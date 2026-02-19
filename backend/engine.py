"""
CHIMERA Lay Engine — Main Engine
=================================
Discovers races → applies rules → places bets.
Runs on a loop. No manual intervention. No intelligence.

FIX LOG:
  - DRY_RUN now fetches real markets + prices, only skips actual bet placement
  - Added in-play guard (market can be OPEN + inPlay simultaneously)
  - Added state persistence to survive Cloud Run cold starts
  - Engine auto-restarts on state reload if it was previously running
"""

import os
import json
import time
import secrets
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from betfair_client import BetfairClient
from rules import Runner, apply_rules, RuleResult

logger = logging.getLogger("engine")

# ── Configuration from environment ──
BETFAIR_APP_KEY = os.environ.get("BETFAIR_APP_KEY", "")

# Dry run mode (log but don't place real bets)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Poll interval in seconds
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))

# State file for Cloud Run cold-start recovery
STATE_FILE = Path(os.environ.get("STATE_FILE", "/tmp/chimera_engine_state.json"))

# Session history file (persists across days, separate from daily state)
SESSIONS_FILE = Path(os.environ.get("SESSIONS_FILE", "/tmp/chimera_sessions.json"))

# API keys file
API_KEYS_FILE = Path(os.environ.get("API_KEYS_FILE", "/tmp/chimera_api_keys.json"))

# ── GCS persistence (survives container restarts) ──
GCS_BUCKET = os.environ.get("GCS_BUCKET", "")
_gcs_client = None

def _get_gcs_client():
    global _gcs_client
    if _gcs_client is None and GCS_BUCKET:
        from google.cloud import storage
        _gcs_client = storage.Client()
    return _gcs_client

def _gcs_write(blob_name: str, data: str):
    """Write a string to GCS. Falls back silently on error."""
    try:
        client = _get_gcs_client()
        if not client:
            return
        bucket = client.bucket(GCS_BUCKET)
        bucket.blob(blob_name).upload_from_string(data, content_type="application/json")
    except Exception as e:
        logger.warning(f"GCS write failed for {blob_name}: {e}")

def _gcs_read(blob_name: str) -> Optional[str]:
    """Read a string from GCS. Returns None if not found or on error."""
    try:
        client = _get_gcs_client()
        if not client:
            return None
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        return blob.download_as_text()
    except Exception as e:
        logger.warning(f"GCS read failed for {blob_name}: {e}")
        return None


