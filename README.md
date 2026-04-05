# CHIMERA Lay Engine

Automated lay betting engine for Betfair horse racing. Discovers WIN markets, identifies favourites, applies a fixed rule set, and places lay bets — all running unattended on Google Cloud Run with a React dashboard on Cloudflare Pages.

**Current version: v5.0.0**
**Last updated: 2026-04-05**

---

## Overview

CHIMERA scans Betfair Exchange for horse racing WIN markets across configurable countries (GB, IE, ZA, FR), fetches live prices, identifies the favourite and second favourite, then applies one of four stake rules based on the favourite's odds and the gap to the second favourite. Bets are placed automatically before the off. A full dry-run mode lets you watch the engine work with real market data without risking real money. A historic backtest mode replays any past date via FSU1 with full rule, signal, and AI agent overlays.

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
- **JOFS Control** — Close-odds split filter: splits stake across joint favourites when gap ≤ 0.2 (toggleable)
- **Mark Rules** — Ceiling (no lays above 8.0), Floor (no lays below 1.5), and Uplift (configurable boosted stake 1–20 pts in the 2.5–3.5 band) — each independently toggleable
- **Kelly Criterion** — Optional Kelly-fraction stake sizing with bankroll, edge %, min/max stake controls
- **Signal Filters** — Four independently switchable market intelligence signals that sit between rule evaluation and execution (see Signal Filters section below)
- **TOP2_CONCENTRATION** — Market-structure protection layer that identifies two-horse race dynamics and suppresses or blocks lay bets when the top two runners dominate the win market — independently toggleable in both Backtest and Live modes (see TOP2_CONCENTRATION section below)
- **Process Window** — Configurable minutes-before-off window (0.05–60 min) within which the engine will consider placing a bet
- **Dry run mode** — Fetches real markets and prices, logs everything, skips actual bet placement
- **Dry run snapshots** — Instant point-in-time dry-run snapshots for selected markets; archived to GCS
- **Country selection** — Toggle GB, IE, ZA, FR markets from the dashboard
- **Live market view** — Betfair-style 3-level back/lay price grid with auto-refresh
- **Matched bets** — View all live bets placed on Betfair with date range filtering
- **Settled bets** — Race results with actual P/L from Betfair cleared orders
- **Session tracking** — Every engine run is a session with full bet/result history
- **Data Registry** — Full inventory of all data records (sessions, snapshots, reports) with storage locations
- **AI reports** — Structured daily performance reports with odds band analysis, venue analysis, cumulative performance, and recommendations; generated via Claude streaming
- **AI Research Agent** — Web-searches for runner intelligence pre-race and may overrule or adjust individual bets (backtest only)
- **AI Odds Movement Agent** — Samples historical price series at configurable intervals, analyses drift/steam, and may overrule or adjust bets (backtest only; no internet required)
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

**JOFS (Joint/Close Favourite Split) — applied to Rules 1 & 2:**
When the gap between 1st and 2nd favourite is ≤ 0.2, the market is treated as a joint-favourite race and the full stake is split evenly across both runners.

**Guards applied before rule evaluation:**
- Markets with favourite odds > 50.0 are skipped (illiquid/bogus)
- In-play markets are skipped (pre-off only)
- Duplicate bets on the same runner/race are prevented
- **Spread Control** (optional) — rejects bets where back-lay spread exceeds odds-based thresholds
- **Mark Ceiling** (optional) — rejects any lay where odds > 8.0
- **Mark Floor** (optional) — rejects any lay where odds < 1.5
- **Mark Uplift** (optional) — applies a configurable uplift stake (1–20 pts) to bets in the 2.5–3.5 odds band

### Spread Control Thresholds

| Odds Range | Max Spread | Action |
|-----------|-----------|--------|
| 1.0 – 2.0 | 0.05 | Allow if within |
| 2.0 – 3.0 | 0.15 | Allow if within |
| 3.0 – 5.0 | 0.30 | Allow if within |
| 5.0 – 8.0 | 0.50 | Allow if within |
| 8.0+ | — | REJECT (too volatile) |

---

## Signal Filters (Market Intelligence Layer)

Signal filters are a post-rules, pre-execution layer derived from the dickreuter methodology analysis (Day 33 post-mortem, 2026-03-19). They sit between rule evaluation and bet placement — they never modify the rules themselves, only adjust stakes or block individual bets. All signals are **OFF by default** and independently switchable in both Live and Backtest modes.

