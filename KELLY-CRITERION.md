# Kelly Criterion — Briefing Document

**Project:** CHIMERA Lay Engine
**Version:** 5.2.0+
**Prepared for:** Mark
**Date:** 15 March 2026

---

## 1. What Is the Kelly Criterion?

The Kelly Criterion is a mathematical formula for calculating the **optimal size of a bet** relative to your available bankroll. It was developed in 1956 by John L. Kelly Jr., a physicist at Bell Labs, and has since become one of the most respected tools in professional gambling, trading, and investment management.

The core principle is elegantly simple:

> **Bet proportionally to your edge. Never bet more than your edge justifies.**

---

## 2. The Formula

For a standard win/lose bet:

```
f* = (bp - q) / b
```

Where:
- **f*** = the fraction of your bankroll to stake
- **b** = the net odds received on the bet (decimal odds minus 1)
- **p** = your estimated probability of winning
- **q** = your estimated probability of losing (1 − p)

### Lay Betting Adaptation

Because CHIMERA places **lay bets** (betting against a horse winning), the formula is adapted:

```
f* = (p - (1 - p) / (b - 1)) / 1
```

Or equivalently, Kelly for laying:

```
f* = p - (1 - p) / (lay_price - 1)
```

Where **p** is your estimated probability that the horse **loses** (i.e., the lay succeeds).

---

## 3. Why Does It Matter?

Without stake sizing logic, a betting strategy is incomplete. You can have a genuine edge and still go broke if you:

- Over-stake during a losing run (ruin)
- Under-stake during a winning run (missed profit)

Kelly solves both problems simultaneously. It is **mathematically proven** to maximise the long-run growth rate of a bankroll — a property no other staking system can claim.

### Real-World Adoption

Kelly Criterion (or a variant of it) has been used by:

- **Bill Benter** — widely considered the most successful horse racing bettor in history, whose syndicate reportedly earned over $1 billion from Hong Kong racing
- **Edward Thorp** — mathematician, blackjack pioneer, and hedge fund manager (*Beat the Dealer*, *A Man for All Seasons*)
- **Renaissance Technologies** — the Medallion Fund, arguably the greatest trading fund ever, applies Kelly-based position sizing
- **Warren Buffett / Charlie Munger** — have publicly acknowledged Kelly principles in capital allocation decisions

---

## 4. The Four Variants in CHIMERA

CHIMERA implements four Kelly variants, selectable via the UI:

| Variant | Formula | Description |
|---|---|---|
| **Full Kelly** | f* | Maximum growth — aggressive, higher variance |
| **Half Kelly** | f* × 0.5 | The most widely recommended starting point |
| **Quarter Kelly** | f* × 0.25 | Conservative — strong protection against edge estimation errors |
| **Custom Fraction** | f* × n | User-defined fraction (0.1 – 1.0) |

### Why Not Always Use Full Kelly?

Full Kelly is theoretically optimal **only if your edge estimate is perfectly accurate**. In practice, edge estimates always carry uncertainty — and Full Kelly is ruthlessly punishing when the edge is overestimated. A 10% overestimation of edge on Full Kelly can roughly halve your growth rate.

**The professional consensus is ½ Kelly or ¼ Kelly** for real-world use. This accepts a modest reduction in growth rate in exchange for significantly reduced drawdown and variance.

---

## 5. Key Parameters in the CHIMERA UI

When Kelly Criterion Control is enabled, the following controls appear:

| Control | What It Does | Recommended Starting Value |
|---|---|---|
| **Kelly Fraction** | Full / Half / Quarter / Custom | Half Kelly |
| **Bankroll (£)** | Your total available betting bank | Your actual bank |
| **Estimated Edge %** | Your assessed edge over the market | 3–8% (conservative) |
| **Min Stake (£)** | Floor — Kelly will never suggest below this | £0.50 |
| **Max Stake (£)** | Ceiling — Kelly will never suggest above this | £20–£50 |
| **Max % of Bankroll** | Hard cap per bet as % of bank | 5–10% |

### The Edge Estimate — The Most Important Input

The Edge % is your assessment of how much better your model's probability estimate is than the market's implied probability. This is the single most sensitive input in the formula.