class LayEngine:
    """
    The core engine. Discovers markets, applies rules, places bets.
    State is held in-memory for the current day, with periodic
    persistence to disk so Cloud Run cold starts don't wipe everything.
    """

    def __init__(self):
        self.client: Optional[BetfairClient] = None
        self.running = False
        self._thread: Optional[threading.Thread] = None

        # ── Today's state ──
        self.markets: list[dict] = []                # Discovered markets
        self.results: list[dict] = []                # Rule evaluations
        self.bets_placed: list[dict] = []            # Confirmed bet placements
        self.processed_markets: set[str] = set()     # Markets already processed
        self.processed_runners: set[tuple] = set()   # (runner_name, race_time) dedup
        self.last_scan: Optional[str] = None
        self.status: str = "STOPPED"
        self.balance: Optional[float] = None
        self.errors: list[dict] = []
        self.day_started: str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.dry_run: bool = DRY_RUN  # Start with env default, toggleable at runtime
        self.countries: list[str] = ["GB", "IE"]  # Configurable at runtime

        # ── Credentials for re-auth after cold start ──
        self._username: Optional[str] = None
        self._password: Optional[str] = None

        # ── Session tracking ──
        self.sessions: list[dict] = []
        self.current_session: Optional[dict] = None
        self._session_bets_start_index: int = 0

        # ── API keys ──
        self.api_keys: list[dict] = []

        # Try to reload state from disk (Cloud Run cold-start recovery)
        self._load_state()
        self._load_sessions()
        self._load_api_keys()

    # ──────────────────────────────────────────────
    #  STATE PERSISTENCE (Cloud Run survival)
    # ──────────────────────────────────────────────

    def _save_state(self):
        """Persist current state to disk + GCS so cold starts don't lose everything."""
        try:
            state = {
                "day_started": self.day_started,
                "processed_markets": list(self.processed_markets),
                "processed_runners": list(self.processed_runners),
                "results": self.results[-200:],  # Keep last 200
                "bets_placed": self.bets_placed[-200:],
                "errors": self.errors[-50:],
                "last_scan": self.last_scan,
                "dry_run": self.dry_run,
                "countries": self.countries,
                "status": self.status,
                "balance": self.balance,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
            state_json = json.dumps(state, default=str)
            STATE_FILE.write_text(state_json)
            _gcs_write("chimera_engine_state.json", state_json)

            # Update current session's running snapshot
            if self.current_session:
                session_bets = self.bets_placed[self._session_bets_start_index:]
                self.current_session["bets"] = session_bets
                self.current_session["_last_saved"] = datetime.now(timezone.utc).isoformat()
                self.current_session["summary"]["total_bets"] = len(session_bets)
                self.current_session["summary"]["total_stake"] = round(
                    sum(b.get("size", 0) for b in session_bets), 2)
                self.current_session["summary"]["total_liability"] = round(
                    sum(b.get("liability", 0) for b in session_bets), 2)
                self._save_sessions()
        except Exception as e:
            logger.warning(f"Failed to save state: {e}")

    def _load_state(self):
        """Reload state from GCS (preferred) or disk after a cold start."""
        try:
            raw = _gcs_read("chimera_engine_state.json")
            if raw:
                data = json.loads(raw)
            elif STATE_FILE.exists():
                data = json.loads(STATE_FILE.read_text())
            else:
                return

            # Only reload if same day
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if data.get("day_started") != today:
                logger.info("State file is from a different day — starting fresh")
                STATE_FILE.unlink(missing_ok=True)
                return

            self.day_started = data["day_started"]
            self.processed_markets = set(data.get("processed_markets", []))
            self.processed_runners = set(
                tuple(x) for x in data.get("processed_runners", [])
            )
            self.results = data.get("results", [])
            self.bets_placed = data.get("bets_placed", [])
            self.errors = data.get("errors", [])
            self.last_scan = data.get("last_scan")
            self.dry_run = data.get("dry_run", DRY_RUN)
            self.countries = data.get("countries", ["GB", "IE"])
            self.balance = data.get("balance")

            logger.info(
                f"Restored state: {len(self.processed_markets)} processed markets, "
                f"{len(self.bets_placed)} bets from today"
            )
        except Exception as e:
            logger.warning(f"Failed to load state: {e}")

    # ──────────────────────────────────────────────
    #  SESSION PERSISTENCE
    # ──────────────────────────────────────────────

    def _load_sessions(self):
        """Load session history from GCS (preferred) or disk."""
        try:
            raw = _gcs_read("chimera_sessions.json")
            if raw:
                self.sessions = json.loads(raw)
            elif SESSIONS_FILE.exists():
                self.sessions = json.loads(SESSIONS_FILE.read_text())
            else:
                return
            # If last session was RUNNING, it crashed (e.g. Cloud Run restart)
            if self.sessions and self.sessions[-1].get("status") == "RUNNING":
                crashed = self.sessions[-1]
                crashed["status"] = "CRASHED"
                crashed["stop_time"] = crashed.get(
                    "_last_saved", datetime.now(timezone.utc).isoformat()
                )
                self._save_sessions()
            logger.info(f"Loaded {len(self.sessions)} historical sessions")
        except Exception as e:
            logger.warning(f"Failed to load sessions: {e}")
            self.sessions = []

    def _save_sessions(self):
        """Persist session history to disk + GCS."""
        try:
            sessions_json = json.dumps(self.sessions, default=str)
            SESSIONS_FILE.write_text(sessions_json)
            _gcs_write("chimera_sessions.json", sessions_json)
        except Exception as e:
            logger.warning(f"Failed to save sessions: {e}")

    def _finalize_session(self, status: str):
        """Snapshot bets/results into the session and close it."""
        now = datetime.now(timezone.utc)
        session_bets = self.bets_placed[self._session_bets_start_index:]
        start_iso = self.current_session["start_time"]
        session_results = [
            r for r in self.results
            if r.get("evaluated_at", "") >= start_iso
        ]
        self.current_session["stop_time"] = now.isoformat()
        self.current_session["status"] = status
        self.current_session["bets"] = session_bets
        self.current_session["results"] = session_results
        self.current_session["summary"] = {
            "total_bets": len(session_bets),
            "total_stake": round(sum(b.get("size", 0) for b in session_bets), 2),
            "total_liability": round(sum(b.get("liability", 0) for b in session_bets), 2),
            "markets_processed": len(set(
                r.get("market_id") for r in session_results if not r.get("skipped")
            )),
        }
        self.current_session = None
        self._save_sessions()

    # ──────────────────────────────────────────────
    #  API KEY MANAGEMENT
    # ──────────────────────────────────────────────

    def _load_api_keys(self):
        """Load API keys from GCS (preferred) or disk."""
        try:
            raw = _gcs_read("chimera_api_keys.json")
            if raw:
                self.api_keys = json.loads(raw)
            elif API_KEYS_FILE.exists():
                self.api_keys = json.loads(API_KEYS_FILE.read_text())
            else:
                self.api_keys = []
            logger.info(f"Loaded {len(self.api_keys)} API keys")
        except Exception as e:
            logger.warning(f"Failed to load API keys: {e}")
            self.api_keys = []

    def _save_api_keys(self):
        """Persist API keys to disk + GCS."""
        try:
            keys_json = json.dumps(self.api_keys, default=str)
            API_KEYS_FILE.write_text(keys_json)
            _gcs_write("chimera_api_keys.json", keys_json)
        except Exception as e:
            logger.warning(f"Failed to save API keys: {e}")

    def generate_api_key(self, label: str = "") -> dict:
        """Generate a new API key. Returns the full key (only shown once)."""
        key = f"chm_{secrets.token_hex(24)}"
        key_record = {
            "key_id": secrets.token_hex(8),
            "key_hash": secrets.token_hex(4),  # Short suffix for display
            "key": key,
            "label": label or "Untitled",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_used": None,
        }
        self.api_keys.append(key_record)
        self._save_api_keys()
        logger.info(f"Generated API key: {key_record['key_id']} ({label})")
        return key_record

    def list_api_keys(self) -> list[dict]:
        """Return all keys with the actual key masked."""
        return [
            {
                "key_id": k["key_id"],
                "label": k["label"],
                "key_preview": k["key"][:8] + "..." + k["key"][-4:],
                "created_at": k["created_at"],
                "last_used": k["last_used"],
            }
            for k in self.api_keys
        ]

    def revoke_api_key(self, key_id: str) -> bool:
        """Revoke an API key by its ID. Returns True if found and removed."""
        before = len(self.api_keys)
        self.api_keys = [k for k in self.api_keys if k["key_id"] != key_id]
        if len(self.api_keys) < before:
            self._save_api_keys()
            logger.info(f"Revoked API key: {key_id}")
            return True
        return False

    def validate_api_key(self, key: str) -> bool:
        """Check if a key is valid. Updates last_used timestamp."""
        for k in self.api_keys:
            if k["key"] == key:
                k["last_used"] = datetime.now(timezone.utc).isoformat()
                return True
        return False

    # ──────────────────────────────────────────────
    #  AUTHENTICATION
    # ──────────────────────────────────────────────

    def login(self, username: str, password: str) -> tuple[bool, str]:
        """Validate credentials against Betfair SSO. Returns (success, error_msg)."""
        self.client = BetfairClient(
            app_key=BETFAIR_APP_KEY,
            username=username,
            password=password,
        )
        if self.client.login():
            self.balance = self.client.get_account_balance()
            # Store credentials for re-auth after cold start
            self._username = username
            self._password = password
            return True, ""
        error = self.client.last_login_error or "unknown"
        self.client = None
        return False, error

    def logout(self):
        """Clear credentials and stop engine."""
        self.stop()
        self.client = None
        self._username = None
        self._password = None

    @property
    def is_authenticated(self) -> bool:
        return self.client is not None and self.client.session_token is not None

    # ──────────────────────────────────────────────
    #  ENGINE LIFECYCLE
    # ──────────────────────────────────────────────

    def start(self):
        """Start the engine loop in a background thread."""
        if self.client is None:
            raise RuntimeError("Cannot start engine: not authenticated")
        if self.running:
            return
        self.running = True
        self.status = "STARTING"

        # ── Create new session ──
        now = datetime.now(timezone.utc)
        session_id = f"ses_{now.strftime('%Y%m%d_%H%M%S')}"
        self.current_session = {
            "session_id": session_id,
            "mode": "DRY_RUN" if self.dry_run else "LIVE",
            "date": now.strftime("%Y-%m-%d"),
            "start_time": now.isoformat(),
            "stop_time": None,
            "status": "RUNNING",
            "bets": [],
            "results": [],
            "summary": {
                "total_bets": 0,
                "total_stake": 0,
                "total_liability": 0,
                "markets_processed": 0,
            },
        }
        self._session_bets_start_index = len(self.bets_placed)
        self.sessions.append(self.current_session)
        self._save_sessions()

        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        logger.info("Engine started")

    def stop(self):
        """Stop the engine loop."""
        self.running = False
        self.status = "STOPPED"
        if self.current_session:
            self._finalize_session("COMPLETED")
        self._save_state()
        logger.info("Engine stopped")

    def _run_loop(self):
        """Main engine loop."""
        # Verify session is still valid
        if not self.client.ensure_session():
            self.status = "AUTH_FAILED"
            self._add_error("Session expired and re-authentication failed")
            self.running = False
            if self.current_session:
                self._finalize_session("CRASHED")
            return

        self.balance = self.client.get_account_balance()
        logger.info(f"Account balance: £{self.balance}")

        self.status = "RUNNING"
        logger.info(
            f"Engine running (DRY_RUN={self.dry_run}, POLL={POLL_INTERVAL}s)"
        )

        scan_count = 0
        while self.running:
            try:
                self._check_day_rollover()
                self._scan_and_process()

                # Persist state every 5 scans (~2.5 min at 30s interval)
                scan_count += 1
                if scan_count % 5 == 0:
                    self._save_state()

            except Exception as e:
                logger.error(f"Engine loop error: {e}")
                self._add_error(f"Loop error: {e}")

            time.sleep(POLL_INTERVAL)

    def _check_day_rollover(self):
        """Reset state at midnight UTC."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self.day_started:
            logger.info(f"Day rollover: {self.day_started} → {today}")
            self.markets = []
            self.results = []
            self.bets_placed = []
            self.processed_markets = set()
            self.processed_runners = set()
            self.errors = []
            self.day_started = today
            self._session_bets_start_index = 0

    # ──────────────────────────────────────────────
    #  CORE LOGIC
    # ──────────────────────────────────────────────

    def _scan_and_process(self):
        """
        Discover markets and process any that are ready.

        FIX: Always fetch real markets from Betfair, regardless of dry_run.
        DRY_RUN only affects whether the final placeOrders call is made.
        """
        now = datetime.now(timezone.utc)
        self.last_scan = now.isoformat()

        # ── ALWAYS fetch real markets (dry_run or not) ──
        if not self.client.ensure_session():
            self._add_error("Session expired during scan")
            return

        self.markets = self.client.get_todays_win_markets(countries=self.countries)

        logger.info(
            f"Scan: {len(self.markets)} markets, "
            f"{len(self.processed_markets)} processed, "
            f"{len(self.bets_placed)} bets placed"
        )

        for market in self.markets:
            market_id = market["market_id"]

            # Skip if already processed
            if market_id in self.processed_markets:
                continue

            # Parse race time
            try:
                race_time = datetime.fromisoformat(
                    market["race_time"].replace("Z", "+00:00")
                )
            except (ValueError, KeyError):
                continue

            minutes_to_race = (race_time - now).total_seconds() / 60

            if minutes_to_race < 0:
                # Race has started — mark as processed, we missed it
                self.processed_markets.add(market_id)
                continue

            # ── Process as soon as market is found (pre-off) ──
            logger.info(
                f"Processing {market['venue']} {market['market_name']} "
                f"({minutes_to_race:.1f}m to off)"
            )
            self._process_market(market)

    def _process_market(self, market: dict):
        """
        Fetch prices, apply rules, place bets for a single market.

        FIX: Always fetches real prices from Betfair. DRY_RUN only
        skips the actual placeOrders call — everything else runs for real.
        """
        market_id = market["market_id"]
        self.processed_markets.add(market_id)

        # ── Step 1: Get current prices (ALWAYS — even in dry run) ──
        runners_with_prices, is_valid = self.client.get_market_prices(market_id)

        if not is_valid or not runners_with_prices:
            skip_reason = "No prices available, market closed, or in-play"
            result = RuleResult(
                market_id=market_id,
                market_name=market["market_name"],
                venue=market["venue"],
                race_time=market["race_time"],
                instructions=[],
                skipped=True,
                skip_reason=skip_reason,
            )
            self.results.append(result.to_dict())
            logger.info(f"Skipped {market['venue']}: {skip_reason}")
            return

        # Merge runner names from catalogue into price data
        name_map = {
            r["selection_id"]: r["runner_name"]
            for r in market.get("runners", [])
        }
        for runner in runners_with_prices:
            if runner.selection_id in name_map:
                runner.runner_name = name_map[runner.selection_id]

        # ── Step 2: Apply rules (ALWAYS — even in dry run) ──
        result = apply_rules(
            market_id=market_id,
            market_name=market["market_name"],
            venue=market["venue"],
            race_time=market["race_time"],
            runners=runners_with_prices,
        )

        self.results.append(result.to_dict())

        if result.skipped:
            logger.info(f"Skipped {market['venue']}: {result.skip_reason}")
            return

        # ── Step 3: Place the bets ──
        logger.info(
            f"Rule applied: {result.rule_applied} — "
            f"{len(result.instructions)} bet(s) to place"
        )

        for instruction in result.instructions:
            runner_key = (instruction.runner_name, market["race_time"])
            if runner_key in self.processed_runners:
                logger.info(
                    f"SKIPPED DUPLICATE: {instruction.runner_name} "
                    f"already bet on for race {market['race_time']}"
                )
                continue
            self._place_bet(instruction, venue=market["venue"], country=market.get("country", ""))
            self.processed_runners.add(runner_key)

    def _place_bet(self, instruction, venue: str = "", country: str = ""):
        """
        Place a single lay bet via the Betfair API.

        FIX: In DRY_RUN mode, logs everything but doesn't call placeOrders.
        Previously, DRY_RUN prevented markets and prices from even being fetched.
        """
        logger.info(
            f"{'[DRY RUN] ' if self.dry_run else ''}"
            f"PLACING: LAY {instruction.runner_name} @ {instruction.price} "
            f"£{instruction.size} (liability £{instruction.liability}) "
            f"[{instruction.rule_applied}]"
        )

        if self.dry_run:
            bet_record = {
                **instruction.to_dict(),
                "venue": venue,
                "country": country,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "dry_run": True,
                "betfair_response": {"status": "DRY_RUN"},
            }
            self.bets_placed.append(bet_record)
            return

        response = self.client.place_lay_order(
            market_id=instruction.market_id,
            selection_id=instruction.selection_id,
            price=instruction.price,
            size=instruction.size,
        )

        bet_record = {
            **instruction.to_dict(),
            "venue": venue,
            "country": country,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "dry_run": False,
            "betfair_response": response,
        }
        self.bets_placed.append(bet_record)

        if response.get("status") == "SUCCESS":
            logger.info(
                f"✓ BET PLACED: {instruction.runner_name} — "
                f"betId={response.get('bet_id')}, "
                f"matched=£{response.get('size_matched', 0)}"
            )
        else:
            logger.warning(
                f"✗ BET FAILED: {instruction.runner_name} — "
                f"error={response.get('error_code', 'unknown')}"
            )
            self._add_error(
                f"Bet failed on {instruction.runner_name}: "
                f"{response.get('error_code', 'unknown')}"
            )

    # ──────────────────────────────────────────────
    #  STATE ACCESS (for API)
    # ──────────────────────────────────────────────

    def get_state(self) -> dict:
        """Return current engine state for the frontend."""
        now = datetime.now(timezone.utc)

        # Upcoming = not yet processed
        upcoming = []
        for m in self.markets:
            if m["market_id"] not in self.processed_markets:
                try:
                    rt = datetime.fromisoformat(m["race_time"].replace("Z", "+00:00"))
                    if rt > now:
                        m_copy = dict(m)
                        m_copy["minutes_to_off"] = round((rt - now).total_seconds() / 60, 1)
                        upcoming.append(m_copy)
                except (ValueError, KeyError):
                    pass

        upcoming.sort(key=lambda x: x.get("race_time", ""))

        # Daily P&L summary
        total_stake = sum(b.get("size", 0) for b in self.bets_placed)
        total_liability = sum(b.get("liability", 0) for b in self.bets_placed)

        return {
            "authenticated": self.is_authenticated,
            "status": self.status,
            "dry_run": self.dry_run,
            "countries": self.countries,
            "date": self.day_started,
            "last_scan": self.last_scan,
            "balance": self.balance,
            "summary": {
                "total_markets": len(self.markets),
                "processed": len(self.processed_markets),
                "bets_placed": len(self.bets_placed),
                "total_stake": round(total_stake, 2),
                "total_liability": round(total_liability, 2),
            },
            "upcoming": upcoming[:10],
            "recent_bets": list(reversed(self.bets_placed)),
            "recent_results": list(reversed(self.results)),
            "errors": self.errors[-10:],
        }

    def reset_bets(self):
        """Clear all processed markets, bets, and results so the engine can re-process."""
        self.processed_markets.clear()
        self.processed_runners.clear()
        self.bets_placed.clear()
        self.results.clear()
        self._session_bets_start_index = 0
        self._save_state()
        logger.info("Bets and processed markets cleared — all markets will be re-processed")

    def get_sessions(self) -> list[dict]:
        """Return all session summaries (no bets) in reverse chronological order."""
        summaries = []
        for s in reversed(self.sessions):
            summaries.append({
                "session_id": s["session_id"],
                "mode": s["mode"],
                "date": s["date"],
                "start_time": s["start_time"],
                "stop_time": s["stop_time"],
                "status": s["status"],
                "summary": s["summary"],
            })
        return summaries

    def get_session_detail(self, session_id: str) -> Optional[dict]:
        """Return full session detail including all bets and results."""
        for s in self.sessions:
            if s["session_id"] == session_id:
                return {k: v for k, v in s.items() if not k.startswith("_")}
        return None

    def _add_error(self, msg: str):
        self.errors.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": msg,
        })
