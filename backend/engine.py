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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from betfair_client import BetfairClient
from rules import Runner, apply_rules, RuleResult, check_spread
from kelly import KellyConfig, calculate_kelly_stake
from signal_filters import SignalConfig, apply_signal_filters, get_odds_band

logger = logging.getLogger("engine")

# ── Configuration from environment ──
BETFAIR_APP_KEY = os.environ.get("BETFAIR_APP_KEY", "")

# Dry run mode (log but don't place real bets)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Poll interval in seconds
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))

# Processing window: only place bets within this many minutes of race start.
# Prevents placing bets hours early with meaningless early-morning prices.
PROCESS_WINDOW_MINUTES = int(os.environ.get("PROCESS_WINDOW_MINUTES", "12"))

# State file for Cloud Run cold-start recovery
STATE_FILE = Path(os.environ.get("STATE_FILE", "/tmp/chimera_engine_state.json"))

# Session history file (persists across days, separate from daily state)
SESSIONS_FILE = Path(os.environ.get("SESSIONS_FILE", "/tmp/chimera_sessions.json"))

# API keys file
API_KEYS_FILE = Path(os.environ.get("API_KEYS_FILE", "/tmp/chimera_api_keys.json"))

# Reports file
REPORTS_FILE = Path(os.environ.get("REPORTS_FILE", "/tmp/chimera_reports.json"))

# Dry-run snapshots file
SNAPSHOTS_FILE = Path(os.environ.get("SNAPSHOTS_FILE", "/tmp/chimera_snapshots.json"))

# Daily stats cache (authoritative P/L per date, built from settled bets when reports are generated)
STATS_CACHE_FILE = Path(os.environ.get("STATS_CACHE_FILE", "/tmp/chimera_stats_cache.json"))

