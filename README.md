# CHIMERA Lay Engine

Automated lay betting engine for Betfair horse racing. Discovers WIN markets, identifies favourites, applies a fixed rule set, and places lay bets — all running unattended on Google Cloud Run with a React dashboard on Cloudflare Pages.

**Current version: v5.0.0**
**Last endpoint audit: 2026-03-18**

---

## Overview

CHIMERA scans Betfair Exchange for horse racing WIN markets across configurable countries (GB, IE, ZA, FR), fetches live prices, identifies the favourite and second favourite, then applies one of four stake rules based on the favourite's odds and the gap to the second favourite. Bets are placed automatically before the off. A full dry-run mode lets you watch the engine work with real market data without risking real money.

---

## Platform Architecture

CHIMERA is a multi-service platform running on Google Cloud Platform (project: `chimera-v4`). All services share the compute service account `950990732577-compute@developer.gserviceaccount.com`.

```
┌─────────────────────┐        ┌──────────────────────────────────────────┐
│  Frontend (React)   │  HTTPS │  Lay Engine — Orchestrator               │
│  Cloudflare Pages   │───────>│  Cloud Run: lay-engine (europe-west2)    │
│  layengine.thync.   │        │  Repo: charles-ascot/lay-engine          │
│  online             │        └──────────┬───────────────────────────────┘
└─────────────────────┘                   │
                                          │ FSU_URL env var
              ┌───────────────────────────┼──────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│  FSU1 — Data Replay │   │  FSU2 — Video Intel  │   │  FSU3 — Backtest    │
│  europe-west1       │   │  europe-west1        │   │  europe-west2       │
│  Repo: fsu1         │   │  Node.js / Express   │   │  Repo: fsu3         │
│  GCS: betfair-      │   │  Gemini 2.5 Flash    │   │  Standalone rules   │
│  historic-adv       │   │  GCS: chimera-video- │   │  engine + P&L       │
└─────────────────────┘   │  summaries           │   └─────────────────────┘
                          └─────────────────────┘

┌─────────────────────┐
│  Data Recorder      │
│  betfair-data-rec   │
│  europe-west2       │
│  datarec.thync.     │
│  online             │
└─────────────────────┘
```

| Service | Technology | Hosting | URL |
|---------|-----------|---------|-----|
| Lay Engine (backend) | FastAPI, Python 3.12 | Cloud Run europe-west2 | `lay-engine-*.europe-west2.run.app` |
| Frontend | React 18, Vite 6 | Cloudflare Pages | `layengine.thync.online` |
| FSU1 — Data Replay | Python | Cloud Run europe-west1 | — |
| FSU2 — Video Intelligence | Node.js/Express | Cloud Run europe-west1 | — |
| FSU3 — Backtest | Python | Cloud Run europe-west2 | — |
| Data Recorder | — | Cloud Run europe-west2 | `datarec.thync.online` |
| Persistence | JSON + GCS bucket | Google Cloud Storage | — |
| Betting API | Betfair Exchange JSON-RPC | betfair.com | — |
| AI Analysis | Anthropic Claude Sonnet 4.6 | Anthropic API | — |
| Email | SendGrid REST API | SendGrid | — |
| Voice | OpenAI Whisper (STT) + TTS (nova) | OpenAI API | — |

---

## Features

