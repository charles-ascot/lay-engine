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

from engine import LayEngine
from fsu_client import FSUClient
from rules import apply_rules as apply_betting_rules

# ── Anthropic client (lazy — only created when analysis is requested) ──
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
_anthropic_client = None

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

app = FastAPI(title="CHIMERA Lay Engine", version="1.1.0")

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
    minutes: int

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
        "version": "2.1",
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
    """Toggle Mark Rule: 2.5–3.5 band stake uplift to 5 points."""
    engine.mark_uplift_enabled = not engine.mark_uplift_enabled
    engine._save_state()
    return {"mark_uplift_enabled": engine.mark_uplift_enabled}


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
    if req.minutes < 1 or req.minutes > 60:
        raise HTTPException(status_code=400, detail="Window must be 1–60 minutes")
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


def _get_historical_summary(exclude_date: str = None) -> dict:
    """Build cumulative performance summary from all historical sessions.

    Returns aggregated stats across all previous operating days,
    broken down by day, odds band, rule, and venue.
    """
    days = {}  # date -> {bets, wins, losses, pl, stake, liability}

    for s in engine.sessions:
        date = s.get("date", "")
        if exclude_date and date == exclude_date:
            continue
        if s.get("mode") != "LIVE":
            continue

        if date not in days:
            days[date] = {
                "date": date,
                "bets": 0, "stake": 0, "liability": 0,
                "sessions": 0,
            }
        days[date]["sessions"] += 1

        for b in s.get("bets", []):
            if b.get("dry_run"):
                continue
            days[date]["bets"] += len(s.get("bets", []))

    # Also gather all session data compactly
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

    return {
        "total_sessions": len(all_sessions),
        "operating_days": sorted(days.keys()),
        "day_summaries": list(days.values()),
        "sessions": all_sessions,
    }


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


@app.post("/api/chat")
def chat(req: ChatRequest):
    """Interactive chat with AI about session data."""
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
        else:
            context_sessions = engine.sessions[-10:]
        session_data = _compact_session_data(context_sessions)

    # Fetch settled data for the relevant date
    settled_context = ""
    if ds.get("settled_bets", True) and req.date:
        settled = _get_settled_for_date(req.date)
        if settled:
            settled_context = f"""

SETTLED BETS FROM BETFAIR (actual race outcomes with real P/L):
{json.dumps(settled, indent=2, default=str)}"""

    # Include historical summary for cumulative context
    historical = {}
    if ds.get("historical_summary", True):
        historical = _get_historical_summary()

    # Engine state
    engine_state_ctx = ""
    if ds.get("engine_state", True):
        engine_state_ctx = f"""
Active countries: {', '.join(engine.countries)}
Engine mode: {"DRY_RUN" if engine.dry_run else "LIVE"}
Balance: {engine.balance}"""

    # Rules
    rules_ctx = ""
    if ds.get("rule_definitions", True):
        rules_ctx = RULES_DESCRIPTION

    system_prompt = f"""You are CHIMERA, an expert horse racing lay betting analyst and assistant.
You have access to data from the CHIMERA Lay Engine (only the data sources enabled by the user).

{rules_ctx}
{engine_state_ctx}

SESSION DATA (bets placed by the engine):
{json.dumps(session_data, indent=2, default=str) if session_data else "(Session data not enabled)"}{settled_context}

HISTORICAL SUMMARY (all operating days):
{json.dumps(historical, indent=2, default=str) if historical else "(Historical data not enabled)"}

Answer questions about this data concisely. Be specific with numbers.
You can answer questions about any aspect: bets, P/L, venues, rules, cumulative performance, settled outcomes.
If asked for analysis, provide actionable insights. Keep responses conversational but data-driven."""

    messages = [{"role": h.role, "content": h.content} for h in req.history]
    messages.append({"role": "user", "content": req.message})

    try:
        client = get_anthropic()
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
        )
        return {"reply": response.content[0].text}
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
    engine_version: string;        // "CHIMERA Lay Engine v1.1"
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
      notes?: string;
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
    rule?: string;                 // e.g. "RULE_1", "RULE_2"
    excluded?: boolean;            // true if sub-2.0
    exclusion_reason?: string;     // e.g. "Sub-2.0"
    notes?: string;
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

=== DATA INPUTS ===

TRADING DATE: {date}
REPORT DATE: {report_date}

SESSION DATA (bets placed by the engine, with rule evaluations):
{session_data}

SETTLED BETS FROM BETFAIR (actual race outcomes with real P/L):
{settled_data}

HISTORICAL SESSIONS (all previous operating days — use for cumulative_performance):
{historical_data}

ENGINE STATE:
- Active countries: {countries}
- Mode: {mode}
- Engine version: CHIMERA Lay Engine v1.1

=== INSTRUCTIONS ===

