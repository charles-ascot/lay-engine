"""
CHIMERA Lay Engine — API Server
=================================
FastAPI backend for Cloud Run (europe-west2).
Frontend served from Cloudflare Pages.

FIX LOG:
  - Added /api/keepalive endpoint for Cloud Run minimum-instances warmup
  - Engine state now persists across cold starts via disk
"""

import os
import io
import json
import logging
import tempfile
from pathlib import Path
from dotenv import load_dotenv

# Load .env if present (local dev)
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

from fastapi import FastAPI, UploadFile, File, Header, Depends, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import threading
import uuid
import time

from engine import LayEngine, _gcs_read
from fsu_client import FSUClient
from rules import apply_rules as apply_betting_rules
from strategy_sandbox import RuleSandbox, persist_sandbox, restore_sandbox

# ── Async backtest job store ──────────────────────────────────────────────────
# Backtests (especially with AI agents) can run for minutes — far beyond the
# Cloud Run 60s request timeout.  We run them in a background thread and let
# the frontend poll for completion.
_backtest_jobs: dict = {}   # job_id → {"status", "result", "error", "started_at"}
_backtest_jobs_lock = threading.Lock()

# ── BSP Optimiser job store ───────────────────────────────────────────────────
_bsp_jobs: dict = {}        # job_id → {"status", "result", "error", "progress", "started_at"}
_bsp_jobs_lock = threading.Lock()

RP_API_URL = "https://racing-post-950990732577.europe-west2.run.app"

def _cleanup_old_jobs():
    """Drop jobs older than 2 hours to avoid unbounded memory growth."""
    cutoff = time.time() - 7200
    with _backtest_jobs_lock:
        stale = [k for k, v in _backtest_jobs.items() if v["started_at"] < cutoff]
        for k in stale:
            del _backtest_jobs[k]
    with _bsp_jobs_lock:
        stale = [k for k, v in _bsp_jobs.items() if v["started_at"] < cutoff]
        for k in stale:
            del _bsp_jobs[k]

# ── Strategy Rule Sandbox (FSU9) — persisted to GCS ─────────────────────────
_sandbox = RuleSandbox()
# Restore state from GCS at startup (non-fatal if bucket unavailable locally)
try:
    restore_sandbox(_sandbox)
except Exception as _se:
    logging.warning(f"Sandbox GCS restore skipped: {_se}")

# ── Anthropic client (lazy — only created when analysis is requested) ──
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
_anthropic_client = None

# ── Lazy caches for AI data sources ──
_betfair_history_cache = None       # parsed Betfair account history CSV
_market_data_inventory_cache = None  # betfair-historic-adv bucket inventory

def get_anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic
        _anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _anthropic_client

# ── OpenAI client (lazy — for Whisper STT + TTS) ──
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
_openai_client = None

def get_openai():
    global _openai_client
    if _openai_client is None:
        import openai
        _openai_client = openai.OpenAI(api_key=OPENAI_API_KEY)
    return _openai_client

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("chimera")

app = FastAPI(title="CHIMERA Lay Engine", version="5.0.0")

# ── CORS: Allow Cloudflare Pages frontend + local dev ──
FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://layengine.thync.online")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        FRONTEND_URL,
        "http://localhost:5173",    # Vite dev
        "http://localhost:3000",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Engine singleton ──
engine = LayEngine()


class LoginRequest(BaseModel):
    username: str
    password: str

class CountriesRequest(BaseModel):
    countries: list[str]

class ProcessWindowRequest(BaseModel):
    minutes: float

class PointValueRequest(BaseModel):
    value: float

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    date: str | None = None

class GenerateKeyRequest(BaseModel):
    label: str = ""

class SnapshotRequest(BaseModel):
    market_ids: list[str]


# ──────────────────────────────────────────────
#  API KEY AUTHENTICATION
# ──────────────────────────────────────────────

def require_api_key(x_api_key: str = Header(None), api_key: str = Query(None)):
    """Dependency that validates an API key from header or query param."""
    key = x_api_key or api_key
    if not key:
        raise HTTPException(
            status_code=401,
            detail="Missing API key. Provide X-API-Key header or ?api_key= query param.",
        )
    if not engine.validate_api_key(key):
        raise HTTPException(
            status_code=403,
            detail="Invalid API key.",
        )
    return key


# ──────────────────────────────────────────────
#  API ENDPOINTS
# ──────────────────────────────────────────────

@app.post("/api/login")
def login(req: LoginRequest):
    """Authenticate with Betfair."""
    success, error = engine.login(req.username, req.password)
    if success:
        return {"status": "ok", "balance": engine.balance}
    return JSONResponse(
        status_code=401,
        content={"status": "error", "message": f"Betfair login failed: {error}"},
    )


@app.post("/api/logout")
def logout():
    """Clear credentials and stop engine."""
    engine.logout()
    return {"status": "ok"}


@app.get("/api/health")
def health():
    return {"status": "ok", "engine": engine.status}


@app.get("/api/keepalive")
def keepalive():
    """
    Cloud Run warmup endpoint.
    Use with Cloud Scheduler to ping every 5 minutes and prevent cold starts.
    e.g.: gcloud scheduler jobs create http chimera-keepalive \
          --schedule="*/5 6-22 * * 1-6" \
          --uri="https://lay-engine-950990732577.europe-west2.run.app/api/keepalive" \
          --http-method=GET --time-zone="Europe/London"
    """
    return {
        "status": "ok",
        "engine": engine.status,
        "authenticated": engine.is_authenticated,
        "dry_run": engine.dry_run,
        "markets": len(engine.markets),
        "bets_today": len(engine.bets_placed),
    }


@app.get("/api/markets")
def get_markets():
    """Return all discovered markets for today (for the Market tab selector)."""
    if not engine.client or not engine.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from datetime import datetime as dt, timezone as tz

    markets = engine.markets
    upcoming = []
    now = dt.now(tz.utc)

    for m in markets:
        try:
            race_time_str = m.get("race_time", "")
            race_time = dt.fromisoformat(race_time_str.replace("Z", "+00:00"))
            minutes_to_off = (race_time - now).total_seconds() / 60
            upcoming.append({
                **m,
                "minutes_to_off": round(minutes_to_off, 1),
                "status": "IN_PLAY" if minutes_to_off < 0 else "PRE_OFF",
            })
        except (ValueError, KeyError):
            pass

    upcoming.sort(key=lambda x: x.get("race_time", ""))
    return {"markets": upcoming}


@app.get("/api/markets/{market_id}/book")
def get_market_book_full(market_id: str):
    """Return full market book with 3-level back/lay depth for a specific market."""
    if not engine.client or not engine.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")

    book = engine.client.get_market_book_full(market_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Market not found or closed")

    # Enrich runner names from catalogue data
    for m in engine.markets:
        if m["market_id"] == market_id:
            name_map = {r["selection_id"]: r["runner_name"] for r in m.get("runners", [])}
            sort_map = {r["selection_id"]: r.get("sort_priority", 99) for r in m.get("runners", [])}
            for runner in book["runners"]:
                sid = runner["selection_id"]
                runner["runner_name"] = name_map.get(sid, f"Selection {sid}")
                runner["sort_priority"] = sort_map.get(sid, 99)
            # Sort by cloth number (sort_priority)
            book["runners"].sort(key=lambda r: r.get("sort_priority", 99))
            book["venue"] = m.get("venue", "")
            book["market_name"] = m.get("market_name", "")
            book["race_time"] = m.get("race_time", "")
            book["country"] = m.get("country", "")
            break

    return book


@app.get("/api/state")
def get_state():
    """Full engine state for the dashboard."""
    return engine.get_state()


@app.get("/api/rules")
def get_rules():
    """Return the active rule set."""
    from rules import SPREAD_THRESHOLDS, CLOSE_ODDS_THRESHOLD
    return {
        "strategy": "UK_IE_Favourite_Lay",
        "version": "5.0",
        "timing": "pre_off",
        "markets": {
            "event_type": "7 (Horse Racing)",
            "countries": engine.countries,
            "market_type": "WIN",
        },
        "rules": [
            {
                "id": "RULE_1",
                "condition": "Favourite odds < 2.0",
                "action": "LAY favourite @ £3",
                "jofs_action": "LAY favourite @ £1.50 + LAY 2nd favourite @ £1.50",
            },
            {
                "id": "RULE_2",
                "condition": "Favourite odds 2.0 – 5.0",
                "action": "LAY favourite @ £2",
                "jofs_action": "LAY favourite @ £1 + LAY 2nd favourite @ £1",
            },
            {
                "id": "RULE_3A",
                "condition": "Favourite odds > 5.0 AND gap to 2nd favourite < 2",
                "action": "LAY favourite @ £1 + LAY 2nd favourite @ £1",
                "jofs_action": "LAY favourite @ £1 + LAY 2nd favourite @ £1 (labelled RULE_3_JOINT when gap ≤ 0.2)",
            },
            {
                "id": "RULE_3B",
                "condition": "Favourite odds > 5.0 AND gap to 2nd favourite ≥ 2",
                "action": "LAY favourite @ £1",
                "jofs_action": "Unchanged (close-odds cannot occur when gap ≥ 2)",
            },
        ],
        "spread_control": {
            "enabled": engine.spread_control,
            "thresholds": [
                {
                    "odds_range": f"{lo}–{hi}",
                    "max_spread": threshold if threshold is not None else "REJECT",
                }
                for lo, hi, threshold in SPREAD_THRESHOLDS
            ],
        },
        "jofs_control": {
            "enabled": engine.jofs_control,
            "close_odds_threshold": CLOSE_ODDS_THRESHOLD,
            "description": (
                "Joint/Close-Odds Favourite Split. When the gap between 1st and 2nd "
                f"favourite is ≤ {CLOSE_ODDS_THRESHOLD}, stake is split evenly across both runners."
            ),
        },
    }


@app.post("/api/engine/start")
def start_engine():
    """Start the engine."""
    if not engine.is_authenticated:
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Not authenticated. Please login first."},
        )
    engine.start()
    return {"status": engine.status}


@app.post("/api/engine/stop")
def stop_engine():
    """Stop the engine."""
    engine.stop()
    return {"status": engine.status}


@app.post("/api/engine/dry-run")
def toggle_dry_run():
    """Toggle dry run mode on/off."""
    engine.dry_run = not engine.dry_run
    return {"dry_run": engine.dry_run}


@app.post("/api/engine/spread-control")
def toggle_spread_control():
    """Toggle spread control on/off. When enabled, bets are rejected if the
    back-lay spread exceeds odds-based thresholds (market liquidity filter)."""
    engine.spread_control = not engine.spread_control
    engine._save_state()
    return {"spread_control": engine.spread_control}


@app.post("/api/engine/jofs-control")
def toggle_jofs_control():
    """Toggle Joint/Close-Odds Favourite Split (JOFS) on/off.
    When enabled, markets where the gap between 1st and 2nd favourite is
    ≤ 0.2 odds points have their stake split evenly across both runners
    rather than being placed solely on the favourite."""
    engine.jofs_control = not engine.jofs_control
    engine._save_state()
    return {"jofs_control": engine.jofs_control}


@app.post("/api/engine/mark-ceiling")
def toggle_mark_ceiling():
    """Toggle Mark Rule: hard ceiling — no lays above 8.0 odds."""
    engine.mark_ceiling_enabled = not engine.mark_ceiling_enabled
    engine._save_state()
    return {"mark_ceiling_enabled": engine.mark_ceiling_enabled}


@app.post("/api/engine/mark-floor")
def toggle_mark_floor():
    """Toggle Mark Rule: hard floor — no lays below 1.5 odds."""
    engine.mark_floor_enabled = not engine.mark_floor_enabled
    engine._save_state()
    return {"mark_floor_enabled": engine.mark_floor_enabled}


@app.post("/api/engine/mark-uplift")
def toggle_mark_uplift():
    """Toggle Mark Rule: 2.5–3.5 band stake uplift."""
    engine.mark_uplift_enabled = not engine.mark_uplift_enabled
    engine._save_state()
    return {"mark_uplift_enabled": engine.mark_uplift_enabled}


class MarkUpliftStakeRequest(BaseModel):
    value: float


@app.post("/api/engine/mark-uplift-stake")
def set_mark_uplift_stake(req: MarkUpliftStakeRequest):
    """Set the Mark Rule uplift stake value (pts) for the 2.5–3.5 band."""
    if req.value < 1 or req.value > 20:
        raise HTTPException(status_code=400, detail="Uplift stake must be between 1 and 20")
    engine.mark_uplift_stake = req.value
    engine._save_state()
    return {"mark_uplift_stake": engine.mark_uplift_stake}


@app.post("/api/engine/signal/overround")
def toggle_signal_overround():
    """Toggle Signal 1: Market Overround filter.
    When enabled, halves stake when book > 115% and skips when > 120%."""
    engine.signal_config.overround_enabled = not engine.signal_config.overround_enabled
    engine._save_state()
    return {"signal_overround_enabled": engine.signal_config.overround_enabled}


@app.post("/api/engine/signal/field-size")
def toggle_signal_field_size():
    """Toggle Signal 2: Field Size filter.
    When enabled, caps stake at £10 for fields > 10 runners when fav odds ≥ 3.0."""
    engine.signal_config.field_size_enabled = not engine.signal_config.field_size_enabled
    engine._save_state()
    return {"signal_field_size_enabled": engine.signal_config.field_size_enabled}


@app.post("/api/engine/signal/steam-gate")
def toggle_signal_steam_gate():
    """Toggle Signal 3: Steam Gate filter.
    When enabled, skips bets where the favourite has shortened ≥3% since first monitoring snapshot."""
    engine.signal_config.steam_gate_enabled = not engine.signal_config.steam_gate_enabled
    engine._save_state()
    return {"signal_steam_gate_enabled": engine.signal_config.steam_gate_enabled}


@app.post("/api/engine/signal/band-perf")
def toggle_signal_band_perf():
    """Toggle Signal 4: Rolling Band Performance filter.
    When enabled, caps stake at £10 when the 5-day win rate for the odds band is < 50%."""
    engine.signal_config.band_perf_enabled = not engine.signal_config.band_perf_enabled
    engine._save_state()
    return {"signal_band_perf_enabled": engine.signal_config.band_perf_enabled}


@app.post("/api/engine/market-overlay")
def toggle_market_overlay():
    """Toggle Market Overlay Modifier on/off.
    Scales stakes based on exchange overround: >1.02 → ×1.15 (HIGH_OVERROUND),
    1.00–1.02 → ×1.00 (NEUTRAL), <1.00 → ×0.80 (EFFICIENT_MARKET).
    Applied after signal filters, before bet placement."""
    engine.market_overlay_enabled = not engine.market_overlay_enabled
    engine._save_state()
    return {"market_overlay_enabled": engine.market_overlay_enabled}


@app.post("/api/engine/top2-concentration")
def toggle_top2_concentration():
    """Toggle TOP2_CONCENTRATION rule family on/off.
    Identifies two-horse race market structures and applies WATCH / SUPPRESS / BLOCK
    to lay bets. Requires ADVANCED tier data (batb field). Silently skips on BASIC data.
    Applied before signal filters and MOM, per spec priority order."""
    engine.top2_concentration_enabled = not engine.top2_concentration_enabled
    engine._save_state()
    return {"top2_concentration_enabled": engine.top2_concentration_enabled}


@app.post("/api/engine/point-value")
def set_point_value(req: PointValueRequest):
    """Set the point value (£ per point). Multiplies all rule stakes."""
    if req.value < 0.5 or req.value > 100:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Point value must be between 0.5 and 100"},
        )
    engine.point_value = round(req.value, 2)
    engine._save_state()
    return {"point_value": engine.point_value}


class KellyConfigRequest(BaseModel):
    enabled: bool
    fraction: float = 0.25
    bankroll: float = 1000.0
    edge_pct: float = 5.0
    min_stake: float = 0.50
    max_stake: float = 50.0


@app.post("/api/engine/kelly")
def set_kelly_config(req: KellyConfigRequest):
    """Update Kelly Criterion config for the live engine."""
    from kelly import KellyConfig as _KellyConfig
    if not (0.05 <= req.fraction <= 1.0):
        raise HTTPException(status_code=400, detail="fraction must be 0.05–1.0")
    if req.bankroll < 10 or req.bankroll > 1_000_000:
        raise HTTPException(status_code=400, detail="bankroll must be £10–£1,000,000")
    if not (0.0 <= req.edge_pct <= 50.0):
        raise HTTPException(status_code=400, detail="edge_pct must be 0–50 %")
    if req.min_stake < 0.10:
        raise HTTPException(status_code=400, detail="min_stake must be ≥ £0.10")
    if req.max_stake > 10_000:
        raise HTTPException(status_code=400, detail="max_stake must be ≤ £10,000")
    engine.kelly_config = _KellyConfig(
        enabled=req.enabled,
        fraction=req.fraction,
        bankroll=req.bankroll,
        edge_pct=req.edge_pct,
        min_stake=req.min_stake,
        max_stake=req.max_stake,
    )
    engine._save_state()
    return {"kelly": engine.kelly_config.to_dict()}


@app.get("/api/engine/spread-rejections")
def get_spread_rejections():
    """Return recent spread control rejections for today."""
    return {"rejections": list(reversed(engine.spread_rejections[-50:]))}


@app.post("/api/engine/countries")
def set_countries(req: CountriesRequest):
    """Update the market countries filter."""
    valid = {"GB", "IE", "ZA", "FR"}
    filtered = [c for c in req.countries if c in valid]
    if not filtered:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "At least one valid country required"},
        )
    engine.countries = filtered
    engine._save_state()
    return {"countries": engine.countries}


@app.post("/api/engine/process-window")
def set_process_window(req: ProcessWindowRequest):
    """Set the betting window — how many minutes before race start to place bets."""
    if req.minutes < 0.05 or req.minutes > 60:
        raise HTTPException(status_code=400, detail="Window must be 0.05–60 minutes")
    engine.process_window = req.minutes
    engine._save_state()
    return {"status": "ok", "process_window": engine.process_window}


@app.get("/api/monitoring/{market_id}")
def get_monitoring_data(market_id: str):
    """Return odds monitoring snapshots for a specific market (for drift analysis)."""
    snapshots = engine.monitoring.get(market_id, [])
    return {"market_id": market_id, "snapshots": snapshots, "count": len(snapshots)}


@app.post("/api/engine/reset-bets")
def reset_bets():
    """Clear all dry run bets and processed markets so the engine can re-process."""
    engine.reset_bets()
    return {"status": "ok"}


@app.get("/api/sessions")
def get_sessions():
    """List all sessions (summaries only, most recent first)."""
    return {"sessions": engine.get_sessions()}


@app.get("/api/sessions/{session_id}")
def get_session_detail(session_id: str):
    """Full session detail including all bets and results."""
    detail = engine.get_session_detail(session_id)
    if detail is None:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Session not found"},
        )
    return detail


# ──────────────────────────────────────────────
#  DRY-RUN SNAPSHOTS
# ──────────────────────────────────────────────

