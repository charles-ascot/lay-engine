"""
Kelly Criterion stake sizing for lay betting.

For a lay bet at decimal odds O with an estimated edge over the market:

  p_lose = market-implied P(horse loses) + edge_pct %
  f*     = p_lose − (1 − p_lose) / (O − 1)   [Kelly fraction for layers]
  stake  = bankroll × f* × kelly_fraction      [fractional Kelly]
  stake  = clamp(stake, min_stake, max_stake)

The fractional multiplier (0.25 = quarter Kelly) is strongly recommended to
reduce variance; full Kelly (1.0) is theoretically optimal but incurs large
swings in practice.

Completely standalone — no imports from the rest of the codebase.
"""

from __future__ import annotations
from dataclasses import dataclass, asdict


@dataclass
class KellyConfig:
    enabled: bool = False
    fraction: float = 0.25      # 0.25 = quarter Kelly, 0.5 = half, 1.0 = full
    bankroll: float = 1000.0    # Total betting bankroll £
    edge_pct: float = 5.0       # Assumed edge % over market-implied probability
    min_stake: float = 0.50     # Stake floor £ (never bet less than this)
    max_stake: float = 50.0     # Stake ceiling £ (never bet more than this)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "KellyConfig":
        return cls(
            enabled=bool(d.get("kelly_enabled", False)),
            fraction=float(d.get("kelly_fraction", 0.25)),
            bankroll=float(d.get("kelly_bankroll", 1000.0)),
            edge_pct=float(d.get("kelly_edge_pct", 5.0)),
            min_stake=float(d.get("kelly_min_stake", 0.50)),
            max_stake=float(d.get("kelly_max_stake", 50.0)),
        )


def calculate_kelly_stake(
    lay_odds: float,
    config: KellyConfig,
    base_stake: float,
) -> float:
    """
    Calculate Kelly-optimal lay stake.

    Returns base_stake unchanged when Kelly is disabled or lay_odds ≤ 1.0.
    Falls back to base_stake if the Kelly fraction is non-positive (no
    mathematical edge at these odds), so the strategy bet still stands.

    Args:
        lay_odds:   Betfair decimal lay price (e.g. 2.50).
        config:     KellyConfig with bankroll, fraction, edge, min/max.
        base_stake: The stake the rules engine chose — used as fallback.

    Returns:
        Optimal stake in £, rounded to 2 decimal places.
    """
    if not config.enabled or lay_odds <= 1.0:
        return base_stake

    # Market-implied probability of the horse WINNING
    p_win_market = 1.0 / lay_odds

    # Adjust: we believe the horse is *less likely* to win than the market
    # implies — that gap is our lay edge.
    p_lose = (1.0 - p_win_market) + (config.edge_pct / 100.0)
    p_lose = min(p_lose, 0.999)  # cap sanity
    p_win = 1.0 - p_lose

    # Kelly fraction for a lay bet
    # For a layer: net win per £ staked = 1.0 (horse loses)
    #              net loss per £ staked = (O − 1) (horse wins)
    # f* = p_lose − p_win / (O − 1)
    kelly_f = p_lose - p_win / (lay_odds - 1.0)

    if kelly_f <= 0.0:
        # No mathematical edge at these odds — fall back to strategy stake
        return base_stake

    # Apply fractional Kelly
    stake = config.bankroll * kelly_f * config.fraction

    # Clamp to configured floor and ceiling
    stake = max(config.min_stake, min(config.max_stake, stake))

    return round(stake, 2)


def kelly_stake_detail(
    lay_odds: float,
    config: KellyConfig,
    base_stake: float,
) -> dict:
    """
    Same as calculate_kelly_stake but returns a breakdown dict for logging
    and UI display (useful in backtest results).
    """
    if not config.enabled or lay_odds <= 1.0:
        return {
            "kelly_enabled": False,
            "kelly_stake": base_stake,
            "kelly_fraction_raw": None,
            "kelly_fraction_applied": None,
            "p_lose_estimate": None,
            "fallback": True,
        }

    p_win_market = 1.0 / lay_odds
    p_lose = min((1.0 - p_win_market) + (config.edge_pct / 100.0), 0.999)
    p_win = 1.0 - p_lose
    kelly_f = p_lose - p_win / (lay_odds - 1.0)
    fallback = kelly_f <= 0.0

    if fallback:
        stake = base_stake
    else:
        stake = config.bankroll * kelly_f * config.fraction
        stake = round(max(config.min_stake, min(config.max_stake, stake)), 2)

    return {
        "kelly_enabled": True,
        "kelly_stake": stake,
        "kelly_fraction_raw": round(kelly_f, 6) if not fallback else None,
        "kelly_fraction_applied": round(kelly_f * config.fraction, 6) if not fallback else None,
        "p_lose_estimate": round(p_lose, 4),
        "fallback": fallback,
    }