- **Automated market scanning** — Polls Betfair every 30s for upcoming WIN markets
- **4-rule lay strategy** — Deterministic rules based on favourite odds and the gap to second favourite
- **Points Value** — Configurable stake multiplier (£0.50–£100 per point) applied to all rule stakes
- **Dynamic Spread Control** — Validates back-lay spread against odds-based thresholds (toggleable)
- **JOFS Control** — Close-odds split filter: skips markets where the gap between favourite and second favourite is very small (toggleable)
- **Mark Rules** — Ceiling (no lays above 8.0), Floor (no lays below 1.5), and Uplift (boosted stake in 2.5–3.5 band) — each independently toggleable
- **Kelly Criterion** — Optional Kelly-fraction stake sizing with bankroll, edge %, min/max stake controls
- **Process Window** — Configurable minutes-before-off window (0.05–60 min) within which the engine will consider placing a bet
- **Dry run mode** — Fetches real markets and prices, logs everything, skips actual bet placement
- **Dry run snapshots** — Instant point-in-time dry-run snapshots for selected markets; archived to GCS
- **Country selection** — Toggle GB, IE, ZA, FR markets from the dashboard
- **Live market view** — Betfair-style 3-level back/lay price grid with auto-refresh
- **Matched bets** — View all live bets placed on Betfair with date range filtering
- **Settled bets** — Race results with actual P/L from Betfair cleared orders
- **Session tracking** — Every engine run is a session with full bet/result history
- **Data Registry** — Full inventory of all data records (sessions, snapshots, reports) with storage locations
- **AI reports** — Structured daily performance reports (JSON) with odds band analysis, venue analysis, cumulative performance, and recommendations
- **AI chat** — Interactive conversational analysis powered by Claude Sonnet 4.6 with full session data context
- **Voice interface** — OpenAI Whisper STT + TTS for hands-free interaction with the AI
- **API key auth** — External FSU/agent access with key-based authentication (`X-API-Key` header)
- **Data API** — Key-authenticated endpoints exposing sessions, bets, results, rules, state, and summary stats
- **State persistence** — Survives Cloud Run cold starts via local disk + GCS bucket
- **Report recipients** — Add email recipients who automatically receive copies of AI-generated reports via SendGrid
- **Google Drive export** — Save reports as Google Docs in Drive
- **AI data source toggles** — Control which data sets are exposed to the AI agent
- **AI capability toggles** — Control what actions the AI agent can perform
- **Excel export** — Snapshot any table to `.xls` for offline analysis
- **Balance auto-refresh** — Account balance updates every 30 seconds
- **Glassmorphism dark UI** — Three-theme dashboard (Classic / Dark Glass / Light Glass) with hero image background

---

## Betting Rules

All bets are **LAY** bets on horse racing **WIN** markets, placed pre-off. Base stakes are multiplied by the **Points Value** setting (default £1/point).

| Rule | Condition | Action (base stake) |
|------|-----------|---------------------|
| **RULE 1** | Favourite odds < 2.0 | Lay favourite @ **3 pts** |
| **RULE 2** | Favourite odds 2.0 – 5.0 | Lay favourite @ **2 pts** |
| **RULE 3A** | Favourite odds > 5.0 AND gap to 2nd fav < 2 | Lay favourite @ **1 pt** + Lay 2nd favourite @ **1 pt** |
| **RULE 3B** | Favourite odds > 5.0 AND gap to 2nd fav >= 2 | Lay favourite @ **1 pt** |

**Guards applied before rule evaluation:**
- Markets with favourite odds > 50.0 are skipped (illiquid/bogus)
- In-play markets are skipped (pre-off only)
- Duplicate bets on the same runner/race are prevented
- **Spread Control** (optional) — rejects bets where back-lay spread exceeds odds-based thresholds
- **JOFS Control** (optional) — rejects markets where odds gap is too small (jump-on-favourite scenario)
- **Mark Ceiling** (optional) — rejects any lay where odds > 8.0
- **Mark Floor** (optional) — rejects any lay where odds < 1.5
- **Mark Uplift** (optional) — applies a 3 pt uplift stake (adjustable 2–10 pts) to bets in the 2.5–3.5 odds band

### Spread Control Thresholds

| Odds Range | Max Spread | Action |
|-----------|-----------|--------|
| 1.0 – 2.0 | 0.05 | Allow if within |
| 2.0 – 3.0 | 0.15 | Allow if within |
| 3.0 – 5.0 | 0.30 | Allow if within |
| 5.0 – 8.0 | 0.50 | Allow if within |
| 8.0+ | — | REJECT (too volatile) |

---

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| **Live** | Start/stop LIVE engine, real-time market book (3-level back/lay depth), active bets, P&L |
| **Dry Run** | Start/stop DRY RUN engine, same market view, instant snapshot tool for selected markets |
| **Backtest** | Historic market replay — single date run, multi-date cycle run, history with export |
| **Strategy** | Strategy visualisation and rule documentation |
| **History** | Three sub-tabs: Sessions (live session history), Matched (bets on Betfair), Settled (P/L from Betfair) |
| **Bet Settings** | All betting parameters: timing, stake, countries, rules, JOFS, Spread Control, Mark Rules, Kelly, Process Window |
| **Settings** | Report recipients, AI data source toggles, AI capability toggles, theme selection |
| **Reports** | AI-generated daily performance reports with structured tables; generate, view, email, save to Drive |

