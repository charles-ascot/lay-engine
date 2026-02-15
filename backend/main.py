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
import logging
from pathlib import Path
from dotenv import load_dotenv

# Load .env if present (local dev)
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from engine import LayEngine

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
            "countries": ["GB", "IE"],
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