# App settings file (recipients, data sources, AI capabilities)
SETTINGS_FILE = Path(os.environ.get("SETTINGS_FILE", "/tmp/chimera_settings.json"))

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
        self.spread_control: bool = False  # Spread validation off by default
        self.spread_rejections: list[dict] = []  # Log of rejected bets
        self.point_value: float = 1.0  # £ per point (multiplier for all stakes)
        self.jofs_control: bool = True   # Joint/Close-Odds Favourite Split on by default
        self.mark_ceiling_enabled: bool = False  # Mark Rule: no lays above 8.0
        self.mark_floor_enabled: bool = False    # Mark Rule: no lays below 1.5
        self.mark_uplift_enabled: bool = False   # Mark Rule: 2.5–3.5 band stake uplift
        self.mark_uplift_stake: float = 3.0    # Mark Rule: uplift stake value (pts)

        # ── Kelly Criterion ──
        self.kelly_config: KellyConfig = KellyConfig()

        # ── Signal Filters (market intelligence layer) ──
        self.signal_config: SignalConfig = SignalConfig()
        self.signal_rejections: list[dict] = []  # Log of signal-filtered bets

        # ── Processing window ──
        self.process_window: float = PROCESS_WINDOW_MINUTES  # Configurable at runtime
        self.monitoring: dict = {}      # market_id → list of odds snapshots
        self.next_race: Optional[dict] = None  # Nearest unprocessed race

        # ── Credentials for re-auth after cold start ──
        self._username: Optional[str] = None
        self._password: Optional[str] = None
        self._last_balance_fetch: float = 0  # timestamp for caching

        # ── Session tracking ──
        self.sessions: list[dict] = []
        self.current_session: Optional[dict] = None
        self._session_bets_start_index: int = 0

        # ── API keys ──
        self.api_keys: list[dict] = []

        # ── Reports ──
        self.reports: list[dict] = []

        # ── Daily stats cache: authoritative P/L per date, populated when reports are generated ──
        self.daily_stats_cache: dict = {}  # date (YYYY-MM-DD) → _compute_day_stats output

        # ── Dry-run snapshots ──
        self.dry_run_snapshots: list[dict] = []

        # ── App settings (recipients, data sources, AI caps) ──
        self.settings: dict = {
            "report_recipients": [],        # [{email, name}]
            "ai_data_sources": {            # Which data sources AI can access
                "session_data": True,
                "settled_bets": True,
                "historical_summary": True,
                "engine_state": True,
                "rule_definitions": True,
                "backtest_results": False,
                "github_codebase": False,
            },
            "ai_capabilities": {            # Which actions the AI agent can take
                "send_emails": False,
                "write_reports": True,
                "fetch_files": False,
                "github_access": False,
            },
        }

        # ── Background market refresh (runs when authenticated but engine stopped) ──
        self._market_thread: Optional[threading.Thread] = None
        self._market_refresh_active: bool = False

        # Try to reload state from disk (Cloud Run cold-start recovery)
        self._load_state()
        self._load_sessions()
        self._load_api_keys()
        self._load_reports()
        self._load_snapshots()
        self._load_settings()
        self._load_stats_cache()

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
                "spread_control": self.spread_control,
                "jofs_control": self.jofs_control,
                "mark_ceiling_enabled": self.mark_ceiling_enabled,
                "mark_floor_enabled": self.mark_floor_enabled,
                "mark_uplift_enabled": self.mark_uplift_enabled,
                "mark_uplift_stake": self.mark_uplift_stake,
                "point_value": self.point_value,
                "process_window": self.process_window,
                "kelly_enabled": self.kelly_config.enabled,
                "kelly_fraction": self.kelly_config.fraction,
                "kelly_bankroll": self.kelly_config.bankroll,
                "kelly_edge_pct": self.kelly_config.edge_pct,
                "kelly_min_stake": self.kelly_config.min_stake,
                "kelly_max_stake": self.kelly_config.max_stake,
                # Signal filters
                "signal_overround_enabled": self.signal_config.overround_enabled,
                "signal_field_size_enabled": self.signal_config.field_size_enabled,
                "signal_steam_gate_enabled": self.signal_config.steam_gate_enabled,
                "signal_band_perf_enabled": self.signal_config.band_perf_enabled,
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
                summary = self.current_session.setdefault("summary", {})
                summary["total_bets"] = len(session_bets)
                summary["total_stake"] = round(
                    sum(b.get("size", 0) for b in session_bets), 2)
                summary["total_liability"] = round(
                    sum(b.get("liability", 0) for b in session_bets), 2)
                if self.current_session.get("mode") == "DRY_RUN":
                    dry_settled = [
                        b for b in session_bets
                        if b.get("dry_run") and b.get("outcome") in ("WIN", "LOSS")
                    ]
                    summary["paper_pnl"] = round(
                        sum(b.get("pnl", 0) for b in dry_settled), 2)
                    summary["paper_wins"] = sum(
                        1 for b in dry_settled if b.get("outcome") == "WIN")
                    summary["paper_losses"] = sum(
                        1 for b in dry_settled if b.get("outcome") == "LOSS")
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
            self.spread_control = data.get("spread_control", False)
            self.jofs_control = data.get("jofs_control", True)
            self.mark_ceiling_enabled = data.get("mark_ceiling_enabled", False)
            self.mark_floor_enabled = data.get("mark_floor_enabled", False)
            self.mark_uplift_enabled = data.get("mark_uplift_enabled", False)
            self.mark_uplift_stake = data.get("mark_uplift_stake", 3.0)
            self.point_value = data.get("point_value", 1.0)
            self.process_window = data.get("process_window", PROCESS_WINDOW_MINUTES)
            self.balance = data.get("balance")
            self.kelly_config = KellyConfig.from_dict(data)
            # Signal filter config
            self.signal_config.overround_enabled = data.get("signal_overround_enabled", False)
            self.signal_config.field_size_enabled = data.get("signal_field_size_enabled", False)
            self.signal_config.steam_gate_enabled = data.get("signal_steam_gate_enabled", False)
            self.signal_config.band_perf_enabled = data.get("signal_band_perf_enabled", False)

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
        countries = sorted(set(
            b.get("country") for b in session_bets if b.get("country")
        ))
        dry_settled = [
            b for b in session_bets
            if b.get("dry_run") and b.get("outcome") in ("WIN", "LOSS")
        ]
        summary = {
            "total_bets": len(session_bets),
            "total_stake": round(sum(b.get("size", 0) for b in session_bets), 2),
            "total_liability": round(sum(b.get("liability", 0) for b in session_bets), 2),
            "markets_processed": len(set(
                r.get("market_id") for r in session_results if not r.get("skipped")
            )),
            "countries": countries,
        }
        if self.current_session.get("mode") == "DRY_RUN":
            summary["paper_pnl"] = round(sum(b.get("pnl", 0) for b in dry_settled), 2)
            summary["paper_wins"] = sum(1 for b in dry_settled if b.get("outcome") == "WIN")
            summary["paper_losses"] = sum(1 for b in dry_settled if b.get("outcome") == "LOSS")
        self.current_session["summary"] = summary
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

    def _load_reports(self):
        """Load reports from GCS (preferred) or disk."""
        try:
            raw = _gcs_read("chimera_reports.json")
            if raw:
                self.reports = json.loads(raw)
            elif REPORTS_FILE.exists():
                self.reports = json.loads(REPORTS_FILE.read_text())
            else:
                self.reports = []
            logger.info(f"Loaded {len(self.reports)} reports")
        except Exception as e:
            logger.warning(f"Failed to load reports: {e}")
            self.reports = []

    def _save_reports(self):
        """Persist reports to disk + GCS."""
        try:
            reports_json = json.dumps(self.reports, default=str)
            REPORTS_FILE.write_text(reports_json)
            _gcs_write("chimera_reports.json", reports_json)
        except Exception as e:
            logger.warning(f"Failed to save reports: {e}")

    # ──────────────────────────────────────────────
    #  SNAPSHOT PERSISTENCE
    # ──────────────────────────────────────────────

    def _load_snapshots(self):
        """Load dry-run snapshots from GCS (preferred) or disk. Purge entries older than 90 days."""
        try:
            raw = _gcs_read("chimera_snapshots.json")
            if raw:
                self.dry_run_snapshots = json.loads(raw)
            elif SNAPSHOTS_FILE.exists():
                self.dry_run_snapshots = json.loads(SNAPSHOTS_FILE.read_text())
            else:
                self.dry_run_snapshots = []

            # 90-day retention: purge old entries
            cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
            before = len(self.dry_run_snapshots)
            self.dry_run_snapshots = [
                s for s in self.dry_run_snapshots
                if s.get("created_at", "") >= cutoff
            ]
            if len(self.dry_run_snapshots) < before:
                logger.info(f"Purged {before - len(self.dry_run_snapshots)} snapshots older than 90 days")
                self._save_snapshots()

            logger.info(f"Loaded {len(self.dry_run_snapshots)} dry-run snapshots")
        except Exception as e:
            logger.warning(f"Failed to load snapshots: {e}")
            self.dry_run_snapshots = []

    def _save_snapshots(self):
        """Persist dry-run snapshots to disk + GCS."""
        try:
            snapshots_json = json.dumps(self.dry_run_snapshots, default=str)
            SNAPSHOTS_FILE.write_text(snapshots_json)
            _gcs_write("chimera_snapshots.json", snapshots_json)
        except Exception as e:
            logger.warning(f"Failed to save snapshots: {e}")

    def _load_settings(self):
        """Load app settings from GCS (preferred) or disk."""
        defaults = {
            "report_recipients": [],
            "ai_data_sources": {
                "session_data": True, "settled_bets": True,
                "historical_summary": True, "engine_state": True,
                "rule_definitions": True, "backtest_results": False,
                "github_codebase": False,
            },
            "ai_capabilities": {
                "send_emails": False, "write_reports": True,
                "fetch_files": False, "github_access": False,
            },
        }
        try:
            raw = _gcs_read("chimera_settings.json")
            if raw:
                loaded = json.loads(raw)
            elif SETTINGS_FILE.exists():
                loaded = json.loads(SETTINGS_FILE.read_text())
            else:
                loaded = {}
            # Merge with defaults so new keys are always present
            for key, default_val in defaults.items():
                if key not in loaded:
                    loaded[key] = default_val
                elif isinstance(default_val, dict):
                    for k, v in default_val.items():
                        loaded[key].setdefault(k, v)
            self.settings = loaded
            logger.info(f"Loaded settings ({len(self.settings.get('report_recipients', []))} recipients)")
        except Exception as e:
            logger.warning(f"Failed to load settings: {e}")
            self.settings = defaults

    def _save_settings(self):
        """Persist app settings to disk + GCS."""
        try:
            settings_json = json.dumps(self.settings, default=str)
            SETTINGS_FILE.write_text(settings_json)
            _gcs_write("chimera_settings.json", settings_json)
        except Exception as e:
            logger.warning(f"Failed to save settings: {e}")

    def _load_stats_cache(self):
        """Load daily stats cache from GCS (preferred) or disk."""
        try:
            raw = _gcs_read("chimera_stats_cache.json")
            if raw:
                self.daily_stats_cache = json.loads(raw)
            elif STATS_CACHE_FILE.exists():
                self.daily_stats_cache = json.loads(STATS_CACHE_FILE.read_text())
            else:
                self.daily_stats_cache = {}
            logger.info(f"Loaded stats cache ({len(self.daily_stats_cache)} dates)")
        except Exception as e:
            logger.warning(f"Failed to load stats cache: {e}")
            self.daily_stats_cache = {}

    def _save_stats_cache(self):
        """Persist daily stats cache to disk + GCS."""
        try:
            cache_json = json.dumps(self.daily_stats_cache, default=str)
            STATS_CACHE_FILE.write_text(cache_json)
            _gcs_write("chimera_stats_cache.json", cache_json)
        except Exception as e:
            logger.warning(f"Failed to save stats cache: {e}")

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
            # Fetch markets immediately so the Live tab has data without starting the engine
            try:
                self.markets = self.client.get_todays_win_markets(countries=self.countries)
                logger.info(f"Initial market fetch on login: {len(self.markets)} markets")
            except Exception as e:
                logger.warning(f"Initial market fetch failed: {e}")
            # Start background refresh so markets stay current
            self._start_market_refresh()
            return True, ""
        error = self.client.last_login_error or "unknown"
        self.client = None
        return False, error

    def logout(self):
        """Clear credentials and stop engine."""
        self._market_refresh_active = False
        self.stop()
        self.client = None
        self._username = None
        self._password = None

    def _start_market_refresh(self):
        """Spawn a daemon thread that refreshes markets every 3 minutes when not running."""
        self._market_refresh_active = True
        if self._market_thread and self._market_thread.is_alive():
            return
        self._market_thread = threading.Thread(target=self._market_refresh_loop, daemon=True)
        self._market_thread.start()
        logger.info("Background market refresh thread started")

    def _market_refresh_loop(self):
        """Background thread: refresh markets every 3 minutes while authenticated and engine stopped."""
        while self._market_refresh_active and self.is_authenticated:
            time.sleep(180)  # 3 minutes
            if not self._market_refresh_active or not self.is_authenticated:
                break
            if self.running:
                continue  # engine loop handles its own market fetching
            try:
                fresh = self.client.get_todays_win_markets(countries=self.countries)
                if fresh is not None:
                    self.markets = fresh
                    logger.info(f"Background market refresh: {len(fresh)} markets")
            except Exception as e:
                logger.warning(f"Background market refresh error: {e}")

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
            self.monitoring = {}
            self.next_race = None
            self.errors = []
            self.spread_rejections = []
            self.signal_rejections = []
            self.day_started = today
            self._session_bets_start_index = 0

    # ──────────────────────────────────────────────
    #  CORE LOGIC
    # ──────────────────────────────────────────────

    def _scan_and_process(self):
        """
        Discover markets, monitor odds outside the window, and process
        within the betting window.

        TIMING FIX: The engine previously placed bets the moment markets
        were discovered (e.g. 07:00 prices for a 16:30 race). Now it only
        processes markets within `process_window` minutes of race start.
        Outside the window, odds snapshots are logged for drift analysis.

        BEHAVIOUR:
          - Fetches today's market catalogue from Betfair (every scan)
          - If minutes_to_off > process_window  → take odds snapshot (monitoring)
          - If 0 < minutes_to_off ≤ process_window → fetch prices, apply rules, place bets
          - If minutes_to_off ≤ 0 → missed, mark processed
          - Engine can be started once at 08:00 and runs all day unattended
        """
        now = datetime.now(timezone.utc)
        self.last_scan = now.isoformat()

        if not self.client.ensure_session():
            # Count consecutive auth/network failures — only log as error after 3 in a row
            # so a brief laptop offline does not litter the error list.
            self._net_fail_count = getattr(self, "_net_fail_count", 0) + 1
            if self._net_fail_count >= 3:
                self._add_error(
                    f"Session unavailable — {self._net_fail_count} consecutive scan(s) skipped"
                )
                self._net_fail_count = 0  # Reset so we get one error per burst, not a flood
            else:
                logger.warning(
                    f"Session check failed (transient?) — scan skipped "
                    f"({self._net_fail_count}/3 before error is recorded)"
                )
            return
        # Session good — reset failure counter
        self._net_fail_count = 0

        self.markets = self.client.get_todays_win_markets(countries=self.countries)

        logger.info(
            f"Scan: {len(self.markets)} markets, "
            f"{len(self.processed_markets)} processed, "
            f"{len(self.bets_placed)} bets placed, "
            f"window={self.process_window}m"
        )

        # Reset next_race tracker each scan
        self.next_race = None
        nearest_minutes = float("inf")

        for market in self.markets:
            market_id = market["market_id"]

            # Skip if already processed (bets placed or missed)
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

            # ── Race has started — mark missed ──
            if minutes_to_race < 0:
                self.processed_markets.add(market_id)
                if market_id in self.monitoring:
                    del self.monitoring[market_id]
                logger.info(
                    f"MISSED: {market['venue']} {market['market_name']} "
                    f"(started {abs(minutes_to_race):.0f}m ago)"
                )
                continue

            # ── Track nearest upcoming race for dashboard ──
            if minutes_to_race < nearest_minutes:
                nearest_minutes = minutes_to_race
                self.next_race = {
                    "market_id": market_id,
                    "venue": market["venue"],
                    "market_name": market["market_name"],
                    "race_time": market["race_time"],
                    "minutes_to_off": round(minutes_to_race, 1),
                    "country": market.get("country", ""),
                    "status": "IN_WINDOW" if minutes_to_race <= self.process_window else "MONITORING",
                }

            # ── INSIDE window — fetch prices, apply rules, place bets ──
            if minutes_to_race <= self.process_window:
                logger.info(
                    f"⏰ WINDOW HIT: {market['venue']} {market['market_name']} "
                    f"({minutes_to_race:.1f}m to off) — processing now"
                )
                self._process_market(market)
                # Clean up monitoring data for this market
                if market_id in self.monitoring:
                    del self.monitoring[market_id]

            # ── OUTSIDE window — take an odds snapshot for monitoring ──
            else:
                self._monitor_market(market, minutes_to_race)

        # ── Update session monitoring count ──
        if self.current_session:
            self.current_session.setdefault("summary", {})["markets_monitoring"] = len(self.monitoring)

        # ── Settle any dry-run bets whose races have now finished ──
        self._settle_dry_run_bets()

    def _monitor_market(self, market: dict, minutes_to_race: float):
        """
        Take an odds snapshot for a market outside the processing window.
        Snapshots feed drift analysis in reports and the AI agent.
        Only fires every 5 minutes per market to avoid API spam.
        """
        market_id = market["market_id"]

        # Rate-limit: only one snapshot per 5 minutes per market
        if market_id in self.monitoring and self.monitoring[market_id]:
            last_ts = self.monitoring[market_id][-1]["timestamp"]
            last_time = datetime.fromisoformat(last_ts)
            if (datetime.now(timezone.utc) - last_time).total_seconds() < 300:
                return

        try:
            runners_with_prices, is_valid = self.client.get_market_prices(market_id)
            if not is_valid or not runners_with_prices:
                return

            name_map = {
                r["selection_id"]: r["runner_name"]
                for r in market.get("runners", [])
            }

            snapshot = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "minutes_to_off": round(minutes_to_race, 1),
                "runners": [
                    {
                        "selection_id": r.selection_id,
                        "runner_name": name_map.get(r.selection_id, r.runner_name),
                        "lay_odds": r.best_available_to_lay,
                    }
                    for r in runners_with_prices
                    if r.status == "ACTIVE" and r.best_available_to_lay is not None
                ],
            }

            if market_id not in self.monitoring:
                self.monitoring[market_id] = []
            self.monitoring[market_id].append(snapshot)

            # Cap at 20 snapshots per market
            if len(self.monitoring[market_id]) > 20:
                self.monitoring[market_id] = self.monitoring[market_id][-20:]

            fav_odds = snapshot["runners"][0]["lay_odds"] if snapshot["runners"] else "?"
            logger.debug(
                f"📊 MONITORING: {market['venue']} {market['market_name']} "
                f"({minutes_to_race:.0f}m to off) — fav @ {fav_odds}"
            )

        except Exception as e:
            logger.debug(f"Monitor snapshot failed for {market_id}: {e}")

    # ──────────────────────────────────────────────
    #  SIGNAL FILTER HELPERS
    # ──────────────────────────────────────────────

    def _get_previous_prices(self, market_id: str) -> dict:
        """
        Return the earliest monitoring snapshot prices for a market.
        Used by the Steam Gate signal to detect price shortening.
        Returns {selection_id: lay_odds}
        """
        snapshots = self.monitoring.get(market_id, [])
        if not snapshots:
            return {}
        oldest = snapshots[0]
        return {
            r["selection_id"]: r["lay_odds"]
            for r in oldest.get("runners", [])
            if r.get("lay_odds") is not None
        }

    def _compute_band_stats(self, lookback_days: int = 5) -> dict:
        """
        Compute win rates per odds band over the last N days from settled bets.
        Scans both today's bets (self.bets_placed) and historical session
        records (self.sessions) so the full lookback window is populated
        from day one — not just the current session.
        Returns {band_name: {"wins": int, "total": int, "win_rate": float}}
        """
        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=lookback_days)
        ).isoformat()
        stats: dict = {}

        def _tally(bet):
            if bet.get("outcome") not in ("WIN", "LOSS"):
                return
            if bet.get("timestamp", "") < cutoff:
                return
            band = get_odds_band(bet.get("price", 0))
            if band not in stats:
                stats[band] = {"wins": 0, "total": 0}
            stats[band]["total"] += 1
            if bet.get("outcome") == "WIN":
                stats[band]["wins"] += 1

        # Today's live bets
        for bet in self.bets_placed:
            _tally(bet)

        # Historical sessions (covers the lookback window across past days)
        for session in self.sessions:
            # Skip the current active session — already covered by bets_placed
            if self.current_session and session.get("session_id") == self.current_session.get("session_id"):
                continue
            for bet in session.get("bets", []):
                _tally(bet)

        for band_data in stats.values():
            t = band_data["total"]
            band_data["win_rate"] = round(band_data["wins"] / t, 4) if t > 0 else 0.0
        return stats

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
            jofs_enabled=self.jofs_control,
            mark_ceiling_enabled=self.mark_ceiling_enabled,
            mark_floor_enabled=self.mark_floor_enabled,
            mark_uplift_enabled=self.mark_uplift_enabled,
            mark_uplift_stake=self.mark_uplift_stake,
        )

        # Apply point value multiplier to stakes
        if self.point_value != 1.0:
            for instruction in result.instructions:
                instruction.size = round(instruction.size * self.point_value, 2)

        # Apply Kelly Criterion sizing (replaces point-valued stake when enabled)
        if self.kelly_config.enabled:
            for instruction in result.instructions:
                instruction.size = calculate_kelly_stake(
                    lay_odds=instruction.price,
                    config=self.kelly_config,
                    base_stake=instruction.size,
                )

        self.results.append(result.to_dict())

        if result.skipped:
            logger.info(f"Skipped {market['venue']}: {result.skip_reason}")
            return

        # ── Step 2.5: Spread control validation (if enabled) ──
        # Build runner lookup for spread checks
        runner_lookup = {r.selection_id: r for r in runners_with_prices}

        # ── Step 2.6: Pre-compute signal filter inputs (once per market) ──
        previous_prices = self._get_previous_prices(market_id)
        band_stats = self._compute_band_stats(self.signal_config.band_perf_lookback_days)

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

            # ── Signal filters (market intelligence layer) ──
            any_signal_enabled = (
                self.signal_config.overround_enabled or
                self.signal_config.field_size_enabled or
                self.signal_config.steam_gate_enabled or
                self.signal_config.band_perf_enabled
            )
            if any_signal_enabled:
                sig_result = apply_signal_filters(
                    selection_id=instruction.selection_id,
                    current_price=instruction.price,
                    original_stake=instruction.size,
                    all_runners=runners_with_prices,
                    previous_prices=previous_prices,
                    band_stats=band_stats,
                    config=self.signal_config,
                )
                if not sig_result.allowed:
                    logger.warning(
                        f"[SIGNAL FILTER] BLOCKED: {instruction.runner_name} "
                        f"@ {market['venue']} — {sig_result.skip_reason}"
                    )
                    self.signal_rejections.append({
                        "runner": instruction.runner_name,
                        "venue": market["venue"],
                        "country": market.get("country", ""),
                        "market_id": market_id,
                        "price": instruction.price,
                        "original_stake": sig_result.original_stake,
                        "rule": instruction.rule_applied,
                        "signals_fired": sig_result.to_dict()["signals_fired"],
                        "reason": sig_result.skip_reason,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    self.processed_runners.add(runner_key)
                    continue
                # Apply adjusted stake if signals modified it
                if sig_result.final_stake != sig_result.original_stake:
                    logger.info(
                        f"[SIGNAL FILTER] STAKE ADJUSTED: {instruction.runner_name} "
                        f"£{sig_result.original_stake} → £{sig_result.final_stake} "
                        f"({', '.join(v.signal for v in sig_result.verdicts if v.fired)})"
                    )
                    instruction.size = sig_result.final_stake

            # ── Spread control check ──
            if self.spread_control:
                runner = runner_lookup.get(instruction.selection_id)
                if runner:
                    spread_result = check_spread(runner)
                    if not spread_result.passed:
                        logger.warning(
                            f"[SPREAD CONTROL] REJECTED: {instruction.runner_name} "
                            f"@ {market['venue']} — {spread_result.reason}"
                        )
                        self.spread_rejections.append({
                            "runner": instruction.runner_name,
                            "venue": market["venue"],
                            "country": market.get("country", ""),
                            "market_id": market_id,
                            "lay_price": spread_result.lay_price,
                            "back_price": spread_result.back_price,
                            "spread": spread_result.spread,
                            "max_spread": spread_result.max_spread,
                            "reason": spread_result.reason,
                            "rule": instruction.rule_applied,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                        self.processed_runners.add(runner_key)
                        continue

            self._place_bet(
                instruction,
                venue=market["venue"],
                country=market.get("country", ""),
                race_time=market.get("race_time", ""),
            )
            self.processed_runners.add(runner_key)

    def _place_bet(self, instruction, venue: str = "", country: str = "", race_time: str = ""):
        """
        Place a single lay bet via the Betfair API.

        FIX: In DRY_RUN mode, logs everything but doesn't call placeOrders.
        Previously, DRY_RUN prevented markets and prices from even being fetched.
        race_time is stored so dry-run settlement can look up results later.
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
                "race_time": race_time,
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
            "race_time": race_time,
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
    #  DRY RUN SETTLEMENT
    # ──────────────────────────────────────────────

    def _settle_dry_run_bets(self):
        """
        For each unsettled dry-run bet whose race has finished, look up the
        Betfair market result and record WIN / LOSS / UNKNOWN + paper P&L.

        Called every scan cycle.  One API call per unsettled market.
        Dry-run settlement works even when the engine is currently in LIVE
        mode (i.e. covers bets placed during an earlier dry-run session today).

        Outcome from the LAYER's perspective:
          WIN  — the horse we laid did NOT win → we keep the stake (pnl = +size)
          LOSS — the horse we laid WON         → we pay out (pnl = -liability)
        """
        if self.client is None:
            return

        now = datetime.now(timezone.utc)

        # Collect all dry-run bets that have no outcome yet
        unsettled = [
            b for b in self.bets_placed
            if b.get("dry_run") and "outcome" not in b
        ]
        if not unsettled:
            return

        # Group by market_id — one result lookup per market
        markets_to_check: dict[str, datetime] = {}
        for bet in unsettled:
            market_id = bet.get("market_id")
            race_time_str = bet.get("race_time")
            if not market_id or not race_time_str:
                continue
            try:
                race_time = datetime.fromisoformat(
                    race_time_str.replace("Z", "+00:00")
                )
            except ValueError:
                continue
            minutes_since = (now - race_time).total_seconds() / 60
            if minutes_since < 10:
                continue  # Race hasn't started + 10-min settlement buffer
            if market_id not in markets_to_check:
                markets_to_check[market_id] = race_time

        if not markets_to_check:
            return

        changed = False
        for market_id, race_time in markets_to_check.items():
            minutes_since = (now - race_time).total_seconds() / 60
            result = self.client.get_race_result(market_id)

            if result is None:
                # API returned nothing (market too old or not found)
                if minutes_since > 120:
                    # Give up after 2 hours — mark unknown
                    for bet in self.bets_placed:
                        if (bet.get("dry_run") and "outcome" not in bet
                                and bet.get("market_id") == market_id):
                            bet["outcome"] = "UNKNOWN"
                            bet["pnl"] = 0.0
                            changed = True
                continue

            if not result.get("settled"):
                continue  # Market not yet closed — try again next scan

            winner_id = result.get("winner_selection_id")
            for bet in self.bets_placed:
                if (bet.get("dry_run") and "outcome" not in bet
                        and bet.get("market_id") == market_id):
                    if winner_id is None:
                        bet["outcome"] = "UNKNOWN"
                        bet["pnl"] = 0.0
                    elif bet.get("selection_id") == winner_id:
                        bet["outcome"] = "LOSS"
                        bet["pnl"] = round(-bet.get("liability", 0), 2)
                    else:
                        bet["outcome"] = "WIN"
                        bet["pnl"] = round(bet.get("size", 0), 2)
                    changed = True
                    logger.info(
                        f"[DRY RUN SETTLED] {bet.get('runner_name')} "
                        f"@ {bet.get('venue', '?')}: {bet['outcome']} "
                        f"(P&L: £{bet['pnl']:+.2f})"
                    )

        if changed:
            self._save_state()

    # ──────────────────────────────────────────────
    #  STATE ACCESS (for API)
    # ──────────────────────────────────────────────

    def get_state(self) -> dict:
        """Return current engine state for the frontend."""
        now = datetime.now(timezone.utc)

        # Auto-refresh balance every 30 seconds
        if self.client and self.is_authenticated:
            if time.time() - self._last_balance_fetch > 30:
                try:
                    fresh_balance = self.client.get_account_balance()
                    if fresh_balance is not None:
                        self.balance = fresh_balance
                    self._last_balance_fetch = time.time()
                except Exception:
                    pass

        # Upcoming = not yet processed, enriched with window/monitoring state
        upcoming = []
        for m in self.markets:
            if m["market_id"] not in self.processed_markets:
                try:
                    rt = datetime.fromisoformat(m["race_time"].replace("Z", "+00:00"))
                    if rt > now:
                        m_copy = dict(m)
                        minutes = round((rt - now).total_seconds() / 60, 1)
                        m_copy["minutes_to_off"] = minutes
                        m_copy["in_window"] = minutes <= self.process_window
                        m_copy["monitoring_snapshots"] = len(
                            self.monitoring.get(m["market_id"], [])
                        )
                        upcoming.append(m_copy)
                except (ValueError, KeyError):
                    pass

        upcoming.sort(key=lambda x: x.get("race_time", ""))

        # Daily P&L summary
        total_stake = sum(b.get("size", 0) for b in self.bets_placed)
        total_liability = sum(b.get("liability", 0) for b in self.bets_placed)

        # Dry-run paper P&L
        dry_run_bets = [b for b in self.bets_placed if b.get("dry_run")]
        dry_run_settled = [
            b for b in dry_run_bets
            if b.get("outcome") in ("WIN", "LOSS")
        ]
        dry_run_pending = sum(1 for b in dry_run_bets if "outcome" not in b)
        dry_run_pnl = round(sum(b.get("pnl", 0) for b in dry_run_settled), 2)
        dry_run_wins = sum(1 for b in dry_run_settled if b.get("outcome") == "WIN")
        dry_run_losses = sum(1 for b in dry_run_settled if b.get("outcome") == "LOSS")

        # General W/L stats (any bets with settled outcomes — dry run or live)
        all_settled = [b for b in self.bets_placed if b.get("outcome") in ("WIN", "LOSS")]
        wins = sum(1 for b in all_settled if b.get("outcome") == "WIN")
        losses = sum(1 for b in all_settled if b.get("outcome") == "LOSS")
        pnl = round(sum(b.get("pnl", 0) for b in all_settled), 2)
        strike_rate = round(wins / len(all_settled) * 100, 1) if all_settled else None

        return {
            "authenticated": self.is_authenticated,
            "status": self.status,
            "dry_run": self.dry_run,
            "countries": self.countries,
            "spread_control": self.spread_control,
            "jofs_control": self.jofs_control,
            "mark_ceiling_enabled": self.mark_ceiling_enabled,
            "mark_floor_enabled": self.mark_floor_enabled,
            "mark_uplift_enabled": self.mark_uplift_enabled,
            "mark_uplift_stake": self.mark_uplift_stake,
            "point_value": self.point_value,
            "kelly_enabled": self.kelly_config.enabled,
            "kelly_fraction": self.kelly_config.fraction,
            "kelly_bankroll": self.kelly_config.bankroll,
            "kelly_edge_pct": self.kelly_config.edge_pct,
            "kelly_min_stake": self.kelly_config.min_stake,
            "kelly_max_stake": self.kelly_config.max_stake,
            # Signal filter config
            "signal_overround_enabled": self.signal_config.overround_enabled,
            "signal_field_size_enabled": self.signal_config.field_size_enabled,
            "signal_steam_gate_enabled": self.signal_config.steam_gate_enabled,
            "signal_band_perf_enabled": self.signal_config.band_perf_enabled,
            "date": self.day_started,
            "last_scan": self.last_scan,
            "balance": self.balance,
            "process_window": self.process_window,
            "next_race": self.next_race,
            "session_id": self.current_session["session_id"] if self.current_session else None,
            "session_start": self.current_session["start_time"] if self.current_session else None,
            "session_mode": self.current_session["mode"] if self.current_session else None,
            "summary": {
                "total_markets": len(self.markets),
                "processed": len(self.processed_markets),
                "monitoring": len(self.monitoring),
                "bets_placed": len(self.bets_placed),
                "spread_rejections": len(self.spread_rejections),
                "signal_rejections": len(self.signal_rejections),
                "jofs_splits": sum(
                    1 for b in self.bets_placed
                    if "JOINT" in b.get("rule_applied", "")
                ),
                "total_stake": round(total_stake, 2),
                "total_liability": round(total_liability, 2),
                # Paper trading stats (dry-run only)
                "dry_run_bets": len(dry_run_bets),
                "dry_run_settled": len(dry_run_settled),
                "dry_run_pending": dry_run_pending,
                "dry_run_wins": dry_run_wins,
                "dry_run_losses": dry_run_losses,
                "dry_run_pnl": dry_run_pnl,
                # General ribbon stats
                "wins": wins,
                "losses": losses,
                "pnl": pnl,
                "strike_rate": strike_rate,
            },
            "upcoming": upcoming[:10],
            "recent_bets": list(reversed(self.bets_placed)),
            "recent_results": list(reversed(self.results)),
            "spread_rejections": list(reversed(self.spread_rejections[-20:])),
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
            summary = s.get("summary", {})
            # Derive countries from bets if not in summary (backward compat)
            countries = summary.get("countries")
            if not countries:
                countries = sorted(set(
                    b.get("country") for b in s.get("bets", []) if b.get("country")
                ))
            summaries.append({
                "session_id": s["session_id"],
                "mode": s["mode"],
                "date": s["date"],
                "start_time": s["start_time"],
                "stop_time": s["stop_time"],
                "status": s["status"],
                "summary": summary,
                "countries": countries,
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

    # ──────────────────────────────────────────────
    #  INSTANT DRY-RUN SNAPSHOT
    # ──────────────────────────────────────────────

    def run_instant_snapshot(self, market_ids: list[str]) -> dict:
        """Run a one-shot snapshot for selected markets: fetch prices, apply rules, return results.

        Does NOT start the engine loop, place bets, or mutate processed_markets/bets_placed.
        """
        if not self.client or not self.is_authenticated:
            raise RuntimeError("Not authenticated")

        now = datetime.now(timezone.utc)
        per_market_results = []
        total_stake = 0.0
        total_liability = 0.0
        total_bets = 0
        rule_breakdown: dict[str, int] = {}

        # Build lookup from in-memory markets
        market_lookup = {m["market_id"]: m for m in self.markets}

        for market_id in market_ids:
            market = market_lookup.get(market_id)
            if not market:
                per_market_results.append({
                    "market_id": market_id,
                    "venue": "?",
                    "race_time": "",
                    "market_name": "",
                    "skipped": True,
                    "skip_reason": "Market not found in catalogue",
                    "favourite_name": None,
                    "favourite_odds": None,
                    "rule_applied": "",
                    "bets": [],
                })
                continue

            # Fetch live prices
            try:
                runners_with_prices, is_valid = self.client.get_market_prices(market_id)
            except Exception as e:
                per_market_results.append({
                    "market_id": market_id,
                    "venue": market.get("venue", ""),
                    "race_time": market.get("race_time", ""),
                    "market_name": market.get("market_name", ""),
                    "skipped": True,
                    "skip_reason": f"Price fetch failed: {e}",
                    "favourite_name": None,
                    "favourite_odds": None,
                    "rule_applied": "",
                    "bets": [],
                })
                continue

            if not is_valid or not runners_with_prices:
                per_market_results.append({
                    "market_id": market_id,
                    "venue": market.get("venue", ""),
                    "race_time": market.get("race_time", ""),
                    "market_name": market.get("market_name", ""),
                    "skipped": True,
                    "skip_reason": "No prices available, market closed, or in-play",
                    "favourite_name": None,
                    "favourite_odds": None,
                    "rule_applied": "",
                    "bets": [],
                })
                continue

            # Merge runner names from catalogue into price data
            name_map = {
                r["selection_id"]: r["runner_name"]
                for r in market.get("runners", [])
            }
            for runner in runners_with_prices:
                if runner.selection_id in name_map:
                    runner.runner_name = name_map[runner.selection_id]

            # Apply rules
            result = apply_rules(
                market_id=market_id,
                market_name=market.get("market_name", ""),
                venue=market.get("venue", ""),
                race_time=market.get("race_time", ""),
                runners=runners_with_prices,
                jofs_enabled=self.jofs_control,
                mark_ceiling_enabled=self.mark_ceiling_enabled,
                mark_floor_enabled=self.mark_floor_enabled,
                mark_uplift_enabled=self.mark_uplift_enabled,
            )

            # Apply point value multiplier
            if self.point_value != 1.0:
                for instruction in result.instructions:
                    instruction.size = round(instruction.size * self.point_value, 2)

            # Apply signal filters (backtest mode — no previous prices / steam data)
            any_signal_enabled = (
                self.signal_config.overround_enabled or
                self.signal_config.field_size_enabled or
                self.signal_config.band_perf_enabled
                # steam_gate skipped in snapshot mode — no monitoring history
            )
            if any_signal_enabled and not result.skipped:
                bt_band_stats = self._compute_band_stats(self.signal_config.band_perf_lookback_days)
                filtered_instructions = []
                for inst in result.instructions:
                    sig_result = apply_signal_filters(
                        selection_id=inst.selection_id,
                        current_price=inst.price,
                        original_stake=inst.size,
                        all_runners=runners_with_prices,
                        previous_prices={},   # not available in snapshot mode
                        band_stats=bt_band_stats,
                        config=self.signal_config,
                    )
                    if sig_result.allowed:
                        inst.size = sig_result.final_stake
                        filtered_instructions.append(inst)
                result.instructions = filtered_instructions

            # Build per-market result dict
            bets_list = []
            for inst in result.instructions:
                bets_list.append({
                    "runner_name": inst.runner_name,
                    "price": inst.price,
                    "size": inst.size,
                    "liability": inst.liability,
                    "rule_applied": inst.rule_applied,
                })
                total_stake += inst.size
                total_liability += inst.liability
                total_bets += 1

            # Track rule breakdown
            if result.rule_applied and not result.skipped:
                # Extract short rule tag (e.g. "RULE_1" from "RULE_1: Fav odds ...")
                short_rule = result.rule_applied.split(":")[0].strip()
                rule_breakdown[short_rule] = rule_breakdown.get(short_rule, 0) + 1

            per_market_results.append({
                "market_id": market_id,
                "venue": market.get("venue", ""),
                "race_time": market.get("race_time", ""),
                "market_name": market.get("market_name", ""),
                "skipped": result.skipped,
                "skip_reason": result.skip_reason if result.skipped else "",
                "favourite_name": result.favourite.runner_name if result.favourite else None,
                "favourite_odds": result.favourite.best_available_to_lay if result.favourite else None,
                "rule_applied": result.rule_applied,
                "bets": bets_list,
            })

        # Build snapshot record
        snapshot = {
            "snapshot_id": f"drs_{now.strftime('%Y%m%d_%H%M%S')}",
            "created_at": now.isoformat(),
            "markets_evaluated": len(market_ids),
            "bets_would_place": total_bets,
            "total_stake": round(total_stake, 2),
            "total_liability": round(total_liability, 2),
            "rule_breakdown": rule_breakdown,
            "countries": self.countries,
            "point_value": self.point_value,
            "jofs_control": self.jofs_control,
            "spread_control": getattr(self, 'spread_control', False),
            "mark_ceiling_enabled": self.mark_ceiling_enabled,
            "mark_floor_enabled": self.mark_floor_enabled,
            "mark_uplift_enabled": self.mark_uplift_enabled,
            "mark_uplift_stake": self.mark_uplift_stake,
            "process_window": getattr(self, 'process_window', 12),
            "signal_overround_enabled": self.signal_config.overround_enabled,
            "signal_field_size_enabled": self.signal_config.field_size_enabled,
            "signal_steam_gate_enabled": self.signal_config.steam_gate_enabled,
            "signal_band_perf_enabled": self.signal_config.band_perf_enabled,
            "results": per_market_results,
        }

        self.dry_run_snapshots.append(snapshot)
        self._save_snapshots()
        logger.info(
            f"Instant snapshot {snapshot['snapshot_id']}: "
            f"{len(market_ids)} markets, {total_bets} bets, "
            f"£{round(total_stake, 2)} stake"
        )
        return snapshot
