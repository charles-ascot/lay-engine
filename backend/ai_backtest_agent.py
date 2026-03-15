"""
CHIMERA AI Backtest Agent
=========================
An agentic research overlay for the standard backtest strategy.

This module is completely isolated from the live betting engine.
It is only invoked when `ai_agent_enabled=True` in a BacktestRunRequest.
It has NO side effects on live sessions, engine state, or Betfair connectivity.

Flow:
  1. Standard rules engine runs first → produces RuleResult list
  2. For each market where strategy says "place a bet", the agent:
     a. Searches the web for runner info (only info available before the backtest date)
     b. Runs an agentic Claude loop (tool_use) to gather and synthesise research
     c. Returns an AgentDecision: CONFIRM / OVERRULE / ADJUST
  3. Caller applies decisions to modify the instructions list
  4. P&L is then computed on the agent-adjusted instructions
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class AgentConfig:
    """Toggleable settings for the AI backtest agent."""
    max_searches_per_runner: int = 4      # Max web searches the agent may make per runner
    stake_adjustment_enabled: bool = True  # Whether ADJUST decisions are honoured
    max_stake_multiplier: float = 2.0      # Upper cap on stake multiplier
    min_stake_multiplier: float = 0.25     # Lower cap on stake multiplier
    overrule_min_confidence: float = 0.65  # Min confidence required to overrule


# ---------------------------------------------------------------------------
# Output types
# ---------------------------------------------------------------------------

@dataclass
class AgentDecision:
    """The agent's final decision for a single lay instruction."""
    market_id: str
    runner_name: str
    selection_id: int

    # Strategy's original intent
    original_action: str          # always "BET"
    original_stake: float
    original_price: float
    original_rule: str

    # Agent's verdict
    agent_action: str             # "CONFIRM" | "OVERRULE" | "ADJUST"
    final_stake: float
    stake_multiplier: float
    confidence: float             # 0.0–1.0
    reasoning: str
    research_summary: str

    # Meta
    overruled: bool               # True if agent changed the strategy decision
    searches_performed: int
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Main agent class
# ---------------------------------------------------------------------------