@app.post("/api/engine/snapshot")
def run_snapshot(req: SnapshotRequest):
    """Run an instant dry-run snapshot for selected markets."""
    if not engine.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not req.market_ids:
        raise HTTPException(status_code=400, detail="No market_ids provided")
    try:
        snapshot = engine.run_instant_snapshot(req.market_ids)
        return snapshot
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/snapshots")
def list_snapshots():
    """List all dry-run snapshots (summaries only, no full results)."""
    summaries = []
    for s in reversed(engine.dry_run_snapshots):
        summaries.append({
            "snapshot_id": s["snapshot_id"],
            "created_at": s["created_at"],
            "markets_evaluated": s["markets_evaluated"],
            "bets_would_place": s["bets_would_place"],
            "total_stake": s["total_stake"],
            "total_liability": s["total_liability"],
            "rule_breakdown": s.get("rule_breakdown", {}),
            "countries": s.get("countries", []),
            "point_value": s.get("point_value", 1.0),
        })
    return {"snapshots": summaries}


@app.get("/api/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str):
    """Return full snapshot including per-market results."""
    for s in engine.dry_run_snapshots:
        if s["snapshot_id"] == snapshot_id:
            return s
    raise HTTPException(status_code=404, detail="Snapshot not found")


@app.post("/api/snapshots/{snapshot_id}/archive")
def archive_snapshot(snapshot_id: str):
    """Toggle the archived flag on a dry-run snapshot."""
    from datetime import datetime as _dt
    for s in engine.dry_run_snapshots:
        if s["snapshot_id"] == snapshot_id:
            s["archived"] = not s.get("archived", False)
            s["archived_at"] = _dt.utcnow().isoformat() if s["archived"] else None
            engine._save_snapshots()
            return {"snapshot_id": snapshot_id, "archived": s["archived"]}
    raise HTTPException(status_code=404, detail="Snapshot not found")


@app.get("/api/snapshots/{snapshot_id}/export")
def export_snapshot(snapshot_id: str):
    """Download the full snapshot as a JSON file attachment."""
    import json as _json
    from fastapi.responses import Response as _Resp
    for s in engine.dry_run_snapshots:
        if s["snapshot_id"] == snapshot_id:
            content = _json.dumps(s, indent=2, default=str)
            ts = (s.get("created_at", "")[:10] or snapshot_id)
            return _Resp(
                content=content,
                media_type="application/json",
                headers={"Content-Disposition": f'attachment; filename="chimera_dryrun_{ts}.json"'},
            )
    raise HTTPException(status_code=404, detail="Snapshot not found")


@app.get("/api/data-registry")
def get_data_registry():
    """Return a full inventory of all CHIMERA data records with their GCS/local storage locations."""
    from collections import defaultdict as _dd

    date_map = _dd(lambda: {
        "date": "",
        "sessions": [],
        "dry_run_snapshots": [],
        "reports": [],
        "has_backtest": False,
    })

    # Sessions
    for s in engine.sessions:
        d = s.get("date", "unknown")
        date_map[d]["date"] = d
        date_map[d]["sessions"].append({
            "session_id": s["session_id"],
            "mode": s.get("mode", "LIVE"),
            "status": s.get("status", ""),
            "start_time": s.get("start_time", ""),
            "stop_time": s.get("stop_time", ""),
            "total_bets": s.get("summary", {}).get("total_bets", 0),
            "total_stake": s.get("summary", {}).get("total_stake", 0),
        })

    # Dry-run snapshots
    for s in engine.dry_run_snapshots:
        created = s.get("created_at", "")
        d = created[:10] if created else "unknown"
        date_map[d]["date"] = d
        date_map[d]["dry_run_snapshots"].append({
            "snapshot_id": s["snapshot_id"],
            "created_at": created,
            "markets_evaluated": s.get("markets_evaluated", 0),
            "bets_would_place": s.get("bets_would_place", 0),
            "total_stake": s.get("total_stake", 0),
            "archived": s.get("archived", False),
        })

    # Reports
    for r in engine.reports:
        d = r.get("date") or (r.get("created_at", "")[:10])
        date_map[d]["date"] = d
        date_map[d]["reports"].append({
            "report_id": r["report_id"],
            "title": r.get("title", ""),
            "created_at": r.get("created_at", ""),
            "template": r.get("template_name", ""),
        })

    sorted_entries = sorted(
        [v for v in date_map.values() if v["date"]],
        key=lambda x: x["date"],
        reverse=True,
    )

    storage_locations = {
        "sessions": {
            "gcs": "gs://chimera-v4/chimera_sessions.json",
            "local": "/tmp/chimera_sessions.json",
            "description": "All session records (LIVE + DRY RUN) with full bet histories",
        },
        "engine_state": {
            "gcs": "gs://chimera-v4/chimera_engine_state.json",
            "local": "/tmp/chimera_engine_state.json",
            "description": "Current engine state — today's markets, results, settings",
        },
        "reports": {
            "gcs": "gs://chimera-v4/chimera_reports.json",
            "local": "/tmp/chimera_reports.json",
            "description": "All AI-generated daily performance reports",
        },
        "snapshots": {
            "gcs": "gs://chimera-v4/chimera_snapshots.json",
            "local": "/tmp/chimera_snapshots.json",
            "description": "All dry-run snapshots (90-day retention policy)",
        },
        "stats_cache": {
            "gcs": "gs://chimera-v4/chimera_stats_cache.json",
            "local": "/tmp/chimera_stats_cache.json",
            "description": "Pre-computed daily P&L statistics cache",
        },
        "settings": {
            "gcs": "gs://chimera-v4/chimera_settings.json",
            "local": "/tmp/chimera_settings.json",
            "description": "Application settings — recipients, AI capabilities",
        },
    }

    return {
        "entries": sorted_entries,
        "total_sessions": sum(len(e["sessions"]) for e in sorted_entries),
        "total_snapshots": sum(len(e["dry_run_snapshots"]) for e in sorted_entries),
        "total_reports": sum(len(e["reports"]) for e in sorted_entries),
        "storage_locations": storage_locations,
        "earliest_date": sorted_entries[-1]["date"] if sorted_entries else None,
        "latest_date": sorted_entries[0]["date"] if sorted_entries else None,
    }


# ──────────────────────────────────────────────
#  MATCHED BETS (live bets placed on Betfair)
# ──────────────────────────────────────────────

@app.get("/api/matched")
def get_matched_bets(
    date_from: str = Query(None, description="Start date YYYY-MM-DD"),
    date_to: str = Query(None, description="End date YYYY-MM-DD"),
):
    """Return LIVE bets placed on Betfair (non-dry-run), with date range filtering."""
    bets = []
    for s in engine.sessions:
        if s.get("mode") != "LIVE":
            continue
        session_date = s.get("date", "")
        if date_from and session_date < date_from:
            continue
        if date_to and session_date > date_to:
            continue
        for b in s.get("bets", []):
            if b.get("dry_run"):
                continue
            bet = dict(b)
            bet["session_id"] = s["session_id"]
            bet["session_date"] = s["date"]
            bets.append(bet)

    # Group by date
    grouped = {}
    for b in bets:
        d = b.get("session_date", "unknown")
        if d not in grouped:
            grouped[d] = []
        grouped[d].append(b)

    total_stake = sum(b.get("size", 0) for b in bets)
    total_liability = sum(b.get("liability", 0) for b in bets)
    avg_odds = (
        round(sum(b.get("price", 0) for b in bets) / len(bets), 2)
        if bets else 0
    )

    return {
        "count": len(bets),
        "total_stake": round(total_stake, 2),
        "total_liability": round(total_liability, 2),
        "avg_odds": avg_odds,
        "bets_by_date": {
            d: list(reversed(day_bets))
            for d, day_bets in sorted(grouped.items(), reverse=True)
        },
    }


# ──────────────────────────────────────────────
#  SETTLED BETS (race results + P/L from Betfair)
# ──────────────────────────────────────────────

@app.get("/api/settled")
def get_settled_bets(
    date_from: str = Query(None, description="Start date YYYY-MM-DD"),
    date_to: str = Query(None, description="End date YYYY-MM-DD"),
):
    """Return settled bets with P/L from Betfair cleared orders."""
    if not engine.is_authenticated:
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Not authenticated with Betfair"},
        )

    from datetime import datetime as dt, timedelta, timezone as tz

    now = dt.now(tz.utc)
    if date_to:
        to_str = date_to + "T23:59:59Z"
    else:
        to_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if date_from:
        from_str = date_from + "T00:00:00Z"
    else:
        from_str = (now - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z")

    # Fetch cleared orders from Betfair
    try:
        cleared = engine.client.get_cleared_orders(
            settled_from=from_str,
            settled_to=to_str,
        )
    except Exception as e:
        logging.error(f"Failed to fetch cleared orders: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Betfair API error: {str(e)}"},
        )

    # Build lookup of our placed bets by bet_id
    our_bets_by_id = {}
    for s in engine.sessions:
        if s.get("mode") != "LIVE":
            continue
        for b in s.get("bets", []):
            bid = str(b.get("betfair_response", {}).get("bet_id", ""))
            if bid:
                our_bets_by_id[bid] = b

    # Cross-reference cleared orders with our bets
    settled = []
    for co in cleared:
        bet_id = str(co.get("betId", ""))
        our_bet = our_bets_by_id.get(bet_id, {})
        desc = co.get("itemDescription", {})

        settled.append({
            "bet_id": bet_id,
            "market_id": co.get("marketId", ""),
            "selection_id": co.get("selectionId"),
            "runner_name": desc.get("runnerDesc", our_bet.get("runner_name", "Unknown")),
            "venue": desc.get("eventDesc", our_bet.get("venue", "")),
            "market_desc": desc.get("marketDesc", ""),
            "price_matched": co.get("priceMatched", 0),
            "price_requested": co.get("priceRequested", 0),
            "size_settled": co.get("sizeSettled", 0),
            "profit": co.get("profit", 0),
            "commission": co.get("commission", 0),
            "bet_outcome": co.get("betOutcome", ""),
            "settled_date": co.get("settledDate", ""),
            "placed_date": co.get("placedDate", ""),
            "side": co.get("side", ""),
            "rule_applied": our_bet.get("rule_applied", ""),
            "our_stake": our_bet.get("size", 0),
            "our_liability": our_bet.get("liability", 0),
            "is_chimera_bet": bet_id in our_bets_by_id,
        })

    # Group by settled date
    grouped = {}
    for b in settled:
        sd = (b.get("settled_date") or "")[:10]
        if not sd:
            sd = "unknown"
        if sd not in grouped:
            grouped[sd] = []
        grouped[sd].append(b)

    # Compute totals
    total_pl = sum(b.get("profit", 0) for b in settled)
    total_commission = sum(b.get("commission", 0) for b in settled)
    wins = sum(1 for b in settled if b.get("bet_outcome") == "WON")
    losses = sum(1 for b in settled if b.get("bet_outcome") == "LOST")

    days_summary = {}
    for d, day_bets in sorted(grouped.items(), reverse=True):
        day_pl = sum(b.get("profit", 0) for b in day_bets)
        day_wins = sum(1 for b in day_bets if b.get("bet_outcome") == "WON")
        day_losses = sum(1 for b in day_bets if b.get("bet_outcome") == "LOST")
        total_day = day_wins + day_losses
        days_summary[d] = {
            "bets": day_bets,
            "day_pl": round(day_pl, 2),
            "wins": day_wins,
            "losses": day_losses,
            "strike_rate": round(day_wins / total_day * 100, 1) if total_day > 0 else 0,
            "races": len(set(b.get("market_id") for b in day_bets)),
        }

    total = wins + losses
    return {
        "count": len(settled),
        "total_pl": round(total_pl, 2),
        "total_commission": round(total_commission, 2),
        "wins": wins,
        "losses": losses,
        "strike_rate": round(wins / total * 100, 1) if total > 0 else 0,
        "days": days_summary,
    }


class AnalyseRequest(BaseModel):
    date: str  # YYYY-MM-DD


def _compact_session_data(sessions: list[dict]) -> list[dict]:
    """Build compact session summaries for AI prompts."""
    data = []
    for s in sessions:
        data.append({
            "session_id": s["session_id"],
            "mode": s["mode"],
            "date": s.get("date"),
            "start_time": s.get("start_time"),
            "stop_time": s.get("stop_time"),
            "status": s.get("status"),
            "summary": s.get("summary", {}),
            "bets": [
                {
                    "runner": b.get("runner_name"),
                    "odds": b.get("price"),
                    "stake": b.get("size"),
                    "liability": b.get("liability"),
                    "rule": b.get("rule_applied"),
                    "status": b.get("betfair_response", {}).get("status"),
                    "bet_id": str(b.get("betfair_response", {}).get("bet_id", "")),
                    "time": b.get("timestamp"),
                    "dry_run": b.get("dry_run"),
                    "venue": b.get("venue"),
                    "country": b.get("country"),
                    "market_id": b.get("market_id"),
                }
                for b in s.get("bets", [])
            ],
            "results": [
                {
                    "venue": r.get("venue"),
                    "race": r.get("market_name"),
                    "race_time": r.get("race_time"),
                    "market_id": r.get("market_id"),
                    "fav": r.get("favourite", {}).get("name") if r.get("favourite") else None,
                    "fav_odds": r.get("favourite", {}).get("odds") if r.get("favourite") else None,
                    "second_fav": r.get("second_favourite", {}).get("name") if r.get("second_favourite") else None,
                    "second_fav_odds": r.get("second_favourite", {}).get("odds") if r.get("second_favourite") else None,
                    "rule": r.get("rule_applied"),
                    "skipped": r.get("skipped"),
                    "skip_reason": r.get("skip_reason"),
                }
                for r in s.get("results", [])
            ],
        })
    return data


def _get_settled_for_date(target_date: str) -> list[dict]:
    """Fetch settled bet outcomes from Betfair for a specific date.

    Cross-references with engine bets to add rule_applied, venue, etc.
    Returns a list of settled bet dicts with actual P/L.
    """
    if not engine.is_authenticated:
        return []

    from_str = target_date + "T00:00:00Z"
    to_str = target_date + "T23:59:59Z"

    try:
        cleared = engine.client.get_cleared_orders(
            settled_from=from_str,
            settled_to=to_str,
        )
    except Exception as e:
        logging.error(f"Failed to fetch settled data for {target_date}: {e}")
        return []

    # Build lookup of our placed bets by bet_id
    our_bets_by_id = {}
    for s in engine.sessions:
        for b in s.get("bets", []):
            bid = str(b.get("betfair_response", {}).get("bet_id", ""))
            if bid:
                our_bets_by_id[bid] = b

    settled = []
    for co in cleared:
        bet_id = str(co.get("betId", ""))
        our_bet = our_bets_by_id.get(bet_id, {})
        desc = co.get("itemDescription", {})
        settled.append({
            "bet_id": bet_id,
            "runner_name": desc.get("runnerDesc", our_bet.get("runner_name", "Unknown")),
            "venue": desc.get("eventDesc", our_bet.get("venue", "")),
            "market_desc": desc.get("marketDesc", ""),
            "price_matched": co.get("priceMatched", 0),
            "size_settled": co.get("sizeSettled", 0),
            "profit": co.get("profit", 0),
            "commission": co.get("commission", 0),
            "bet_outcome": co.get("betOutcome", ""),  # WON or LOST
            "settled_date": co.get("settledDate", ""),
            "placed_date": co.get("placedDate", ""),
            "rule_applied": our_bet.get("rule_applied", ""),
            "country": our_bet.get("country", ""),
            "our_stake": our_bet.get("size", 0),
            "our_liability": our_bet.get("liability", 0),
            "is_chimera_bet": bet_id in our_bets_by_id,
        })
    return settled


def _compute_day_stats(settled_bets: list[dict]) -> dict:
    """Pre-compute authoritative aggregations from settled bet data.

    All win/loss counts, P&L totals, and odds-band breakdowns are computed
    here in Python so the AI agent receives authoritative figures rather than
    computing them itself (LLMs are unreliable arithmetic engines).

    Odds-band boundaries (half-open intervals, same as lay rules):
      < 2.0    → [0, 2.0)
      2.0–2.99 → [2.0, 3.0)
      3.0–3.99 → [3.0, 4.0)
      4.0–4.99 → [4.0, 5.0)
      5.0+     → [5.0, ∞)
    """
    BANDS = [
        {"label": "< 2.0",    "min": None, "max": 2.0},
        {"label": "2.0–2.99", "min": 2.0,  "max": 3.0},
        {"label": "3.0–3.99", "min": 3.0,  "max": 4.0},
        {"label": "4.0–4.99", "min": 4.0,  "max": 5.0},
        {"label": "5.0+",     "min": 5.0,  "max": None},
    ]

    def get_band_label(odds: float) -> str:
        for b in BANDS:
            lo = b["min"] if b["min"] is not None else float("-inf")
            hi = b["max"] if b["max"] is not None else float("inf")
            if lo <= odds < hi:
                return b["label"]
        return "Unknown"

    # Only count bets with a definitive WIN/LOSS outcome
    settled = [b for b in settled_bets if b.get("bet_outcome") in ("WON", "LOST")]

    wins = sum(1 for b in settled if b["bet_outcome"] == "WON")
    losses = sum(1 for b in settled if b["bet_outcome"] == "LOST")
    total = wins + losses
    net_pl = round(sum(b.get("profit", 0) for b in settled), 2)
    total_staked = round(
        sum(b.get("our_stake") or b.get("size_settled", 0) for b in settled), 2
    )
    strike_rate = round(wins / total, 4) if total > 0 else 0.0
    roi = round(net_pl / total_staked, 4) if total_staked > 0 else 0.0

    # Per-band aggregation
    band_acc = {b["label"]: {"bets": 0, "wins": 0, "losses": 0, "pl": 0.0, "staked": 0.0}
                for b in BANDS}
    unclassified = []
    for b in settled:
        odds = b.get("price_matched") or 0.0  # guard against None (Betfair returns null for unmatched)
        label = get_band_label(odds)
        if label not in band_acc:
            unclassified.append({"odds": odds, "bet_id": b.get("bet_id")})
            continue
        band_acc[label]["bets"] += 1
        band_acc[label]["wins"] += int(b["bet_outcome"] == "WON")
        band_acc[label]["losses"] += int(b["bet_outcome"] == "LOST")
        band_acc[label]["pl"] += b.get("profit", 0)
        band_acc[label]["staked"] += b.get("our_stake") or b.get("size_settled", 0)

    bands = []
    for b_def in BANDS:
        s = band_acc[b_def["label"]]
        pl = round(s["pl"], 2)
        staked = round(s["staked"], 2)
        bands.append({
            "label": b_def["label"],
            "bets": s["bets"],
            "wins": s["wins"],
            "losses": s["losses"],
            "win_pct": round(s["wins"] / s["bets"], 4) if s["bets"] > 0 else 0.0,
            "pl": pl,
            "roi": round(pl / staked, 4) if staked > 0 else 0.0,
        })

    return {
        "total_bets": total,
        "wins": wins,
        "losses": losses,
        "strike_rate": strike_rate,
        "net_pl": net_pl,
        "total_staked": total_staked,
        "roi": roi,
        "bands": bands,
        "band_pl_sum": round(sum(b["pl"] for b in bands), 2),  # Must equal net_pl
        "unclassified_bets": unclassified,  # Should always be empty
    }