**Example:**
- Market lay price: 3.0 (implied win probability: 33.3%)
- Your model estimates the horse will actually win only 25% of the time
- Your edge = 33.3% − 25% = **8.3%**

If you are uncertain about your edge, **always err lower** (3–5%) and use ¼ Kelly until backtesting validates a higher figure.

---

## 6. How It Integrates with CHIMERA

### Flow with Kelly Enabled

```
Market identified by strategy rules
         ↓
Standard rules engine (JOFS, Mark Rules, Spread Control)
         ↓
[Optional] AI Internet Check agent
         ↓
[Optional] AI Odds Movement agent
         ↓
Kelly Criterion calculates stake size
         ↓
Stake applied (subject to Min / Max / % cap)
         ↓
Bet placed (live) or recorded (backtest)
```

Kelly sits at the **end of the pipeline**, after all rules and AI agents have confirmed a bet should be placed. It answers the question: **how much?**

### Toggle Behaviour

- **Kelly OFF** — Fixed stake (uplift stake setting, currently 3 pts) is used for all bets. Existing behaviour, unchanged.
- **Kelly ON** — Stake is calculated dynamically per bet based on the bankroll, edge, and lay price. Fixed stake setting is ignored.

Kelly is fully available in both **Live** and **Backtest** modes. In Backtest, the bankroll is updated after each simulated bet so Kelly sizing evolves realistically across the day.

---

## 7. A Worked Example

**Scenario:**
- Bankroll: £1,000
- Lay price: 4.0
- Estimated win probability (your model): 20%
- Therefore lay success probability: 80%
- Fraction: Half Kelly

**Kelly calculation:**
```
Full Kelly f* = p - (1-p) / (b - 1)
             = 0.80 - (0.20) / (4.0 - 1)
             = 0.80 - 0.0667
             = 0.7333  ← this is extremely high, lay bets at short prices are sensitive

Half Kelly  = 0.7333 × 0.5 = 0.3667

Stake       = £1,000 × 0.3667 = £366.70  ← would be capped by Max Stake
```

This example illustrates why a **Max Stake cap is essential**. Kelly can suggest large fractions at high confidence — the cap protects against catastrophic single-bet losses.

**With Max Stake = £20:** Kelly recommends £20 (capped). Sensible and safe.

---

## 8. Risks and Safeguards

| Risk | Safeguard in CHIMERA |
|---|---|
| Overestimated edge → overbetting | Start with ¼ Kelly; validate edge via backtest first |
| Single large loss wipes bank | Max Stake (£) and Max % of Bankroll caps |
| Compounding errors over time | Bankroll recalculated after each bet in backtest |
| Kelly disabled accidentally in live | Toggle state is persisted; UI clearly shows Kelly ON/OFF status |

---

## 9. Recommended Getting-Started Sequence

1. **Run Dec 10, 2025 backtest with Kelly OFF** — establish your fixed-stake baseline P&L
2. **Run the same day with ¼ Kelly, Edge 5%, bankroll £1,000, Max £20** — compare
3. **Run again with ½ Kelly** — see the difference in growth vs. variance
4. **Validate your edge estimate** — does 5% feel right given the backtest results? Adjust and re-run
5. **Only move to live Kelly once backtest confidence is established** — minimum 30 days of backtest data recommended

---

## 10. Summary

| | Fixed Stake | Kelly Criterion |
|---|---|---|
| Stake per bet | Always the same | Varies with edge and price |
| Optimal growth | No | Yes (mathematically proven) |
| Requires edge estimate | No | Yes |
| Ruin protection | Only via manual limits | Built into the formula |
| Used by Bill Benter | No | Yes |
| Recommended for CHIMERA | Baseline / starting point | Target operating mode |

The Kelly Criterion is not a magic formula — it requires honest, well-calibrated edge estimates to deliver its theoretical benefits. But when those estimates are grounded in real backtest data, it is the single most powerful stake sizing tool available to a professional bettor.

---

*CHIMERA Lay Engine — Internal Technical Document*
*Kelly Criterion module: `backend/kelly_criterion.py`*
*UI controls: Backtest Config Panel → Kelly Criterion Control / Live Dashboard → Kelly Criterion Control*
