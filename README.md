# CHIMERA Lay Engine

Automated lay betting engine for Betfair horse racing. Discovers WIN markets, identifies favourites, applies a fixed rule set, and places lay bets — all running unattended on Google Cloud Run with a React dashboard on Cloudflare Pages.

## Overview

CHIMERA scans Betfair Exchange for horse racing WIN markets across configurable countries (GB, IE, ZA, FR), fetches live prices, identifies the favourite and second favourite, then applies one of four stake rules based on the favourite's odds and the gap to the second favourite. Bets are placed automatically before the off. A full dry-run mode lets you watch the engine work with real market data without risking real money.

## Features

- **Automated market scanning** — Polls Betfair every 30s for upcoming WIN markets
- **4-rule lay strategy** — Deterministic rules based on favourite odds and the gap to second favourite
- **Dry run mode** — Fetches real markets and prices, logs everything, skips actual bet placement
- **Country selection** — Toggle GB, IE, ZA, FR markets from the dashboard
- **Session tracking** — Every engine run is a session with full bet/result history
- **AI analysis** — Interactive chat powered by Claude for session analysis and insights
- **Voice interface** — OpenAI Whisper STT + TTS for hands-free interaction with the AI
- **State persistence** — Survives Cloud Run cold starts via local disk + GCS bucket
- **Excel export** — Snapshot any table to `.xls` for offline analysis
- **Cold-start protection** — `/api/keepalive` endpoint for Cloud Scheduler pings

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Frontend (React)   │  HTTPS │  Backend (FastAPI)        │
│  Cloudflare Pages   │───────>│  Cloud Run europe-west2   │
│  layengine.thync.   │        │                           │
│  online             │        │  ┌──────────┐             │
└─────────────────────┘        │  │  Engine   │──> Betfair  │
                               │  │  Loop     │    Exchange  │
                               │  └──────────┘    API       │
                               │       │                    │
                               │  ┌────▼─────┐             │
                               │  │  GCS     │             │
                               │  │  Bucket  │             │
                               │  └──────────┘             │
                               └──────────────────────────┘
```

| Layer | Technology | Hosting |
|-------|-----------|---------|
| Frontend | React 18, Vite 6 | Cloudflare Pages |
| Backend | FastAPI, Uvicorn, Python 3.12 | Google Cloud Run |
| Persistence | JSON files on disk + Google Cloud Storage | GCS bucket |
| Betting API | Betfair Exchange JSON-RPC | betfair.com |
| AI Analysis | Anthropic Claude (claude-sonnet-4-5-20250929) | Anthropic API |
| Voice | OpenAI Whisper (STT) + TTS (nova) | OpenAI API |

## Betting Rules

All bets are **LAY** bets on horse racing **WIN** markets, placed pre-off.

| Rule | Condition | Action |
|------|-----------|--------|
| **RULE 1** | Favourite odds < 2.0 | Lay favourite @ **£3** |
| **RULE 2** | Favourite odds 2.0 – 5.0 | Lay favourite @ **£2** |
| **RULE 3A** | Favourite odds > 5.0 AND gap to 2nd fav < 2 | Lay favourite @ **£1** + Lay 2nd favourite @ **£1** |
| **RULE 3B** | Favourite odds > 5.0 AND gap to 2nd fav >= 2 | Lay favourite @ **£1** |

**Guards:**
- Markets with favourite odds > 50.0 are skipped (illiquid/bogus)
- In-play markets are skipped (pre-off only)
- Duplicate bets on the same runner/race are prevented

## Project Structure

```
chimera-lay-engine/
├── Dockerfile                  # Python 3.12 container for Cloud Run
├── README.md                   # This file
├── CHANGELOG.md                # Version history
├── test_rules.py               # Rule verification tests
├── .gitignore
├── backend/
│   ├── main.py                 # FastAPI app, all API endpoints
│   ├── engine.py               # Core engine: scan → rules → bet loop
│   ├── betfair_client.py       # Betfair Exchange API client
│   ├── rules.py                # Rule definitions + data classes
│   └── requirements.txt        # Python dependencies
└── frontend/
    ├── index.html              # HTML entry point
    ├── package.json            # Node dependencies
    ├── vite.config.js          # Vite config with /api proxy
    └── src/
        ├── main.jsx            # React entry point
        ├── App.jsx             # All UI components (single file)
        └── App.css             # All styles (dark theme)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Authenticate with Betfair |
