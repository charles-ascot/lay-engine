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

# ── Gemini client (lazy — only created when analysis is requested) ──
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_gemini_client = None

def get_gemini():
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    return _gemini_client

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

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    date: str | None = None

class GenerateKeyRequest(BaseModel):
    label: str = ""


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
    return {
        "strategy": "UK_IE_Favourite_Lay",
        "version": "2.0",
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
            },
            {
                "id": "RULE_2",
                "condition": "Favourite odds 2.0 – 5.0",
                "action": "LAY favourite @ £2",
            },
            {
                "id": "RULE_3A",
                "condition": "Favourite odds > 5.0 AND gap to 2nd favourite < 2",
                "action": "LAY favourite @ £1 + LAY 2nd favourite @ £1",
            },
            {
                "id": "RULE_3B",
                "condition": "Favourite odds > 5.0 AND gap to 2nd favourite ≥ 2",
                "action": "LAY favourite @ £1",
            },
        ],
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
                    "time": b.get("timestamp"),
                    "dry_run": b.get("dry_run"),
                }
                for b in s.get("bets", [])
            ],
            "results": [
                {
                    "venue": r.get("venue"),
                    "race": r.get("market_name"),
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


RULES_DESCRIPTION = """The CHIMERA Lay Engine uses these rules on horse racing WIN markets:
- RULE 1: Favourite odds < 2.0 -> £3 lay on favourite
- RULE 2: Favourite odds 2.0-5.0 -> £2 lay on favourite
- RULE 3A: Favourite odds > 5.0 AND gap to 2nd fav < 2 -> £1 lay fav + £1 lay 2nd fav
- RULE 3B: Favourite odds > 5.0 AND gap to 2nd fav >= 2 -> £1 lay fav only"""


@app.post("/api/sessions/analyse")
def analyse_sessions(req: AnalyseRequest):
    """AI-powered analysis of all sessions for a given date."""
    if not GEMINI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "GEMINI_API_KEY not configured"},
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

    prompt = f"""You are an expert horse racing betting analyst. Analyse the following lay betting session data from {req.date}.

{RULES_DESCRIPTION}

SESSION DATA:
{json.dumps(session_data, indent=2, default=str)}

Provide exactly 6-10 concise bullet points covering:
- Odds drift patterns (are favourites drifting or shortening?)
- Rule distribution (which rules triggered most/least?)
- Risk exposure (total liability vs stake ratio)
- Venue/race patterns (any concentrations?)
- Session timing observations
- Any anomalies or notable patterns
- Actionable suggestions for rule tuning

Format each point as a single line starting with a bullet (•). Be specific with numbers. No headers, no preamble — just the bullet points."""

    try:
        client = get_gemini()
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        analysis_text = response.text
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
    if not GEMINI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "GEMINI_API_KEY not configured"},
        )

    # Build session context
    if req.date:
        context_sessions = [s for s in engine.sessions if s.get("date") == req.date]
    else:
        context_sessions = engine.sessions[-10:]

    session_data = _compact_session_data(context_sessions)

    system_prompt = f"""You are CHIMERA, an expert horse racing lay betting analyst and assistant.
You have access to session data from the CHIMERA Lay Engine.

{RULES_DESCRIPTION}

Active countries: {', '.join(engine.countries)}

SESSION DATA:
{json.dumps(session_data, indent=2, default=str)}

Answer questions about this data concisely. Be specific with numbers.
If asked for analysis, provide actionable insights. Keep responses conversational but data-driven."""

    messages = [{"role": h.role, "content": h.content} for h in req.history]
    messages.append({"role": "user", "content": req.message})

    try:
        client = get_gemini()
        # Build Gemini contents: system instruction + conversation history
        gemini_contents = [{"role": "user", "parts": [{"text": system_prompt}]},
                          {"role": "model", "parts": [{"text": "Understood. I'm CHIMERA, ready to analyse your session data."}]}]
        for m in messages:
            role = "user" if m["role"] == "user" else "model"
            gemini_contents.append({"role": role, "parts": [{"text": m["content"]}]})
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=gemini_contents,
        )
        return {"reply": response.text}
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


DAILY_REPORT_PROMPT = """You are a professional horse racing lay betting analyst producing a comprehensive daily performance report for the CHIMERA Lay Engine. Generate a detailed report in clean markdown format following this exact structure. Use the session data provided.

{rules_description}

SESSION DATA FOR {date}:
{session_data}

Generate the report in markdown with these sections. Use actual data from the sessions provided. If data is insufficient for a section, note it briefly and move on.

# CHIMERA Lay Engine Performance Report
## {date}

### Executive Summary
Write a 3-4 sentence headline summary covering: total bets, win-loss record, strike rate, net P/L, and one key finding. Use the format "XW-YL (Z%)" for records.

### Performance Summary

| Metric | Value |
|--------|-------|
| Total Bets | (number) |
| Record | XW-YL |
| Strike Rate | X% |
| Total Staked | £X.XX |
| Total Liability | £X.XX |
| Net P/L | £X.XX |
| Mode | (DRY_RUN or LIVE) |

### Odds Band Analysis
Break down results into these bands: <2.0, 2.0-2.99, 3.0-3.99, 4.0-4.99, 5.0+
For each band show: bets, wins, strike%, P/L, and a verdict (STRONG/SOLID/MIXED/POOR/TOXIC).
Present as a table.

### Country & Venue Analysis
Break down by country and venue. Show bets, record, strike%, P/L for each.
Present as a table.

### Rule Distribution
Show which rules triggered and their performance:
- RULE_1 (<2.0): count, strike%, P/L
- RULE_2 (2.0-5.0): count, strike%, P/L
- RULE_3A (>5.0, gap<2): count, strike%, P/L
- RULE_3B (>5.0, gap>=2): count, strike%, P/L
Present as a table.

### Individual Bet Breakdown
List ALL bets in a table with columns: Runner, Venue, Country, Odds, Stake, Liability, Rule, Result (WIN/LOSS/DRY).
Sort by time.

### Session Timing
Note when sessions started/stopped and any timing observations.

### Key Observations
Provide 5-8 bullet points with specific actionable observations covering:
- Strike rate patterns
- Risk exposure (liability vs stake ratios)
- Best/worst performing segments
- Any anomalies
- Suggestions for rule tuning

### Recommendations
3-5 specific, data-driven recommendations for the next trading day.

---
*Report generated by CHIMERA AI Agent*

IMPORTANT: Use ONLY the data provided. Calculate P/L as: WIN = +stake, LOSS = -liability. For dry run bets, mark result as DRY (neither win nor loss). Be precise with numbers — do not invent data."""


@app.get("/api/reports/templates")
def get_report_templates():
    """List available report templates."""
    return {"templates": [
        {"id": k, "name": v["name"], "description": v["description"]}
        for k, v in REPORT_TEMPLATES.items()
    ]}


@app.post("/api/reports/generate")
def generate_report(req: GenerateReportRequest):
    """Generate an AI-powered daily report for the selected sessions."""
    if not GEMINI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "GEMINI_API_KEY not configured"},
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

    session_data = _compact_session_data(selected_sessions)

    prompt = DAILY_REPORT_PROMPT.format(
        rules_description=RULES_DESCRIPTION,
        date=req.date,
        session_data=json.dumps(session_data, indent=2, default=str),
    )

    try:
        client = get_gemini()
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        report_content = response.text

        # Store the report
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
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
            "content": report_content,
        }
        engine.reports.append(report)
        engine._save_reports()

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
