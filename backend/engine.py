"""
CHIMERA Lay Engine — Main Engine
=================================
Discovers races → applies rules → places bets.
Runs on a loop. No manual intervention. No intelligence.
"""

import os
import time
import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from betfair_client import BetfairClient
from rules import Runner, apply_rules, RuleResult

logger = logging.getLogger("engine")

# ── Configuration from environment ──
BETFAIR_APP_KEY = os.environ.get("BETFAIR_APP_KEY", "")

# How many minutes before race to place the bet
BET_BEFORE_MINUTES = int(os.environ.get("BET_BEFORE_MINUTES", "2"))

# Dry run mode (log but don't place real bets)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Poll interval in seconds
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))


class LayEngine:
    """
    The core engine. Discovers markets, applies rules, places bets.
    All state is held in-memory for the current day.
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
        self.last_scan: Optional[str] = None
        self.status: str = "STOPPED"
        self.balance: Optional[float] = None
        self.errors: list[dict] = []
        self.day_started: str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

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
            return True, ""
        error = self.client.last_login_error or "unknown"
        self.client = None
        return False, error

    def logout(self):
        """Clear credentials and stop engine."""
        self.stop()
        self.client = None

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
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        logger.info("Engine started")

    def stop(self):
        """Stop the engine loop."""
        self.running = False
        self.status = "STOPPED"
        logger.info("Engine stopped")

    def _run_loop(self):
        """Main engine loop."""
        # Verify session is still valid
        if not DRY_RUN:
            if not self.client.ensure_session():
                self.status = "AUTH_FAILED"
                self._add_error("Session expired and re-authentication failed")
                self.running = False
                return

            self.balance = self.client.get_account_balance()
            logger.info(f"Account balance: £{self.balance}")

        self.status = "RUNNING"
        logger.info(f"Engine running (DRY_RUN={DRY_RUN}, POLL={POLL_INTERVAL}s, BET_BEFORE={BET_BEFORE_MINUTES}m)")

        while self.running:
            try:
                self._check_day_rollover()
                self._scan_and_process()
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
            self.errors = []
            self.day_started = today

    # ──────────────────────────────────────────────
    #  CORE LOGIC
    # ──────────────────────────────────────────────

    def _scan_and_process(self):
        """Discover markets and process any that are ready."""
        now = datetime.now(timezone.utc)
        self.last_scan = now.isoformat()

        # Refresh market list
        if not DRY_RUN:
            self.client.ensure_session()
            self.markets = self.client.get_todays_win_markets()
        else:
            # In dry run, keep any previously set markets
            if not self.markets:
                logger.info("DRY_RUN: No markets loaded. Waiting for manual load or API connection.")

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

            # Only process if within the betting window
            minutes_to_race = (race_time - now).total_seconds() / 60

            if minutes_to_race < 0:
                # Race has started — mark as processed, we missed it
                self.processed_markets.add(market_id)
                continue

            if minutes_to_race > BET_BEFORE_MINUTES:
                # Too early — wait
                continue

            # ── WITHIN BETTING WINDOW → PROCESS ──
            logger.info(
                f"Processing {market['venue']} {market['market_name']} "
                f"({minutes_to_race:.1f}m to off)"
            )
            self._process_market(market)

    def _process_market(self, market: dict):
        """Fetch prices, apply rules, place bets for a single market."""
        market_id = market["market_id"]
        self.processed_markets.add(market_id)

        # Step 1: Get current prices
        if DRY_RUN:
            logger.info(f"DRY_RUN: Would fetch prices for {market_id}")
            # Create dummy result for dry run
            result = RuleResult(
                market_id=market_id,
                market_name=market["market_name"],
                venue=market["venue"],
                race_time=market["race_time"],
                instructions=[],
                skipped=True,
                skip_reason="DRY_RUN — no live prices",
            )
            self.results.append(result.to_dict())
            return

        runners_with_prices = self.client.get_market_prices(market_id)

        if not runners_with_prices:
            result = RuleResult(
                market_id=market_id,
                market_name=market["market_name"],
                venue=market["venue"],
                race_time=market["race_time"],
                instructions=[],
                skipped=True,
                skip_reason="No prices available or market closed",
            )
            self.results.append(result.to_dict())
            return

        # Merge runner names from catalogue into price data
        name_map = {
            r["selection_id"]: r["runner_name"]
            for r in market.get("runners", [])
        }
        for runner in runners_with_prices:
            if runner.selection_id in name_map:
                runner.runner_name = name_map[runner.selection_id]

        # Step 2: Apply rules
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

        # Step 3: Place the bets
        logger.info(
            f"Rule applied: {result.rule_applied} — "
            f"{len(result.instructions)} bet(s) to place"
        )

        for instruction in result.instructions:
            self._place_bet(instruction)

    def _place_bet(self, instruction):
        """Place a single lay bet via the Betfair API."""
        logger.info(
            f"PLACING: LAY {instruction.runner_name} @ {instruction.price} "
            f"£{instruction.size} (liability £{instruction.liability}) "
            f"[{instruction.rule_applied}]"
        )

        if DRY_RUN:
            bet_record = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "dry_run": True,
                **instruction.to_dict(),
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
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "dry_run": False,
            **instruction.to_dict(),
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
            "dry_run": DRY_RUN,
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
            "recent_bets": list(reversed(self.bets_placed[-20:])),
            "recent_results": list(reversed(self.results[-20:])),
            "errors": self.errors[-10:],
        }

    def _add_error(self, msg: str):
        self.errors.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": msg,
        })