1. Use SETTLED BETS data for actual WIN/LOSS outcomes and real P/L figures. Cross-reference by runner name and venue to match session bets with settled outcomes.
2. If settled data is empty (e.g. dry run mode or Betfair not authenticated), calculate P/L from session data using: WIN (lay wins when horse loses) = +stake, LOSS (lay loses when horse wins) = -liability. For DRY RUN bets, you must still assign WIN/LOSS results based on the settled data if available.
3. For cumulative_performance.by_day, include ALL historical operating days plus today.
4. For cumulative_performance.by_band, aggregate across ALL days (historical + today).
5. Strike rates and ROI are DECIMAL values (0.615 not 61.5, 0.266 not 26.6).
6. P/L values are raw GBP numbers (use -5.60 not "-£5.60").
7. Be precise with numbers — do not invent data. Only use the data provided.
8. The day_number should be calculated from the historical data (count of unique operating dates + 1 for today).
9. Include ALL bets that have a definitive outcome (WIN or LOSS) in the bets array. EXCLUDE any bets where the outcome cannot be determined — do NOT include VOID, NR, or unknown-result bets in any section (bets array, performance stats, odds band analysis, etc.). Only count bets with confirmed WIN/LOSS results.
10. Output ONLY the JSON object. No backticks, no markdown fences, no explanatory text."""


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

    ds = engine.settings.get("ai_data_sources", {})

    # 1. Compact session data (enriched with venue, country, market_id)
    session_data = _compact_session_data(selected_sessions) if ds.get("session_data", True) else []

    # 2. Settled bet data from Betfair (actual WIN/LOSS outcomes)
    settled_data = _get_settled_for_date(req.date) if ds.get("settled_bets", True) else None

    # 3. Historical session data for cumulative performance
    historical_data = _get_historical_summary(exclude_date=req.date) if ds.get("historical_summary", True) else {}

    # 4. Current engine state
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
        session_data=json.dumps(session_data, indent=2, default=str),
        settled_data=json.dumps(settled_data, indent=2, default=str) if settled_data else "[]  (No settled data available — use session data to calculate P/L)",
        historical_data=json.dumps(historical_data, indent=2, default=str),
        countries=", ".join(engine.countries),
        mode=mode,
    )

    try:
        client = get_anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=16384,
            messages=[{"role": "user", "content": prompt}],
        )
        if message.stop_reason == "max_tokens":
            logging.warning(f"Report response truncated — hit max_tokens ({16384})")
        report_text = message.content[0].text

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
    process_window_mins: int = 5
    jofs_enabled: bool = True
    mark_ceiling_enabled: bool = False
    mark_floor_enabled: bool = False
    mark_uplift_enabled: bool = False
    market_ids: list[str] = []  # empty = run all markets for the date


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
    Run a full-day backtest against FSU historic Betfair data.
    Evaluates each market at race_time - process_window_mins, applies rules,
    then checks the final settlement to compute P&L.
    """
    from datetime import datetime, timezone as _tz

    client = FSUClient(base_url=FSU_URL, date=req.date)
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
        )

        if rule_result.skipped:
            rd = rule_result.to_dict()
            rd["evaluated_at"] = target_iso
            rd["settled"] = False
            rd["winner_selection_id"] = None
            rd["pnl"] = 0.0
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
            instructions_with_outcome.append(d)

        rd = rule_result.to_dict()
        rd["instructions"] = instructions_with_outcome
        rd["evaluated_at"] = target_iso
        rd["winner_selection_id"] = winner_id
        rd["settled"] = settled
        rd["pnl"] = round(total_pnl, 2)
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

    return {
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


# ── Google Drive / Sheets helpers ──

GOOGLE_DRIVE_FOLDER_ID = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "")


def _google_access_token():
    """Get an OAuth2 access token from the default service account (Cloud Run)."""
    try:
        from google.auth import default as _gauth_default
        from google.auth.transport.requests import Request as _GRequest
        creds, _ = _gauth_default(scopes=[
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.file",
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

    token = _google_access_token()
    if not token:
        raise HTTPException(status_code=500, detail="Google auth not available")

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

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
        raise HTTPException(status_code=502, detail=f"Sheets API error: {create_resp.text}")

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

    # 5. Move to shared folder if configured
    if GOOGLE_DRIVE_FOLDER_ID:
        _requests.patch(
            f"https://www.googleapis.com/drive/v3/files/{spreadsheet_id}?addParents={GOOGLE_DRIVE_FOLDER_ID}",
            headers=headers,
            timeout=10,
        )

    return {"url": spreadsheet_url, "spreadsheet_id": spreadsheet_id}


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

    if not GOOGLE_DRIVE_FOLDER_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_DRIVE_FOLDER_ID not configured")

    headers = {"Authorization": f"Bearer {token}"}

    title = report.get("title", f"CHIMERA Report {report_id}")
    content = report.get("content", "")
    if isinstance(content, dict):
        content = json.dumps(content, indent=2)

    # Create HTML file in Drive
    html_body = f"""<html><head><meta charset="utf-8"><title>{title}</title></head>
<body style="font-family: Inter, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px;">
<h1>{title}</h1>
{content}
<hr><p style="color: #999; font-size: 11px;">Generated by CHIMERA Lay Engine</p>
</body></html>"""

    metadata = {
        "name": title,
        "mimeType": "application/vnd.google-apps.document",
        "parents": [GOOGLE_DRIVE_FOLDER_ID],
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
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
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
