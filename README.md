# CHIMERA Lay Engine

Automated lay betting engine for Betfair horse racing. Discovers WIN markets, identifies favourites, applies a fixed rule set, and places lay bets — all running unattended on Google Cloud Run with a React dashboard on Cloudflare Pages.

## Overview

CHIMERA scans Betfair Exchange for horse racing WIN markets across configurable countries (GB, IE, ZA, FR), fetches live prices, identifies the favourite and second favourite, then applies one of four stake rules based on the favourite's odds and the gap to the second favourite. Bets are placed automatically before the off. A full dry-run mode lets you watch the engine work with real market data without risking real money.

## Features

- **Automated market scanning** — Polls Betfair every 30s for upcoming WIN markets
- **4-rule lay strategy** — Deterministic rules based on favourite odds and the gap to second favourite
- **Points Value** — Configurable stake multiplier (£1–£50 per point) applied to all rule stakes
- **Dynamic Spread Control** — Validates back-lay spread against odds-based thresholds to reject bets in illiquid markets (toggleable)
- **Dry run mode** — Fetches real markets and prices, logs everything, skips actual bet placement
- **Country selection** — Toggle GB, IE, ZA, FR markets from the dashboard
- **Live market view** — Betfair-style 3-level back/lay price grid with auto-refresh
- **Matched bets** — View all live bets placed on Betfair with date range filtering
- **Settled bets** — Race results with actual P/L from Betfair cleared orders
- **Session tracking** — Every engine run is a session with full bet/result history
- **AI reports** — Structured daily performance reports (JSON) with odds band analysis, venue analysis, cumulative performance, and recommendations
- **AI chat** — Interactive conversational analysis powered by Gemini with full session data context
- **Voice interface** — OpenAI Whisper STT + TTS for hands-free interaction with the AI
- **API key auth** — External agent access with key-based authentication
- **State persistence** — Survives Cloud Run cold starts via local disk + GCS bucket
- **Excel export** — Snapshot any table to `.xls` for offline analysis
- **Balance auto-refresh** — Account balance updates every 30 seconds

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Frontend (React)   │  HTTPS │  Backend (FastAPI)        │
│  Cloudflare Pages   │───────>│  Cloud Run europe-west2   │
│  chimera5.thync.    │        │                           │
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
| AI Analysis | Google Gemini 2.5 Flash | Google AI API |
| Voice | OpenAI Whisper (STT) + TTS (nova) | OpenAI API |

## Betting Rules

All bets are **LAY** bets on horse racing **WIN** markets, placed pre-off. Base stakes are multiplied by the **Points Value** setting (default £1/point).

| Rule | Condition | Action (base stake) |
|------|-----------|---------------------|
| **RULE 1** | Favourite odds < 2.0 | Lay favourite @ **3 pts** |
| **RULE 2** | Favourite odds 2.0 – 5.0 | Lay favourite @ **2 pts** |
| **RULE 3A** | Favourite odds > 5.0 AND gap to 2nd fav < 2 | Lay favourite @ **1 pt** + Lay 2nd favourite @ **1 pt** |
| **RULE 3B** | Favourite odds > 5.0 AND gap to 2nd fav >= 2 | Lay favourite @ **1 pt** |

**Guards:**
- Markets with favourite odds > 50.0 are skipped (illiquid/bogus)
- In-play markets are skipped (pre-off only)
- Duplicate bets on the same runner/race are prevented
- Spread Control (optional) rejects bets where back-lay spread exceeds odds-based thresholds

### Spread Control Thresholds

| Odds Range | Max Spread | Action |
|-----------|-----------|--------|
| 1.0 – 2.0 | 0.05 | Allow if within |
| 2.0 – 3.0 | 0.15 | Allow if within |
| 3.0 – 5.0 | 0.30 | Allow if within |
| 5.0 – 8.0 | 0.50 | Allow if within |
| 8.0+ | — | REJECT (too volatile) |

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
│   ├── rules.py                # Rule definitions, spread control, data classes
│   └── requirements.txt        # Python dependencies
├── frontend/
│   ├── index.html              # HTML entry point
│   ├── package.json            # Node dependencies
│   ├── vite.config.js          # Vite config with /api proxy
│   └── src/
│       ├── main.jsx            # React entry point
│       ├── App.jsx             # All UI components (single file)
│       └── App.css             # All styles (glassmorphism dark theme)
└── update/
    └── chimera-report-template/ # ChimeraReport JSON schema reference
```

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| **Market** | Live Betfair price grid with 3-level back/lay depth, book %, auto-refresh |
| **Snapshots** | Session history grouped by date with drill-down to individual bets |
| **Matched** | All LIVE bets placed on Betfair with date range filter and Excel export |
| **Settled** | Race results with P/L from Betfair, Won/Lost filter, AI Report per day |
| **Reports** | AI-generated daily performance reports with structured tables and PDF export |
| **Rules** | Every market evaluation showing favourite, odds, rule applied |
| **Errors** | Timestamped error log |
| **API Keys** | Generate, list, and revoke API keys for external agents |

## API Endpoints

### Core

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Authenticate with Betfair |
| `POST` | `/api/logout` | Clear credentials, stop engine |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/keepalive` | Cloud Run warmup (for Cloud Scheduler) |
| `GET` | `/api/state` | Full engine state for dashboard |
| `GET` | `/api/rules` | Active rule set with spread control config |