def _get_historical_summary(exclude_date: str = None) -> dict:
    """Build cumulative performance summary from all historical sessions.

    Returns aggregated stats across all previous operating days,
    broken down by day, odds band, rule, and venue.
    Includes both LIVE and DRY_RUN sessions.
    """
    days = {}  # date -> {live_bets, dry_bets, stake, liability, sessions, dry_sessions}

    for s in engine.sessions:
        date = s.get("date", "")
        if exclude_date and date == exclude_date:
            continue

        is_dry = s.get("mode") == "DRY_RUN"

        if date not in days:
            days[date] = {
                "date": date,
                "live_bets": 0, "dry_run_bets": 0,
                "live_stake": 0.0, "live_liability": 0.0,
                "dry_run_stake": 0.0, "dry_run_liability": 0.0,
                "live_sessions": 0, "dry_run_sessions": 0,
            }

        if is_dry:
            days[date]["dry_run_sessions"] += 1
        else:
            days[date]["live_sessions"] += 1

        for b in s.get("bets", []):
            if b.get("dry_run") or is_dry:
                days[date]["dry_run_bets"] += 1
                days[date]["dry_run_stake"] = round(days[date]["dry_run_stake"] + b.get("size", 0), 2)
                days[date]["dry_run_liability"] = round(days[date]["dry_run_liability"] + b.get("liability", 0), 2)
            else:
                days[date]["live_bets"] += 1
                days[date]["live_stake"] = round(days[date]["live_stake"] + b.get("size", 0), 2)
                days[date]["live_liability"] = round(days[date]["live_liability"] + b.get("liability", 0), 2)

    # Gather all session data compactly (LIVE and DRY_RUN)
    all_sessions = []
    for s in engine.sessions:
        date = s.get("date", "")
        if exclude_date and date == exclude_date:
            continue
        all_sessions.append({
            "session_id": s["session_id"],
            "mode": s["mode"],
            "date": date,
            "status": s.get("status"),
            "total_bets": s.get("summary", {}).get("total_bets", 0),
            "total_stake": s.get("summary", {}).get("total_stake", 0),
            "total_liability": s.get("summary", {}).get("total_liability", 0),
            "countries": s.get("summary", {}).get("countries", []),
        })

    # Merge in cached P/L stats (populated when reports are generated for each day)
    for d in days.values():
        cached = engine.daily_stats_cache.get(d["date"], {})
        d["pl"] = cached.get("net_pl")          # None if not yet cached
        d["wins"] = cached.get("wins", 0)
        d["losses"] = cached.get("losses", 0)
        d["strike_rate"] = cached.get("strike_rate", 0)
        d["roi"] = cached.get("roi", 0)

    return {
        "total_sessions": len(all_sessions),
        "operating_days": sorted(days.keys()),
        "day_summaries": sorted(days.values(), key=lambda d: d["date"]),
        "sessions": all_sessions,
        "note": "pl/wins/losses only available for dates where a daily report has been generated. Bet counts and stake/liability are available for all dates.",
    }


def _load_betfair_history(target_date: str = None) -> dict:
    """Load and parse Betfair account history CSV from GCS.

    Returns a summary for all dates, or per-date rows if target_date is given.
    Results are cached in memory for the lifetime of the container.
    """
    global _betfair_history_cache
    if _betfair_history_cache is None:
        try:
            import csv as _csv
            from collections import defaultdict
            raw = _gcs_read("betfair_betting_history.csv")
            if not raw:
                _betfair_history_cache = {"error": "betfair_betting_history.csv not found in GCS"}
            else:
                reader = _csv.DictReader(io.StringIO(raw))
                rows = list(reader)
                by_date = defaultdict(list)
                total_pl = 0.0
                wins = 0
                losses = 0
                for row in rows:
                    bet_placed = row.get("Bet placed", "").strip()
                    try:
                        from datetime import datetime as _dt
                        dt = _dt.strptime(bet_placed, "%d-%b-%y %H:%M")
                        date_str = dt.strftime("%Y-%m-%d")
                    except Exception:
                        date_str = "unknown"
                    pl = 0.0
                    try:
                        pl = float(row.get("Profit/Loss (£)", 0) or 0)
                    except (ValueError, TypeError):
                        pass
                    total_pl += pl
                    if pl > 0:
                        wins += 1
                    elif pl < 0:
                        losses += 1
                    by_date[date_str].append({
                        "market": row.get("Market", ""),
                        "selection": row.get("Selection", ""),
                        "bet_id": row.get("Bet ID", ""),
                        "odds_req": row.get("Odds req.", ""),
                        "stake": row.get("Stake (£)", ""),
                        "liability": row.get("Liability (£)", ""),
                        "avg_odds": row.get("Avg. odds matched", ""),
                        "pl": pl,
                    })
                dates = sorted(d for d in by_date if d != "unknown")
                date_summaries = []
                for d in dates:
                    bets = by_date[d]
                    day_pl = sum(b["pl"] for b in bets)
                    day_wins = sum(1 for b in bets if b["pl"] > 0)
                    day_losses = sum(1 for b in bets if b["pl"] < 0)
                    date_summaries.append({
                        "date": d,
                        "bets": len(bets),
                        "wins": day_wins,
                        "losses": day_losses,
                        "pl": round(day_pl, 2),
                        "strike_rate": round(day_wins / len(bets) * 100, 1) if bets else 0,
                    })
                _betfair_history_cache = {
                    "source": "Betfair Account History CSV (exported 23 March 2026)",
                    "total_bets": len(rows),
                    "total_wins": wins,
                    "total_losses": losses,
                    "total_pl": round(total_pl, 2),
                    "overall_strike_rate": round(wins / len(rows) * 100, 1) if rows else 0,
                    "date_range": {"from": dates[0] if dates else None, "to": dates[-1] if dates else None},
                    "days_traded": len(by_date),
                    "date_summaries": date_summaries,
                    "_by_date": dict(by_date),
                }
        except Exception as e:
            logging.error(f"Failed to load Betfair history: {e}")
            _betfair_history_cache = {"error": str(e)}

    if target_date and _betfair_history_cache and "_by_date" in _betfair_history_cache:
        day_bets = _betfair_history_cache["_by_date"].get(target_date, [])
        summary = next(
            (d for d in _betfair_history_cache.get("date_summaries", []) if d["date"] == target_date),
            None,
        )
        return {"date": target_date, "summary": summary, "bets": day_bets}

    # Return summary without the large _by_date index
    if _betfair_history_cache and "_by_date" in _betfair_history_cache:
        return {k: v for k, v in _betfair_history_cache.items() if k != "_by_date"}
    return _betfair_history_cache or {}


def _get_market_data_inventory() -> dict:
    """Build an inventory of available Betfair historic market data from betfair-historic-adv.

    Structure: ADVANCED/BASIC -> year -> month -> [days available]
    Cached for container lifetime (changes rarely).
    """
    global _market_data_inventory_cache
    if _market_data_inventory_cache is not None:
        return _market_data_inventory_cache

    HIST_BUCKET = "betfair-historic-adv"
    try:
        from google.cloud import storage as _gcs
        client = _gcs.Client()
        inventory = {}

        for tier in ["ADVANCED", "BASIC"]:
            tier_data = {}
            # List years
            blobs = client.list_blobs(HIST_BUCKET, prefix=f"{tier}/", delimiter="/")
            year_prefixes = []
            for page in blobs.pages:
                year_prefixes.extend(page.prefixes)

            for year_p in year_prefixes:
                year = year_p.rstrip("/").split("/")[-1]
                month_data = {}
                blobs2 = client.list_blobs(HIST_BUCKET, prefix=year_p, delimiter="/")
                month_prefixes = []
                for page in blobs2.pages:
                    month_prefixes.extend(page.prefixes)

                for month_p in month_prefixes:
                    month = month_p.rstrip("/").split("/")[-1]
                    blobs3 = client.list_blobs(HIST_BUCKET, prefix=month_p, delimiter="/")
                    day_prefixes = []
                    for page in blobs3.pages:
                        day_prefixes.extend(page.prefixes)
                    days = sorted(
                        [p.rstrip("/").split("/")[-1] for p in day_prefixes],
                        key=lambda x: int(x) if x.isdigit() else x,
                    )
                    month_data[month] = days

                tier_data[year] = month_data
            inventory[tier] = tier_data

        _market_data_inventory_cache = {
            "bucket": HIST_BUCKET,
            "description": "Betfair historic market data (bz2 stream files). ADVANCED = full price ladder + traded volume. BASIC = last-traded-price only.",
            "available_data": inventory,
        }
        return _market_data_inventory_cache
    except Exception as e:
        logging.error(f"Failed to build market data inventory: {e}")
        return {"error": str(e)}


RULES_DESCRIPTION = """The CHIMERA Lay Engine uses these rules on horse racing WIN markets:
- RULE 1: Favourite odds < 2.0 -> £3 lay on favourite
  RULE 1 JOINT (JOFS): if gap to 2nd fav <= 0.2 -> £1.50 lay fav + £1.50 lay 2nd fav
- RULE 2: Favourite odds 2.0-5.0 -> £2 lay on favourite
  RULE 2 JOINT (JOFS): if gap to 2nd fav <= 0.2 -> £1 lay fav + £1 lay 2nd fav
- RULE 3A: Favourite odds > 5.0 AND gap to 2nd fav < 2 -> £1 lay fav + £1 lay 2nd fav
  RULE 3 JOINT (JOFS): same as 3A but labelled RULE_3_JOINT when gap <= 0.2
- RULE 3B: Favourite odds > 5.0 AND gap to 2nd fav >= 2 -> £1 lay fav only
JOFS (Joint/Close-Odds Favourite Split): protective measure applied when the market
has near-identical favourites, splitting the stake rather than doubling down on one."""


@app.post("/api/sessions/analyse")
def analyse_sessions(req: AnalyseRequest):
    """AI-powered analysis of all sessions for a given date."""
    if not ANTHROPIC_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "ANTHROPIC_API_KEY not configured"},
        )

    day_sessions = [
        s for s in engine.sessions if s.get("date") == req.date
    ]
    if not day_sessions:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": f"No sessions found for {req.date}"},
        )

    session_data = _compact_session_data(day_sessions)
    settled_data = _get_settled_for_date(req.date)

    prompt = f"""You are an expert horse racing betting analyst. Analyse the following lay betting session data from {req.date}.

{RULES_DESCRIPTION}

SESSION DATA (bets placed by the engine):
{json.dumps(session_data, indent=2, default=str)}

SETTLED BETS FROM BETFAIR (actual race outcomes with real P/L — use these for WIN/LOSS and P/L figures):
{json.dumps(settled_data, indent=2, default=str) if settled_data else "No settled data available — calculate P/L as: WIN = +stake, LOSS = -liability"}

Provide exactly 6-10 concise bullet points covering:
- Actual P/L performance (wins, losses, strike rate, net P/L)
- Odds band performance (which bands performed best/worst?)
- Rule distribution (which rules triggered most/least?)
- Risk exposure (total liability vs stake ratio)
- Venue/race patterns (any concentrations?)
- Country performance (if multiple countries)
- Session timing observations
- Any anomalies or notable patterns
- Actionable suggestions for rule tuning

Format each point as a single line starting with a bullet (•). Be specific with numbers. No headers, no preamble — just the bullet points."""

    try:
        client = get_anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        analysis_text = message.content[0].text
        points = [
            line.strip().lstrip("•").lstrip("- ").strip()
            for line in analysis_text.strip().split("\n")
            if line.strip() and (line.strip().startswith("•") or line.strip().startswith("-"))
        ]
        if not points:
            points = [line.strip() for line in analysis_text.strip().split("\n") if line.strip()]
        return {"date": req.date, "points": points[:10]}
    except Exception as e:
        logging.error(f"Analysis failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Analysis failed: {str(e)}"},
        )