---

## Project Structure

```
chimera-lay-engine/
├── Dockerfile                  # Python 3.12 container for Cloud Run
├── README.md                   # This file
├── CHANGELOG.md                # Version history
├── test_rules.py               # Rule verification tests
├── .gitignore
├── backend/
│   ├── main.py                 # FastAPI app — all 60 API endpoints
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
│       └── App.css             # All styles (glassmorphism themes)
└── update/
    └── chimera-report-template/ # ChimeraReport JSON schema reference
```

---

## API Endpoints

> **Base URL (production):** `https://lay-engine-950990732577.europe-west2.run.app`
> **Authentication (Data API):** `X-API-Key: <key>` header or `?api_key=<key>` query param
> **Total endpoints: 60**

---

### Authentication & Health

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/login` | `{username, password}` | `{status, balance}` | Authenticate with Betfair |
| `POST` | `/api/logout` | — | `{status}` | Clear credentials, stop engine |
| `GET` | `/api/health` | — | `{status, engine}` | Health check |
| `GET` | `/api/keepalive` | — | `{status, engine, authenticated, dry_run, markets, bets_today}` | Cloud Run warmup (for Cloud Scheduler) |

---

### Core State

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/state` | — | Full engine state JSON | Full engine state for dashboard |
| `GET` | `/api/rules` | — | `{strategy, version, timing, markets, rules[], spread_control, jofs_control}` | Active rule set with all control config |

---

### Engine Controls

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/engine/start` | — | `{status}` | Start the engine loop |
| `POST` | `/api/engine/stop` | — | `{status}` | Stop the engine loop |
| `POST` | `/api/engine/dry-run` | — | `{dry_run: bool}` | Toggle dry run mode |
| `POST` | `/api/engine/countries` | `{countries: [GB,IE,ZA,FR]}` | `{countries}` | Set market country filter |
| `POST` | `/api/engine/process-window` | `{minutes: float (0.05–60)}` | `{status, process_window}` | Set betting window (minutes before off) |
| `POST` | `/api/engine/point-value` | `{value: float (0.5–100)}` | `{point_value}` | Set stake multiplier (£/point) |
| `POST` | `/api/engine/spread-control` | — | `{spread_control: bool}` | Toggle spread control |
| `POST` | `/api/engine/jofs-control` | — | `{jofs_control: bool}` | Toggle JOFS close-odds-split filter |
| `POST` | `/api/engine/mark-ceiling` | — | `{mark_ceiling_enabled: bool}` | Toggle Mark Rule ceiling (no lays > 8.0) |
| `POST` | `/api/engine/mark-floor` | — | `{mark_floor_enabled: bool}` | Toggle Mark Rule floor (no lays < 1.5) |
| `POST` | `/api/engine/mark-uplift` | — | `{mark_uplift_enabled: bool}` | Toggle Mark Rule uplift (2.5–3.5 band) |
| `POST` | `/api/engine/mark-uplift-stake` | `{value: float (1–20)}` | `{mark_uplift_stake}` | Set Mark Rule uplift stake (pts) |
| `POST` | `/api/engine/kelly` | `{enabled, fraction (0–1), bankroll, edge_pct (0–50), min_stake, max_stake}` | `{kelly: {...}}` | Update Kelly Criterion config |
| `POST` | `/api/engine/reset-bets` | — | `{status}` | Clear dry-run bets and re-process markets |
| `GET` | `/api/engine/spread-rejections` | — | `{rejections: [...]}` | View last 50 spread control rejections |

---

### Market Data

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/markets` | — | `{markets: [{market_id, race_time, minutes_to_off, status, ...}]}` | All discovered markets for today |
| `GET` | `/api/markets/{market_id}/book` | — | `{market_id, runners: [{selection_id, name, back[], lay[]}], venue, race_time}` | Full market book with 3-level back/lay depth |
| `GET` | `/api/monitoring/{market_id}` | — | `{market_id, snapshots: [], count}` | Odds monitoring snapshots for drift analysis |

---

