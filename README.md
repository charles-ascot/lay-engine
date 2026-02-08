# CHIMERA Lay Engine

Pure rule-based lay betting engine for UK/IE horse racing on Betfair Exchange.

## Rules

| Condition | Action |
|---|---|
| Favourite odds < 2.0 | LAY favourite @ £3 |
| Favourite odds 2.0–5.0 | LAY favourite @ £2 |
| Favourite odds > 5.0, gap to 2nd fav < 2 | LAY fav @ £1 + LAY 2nd fav @ £1 |
| Favourite odds > 5.0, gap to 2nd fav ≥ 2 | LAY favourite @ £1 |

## Architecture

- **Backend**: FastAPI + Python → Google Cloud Run (`europe-west2`)
- **Frontend**: React + Vite → Cloudflare Pages (`layengine.thync.online`)

## Local Development

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs on `http://localhost:5173` and proxies `/api` to `localhost:8080`.

## Deploy Backend → Cloud Run

```bash
# Build and push
gcloud builds submit --tag gcr.io/YOUR_PROJECT/chimera-lay-engine

# Deploy
gcloud run deploy chimera-lay-engine \
  --image gcr.io/YOUR_PROJECT/chimera-lay-engine \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "BETFAIR_APP_KEY=HTPjf4PpMGLksswf,BETFAIR_USERNAME=markinsley,BETFAIR_PASSWORD=YOUR_PASSWORD,DRY_RUN=true,FRONTEND_URL=https://layengine.thync.online"
```

After deploy, copy the Cloud Run URL (e.g. `https://chimera-lay-engine-xxxxx-nod.a.run.app`).

## Deploy Frontend → Cloudflare Pages

1. Update `API_BASE` in `frontend/src/App.jsx` with your Cloud Run URL
2. Build:
```bash
cd frontend
npm run build
```
3. In Cloudflare Dashboard:
   - Pages → Create project → Connect Git repo (or direct upload of `frontend/dist`)
   - Custom domain: `layengine.thync.online`
   - Build command: `cd frontend && npm install && npm run build`
   - Build output: `frontend/dist`

## Run Tests
```bash
python test_rules.py
```

## Configuration

All config via `.env` or Cloud Run environment variables:

| Variable | Default | Description |
|---|---|---|
| `BETFAIR_APP_KEY` | — | Betfair API app key |
| `BETFAIR_USERNAME` | — | Betfair username |
| `BETFAIR_PASSWORD` | — | Betfair password |
| `DRY_RUN` | `true` | `true` = no real bets |
| `BET_BEFORE_MINUTES` | `2` | Minutes before race to place bet |
| `POLL_INTERVAL` | `30` | Seconds between market scans |
| `FRONTEND_URL` | `https://layengine.thync.online` | For CORS |