def _chat_execute_tool(tool_name: str, tool_input: dict) -> dict:
    """
    Execute a tool call from the CHIMERA AI chat agent.

    All external interactions (FSU1, backtest engine) go through HTTP-style
    calls so this block can be extracted to a separate service unchanged
    when the architecture migrates to full FSU separation.
    """
    import requests as _req

    try:
        # ── FSU1: list available backtest dates ───────────────────────────────
        if tool_name == "list_available_dates":
            r = _req.get(
                f"{FSU_URL}/api/dates",
                headers=_fsu_auth_header(),
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            return {
                "dates": data.get("dates", []),
                "count": data.get("count", 0),
                "note": (
                    "Dates before 2026-01-01 use ADVANCED data (full price ladder). "
                    "Dates from 2026-01-01 onwards use BASIC data (last-traded-price only — "
                    "backtest will skip all markets on these dates as lay prices are unavailable)."
                ),
            }

        # ── FSU1: list markets for a date ─────────────────────────────────────
        elif tool_name == "list_markets_for_date":
            date = tool_input.get("date", "")
            countries = tool_input.get("countries", "GB,IE")
            r = _req.get(
                f"{FSU_URL}/api/markets",
                params={"date": date, "market_type": "WIN", "countries": countries},
                headers=_fsu_auth_header(),
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            markets = data.get("markets", [])
            return {
                "date": date,
                "market_count": len(markets),
                "markets": [
                    {
                        "market_id": m["market_id"],
                        "venue": m["venue"],
                        "race_time": m["race_time"],
                        "runner_count": len(m.get("runners", [])),
                    }
                    for m in markets
                ],
            }

        # ── Backtest: start a job ─────────────────────────────────────────────
        elif tool_name == "run_backtest":
            from pydantic import ValidationError
            try:
                bt_req = BacktestRunRequest(**tool_input)
            except (ValidationError, Exception) as e:
                return {"error": f"Invalid backtest parameters: {e}"}
            job_id = str(uuid.uuid4())
            with _backtest_jobs_lock:
                _backtest_jobs[job_id] = {
                    "status": "running",
                    "result": None,
                    "error": None,
                    "started_at": time.time(),
                }
            def _run():
                try:
                    result = _backtest_run_inner(bt_req)
                    with _backtest_jobs_lock:
                        _backtest_jobs[job_id]["status"] = "done"
                        _backtest_jobs[job_id]["result"] = result
                except Exception as _exc:
                    with _backtest_jobs_lock:
                        _backtest_jobs[job_id]["status"] = "error"
                        _backtest_jobs[job_id]["error"] = str(_exc)
            threading.Thread(target=_run, daemon=True).start()
            return {"job_id": job_id, "status": "running", "message": "Backtest started. Use get_backtest_job to poll for results."}

        # ── Backtest: poll job status / retrieve results ──────────────────────
        elif tool_name == "get_backtest_job":
            job_id = tool_input.get("job_id", "")
            with _backtest_jobs_lock:
                job = _backtest_jobs.get(job_id)
            if not job:
                return {"error": f"Job '{job_id}' not found"}
            resp = {"job_id": job_id, "status": job["status"]}
            if job["status"] == "done":
                result = job["result"] or {}
                resp["summary"] = {
                    "date": result.get("date"),
                    "markets_evaluated": result.get("markets_evaluated", 0),
                    "bets_placed": result.get("bets_placed", 0),
                    "markets_skipped": result.get("markets_skipped", 0),
                    "total_stake": result.get("total_stake", 0.0),
                    "total_liability": result.get("total_liability", 0.0),
                    "total_pnl": result.get("total_pnl", 0.0),
                    "roi": result.get("roi", 0.0),
                }
                resp["results"] = result.get("results", [])
            elif job["status"] == "error":
                resp["error"] = job["error"]
            return resp

        # ── Sandbox: create a rule ────────────────────────────────────────────
        elif tool_name == "create_sandbox_rule":
            rule, error = _sandbox.add_rule(
                name=tool_input.get("name", "Unnamed Rule"),
                description=tool_input.get("description", ""),
                rule_type=tool_input.get("rule_type", "STAKE_MODIFIER"),
                conditions=tool_input.get("conditions", []),
                effect=tool_input.get("effect", {}),
            )
            if error:
                return {"error": error}
            persist_sandbox(_sandbox)
            return {"created": rule.to_dict()}

        # ── Sandbox: list rules ───────────────────────────────────────────────
        elif tool_name == "list_sandbox_rules":
            return {"rules": _sandbox.list_rules(), "count": _sandbox.size()}

        # ── Sandbox: delete a rule ────────────────────────────────────────────
        elif tool_name == "delete_sandbox_rule":
            rule_id = tool_input.get("rule_id", "")
            removed = _sandbox.remove_rule(rule_id)
            persist_sandbox(_sandbox)
            return {"deleted": removed, "rule_id": rule_id}

        # ── Sandbox: clear all rules ──────────────────────────────────────────
        elif tool_name == "clear_sandbox_rules":
            count = _sandbox.clear()
            persist_sandbox(_sandbox)
            return {"cleared": count}

        # ── Sandbox trays: create ─────────────────────────────────────────────
        elif tool_name == "create_sandbox_tray":
            tray, error = _sandbox.create_tray(tool_input)
            if error:
                return {"error": error}
            persist_sandbox(_sandbox)
            return {"created": tray.to_dict()}

        # ── Sandbox trays: update ─────────────────────────────────────────────
        elif tool_name == "update_tray":
            tray_id = tool_input.pop("tray_id", "")
            tray, error = _sandbox.update_tray(tray_id, tool_input)
            if error:
                return {"error": error}
            persist_sandbox(_sandbox)
            return {"updated": tray.to_dict()}

        # ── Sandbox trays: list ───────────────────────────────────────────────
        elif tool_name == "list_sandbox_trays":
            return {"trays": _sandbox.list_trays(), "count": _sandbox.tray_count()}

        else:
            return {"error": f"Unknown tool: {tool_name}"}

    except Exception as e:
        logging.error(f"Tool '{tool_name}' failed: {e}")
        return {"error": str(e)}


# Tool schema definitions for the CHIMERA AI chat agent
_CHAT_TOOLS = [
    {
        "name": "list_available_dates",
        "description": (
            "List all dates that have historic Betfair market data available in the GCS bucket "
            "via FSU1. Use this before running a backtest to confirm data exists for the target date. "
            "Dates before 2026-01-01 use ADVANCED data (full price ladder — backtest works fully). "
            "Dates from 2026-01-01 use BASIC data (last-traded-price only — backtest will skip all markets)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "list_markets_for_date",
        "description": "List WIN markets available for a specific date via FSU1. Shows venue, race time, and runner count.",
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Date in YYYY-MM-DD format, e.g. 2025-07-13",
                },
                "countries": {
                    "type": "string",
                    "description": "Comma-separated country codes, e.g. 'GB,IE'. Defaults to GB,IE.",
                },
            },
            "required": ["date"],
        },
    },
    {
        "name": "run_backtest",
        "description": (
            "Start a backtest job for a specific date. Returns a job_id immediately. "
            "Poll with get_backtest_job until status is 'done'. "
            "Set sandbox_enabled=true to apply any active sandbox rules during the backtest. "
            "Key parameters: date (required), countries, process_window_mins, "
            "rule1_enabled through rule4_enabled, mark_rules_enabled, jofs_enabled, "
            "market_overlay_enabled, sandbox_enabled."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Backtest date, YYYY-MM-DD"},
                "countries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Country codes, e.g. ['GB', 'IE']",
                },
                "process_window_mins": {
                    "type": "number",
                    "description": "Minutes before race time to evaluate (default 5)",
                },
                "rule1_enabled": {"type": "boolean"},
                "rule2_enabled": {"type": "boolean"},
                "rule3_enabled": {"type": "boolean"},
                "rule4_enabled": {"type": "boolean"},
                "mark_rules_enabled": {"type": "boolean"},
                "jofs_enabled": {"type": "boolean"},
                "market_overlay_enabled": {"type": "boolean"},
                "sandbox_enabled": {
                    "type": "boolean",
                    "description": "Apply active sandbox rules during this backtest",
                },
            },
            "required": ["date"],
        },
    },
    {
        "name": "get_backtest_job",
        "description": (
            "Poll a running backtest job for status and results. "
            "Status values: 'running' (still in progress), 'done' (results available), 'error'. "
            "When done, returns a summary (P&L, ROI, bet count) and full per-market results."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "The job_id returned by run_backtest"},
            },
            "required": ["job_id"],
        },
    },
    {
        "name": "create_sandbox_rule",
        "description": (
            "Create a temporary sandbox rule for strategy testing. Rules are held in memory "
            "and applied to backtests when sandbox_enabled=true. "
            "rule_type options: STAKE_MODIFIER (scale stake), BET_FILTER (veto bet), SIGNAL_AMPLIFIER (scale signal confidence). "
            "Condition fields: exchange_overround, favourite_price, price_gap_1_2, price_gap_2_3, runner_count. "
            "Condition operators: gt, lt, gte, lte, eq. "
            "Effect fields: stake_multiplier (float), skip (bool), signal_multiplier (float), reason (string)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short rule name, e.g. 'High overround amplifier'"},
                "description": {"type": "string", "description": "What this rule does and why"},
                "rule_type": {
                    "type": "string",
                    "enum": ["STAKE_MODIFIER", "BET_FILTER", "SIGNAL_AMPLIFIER"],
                },
                "conditions": {
                    "type": "array",
                    "description": "All conditions must be true for the rule to fire (AND logic)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field": {"type": "string"},
                            "operator": {"type": "string", "enum": ["gt", "lt", "gte", "lte", "eq"]},
                            "value": {"type": "number"},
                        },
                        "required": ["field", "operator", "value"],
                    },
                },
                "effect": {
                    "type": "object",
                    "properties": {
                        "stake_multiplier": {"type": "number"},
                        "skip": {"type": "boolean"},
                        "signal_multiplier": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                },
            },
            "required": ["name", "rule_type", "conditions", "effect"],
        },
    },
    {
        "name": "list_sandbox_rules",
        "description": "List all active sandbox rules currently in memory.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "delete_sandbox_rule",
        "description": "Delete a specific sandbox rule by its ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "string", "description": "The rule ID returned by create_sandbox_rule"},
            },
            "required": ["rule_id"],
        },
    },
    {
        "name": "clear_sandbox_rules",
        "description": "Remove all sandbox rules from memory. Use after a test cycle is complete.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "create_sandbox_tray",
        "description": (
            "Create a new sandbox tray — a full rule-testing workspace that tracks the complete "
            "lifecycle of one rule or strategy under test. A tray stores the rule specification "
            "(family name, priority, purpose, inputs, checkpoints, metrics, threshold bands, "
            "sub-rules, expected output, lay action), the backtest results, and your analysis. "
            "Create a tray at the start of each new test. Link sandbox rules and backtest results "
            "to it using update_tray. The tray appears in the Strategy tab UI for Mark to review."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Display name, e.g. 'TOP2_CONCENTRATION Test'"},
                "rule_family": {"type": "string", "description": "Rule family code, e.g. 'TOP2_CONCENTRATION'"},
                "test_instruction": {"type": "string", "description": "What you were asked to test"},
                "priority": {"type": "string", "description": "Where in the engine pipeline this runs"},
                "purpose": {"type": "string", "description": "Objective — what problem this rule solves"},
                "inputs_required": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Market data fields needed, e.g. ['runner_1_back_odds', 'runner_2_back_odds']",
                },
                "checkpoints": {
                    "type": "array", "items": {"type": "string"},
                    "description": "When to evaluate, e.g. ['T-30', 'T-15', 'T-5', 'T-1']",
                },
                "derived_metrics": {
                    "type": "array",
                    "description": "Calculated values, e.g. [{name, formula, description}]",
                    "items": {"type": "object"},
                },
                "threshold_bands": {
                    "type": "array",
                    "description": "Sensitivity bands e.g. [{name, field, operator, value, severity}]",
                    "items": {"type": "object"},
                },
                "sub_rules": {
                    "type": "array",
                    "description": "Individual rule definitions with trigger logic and effects",
                    "items": {"type": "object"},
                },
                "expected_output": {
                    "type": "object",
                    "description": "The state object this rule returns (schema/example)",
                },
                "lay_action": {
                    "type": "string",
                    "enum": ["WATCH", "SUPPRESS", "BLOCK", "ALLOW", ""],
                    "description": "Primary lay action when this rule fires",
                },
                "lay_multiplier": {"type": "number", "description": "Stake multiplier when triggered (e.g. 0.25 = 75% suppression)"},
                "severity": {"type": "string", "description": "mild | medium | strong | extreme"},
                "reason_codes": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Reason codes this rule can emit",
                },
                "sandbox_rule_ids": {
                    "type": "array", "items": {"type": "string"},
                    "description": "IDs of sandbox rules created for this test",
                },
                "notes": {"type": "string", "description": "Any additional notes"},
            },
            "required": ["rule_family", "test_instruction"],
        },
    },
    {
        "name": "update_tray",
        "description": (
            "Update an existing sandbox tray with new information — typically to save backtest "
            "results and your analysis after a test completes. Also use to update status "
            "(PENDING → RUNNING → COMPLETED) or to refine the rule spec. "
            "Status values: PENDING, RUNNING, COMPLETED, PROMOTED, DISCARDED."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tray_id": {"type": "string", "description": "The tray ID returned by create_sandbox_tray"},
                "status": {"type": "string", "enum": ["PENDING", "RUNNING", "COMPLETED", "PROMOTED", "DISCARDED"]},
                "backtest_job_id": {"type": "string"},
                "backtest_config": {"type": "object"},
                "backtest_results": {"type": "object", "description": "Full results from get_backtest_job"},
                "agent_analysis": {"type": "string", "description": "Your analysis and recommendation"},
                "sandbox_rule_ids": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"},
                "lay_action": {"type": "string"},
                "lay_multiplier": {"type": "number"},
                "severity": {"type": "string"},
                "reason_codes": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tray_id"],
        },
    },
    {
        "name": "list_sandbox_trays",
        "description": "List all sandbox trays currently in memory with their status and summary.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]


@app.post("/api/chat")
def chat(req: ChatRequest):
    """
    Interactive chat with CHIMERA AI agent.

    Supports an agentic tool-use loop: Claude can call tools to query FSU1
    historic data, trigger and monitor backtests, and manage sandbox rules —
    all within a single conversational turn.
    """
    if not ANTHROPIC_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "ANTHROPIC_API_KEY not configured"},
        )

    ds = engine.settings.get("ai_data_sources", {})

    # Build session context (only if enabled)
    session_data = []
    if ds.get("session_data", True):
        if req.date:
            context_sessions = [s for s in engine.sessions if s.get("date") == req.date]
            session_data = _compact_session_data(context_sessions)
        else:
            session_data = [
                {
                    "session_id": s["session_id"],
                    "mode": s["mode"],
                    "date": s.get("date"),
                    "status": s.get("status"),
                    "summary": s.get("summary", {}),
                }
                for s in engine.sessions
            ]

    settled_context = ""
    if ds.get("settled_bets", True) and req.date:
        settled = _get_settled_for_date(req.date)
        if settled:
            settled_context = f"""

SETTLED BETS FROM BETFAIR (actual race outcomes with real P/L):
{json.dumps(settled, indent=2, default=str)}"""

    historical = {}
    if ds.get("historical_summary", True):
        historical = _get_historical_summary()

    engine_state_ctx = ""
    if ds.get("engine_state", True):
        engine_state_ctx = f"""
Active countries: {', '.join(engine.countries)}
Engine mode: {"DRY_RUN" if engine.dry_run else "LIVE"}
Balance: {engine.balance}"""

    rules_ctx = ""
    if ds.get("rule_definitions", True):
        rules_ctx = RULES_DESCRIPTION

    betfair_history_ctx = ""
    if ds.get("betfair_history", True):
        bh = _load_betfair_history(target_date=req.date)
        betfair_history_ctx = f"""

BETFAIR ACCOUNT HISTORY (exported CSV — actual Betfair account bets with real P/L):
{json.dumps(bh, indent=2, default=str)}"""

    market_inventory_ctx = ""
    if ds.get("market_data_inventory", True):
        inv = _get_market_data_inventory()
        market_inventory_ctx = f"""

BETFAIR HISTORIC MARKET DATA INVENTORY (available for backtesting via FSU1):
{json.dumps(inv, indent=2, default=str)}"""

    date_context_note = (
        f"You are viewing data for a specific date: {req.date}. Full bet detail is included where available."
        if req.date else
        "You have access to ALL sessions from the full history (summaries only — ask about a specific date for full bet detail). "
        "Win/loss P&L data is only available for dates where a daily report has been generated; "
        "for earlier dates you have bet counts, stake, and liability from session summaries."
    )

    # Sandbox state for context
    sandbox_ctx = ""
    has_sandbox = _sandbox.size() > 0 or _sandbox.tray_count() > 0
    if has_sandbox:
        sandbox_ctx = ""
        if _sandbox.size() > 0:
            sandbox_ctx += f"""

ACTIVE SANDBOX RULES ({_sandbox.size()} rules in memory):
{json.dumps(_sandbox.list_rules(), indent=2)}
These rules will be applied to any backtest run with sandbox_enabled=true."""
        if _sandbox.tray_count() > 0:
            sandbox_ctx += f"""

ACTIVE SANDBOX TRAYS ({_sandbox.tray_count()} trays):
{json.dumps(_sandbox.list_trays(), indent=2)}
Each tray is a full rule-testing workspace visible in the Strategy tab."""

    system_prompt = f"""You are CHIMERA, an expert horse racing lay betting AI agent and analyst.
You have access to data from the CHIMERA Lay Engine and a suite of tools to query historic data,
run and monitor backtests, and create/manage sandbox rules and trays for strategy testing.

{date_context_note}

{rules_ctx}
{engine_state_ctx}

SESSION DATA (bets placed by the engine):
{json.dumps(session_data, indent=2, default=str) if session_data else "(Session data not enabled)"}{settled_context}

HISTORICAL SUMMARY (all operating days, including DRY_RUN and LIVE):
{json.dumps(historical, indent=2, default=str) if historical else "(Historical data not enabled)"}
{betfair_history_ctx}
{market_inventory_ctx}
{sandbox_ctx}

TOOL USE GUIDELINES:
- Before running a backtest, always call list_available_dates to confirm data exists for the target date.
- Only ADVANCED data (pre-2026) has full price ladders required for backtesting. BASIC data (2026+) will result in all markets being skipped.
- When given a new rule or strategy to test: (1) call create_sandbox_tray to open a workspace, (2) call create_sandbox_rule to define the rule logic, (3) call run_backtest with sandbox_enabled=true, (4) poll get_backtest_job until done, (5) call update_tray with the results and your analysis, (6) set tray status to COMPLETED.
- Sandbox rules persist until deleted. Clean up with clear_sandbox_rules after a test cycle.
- Backtest jobs run asynchronously. Poll get_backtest_job every few seconds until status is 'done'.
- Be specific with numbers. Keep responses concise and data-driven.
- Never say data is missing for a date — if P&L is unavailable, say so but still report what is available."""

    messages = [{"role": h.role, "content": h.content} for h in req.history]
    messages.append({"role": "user", "content": req.message})

    try:
        client = get_anthropic()
        # Agentic tool-use loop — runs until Claude produces a final text response
        max_iterations = 10  # guard against infinite loops
        for _ in range(max_iterations):
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=4096,
                system=system_prompt,
                tools=_CHAT_TOOLS,
                messages=messages,
            )

            if response.stop_reason == "end_turn":
                # Extract the final text block
                text_blocks = [b.text for b in response.content if hasattr(b, "text")]
                reply = text_blocks[0] if text_blocks else "(No response)"
                return {"reply": reply}

            if response.stop_reason == "tool_use":
                # Execute all requested tools and collect results
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        result = _chat_execute_tool(block.name, block.input)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(result),
                        })
                # Append assistant turn + tool results to messages for next iteration
                # Serialise content blocks to plain dicts — passing raw Pydantic SDK
                # objects causes a Pydantic v2 by_alias=None error on re-serialisation.
                serialised_content = []
                for b in response.content:
                    if b.type == "tool_use":
                        serialised_content.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
                    elif b.type == "text":
                        serialised_content.append({"type": "text", "text": b.text})
                    else:
                        serialised_content.append(b.model_dump() if hasattr(b, "model_dump") else {"type": b.type})
                messages.append({"role": "assistant", "content": serialised_content})
                messages.append({"role": "user", "content": tool_results})
                continue

            # Unexpected stop reason — return whatever text exists
            text_blocks = [b.text for b in response.content if hasattr(b, "text")]
            return {"reply": text_blocks[0] if text_blocks else "(No response)"}

        return {"reply": "I reached the maximum number of tool calls for this request. Please try a more specific question."}

    except Exception as e:
        logging.error(f"Chat failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Chat failed: {str(e)}"},
        )


# ──────────────────────────────────────────────
#  REPORTS
# ──────────────────────────────────────────────

REPORT_TEMPLATES = {
    "daily_performance": {
        "name": "Daily Performance Report",
        "description": "Comprehensive daily analysis based on the CHIMERA Day 8 report format.",
    },
}


class GenerateReportRequest(BaseModel):
    date: str
    session_ids: list[str]
    template: str = "daily_performance"


DAILY_REPORT_PROMPT = """You are a professional horse racing lay betting analyst producing a structured daily performance report for the CHIMERA Lay Engine. You MUST output a single valid JSON object conforming exactly to the schema below. No markdown, no commentary — only the JSON object.

{rules_description}

=== SCHEMA (TypeScript — follow these field names and types exactly) ===

interface ChimeraReport {{
  meta: {{
    schema_version: string;        // Always "1.0.0"
    report_title: string;          // "CHIMERA Lay Engine Performance Report"
    subtitle: string;              // "Automated Lay Betting Performance Analysis"
    day_number: number;            // Sequential operating day (count from historical data)
    trading_date: string;          // ISO 8601: "YYYY-MM-DD"
    report_date: string;           // ISO 8601: today's date
    prepared_for: string;          // "Mark Insley"
    prepared_by: string;           // "CHIMERA AI Agent"
    version: string;               // "1.0"
    confidential: boolean;         // true
    engine_version: string;        // "CHIMERA Lay Engine v5.0"
    dry_run_disabled: boolean;     // true if mode is LIVE
  }};
  executive_summary: {{
    headline: string;              // One-sentence headline finding
    narrative: string;             // 3-4 sentence summary
    key_findings: string[];        // 5-7 bullet point findings
  }};
  day_performance: {{
    slices: Array<{{
      label: string;               // "All Bets", "Sub-2.0 Only", "2.0+ Only"
      total_bets: number;
      wins: number;
      losses: number;
      strike_rate: number;         // Decimal: 0.615 = 61.5%
      net_pl: number;              // GBP raw number
      total_staked: number;        // GBP
      roi: number;                 // Decimal: 0.266 = +26.6%
    }}>;
    narrative: string;
  }};
  odds_band_analysis: {{
    bands: Array<{{
      label: string;               // "< 2.0", "2.0–2.99", "3.0–3.99", "4.0–4.99", "5.0+"
      min_odds: number | null;
      max_odds: number | null;
      bets: number;
      wins: number;
      win_pct: number;             // Decimal
      pl: number;                  // GBP
      roi: number;                 // Decimal
      verdict: string;             // ELITE|PRIME|STRONG|SOLID|CORE|MIXED|WEAK|POOR|TOXIC|EXCLUDE|ANOMALY|MONITOR
      notes: string;
    }}>;
    narrative: string;
  }};
  cumulative_performance: {{
    by_day: Array<{{
      day_number: number;
      date: string;
      bets: number;
      wins: number;
      losses: number;
      strike_rate: number;         // Decimal
      pl: number;                  // GBP
      cumulative_pl: number;       // Running total GBP
      notes?: string;
    }}>;
    by_band: Array<{{
      label: string;
      bets: number;
      wins: number;
      losses: number;
      strike_rate: number;         // Decimal
      pl: number;
      status: string;              // Same verdict enum
      recommendation: string;
    }}>;
    narrative: string;
  }};
  drift_analysis: null;            // Set to null — no snapshot data yet
  discipline_analysis: {{
    rows: Array<{{
      discipline: string;          // "Flat", "Flat (AW)", "Jumps (NH)"
      bets: number;
      wins: number;
      losses: number;
      strike_rate: number;         // Decimal
      pl: number;
      roi: number;                 // Decimal
    }}>;
    narrative: string;
  }};
  venue_analysis: {{
    rows: Array<{{
      venue: string;
      country: string;             // "GB", "IE", "FR", "ZA"
      discipline: string;
      bets: number;
      wins: number;
      losses: number;
      strike_rate: number;         // Decimal
      pl: number;
      roi: number;                 // Decimal
      rating: string;              // SUPERB|EXCELLENT|GOOD|FAIR|MARGINAL|MIXED|POOR
    }}>;
    narrative: string;
  }};
  bets: Array<{{
    selection: string;             // Runner name
    venue: string;
    market: string;                // e.g. "GB Flat", "IE Jumps"
    race_time: string;             // "HH:MM" format
    odds: number;
    stake: number;
    liability: number;
    pl: number;                    // +stake for WIN, -liability for LOSS
    result: string;                // "WIN" | "LOSS" | "VOID" | "NR"
    band_label: string;            // Which odds band this falls in
  }}>;
  timing_analysis: null;           // Set to null unless timing data available
  weekday_weekend: null;           // Set to null unless weekend data available
  agent_analysis: null;            // Set to null
  conclusions: {{
    findings: Array<{{
      number: number;
      priority: boolean;           // true for top 1-3 findings
      text: string;
    }}>;
    recommendations: Array<{{
      number: number;
      priority: boolean;           // true for top 1-3 recommendations
      text: string;
    }}>;
  }};
  appendix: {{
    day_over_day?: Array<{{
      metric: string;
      values: Record<string, string | number>;
    }}>;
    data_sources: Array<{{
      label: string;
      value: string;
    }}>;
  }};
}}

=== PRE-COMPUTED AGGREGATIONS (AUTHORITATIVE — copy these values exactly) ===

These figures were computed in Python directly from the settled bet records.
You MUST use them verbatim for the matching fields — do NOT recompute from raw data.

{computed_stats}

Mapping to schema fields:
  day_performance.slices[0] ("All Bets"):
    total_bets    ← computed total_bets
    wins          ← computed wins
    losses        ← computed losses
    strike_rate   ← computed strike_rate   (decimal, e.g. 0.816)
    net_pl        ← computed net_pl        (GBP, e.g. 262.97)
    total_staked  ← computed total_staked
    roi           ← computed roi           (decimal)

  odds_band_analysis.bands — use computed bands[] in order.
    For each band: label, bets, wins, win_pct, pl, roi come from the computed values.
    losses = bets - wins (compute inline).

=== DATA INPUTS ===

TRADING DATE: {date}
REPORT DATE: {report_date}

SESSION DATA (bets placed by the engine, with rule evaluations):
{session_data}

SETTLED BETS FROM BETFAIR (actual race outcomes with real P/L — use for individual bet records and cross-referencing):
{settled_data}

HISTORICAL SESSIONS (all previous operating days — use for cumulative_performance):
{historical_data}

ENGINE STATE:
- Active countries: {countries}
- Mode: {mode}
- Engine version: CHIMERA Lay Engine v5.0

=== INSTRUCTIONS ===

1. The PRE-COMPUTED AGGREGATIONS above are authoritative. Use them exactly for summary totals and band P&Ls. Do not recount or resum from raw data.
2. Use SETTLED BETS data to populate the individual bets[] array (runner name, venue, odds, stake, liability, pl, result, band_label). Cross-reference by runner name and venue.
3. If settled data is empty (e.g. dry run mode or Betfair not authenticated), calculate P/L from session data using: WIN = +stake, LOSS = -liability.
4. For cumulative_performance.by_day, include the most recent 30 operating days (plus today). Older days can be omitted to keep output concise.
5. For cumulative_performance.by_band, aggregate across ALL days (historical + today).
6. Strike rates and ROI are DECIMAL values (0.615 not 61.5, 0.266 not 26.6).
7. P/L values are raw GBP numbers (use -5.60 not "-£5.60").
8. Be precise with numbers — do not invent data. Only use the data provided.
8a. Keep all narrative and notes fields concise — maximum 2 sentences each.
9. The day_number should be calculated from the historical data (count of unique operating dates + 1 for today).
10. Include ALL bets with WIN or LOSS outcome in the bets array. Exclude VOID, NR, or unknown-result bets from all sections.
11. Output ONLY the JSON object. No backticks, no markdown fences, no explanatory text."""