### Dry Run Snapshots

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/engine/snapshot` | `{market_ids: [str]}` | Full dry-run snapshot JSON | Instant dry-run snapshot for selected markets |
| `GET` | `/api/snapshots` | — | `{snapshots: [{summary fields}]}` | List all snapshots (summaries only) |
| `GET` | `/api/snapshots/{snapshot_id}` | — | Full snapshot with per-market results | Get full snapshot detail |
| `POST` | `/api/snapshots/{snapshot_id}/archive` | — | `{snapshot_id, archived: bool}` | Toggle snapshot archived flag |
| `GET` | `/api/snapshots/{snapshot_id}/export` | — | JSON file download | Download snapshot as JSON file |

---

### Sessions

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/sessions` | — | `{sessions: [{summary fields}]}` | List all sessions (summaries) |
| `GET` | `/api/sessions/{session_id}` | — | Full session detail with bets/results | Get full session detail |

---

### Matched & Settled Bets

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/matched` | `?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` | `{count, total_stake, total_liability, avg_odds, bets_by_date}` | Live matched bets on Betfair |
| `GET` | `/api/settled` | `?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` | `{count, total_pl, wins, losses, strike_rate, days: {bets, p&l, races}}` | Settled bets with P/L from Betfair |
| `GET` | `/api/data-registry` | — | `{entries: [{date, sessions, snapshots, reports}], storage_locations}` | Full data inventory with storage locations |

---

### AI Analysis & Chat

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/sessions/analyse` | `{date: YYYY-MM-DD}` | `{date, points: [6-10 bullet analysis]}` | AI quick-analysis of a day's sessions |
| `POST` | `/api/chat` | `{message, history: [], date?: YYYY-MM-DD}` | `{reply}` | Interactive AI chat with session context |
| `POST` | `/api/audio/transcribe` | Multipart file (audio) | `{text}` | Speech-to-text via OpenAI Whisper |
| `POST` | `/api/audio/speak` | `{text}` | Audio stream (MP3) | Text-to-speech via OpenAI TTS (nova voice) |

---

### Reports

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/reports/templates` | — | `{templates: [{id, name, description}]}` | List available report templates |
| `POST` | `/api/reports/generate` | `{date, session_ids: [], template}` | Full report JSON | Generate AI daily report (auto-emails recipients) |
| `GET` | `/api/reports` | — | `{reports: [{id, date, template, title, created_at}]}` | List all reports (without content) |
| `GET` | `/api/reports/{report_id}` | — | Full report with content | Get report with full content |
| `DELETE` | `/api/reports/{report_id}` | — | `{status, message}` | Delete a report |
| `POST` | `/api/reports/{report_id}/send` | — | `{status, sent: int}` | Email report to all configured recipients |
| `POST` | `/api/reports/{report_id}/save-drive` | — | `{url: Google Doc URL, file_id}` | Save report as Google Doc in Drive |

---

### Settings

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/settings` | — | `{report_recipients, ai_data_sources, ai_capabilities}` | Get all settings |
| `PUT` | `/api/settings/recipients` | `{recipients: [{email, name}]}` | `{status, recipients}` | Update report email recipients |
| `PUT` | `/api/settings/ai-data-sources` | `{ai_data_sources: {key: bool}}` | `{status, ai_data_sources}` | Toggle AI data source access |
| `PUT` | `/api/settings/ai-capabilities` | `{ai_capabilities: {key: bool}}` | `{status, ai_capabilities}` | Toggle AI agent permissions |

---

### API Keys

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/keys/generate` | `{label?: str}` | `{status, key, key_id, label}` | Generate a new API key |
| `GET` | `/api/keys` | — | `{keys: [{key_id, label, created_at, masked}]}` | List API keys (masked) |
| `DELETE` | `/api/keys/{key_id}` | — | `{status, message}` | Revoke an API key |

---

### Data API  _(requires `X-API-Key` header or `?api_key=` query param)_

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/data/sessions` | `?date=YYYY-MM-DD&mode=LIVE\|DRY_RUN` | `{count, sessions: [full detail]}` | All sessions with optional date/mode filter |
| `GET` | `/api/data/sessions/{session_id}` | — | Full session detail | Get specific session by ID |
| `GET` | `/api/data/bets` | `?date=YYYY-MM-DD&mode=LIVE\|DRY_RUN` | `{count, bets: [...]}` | All bets with optional filter |
| `GET` | `/api/data/results` | `?date=YYYY-MM-DD` | `{count, results: [rule evaluations]}` | All rule evaluation results |
| `GET` | `/api/data/state` | — | Full engine state | Current engine state |
| `GET` | `/api/data/rules` | — | Rule definitions | Active rule definitions |
| `GET` | `/api/data/summary` | `?date=YYYY-MM-DD` | `{total_sessions, total_bets, total_stake, bets_by_rule, dates_active, ...}` | Aggregated statistics |

