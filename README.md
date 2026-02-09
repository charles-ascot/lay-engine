# 🐴 CHIMERA Lay Engine v1.1

Automated lay betting engine for Betfair UK/IE horse racing.

## What's Fixed (v1.1)

### Bug 1: DRY_RUN killed all market fetching
**Before:** When `DRY_RUN=true`, `_scan_and_process()` returned immediately without fetching markets or prices. Engine was braindead.
**After:** `DRY_RUN` only skips the final `placeOrders` API call. Markets are discovered, prices fetched, rules evaluated, and everything logged — the only thing that doesn't happen is real money leaving the account..

### Bug 2: Betfair API type mismatches (silent failures)
**Before:** `selectionId`, `size`, `price`, `handicap` were sent as **strings**. Betfair expects **numbers**. This caused silent rejection — no error, just `FAILURE`.
**After:** All values cast to correct types: `selectionId` → `int`, `size`/`price` → `float`, `handicap` → `int(0)`.

### Bug 3: No in-play guard
**Before:** Only checked `market.status != "OPEN"`. Markets can be `OPEN` AND `inPlay=True` simultaneously. Bets placed into live markets get rejected or matched at wrong odds.
**After:** Explicit `inPlay` check — if `True`, market is skipped with a log entry.

### Bug 4: Cloud Run cold starts wiped all state
**Before:** All state (markets, bets, results) stored in-memory only. Cloud Run scales to zero → everything gone.
**After:** State persisted to `/tmp/chimera_engine_state.json` every ~2.5 minutes. On cold start, state is reloaded if same day. Added `/api/keepalive` endpoint for Cloud Scheduler pings.

### Rules: UNCHANGED
Mark's rules are exactly as specified. Not a comma moved.

---

## Architecture

```
Frontend (React/Vite) → Cloudflare Pages
Backend (FastAPI)     → Google Cloud Run (europe-west2)
```

## Local Development

### Backend
```bash
cd backend
pip install -r requirements.txt
BETFAIR_APP_KEY=your_key uvicorn main:app --reload --port 8080
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Vite proxies `/api` to `localhost:8080` automatically.

## Deployment

### Backend → Cloud Run
```bash
# Build and deploy
gcloud builds submit --tag gcr.io/chimera-v4/chimera-lay-engine
gcloud run deploy chimera-lay-engine \
  --image gcr.io/chimera-v4/chimera-lay-engine \
  --region europe-west2 \
  --platform managed \
  --set-env-vars "BETFAIR_APP_KEY=HTPjf4PpMGLksswf,FRONTEND_URL=https://layengine.thync.online,DRY_RUN=true" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=256Mi \
  --allow-unauthenticated
```

### Prevent Cold Starts (Optional but Recommended)
```bash
gcloud scheduler jobs create http chimera-keepalive \
  --schedule="*/5 6-22 * * 1-6" \
  --uri="https://lay-engine-950990732577.europe-west2.run.app/api/keepalive" \
  --http-method=GET \
  --time-zone="Europe/London"
```

### Frontend → Cloudflare Pages
1. Push `frontend/` to GitHub
2. Connect repo to Cloudflare Pages
3. Build command: `npm run build`
4. Build output: `dist`
5. Environment variable: `VITE_API_URL=https://lay-engine-950990732577.europe-west2.run.app`
6. Custom domain: `layengine.thync.online`

## Going Live
1. Set `DRY_RUN=false` in Cloud Run env vars, OR
2. Toggle via the UI dashboard button

## Environment Variables

| Variable | Where | Default | Description |
|---|---|---|---|
| `BETFAIR_APP_KEY` | Cloud Run | — | Your Betfair API app key |
| `FRONTEND_URL` | Cloud Run | `https://layengine.thync.online` | CORS origin |
| `DRY_RUN` | Cloud Run | `true` | Skip real bet placement |
| `POLL_INTERVAL` | Cloud Run | `30` | Seconds between scans |
| `VITE_API_URL` | Cloudflare Pages | — | Backend API URL |
