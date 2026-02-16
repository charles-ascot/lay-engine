"""
CHIMERA Lay Engine — Core Rules
================================
Pure rule-based lay betting. No intelligence. No ML. Just IF/WHEN logic.

RULES:
  1. All bets are LAY bets on the favourite (lowest odds runner)
  2. If favourite odds < 2.0  → £3 lay on favourite
  3. If favourite odds 2.0–5.0 → £2 lay on favourite
  4. If favourite odds > 5.0:
     a. If gap to 2nd favourite < 2 → £1 lay on fav + £1 lay on 2nd fav
     b. If gap to 2nd favourite ≥ 2 → £1 lay on favourite only
"""

from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime

# Maximum lay odds — skip markets where the favourite exceeds this.
# Odds like 560.00 indicate an illiquid market with no real trading.
MAX_LAY_ODDS = 50.0


@dataclass
class Runner:
    """A runner in a race with current market data."""
    selection_id: int
    runner_name: str
    handicap: float = 0.0
    best_available_to_lay: Optional[float] = None  # lowest lay price = best odds
    status: str = "ACTIVE"


@dataclass
class LayInstruction:
    """A single lay bet instruction to send to Betfair."""
    market_id: str
    selection_id: int
    runner_name: str
    price: float      # The lay odds
    size: float        # The stake (backer's stake we're accepting)
    rule_applied: str  # Which rule triggered this bet

    @property
    def liability(self) -> float:
        """What we lose if the horse wins."""
        return round(self.size * (self.price - 1), 2)

    def to_betfair_instruction(self) -> dict:
        """Format as Betfair placeOrders instruction."""
        return {
            "selectionId": str(self.selection_id),
            "handicap": "0",
            "side": "LAY",
            "orderType": "LIMIT",
            "limitOrder": {
                "size": str(self.size),
                "price": str(self.price),
                "persistenceType": "LAPSE"
            }
        }

    def to_dict(self) -> dict:
        return {
            "market_id": self.market_id,
            "selection_id": self.selection_id,
            "runner_name": self.runner_name,
            "price": self.price,
            "size": self.size,
            "liability": self.liability,
            "rule_applied": self.rule_applied,
        }


@dataclass
class RuleResult:
    """The output of applying rules to a market."""
    market_id: str
    market_name: str
    venue: str
    race_time: str
    instructions: list  # List[LayInstruction]
    favourite: Optional[Runner] = None
    second_favourite: Optional[Runner] = None
    skipped: bool = False
    skip_reason: str = ""
    rule_applied: str = ""
    evaluated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> dict:
        return {
            "market_id": self.market_id,
            "market_name": self.market_name,
            "venue": self.venue,
            "race_time": self.race_time,
            "favourite": {
                "name": self.favourite.runner_name,
                "odds": self.favourite.best_available_to_lay,
                "selection_id": self.favourite.selection_id,
            } if self.favourite else None,
            "second_favourite": {
                "name": self.second_favourite.runner_name,
                "odds": self.second_favourite.best_available_to_lay,
                "selection_id": self.second_favourite.selection_id,
            } if self.second_favourite else None,
            "instructions": [i.to_dict() for i in self.instructions],
            "skipped": self.skipped,
            "skip_reason": self.skip_reason,
            "rule_applied": self.rule_applied,
            "evaluated_at": self.evaluated_at,
            "total_stake": sum(i.size for i in self.instructions),
            "total_liability": sum(i.liability for i in self.instructions),
        }


def identify_favourites(runners: list[Runner]) -> tuple[Optional[Runner], Optional[Runner]]:
    """
    Identify the favourite (lowest lay odds) and second favourite.
    Only considers ACTIVE runners with available lay prices.
    """
    active = [
        r for r in runners
        if r.status == "ACTIVE" and r.best_available_to_lay is not None
    ]

    if len(active) < 1:
        return None, None

    # Sort by best available to lay (lowest = favourite)
    active.sort(key=lambda r: r.best_available_to_lay)

    favourite = active[0]
    second_favourite = active[1] if len(active) > 1 else None

    return favourite, second_favourite