---

### Backtest

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `GET` | `/api/backtest/dates` | — | `{dates: [...]}` | Available replay dates from FSU1 |
| `GET` | `/api/backtest/markets` | `?date=YYYY-MM-DD&countries=GB,IE` | `{markets: [...]}` | Markets for date + country filter |
| `POST` | `/api/backtest/run` | `{date, countries, jofs_enabled, spread_control, mark_ceiling, mark_floor, mark_uplift, mark_uplift_stake, point_value, process_window, kelly_enabled, ai_agent_enabled, odds_agent_enabled, market_ids?: [...]}` | `{job_id, status}` | Start backtest job (async — poll for result) |
| `GET` | `/api/backtest/job/{job_id}` | — | `{job_id, status, result?, error?}` | Poll backtest job status / retrieve results |
| `POST` | `/api/backtest/export-sheets` | `{entries: [backtest run objects]}` | `{url: spreadsheet URL, spreadsheet_id}` | Export backtest runs to Google Sheets |

---

## Backtest Tab

### Single Run
1. Select a date from the dropdown (populated from FSU1 historic data).
2. Configure rules (JOFS, Spread Control, Mark Ceiling/Floor/Uplift, Point Value, Process Window, Kelly).
3. Optionally filter the market browser to include only specific races.
4. Click **Run Backtest** — the engine calls `/api/backtest/run` (async job) and polls `/api/backtest/job/{job_id}` until complete.
5. Results appear as a settlement table with P&L per race.
6. Each run is saved to **History** (browser localStorage, max 50 runs).

### Cycle Run
1. Tick any number of dates in the **Dates** grid.
2. Click **Run Cycle** — calls `/api/backtest/run` once per date (all markets, no pre-filtering) with a live progress bar.
3. When complete the cycle is saved to **Cycle History** (separate localStorage key, max 20 runs).

### History & Export
Both History sections support:
- **Select / Deselect All** for bulk operations
- **Download XLS** — exports selected runs to a local Excel file
- **Google Sheets** — exports to a new Google Spreadsheet (requires service account with Sheets API scope — currently requires SA to have Sheets API permission)
- **Delete** — removes selected entries from localStorage
- **Clear All** — wipes the entire history section

| Store | localStorage key | Max entries |
|-------|-----------------|-------------|
| Single runs | `chimera_backtest_history` | 50 |
| Cycle runs | `chimera_backtest_cycle_history` | 20 |

---

## AI Chat

The chat drawer (AI Chat button, or opened from History) provides:

- Conversational interface powered by Claude Sonnet 4.6
- Data access controlled by **AI Data Source** toggles in Settings
- Voice input via OpenAI Whisper (record → transcribe → send)
- Voice output via OpenAI TTS (nova voice) with browser fallback
- Sound toggle to mute/unmute voice responses
- Scoped to a specific date when opened with context, or last 10 sessions otherwise

---

## AI Reports

Daily performance reports conform to the ChimeraReport JSON schema:

- Executive summary with headline and key findings
- Day performance slices (all bets, sub-2.0, 2.0+)
- Odds band analysis with verdicts (ELITE / PRIME / STRONG / SOLID / MIXED / WEAK / POOR / TOXIC)
- Discipline analysis (Flat, Flat AW, Jumps NH)
- Venue analysis with ratings
- Individual bet breakdown (WIN/LOSS only — VOID excluded)
- Cumulative performance by day and by band
- Key findings and recommendations
- Auto-emailed to configured recipients after generation
- Manual email send per report
- Save as Google Doc to Drive

---

## Settings

### Report Recipients
Add/remove email addresses that receive automatic copies of AI-generated reports. Stored server-side and persist across sessions.

### AI Data Sources