@app.get("/api/reports/templates")
def get_report_templates():
    """List available report templates."""
    return {"templates": [
        {"id": k, "name": v["name"], "description": v["description"]}
        for k, v in REPORT_TEMPLATES.items()
    ]}


@app.post("/api/reports/generate")
def generate_report(req: GenerateReportRequest):
    """Generate an AI-powered daily report for the selected sessions.

    Gathers all available data sources:
    - Session data (bets placed, rule evaluations)
    - Settled bet outcomes from Betfair (actual P/L)
    - Historical session data for cumulative performance
    Then instructs the AI to produce a structured JSON report
    conforming to the ChimeraReport schema.
    """
    if not ANTHROPIC_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "ANTHROPIC_API_KEY not configured"},
        )

    if req.template not in REPORT_TEMPLATES:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Unknown template: {req.template}"},
        )

    # Get the selected sessions
    selected_sessions = []
    for sid in req.session_ids:
        detail = engine.get_session_detail(sid)
        if detail:
            selected_sessions.append(detail)

    if not selected_sessions:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "No matching sessions found"},
        )

    try:
        ds = engine.settings.get("ai_data_sources", {})

        # 1. Compact session data (enriched with venue, country, market_id)
        session_data = _compact_session_data(selected_sessions) if ds.get("session_data", True) else []

        # 2. Settled bet data from Betfair (actual WIN/LOSS outcomes)
        settled_data = _get_settled_for_date(req.date) if ds.get("settled_bets", True) else None

        # 3. Historical session data for cumulative performance
        historical_data = _get_historical_summary(exclude_date=req.date) if ds.get("historical_summary", True) else {}

        # 4. Pre-compute authoritative aggregations from settled data
        computed_stats = _compute_day_stats(settled_data) if settled_data else {
            "note": "No settled data — aggregations unavailable; AI must estimate from session data"
        }

        # Cache today's stats for cumulative_performance in future reports
        if computed_stats and "note" not in computed_stats:
            engine.daily_stats_cache[req.date] = computed_stats
            engine._save_stats_cache()

        # 5. Current engine state
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        mode = "DRY_RUN" if engine.dry_run else "LIVE"
        # Check mode from selected sessions — they may differ from current
        session_modes = set(s.get("mode") for s in selected_sessions)
        if session_modes:
            mode = "LIVE" if "LIVE" in session_modes else "DRY_RUN"

        prompt = DAILY_REPORT_PROMPT.format(
            rules_description=RULES_DESCRIPTION,
            date=req.date,
            report_date=now.strftime("%Y-%m-%d"),
            computed_stats=json.dumps(computed_stats, indent=2, default=str),
            session_data=json.dumps(session_data, indent=2, default=str),
            settled_data=json.dumps(settled_data, indent=2, default=str) if settled_data else "[]  (No settled data available — use session data to calculate P/L)",
            historical_data=json.dumps(historical_data, indent=2, default=str),
            countries=", ".join(engine.countries),
            mode=mode,
        )
    except Exception as e:
        logging.error(f"Report data preparation failed: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Report data preparation failed: {str(e)}"},
        )

    try:
        client = get_anthropic()
        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=32768,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            report_text = stream.get_final_text()
            final_msg = stream.get_final_message()
        if final_msg.stop_reason == "max_tokens":
            logging.warning(f"Report response truncated — hit max_tokens ({32768})")

        # Parse the JSON response — strip any markdown fencing if present
        import re
        clean_text = report_text.strip()
        # Remove opening ```json or ``` fence
        clean_text = re.sub(r'^```\w*\s*\n?', '', clean_text)
        # Remove closing ``` fence
        clean_text = re.sub(r'\n?```\s*$', '', clean_text)
        clean_text = clean_text.strip()

        try:
            report_json = json.loads(clean_text)
        except json.JSONDecodeError as je:
            logging.error(f"Failed to parse AI report JSON: {je}")
            logging.error(f"Raw response (first 500 chars): {report_text[:500]}")
            # Fall back to storing raw text
            report_json = None

        report_id = f"rpt_{now.strftime('%Y%m%d_%H%M%S')}"
        template_info = REPORT_TEMPLATES[req.template]

        report = {
            "report_id": report_id,
            "date": req.date,
            "session_ids": req.session_ids,
            "template": req.template,
            "template_name": template_info["name"],
            "created_at": now.isoformat(),
            "title": f"{template_info['name']} — {req.date}",
            "content": report_json if report_json else report_text,
            "format": "json" if report_json else "markdown",
        }
        engine.reports.append(report)
        engine._save_reports()

        # Auto-send to recipients if email is enabled
        recipients = engine.settings.get("report_recipients", [])
        ai_caps = engine.settings.get("ai_capabilities", {})
        email_result = None
        if recipients and ai_caps.get("send_emails"):
            email_result = _send_report_email(report, recipients)

        report["email_result"] = email_result
        return report
    except Exception as e:
        logging.error(f"Report generation failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Report generation failed: {str(e)}"},
        )


@app.get("/api/reports")
def list_reports():
    """List all generated reports (without content for efficiency)."""
    return {
        "reports": [
            {
                "report_id": r["report_id"],
                "date": r["date"],
                "template": r["template"],
                "template_name": r.get("template_name", ""),
                "title": r["title"],
                "created_at": r["created_at"],
                "session_ids": r.get("session_ids", []),
            }
            for r in reversed(engine.reports)
        ]
    }


@app.get("/api/reports/{report_id}")
def get_report(report_id: str):
    """Get a specific report with full content."""
    for r in engine.reports:
        if r["report_id"] == report_id:
            return r
    return JSONResponse(
        status_code=404,
        content={"status": "error", "message": "Report not found"},
    )


@app.delete("/api/reports/{report_id}")
def delete_report(report_id: str):
    """Delete a report."""
    for i, r in enumerate(engine.reports):
        if r["report_id"] == report_id:
            engine.reports.pop(i)
            engine._save_reports()
            return {"status": "ok", "message": "Report deleted"}
    return JSONResponse(
        status_code=404,
        content={"status": "error", "message": "Report not found"},
    )


# ──────────────────────────────────────────────
#  SETTINGS: Recipients, AI Data Sources, AI Capabilities
# ──────────────────────────────────────────────

class RecipientModel(BaseModel):
    email: str
    name: str = ""

class UpdateRecipientsRequest(BaseModel):
    recipients: list[RecipientModel]

class UpdateAIDataSourcesRequest(BaseModel):
    ai_data_sources: dict[str, bool]

class UpdateAICapabilitiesRequest(BaseModel):
    ai_capabilities: dict[str, bool]


@app.get("/api/settings")
def get_settings():
    """Return app settings (recipients, data sources, AI capabilities)."""
    return engine.settings


@app.put("/api/settings/recipients")
def update_recipients(req: UpdateRecipientsRequest):
    """Update the list of report email recipients."""
    engine.settings["report_recipients"] = [r.dict() for r in req.recipients]
    engine._save_settings()
    return {"status": "ok", "recipients": engine.settings["report_recipients"]}


@app.put("/api/settings/ai-data-sources")
def update_ai_data_sources(req: UpdateAIDataSourcesRequest):
    """Toggle which data sources are exposed to the AI agent."""
    engine.settings["ai_data_sources"].update(req.ai_data_sources)
    engine._save_settings()
    return {"status": "ok", "ai_data_sources": engine.settings["ai_data_sources"]}


@app.put("/api/settings/ai-capabilities")
def update_ai_capabilities(req: UpdateAICapabilitiesRequest):
    """Toggle which actions the AI agent is allowed to perform."""
    engine.settings["ai_capabilities"].update(req.ai_capabilities)
    engine._save_settings()
    return {"status": "ok", "ai_capabilities": engine.settings["ai_capabilities"]}


# ──────────────────────────────────────────────
#  EMAIL: Send reports to recipients
# ──────────────────────────────────────────────

SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "chimera@thync.online")
EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "CHIMERA Lay Engine")


def _render_report_html(data: dict) -> str:
    """Render a ChimeraReport JSON structure into styled HTML (mirrors frontend renderJsonReport)."""
    def fpl(v):
        if v is None: return "—"
        return f"+£{v:.2f}" if v >= 0 else f"−£{abs(v):.2f}"
    def fpct(v):
        if v is None: return "—"
        return f"{(v * 100):.1f}%"
    def fodds(v):
        return f"{v:.2f}" if v else "—"

    ts = ("border-collapse: collapse; width: 100%; font-size: 13px; margin: 12px 0;"
          " border: 1px solid #e5e7eb;")
    th = "padding: 6px 10px; text-align: left; background: #f1f5f9; border: 1px solid #e5e7eb; font-size: 12px;"
    td = "padding: 6px 10px; border: 1px solid #e5e7eb; font-size: 12px;"
    h2s = "color: #1a1a2e; font-size: 18px; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px;"

    h = ""
    m = data.get("meta", {})
    h += f'<h1 style="color: #2563eb; font-size: 22px;">CHIMERA Lay Engine Performance Report</h1>'
    h += f'<h2 style="{h2s}">Day {m.get("day_number", "?")} — {m.get("trading_date", "")}</h2>'
    h += f'<p style="color: #6b7280;"><em>Prepared by {m.get("prepared_by", "CHIMERA AI Agent")} | {m.get("engine_version", "")} | {"LIVE" if m.get("dry_run_disabled") else "DRY RUN"}</em></p>'

    es = data.get("executive_summary")
    if es:
        h += f'<h2 style="{h2s}">Executive Summary</h2>'
        if es.get("headline"): h += f'<p><strong>{es["headline"]}</strong></p>'
        if es.get("narrative"): h += f'<p>{es["narrative"]}</p>'
        if es.get("key_findings"):
            h += "<ul>" + "".join(f"<li>{f}</li>" for f in es["key_findings"]) + "</ul>"

    dp = data.get("day_performance")
    if dp and dp.get("slices"):
        h += f'<h2 style="{h2s}">Performance Summary</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Slice</th><th style="{th}">Bets</th><th style="{th}">Record</th><th style="{th}">Strike</th><th style="{th}">Staked</th><th style="{th}">P/L</th><th style="{th}">ROI</th></tr></thead><tbody>'
        for s in dp["slices"]:
            h += f'<tr><td style="{td}">{s.get("label","")}</td><td style="{td}">{s.get("total_bets","")}</td><td style="{td}">{s.get("wins",0)}W-{s.get("losses",0)}L</td><td style="{td}">{fpct(s.get("strike_rate"))}</td><td style="{td}">£{s.get("total_staked",0):.2f}</td><td style="{td}">{fpl(s.get("net_pl"))}</td><td style="{td}">{fpct(s.get("roi"))}</td></tr>'
        h += "</tbody></table>"
        if dp.get("narrative"): h += f'<p style="color: #6b7280;"><em>{dp["narrative"]}</em></p>'

    ob = data.get("odds_band_analysis")
    if ob and ob.get("bands"):
        h += f'<h2 style="{h2s}">Odds Band Analysis</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Band</th><th style="{th}">Bets</th><th style="{th}">Wins</th><th style="{th}">Strike</th><th style="{th}">P/L</th><th style="{th}">ROI</th><th style="{th}">Verdict</th></tr></thead><tbody>'
        for b in ob["bands"]:
            h += f'<tr><td style="{td}">{b.get("label","")}</td><td style="{td}">{b.get("bets","")}</td><td style="{td}">{b.get("wins","")}</td><td style="{td}">{fpct(b.get("win_pct"))}</td><td style="{td}">{fpl(b.get("pl"))}</td><td style="{td}">{fpct(b.get("roi"))}</td><td style="{td}"><strong>{b.get("verdict","")}</strong></td></tr>'
        h += "</tbody></table>"
        if ob.get("narrative"): h += f'<p style="color: #6b7280;"><em>{ob["narrative"]}</em></p>'

    da = data.get("discipline_analysis")
    if da and da.get("rows"):
        h += f'<h2 style="{h2s}">Discipline Analysis</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Discipline</th><th style="{th}">Bets</th><th style="{th}">Record</th><th style="{th}">Strike</th><th style="{th}">P/L</th><th style="{th}">ROI</th></tr></thead><tbody>'
        for r in da["rows"]:
            h += f'<tr><td style="{td}">{r.get("discipline","")}</td><td style="{td}">{r.get("bets","")}</td><td style="{td}">{r.get("wins",0)}W-{r.get("losses",0)}L</td><td style="{td}">{fpct(r.get("strike_rate"))}</td><td style="{td}">{fpl(r.get("pl"))}</td><td style="{td}">{fpct(r.get("roi"))}</td></tr>'
        h += "</tbody></table>"

    va = data.get("venue_analysis")
    if va and va.get("rows"):
        h += f'<h2 style="{h2s}">Venue Analysis</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Venue</th><th style="{th}">Country</th><th style="{th}">Disc.</th><th style="{th}">Bets</th><th style="{th}">Record</th><th style="{th}">Strike</th><th style="{th}">P/L</th><th style="{th}">ROI</th><th style="{th}">Rating</th></tr></thead><tbody>'
        for r in va["rows"]:
            h += f'<tr><td style="{td}">{r.get("venue","")}</td><td style="{td}">{r.get("country","")}</td><td style="{td}">{r.get("discipline","")}</td><td style="{td}">{r.get("bets","")}</td><td style="{td}">{r.get("wins",0)}W-{r.get("losses",0)}L</td><td style="{td}">{fpct(r.get("strike_rate"))}</td><td style="{td}">{fpl(r.get("pl"))}</td><td style="{td}">{fpct(r.get("roi"))}</td><td style="{td}"><strong>{r.get("rating","")}</strong></td></tr>'
        h += "</tbody></table>"

    bets = [b for b in data.get("bets", []) if b.get("result") in ("WIN", "LOSS")]
    if bets:
        h += f'<h2 style="{h2s}">Individual Bet Breakdown</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Time</th><th style="{th}">Runner</th><th style="{th}">Venue</th><th style="{th}">Odds</th><th style="{th}">Stake</th><th style="{th}">Liability</th><th style="{th}">P/L</th><th style="{th}">Result</th><th style="{th}">Band</th><th style="{th}">Rule</th></tr></thead><tbody>'
        for b in bets:
            rc = "color:#16a34a" if b.get("result") == "WIN" else "color:#dc2626"
            h += f'<tr><td style="{td}">{b.get("race_time","")}</td><td style="{td}">{b.get("selection","")}</td><td style="{td}">{b.get("venue","")}</td><td style="{td}">{fodds(b.get("odds"))}</td><td style="{td}">£{b.get("stake",0):.2f}</td><td style="{td}">£{b.get("liability",0):.2f}</td><td style="{td}">{fpl(b.get("pl"))}</td><td style="{td};{rc}"><strong>{b.get("result","")}</strong></td><td style="{td}">{b.get("band_label","")}</td><td style="{td}">{b.get("rule","")}</td></tr>'
        h += "</tbody></table>"

    cp = data.get("cumulative_performance")
    if cp and cp.get("by_day"):
        h += f'<h2 style="{h2s}">Cumulative Performance — By Day</h2>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Day</th><th style="{th}">Date</th><th style="{th}">Bets</th><th style="{th}">Record</th><th style="{th}">Strike</th><th style="{th}">Day P/L</th><th style="{th}">Cumulative</th></tr></thead><tbody>'
        for d in cp["by_day"]:
            h += f'<tr><td style="{td}">{d.get("day_number","")}</td><td style="{td}">{d.get("date","")}</td><td style="{td}">{d.get("bets","")}</td><td style="{td}">{d.get("wins",0)}W-{d.get("losses",0)}L</td><td style="{td}">{fpct(d.get("strike_rate"))}</td><td style="{td}">{fpl(d.get("pl"))}</td><td style="{td}"><strong>{fpl(d.get("cumulative_pl"))}</strong></td></tr>'
        h += "</tbody></table>"
    if cp and cp.get("by_band"):
        h += f'<h3 style="color: #1a1a2e; font-size: 15px; margin-top: 20px;">Cumulative — By Odds Band</h3>'
        h += f'<table style="{ts}"><thead><tr><th style="{th}">Band</th><th style="{th}">Bets</th><th style="{th}">Record</th><th style="{th}">Strike</th><th style="{th}">P/L</th><th style="{th}">Status</th><th style="{th}">Recommendation</th></tr></thead><tbody>'
        for b in cp["by_band"]:
            h += f'<tr><td style="{td}">{b.get("label","")}</td><td style="{td}">{b.get("bets","")}</td><td style="{td}">{b.get("wins",0)}W-{b.get("losses",0)}L</td><td style="{td}">{fpct(b.get("strike_rate"))}</td><td style="{td}">{fpl(b.get("pl"))}</td><td style="{td}"><strong>{b.get("status","")}</strong></td><td style="{td}">{b.get("recommendation","")}</td></tr>'
        h += "</tbody></table>"

    cc = data.get("conclusions")
    if cc:
        if cc.get("findings"):
            h += f'<h2 style="{h2s}">Key Findings</h2><ol>'
            for f in cc["findings"]:
                txt = f.get("text", f) if isinstance(f, dict) else f
                h += f"<li><strong>{txt}</strong></li>" if (isinstance(f, dict) and f.get("priority")) else f"<li>{txt}</li>"
            h += "</ol>"
        if cc.get("recommendations"):
            h += f'<h2 style="{h2s}">Recommendations</h2><ol>'
            for r in cc["recommendations"]:
                txt = r.get("text", r) if isinstance(r, dict) else r
                h += f"<li><strong>{txt}</strong></li>" if (isinstance(r, dict) and r.get("priority")) else f"<li>{txt}</li>"
            h += "</ol>"

    return h