def apply_rules(
    market_id: str,
    market_name: str,
    venue: str,
    race_time: str,
    runners: list[Runner],
) -> RuleResult:
    """
    Apply the lay betting rules to a market.
    Returns a RuleResult with zero or more LayInstructions.

    THE RULES (exhaustive):
      - Fav odds < 2.0  → £3 lay on fav
      - Fav odds 2.0–5.0 → £2 lay on fav
      - Fav odds > 5.0 AND gap to 2nd fav < 2 → £1 lay fav + £1 lay 2nd fav
      - Fav odds > 5.0 AND gap to 2nd fav ≥ 2 → £1 lay fav only
    """
    result = RuleResult(
        market_id=market_id,
        market_name=market_name,
        venue=venue,
        race_time=race_time,
        instructions=[],
    )

    # Step 1: Identify favourite and second favourite
    fav, second_fav = identify_favourites(runners)
    result.favourite = fav
    result.second_favourite = second_fav

    if fav is None:
        result.skipped = True
        result.skip_reason = "No active runners with available lay prices"
        return result

    odds = fav.best_available_to_lay

    # ─── Guard: Skip illiquid markets with absurd odds ───
    if odds > MAX_LAY_ODDS:
        result.skipped = True
        result.skip_reason = f"Favourite odds {odds} exceed max threshold ({MAX_LAY_ODDS})"
        return result

    # ─── RULE 1: Favourite odds < 2.0 → £3 lay ───
    if odds < 2.0:
        result.rule_applied = f"RULE_1: Fav odds {odds} < 2.0 → £3 lay"
        result.instructions.append(LayInstruction(
            market_id=market_id,
            selection_id=fav.selection_id,
            runner_name=fav.runner_name,
            price=odds,
            size=3.0,
            rule_applied="RULE_1_ODDS_UNDER_2",
        ))
        return result

    # ─── RULE 2: Favourite odds 2.0–5.0 → £2 lay ───
    if 2.0 <= odds <= 5.0:
        result.rule_applied = f"RULE_2: Fav odds {odds} in 2.0–5.0 → £2 lay"
        result.instructions.append(LayInstruction(
            market_id=market_id,
            selection_id=fav.selection_id,
            runner_name=fav.runner_name,
            price=odds,
            size=2.0,
            rule_applied="RULE_2_ODDS_2_TO_5",
        ))
        return result

    # ─── RULE 3: Favourite odds > 5.0 ───
    if odds > 5.0:
        # Need second favourite to calculate gap
        if second_fav is None:
            # No second favourite — just lay the favourite £1
            result.rule_applied = f"RULE_3B: Fav odds {odds} > 5.0, no 2nd fav → £1 lay fav only"
            result.instructions.append(LayInstruction(
                market_id=market_id,
                selection_id=fav.selection_id,
                runner_name=fav.runner_name,
                price=odds,
                size=1.0,
                rule_applied="RULE_3B_NO_SECOND_FAV",
            ))
            return result

        gap = second_fav.best_available_to_lay - odds

        if gap < 2.0:
            # Gap < 2 → £1 on fav + £1 on 2nd fav
            result.rule_applied = (
                f"RULE_3A: Fav odds {odds} > 5.0, gap {gap:.2f} < 2 "
                f"→ £1 fav + £1 2nd fav"
            )
            result.instructions.append(LayInstruction(
                market_id=market_id,
                selection_id=fav.selection_id,
                runner_name=fav.runner_name,
                price=odds,
                size=1.0,
                rule_applied="RULE_3A_FAV",
            ))
            result.instructions.append(LayInstruction(
                market_id=market_id,
                selection_id=second_fav.selection_id,
                runner_name=second_fav.runner_name,
                price=second_fav.best_available_to_lay,
                size=1.0,
                rule_applied="RULE_3A_SECOND_FAV",
            ))
            return result

        else:
            # Gap ≥ 2 → £1 on fav only
            result.rule_applied = (
                f"RULE_3B: Fav odds {odds} > 5.0, gap {gap:.2f} ≥ 2 "
                f"→ £1 fav only"
            )
            result.instructions.append(LayInstruction(
                market_id=market_id,
                selection_id=fav.selection_id,
                runner_name=fav.runner_name,
                price=odds,
                size=1.0,
                rule_applied="RULE_3B_WIDE_GAP",
            ))
            return result

    # Should never reach here
    result.skipped = True
    result.skip_reason = f"Unexpected odds value: {odds}"
    return result
