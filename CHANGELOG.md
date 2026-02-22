# Changelog

All notable changes to the CHIMERA Lay Engine.

## [1.6.0] — 2026-02-22

### Added
- **Points Value control** — Configurable stake multiplier in the dashboard header. Set £1, £2, £5, £10, £20, or £50 per point. All rule stakes are multiplied by this value (e.g. at £10/point, RULE_1 places a £30 lay instead of £3). Persists across restarts.
- **Dynamic Spread Control** — Pre-bet validation gate that checks back-lay spread against odds-based thresholds to reject bets in illiquid markets. Toggleable on/off from the dashboard. Based on Mark Insley's Spread Control Logic specification.
- **Balance auto-refresh** — Account balance now refreshes every 30 seconds via cached Betfair API call, visible in the header without needing to start/stop the engine.
- **Spread Control thresholds** — Odds-based maximum spread limits: 0.05 (1.0–2.0), 0.15 (2.0–3.0), 0.30 (3.0–5.0), 0.50 (5.0–8.0), REJECT (8.0+).
- `POST /api/engine/spread-control` — Toggle spread control on/off.
- `GET /api/engine/spread-rejections` — View recent spread rejections.
- `POST /api/engine/point-value` — Set the point value multiplier.
- `best_available_to_back` field on Runner dataclass for spread calculation.

### Changed
- `rules.py` — Added `SpreadCheckResult` dataclass, `check_spread()` function, and `SPREAD_THRESHOLDS` table.
- `betfair_client.py` — Now fetches back prices alongside lay prices in `get_market_prices()`.
- `engine.py` — Integrated spread control and point value into the bet pipeline. Added balance caching.
- Settled tab now defaults to "Today" instead of last 7 days.
- Reports exclude VOID/NR bets — only confirmed WIN/LOSS results are shown.

### Fixed
- Report JSON parsing — robust regex-based markdown fence stripping replaces fragile index-based logic.
- Report viewer handles both pre-parsed JSON objects and markdown-fenced JSON strings.
- Spread Control button visibility — uses `btn-warning` (amber) for active state instead of invisible `btn-info`.

## [1.5.0] — 2026-02-20

### Added
- **Market tab** — Live Betfair market view with 3-level back/lay depth, book percentage, auto-refresh every 5 seconds, market selector dropdown sorted by race time.
- **Matched bets tab** — Displays all LIVE bets placed on Betfair with date range filtering, date grouping, expandable bet details (bet ID, market ID, venue), and Excel export.
- **Settled bets tab** — Race results with P/L from Betfair cleared orders. Includes date range filter, Today/Yesterday/7 Days/Month presets, Won/Lost/All filter, day-by-day grouping with strike rate and P/L, AI Report button per day, and Excel export.
- **Snapshots tab** — Renamed from History. Sessions grouped by date with country flags, mode badges, and drill-down to individual bets.
- `GET /api/markets` — List all discovered markets for today.
- `GET /api/markets/{id}/book` — Full market book with 3-level back/lay depth.
- `GET /api/matched` — Live matched bets with date range filtering.
- `GET /api/settled` — Settled bets from Betfair cleared orders with P/L.

### Changed
- `betfair_client.py` — Added `get_market_book_full()` for 3-level price depth, `get_cleared_orders()` for settled bets.
- Dashboard tabs expanded from 4 to 8: Market, Snapshots, Matched, Settled, Reports, Rules, Errors, API Keys.

## [1.4.0] — 2026-02-18

### Added
- **AI report generator** — Full daily performance reports with structured JSON output matching the ChimeraReport schema. Reports include executive summary, day performance, odds band analysis, cumulative performance, discipline/venue analysis, individual bet breakdown, conclusions, and appendix.
- **Glassmorphism design system** — Complete UI overhaul with dark theme, glass-morphism panels, gradient accents, Lexend/Poppins fonts, and Betfair-style price cells.
- **API key authentication** — Generate, list, and revoke API keys for external agent access. Keys authenticate via `X-API-Key` header or `?api_key=` query param.
- **Data API endpoints** — External agent endpoints: `/api/data/sessions`, `/api/data/bets`, `/api/data/results`, `/api/data/state`, `/api/data/rules`, `/api/data/summary`.
- **Report templates** — Extensible template system for AI-generated reports (currently: `daily_performance`).
- AI agent enriched with settled bet outcomes, venue/country per bet, and historical cumulative data.
- AI switched from Anthropic Claude to Gemini 2.5 Flash (temporary — Anthropic version tagged as `v1.0-reports`).
- `POST /api/reports/generate` — Generate AI report for selected sessions.
- `GET /api/reports` — List all generated reports.
- `GET /api/reports/{id}` — View report with full content.
- `DELETE /api/reports/{id}` — Delete a report.
- `POST /api/keys/generate` — Generate API key.
- `GET /api/keys` — List API keys (masked).
- `DELETE /api/keys/{id}` — Revoke API key.

### Changed
- `engine.py` — Added report and API key persistence to GCS.
- `main.py` — Added `_get_settled_for_date()`, `_get_historical_summary()` helpers. Rewrote `DAILY_REPORT_PROMPT` for structured JSON output.
- `App.jsx` — Added `renderJsonReport()` and `renderReportContent()` for structured report rendering.
- Dashboard redesigned with glassmorphic panels, branded background, and improved typography.