Module: `backend/signal_filters.py`

### Signal 1 — Market Overround

Computes the market book percentage (sum of implied win probabilities from all runners' back prices). A high overround indicates an illiquid or unreliable market where the favourite's price is less trustworthy.

| Book % | Action |
|--------|--------|
| > 120% (hard threshold) | SKIP — market too illiquid |
| > 115% (soft threshold) | HALVE stake |
| ≤ 115% | No action |

### Signal 2 — Field Size

Large NH fields at mid-to-high odds significantly increase variance. A 3.10 favourite in a 14-runner novice hurdle is a very different proposition to the same price in a 6-runner conditions chase.

**Trigger:** Active runners > 10 AND favourite odds ≥ 3.0 → cap stake at £10.

### Signal 3 — Steam Gate

Detects favourites that are being backed heavily into the race. Laying into a steaming horse is betting against the live information flow.

**Live:** Uses the engine's in-memory monitoring snapshots (price at first poll vs current price).
**Backtest:** Samples FSU1 prices at `target_iso − 15 minutes` (8-second timeout; skipped gracefully if FSU is slow), comparing to prices at evaluation time.

**Trigger:** Favourite price has shortened ≥ 3% since the earlier snapshot AND odds ≥ 3.0 → SKIP.

### Signal 4 — Rolling Band Performance

Tracks the 5-day win rate per odds band across all settled sessions. When a band has been losing consistently, stakes are automatically reduced rather than betting full size into a deteriorating band.

**Data source:** Reads from both `self.bets_placed` (today) and `self.sessions` (historical) to populate the full lookback window from day one.

**Trigger:** 5-day win rate in band < 50% AND minimum 10 bets in sample → cap stake at £10.

### Signal Priority (when multiple signals fire)

1. Any **SKIP** verdict → bet blocked entirely
2. **HALVE_STAKE** verdicts → each halves the current stake (compounding)
3. **CAP_STAKE** verdicts → most restrictive cap across all fired signals
4. Stake never drops below £2.00 when the original stake was ≥ £2.00

### Signal Availability by Mode

| Signal | Live | Dry Run | Backtest (Single) | Backtest (Cycle) |
|--------|------|---------|-------------------|-----------------|
| Overround | ✅ | ✅ | ✅ | ✅ |
| Field Size | ✅ | ✅ | ✅ | ✅ |
| Steam Gate | ✅ | ✅ | ✅ | ✅ |
| Band Perf | ✅ | ✅ | ✅ | ✅ |

---

## TOP2_CONCENTRATION Rule Family

TOP2_CONCENTRATION is a market-structure protection and suppression layer that sits between the signal filters and the Market Overlay Modifier (MOM). It identifies races where the betting market is heavily concentrated in the top two runners, indicating a potential two-horse race dynamic where standard lay logic should be reduced or blocked entirely. It is not a replacement for the core lay engine — it is a guard layer applied before any bet is placed.

**The key idea:** if the top two runners are very strongly priced relative to the third runner, the race may effectively be a two-horse race. In these cases, normal favourite-lay logic should be reduced or blocked.

**Priority order in the engine:**

| Position | Rule/Layer |
|----------|-----------|
| 1 | SHORT_PRICE_CONTROL |
| 2 | BMEX_ODDSON_DISLOCATION |
| **3** | **TOP2_CONCENTRATION** ← applied here |
| 4 | Core lay engine |
| 5 | JOFS / split logic |
| 6 | RPR overlay rules |

Module: `backend/top2_concentration.py`

### Inputs and Derived Metrics

At each evaluation the rule ranks all ACTIVE runners by exchange back odds (ascending — shortest price first), takes the top three, and derives:

| Metric | Formula | Description |
|--------|---------|-------------|
| `p1`, `p2`, `p3` | `1 / odds_n` | Implied win probabilities for 1st, 2nd, 3rd favourite |
| `top2_combined` | `p1 + p2` | Combined implied probability share held by top two runners |
| `third_vs_second_ratio` | `p3 / p2` | Weakness of third runner relative to second — lower = larger gap |
| `second_vs_first_ratio` | `p2 / p1` | Closeness of the top two — higher = more like co-leaders |

Requires ADVANCED tier Betfair historic data (`batb` field present). Silently skips on BASIC data (2026+, no order book) — no false signals, no errors.

### Checkpoints

The rule is designed to run at T-30, T-15, T-5, and T-1 relative to race off time. The most operationally significant checkpoints are T-15, T-5, and T-1. T-30 is primarily for data collection and early detection.

### Sub-Rules (Day-One Launch Set)

| Rule | Runs at | Condition | Purpose |
|------|---------|-----------|---------|
| `TOP2_01_SCOPE` | T-30, T-15, T-5, T-1 | ≥ 3 runners with valid exchange back odds | Gate check — enables the family; skips silently if not met |
| `TOP2_02_TOP2_COMBINED_CONCENTRATION` | T-30, T-15, T-5, T-1 | Compute and classify `top2_combined` | Measures how much of the win market sits in the top two |
| `TOP2_03_THIRD_GAP_CONFIRMATION` | T-30, T-15, T-5, T-1 | Compute and classify `third_vs_second_ratio` | Confirms whether the third runner is materially weaker |
| `TOP2_04_TOP2_CLOSE_TOGETHER` | T-30, T-15, T-5, T-1 | Compute and classify `second_vs_first_ratio` | Identifies when top two behave like co-leaders |
| `TOP2_06_MEDIUM_SUPPRESSOR` | T-15, T-5, T-1 | See threshold logic below | Reduce lay stake to 60% of normal |
| `TOP2_07_STRONG_SUPPRESSOR` | T-5, T-1 | See threshold logic below | Reduce lay stake to 25% of normal |
| `TOP2_08_TWO_HORSE_RACE_BLOCK` | T-5, T-1 | See threshold logic below | Full block — no lay placed |

### Threshold Bands

**Top-two combined concentration (`top2_combined`):**

| Band | Threshold | Reason Code |
|------|-----------|-------------|
| Mild | ≥ 0.60 | `TOP2_COMBINED_MILD` |
| Medium | ≥ 0.65 | `TOP2_COMBINED_MEDIUM` |
| Strong | ≥ 0.70 | `TOP2_COMBINED_STRONG` |
| Extreme | ≥ 0.80 | `TOP2_COMBINED_EXTREME` |

**Third-runner gap (`third_vs_second_ratio`):**

| Band | Threshold | Reason Code |
|------|-----------|-------------|
| Mild gap | ≤ 0.60 | `THIRD_GAP_MILD` |
| Medium gap | ≤ 0.50 | `THIRD_GAP_MEDIUM` |
| Strong gap | ≤ 0.40 | `THIRD_GAP_STRONG` |
| Extreme gap | ≤ 0.30 | `THIRD_GAP_EXTREME` |

**Top-two closeness (`second_vs_first_ratio`):**

| Band | Threshold | Reason Code |
|------|-----------|-------------|
| Close top two | ≥ 0.85 | `TOP2_CLOSE` |
| Very close top two | ≥ 0.92 | `TOP2_VERY_CLOSE` |

### Resolution States and Threshold Logic

| State | Lay Multiplier | Trigger Condition |
|-------|---------------|-------------------|
| `NONE` | ×1.00 | No threshold combination breached — no action |
| `WATCH` | ×1.00 | `top2_combined ≥ 0.60` AND `third_vs_second_ratio ≤ 0.60` — log only, no stake change |
| `SUPPRESS_MEDIUM` | ×0.60 | `top2_combined ≥ 0.65` AND `third_vs_second_ratio ≤ 0.50` |
| `SUPPRESS_STRONG` | ×0.25 | `top2_combined ≥ 0.70` AND `third_vs_second_ratio ≤ 0.40` |
| `BLOCK` | ×0.00 | `top2_combined ≥ 0.80` AND `third_vs_second_ratio ≤ 0.30` AND `second_vs_first_ratio ≥ 0.85` |

**Evaluation is cascading — the most severe matching state wins.** SUPPRESS states scale the computed lay stake by the multiplier (£2.00 minimum floor enforced when original stake ≥ £2.00). BLOCK clears all instructions — no bet is placed. WATCH produces a structured log entry only. RPR overlay rules must not override a BLOCK decision.

**Example (extreme two-horse race):**
- Runner 1: 2.10 → p1 = 0.4762
- Runner 2: 2.20 → p2 = 0.4545
- Runner 3: 11.00 → p3 = 0.0909
- `top2_combined` = 0.9307, `third_vs_second_ratio` = 0.20, `second_vs_first_ratio` = 0.95 → **BLOCK**

**Example (normal open race):**
- Runner 1: 3.20 → p1 = 0.3125
- Runner 2: 4.20 → p2 = 0.2381
- Runner 3: 5.50 → p3 = 0.1818
- `top2_combined` = 0.5506, `third_vs_second_ratio` = 0.76 → **NONE** — no action

### Availability by Mode

| Mode | Status | Toggle |
|------|--------|--------|
| Backtest — Single Run | ✅ Active | "TOP2 Concentration" in backtest settings panel |
| Backtest — Cycle Run | ✅ Active | Carries through from single-run config |
| Live engine | ✅ Active | "TOP2 Concentration" in live Bet Settings panel |
| Dry Run | ✅ Active | Follows live engine settings |

> **Data tier requirement:** TOP2_CONCENTRATION uses `best_available_to_back` extracted from the ADVANCED tier `batb` field via FSU1. BASIC tier data (2026+) does not contain this field — the rule silently returns `NONE` with `skipped=true` and has no effect on bet placement.

### Deferred Sub-Rules (Post Day-One — pending threshold calibration)

| Rule | Purpose |
|------|---------|
| `TOP2_09_SPLIT_EXPOSURE_CAP` | When joint/split-favourite logic is active in a concentrated market, cap total exposure across both top runners to 50% of normal split stake |
| `TOP2_10_PERSISTENCE_CONFIRMATION` | Require suppressor state to be active at both the current and previous checkpoint before allowing a hard BLOCK — prevents transient spikes triggering full blocks |

---

## Market Overlay Modifier (MOM)

The Market Overlay Modifier is a post-signal-filter stake scaling layer that adjusts the computed lay stake based on overall market efficiency. It never blocks or creates bets — it only scales an existing stake up or down. Independently toggleable in both Live and Backtest modes.

Module: `backend/market_overlay.py`

MOM computes the **market overround** — the sum of implied win probabilities from all active runners' best available back prices. A perfectly efficient market scores 1.00. Real markets are typically slightly above 1.00. A high overround indicates the market is inefficient (more bookmaker margin); a sub-1.00 reading indicates sharp money dominance.

| Overround | Multiplier | Reason Code | Rationale |
|-----------|-----------|-------------|-----------|
| > 1.02 | ×1.15 | `HIGH_OVERROUND` | Inefficient market — signals are more informative, amplify stake |
| 1.00 – 1.02 | ×1.00 | `NEUTRAL` | Normal market — no adjustment |
| < 1.00 | ×0.80 | `EFFICIENT_MARKET` | Sharp market — edge is largely priced in, reduce exposure |

### Directional Exception Flag

MOM also logs a structured flag (no stake effect) when all of the following are simultaneously true:
- Overround > 1.02 (HIGH_OVERROUND state)
- Gap between 1st and 2nd favourite back prices ≤ 0.30
- Gap between 2nd and 3rd favourite back prices ≥ 1.50

This combination identifies a high-overround market where the top two runners are unusually close whilst the third is materially weaker — effectively a concentrated market with an overlay. The flag feeds the future `TOP_OF_MARKET_CONCENTRATION` rule family.

### Availability by Mode

| Mode | Status | Toggle |
|------|--------|--------|
| Backtest — Single Run | ✅ Active | "Market Overlay (MOM)" in backtest settings panel |
| Backtest — Cycle Run | ✅ Active | Carries through from single-run config |
| Live engine | ✅ Active | Available in live Bet Settings panel |
| Dry Run | ✅ Active | Follows live engine settings |

---

## Strategy Pipeline

The full order in which layers are applied to every candidate bet. Each layer can modify, reduce, or block the instruction generated by the core rules. Layers marked **toggleable** are skipped entirely when disabled.

| Step | Layer | Module | Effect | Toggleable |
|------|-------|--------|--------|------------|
| 1 | Market scan & deduplication | `engine.py` | Discover WIN markets; skip duplicates, in-play, and odds > 50 | — |
| 2 | **Core lay rules** (Rules 1 / 2 / 3A / 3B) | `rules.py` | Generate base lay instruction and stake | — |
| 3 | **JOFS split** | `rules.py` | Split stake across joint/close favourites when gap ≤ 0.2 | ✅ |
| 4 | **Mark rules** (Ceiling / Floor / Uplift) | `rules.py` | Reject odds > 8.0 or < 1.5; boost stake in 2.5–3.5 band | ✅ each |
| 5 | **Spread Control** | `rules.py` | Reject bet if back-lay spread exceeds odds-based threshold | ✅ |
| 6 | **TOP2_CONCENTRATION** | `top2_concentration.py` | Suppress stake (×0.60 or ×0.25) or block entirely in two-horse race markets | ✅ |
| 7 | **Signal Filters** (×4) | `signal_filters.py` | SKIP / HALVE_STAKE / CAP_STAKE based on overround, field size, steam, band performance | ✅ each |
| 8 | **Market Overlay Modifier (MOM)** | `market_overlay.py` | Scale stake ×1.15 / ×1.00 / ×0.80 based on market overround efficiency | ✅ |
| 9 | **Kelly Criterion** | `kelly.py` | Replace computed stake with bankroll-fraction Kelly sizing | ✅ |
| 10 | **FSU9 Strategy Sandbox** | `strategy_sandbox.py` | User-defined rule overlays; can further adjust or block bets | ✅ |
| 11 | **AI agents** (Research + Odds Movement) | `ai_backtest_agent.py`, `ai_odds_agent.py` | CONFIRM / OVERRULE / ADJUST per instruction (backtest only) | ✅ each |
| 12 | **Bet placement / settlement** | `engine.py`, `betfair_client.py` | Place lay order on Betfair (Live/Dry Run) or resolve against FSU1 result (Backtest) | — |

**Minimum stake floor:** £2.00 is enforced throughout the pipeline whenever the original computed stake was ≥ £2.00. No suppression or scaling layer can push a qualifying bet below this floor.

---

## Dashboard Tabs

| Tab | Description |
|-----|-------------|
| **Live** | Start/stop LIVE engine, real-time market book (3-level back/lay depth), active bets, P&L |
| **Dry Run** | Start/stop DRY RUN engine, same market view, instant snapshot tool for selected markets |
| **Backtest** | Historic market replay — single date run, multi-date cycle run, history with export |
| **Strategy** | Strategy visualisation and rule documentation |
| **History** | Three sub-tabs: Sessions (live session history), Matched (bets on Betfair), Settled (P/L from Betfair) |
| **Bet Settings** | All betting parameters: timing, stake, countries, rules, JOFS, Spread Control, Mark Rules, Kelly, Signal Filters, Process Window |
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
├── docs/
│   ├── CHIMERA_Platform_Architecture.md   # Platform overview and FSU breakdown
│   ├── Lay_Engine_Infographic.md          # Component map and workflow descriptions
│   └── Day33_Loss_Analysis_and_Methodology_Signals.md  # Day 33 post-mortem + signal rationale
├── backend/
│   ├── main.py                 # FastAPI app — all API endpoints
│   ├── engine.py               # Core engine: scan → rules → signal filters → bet loop
│   ├── rules.py                # Rule definitions, spread control, JOFS, data classes
│   ├── signal_filters.py       # Four market intelligence signal filters (post-rules layer)
│   ├── betfair_client.py       # Betfair Exchange API client (live)
│   ├── fsu_client.py           # FSU1 historic data client with virtual time support
│   ├── kelly.py                # Kelly Criterion stake sizing
│   ├── ai_backtest_agent.py    # AI Research Agent (web search overlay for backtest)
│   ├── ai_odds_agent.py        # AI Odds Movement Agent (price drift analysis for backtest)
│   ├── market_overlay.py       # Market Overlay Modifier (MOM) — overround + concentration guard
│   ├── top2_concentration.py   # TOP2_CONCENTRATION rule family — two-horse race suppression/block
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
| `GET` | `/api/rules` | — | `{strategy, version, timing, markets, rules[], spread_control, jofs_control, signal_config}` | Active rule set with all control config including signals |

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

### Signal Filter Controls

| Method | Path | Body / Params | Response | Description |
|--------|------|---------------|----------|-------------|
| `POST` | `/api/engine/signal/overround` | — | `{signal_overround_enabled: bool}` | Toggle Market Overround signal |
| `POST` | `/api/engine/signal/field-size` | — | `{signal_field_size_enabled: bool}` | Toggle Field Size signal |
| `POST` | `/api/engine/signal/steam-gate` | — | `{signal_steam_gate_enabled: bool}` | Toggle Steam Gate signal |
| `POST` | `/api/engine/signal/band-perf` | — | `{signal_band_perf_enabled: bool}` | Toggle Rolling Band Performance signal |
| `POST` | `/api/engine/top2-concentration` | — | `{top2_concentration_enabled: bool}` | Toggle TOP2_CONCENTRATION suppression/block layer |

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
| `POST` | `/api/reports/generate` | `{date, session_ids: [], template}` | Full report JSON | Generate AI daily report via streaming (auto-emails recipients) |
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
| `POST` | `/api/backtest/run` | See Backtest Request below | `{job_id, status}` | Start backtest job (async — poll for result) |
| `GET` | `/api/backtest/job/{job_id}` | — | `{job_id, status, result?, error?}` | Poll backtest job status / retrieve results |
| `POST` | `/api/backtest/export-sheets` | `{entries: [backtest run objects]}` | `{url: spreadsheet URL, spreadsheet_id}` | Export backtest runs to Google Sheets |

#### Backtest Request Body (`POST /api/backtest/run`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `date` | str | — | Date to replay (YYYY-MM-DD) |
| `countries` | list[str] | `["GB","IE"]` | Country filter |
| `process_window_mins` | float | 5 | Minutes before off to evaluate |
| `jofs_enabled` | bool | true | JOFS close-odds split |
| `spread_control` | bool | false | Spread control filter |
| `mark_ceiling_enabled` | bool | false | Mark ceiling (≤8.0) |
| `mark_floor_enabled` | bool | false | Mark floor (≥1.5) |
| `mark_uplift_enabled` | bool | false | Mark uplift (2.5–3.5 band) |
| `mark_uplift_stake` | float | 3.0 | Uplift stake in points |
| `point_value` | float | 1.0 | Stake multiplier |
| `market_ids` | list[str] | `[]` | Specific markets (empty = all) |
| `ai_agent_enabled` | bool | false | AI Research Agent overlay |
| `ai_agent_max_searches` | int | 4 | Max web searches per runner |
| `ai_agent_overrule_confidence` | float | 0.65 | Min confidence to overrule |
| `odds_agent_enabled` | bool | false | AI Odds Movement Agent overlay |
| `odds_agent_interval_mins` | int | 5 | Price sampling interval (mins) |
| `odds_agent_lookback_mins` | int | 30 | Price history window (mins) |
| `odds_agent_overrule_confidence` | float | 0.65 | Min confidence to overrule |
| `kelly_enabled` | bool | false | Kelly Criterion stake sizing |
| `kelly_fraction` | float | 0.25 | Fraction of Kelly to apply |
| `kelly_bankroll` | float | 1000.0 | Total bankroll (£) |
| `kelly_edge_pct` | float | 5.0 | Assumed edge % |
| `kelly_min_stake` | float | 0.50 | Minimum stake floor (£) |
| `kelly_max_stake` | float | 50.0 | Maximum stake ceiling (£) |
| `signal_overround_enabled` | bool | false | Market Overround signal |
| `signal_field_size_enabled` | bool | false | Field Size signal |
| `signal_steam_gate_enabled` | bool | false | Steam Gate signal (samples FSU at −15 mins) |
| `signal_band_perf_enabled` | bool | false | Rolling Band Performance signal |
| `market_overlay_enabled` | bool | false | Market Overlay Modifier (MOM) — overround + concentration guard |
| `top2_concentration_enabled` | bool | false | TOP2_CONCENTRATION — two-horse race suppression and block layer (requires ADVANCED data) |

---

## Backtest Tab

### Single Run
1. Select a date from the dropdown (populated from FSU1 historic data).
2. Configure rules (JOFS, Spread Control, Mark Ceiling/Floor/Uplift, Point Value, Process Window, Kelly).
3. Optionally enable Signal Filters (Overround, Field Size, Steam Gate, Band Perf).
4. Optionally enable **TOP2 Concentration** — suppresses or blocks lays in two-horse race markets (requires a pre-2026 ADVANCED date; silently skips on 2026+ BASIC data).
5. Optionally enable AI agent overlays (Research Agent, Odds Movement Agent).
6. Optionally filter the market browser to include only specific races.
7. Click **Run Backtest** — the engine calls `/api/backtest/run` (async job) and polls `/api/backtest/job/{job_id}` until complete.
8. Results appear as a settlement table with P&L per race.
9. Each run is saved to **History** (browser localStorage, max 50 runs).

> **Note on Steam Gate in Backtest:** FSU1 is queried at `target_iso − 15 minutes` per market to obtain earlier prices for shortening detection. A hard 8-second timeout is applied per market — if FSU is slow, the steam check is silently skipped and the bet proceeds normally.

### Cycle Run
1. Tick any number of dates in the **Dates** grid.
2. Click **Run Cycle** — calls `/api/backtest/run` once per date (all markets, no pre-filtering) with a live progress bar.
3. Signal filters and Kelly settings carry through to the cycle run.
4. When complete the cycle is saved to **Cycle History** (separate localStorage key, max 20 runs).

### History & Export
Both History sections support:
- **Select / Deselect All** for bulk operations
- **Download XLS** — exports selected runs to a local Excel file
- **Google Sheets** — exports to a new Google Spreadsheet (requires SA with Sheets API permission — currently returns 403)
- **Delete** — removes selected entries from localStorage
- **Clear All** — wipes the entire history section

| Store | localStorage key | Max entries |
|-------|-----------------|-------------|
| Single runs | `chimera_backtest_history` | 50 |
| Cycle runs | `chimera_backtest_cycle_history` | 20 |

---

## AI Agents (Backtest)

### AI Research Agent
Searches the web for runner intelligence (form, news, trainer/jockey info) before the race date and may CONFIRM, OVERRULE, or ADJUST individual bet instructions. Slows backtest runs significantly — allow extra time per race. Controlled by `ai_agent_enabled` and `ai_agent_max_searches`.

### AI Odds Movement Agent
Samples FSU1 historical prices at configurable intervals (`odds_agent_interval_mins`) over a configurable lookback window (`odds_agent_lookback_mins`), analyses the price trend (SHORTENING / DRIFTING / STABLE), and may CONFIRM, OVERRULE, or ADJUST each instruction's stake. No internet required — uses historic data only. Virtual time is always restored to `target_iso` after sampling.

Both agents run **after Kelly** and **after Signal Filters** in the backtest pipeline, before settlement lookup.

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

Daily performance reports are generated via Anthropic Claude streaming (required for large outputs):

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
| `ANTHROPIC_API_KEY` | Cloud Run | — | Claude Sonnet API key for AI reports/chat/agents |
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
| Spread Control → 0 bets in backtest | Under investigation — `best_available_to_back` returns `None` due to empty `batb` after MCM reconstruction in FSU1; ADVANCED data confirmed to contain `batb` fields | Disable Spread Control in backtest until resolved |
| Mark Floor / Mark Uplift → 0 bets in backtest | Under investigation — root cause not yet identified | Disable Mark Floor and Mark Uplift in backtest until resolved |
| Signal: Overround stuck in backtest | Intermittent — likely Cloud Run instance saturation from concurrent jobs | Wait for previous backtest cycle to complete before starting a new one |

---

## Recent Changes (2026-03-25 / 2026-04-05)

| Commit | Description |
|--------|-------------|
| `9f06b09` | Fix critical integrity issues: OOM, NameError, sandbox restore, snapshot stake |
| `bf7f208` | Fix NameError: logger not defined in backtest thread |
| `f3685d1` | Update README: known issues, recent changes (2026-03-25/26) |
| `af9b4ec` | Fix `React is not defined` ReferenceError in `StrategyTab` and `TrayCard` |
| `a34df26` | TOP2_CONCENTRATION: per-race result in backtest output, live engine wiring, live UI toggle |

---

## Tagged Versions

| Tag | Version | Description |
|-----|---------|-------------|
| `v1.0-reports` | 1.0 | Stable release with Anthropic Claude-based AI agent |
| `v5.0.0` | 5.0.0 | Current — unified version, dark glass UI, full FSU platform, signal filters, AI agents, Kelly Criterion |
