# CHIMERA Platform — Service Architecture

**Version:** 5.0.0 | **Date:** 11 March 2026 | **Owner:** Cape Berkshire Ltd

## Platform Overview

CHIMERA is a modular horse racing lay betting platform built on Google Cloud Run. It consists of independent Fractional Services Units (FSUs) that each handle a specific concern, orchestrated by the Lay Engine.

```
┌─────────────────────────────────────────────────────────────┐
│                    CHIMERA PLATFORM v5.0                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│   │  LAY ENGINE   │    │    FSU1      │    │    FSU3      │ │
│   │  (Orchestrator)│◄──►│  Data Replay │◄──►│  Backtest   │ │
│   │              │    │              │    │              │ │
│   │  Live/Dry Run │    │  GCS → API   │    │  Rules + P&L │ │
│   │  Rules Engine │    │  Historic    │    │  Settlement  │ │
│   │  AI Reports  │    │  Market Data │    │              │ │
│   │  Dashboard   │    │              │    │              │ │
│   └──────┬───────┘    └──────────────┘    └──────────────┘ │
│          │                                                  │
│   ┌──────┴───────┐    ┌──────────────┐                     │
│   │  FSU2        │    │  Frontend    │                     │
│   │  Video Intel │    │  (Cloudflare)│                     │
│   │              │    │              │                     │
│   │  YouTube →   │    │  React SPA   │                     │
│   │  Gemini AI   │    │  Dashboard   │                     │
│   └──────────────┘    └──────────────┘                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Services

### Lay Engine (Orchestrator)

The central service. Runs live and dry-run betting sessions, hosts the rules engine, manages AI reports, and serves the API for the React dashboard.

| Property | Value |
|----------|-------|
| **Version** | 5.0.0 |
| **Cloud Run** | `lay-engine` (europe-west2) |
| **GitHub** | `charles-ascot/lay-engine` |
| **Frontend** | `layengine.thync.online` (Cloudflare Pages) |
| **Framework** | FastAPI (Python) + React (Vite) |
| **AI Agent** | Anthropic Claude Sonnet 4.6 |

**Responsibilities:**
- Live betting: scan markets, apply rules, place bets via Betfair API
- Dry run: simulate betting with real market data, no real money
- Rules engine: 4-rule lay strategy + JOFS + Mark Rules + Spread Control
- AI reports: generate analysis via Claude, email via SendGrid
- Dashboard: React SPA with Live, Dry Run, Backtest, Strategy, History, Settings tabs
- State persistence: GCS + local disk dual-write

---

### FSU1 — Data Replay Service

Reads historic Betfair Advanced data from GCS and serves it through an API that mirrors the live Betfair Exchange contract.

| Property | Value |
|----------|-------|
| **Version** | 5.0.0 |
| **Cloud Run** | `fsu1` (europe-west1) |
| **GitHub** | `charles-ascot/fsu1` |
| **GCS Bucket** | `betfair-historic-adv` (us-east1) |
| **Data Format** | Betfair Advanced `.bz2` compressed streams |

**Key Capabilities:**
- Market discovery by date, country, and market type
- Price reconstruction at any historic timestamp
- Full market book with 3-level depth
- Timeline endpoint for replay loops
- LRU cache with prefetch for performance

**API:** `/api/health`, `/api/dates`, `/api/markets`, `/api/markets/{id}/prices`, `/api/markets/{id}/book`, `/api/markets/{id}/timeline`, `/api/cache`

---

### FSU2 — Video Intelligence Service

Receives YouTube URLs, processes them through Gemini 2.5 Flash (Vertex AI), and persists structured intelligence (summaries, transcripts, topics, entities, sentiment) to Google Cloud Storage.

| Property | Value |
|----------|-------|
| **Version** | 5.0.0 |
| **Cloud Run** | `fsu2` (europe-west1) |
| **GitHub** | `charles-ascot/fsu2` |
| **Framework** | Node.js (Express) |
| **AI Model** | Google Gemini 2.5 Flash (Vertex AI) |
| **GCS Bucket** | `chimera-video-summaries` |
| **Auth** | API key (`FSU_API_KEY`) |

**Key Capabilities:**
- YouTube video processing via Gemini AI
- Structured content extraction: summary, transcript, key topics, entities, sentiment
- Persistent storage to GCS (`processed/YYYY/MM/DD/{jobId}.json`)
- Deep health checks (GCS + Gemini connectivity)
- Rate limiting and API key authentication

**API:** `/health`, `/health/deep`, `POST /process`, `GET /process/validate`

---

### FSU3 — Backtest Service

Standalone backtest engine. Connects to FSU1 for historic data, runs the full rules engine against each market, and computes P&L with settlement.

| Property | Value |
|----------|-------|
| **Version** | 5.0.0 |
| **Cloud Run** | `fsu3` (europe-west2) |
| **GitHub** | `charles-ascot/fsu3` |

**Key Capabilities:**
- Full-day backtests with configurable parameters
- Complete rules engine (identical to Lay Engine)
- Spread control validation
- Point value multiplier
- Adjustable uplift stake (2.5–3.5 band)
- Per-market P&L with win/loss settlement

**API:** `/api/health`, `/api/dates`, `/api/markets`, `/api/backtest/run`, `/api/rules`

---

## Service Communication

```
Frontend (Cloudflare Pages)
    │ HTTPS
    ▼
