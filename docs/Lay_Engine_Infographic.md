# CHIMERA Lay Engine — Internal Architecture & Workflows

**Version:** 5.3.x | **Date:** 20 March 2026 | **Owner:** Cape Berkshire Ltd

---

## What the Lay Engine Is

The Lay Engine is the central orchestrator of the CHIMERA platform. It is a single Cloud Run service (FastAPI + Python) that does everything: runs the live betting loop, hosts the rules engine, manages sessions and state, coordinates backtesting with FSU1, generates AI reports, and serves the React dashboard via 60+ REST API endpoints.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LAY ENGINE (Cloud Run)                        │
│                         europe-west2                                 │
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │  FastAPI App  │   │ Lay Engine   │   │      State Layer          │ │
│  │  (main.py)   │◄──┤  (engine.py) │◄──┤  /tmp/*.json (local)     │ │
│  │              │   │              │   │  gs://chimera-v4/ (GCS)  │ │
│  │  60+ endpoints│   │  Background  │   │  Dual-write on every     │ │
│  │  REST API    │   │  thread loop │   │  state change            │ │
│  └──────┬───────┘   └──────┬───────┘   └──────────────────────────┘ │
│         │                  │                                          │
│  ┌──────┴───────────────────┴───────────────────────────────────────┐│
│  │                     Core Logic Layer                             ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐ ││
│  │  │ rules.py │  │betfair_  │  │ kelly.py │  │ ai_backtest_    │ ││
│  │  │ 4 rules  │  │client.py │  │ Stake    │  │ agent.py /      │ ││
│  │  │ + guards │  │ Exchange │  │ sizing   │  │ ai_odds_agent   │ ││
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────────────┘ ││
│  └───────────────────────────────────────────────────────────────── ┘│
└─────────────────────────────────────────────────────────────────────┘
            │                            │
            ▼                            ▼
   External: Betfair API         Internal: FSU1 (backtest)
   External: Anthropic API       External: SendGrid (email)
   External: OpenAI API          External: Google Drive
```

---

## Workflows

### 1. Live Betting Workflow

The main operational workflow. Runs as a background thread when the engine is started.

```
User: POST /api/login
      └─► BetfairClient.login()
          └─► Betfair Exchange: username + password → session token (4hr TTY)
              └─► Session token stored in memory + kept alive every 30 min

User: POST /api/engine/start
      └─► LayEngine.run() spawns background thread

┌─────────────────────────────────────────────────────┐
│                   MAIN LOOP (every 30s)              │
│                                                      │
│  1. BetfairClient.get_todays_win_markets(countries)  │
│     └─► Betfair listMarketCatalogue → WIN markets    │
│         (GB, IE, ZA, FR — as configured)             │
│                                                      │
│  2. For each market NOT already processed:           │
│     └─► Check if within process_window (e.g. 12 min) │
│         └─► BetfairClient.get_market_prices(id)      │
│             └─► Betfair listMarketBook → live prices  │
│                 └─► apply_rules(runners, config)      │
│                     └─► 0..N LayInstructions          │
│                                                      │
│  3. For each LayInstruction:                         │
│     ├─► dry_run=True:  log only, no bet placed       │
│     └─► dry_run=False: BetfairClient.place_lay_order │
│         └─► Betfair placeOrders → confirms bet       │
│                                                      │
│  4. Save state to /tmp + GCS                         │
│  5. Sleep POLL_INTERVAL (30s), repeat                │
└─────────────────────────────────────────────────────┘

User: GET /api/state (polls every 2s)
      └─► Returns current markets, bets, balance, config
          └─► React dashboard updates in real time
```

---

### 2. Dry Run Workflow

Identical to Live, but `dry_run=True`. All rule evaluations are logged as results with simulated P&L. No orders are sent to Betfair. Real market prices are used — only the order placement step is skipped.

```
POST /api/engine/dry-run {enabled: true}
     └─► engine.dry_run = True

Engine loop runs normally:
     └─► apply_rules() → LayInstructions
         └─► Results logged with hypothetical P&L
             (no placeOrders call to Betfair)

User: POST /api/engine/snapshot
      └─► Point-in-time dry-run snapshot saved to GCS
          └─► Viewable in Reports → Dry Run Archive tab
```

---

### 3. Backtest Workflow

Uses FSU1 (historic market data) instead of live Betfair. Runs asynchronously as a background job.

```
User selects: date, rule config, AI agents → POST /api/backtest/run

Backend spawns async job thread:

┌──────────────────────────────────────────────────────────────┐
│                    BACKTEST JOB                               │
│                                                              │
│  1. FSUClient.login()                                        │
│     └─► Fetch GCP OIDC token → authenticate to FSU1         │
│                                                              │
│  2. FSUClient.get_todays_win_markets(date, countries)        │
│     └─► FSU1: reads GCS historic blobs for that date        │
│         └─► Returns market list                              │
│                                                              │
│  3. For each market:                                         │
│     └─► Set virtual_time = race_start - process_window       │
│         └─► FSUClient.get_market_prices(id, virtual_time)    │
│             └─► FSU1: reconstructs prices at that timestamp  │
│                 └─► apply_rules(runners, config)             │
│                     └─► LayInstructions                      │
│                                                              │
│  4. (Optional) AI Agents:                                    │
│     ├─► BacktestAIAgent: web search (DuckDuckGo) + Claude   │
│     │   └─► CONFIRM / OVERRULE / ADJUST each lay            │
│     └─► OddsMovementAgent: odds drift analysis from FSU1    │
│         └─► SHORTENING / DRIFTING / STEAM signal            │
│                                                              │
│  5. Simulate settlement:                                     │
│     └─► If horse wins: loss = size × (price − 1)            │
│         If horse loses: profit = size                        │
│                                                              │
│  6. Return results: bets, P&L, rules fired, AI decisions    │
└──────────────────────────────────────────────────────────────┘

Frontend polls GET /api/backtest/job/{id} every 3s
→ Status: RUNNING → COMPLETED
→ Results table rendered in Backtest tab
→ Download XLS or Export to Google Sheets
```

---

### 4. AI Report Workflow

```
User: POST /api/reports/generate {date}

Claude Sonnet 4.6 receives:
  - All sessions for that date
  - All bets placed
  - Rule evaluation results
  - Settled P&L (if available)
  - Configured AI data source toggles

Claude generates structured report:
  - Summary paragraph
  - Rule performance breakdown
  - Bet-by-bet commentary
  - P&L analysis
  - Recommendations

Report saved to:
  ├─► /tmp/chimera_reports.json (local)
  ├─► gs://chimera-v4/chimera_reports.json (GCS)
  └─► (optional) Google Drive as Google Doc

If recipients configured:
  └─► SendGrid: email delivered to each recipient

Viewable in Reports tab, re-sendable at any time.
```

---

### 5. AI Chat Workflow

```
User: types or speaks into AI Chat tab

(Optional) Voice input:
  └─► POST /api/audio/transcribe (audio blob)
      └─► OpenAI Whisper → transcript text

POST /api/chat {message, date (optional)}
  └─► Claude Sonnet 4.6 with system context:
      - Engine state
      - Sessions for date (if scoped)
      - Bets placed
      - Rule definitions
      - Settled P&L

Claude responds → displayed in chat bubble

(Optional) Voice output:
  └─► POST /api/audio/speak {text}
      └─► OpenAI TTS (nova voice) → audio playback
```

---

### 6. State Persistence & Recovery Workflow

```
On every state change:
  └─► _save_state()
      ├─► Write to /tmp/chimera_*.json (fast, local)
      └─► Write to gs://chimera-v4/chimera_*.json (durable)

On Cloud Run cold start:
  └─► LayEngine.__init__() → _load_state()
      ├─► Try GCS first (authoritative)
      └─► Fall back to /tmp (if GCS unavailable)
          └─► Restore: markets, bets, sessions, config, API keys

If last session was RUNNING at crash:
  └─► Mark session status = CRASHED
      └─► Visible in History tab

Cloud Scheduler (every 5 min, 6am–10pm Mon–Sat):
  └─► GET /api/keepalive → prevents cold start during racing hours
```

---

### 7. Betfair Session Keepalive Workflow

```
On login:
  └─► BetfairClient stores session_token + expiry (now + 4h)

Background keepalive (every 30 min):
  └─► If expiry < now + 30 min:
      └─► POST to Betfair keepalive endpoint
          └─► Refreshes token expiry

On network error during any Betfair call:
  └─► Retry with exponential backoff (up to 3 attempts)
      └─► If all fail: log error, skip market, continue loop
```

---

## Components

### Backend Components

| Component | File | Role |
|-----------|------|------|
| **FastAPI App** | `backend/main.py` | Entry point. Mounts all 60+ endpoints, configures CORS, starts background engine thread, handles auth middleware. |
| **Lay Engine** | `backend/engine.py` | Core orchestrator class. Owns the main betting loop, session lifecycle, state persistence, and all in-memory data models. |
| **Rules Engine** | `backend/rules.py` | The 4-rule lay strategy. Pure function: takes runner prices and config, returns zero or more `LayInstruction` objects. No side effects. |
| **Betfair Client** | `backend/betfair_client.py` | Wrapper for Betfair Exchange JSON-RPC API. Handles login, session keepalive, market discovery, price retrieval, and order placement. |
| **FSU Client** | `backend/fsu_client.py` | Drop-in mirror of `BetfairClient` for backtest mode. Fetches data from FSU1 instead of live Betfair. Supports virtual time control. |
| **Kelly Criterion** | `backend/kelly.py` | Optional stake sizing module. Calculates optimal fractional Kelly stake for each lay instruction based on bankroll, edge %, and odds. |
| **AI Backtest Agent** | `backend/ai_backtest_agent.py` | Claude-powered research agent for backtest. Runs DuckDuckGo web searches per runner (capped at backtest date), then asks Claude to CONFIRM, OVERRULE, or ADJUST each lay. |
| **AI Odds Agent** | `backend/ai_odds_agent.py` | Odds movement analyst for backtest. Samples FSU1 price timeline at configurable intervals and classifies each runner as SHORTENING, DRIFTING, or STEAM. No web calls needed. |

---

### Rules Engine Detail

| Rule | Trigger | Default Stake | JOFS Variant (gap ≤ 0.2) |
|------|---------|---------------|--------------------------|
| **Rule 1** | Favourite odds < 2.0 | 3 pts on fav | 1.5 pts fav + 1.5 pts 2nd fav |
| **Rule 2** | Favourite odds 2.0–5.0 | 2 pts on fav | 1 pt fav + 1 pt 2nd fav |
| **Rule 3A** | Favourite > 5.0, gap < 2.0 | 1 pt fav + 1 pt 2nd fav | Same (labelled RULE_3_JOINT) |
| **Rule 3B** | Favourite > 5.0, gap ≥ 2.0 | 1 pt on fav only | N/A |

**Guards (evaluated before any rule fires)**

| Guard | Condition | Effect |
|-------|-----------|--------|
| No runners | No active runners with lay prices | Skip market |
| Illiquid | Favourite odds > 50.0 | Skip market |
| Not pre-off | Market is IN_PLAY or CLOSED | Skip market |
| Duplicate | (runner_name, race_time) seen before | Skip |
| Mark Ceiling | Odds > 8.0 (if enabled) | Skip |
| Mark Floor | Odds < 1.5 (if enabled) | Skip |
| Spread Control | Lay−back spread exceeds band threshold | Skip |
| Mark Uplift | 2.5 ≤ odds ≤ 3.5 (if enabled) | Boost stake to uplift amount |

**Spread Control Thresholds**

| Odds Band | Max Spread |
|-----------|-----------|
| 1.0 – 2.0 | 0.05 |
| 2.0 – 3.0 | 0.15 |
| 3.0 – 5.0 | 0.30 |
| 5.0 – 8.0 | 0.50 |
| 8.0+ | Reject always |

---

### State & Data Models

| Model | Where stored | What it holds |
|-------|-------------|---------------|
| **Engine State** | memory + GCS | markets, results, bets_placed, processed sets, config flags |
| **Sessions** | memory + GCS | list of all LIVE/DRY_RUN sessions with start/stop/status/bets |
| **Snapshots** | memory + GCS | dry-run point-in-time captures with archived flag |
| **Reports** | memory + GCS | AI-generated daily reports (JSON + plain text) |
| **API Keys** | memory + GCS | generated keys with hashed secret, active/revoked |
| **Settings** | memory + GCS | email recipients, AI data source toggles, AI capability toggles |
| **Stats Cache** | memory + GCS | pre-computed daily P&L totals (avoids reprocessing) |

All files written to `/tmp/chimera_*.json` locally and `gs://chimera-v4/chimera_*.json` in GCS simultaneously. On cold start GCS is read first.

---

### API Endpoint Groups

| Group | Count | Purpose |
|-------|-------|---------|
| **Auth & Health** | 4 | Betfair login/logout, health check, keepalive ping |
| **Engine Controls** | 14 | Start/stop, dry-run, countries, process window, point value, all rule toggles |
| **State & Rules** | 2 | Full engine state, active rule definitions |
| **Market Data** | 3 | Discovered markets, 3-level book, odds drift snapshots |
| **Dry Run Snapshots** | 4 | Create, list, view, archive point-in-time snapshots |
| **Sessions** | 2 | List all sessions, get session detail |
| **Matched & Settled** | 3 | Live Betfair bets, cleared P&L, data registry |
| **AI Analysis** | 4 | Session analysis, interactive chat, speech-to-text, text-to-speech |
| **Reports** | 6 | Generate, list, view, delete, email, save to Drive |
| **Settings** | 3 | Recipients, AI data sources, AI capabilities |
| **API Keys** | 3 | Generate, list, revoke |
| **Data API** | 7 | External-facing authenticated data endpoints (X-API-Key) |
| **Backtest** | 4 | Available dates, market list, run job, poll job status |

---

### Frontend Components (React)

| Tab | Purpose |
|-----|---------|
| **Live** | Start/stop engine, real-time market book, active bets, account balance |
| **Dry Run** | Paper-trade view with instant snapshot tool, markets by status |
| **Backtest** | Date + rule config, AI agent toggles, run job, results table, XLS download |
| **Strategy** | Static documentation of the 4 rules, spread thresholds, mark rules |
| **History** | Sessions list, matched bets (date range), settled bets with P&L + charts |
| **Bet Settings** | All runtime config: process window, point value, countries, rule toggles, Kelly |
| **Settings** | Email recipients, AI toggles (data sources + capabilities), theme selector |
| **Reports** | AI reports list, dry-run archive, data registry (GCS + local paths by month) |
| **AI Chat** | Conversational interface, optional date scope, voice in + out |

---

### External Integrations

| Integration | Auth | Used For |
|-------------|------|----------|
| **Betfair Exchange API** | Username + password → session token | Market discovery, price data, order placement |
| **FSU1 (Cloud Run)** | GCP OIDC identity token | Historic market data for backtesting |
| **Anthropic Claude Sonnet 4.6** | API key | AI reports, chat, backtest research agent |
| **OpenAI Whisper** | API key | Speech-to-text in AI chat |
| **OpenAI TTS (nova)** | API key | Text-to-speech in AI chat |
| **DuckDuckGo Search** | None (public) | Web search in AI backtest research agent |
| **SendGrid** | API key | Email delivery of generated reports |
| **Google Drive** | Service account | Save reports as Google Docs |
| **Google Sheets** | Service account | Export backtest results (has known 403 issue) |
| **GCS (`chimera-v4`)** | Service account | Durable state persistence across cold starts |
| **Cloud Scheduler** | IAM | Keepalive pings every 5 min during racing hours |

---

### Configuration Parameters (Runtime-Adjustable)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `dry_run` | true | bool | Skip real bet placement |
| `countries` | GB, IE | list | Markets to scan |
| `point_value` | varies | £0.50–£100 | Stake multiplier |
| `process_window` | 12 min | 0.05–60 min | How early before off to bet |
| `spread_control` | true | bool | Reject bets with wide spreads |
| `jofs_control` | true | bool | Joint/close-odds filter |
| `mark_ceiling_enabled` | true | bool | Reject odds > 8.0 |
| `mark_floor_enabled` | true | bool | Reject odds < 1.5 |
| `mark_uplift_enabled` | true | bool | Boost stakes in 2.5–3.5 band |
| `mark_uplift_stake` | 3 pts | 2–10 pts | Uplift boost amount |
| `kelly.enabled` | false | bool | Use Kelly Criterion for sizing |
| `kelly.fraction` | 0.25 | 0.25–1.0 | Fractional Kelly multiplier |
| `kelly.bankroll` | 1000 | £ | Total bankroll for Kelly calc |
| `kelly.edge_pct` | 5.0 | % | Assumed edge over market |
| `kelly.min_stake` | 0.50 | £ | Kelly stake floor |
| `kelly.max_stake` | 50.0 | £ | Kelly stake ceiling |

---

## Deployment & Operations

```
┌────────────────────────────────────────────────────────────┐
│                     DEPLOYMENT PIPELINE                     │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Push to main branch                                       │
│       │                                                    │
│       ├──► GitHub Actions                                  │
│       │    └─► docker build → push to GCR                 │
│       │        └─► gcloud run deploy lay-engine            │
│       │            └─► Cloud Run auto-updates              │
│       │                                                    │
│       └──► Cloudflare Pages                                │
│            └─► npm run build (Vite)                        │
│                └─► Deploy to layengine.thync.online        │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                     CLOUD RUN CONFIG                        │
│                                                            │
│  Region:       europe-west2                                │
│  Min instances: 0  (scales to zero when idle)              │
│  Max instances: 1  (single process; concurrency-safe)      │
│  Memory:        512 MB                                     │
│  Request timeout: 60s (backtest jobs run async)            │
│  Auth:          Public (frontend on Cloudflare)            │
│                                                            │
│  Keepalive: Cloud Scheduler pings /api/keepalive           │
│             every 5 min, 6am–10pm, Mon–Sat (Europe/London) │
└────────────────────────────────────────────────────────────┘
```

---

*This document covers the Lay Engine internals only. For platform-wide architecture including FSU1, FSU2, FSU3 and their inter-service communication, see `CHIMERA_Platform_Architecture.md`.*
