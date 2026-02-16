# Changelog

All notable changes to the CHIMERA Lay Engine.

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