| Key | Description |
|-----|-------------|
| `session_data` | Current and historical session records |
| `settled_bets` | Race results with P/L from Betfair |
| `historical_summary` | Aggregated statistics and cumulative performance |
| `engine_state` | Current engine configuration and status |
| `rule_definitions` | The 4-rule strategy with spread control parameters |
| `backtest_results` | Historical backtesting analysis data |
| `github_codebase` | Access to the app's source code repository |

### AI Capabilities

| Key | Description |
|-----|-------------|
| `send_emails` | Dispatch reports to configured recipients |
| `write_reports` | Generate structured daily performance reports |
| `fetch_files` | Access external files and data sources |
| `github_access` | Read and analyse the application codebase |

### Theme
Choose between three visual themes: **Classic** (original), **Dark Glass** (glassmorphism with dark hero image), **Light Glass** (glassmorphism with light hero image).

---

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

---

## Deployment

### Backend — Google Cloud Run

Both Cloud Run (backend) and Cloudflare Pages (frontend) **auto-deploy on push to `main`**. Never redeploy manually.

```bash
# Manual deploy (FSUs only — lay-engine auto-deploys via GitHub)
gcloud run deploy lay-engine \
  --image gcr.io/chimera-v4/chimera-lay-engine \
  --region europe-west2 \
  --platform managed \
  --set-env-vars "BETFAIR_APP_KEY=<key>,FRONTEND_URL=https://layengine.thync.online,DRY_RUN=true,ANTHROPIC_API_KEY=<key>,OPENAI_API_KEY=<key>,SENDGRID_API_KEY=<key>,GCS_BUCKET=<bucket>" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --allow-unauthenticated
```

### Cold-Start Prevention

```bash
gcloud scheduler jobs create http chimera-keepalive \
  --schedule="*/5 6-22 * * 1-6" \
  --uri="https://lay-engine-950990732577.europe-west2.run.app/api/keepalive" \
  --http-method=GET \
  --time-zone="Europe/London"
```

### Frontend — Cloudflare Pages

1. Push to GitHub (`main`) — auto-deploys
2. Build command: `npm run build`
3. Build output: `dist`
4. Root directory: `frontend`
5. Environment variable: `VITE_API_URL=https://lay-engine-950990732577.europe-west2.run.app`
6. Custom domain: `layengine.thync.online`

---

## Environment Variables

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `BETFAIR_APP_KEY` | Cloud Run | — | Betfair API application key |
| `FRONTEND_URL` | Cloud Run | `https://layengine.thync.online` | CORS allowed origin |
| `DRY_RUN` | Cloud Run | `true` | Skip real bet placement on startup |
| `POLL_INTERVAL` | Cloud Run | `30` | Seconds between market scans |
| `STATE_FILE` | Cloud Run | `/tmp/chimera_engine_state.json` | Local state file path |
| `SESSIONS_FILE` | Cloud Run | `/tmp/chimera_sessions.json` | Session history file path |
| `GCS_BUCKET` | Cloud Run | — | GCS bucket for persistent state |
| `ANTHROPIC_API_KEY` | Cloud Run | — | Claude Sonnet API key for AI reports/chat |
| `OPENAI_API_KEY` | Cloud Run | — | OpenAI API key for Whisper STT + TTS |
| `SENDGRID_API_KEY` | Cloud Run | — | SendGrid key for report email dispatch |
| `EMAIL_FROM` | Cloud Run | `chimera@thync.online` | Sender email address |
| `EMAIL_FROM_NAME` | Cloud Run | `CHIMERA Lay Engine` | Sender display name |
| `FSU_URL` | Cloud Run | — | FSU1 base URL for historic data replay |
| `GEMINI_API_KEY` | Cloud Run (FSU2) | — | Gemini 2.5 Flash key for video intelligence |
| `VITE_API_URL` | Cloudflare Pages | — | Backend API URL for frontend build |

---

## Going Live

1. Set `DRY_RUN=false` in Cloud Run environment variables, **or**
2. Toggle via the **Dry Run ON** button in the dashboard (Live tab)

---

## Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| Google Sheets export 403 PERMISSION_DENIED | Open — SA lacks Sheets API permission | Use local XLS download button |

---

## Tagged Versions

| Tag | Version | Description |
|-----|---------|-------------|
| `v1.0-reports` | 1.0 | Stable release with Anthropic Claude-based AI agent |
| `v5.0.0` | 5.0.0 | Current — unified version across all services, dark glass UI, full FSU platform |