def _send_report_email(report: dict, recipients: list[dict]):
    """Send an HTML report to all recipients via SendGrid."""
    if not SENDGRID_API_KEY:
        logging.warning("SENDGRID_API_KEY not configured — skipping email dispatch")
        return {"sent": 0, "error": "SENDGRID_API_KEY not configured"}
    if not recipients:
        return {"sent": 0, "error": "No recipients configured"}

    import requests as http_requests

    content = report.get("content", "")
    if isinstance(content, dict):
        html_content = _render_report_html(content)
    elif isinstance(content, str):
        # Try to parse as JSON in case it's a stringified report
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                html_content = _render_report_html(parsed)
            else:
                html_content = content
        except (json.JSONDecodeError, ValueError):
            html_content = content
    else:
        html_content = str(content)

    subject = report.get("title", "CHIMERA Report")
    to_list = [{"email": r["email"], "name": r.get("name", "")} for r in recipients]

    payload = {
        "personalizations": [{"to": to_list}],
        "from": {"email": EMAIL_FROM, "name": EMAIL_FROM_NAME},
        "subject": subject,
        "content": [{"type": "text/html", "value": f"""
            <div style="font-family: 'Inter', 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; color: #1a1a2e;">
                {html_content}
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;"/>
                <p style="color: #8a8a9a; font-size: 12px;">
                    Sent automatically by CHIMERA Lay Engine.<br/>
                    Manage recipients in Settings → Report Recipients.
                </p>
            </div>
        """}],
    }

    try:
        resp = http_requests.post(
            "https://api.sendgrid.com/v3/mail/send",
            json=payload,
            headers={
                "Authorization": f"Bearer {SENDGRID_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=15,
        )
        if resp.status_code in (200, 201, 202):
            logging.info(f"Report email sent to {len(to_list)} recipients")
            return {"sent": len(to_list)}
        else:
            logging.error(f"SendGrid error {resp.status_code}: {resp.text}")
            return {"sent": 0, "error": f"SendGrid {resp.status_code}"}
    except Exception as e:
        logging.error(f"Email send failed: {e}")
        return {"sent": 0, "error": str(e)}


@app.post("/api/reports/{report_id}/send")
def send_report_to_recipients(report_id: str):
    """Manually send a report to all configured recipients."""
    report = None
    for r in engine.reports:
        if r["report_id"] == report_id:
            report = r
            break
    if not report:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Report not found"})

    recipients = engine.settings.get("report_recipients", [])
    if not recipients:
        return JSONResponse(status_code=400, content={"status": "error", "message": "No recipients configured"})

    result = _send_report_email(report, recipients)
    return {"status": "ok", **result}


# ──────────────────────────────────────────────
#  AUDIO: Whisper STT + OpenAI TTS
# ──────────────────────────────────────────────

@app.post("/api/audio/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe audio using OpenAI Whisper."""
    if not OPENAI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "OPENAI_API_KEY not configured"},
        )
    try:
        # Write uploaded audio to a temp file (Whisper API needs a file-like object with a name)
        suffix = ".webm"
        if file.content_type and "wav" in file.content_type:
            suffix = ".wav"
        elif file.content_type and "mp4" in file.content_type:
            suffix = ".mp4"

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        client = get_openai()
        with open(tmp_path, "rb") as audio_file:
            transcript = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language="en",
            )

        os.unlink(tmp_path)
        return {"text": transcript.text}
    except Exception as e:
        logging.error(f"Transcription failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Transcription failed: {str(e)}"},
        )


@app.post("/api/audio/speak")
def text_to_speech(req: dict):
    """Convert text to speech using OpenAI TTS."""
    if not OPENAI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "OPENAI_API_KEY not configured"},
        )
    text = req.get("text", "")
    if not text:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "No text provided"},
        )
    try:
        client = get_openai()
        response = client.audio.speech.create(
            model="tts-1",
            voice="nova",
            input=text[:4096],  # TTS has a 4096 char limit
            response_format="mp3",
        )
        audio_bytes = response.content
        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline; filename=speech.mp3"},
        )
    except Exception as e:
        logging.error(f"TTS failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"TTS failed: {str(e)}"},
        )


# ──────────────────────────────────────────────
#  API KEY MANAGEMENT (requires Betfair login)
# ──────────────────────────────────────────────

@app.post("/api/keys/generate")
def generate_api_key(req: GenerateKeyRequest):
    """Generate a new API key. Must be logged in."""
    if not engine.is_authenticated:
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Login required to manage API keys"},
        )
    key_record = engine.generate_api_key(req.label)
    return {
        "status": "ok",
        "key": key_record["key"],
        "key_id": key_record["key_id"],
        "label": key_record["label"],
        "message": "Save this key — it won't be shown again.",
    }


@app.get("/api/keys")
def list_api_keys():
    """List all API keys (masked)."""
    if not engine.is_authenticated:
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Login required to manage API keys"},
        )
    return {"keys": engine.list_api_keys()}


@app.delete("/api/keys/{key_id}")
def revoke_api_key(key_id: str):
    """Revoke an API key."""
    if not engine.is_authenticated:
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Login required to manage API keys"},
        )
    if engine.revoke_api_key(key_id):
        return {"status": "ok", "message": "Key revoked"}
    return JSONResponse(
        status_code=404,
        content={"status": "error", "message": "Key not found"},
    )


# ──────────────────────────────────────────────
#  DATA API (requires API key)
# ──────────────────────────────────────────────

@app.get("/api/data/sessions")
def data_sessions(
    date: str = Query(None, description="Filter by date (YYYY-MM-DD)"),
    mode: str = Query(None, description="Filter by mode (LIVE or DRY_RUN)"),
    _key: str = Depends(require_api_key),
):
    """All sessions with full detail. Optionally filter by date or mode."""
    sessions = engine.sessions
    if date:
        sessions = [s for s in sessions if s.get("date") == date]
    if mode:
        sessions = [s for s in sessions if s.get("mode") == mode.upper()]
    # Strip internal fields
    return {
        "count": len(sessions),
        "sessions": [
            {k: v for k, v in s.items() if not k.startswith("_")}
            for s in reversed(sessions)
        ],
    }


@app.get("/api/data/sessions/{session_id}")
def data_session_detail(session_id: str, _key: str = Depends(require_api_key)):
    """Full session detail including all bets and results."""
    detail = engine.get_session_detail(session_id)
    if detail is None:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Session not found"},
        )
    return detail


@app.get("/api/data/bets")
def data_bets(
    date: str = Query(None, description="Filter by date (YYYY-MM-DD)"),
    mode: str = Query(None, description="Filter by mode (LIVE or DRY_RUN)"),
    _key: str = Depends(require_api_key),
):
    """All bets across all sessions. Optionally filter by date or mode."""
    bets = []
    for s in engine.sessions:
        if date and s.get("date") != date:
            continue
        if mode and s.get("mode") != mode.upper():
            continue
        for b in s.get("bets", []):
            bet = dict(b)
            bet["session_id"] = s["session_id"]
            bet["session_mode"] = s["mode"]
            bet["session_date"] = s["date"]
            bets.append(bet)
    return {"count": len(bets), "bets": list(reversed(bets))}


@app.get("/api/data/results")
def data_results(
    date: str = Query(None, description="Filter by date (YYYY-MM-DD)"),
    _key: str = Depends(require_api_key),
):
    """All rule evaluation results across all sessions."""
    results = []
    for s in engine.sessions:
        if date and s.get("date") != date:
            continue
        for r in s.get("results", []):
            result = dict(r)
            result["session_id"] = s["session_id"]
            result["session_date"] = s["date"]
            results.append(result)
    return {"count": len(results), "results": list(reversed(results))}


@app.get("/api/data/state")
def data_state(_key: str = Depends(require_api_key)):
    """Current engine state (same as dashboard)."""
    return engine.get_state()


@app.get("/api/data/rules")
def data_rules(_key: str = Depends(require_api_key)):
    """Active rule definitions."""
    return get_rules()


@app.get("/api/data/summary")
def data_summary(
    date: str = Query(None, description="Filter by date (YYYY-MM-DD)"),
    _key: str = Depends(require_api_key),
):
    """Aggregated statistics across all sessions."""
    sessions = engine.sessions
    if date:
        sessions = [s for s in sessions if s.get("date") == date]

    all_bets = []
    for s in sessions:
        all_bets.extend(s.get("bets", []))

    total_stake = sum(b.get("size", 0) for b in all_bets)
    total_liability = sum(b.get("liability", 0) for b in all_bets)

    # Count by rule
    rule_counts = {}
    for b in all_bets:
        rule = b.get("rule_applied", "unknown")
        rule_counts[rule] = rule_counts.get(rule, 0) + 1

    # Count by date
    date_counts = {}
    for s in sessions:
        d = s.get("date", "unknown")
        date_counts[d] = date_counts.get(d, 0) + len(s.get("bets", []))

    # Unique dates
    dates = sorted(set(s.get("date") for s in sessions if s.get("date")))

    return {
        "total_sessions": len(sessions),
        "total_bets": len(all_bets),
        "total_stake": round(total_stake, 2),
        "total_liability": round(total_liability, 2),
        "live_bets": sum(1 for b in all_bets if not b.get("dry_run")),
        "dry_run_bets": sum(1 for b in all_bets if b.get("dry_run")),
        "bets_by_rule": rule_counts,
        "bets_by_date": date_counts,
        "dates_active": dates,
        "engine_status": engine.status,
        "engine_mode": "DRY_RUN" if engine.dry_run else "LIVE",
        "countries": engine.countries,
    }


# ──────────────────────────────────────────────
#  BACKTEST
# ──────────────────────────────────────────────

FSU_URL = os.environ.get("FSU_URL", "https://fsu.thync.online")


def _fsu_auth_header() -> dict:
    """
    Fetch a GCP OIDC identity token for service-to-service Cloud Run auth.
    Returns empty dict when running locally (no metadata server).
    """
    import requests as _r
    meta_url = (
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        f"service-accounts/default/identity?audience={FSU_URL}"
    )
    try:
        resp = _r.get(meta_url, headers={"Metadata-Flavor": "Google"}, timeout=3)
        if resp.status_code == 200:
            return {"Authorization": f"Bearer {resp.text.strip()}"}
    except Exception:
        pass
    return {}


class BacktestRunRequest(BaseModel):
    date: str
    countries: list[str] = ["GB", "IE"]
    process_window_mins: float = 5
    jofs_enabled: bool = True
    spread_control: bool = False
    mark_ceiling_enabled: bool = False
    mark_floor_enabled: bool = False
    mark_uplift_enabled: bool = False
    mark_uplift_stake: float = 3.0
    point_value: float = 1.0
    market_ids: list[str] = []  # empty = run all markets for the date
    # AI Internet Check Agent (backtest-only — no effect on live betting)
    ai_agent_enabled: bool = False
    ai_agent_max_searches: int = 4      # max web searches per runner (1–8)
    ai_agent_overrule_confidence: float = 0.65  # min confidence to overrule strategy
    # AI Odds Movement Agent (backtest-only — no effect on live betting)
    odds_agent_enabled: bool = False
    odds_agent_interval_mins: int = 5   # sample interval in minutes (1, 2, 5, 10)
    odds_agent_lookback_mins: int = 30  # how far back to sample (15, 30, 60, 120)
    odds_agent_overrule_confidence: float = 0.65
    # Kelly Criterion stake sizing (works in both backtest and live)
    kelly_enabled: bool = False
    kelly_fraction: float = 0.25        # 0.25 = quarter Kelly (recommended)
    kelly_bankroll: float = 1000.0      # total bankroll £
    kelly_edge_pct: float = 5.0         # assumed edge % over market-implied probability
    kelly_min_stake: float = 0.50       # stake floor £
    kelly_max_stake: float = 50.0       # stake ceiling £
    # Signal filters (market intelligence layer)
    signal_overround_enabled: bool = False
    signal_field_size_enabled: bool = False
    signal_steam_gate_enabled: bool = False   # samples price 15 mins before target_iso
    signal_band_perf_enabled: bool = False
    market_overlay_enabled: bool = False
    top2_concentration_enabled: bool = False  # TOP2_CONCENTRATION rule family
    sandbox_enabled: bool = False   # apply strategy sandbox rules during this backtest


@app.get("/api/backtest/dates")
def backtest_dates():
    """Return available backtest dates from the FSU service."""
    import requests as _requests
    try:
        r = _requests.get(f"{FSU_URL}/api/dates", headers=_fsu_auth_header(), timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"FSU unavailable: {e}")


@app.get("/api/backtest/markets")
def backtest_markets(
    date: str = Query(..., description="YYYY-MM-DD"),
    countries: str = Query("GB,IE", description="Comma-separated country codes"),
):
    """Return WIN markets for a given date from the FSU (for the market browser)."""
    import requests as _requests
    try:
        r = _requests.get(
            f"{FSU_URL}/api/markets",
            params={"date": date, "market_type": "WIN", "countries": countries},
            headers=_fsu_auth_header(),
            timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"FSU unavailable: {e}")


@app.post("/api/backtest/run")
def backtest_run(req: BacktestRunRequest):
    """
    Start a backtest job and return a job_id immediately.
    The backtest runs in a background thread — poll GET /api/backtest/job/{job_id}
    for status and results.  This avoids Cloud Run's 60s request timeout for
    long AI-agent runs.
    """
    _cleanup_old_jobs()
    job_id = str(uuid.uuid4())
    with _backtest_jobs_lock:
        _backtest_jobs[job_id] = {
            "status": "running",
            "result": None,
            "error": None,
            "started_at": time.time(),
        }

    def _run():
        try:
            result = _backtest_run_inner(req)
            with _backtest_jobs_lock:
                _backtest_jobs[job_id]["status"] = "done"
                _backtest_jobs[job_id]["result"] = result
        except Exception as _exc:
            logger.exception(f"Backtest job {job_id} crashed: {_exc}")
            with _backtest_jobs_lock:
                _backtest_jobs[job_id]["status"] = "error"
                _backtest_jobs[job_id]["error"] = str(_exc)

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "running"}


@app.get("/api/backtest/job/{job_id}")
def backtest_job_status(job_id: str):
    """Poll for backtest job status.  Returns {status, result?, error?}."""
    _cleanup_old_jobs()
    with _backtest_jobs_lock:
        job = _backtest_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found or expired")
    return {
        "job_id": job_id,
        "status": job["status"],
        "result": job["result"],
        "error": job["error"],
    }


# ══════════════════════════════════════════════════════════════════════════════
#  BSP OPTIMISER  —  pre-race back / in-running lay contraction analysis
# ══════════════════════════════════════════════════════════════════════════════

class BspOptimiserRequest(BaseModel):
    date_from: str                              # YYYY-MM-DD
    date_to: str                                # YYYY-MM-DD
    countries: list[str] = ["GB", "IE"]
    contraction_threshold_pct: float = 10.0    # % contraction, e.g. 10 = price drops to 90% of BSP
    max_bsp: float | None = None                # optional upper BSP filter on favourite

    @property
    def threshold(self) -> float:
        return 1.0 - self.contraction_threshold_pct / 100.0