| `POST` | `/api/logout` | Clear credentials, stop engine |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/keepalive` | Cloud Run warmup (for Cloud Scheduler) |
| `GET` | `/api/state` | Full engine state for dashboard |
| `GET` | `/api/rules` | Active rule set |
| `POST` | `/api/engine/start` | Start the engine |
| `POST` | `/api/engine/stop` | Stop the engine |
| `POST` | `/api/engine/dry-run` | Toggle dry run mode |
| `POST` | `/api/engine/countries` | Update market country filter |
| `POST` | `/api/engine/reset-bets` | Clear bets and re-process all markets |
| `GET` | `/api/sessions` | List all sessions (summaries) |
| `GET` | `/api/sessions/{id}` | Full session detail with bets/results |
| `POST` | `/api/sessions/analyse` | AI analysis of a day's sessions |
| `POST` | `/api/chat` | Interactive AI chat about session data |
| `POST` | `/api/audio/transcribe` | Speech-to-text via OpenAI Whisper |
| `POST` | `/api/audio/speak` | Text-to-speech via OpenAI TTS |

## Local Development

### Backend

```bash
cd backend
pip install -r requirements.txt
BETFAIR_APP_KEY=your_key DRY_RUN=true uvicorn main:app --reload --port 8080
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` requests to `localhost:8080` automatically.

### Running Tests

```bash
python3 test_rules.py
```

## Deployment

### Backend — Google Cloud Run

```bash
# Build and push container
gcloud builds submit --tag gcr.io/chimera-v4/chimera-lay-engine

# Deploy
gcloud run deploy chimera-lay-engine \
  --image gcr.io/chimera-v4/chimera-lay-engine \
  --region europe-west2 \
  --platform managed \
  --set-env-vars "BETFAIR_APP_KEY=<key>,FRONTEND_URL=https://layengine.thync.online,DRY_RUN=true,ANTHROPIC_API_KEY=<key>,OPENAI_API_KEY=<key>,GCS_BUCKET=<bucket>" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=256Mi \
  --allow-unauthenticated
```

### Cold-Start Prevention (Recommended)

```bash
gcloud scheduler jobs create http chimera-keepalive \
  --schedule="*/5 6-22 * * 1-6" \
  --uri="https://lay-engine-950990732577.europe-west2.run.app/api/keepalive" \
  --http-method=GET \
  --time-zone="Europe/London"
```

### Frontend — Cloudflare Pages

1. Push to GitHub (auto-deploys on push to `main`)
2. Build command: `npm run build`
3. Build output: `dist`
4. Root directory: `frontend`
5. Environment variable: `VITE_API_URL=https://lay-engine-950990732577.europe-west2.run.app`
6. Custom domain: `layengine.thync.online`

## Environment Variables

| Variable | Where | Default | Description |
|----------|-------|---------|-------------|
| `BETFAIR_APP_KEY` | Cloud Run | — | Betfair API application key |
| `FRONTEND_URL` | Cloud Run | `https://layengine.thync.online` | CORS allowed origin |
| `DRY_RUN` | Cloud Run | `true` | Skip real bet placement |
| `POLL_INTERVAL` | Cloud Run | `30` | Seconds between market scans |
| `STATE_FILE` | Cloud Run | `/tmp/chimera_engine_state.json` | Local state file path |
| `SESSIONS_FILE` | Cloud Run | `/tmp/chimera_sessions.json` | Session history file path |
| `GCS_BUCKET` | Cloud Run | — | GCS bucket for persistent state |
| `ANTHROPIC_API_KEY` | Cloud Run | — | Anthropic API key for AI chat/analysis |
| `OPENAI_API_KEY` | Cloud Run | — | OpenAI API key for Whisper STT + TTS |
| `VITE_API_URL` | Cloudflare Pages | — | Backend API URL for frontend |

## Going Live

1. Set `DRY_RUN=false` in Cloud Run environment variables, **or**
2. Toggle via the "Dry Run ON" button in the dashboard UI

## Dashboard UI

The dashboard is a single-page React app with four tabs:

- **History** — Session list with drill-down to individual session bets/results. AI analysis button opens the chat drawer with a pre-built analysis prompt.
- **Bets** — All bets placed today with venue, runner, odds, stake, liability, rule, and status.
- **Rules** — Every market evaluation showing favourite, odds, second favourite, rule applied, and number of bets.
- **Errors** — Timestamped error log.

Controls panel includes engine start/stop, dry run toggle, bet reset, AI chat button, live stats (markets/processed/bets/stake/liability), and country toggle switches.

## AI Chat

The chat drawer (`AI Chat` button or `Analysis` in History tab) provides:

- Conversational interface powered by Claude with full session data context
- Voice input via OpenAI Whisper (record → transcribe → send)
- Voice output via OpenAI TTS (nova voice) with browser fallback
- Sound toggle to mute/unmute voice responses
- Scoped to a specific date when opened from History, or last 10 sessions when opened from controls
