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

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from engine import LayEngine

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

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    date: str | None = None


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
        client = get_anthropic()
        message = client.messages.create(
            model="claude-sonnet-4-5-20250929",
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
        client = get_anthropic()
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
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