### Engine Controls

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/engine/start` | Start the engine |
| `POST` | `/api/engine/stop` | Stop the engine |
| `POST` | `/api/engine/dry-run` | Toggle dry run mode |
| `POST` | `/api/engine/countries` | Update market country filter |
| `POST` | `/api/engine/spread-control` | Toggle spread control on/off |
| `POST` | `/api/engine/point-value` | Set point value (stake multiplier) |
| `POST` | `/api/engine/reset-bets` | Clear bets and re-process all markets |
| `GET` | `/api/engine/spread-rejections` | View recent spread rejections |

### Market Data

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/markets` | All discovered markets for today |
| `GET` | `/api/markets/{id}/book` | Full market book with 3-level depth |
| `GET` | `/api/matched` | Live matched bets (date range filter) |
| `GET` | `/api/settled` | Settled bets with P/L (date range filter) |

### Sessions & AI

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all sessions (summaries) |
| `GET` | `/api/sessions/{id}` | Full session detail with bets/results |
| `POST` | `/api/sessions/analyse` | AI analysis of a day's sessions |
| `POST` | `/api/chat` | Interactive AI chat about session data |
| `POST` | `/api/audio/transcribe` | Speech-to-text via OpenAI Whisper |
| `POST` | `/api/audio/speak` | Text-to-speech via OpenAI TTS |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reports/templates` | List available report templates |
| `POST` | `/api/reports/generate` | Generate AI report for selected sessions |
| `GET` | `/api/reports` | List all generated reports |
| `GET` | `/api/reports/{id}` | View report with full content |
| `DELETE` | `/api/reports/{id}` | Delete a report |

### API Keys & Data API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/keys/generate` | Generate API key |
| `GET` | `/api/keys` | List API keys (masked) |
| `DELETE` | `/api/keys/{id}` | Revoke API key |
| `GET` | `/api/data/sessions` | All sessions (requires API key) |
| `GET` | `/api/data/sessions/{id}` | Session detail (requires API key) |
| `GET` | `/api/data/bets` | All bets (requires API key) |
| `GET` | `/api/data/results` | All rule evaluations (requires API key) |
| `GET` | `/api/data/state` | Engine state (requires API key) |
| `GET` | `/api/data/rules` | Rule definitions (requires API key) |
| `GET` | `/api/data/summary` | Aggregated statistics (requires API key) |

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
  --set-env-vars "BETFAIR_APP_KEY=<key>,FRONTEND_URL=https://chimera5.thync.online,DRY_RUN=true,GEMINI_API_KEY=<key>,OPENAI_API_KEY=<key>,GCS_BUCKET=<bucket>" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=256Mi \
  --allow-unauthenticated
```

Both Cloud Run (backend) and Cloudflare Pages (frontend) auto-deploy when code is pushed to GitHub.

### Cold-Start Prevention (Recommended)

```bash
gcloud scheduler jobs create http chimera-keepalive \
  --schedule="*/5 6-22 * * 1-6" \
  --uri="https://chimera-flumine-950990732577.europe-west2.run.app/api/keepalive" \
  --http-method=GET \
  --time-zone="Europe/London"
```

### Frontend — Cloudflare Pages

1. Push to GitHub (auto-deploys on push to `main`)
2. Build command: `npm run build`
3. Build output: `dist`
4. Root directory: `frontend`
5. Environment variable: `VITE_API_URL=https://chimera-flumine-950990732577.europe-west2.run.app`
6. Custom domain: `chimera5.thync.online`

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
| `GEMINI_API_KEY` | Cloud Run | — | Google Gemini API key for AI reports/chat |
| `OPENAI_API_KEY` | Cloud Run | — | OpenAI API key for Whisper STT + TTS |
| `VITE_API_URL` | Cloudflare Pages | — | Backend API URL for frontend |

## Going Live

1. Set `DRY_RUN=false` in Cloud Run environment variables, **or**
2. Toggle via the "Dry Run ON" button in the dashboard UI

## AI Chat

The chat drawer (AI Chat button or AI Report in Settled tab) provides:

- Conversational interface powered by Gemini 2.5 Flash with full session data context
- Access to settled bet outcomes, historical cumulative data, venue/country breakdown
- Voice input via OpenAI Whisper (record > transcribe > send)
- Voice output via OpenAI TTS (nova voice) with browser fallback
- Sound toggle to mute/unmute voice responses
- Scoped to a specific date when opened from Settled, or last 10 sessions when opened from controls

## AI Reports

Daily performance reports are generated as structured JSON conforming to the ChimeraReport schema:

- Executive summary with headline and key findings
- Day performance slices (all bets, sub-2.0 only, 2.0+ only)
- Odds band analysis with verdicts (ELITE/PRIME/STRONG/SOLID/MIXED/WEAK/POOR/TOXIC)
- Discipline analysis (Flat, Flat AW, Jumps NH)
- Venue analysis with ratings
- Individual bet breakdown (confirmed WIN/LOSS only — VOID excluded)
- Cumulative performance by day and by band
- Key findings and recommendations
- Downloadable as PDF via print dialog

## Tagged Versions

| Tag | Description |
|-----|-------------|
| `v1.0-reports` | Stable release with Anthropic Claude-based AI agent |