def _run_bsp_job(job_id: str, req: BspOptimiserRequest):
    """Background worker: fetch BSP stats from FSU1, enrich with RP, compute hits."""
    import requests as _req
    from zoneinfo import ZoneInfo as _ZI

    _LONDON = _ZI("Europe/London")

    def _update(data: dict):
        with _bsp_jobs_lock:
            _bsp_jobs[job_id].update(data)

    try:
        # 1. Get available dates from FSU1
        dates_resp = _req.get(
            f"{FSU_URL}/api/dates",
            headers=_fsu_auth_header(),
            timeout=30,
        )
        dates_resp.raise_for_status()
        all_dates = dates_resp.json().get("dates", [])
        dates = sorted(d for d in all_dates if req.date_from <= d <= req.date_to)

        if not dates:
            _update({"status": "error", "error": f"No data available between {req.date_from} and {req.date_to}"})
            return

        countries_param = ",".join(req.countries)
        runner_rows = []

        for i, date in enumerate(dates):
            _update({"progress": {"current": i + 1, "total": len(dates), "date": date}})

            # 2. Fetch BSP stats from FSU1 for this date
            try:
                bsp_resp = _req.get(
                    f"{FSU_URL}/api/bsp-analysis/{date}",
                    params={"countries": countries_param},
                    headers=_fsu_auth_header(),
                    timeout=180,
                )
                if bsp_resp.status_code != 200:
                    logging.warning(f"BSP analysis {date}: FSU returned {bsp_resp.status_code}")
                    continue
                bsp_data = bsp_resp.json()
            except Exception as exc:
                logging.warning(f"BSP analysis {date}: FSU error — {exc}")
                continue

            # 3. Try RP results for enrichment (class, going, pattern, surface)
            rp_map: dict[tuple, dict] = {}   # (venue_lower, off_hhmm) -> race dict
            try:
                rp_resp = _req.get(
                    f"{RP_API_URL}/api/v1/results/{date}",
                    timeout=30,
                )
                if rp_resp.status_code == 200:
                    for race in rp_resp.json().get("results", []):
                        key = (
                            race.get("course", "").lower().strip(),
                            (race.get("off", "") or "")[:5],
                        )
                        rp_map.setdefault(key, race)
            except Exception:
                pass   # RP enrichment is best-effort

            # 4. Process each market
            for market in bsp_data.get("results", []):
                runners = market.get("runners", [])
                active = [r for r in runners if r.get("bsp") and not r.get("non_runner")]
                if not active:
                    continue

                # BSP favourite = lowest BSP
                sorted_by_bsp = sorted(active, key=lambda r: r["bsp"])
                bsp_fav = sorted_by_bsp[0]
                second_bsp = sorted_by_bsp[1]["bsp"] if len(sorted_by_bsp) > 1 else None

                # Optional max BSP filter on the favourite
                if req.max_bsp and bsp_fav["bsp"] > req.max_bsp:
                    continue

                # RP race lookup
                off_time = market.get("off_time_local", "")
                rp_race = rp_map.get((market.get("venue", "").lower().strip(), off_time), {})

                for runner in runners:
                    bsp = runner.get("bsp")
                    if bsp is None:
                        continue
                    is_fav = runner["runner_id"] == bsp_fav["runner_id"]
                    target = round(bsp * req.threshold, 2)
                    ip_min = runner.get("in_play_min_price")
                    hit = ip_min is not None and ip_min <= target

                    runner_rows.append({
                        "market_id": market["market_id"],
                        "race_date": date,
                        "course": market.get("venue", ""),
                        "country": market.get("country", ""),
                        "off_time": off_time,
                        "market_name": market.get("market_name", ""),
                        "distance": market.get("distance", ""),
                        "race_type": market.get("race_type", ""),
                        "number_of_runners": market.get("number_of_runners", 0),
                        "runner_id": runner["runner_id"],
                        "runner_name": runner["runner_name"],
                        "bsp": bsp,
                        "is_bsp_favourite": is_fav,
                        "second_fav_bsp": second_bsp if is_fav else None,
                        "target_price": target,
                        "preoff_ltp": runner.get("preoff_ltp"),
                        "in_play_min_price": ip_min,
                        "in_play_max_price": runner.get("in_play_max_price"),
                        "in_play_volume": runner.get("in_play_volume"),
                        "winner": runner.get("winner", False),
                        "non_runner": runner.get("non_runner", False),
                        "hit": hit,
                        # RP enrichment (best-effort)
                        "race_class": rp_race.get("class") or rp_race.get("race_class"),
                        "going": rp_race.get("going"),
                        "pattern": rp_race.get("pattern"),
                        "handicap": rp_race.get("handicap"),
                        "surface": rp_race.get("surface"),
                    })

        # 5. Compute summary stats (favourites only)
        fav_rows = [r for r in runner_rows if r["is_bsp_favourite"] and not r["non_runner"]]
        markets_analysed = len(set(r["market_id"] for r in fav_rows))
        qualified_count = sum(1 for r in fav_rows if r["hit"])
        win_rate_pct = round(qualified_count / len(fav_rows) * 100, 1) if fav_rows else 0
        avg_bsp = round(sum(r["bsp"] for r in fav_rows) / len(fav_rows), 2) if fav_rows else None
        contractions = [
            round((1 - r["in_play_min_price"] / r["bsp"]) * 100, 1)
            for r in fav_rows
            if r["bsp"] and r["in_play_min_price"]
        ]
        avg_contraction_pct = round(sum(contractions) / len(contractions), 1) if contractions else None

        # BSP band breakdown
        band_defs = [
            ("Under 2.0",  lambda b: b < 2.0),
            ("2.0 – 3.0",  lambda b: 2.0 <= b < 3.0),
            ("3.0 – 5.0",  lambda b: 3.0 <= b < 5.0),
            ("5.0+",       lambda b: b >= 5.0),
        ]
        bsp_bands = []
        for label, fn in band_defs:
            band = [r for r in fav_rows if fn(r["bsp"])]
            if band:
                b_hits = sum(1 for r in band if r["hit"])
                b_ctrs = [
                    round((1 - r["in_play_min_price"] / r["bsp"]) * 100, 1)
                    for r in band if r["bsp"] and r["in_play_min_price"]
                ]
                b_ip_mins = [r["in_play_min_price"] for r in band if r["in_play_min_price"]]
                bsp_bands.append({
                    "band": label,
                    "count": len(band),
                    "qualified": b_hits,
                    "win_rate_pct": round(b_hits / len(band) * 100, 1),
                    "avg_contraction_pct": round(sum(b_ctrs) / len(b_ctrs), 1) if b_ctrs else None,
                    "avg_inplay_min": round(sum(b_ip_mins) / len(b_ip_mins), 2) if b_ip_mins else None,
                })

        # Normalise runner rows for frontend
        runners_out = [
            {
                "date": r["race_date"],
                "market_id": r["market_id"],
                "venue": r["course"],
                "race_time": r["off_time"],
                "distance": r.get("distance", ""),
                "race_type": r.get("race_type", ""),
                "runner_name": r["runner_name"],
                "bsp": r["bsp"],
                "pre_off_ltp": r.get("preoff_ltp"),
                "contraction_pct": (
                    round((1 - r["in_play_min_price"] / r["bsp"]) * 100, 1)
                    if r["bsp"] and r.get("in_play_min_price") else None
                ),
                "inplay_min": r.get("in_play_min_price"),
                "inplay_max": r.get("in_play_max_price"),
                "won": r.get("winner"),
                "hit": r.get("hit"),
            }
            for r in runner_rows if r["is_bsp_favourite"] and not r["non_runner"]
        ]

        _update({
            "status": "done",
            "result": {
                "summary": {
                    "days_analysed": len(dates),
                    "markets_analysed": markets_analysed,
                    "favourites_tracked": len(fav_rows),
                    "qualified_count": qualified_count,
                    "win_rate_pct": win_rate_pct,
                    "avg_contraction_pct": avg_contraction_pct,
                    "avg_bsp": avg_bsp,
                    "threshold_pct": req.contraction_threshold_pct,
                    "countries": req.countries,
                },
                "bsp_bands": bsp_bands,
                "runners": runners_out,
            },
        })

    except Exception as exc:
        logging.error(f"BSP job {job_id} failed: {exc}")
        _update({"status": "error", "error": str(exc)})


@app.post("/api/bsp-optimiser/run", dependencies=[Depends(require_api_key)])
def bsp_optimiser_run(req: BspOptimiserRequest):
    """Start a BSP contraction analysis job. Returns job_id to poll."""
    _cleanup_old_jobs()
    job_id = str(uuid.uuid4())
    with _bsp_jobs_lock:
        _bsp_jobs[job_id] = {
            "status": "running",
            "result": None,
            "error": None,
            "progress": {"current": 0, "total": 0, "date": ""},
            "started_at": time.time(),
        }
    t = threading.Thread(target=_run_bsp_job, args=(job_id, req), daemon=True)
    t.start()
    return {"job_id": job_id, "status": "running"}


@app.get("/api/bsp-optimiser/job/{job_id}", dependencies=[Depends(require_api_key)])
def bsp_optimiser_job_status(job_id: str):
    """Poll BSP optimiser job status. Returns {status, progress, result?, error?}."""
    with _bsp_jobs_lock:
        job = _bsp_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found or expired")
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job.get("progress", {}),
        "result": job["result"],
        "error": job["error"],
    }


@app.get("/api/bsp-optimiser/settings", dependencies=[Depends(require_api_key)])
def bsp_settings_get():
    """Get BSP Optimiser live settings plus active candidates."""
    cfg = engine.settings.get("bsp_optimiser", {
        "enabled": False,
        "dry_run": True,
        "contraction_threshold_pct": 10,
        "stake_pts": 2,
        "max_bsp": None,
    })
    candidates = [
        {
            "runner_name": c.get("runner_name"),
            "venue": c.get("venue"),
            "race_time": c.get("race_time"),
            "bsp_proxy": c.get("bsp_proxy"),
            "target": c.get("target"),
            "status": "placed" if c.get("bet_placed") else "monitoring",
        }
        for c in engine._bsp_candidates.values()
    ]
    return {**cfg, "active_candidates": candidates}


@app.post("/api/bsp-optimiser/settings", dependencies=[Depends(require_api_key)])
def bsp_settings_set(body: dict):
    """Update BSP Optimiser live settings."""
    current = engine.settings.get("bsp_optimiser", {})
    current.update(body)
    engine.settings["bsp_optimiser"] = current
    engine._save_settings()
    return current


