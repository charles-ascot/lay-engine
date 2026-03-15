"""
CHIMERA AI Odds Movement Agent
================================
An agentic overlay for the backtest engine that analyses historical odds movement
before deciding whether to confirm, overrule, or adjust a proposed lay bet.

Unlike the AI Research Agent (which searches the internet), this agent reads
directly from the FSU historic market data — the same feed the backtest uses —
so there is no external dependency and no API key required for web search.

STRICT TEMPORAL RULE:
  All samples are taken from timestamps ≤ evaluation_time (race_time minus
  the process window). The agent never reads prices from after this point,
  ensuring the backtest is completely honest.

Flow:
  1. Standard rules engine runs → proposes a lay bet on the favourite
  2. Odds agent samples prices at regular intervals going back N minutes
     from the evaluation time (e.g. every 5 min for the last 30 min)
  3. The full price series (lay, back, spread, trend) is passed to Claude
     in a single structured call
  4. Claude analyses drift direction, steam moves, and market confidence
     then returns CONFIRM / OVERRULE / ADJUST + reasoning
  5. Caller applies the decision before computing P&L

This module is completely isolated from the live betting engine.
It is only invoked when odds_agent_enabled=True in a BacktestRunRequest.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class OddsAgentConfig:
    """Toggleable settings for the odds movement agent."""
    sample_interval_mins: int = 5     # How often to sample prices (minutes)
    lookback_mins: int = 30           # How far back from evaluation time to sample
    overrule_min_confidence: float = 0.65  # Min confidence required to overrule
    stake_adjustment_enabled: bool = True
    max_stake_multiplier: float = 2.0
    min_stake_multiplier: float = 0.25


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class OddsSnapshot:
    """A single price observation at a point in the pre-race timeline."""
    timestamp_iso: str
    mins_before_race: float       # How many minutes before race time this was taken
    lay_price: Optional[float]    # Best available to lay (what we pay if we lose)
    back_price: Optional[float]   # Best available to back
    spread: Optional[float]       # lay - back (smaller = more liquid)
    is_favourite: bool = True     # Whether this runner was still the favourite


@dataclass
class OddsAgentDecision:
    """The agent's final decision for a single lay instruction."""
    market_id: str
    runner_name: str
    selection_id: int

    # Strategy's original intent
    original_action: str      # always "BET"
    original_stake: float
    original_price: float     # Price at evaluation time
    original_rule: str

    # Agent's verdict
    agent_action: str         # "CONFIRM" | "OVERRULE" | "ADJUST"
    final_stake: float
    stake_multiplier: float
    confidence: float         # 0.0–1.0
    reasoning: str
    odds_summary: str         # Human-readable summary of the odds movement

    # Odds movement data (for display)
    snapshots: list[OddsSnapshot] = field(default_factory=list)
    price_open: Optional[float] = None   # Earliest sampled price
    price_close: Optional[float] = None  # Price at evaluation time
    price_delta: Optional[float] = None  # close - open (negative = shortened)
    trend: str = ""                       # "SHORTENING" | "DRIFTING" | "STABLE"

    # Meta
    overruled: bool = False
    samples_taken: int = 0
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Main agent class
# ---------------------------------------------------------------------------