class BacktestAIAgent:
    """
    Wraps the Anthropic client to run a multi-turn research loop for each runner.

    Usage:
        agent = BacktestAIAgent(anthropic_client, backtest_date="2025-12-10")
        decisions = agent.process_rule_results(rule_results_list, config)
        # decisions: dict[market_id] -> list[AgentDecision]
    """

    MODEL = "claude-sonnet-4-6"

    def __init__(self, anthropic_client, backtest_date: str):
        self.client = anthropic_client
        self.backtest_date = backtest_date   # "YYYY-MM-DD"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process_rule_results(
        self,
        rule_results: list,          # list of dicts (from to_dict()) or RuleResult objects
        config: AgentConfig,
    ) -> dict[str, list[AgentDecision]]:
        """
        Iterate over rule results and return agent decisions keyed by market_id.
        Only processes markets that the strategy wants to bet on (not skipped ones).
        """
        decisions: dict[str, list[AgentDecision]] = {}

        for rr in rule_results:
            # Support both dict and dataclass
            if hasattr(rr, '__dict__'):
                market_id = rr.market_id
                market_name = getattr(rr, 'market_name', '')
                venue = getattr(rr, 'venue', '')
                race_time = getattr(rr, 'race_time', '')
                skipped = rr.skipped
                instructions = rr.instructions
            else:
                market_id = rr.get('market_id', '')
                market_name = rr.get('market_name', '')
                venue = rr.get('venue', '')
                race_time = rr.get('race_time', '')
                skipped = rr.get('skipped', True)
                instructions = rr.get('instructions', [])

            if skipped or not instructions:
                continue

            market_decisions = []
            for instr in instructions:
                # Support both dict and LayInstruction
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

                decision = self._research_and_decide(
                    market_id=market_id,
                    market_name=market_name,
                    venue=venue,
                    race_time=race_time,
                    runner_name=runner_name,
                    selection_id=selection_id,
                    price=price,
                    size=size,
                    rule_applied=rule_applied,
                    config=config,
                )
                market_decisions.append(decision)

            decisions[market_id] = market_decisions

        return decisions

    # ------------------------------------------------------------------
    # Internal: agent loop
    # ------------------------------------------------------------------

    def _research_and_decide(
        self,
        market_id: str,
        market_name: str,
        venue: str,
        race_time: str,
        runner_name: str,
        selection_id: int,
        price: float,
        size: float,
        rule_applied: str,
        config: AgentConfig,
    ) -> AgentDecision:
        """Run the agentic research loop for a single runner, return a decision."""

        searches_performed = 0

        system_prompt = f"""You are a horse racing research analyst for a backtesting system.

CRITICAL DATE CONSTRAINT:
Today (in this simulation) is {self.backtest_date}. You are gathering intelligence as of this date.
You MUST only consider information that was publicly available BEFORE {self.backtest_date}.
If any search result mentions events or outcomes that occurred on or after {self.backtest_date},
you must discard that information as "future knowledge" and not factor it into your decision.
This is essential for a valid backtest — using future information would be cheating.

YOUR TASK:
The standard strategy (a mechanical rules engine) wants to LAY the following runner:

  Race:       {market_name} at {venue}
  Race Time:  {race_time}
  Runner:     {runner_name}
  Lay Odds:   {price}
  Stake:      £{size}
  Rule Used:  {rule_applied}

Laying means we are betting AGAINST this horse winning. We profit if ANY other horse wins.
We lose our liability (£{round(size * (price - 1), 2)}) if this horse wins.

Use the web_search tool to gather relevant pre-race intelligence. Consider:
- Recent form (last 3-6 runs before {self.backtest_date})
- Trainer/jockey confidence signals, interviews, quotes
- Course/going suitability
- Reported fitness or injury concerns
- Any significant market moves or industry tips
- The horse's profile at these odds (is it a worthy favourite?)

Search strategically — you may search up to {config.max_searches_per_runner} times.
When you have enough information, provide your FINAL DECISION as a JSON object (nothing else):

{{
  "action": "CONFIRM" | "OVERRULE" | "ADJUST",
  "stake_multiplier": <float between {config.min_stake_multiplier} and {config.max_stake_multiplier}>,
  "confidence": <float 0.0–1.0>,
  "reasoning": "<1-3 sentence explanation of your decision>",
  "research_summary": "<key findings from your research, max 200 words>"
}}

DECISION GUIDE:
- CONFIRM  → Research supports the lay. Proceed with the strategy's stake.
- OVERRULE → Strong evidence the horse is likely to WIN (bad lay). Skip this bet.
- ADJUST   → Proceed but with a modified stake (use stake_multiplier ≠ 1.0).

Only OVERRULE if confidence ≥ {config.overrule_min_confidence:.0%}.
If research is sparse or inconclusive, CONFIRM with moderate confidence.
Set stake_multiplier = 1.0 for CONFIRM and OVERRULE actions.
"""

        tools = [
            {
                "name": "web_search",
                "description": (
                    "Search the internet for information about a horse, race, trainer, or jockey. "
                    f"IMPORTANT: Only use results published before {self.backtest_date}."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query string",
                        }
                    },
                    "required": ["query"],
                },
            }
        ]

        messages = [{"role": "user", "content": "Please research this runner and provide your decision."}]

        try:
            for _turn in range(config.max_searches_per_runner + 2):
                response = self.client.messages.create(
                    model=self.MODEL,
                    max_tokens=1500,
                    system=system_prompt,
                    tools=tools,
                    messages=messages,
                )

                # Add assistant response to conversation
                messages.append({"role": "assistant", "content": response.content})

                if response.stop_reason == "end_turn":
                    # Extract JSON decision from the final text block
                    for block in response.content:
                        if hasattr(block, 'text'):
                            return self._parse_decision(
                                block.text,
                                market_id=market_id,
                                runner_name=runner_name,
                                selection_id=selection_id,
                                price=price,
                                size=size,
                                rule_applied=rule_applied,
                                searches_performed=searches_performed,
                                config=config,
                            )
                    break

                if response.stop_reason == "tool_use":
                    # Execute all requested tool calls
                    tool_results = []
                    for block in response.content:
                        if block.type == "tool_use" and block.name == "web_search":
                            if searches_performed >= config.max_searches_per_runner:
                                result_text = "Search limit reached. Please provide your final decision now."
                            else:
                                query = block.input.get("query", "")
                                result_text = self._web_search(query, runner_name)
                                searches_performed += 1

                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": result_text,
                            })

                    if tool_results:
                        messages.append({"role": "user", "content": tool_results})
                    else:
                        break
                else:
                    break

        except Exception as e:
            logger.warning(f"AI agent error for {runner_name}: {e}")
            return self._fallback_decision(
                market_id=market_id,
                runner_name=runner_name,
                selection_id=selection_id,
                price=price,
                size=size,
                rule_applied=rule_applied,
                error=str(e),
            )

        # If we exit the loop without a clean end_turn, fallback
        return self._fallback_decision(
            market_id=market_id,
            runner_name=runner_name,
            selection_id=selection_id,
            price=price,
            size=size,
            rule_applied=rule_applied,
            error="Agent loop completed without a clear decision.",
        )

    # ------------------------------------------------------------------
    # Internal: web search via DuckDuckGo
    # ------------------------------------------------------------------

    def _web_search(self, query: str, runner_name: str) -> str:
        """Execute a DuckDuckGo web search and return formatted results."""
        try:
            from duckduckgo_search import DDGS

            # Add runner name context if not already in the query
            if runner_name.lower() not in query.lower():
                query = f"{runner_name} horse racing {query}"

            results = []
            with DDGS() as ddgs:
                raw = list(ddgs.text(query, max_results=5, safesearch="off"))

            for r in raw:
                title = r.get("title", "")
                snippet = r.get("body", "")
                url = r.get("href", "")
                results.append(f"Title: {title}\nURL: {url}\nSnippet: {snippet}\n")

            if not results:
                return f"No results found for: {query}"

            return (
                f"Search results for: '{query}'\n"
                f"[IMPORTANT: Only use information published before {self.backtest_date}]\n\n"
                + "\n---\n".join(results)
            )

        except ImportError:
            return (
                "duckduckgo-search library not installed. "
                "Install with: pip install duckduckgo-search"
            )
        except Exception as e:
            return f"Search failed: {str(e)}"

    # ------------------------------------------------------------------
    # Internal: parse and validate Claude's JSON decision
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
        searches_performed: int,
        config: AgentConfig,
    ) -> AgentDecision:
        """Extract and validate the JSON decision from Claude's response."""
        try:
            # Try to extract JSON from the text (Claude may wrap it in markdown)
            raw = text.strip()
            if "```json" in raw:
                raw = raw.split("```json")[1].split("```")[0].strip()
            elif "```" in raw:
                raw = raw.split("```")[1].split("```")[0].strip()
            else:
                # Find the JSON object
                start = raw.find("{")
                end = raw.rfind("}") + 1
                if start >= 0 and end > start:
                    raw = raw[start:end]

            data = json.loads(raw)

            action = str(data.get("action", "CONFIRM")).upper()
            if action not in ("CONFIRM", "OVERRULE", "ADJUST"):
                action = "CONFIRM"

            confidence = float(data.get("confidence", 0.5))
            confidence = max(0.0, min(1.0, confidence))

            # Enforce minimum confidence for overrule
            if action == "OVERRULE" and confidence < config.overrule_min_confidence:
                action = "CONFIRM"

            stake_multiplier = float(data.get("stake_multiplier", 1.0))
            stake_multiplier = max(
                config.min_stake_multiplier,
                min(config.max_stake_multiplier, stake_multiplier),
            )

            # Force multiplier = 1.0 for CONFIRM/OVERRULE
            if action in ("CONFIRM", "OVERRULE"):
                stake_multiplier = 1.0

            if action == "OVERRULE" or not config.stake_adjustment_enabled:
                final_stake = 0.0 if action == "OVERRULE" else size
            else:
                final_stake = round(size * stake_multiplier, 2)

            overruled = action == "OVERRULE" or (
                action == "ADJUST" and abs(stake_multiplier - 1.0) > 0.01
            )

            return AgentDecision(
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
                research_summary=str(data.get("research_summary", "")),
                overruled=overruled,
                searches_performed=searches_performed,
            )

        except Exception as e:
            logger.warning(f"Failed to parse agent decision for {runner_name}: {e}\nRaw: {text[:500]}")
            return self._fallback_decision(
                market_id=market_id,
                runner_name=runner_name,
                selection_id=selection_id,
                price=price,
                size=size,
                rule_applied=rule_applied,
                error=f"Parse error: {e}",
                searches_performed=searches_performed,
            )

    def _fallback_decision(
        self,
        market_id: str,
        runner_name: str,
        selection_id: int,
        price: float,
        size: float,
        rule_applied: str,
        error: str = "",
        searches_performed: int = 0,
    ) -> AgentDecision:
        """Safe fallback: confirm the strategy's bet if the agent fails."""
        return AgentDecision(
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
            reasoning="Agent analysis unavailable — defaulting to strategy decision.",
            research_summary="",
            overruled=False,
            searches_performed=searches_performed,
            error=error or None,
        )
