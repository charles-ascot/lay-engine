FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# ── Environment defaults ──
# DRY_RUN=true: Engine fetches real markets/prices but skips placeOrders call.
# Set DRY_RUN=false in Cloud Run env vars to go live.
ENV DRY_RUN=true
ENV POLL_INTERVAL=30
ENV STATE_FILE=/tmp/chimera_engine_state.json
# BETFAIR_APP_KEY must be set in Cloud Run environment variables
# FRONTEND_URL must be set in Cloud Run environment variables

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