## [1.3.0] — 2026-02-16

### Added
- **Max odds cap** — Markets where the favourite's odds exceed 50.0 are now skipped automatically. Prevents the engine from processing illiquid/bogus markets with dummy prices (e.g. 560.00).
- **OpenAI Whisper STT** — Voice input in the AI chat now uses OpenAI Whisper via `POST /api/audio/transcribe` for accurate speech recognition. Falls back to browser Speech API if unavailable.
- **OpenAI TTS** — AI chat responses are spoken aloud using OpenAI TTS (nova voice) via `POST /api/audio/speak`. Falls back to browser SpeechSynthesis if unavailable.
- **Venue column in Bets tab** — Replaced the Market ID column with Venue in both the main Bets tab and session detail bets table for better readability.

### Changed
- `rules.py` — Added `MAX_LAY_ODDS = 50.0` constant and guard clause in `apply_rules()`.
- `engine.py` — `_place_bet()` now accepts and stores a `venue` parameter in bet records.
- `main.py` — Added OpenAI client setup, `/api/audio/transcribe` and `/api/audio/speak` endpoints.
- `requirements.txt` — Added `openai==1.58.1`.

## [1.2.0] — 2026-02-16

### Added
- **Country toggle switches** — GB, IE, ZA, and FR are now selectable from the dashboard controls panel. Previously only GB and IE were hardcoded.
- **Interactive AI chat** — The one-shot Analysis button has been replaced with a full conversational chat drawer powered by Claude. Accessible from both the History tab and the main controls panel.
- **Voice interface** — Microphone button for speech input and auto-read for AI responses (with mute toggle).
- `POST /api/engine/countries` endpoint to update the market country filter at runtime.
- `POST /api/chat` endpoint for conversational AI with session data context and history.

### Changed
- `betfair_client.py` — `get_todays_win_markets()` now accepts an optional `countries` parameter.
- `engine.py` — Added `self.countries` state with persistence across cold starts. Countries are passed to the Betfair client on each scan.
- `main.py` — Extracted `_compact_session_data()` helper for AI prompts (shared by analyse and chat endpoints). Updated `/api/rules` to use `engine.countries`.
- `App.jsx` — Added `ChatDrawer` component, country toggle buttons, removed old one-shot analysis UI.

## [1.1.3] — 2026-02-15

### Changed
- Switched AI analysis back to Anthropic Claude from Google Gemini for better quality.
- Switched from gemini-2.0-flash to gemini-1.5-flash for higher free tier quota (intermediate step).
- Sanitized API keys from error messages sent to frontend.

## [1.1.2] — 2026-02-15

### Added
- **GCS bucket persistence** — Engine state and session history now persist to Google Cloud Storage in addition to local disk, surviving full container restarts on Cloud Run.
- **AI-powered session analysis** — Analysis button on History tab sends session data to AI for bullet-point insights on odds drift, rule distribution, risk exposure, and venue patterns.
- **Session history tracking** — Every engine run is recorded as a session with start/stop times, mode, bets, results, and summary stats. Sessions persist across restarts.
- **Excel snapshot downloads** — Any table in the dashboard can be exported to `.xls` format.

### Changed
- State persistence upgraded from disk-only to disk + GCS.
- Crashed sessions (from container restarts) are automatically detected and marked.

## [1.1.1] — 2026-02-11

### Reverted
- Reverted v2.1 changes (jumps-only filter, min odds floor, double dedup) — these were experimental and not part of the core rule set.

## [1.1.0] — 2026-02-09 – 2026-02-10

### Fixed
- **DRY_RUN mode** — Previously returned immediately without fetching markets or prices. Now fetches real data and only skips the final `placeOrders` call.
- **Betfair API type mismatches** — `selectionId`, `size`, `price`, `handicap` were sent as strings causing silent rejection. Now sent as correct numeric types.
- **In-play guard** — Markets can be `OPEN` and `inPlay=True` simultaneously. Added explicit check to skip in-play markets.
- **Cloud Run cold starts** — All state was in-memory only. Added persistence to `/tmp/chimera_engine_state.json` every ~2.5 minutes with reload on cold start.
- **Duplicate bets** — Added runner deduplication to prevent betting on the same runner/race twice.
- **Timestamp ordering** — Fixed bet record timestamps to prevent overwrites.

### Added
- `POST /api/engine/reset-bets` — Clear all bets and re-process all markets (for switching from dry run to live).
- `GET /api/keepalive` — Cloud Run warmup endpoint for Cloud Scheduler.
- Removed 20-item cap on bets/rules API responses — all results now returned.
- Removed `BET_BEFORE_MINUTES` timing restriction — engine bets on any pre-off market immediately.

## [1.0.0] — 2026-02-08

### Added
- Initial release of CHIMERA Lay Engine.
- FastAPI backend with Betfair Exchange API integration.
- React dashboard with login, engine controls, bets table, rules table, errors tab.
- 4-rule lay betting strategy (Rules 1, 2, 3A, 3B).
- Dry run / live toggle from dashboard UI.
- Dockerfile for Google Cloud Run deployment.
- Vite frontend with Cloudflare Pages deployment.