class OddsMovementAgent:
    """
    Samples historical odds from the FSU at configurable intervals and asks
    Claude to reason about the price movement before influencing the bet.

    Usage:
        agent = OddsMovementAgent(anthropic_client)
        decisions = agent.process_market(
            fsu_client=client,
            market_id=market_id,
            race_time_iso=race_time_str,
            evaluation_time_iso=target_iso,
            rule_result=rule_result,
            config=config,
        )
        # decisions: list[OddsAgentDecision]

    IMPORTANT: After calling process_market(), the caller must restore the
    FSU client's virtual time to evaluation_time_iso. This agent borrows the
    client for sampling but does not restore time itself.
    """

    MODEL = "claude-sonnet-4-6"

    def __init__(self, anthropic_client):
        self.client = anthropic_client

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process_market(
        self,
        fsu_client,
        market_id: str,
        race_time_iso: str,
        evaluation_time_iso: str,
        rule_result,                  # RuleResult dataclass or dict
        config: OddsAgentConfig,
    ) -> list[OddsAgentDecision]:
        """
        Analyse odds movement for all runners in rule_result and return
        one OddsAgentDecision per instruction.
        """
        # Support both dict and dataclass rule results
        if hasattr(rule_result, '__dict__'):
            market_name = getattr(rule_result, 'market_name', '')
            venue = getattr(rule_result, 'venue', '')
            instructions = rule_result.instructions
        else:
            market_name = rule_result.get('market_name', '')
            venue = rule_result.get('venue', '')
            instructions = rule_result.get('instructions', [])

        decisions = []

        for instr in instructions:
            if hasattr(instr, '__dict__'):
                runner_name = instr.runner_name
                selection_id = instr.selection_id
                price = instr.price
                size = instr.size
                rule_applied = instr.rule_applied
            else:
                runner_name = instr.get('runner_name', '')
                selection_id = instr.get('selection_id', 0)
                price = instr.get('price', 0.0)
                size = instr.get('size', 0.0)
                rule_applied = instr.get('rule_applied', '')

            decision = self._analyse_runner(
                fsu_client=fsu_client,
                market_id=market_id,
                market_name=market_name,
                venue=venue,
                race_time_iso=race_time_iso,
                evaluation_time_iso=evaluation_time_iso,
                runner_name=runner_name,
                selection_id=selection_id,
                price=price,
                size=size,
                rule_applied=rule_applied,
                config=config,
            )
            decisions.append(decision)

        return decisions

    # ------------------------------------------------------------------
    # Internal: sample prices from FSU
    # ------------------------------------------------------------------

    def _sample_prices(
        self,
        fsu_client,
        market_id: str,
        selection_id: int,
        race_time_iso: str,
        evaluation_time_iso: str,
        config: OddsAgentConfig,
    ) -> list[OddsSnapshot]:
        """
        Sample prices for the target selection at regular intervals going back
        from evaluation_time. All samples are strictly ≤ evaluation_time.
        """
        try:
            race_dt = datetime.fromisoformat(race_time_iso.replace("Z", "+00:00"))
            eval_dt = datetime.fromisoformat(evaluation_time_iso.replace("Z", "+00:00"))
        except Exception as e:
            logger.warning(f"Odds agent: could not parse timestamps: {e}")
            return []

        # Build list of sample timestamps (oldest → newest, all ≤ eval_dt)
        interval_secs = config.sample_interval_mins * 60
        lookback_secs = config.lookback_mins * 60

        sample_times = []
        t = eval_dt.timestamp()
        oldest = t - lookback_secs
        while t >= oldest:
            sample_times.append(t)
            t -= interval_secs
        sample_times.reverse()  # oldest first

        snapshots = []
        for ts in sample_times:
            sample_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            sample_iso = sample_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            mins_before_race = (race_dt.timestamp() - ts) / 60

            fsu_client.set_virtual_time(sample_iso)
            runners, valid = fsu_client.get_market_prices(market_id)

            if not valid or not runners:
                continue

            # Find the target runner
            target = next((r for r in runners if r.selection_id == selection_id), None)
            if target is None:
                continue

            # Determine if this runner is still the favourite at this time
            active = [
                r for r in runners
                if r.status == "ACTIVE" and r.best_available_to_lay is not None
            ]
            active.sort(key=lambda r: r.best_available_to_lay)
            is_fav = bool(active and active[0].selection_id == selection_id)

            lay = target.best_available_to_lay
            back = target.best_available_to_back
            spread = round(lay - back, 3) if lay is not None and back is not None else None

            snapshots.append(OddsSnapshot(
                timestamp_iso=sample_iso,
                mins_before_race=round(mins_before_race, 1),
                lay_price=lay,
                back_price=back,
                spread=spread,
                is_favourite=is_fav,
            ))

        return snapshots

    # ------------------------------------------------------------------
    # Internal: call Claude with the price series
    # ------------------------------------------------------------------

    def _analyse_runner(
        self,
        fsu_client,
        market_id: str,
        market_name: str,
        venue: str,
        race_time_iso: str,
        evaluation_time_iso: str,
        runner_name: str,
        selection_id: int,
        price: float,
        size: float,
        rule_applied: str,
        config: OddsAgentConfig,
    ) -> OddsAgentDecision:
        """Sample historical prices then ask Claude to analyse the movement."""

        try:
            snapshots = self._sample_prices(
                fsu_client=fsu_client,
                market_id=market_id,
                selection_id=selection_id,
                race_time_iso=race_time_iso,
                evaluation_time_iso=evaluation_time_iso,
                config=config,
            )
        except Exception as e:
            logger.warning(f"Odds agent sampling error for {runner_name}: {e}")
            return self._fallback_decision(
                market_id, runner_name, selection_id, price, size, rule_applied,
                error=f"Sampling failed: {e}",
            )

        if not snapshots:
            return self._fallback_decision(
                market_id, runner_name, selection_id, price, size, rule_applied,
                error="No price data found in lookback window.",
            )

        # Compute movement statistics
        valid_lays = [s.lay_price for s in snapshots if s.lay_price is not None]
        price_open = valid_lays[0] if valid_lays else None
        price_close = valid_lays[-1] if valid_lays else None
        price_delta = round(price_close - price_open, 3) if (price_open and price_close) else None

        if price_delta is not None:
            if price_delta <= -0.1:
                trend = "SHORTENING"   # being backed — money on it to win
            elif price_delta >= 0.1:
                trend = "DRIFTING"     # being laid off — market less confident
            else:
                trend = "STABLE"
        else:
            trend = "UNKNOWN"

        # Build a compact table for Claude
        rows = []
        for s in snapshots:
            lay_str = f"{s.lay_price:.2f}" if s.lay_price else "n/a"
            back_str = f"{s.back_price:.2f}" if s.back_price else "n/a"
            spread_str = f"{s.spread:.3f}" if s.spread else "n/a"
            fav_str = "★" if s.is_favourite else "  "
            rows.append(
                f"  {fav_str} -{s.mins_before_race:5.1f} min  "
                f"Lay {lay_str:>6}  Back {back_str:>6}  Spread {spread_str:>7}"
            )

        price_table = "\n".join(rows)

        prompt = f"""You are a horse racing market analyst for a backtesting system.

RACE:
  Market:    {market_name} at {venue}
  Race Time: {race_time_iso}
  Runner:    {runner_name}

PROPOSED BET (from mechanical strategy):
  Action:     LAY (bet against this horse winning)
  Lay Odds:   {price:.2f}
  Stake:      £{size:.2f}  (liability £{round(size * (price - 1), 2):.2f})
  Rule Used:  {rule_applied}

ODDS MOVEMENT (sampled every {config.sample_interval_mins} min, last {config.lookback_mins} min before evaluation):
  ★ = favourite at that time

{price_table}

SUMMARY:
  Opening price:  {f"{price_open:.2f}" if price_open else "n/a"}
  Closing price:  {f"{price_close:.2f}" if price_close else "n/a"}
  Movement:       {f"{price_delta:+.3f}" if price_delta is not None else "n/a"}  ({trend})

INTERPRETATION GUIDE:
  SHORTENING (price falling) → money being placed ON the horse to WIN → bad for a lay
  DRIFTING   (price rising)  → money being placed AGAINST it, or lack of support → good for a lay
  STABLE                     → no strong directional signal either way
  Late steam (sharp move in final minutes) = potentially significant sharp/insider money

Analyse the odds movement and decide:
- Is this a good lay given how the market has moved?
- Is there a steam move that concerns you?
- Does the drift support or contradict the strategy?

Respond with VALID JSON only (no other text):
{{
  "action": "CONFIRM" | "OVERRULE" | "ADJUST",
  "stake_multiplier": <float {config.min_stake_multiplier}–{config.max_stake_multiplier}>,
  "confidence": <float 0.0–1.0>,
  "reasoning": "<1-3 sentences explaining your decision based on the price movement>",
  "odds_summary": "<brief characterisation of the movement, e.g. 'Shortened 3.4→2.8 in 30 min — steady backing'>"
}}

DECISION GUIDE:
  CONFIRM  → Odds movement supports the lay, or is inconclusive. Use stake_multiplier=1.0.
  OVERRULE → Strong evidence the horse is being backed to win (dangerous lay). Use stake_multiplier=1.0.
  ADJUST   → Movement warrants a modified stake. Set stake_multiplier accordingly.
  Only OVERRULE if confidence ≥ {config.overrule_min_confidence:.0%}.
"""

        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=400,
                messages=[{"role": "user", "content": prompt}],
            )
            text = response.content[0].text if response.content else ""
            return self._parse_decision(
                text=text,
                market_id=market_id,
                runner_name=runner_name,
                selection_id=selection_id,
                price=price,
                size=size,
                rule_applied=rule_applied,
                snapshots=snapshots,
                price_open=price_open,
                price_close=price_close,
                price_delta=price_delta,
                trend=trend,
                config=config,
            )

        except Exception as e:
            logger.warning(f"Odds agent Claude call failed for {runner_name}: {e}")
            return self._fallback_decision(
                market_id, runner_name, selection_id, price, size, rule_applied,
                snapshots=snapshots,
                price_open=price_open,
                price_close=price_close,
                price_delta=price_delta,
                trend=trend,
                error=str(e),
            )

    # ------------------------------------------------------------------
    # Internal: parse Claude's JSON response
    # ------------------------------------------------------------------

    def _parse_decision(
        self,
        text: str,
        market_id: str,
        runner_name: str,
        selection_id: int,
        price: float,
        size: float,
        rule_applied: str,
        snapshots: list,
        price_open: Optional[float],
        price_close: Optional[float],
        price_delta: Optional[float],
        trend: str,
        config: OddsAgentConfig,
    ) -> OddsAgentDecision:
        try:
            raw = text.strip()
            if "```json" in raw:
                raw = raw.split("```json")[1].split("```")[0].strip()
            elif "```" in raw:
                raw = raw.split("```")[1].split("```")[0].strip()
            else:
                start, end = raw.find("{"), raw.rfind("}") + 1
                if start >= 0 and end > start:
                    raw = raw[start:end]

            data = json.loads(raw)

            action = str(data.get("action", "CONFIRM")).upper()
            if action not in ("CONFIRM", "OVERRULE", "ADJUST"):
                action = "CONFIRM"

            confidence = max(0.0, min(1.0, float(data.get("confidence", 0.5))))

            if action == "OVERRULE" and confidence < config.overrule_min_confidence:
                action = "CONFIRM"

            stake_multiplier = float(data.get("stake_multiplier", 1.0))
            stake_multiplier = max(
                config.min_stake_multiplier,
                min(config.max_stake_multiplier, stake_multiplier),
            )
            if action in ("CONFIRM", "OVERRULE"):
                stake_multiplier = 1.0

            final_stake = 0.0 if action == "OVERRULE" else round(size * stake_multiplier, 2)
            overruled = action == "OVERRULE" or (
                action == "ADJUST" and abs(stake_multiplier - 1.0) > 0.01
            )

            return OddsAgentDecision(
                market_id=market_id,
                runner_name=runner_name,
                selection_id=selection_id,
                original_action="BET",
                original_stake=size,
                original_price=price,
                original_rule=rule_applied,
                agent_action=action,
                final_stake=final_stake,
                stake_multiplier=stake_multiplier,
                confidence=confidence,
                reasoning=str(data.get("reasoning", "")),
                odds_summary=str(data.get("odds_summary", "")),
                snapshots=snapshots,
                price_open=price_open,
                price_close=price_close,
                price_delta=price_delta,
                trend=trend,
                overruled=overruled,
                samples_taken=len(snapshots),
            )

        except Exception as e:
            logger.warning(f"Odds agent parse error for {runner_name}: {e}\nRaw: {text[:300]}")
            return self._fallback_decision(
                market_id, runner_name, selection_id, price, size, rule_applied,
                snapshots=snapshots,
                price_open=price_open,
                price_close=price_close,
                price_delta=price_delta,
                trend=trend,
                error=f"Parse error: {e}",
            )

    def _fallback_decision(
        self,
        market_id: str,
        runner_name: str,
        selection_id: int,
        price: float,
        size: float,
        rule_applied: str,
        snapshots: list = None,
        price_open: Optional[float] = None,
        price_close: Optional[float] = None,
        price_delta: Optional[float] = None,
        trend: str = "UNKNOWN",
        error: str = "",
    ) -> OddsAgentDecision:
        return OddsAgentDecision(
            market_id=market_id,
            runner_name=runner_name,
            selection_id=selection_id,
            original_action="BET",
            original_stake=size,
            original_price=price,
            original_rule=rule_applied,
            agent_action="CONFIRM",
            final_stake=size,
            stake_multiplier=1.0,
            confidence=0.0,
            reasoning="Odds agent unavailable — defaulting to strategy decision.",
            odds_summary="",
            snapshots=snapshots or [],
            price_open=price_open,
            price_close=price_close,
            price_delta=price_delta,
            trend=trend,
            overruled=False,
            samples_taken=len(snapshots) if snapshots else 0,
            error=error or None,
        )