Lay Engine (Cloud Run)
    │ OIDC identity token
    ├──► FSU1 (historic data)
    ├──► Betfair Exchange API (live betting)
    ├──► Anthropic API (AI reports)
    ├──► SendGrid API (email)
    └──► Google Drive/Sheets API (exports)

FSU2 (Cloud Run)
    │ API key auth
    ├──► Gemini 2.5 Flash (Vertex AI)
    └──► GCS bucket (video summaries)

FSU3 (Cloud Run)
    │ OIDC identity token
    └──► FSU1 (historic data)
```

All Cloud Run → Cloud Run communication uses GCP OIDC identity tokens fetched from the metadata server. The default Compute Engine service account (`950990732577-compute@developer.gserviceaccount.com`) is shared across all services in `chimera-v4`.

## IAM Requirements

| Service | Needs Access To | Role |
|---------|----------------|------|
| Lay Engine | FSU1 | `roles/run.invoker` |
| FSU3 | FSU1 | `roles/run.invoker` |
| FSU1 | GCS bucket | `roles/storage.objectViewer` |
| FSU2 | Vertex AI | `roles/aiplatform.user` |
| FSU2 | GCS bucket (video summaries) | `roles/storage.objectCreator` + `roles/storage.objectViewer` |
| Lay Engine | Google Drive (Shared) | Service account as Contributor on Shared Drive |

## Deployment

All services auto-deploy when code is pushed to their respective GitHub repos:
- **Lay Engine:** Push to `charles-ascot/lay-engine` → Cloud Build → Cloud Run
- **Frontend:** Push to `charles-ascot/lay-engine` → Cloudflare Pages auto-build
- **FSU1:** `gcloud run deploy fsu1 --source . --region=europe-west1 --project=chimera-v4` (from `charles-ascot/fsu1` repo)
- **FSU2:** `gcloud run deploy fsu2 --source . --region=europe-west1 --project=chimera-v4` (from `charles-ascot/fsu2` repo)
- **FSU3:** `gcloud run deploy fsu3 --source . --region=europe-west2 --project=chimera-v4`

## Future: Strategy FSU

The next planned unit will handle strategy/signal generation as an independent service, enabling the platform to be assembled as:

```
FSU1 (Data) → FSU3 (Backtest) → Strategy FSU (Signals) → Lay Engine (Execution)
```

With a unified control panel to configure and monitor all units as one machine.
