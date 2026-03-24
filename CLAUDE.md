# CHIMERA Lay Engine — Project Guide

## Architecture

**Lay Engine** (this repo) is a monolithic FastAPI + React app that orchestrates lay betting on horse racing favourites.

- Backend: `backend/main.py` (~3200+ lines), `backend/engine.py`
- Frontend: `frontend/src/App.jsx` (~5700+ lines)
- Auto-deploys: backend → Cloud Run (`lay-engine`, europe-west2), frontend → Cloudflare Pages (`layengine.thync.online`)
- NEVER tell the user to redeploy manually — pushes to main trigger auto-deploy.

## FSU Numbering (always be specific — never say "FSU" generically)

| FSU  | Name               | Location       | Repo / Service                  |
|------|--------------------|----------------|---------------------------------|
| FSU1 | Data Replay        | europe-west1   | `charles-ascot/fsu1`            |
| FSU2 | Video Intelligence | europe-west1   | `charles-ascot/fsu2`            |
| FSU3 | Backtest Service   | europe-west2   | `charles-ascot/fsu3`            |
| FSU9 | Strategy Sandbox   | (in monolith)  | `backend/strategy_sandbox.py`   |

FSU9 is currently embedded in the monolith but built FSU-ready (HTTP endpoint callers, isolated namespace). Migration to a standalone Cloud Run service later = only base URL changes.

## GCS Data Tiers (critical — never approximate)

Bucket: `betfair-historic-adv`

- **ADVANCED** (pre-2026): full price ladder — `batb` / `batl` fields present. Use for backtesting.
- **BASIC** (2026+): last-traded-price only — no `batb` / `batl`. Backtests correctly SKIP these dates.

**NEVER** use `ltp` as a proxy for lay price in backtests. Mark bets with real money. If ADVANCED data is needed for 2026 dates, the user must upload it to GCS.

## Git Workflow

Commit directly to `main` and push. No feature branches, no PRs (unless explicitly asked).
Always quote the repo path in bash: `"/Users/charles/Projects/chimera-lay-engine 2"` (space before 2).

## GCS Persistence Pattern

Engine state (sessions, settings, reports, sandbox) is saved to GCS using `_gcs_write` / `_gcs_read` in `engine.py`. The sandbox follows the same pattern:

- File: `chimera_sandbox_state.json`
- Functions: `persist_sandbox()` / `restore_sandbox()` in `backend/strategy_sandbox.py`
- `restore_sandbox(_sandbox)` is called at startup in `main.py`
- `persist_sandbox(_sandbox)` must be called after **every** sandbox mutation endpoint

## AI Chat Agent (in-app Claude)

- Endpoint: `POST /api/chat`
- Multi-turn tool-use loop (max 10 iterations, max_tokens=4096)
- 11 tools: FSU1 data access (`list_available_dates`, `list_markets_for_date`) + backtest control (`run_backtest`, `get_backtest_job`) + sandbox CRUD
- Chat history persisted to `localStorage` key `chimera-chat-history` (capped at 50 messages)

## Backtest Pipeline Order

`SHORT_PRICE_CONTROL → rules → JOFS → signal filters → MOM → sandbox (FSU9) → AI agents → stake sizing`

## Known Issues

- Google Sheets export: SA lacks Sheets API permission → 403. Workaround: local XLS download button.
- Backtest SKIPPED for 2026 dates: expected behaviour (BASIC data, no order book). Not a bug.

## Pricing / Money Rules

- Never use approximate values for prices, stakes, or P/L — this is real money.
- If an exact solution doesn't exist, check with Charles before implementing anything.
- Minimum lay stake enforced at £2.00 after multiplier application.
