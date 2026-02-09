"""
CHIMERA Lay Engine — Betfair API Client
========================================
Handles all Betfair Exchange API interactions.
- Authentication (interactive login)
- Market discovery (UK/IE WIN markets)
- Price retrieval (identify favourites)
- Order placement (LAY bets)
"""

import os
import time
import logging
import requests
from datetime import datetime, timedelta, timezone
from typing import Optional
from rules import Runner

logger = logging.getLogger("betfair")

# ── Betfair API endpoints ──
LOGIN_URL = "https://identitysso.betfair.com/api/login"
CERT_LOGIN_URL = "https://identitysso-cert.betfair.com/api/certlogin"
KEEPALIVE_URL = "https://identitysso.betfair.com/api/keepAlive"
API_URL = "https://api.betfair.com/exchange/betting/json-rpc/v1"

# ── Horse Racing event type ──
EVENT_TYPE_HORSE_RACING = "7"


class BetfairClient:
    """Minimal Betfair Exchange API client for lay betting."""

    def __init__(self, app_key: str, username: str, password: str):
        self.app_key = app_key
        self.username = username
        self.password = password
        self.session_token: Optional[str] = None
        self.session_expiry: Optional[datetime] = None
        self.last_login_error: Optional[str] = None

    # ──────────────────────────────────────────────
    #  AUTH
    # ──────────────────────────────────────────────

    def login(self) -> bool:
        """Authenticate with Betfair using interactive login."""
        try:
            resp = requests.post(
                LOGIN_URL,
                data={"username": self.username, "password": self.password},
                headers={
                    "X-Application": self.app_key,
                    "Accept": "application/json",
                },
                timeout=15,
            )
            data = resp.json()
            if data.get("status") == "SUCCESS":
                self.session_token = data["token"]
                self.session_expiry = datetime.now(timezone.utc) + timedelta(hours=4)
                self.last_login_error = None
                logger.info("Betfair login successful")
                return True
            else:
                self.last_login_error = data.get("error", "unknown")
                logger.error(f"Betfair login failed: {self.last_login_error}")
                return False
        except Exception as e:
            self.last_login_error = str(e)
            logger.error(f"Betfair login exception: {e}")
            return False

    def ensure_session(self) -> bool:
        """Ensure we have a valid session, re-authenticating if needed."""
        if self.session_token and self.session_expiry:
            if datetime.now(timezone.utc) < self.session_expiry - timedelta(minutes=30):
                return True
            # Try keepalive
            try:
                resp = requests.post(
                    KEEPALIVE_URL,
                    headers=self._headers(),
                    timeout=10,
                )
                data = resp.json()
                if data.get("status") == "SUCCESS":
                    self.session_expiry = datetime.now(timezone.utc) + timedelta(hours=4)
                    return True
            except Exception:
                pass

        return self.login()

    def _headers(self) -> dict:
        return {
            "X-Application": self.app_key,
            "X-Authentication": self.session_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _api_call(self, method: str, params: dict) -> Optional[dict]:
        """Make a JSON-RPC call to the Betfair API."""
        if not self.ensure_session():
            logger.error("No valid session for API call")
            return None

        payload = {
            "jsonrpc": "2.0",
            "method": f"SportsAPING/v1.0/{method}",
            "params": params,
            "id": 1,
        }

        try:
            resp = requests.post(
                API_URL,
                json=[payload],
                headers=self._headers(),
                timeout=30,
            )
            results = resp.json()
            if results and len(results) > 0:
                result = results[0]
                if "error" in result:
                    logger.error(f"API error on {method}: {result['error']}")
                    return None
                return result.get("result")
            return None
        except Exception as e:
            logger.error(f"API call {method} failed: {e}")
            return None

    # ──────────────────────────────────────────────
    #  MARKET DISCOVERY
    # ──────────────────────────────────────────────

    def get_todays_win_markets(self) -> list[dict]:
        """
        Get all UK/IE horse racing WIN markets for today.
        Returns list of market catalogue entries.
        """
        now = datetime.now(timezone.utc)
        end_of_day = now.replace(hour=23, minute=59, second=59)

        params = {
            "filter": {
                "eventTypeIds": [EVENT_TYPE_HORSE_RACING],
                "marketCountries": ["GB", "IE"],
                "marketTypeCodes": ["WIN"],
                "marketStartTime": {
                    "from": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "to": end_of_day.strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
            },
            "maxResults": "200",
            "marketProjection": [
                "EVENT",
                "RUNNER_DESCRIPTION",
                "MARKET_START_TIME",
            ],
            "sort": "FIRST_TO_START",
        }

        result = self._api_call("listMarketCatalogue", params)
        if result is None:
            return []

        markets = []
        for m in result:
            markets.append({
                "market_id": m["marketId"],
                "market_name": m.get("marketName", ""),
                "venue": m.get("event", {}).get("venue", "Unknown"),
                "race_time": m.get("marketStartTime", ""),
                "runners": [
                    {
                        "selection_id": r["selectionId"],
                        "runner_name": r.get("runnerName", f"Runner {r['selectionId']}"),
                        "handicap": r.get("handicap", 0.0),
                        "sort_priority": r.get("sortPriority", 99),
                    }
                    for r in m.get("runners", [])
                ],
            })

        logger.info(f"Found {len(markets)} UK/IE WIN markets")
        return markets

    # ──────────────────────────────────────────────
    #  PRICE RETRIEVAL
    # ──────────────────────────────────────────────

    def get_market_prices(self, market_id: str) -> tuple[list["Runner"], bool]:
        """
        Get current best-available-to-lay prices for all runners in a market.
        Returns (runners, is_valid) where is_valid=False if market is
        closed, suspended, or in-play.
        """
        params = {
            "marketIds": [market_id],
            "priceProjection": {
                "priceData": ["EX_BEST_OFFERS"],
            },
        }

        result = self._api_call("listMarketBook", params)
        if result is None or len(result) == 0:
            return [], False

        market = result[0]

        # Check market is still open
        if market.get("status") != "OPEN":
            logger.warning(f"Market {market_id} status: {market.get('status')} — skipping")
            return [], False

        # ── FIX: Check market is NOT in-play ──
        # Markets can be OPEN + inPlay=True simultaneously.
        # We only place pre-off bets.
        if market.get("inPlay", False):
            logger.warning(f"Market {market_id} is IN-PLAY — skipping (pre-off only)")
            return [], False

        runners = []
        for r in market.get("runners", []):
            runner = Runner(
                selection_id=r["selectionId"],
                runner_name=f"Selection {r['selectionId']}",  # Name comes from catalogue
                handicap=r.get("handicap", 0.0),
                status=r.get("status", "ACTIVE"),
            )

            # Get best available to lay (the lowest lay price)
            lay_prices = r.get("ex", {}).get("availableToLay", [])
            if lay_prices:
                runner.best_available_to_lay = lay_prices[0]["price"]

            runners.append(runner)

        return runners, True

    def get_market_book(self, market_id: str) -> Optional[dict]:
        """Get full market book including status and inPlay flag."""
        params = {
            "marketIds": [market_id],
            "priceProjection": {
                "priceData": ["EX_BEST_OFFERS"],
            },
        }
        result = self._api_call("listMarketBook", params)
        if result and len(result) > 0:
            return result[0]
        return None

    # ──────────────────────────────────────────────
    #  ORDER PLACEMENT
    # ──────────────────────────────────────────────

    def place_lay_order(
        self,
        market_id: str,
        selection_id: int,
        price: float,
        size: float,
    ) -> dict:
        """
        Place a single LAY order on Betfair.
        Returns the instruction report from Betfair.

        FIX: Betfair Exchange API expects:
          - selectionId: integer (long)
          - handicap: number
          - size: number (double)
          - price: number (double)
        NOT strings. Sending strings causes silent rejection.
        """
        params = {
            "marketId": market_id,
            "instructions": [
                {
                    "selectionId": int(selection_id),
                    "handicap": 0,
                    "side": "LAY",
                    "orderType": "LIMIT",
                    "limitOrder": {
                        "size": round(float(size), 2),
                        "price": round(float(price), 2),
                        "persistenceType": "LAPSE",
                    },
                }
            ],
        }

        result = self._api_call("placeOrders", params)
        if result is None:
            return {"status": "FAILURE", "error": "API call returned None"}

        status = result.get("status", "FAILURE")
        reports = result.get("instructionReports", [])

        if status == "SUCCESS" and reports:
            report = reports[0]
            return {
                "status": report.get("status", "UNKNOWN"),
                "bet_id": report.get("betId"),
                "placed_date": report.get("placedDate"),
                "avg_price_matched": report.get("averagePriceMatched", 0),
                "size_matched": report.get("sizeMatched", 0),
                "error_code": report.get("errorCode"),
            }
        else:
            return {
                "status": "FAILURE",
                "error_code": result.get("errorCode", "UNKNOWN"),
            }

    def get_account_balance(self) -> Optional[float]:
        """Get current account available balance."""
        try:
            payload = {
                "jsonrpc": "2.0",
                "method": "AccountAPING/v1.0/getAccountFunds",
                "params": {},
                "id": 1,
            }
            resp = requests.post(
                "https://api.betfair.com/exchange/account/json-rpc/v1",
                json=[payload],
                headers=self._headers(),
                timeout=15,
            )
            results = resp.json()
            if results and len(results) > 0:
                result = results[0].get("result", {})
                return result.get("availableToBetBalance")
        except Exception as e:
            logger.error(f"Balance check failed: {e}")
        return None