def _backtest_run_inner(req):
    from datetime import datetime, timezone as _tz

    # ── AI Internet Check Agent setup (backtest-only, lazy init) ───────────
    _ai_agent = None
    if req.ai_agent_enabled:
        try:
            from ai_backtest_agent import BacktestAIAgent, AgentConfig as _AgentConfig
            _agent_config = _AgentConfig(
                max_searches_per_runner=max(1, min(8, req.ai_agent_max_searches)),
                overrule_min_confidence=max(0.5, min(0.95, req.ai_agent_overrule_confidence)),
            )
            _ai_agent = BacktestAIAgent(get_anthropic(), backtest_date=req.date)
        except Exception as _ae:
            logger.warning(f"AI internet agent init failed: {_ae}")

    # ── AI Odds Movement Agent setup (backtest-only, lazy init) ─────────────
    _odds_agent = None
    if req.odds_agent_enabled:
        try:
            from ai_odds_agent import OddsMovementAgent, OddsAgentConfig as _OddsAgentConfig
            _odds_agent_config = _OddsAgentConfig(
                sample_interval_mins=max(1, min(10, req.odds_agent_interval_mins)),
                lookback_mins=max(10, min(120, req.odds_agent_lookback_mins)),
                overrule_min_confidence=max(0.5, min(0.95, req.odds_agent_overrule_confidence)),
            )
            _odds_agent = OddsMovementAgent(get_anthropic())
        except Exception as _oe:
            logger.warning(f"AI odds agent init failed: {_oe}")

    # ── Signal filter setup ──────────────────────────────────────────────────
    from signal_filters import SignalConfig as _SigConfig, apply_signal_filters as _apply_sigs
    _sig_config = _SigConfig(
        overround_enabled=req.signal_overround_enabled,
        field_size_enabled=req.signal_field_size_enabled,
        steam_gate_enabled=req.signal_steam_gate_enabled,
        band_perf_enabled=req.signal_band_perf_enabled,
    )
    # Band performance stats — drawn from live session history (same source as live engine)
    _any_signal = any([
        req.signal_overround_enabled,
        req.signal_field_size_enabled,
        req.signal_steam_gate_enabled,
        req.signal_band_perf_enabled,
    ])
    _band_stats = engine._compute_band_stats(_sig_config.band_perf_lookback_days) if _any_signal else {}

    client = FSUClient(base_url=FSU_URL, date=req.date, timeout=15)
    client.login()  # fetches GCP identity token on Cloud Run
    markets = client.get_todays_win_markets(countries=req.countries)
    if req.market_ids:
        markets = [m for m in markets if m["market_id"] in req.market_ids]

    if not markets:
        return {
            "date": req.date,
            "countries": req.countries,
            "process_window_mins": req.process_window_mins,
            "markets_evaluated": 0,
            "bets_placed": 0,
            "markets_skipped": 0,
            "total_stake": 0.0,
            "total_liability": 0.0,
            "total_pnl": 0.0,
            "roi": 0.0,
            "results": [],
        }

    results = []
    for m in markets:
        market_id = m["market_id"]
        race_time_str = m["race_time"]

        # Target evaluation time: race_time minus process window
        try:
            race_dt = datetime.fromisoformat(race_time_str.replace("Z", "+00:00"))
            target_ts = race_dt.timestamp() - (req.process_window_mins * 60)
            target_iso = datetime.fromtimestamp(target_ts, tz=_tz.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
        except Exception:
            target_iso = race_time_str

        client.set_virtual_time(target_iso)
        runners, valid = client.get_market_prices(market_id)
        _previous_prices: dict = {}   # populated later if Steam Gate fires

        if not valid:
            results.append({
                "market_id": market_id,
                "market_name": m["market_name"],
                "venue": m["venue"],
                "race_time": race_time_str,
                "evaluated_at": target_iso,
                "skipped": True,
                "skip_reason": "Market not valid at evaluation time (closed / suspended / in-play)",
                "rule_applied": "",
                "favourite": None,
                "second_favourite": None,
                "instructions": [],
                "settled": False,
                "winner_selection_id": None,
                "pnl": 0.0,
                "total_stake": 0.0,
                "total_liability": 0.0,
            })
            continue

        # Spread control — reject if favourite's spread is too wide
        if req.spread_control and runners:
            from rules import identify_favourites, check_spread
            fav, _ = identify_favourites(runners)
            if fav:
                sc = check_spread(fav)
                if not sc.passed:
                    results.append({
                        "market_id": market_id,
                        "market_name": m["market_name"],
                        "venue": m["venue"],
                        "race_time": race_time_str,
                        "evaluated_at": target_iso,
                        "skipped": True,
                        "skip_reason": f"Spread rejected: {sc.reason}",
                        "rule_applied": "",
                        "favourite": {"name": fav.runner_name, "odds": fav.best_available_to_lay, "selection_id": fav.selection_id},
                        "second_favourite": None,
                        "instructions": [],
                        "settled": False,
                        "winner_selection_id": None,
                        "pnl": 0.0,
                        "total_stake": 0.0,
                        "total_liability": 0.0,
                    })
                    continue

        rule_result = apply_betting_rules(
            market_id=market_id,
            market_name=m["market_name"],
            venue=m["venue"],
            race_time=race_time_str,
            runners=runners,
            jofs_enabled=req.jofs_enabled,
            mark_ceiling_enabled=req.mark_ceiling_enabled,
            mark_floor_enabled=req.mark_floor_enabled,
            mark_uplift_enabled=req.mark_uplift_enabled,
            mark_uplift_stake=req.mark_uplift_stake,
        )

        # Apply point value multiplier
        if req.point_value != 1.0:
            for instr in rule_result.instructions:
                instr.size = round(instr.size * req.point_value, 2)

        # Apply Kelly Criterion sizing (replaces point-valued stake when enabled)
        if req.kelly_enabled:
            from kelly import KellyConfig as _KC, calculate_kelly_stake as _cks
            _kelly_cfg = _KC(
                enabled=True,
                fraction=req.kelly_fraction,
                bankroll=req.kelly_bankroll,
                edge_pct=req.kelly_edge_pct,
                min_stake=req.kelly_min_stake,
                max_stake=req.kelly_max_stake,
            )
            for instr in rule_result.instructions:
                instr.size = _cks(
                    lay_odds=instr.price,
                    config=_kelly_cfg,
                    base_stake=instr.size,
                )

        # ── Steam Gate: only fetch early prices when rules produced a bet ──
        # Moved here from pre-rules to avoid wasting FSU calls on skipped markets.
        if req.signal_steam_gate_enabled and not rule_result.skipped and rule_result.instructions:
            try:
                _steam_lookback_secs = 15 * 60
                _early_ts = datetime.fromtimestamp(
                    datetime.fromisoformat(target_iso.replace("Z", "+00:00")).timestamp()
                    - _steam_lookback_secs,
                    tz=_tz.utc,
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                client.set_virtual_time(_early_ts)
                _early_runners, _early_valid = client.get_market_prices(market_id)
                if _early_valid and _early_runners:
                    _previous_prices = {
                        r.selection_id: r.best_available_to_lay
                        for r in _early_runners
                        if r.best_available_to_lay is not None
                    }
            except Exception as _se:
                logger.warning(f"Steam Gate price sampling failed for {market_id}: {_se}")
            finally:
                client.set_virtual_time(target_iso)

        # ── Signal filters (market intelligence layer) ─────────────────────
        if _any_signal and not rule_result.skipped and rule_result.instructions:
            _sig_kept = []
            for _instr in rule_result.instructions:
                _sig_result = _apply_sigs(
                    selection_id=_instr.selection_id,
                    current_price=_instr.price,
                    original_stake=_instr.size,
                    all_runners=runners,
                    previous_prices=_previous_prices,
                    band_stats=_band_stats,
                    config=_sig_config,
                )
                if _sig_result.allowed:
                    _instr.size = _sig_result.final_stake
                    _sig_kept.append(_instr)
                else:
                    logger.info(
                        f"[SIGNAL FILTER] BT BLOCKED: {_instr.runner_name} "
                        f"@ {m['venue']} — {_sig_result.skip_reason}"
                    )
            rule_result.instructions = _sig_kept

        # ── TOP2_CONCENTRATION Rule Family ───────────────────────────────────
        # Runs before MOM per spec priority order (section 11).
        # BLOCK clears all instructions; SUPPRESS scales stakes down.
        # WATCH fires logging only — no stake change.
        _top2_result = None
        if req.top2_concentration_enabled and not rule_result.skipped and rule_result.instructions:
            from top2_concentration import apply_top2_concentration as _apply_top2
            _top2 = _apply_top2(runners, enabled=True)
            _top2_result = _top2
            if _top2.state == "BLOCK":
                rule_result.instructions = []
                rule_result.skipped = True
                rule_result.skip_reason = f"[TOP2] {_top2.reason}"
                logger.info(f"[TOP2] BT BLOCK: {m['venue']} — {_top2.reason}")
            elif _top2.state in ("SUPPRESS_MEDIUM", "SUPPRESS_STRONG"):
                for _instr in rule_result.instructions:
                    _pre = _instr.size
                    _instr.size = round(_instr.size * _top2.lay_multiplier, 2)
                    if _pre >= 2.0:
                        _instr.size = max(_instr.size, 2.0)
                logger.info(
                    f"[TOP2] BT {_top2.state}: {m['venue']} "
                    f"top2={_top2.top2_combined:.4f} "
                    f"3v2={_top2.third_vs_second_ratio:.4f} "
                    f"×{_top2.lay_multiplier}"
                )
            elif _top2.state == "WATCH":
                logger.info(
                    f"[TOP2] BT WATCH: {m['venue']} "
                    f"top2={_top2.top2_combined:.4f} "
                    f"3v2={_top2.third_vs_second_ratio:.4f} — no change"
                )

        # ── Market Overlay Modifier ─────────────────────────────────────────
        if req.market_overlay_enabled and not rule_result.skipped and rule_result.instructions:
            from market_overlay import apply_market_overlay as _apply_mom
            _mom = _apply_mom(runners, enabled=True)
            if _mom.overlay_multiplier != 1.0:
                for _instr in rule_result.instructions:
                    _pre = _instr.size
                    _instr.size = round(_instr.size * _mom.overlay_multiplier, 2)
                    if _pre >= 2.0:
                        _instr.size = max(_instr.size, 2.0)
                logger.info(
                    f"[MARKET OVERLAY] BT {_mom.market_overlay_state}: "
                    f"{m['venue']} overround={_mom.exchange_overround:.4f} "
                    f"×{_mom.overlay_multiplier}"
                    + (" [CONCENTRATION]" if _mom.market_concentration_flag else "")
                )

        # ── Strategy Rule Sandbox ────────────────────────────────────────────
        # Runs after MOM, before AI agents.  Only active when sandbox_enabled=True
        # and at least one rule is defined.  Applies STAKE_MODIFIER, BET_FILTER,
        # and SIGNAL_AMPLIFIER rules defined by Claude for strategy testing.
        if req.sandbox_enabled and _sandbox.size() > 0 and not rule_result.skipped and rule_result.instructions:
            _sb_eval = _sandbox.evaluate(runners)
            if _sb_eval.triggered_rules:
                if _sb_eval.skip:
                    rule_result.instructions = []
                    rule_result.skipped = True
                    rule_result.skip_reason = f"[SANDBOX] {_sb_eval.reason}"
                    logger.info(
                        f"[SANDBOX] BT VETOED: {m['venue']} — {_sb_eval.reason}"
                    )
                else:
                    if _sb_eval.stake_multiplier != 1.0:
                        for _instr in rule_result.instructions:
                            _pre = _instr.size
                            _instr.size = round(_instr.size * _sb_eval.stake_multiplier, 2)
                            if _pre >= 2.0:
                                _instr.size = max(_instr.size, 2.0)
                    logger.info(
                        f"[SANDBOX] BT {m['venue']}: {_sb_eval.reason} "
                        f"stake×{_sb_eval.stake_multiplier} signal×{_sb_eval.signal_multiplier}"
                    )

        # ── AI Research Agent overlay (backtest-only) ──────────────────────
        # Runs AFTER the strategy has decided to bet, BEFORE settlement lookup.
        # Agent may CONFIRM, OVERRULE, or ADJUST each instruction's stake.
        _agent_decisions_map: dict = {}
        if _ai_agent and not rule_result.skipped and rule_result.instructions:
            try:
                decisions = _ai_agent.process_rule_results([rule_result], _agent_config)
                market_decisions = decisions.get(market_id, [])
                # Build a map keyed by selection_id for fast lookup
                for dec in market_decisions:
                    _agent_decisions_map[dec.selection_id] = dec
                # Apply decisions to instructions
                kept = []
                for instr in rule_result.instructions:
                    dec = _agent_decisions_map.get(instr.selection_id)
                    if dec is None:
                        kept.append(instr)
                        continue
                    if dec.agent_action == "OVERRULE":
                        # Drop this instruction — agent disagrees with strategy
                        continue
                    if dec.agent_action == "ADJUST":
                        instr.size = dec.final_stake
                    kept.append(instr)
                rule_result.instructions = kept
            except Exception as _ae:
                logger.warning(f"AI agent processing error for {market_id}: {_ae}")

        # ── AI Odds Movement Agent overlay (backtest-only) ─────────────────
        # Samples historical prices at intervals, analyses drift/steam,
        # then may CONFIRM, OVERRULE, or ADJUST each instruction's stake.
        # The FSU virtual time is restored to target_iso after sampling.
        _odds_decisions_map: dict = {}
        if _odds_agent and not rule_result.skipped and rule_result.instructions:
            try:
                odds_decisions = _odds_agent.process_market(
                    fsu_client=client,
                    market_id=market_id,
                    race_time_iso=race_time_str,
                    evaluation_time_iso=target_iso,
                    rule_result=rule_result,
                    config=_odds_agent_config,
                )
                # Restore virtual time after sampling (critical — main loop must continue)
                client.set_virtual_time(target_iso)
                # Build map and apply decisions
                for odec in odds_decisions:
                    _odds_decisions_map[odec.selection_id] = odec
                kept = []
                for instr in rule_result.instructions:
                    odec = _odds_decisions_map.get(instr.selection_id)
                    if odec is None:
                        kept.append(instr)
                        continue
                    if odec.agent_action == "OVERRULE":
                        continue
                    if odec.agent_action == "ADJUST":
                        instr.size = odec.final_stake
                    kept.append(instr)
                rule_result.instructions = kept
            except Exception as _oe:
                logger.warning(f"Odds agent processing error for {market_id}: {_oe}")
                # Always restore virtual time even on error
                try:
                    client.set_virtual_time(target_iso)
                except Exception:
                    pass

        if rule_result.skipped:
            rd = rule_result.to_dict()
            rd["evaluated_at"] = target_iso
            rd["settled"] = False
            rd["winner_selection_id"] = None
            rd["pnl"] = 0.0
            if _top2_result:
                rd["top2_concentration"] = _top2_result.to_dict()
            results.append(rd)
            continue

        # Determine race outcome
        race_result = client.get_race_result(market_id)
        winner_id = race_result.get("winner_selection_id") if race_result else None
        settled = race_result.get("settled", False) if race_result else False

        # Calculate P&L per instruction
        total_pnl = 0.0
        instructions_with_outcome = []
        for instr in rule_result.instructions:
            if not settled or winner_id is None:
                outcome = "UNSETTLED"
                instr_pnl = 0.0
            elif instr.selection_id == winner_id:
                outcome = "LOST"
                instr_pnl = -round(instr.size * (instr.price - 1), 2)
            else:
                outcome = "WON"
                instr_pnl = round(instr.size, 2)

            total_pnl += instr_pnl
            d = instr.to_dict()
            d["outcome"] = outcome
            d["pnl"] = instr_pnl
            # Attach internet agent decision metadata if available
            dec = _agent_decisions_map.get(instr.selection_id)
            if dec:
                d["agent_decision"] = {
                    "action": dec.agent_action,
                    "confidence": dec.confidence,
                    "stake_multiplier": dec.stake_multiplier,
                    "reasoning": dec.reasoning,
                    "research_summary": dec.research_summary,
                    "searches_performed": dec.searches_performed,
                    "overruled": dec.overruled,
                }
            # Attach odds movement agent decision metadata if available
            odec = _odds_decisions_map.get(instr.selection_id)
            if odec:
                d["odds_decision"] = {
                    "action": odec.agent_action,
                    "confidence": odec.confidence,
                    "stake_multiplier": odec.stake_multiplier,
                    "reasoning": odec.reasoning,
                    "odds_summary": odec.odds_summary,
                    "trend": odec.trend,
                    "price_open": odec.price_open,
                    "price_close": odec.price_close,
                    "price_delta": odec.price_delta,
                    "samples_taken": odec.samples_taken,
                    "overruled": odec.overruled,
                }
            instructions_with_outcome.append(d)

        rd = rule_result.to_dict()
        rd["instructions"] = instructions_with_outcome
        rd["evaluated_at"] = target_iso
        rd["winner_selection_id"] = winner_id
        rd["settled"] = settled
        rd["pnl"] = round(total_pnl, 2)
        if _top2_result:
            rd["top2_concentration"] = _top2_result.to_dict()
        # Count internet agent overrules for this market
        if _agent_decisions_map:
            rd["agent_overrules"] = sum(
                1 for dec in _agent_decisions_map.values() if dec.agent_action == "OVERRULE"
            )
        # Count odds agent overrules for this market
        if _odds_decisions_map:
            rd["odds_agent_overrules"] = sum(
                1 for odec in _odds_decisions_map.values() if odec.agent_action == "OVERRULE"
            )
        results.append(rd)

    # Aggregate summary stats
    active_results = [r for r in results if not r.get("skipped")]
    total_stake = round(
        sum(sum(i.get("size", 0) for i in r.get("instructions", [])) for r in active_results), 2
    )
    total_liability = round(
        sum(sum(i.get("liability", 0) for i in r.get("instructions", [])) for r in active_results), 2
    )
    total_pnl = round(sum(r.get("pnl", 0) for r in results), 2)
    bets_placed = sum(len(r.get("instructions", [])) for r in active_results)

    response_body = {
        "date": req.date,
        "countries": req.countries,
        "process_window_mins": req.process_window_mins,
        "markets_evaluated": len(markets),
        "bets_placed": bets_placed,
        "markets_skipped": sum(1 for r in results if r.get("skipped")),
        "total_stake": total_stake,
        "total_liability": total_liability,
        "total_pnl": total_pnl,
        "roi": round((total_pnl / total_stake * 100) if total_stake > 0 else 0.0, 1),
        "results": results,
    }

    all_instrs = [i for r in results for i in r.get("instructions", [])]

    if req.ai_agent_enabled:
        response_body["ai_agent_enabled"] = True
        response_body["ai_agent_overrules"] = sum(
            r.get("agent_overrules", 0) for r in results
        )
        response_body["ai_agent_adjustments"] = sum(
            1 for i in all_instrs
            if i.get("agent_decision", {}).get("action") == "ADJUST"
        )

    if req.odds_agent_enabled:
        response_body["odds_agent_enabled"] = True
        response_body["odds_agent_overrules"] = sum(
            r.get("odds_agent_overrules", 0) for r in results
        )
        response_body["odds_agent_adjustments"] = sum(
            1 for i in all_instrs
            if i.get("odds_decision", {}).get("action") == "ADJUST"
        )

    if req.top2_concentration_enabled:
        response_body["top2_concentration_enabled"] = True
        response_body["top2_blocks"] = sum(
            1 for r in results
            if r.get("top2_concentration", {}).get("state") == "BLOCK"
        )
        response_body["top2_suppressions"] = sum(
            1 for r in results
            if r.get("top2_concentration", {}).get("state") in ("SUPPRESS_MEDIUM", "SUPPRESS_STRONG")
        )

    return response_body


# ── Google Drive / Sheets helpers ──

GOOGLE_DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "")
GOOGLE_DRIVE_BACKTEST_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_BACKTEST_FOLDER_ID", "")


def _google_access_token():
    """Get an OAuth2 access token from the default service account (Cloud Run)."""
    try:
        from google.auth import default as _gauth_default
        from google.auth.transport.requests import Request as _GRequest
        creds, _ = _gauth_default(scopes=[
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ])
        creds.refresh(_GRequest())
        return creds.token
    except Exception as e:
        logging.error(f"Google auth failed: {e}")
        return None


class BacktestExportRequest(BaseModel):
    entries: list[dict]


@app.post("/api/backtest/export-sheets")
def backtest_export_sheets(req: BacktestExportRequest):
    """Export selected backtest history entries to a single Google Sheet."""
    import requests as _requests
    import traceback

    try:
        return _do_export_sheets(req, _requests)
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"export-sheets unhandled error: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=502, detail=f"Export failed: {e}")


def _do_export_sheets(req: BacktestExportRequest, _requests):
    token = _google_access_token()
    if not token:
        raise HTTPException(status_code=500, detail="Google auth not available — check service account scopes")

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    logging.info(f"Backtest export: token obtained, creating spreadsheet for {len(req.entries)} entries")

    # 1. Create a new spreadsheet
    title = f"CHIMERA Backtest Export — {req.entries[0]['date'] if req.entries else 'Unknown'}"
    if len(req.entries) > 1:
        title = f"CHIMERA Backtest Export — {len(req.entries)} runs"

    create_resp = _requests.post(
        "https://sheets.googleapis.com/v4/spreadsheets",
        json={"properties": {"title": title}},
        headers=headers,
        timeout=15,
    )
    if create_resp.status_code != 200:
        logging.error(f"Sheets API create failed: {create_resp.status_code} {create_resp.text[:500]}")
        raise HTTPException(status_code=502, detail=f"Sheets API error: {create_resp.text[:300]}")

    sheet_data = create_resp.json()
    spreadsheet_id = sheet_data["spreadsheetId"]
    spreadsheet_url = sheet_data["spreadsheetUrl"]

    # 2. Build rows — one sheet per backtest run
    batch_requests = []
    value_updates = []

    for idx, entry in enumerate(req.entries):
        sheet_title = f"{entry.get('date', 'Run')}_{idx + 1}"

        # Add sheet (skip first — Sheet1 already exists)
        if idx == 0:
            # Rename Sheet1
            batch_requests.append({
                "updateSheetProperties": {
                    "properties": {"sheetId": 0, "title": sheet_title},
                    "fields": "title",
                }
            })
        else:
            batch_requests.append({
                "addSheet": {"properties": {"title": sheet_title}}
            })

        # Build header + data rows
        summary = entry.get("summary", {})
        config = entry.get("config", {})
        rows = [
            ["CHIMERA Backtest", entry.get("date", ""), f"Run: {entry.get('run_at', '')}"],
            [f"Countries: {','.join(config.get('countries', []))}", f"Window: {config.get('process_window_mins', '')}min",
             f"JOFS: {'ON' if config.get('jofs_enabled') else 'OFF'}"],
            [f"Markets: {summary.get('markets_evaluated', '')}", f"Bets: {summary.get('bets_placed', '')}",
             f"P&L: £{summary.get('total_pnl', 0):.2f}", f"ROI: {summary.get('roi', 0)}%"],
            [],
            ["Time", "Venue", "Favourite", "Odds", "Rule", "Stake", "Liability", "Result", "P&L"],
        ]

        for r in entry.get("results", []):
            instructions = r.get("instructions", [])
            total_stake = sum(i.get("size", 0) for i in instructions)
            total_liab = sum(i.get("liability", 0) for i in instructions)
            outcomes = list(set(i.get("outcome", "") for i in instructions if i.get("outcome")))
            fav = r.get("favourite", {})
            rows.append([
                (r.get("race_time") or "")[:16],
                r.get("venue", ""),
                fav.get("name", "") if fav else "",
                fav.get("odds", "") if fav else "",
                r.get("skip_reason", "") if r.get("skipped") else r.get("rule_applied", ""),
                "" if r.get("skipped") else f"£{total_stake:.2f}",
                "" if r.get("skipped") else f"£{total_liab:.2f}",
                "SKIPPED" if r.get("skipped") else "/".join(outcomes) or "—",
                "" if r.get("skipped") else f"£{r.get('pnl', 0):.2f}",
            ])

        value_updates.append({
            "range": f"'{sheet_title}'!A1",
            "majorDimension": "ROWS",
            "values": rows,
        })

    # 3. Execute batch sheet creation/rename
    if batch_requests:
        _requests.post(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate",
            json={"requests": batch_requests},
            headers=headers,
            timeout=15,
        )

    # 4. Write all data
    _requests.post(
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values:batchUpdate",
        json={"valueInputOption": "RAW", "data": value_updates},
        headers=headers,
        timeout=15,
    )

    # 5. Move to shared Drive folder if configured
    bt_folder = GOOGLE_DRIVE_BACKTEST_FOLDER_ID or GOOGLE_DRIVE_FOLDER_ID
    if bt_folder:
        move_resp = _requests.patch(
            f"https://www.googleapis.com/drive/v3/files/{spreadsheet_id}"
            f"?addParents={bt_folder}&supportsAllDrives=true",
            headers=headers,
            timeout=10,
        )
        if move_resp.status_code != 200:
            logging.warning(f"Drive move failed: {move_resp.status_code} {move_resp.text[:300]}")

    return {"url": spreadsheet_url, "spreadsheet_id": spreadsheet_id}


# ══════════════════════════════════════════════════════════════════════════════
#  STRATEGY — RULE SANDBOX
#  Endpoint namespace: /api/strategy/sandbox/...
#  Designed as a future FSU extract — only the base URL changes on migration.
# ══════════════════════════════════════════════════════════════════════════════

class SandboxRuleRequest(BaseModel):
    name: str
    description: str = ""
    rule_type: str                   # STAKE_MODIFIER | BET_FILTER | SIGNAL_AMPLIFIER
    conditions: list[dict]           # [{field, operator, value}, ...]
    effect: dict                     # {stake_multiplier?, skip?, signal_multiplier?, reason?}


@app.get("/api/strategy/sandbox/rules")
def sandbox_list_rules():
    """List all active sandbox rules."""
    return {"rules": _sandbox.list_rules(), "count": _sandbox.size()}


@app.post("/api/strategy/sandbox/rules")
def sandbox_create_rule(req: SandboxRuleRequest):
    """Create a new sandbox rule. Returns the created rule on success."""
    rule, error = _sandbox.add_rule(
        name=req.name,
        description=req.description,
        rule_type=req.rule_type,
        conditions=req.conditions,
        effect=req.effect,
    )
    if error:
        raise HTTPException(status_code=422, detail=error)
    persist_sandbox(_sandbox)
    return {"rule": rule.to_dict()}


@app.delete("/api/strategy/sandbox/rules/{rule_id}")
def sandbox_delete_rule(rule_id: str):
    """Delete a sandbox rule by ID."""
    removed = _sandbox.remove_rule(rule_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")
    persist_sandbox(_sandbox)
    return {"deleted": rule_id}


@app.delete("/api/strategy/sandbox/rules")
def sandbox_clear_rules():
    """Clear all sandbox rules."""
    count = _sandbox.clear()
    persist_sandbox(_sandbox)
    return {"cleared": count}


@app.get("/api/strategy/sandbox/status")
def sandbox_status():
    """Return sandbox status — rule count, tray count, and summary."""
    return {
        "active_rules": _sandbox.size(),
        "rules": _sandbox.list_rules(),
        "active_trays": _sandbox.tray_count(),
        "trays": _sandbox.list_trays(),
    }


# ── Sandbox Trays ─────────────────────────────────────────────────────────────

@app.get("/api/strategy/sandbox/trays")
def sandbox_list_trays():
    """List all sandbox trays."""
    return {"trays": _sandbox.list_trays(), "count": _sandbox.tray_count()}


@app.post("/api/strategy/sandbox/trays")
def sandbox_create_tray(req: dict):
    """Create a new sandbox tray. Returns the created tray on success."""
    tray, error = _sandbox.create_tray(req)
    if error:
        raise HTTPException(status_code=422, detail=error)
    persist_sandbox(_sandbox)
    return {"tray": tray.to_dict()}


@app.get("/api/strategy/sandbox/trays/{tray_id}")
def sandbox_get_tray(tray_id: str):
    """Get a single sandbox tray by ID."""
    tray = _sandbox.get_tray(tray_id)
    if not tray:
        raise HTTPException(status_code=404, detail=f"Tray '{tray_id}' not found")
    return {"tray": tray.to_dict()}


@app.put("/api/strategy/sandbox/trays/{tray_id}")
def sandbox_update_tray(tray_id: str, req: dict):
    """Update a sandbox tray (results, status, analysis, spec fields)."""
    tray, error = _sandbox.update_tray(tray_id, req)
    if error:
        raise HTTPException(status_code=422, detail=error)
    persist_sandbox(_sandbox)
    return {"tray": tray.to_dict()}


@app.delete("/api/strategy/sandbox/trays/{tray_id}")
def sandbox_delete_tray(tray_id: str):
    """Delete a sandbox tray by ID."""
    removed = _sandbox.delete_tray(tray_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Tray '{tray_id}' not found")
    persist_sandbox(_sandbox)
    return {"deleted": tray_id}


@app.post("/api/strategy/sandbox/trays/{tray_id}/promote")
def sandbox_promote_tray(tray_id: str):
    """Mark a tray as PROMOTED — rule approved for deployment."""
    tray, error = _sandbox.update_tray(tray_id, {"status": "PROMOTED"})
    if error:
        raise HTTPException(status_code=422, detail=error)
    persist_sandbox(_sandbox)
    return {"tray": tray.to_dict()}


@app.post("/api/strategy/sandbox/trays/{tray_id}/discard")
def sandbox_discard_tray(tray_id: str):
    """Mark a tray as DISCARDED — rule rejected."""
    tray, error = _sandbox.update_tray(tray_id, {"status": "DISCARDED"})
    if error:
        raise HTTPException(status_code=422, detail=error)
    persist_sandbox(_sandbox)
    return {"tray": tray.to_dict()}


@app.post("/api/reports/{report_id}/save-drive")
def save_report_to_drive(report_id: str):
    """Save a report as a Google Doc in the configured Drive folder."""
    import requests as _requests

    report = None
    for r in engine.reports:
        if r["report_id"] == report_id:
            report = r
            break
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    token = _google_access_token()
    if not token:
        raise HTTPException(status_code=500, detail="Google auth not available")

    reports_folder = GOOGLE_DRIVE_FOLDER_ID
    if not reports_folder:
        raise HTTPException(status_code=500, detail="GOOGLE_DRIVE_FOLDER_ID not configured")

    headers = {"Authorization": f"Bearer {token}"}

    title = report.get("title", f"CHIMERA Report {report_id}")
    content = report.get("content", "")
    if isinstance(content, dict):
        content = json.dumps(content, indent=2)

    # Create HTML file in Drive (Shared Drive compatible)
    html_body = f"""<html><head><meta charset="utf-8"><title>{title}</title></head>
<body style="font-family: Inter, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px;">
<h1>{title}</h1>
{content}
<hr><p style="color: #999; font-size: 11px;">Generated by CHIMERA Lay Engine</p>
</body></html>"""

    metadata = {
        "name": title,
        "mimeType": "application/vnd.google-apps.document",
        "parents": [reports_folder],
    }

    boundary = "chimera_boundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: text/html; charset=UTF-8\r\n\r\n"
        f"{html_body}\r\n"
        f"--{boundary}--"
    )

    resp = _requests.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
        data=body.encode("utf-8"),
        headers={
            **headers,
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        timeout=15,
    )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Drive API error: {resp.text}")

    file_data = resp.json()
    file_url = f"https://docs.google.com/document/d/{file_data['id']}/edit"
    return {"url": file_url, "file_id": file_data["id"]}
