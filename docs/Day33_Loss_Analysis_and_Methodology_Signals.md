# Day 33 Loss Analysis — Applying the Dickreuter Methodology
**Date:** 2026-03-19 | **Net P&L:** -£311.80 | **Bets:** 32 | **Strike:** 56.25%

---

## Where the Session Was Lost

The £311.80 loss comes almost entirely from 5 bets:

| Runner | Venue | Odds | Liability | Loss |
|---|---|---|---|---|
| Poets Oath | Cork | 4.50 | £70.00 | -£70.00 |
| Emerald Enigma | Cork | 3.35 | £70.50 | -£70.50 |
| Fast Track Harry | Newcastle | 3.25 | £67.50 | -£67.51 |
| Royal Gladiator | Cork | 3.10 | £63.00 | -£63.00 |
| Fouroneohfever | Ludlow | 3.05 | £61.50 | -£61.50 |

Five bets. £332.51 in combined liability. That is where the session was lost.

---

## Signal 1 — Market Overround
**Status: Not in Chimera**

Cork produced 3 of the 5 catastrophic losses. Irish jumps markets — particularly midday Cork — routinely run higher book overrounds than UK venues. A higher overround means the market is less efficient, and the displayed favourite price is less trustworthy. The horse at 3.10 or 3.35 may have been a false favourite — a runner where the price reflects thin liquidity rather than genuine market opinion.

**Proposed rule:** Overround > 115% → reduce stake by 50%. Overround > 120% → skip.

This would likely have flagged all three Cork losses.

**Estimated saving: ~£100–£120**

---

## Signal 2 — Field Size
**Status: Not in Chimera**

Every single bet on Day 33 was National Hunt — hurdles and chases. NH fields frequently run 10–16 runners. The larger the field, the more chaotic the race, and the less reliable the favourite status is. A 3.10 favourite in a 14-runner novice hurdle at Cork is a very different proposition to a 3.10 favourite in a 6-runner conditions chase.

**Proposed rule:** Field > 10 runners AND odds > 3.0 → cap stake at £10.

Directly applicable to Royal Gladiator, Fouroneohfever, and likely Emerald Enigma.

**Estimated saving: ~£80–£100**

---

## Signal 3 — Price Steam as a Hard Gate
**Status: Partially in Chimera — not enforced**

The Odds Agent already classifies runners as SHORTENING / DRIFTING / STABLE, but that classification is advisory only. It informs the AI report; it does not gate bet placement.

The dickreuter philosophy is explicit: only bet when you have identified a pricing inefficiency. A horse shortening from 4.0 to 3.35 into the race is a horse the market is backing. The crowd is telling you something. Laying it anyway is betting against the information flow.

If SHORTENING triggered a skip or stake halving in the 3.0+ band, Emerald Enigma (-£70.50) and Poets Oath (-£70.00) would have been reduced or eliminated.

**Proposed rule:** Runner classified SHORTENING AND odds > 3.0 → skip or halve stake.

**Estimated saving: ~£70–£140 depending on how many were steaming**

---

## Signal 4 — Rolling Band Performance Filter
**Status: Not in Chimera**

The AI report on Day 33 recommends reducing stakes in the 3.0–3.99 band — but that recommendation is retrospective. By Day 33, this band had already been underperforming. A rolling 5-day win rate filter per band would have automatically reduced stakes before Day 33 fired.

The £30 stakes in this band — Fouroneohfever, Royal Gladiator, Emerald Enigma, Fast Track Harry — would have been capped at £10 automatically.

Liability reduction on those four bets alone: ~£220 → ~£75.

**Proposed rule:** 5-day win rate in band < 50% → reduce stake to £10.

**Estimated saving: ~£145**

---

## Summary

| Signal | Mechanism | Est. Saving |
|---|---|---|
| Overround filter | Cork/Irish markets flagged, stakes halved | ~£110 |
| Field size filter | >10 runners + odds >3.0 → cap £10 stake | ~£90 |
| Steam gate | SHORTENING in 3.0+ band → skip | ~£100 |
| Rolling band filter | 5-day <50% win rate → auto-reduce stake | ~£145 |

Some of these savings overlap — the same bets are caught by multiple signals — but the combined picture is clear. A session that ended -£311.80 likely ends flat or marginally positive with all four guards active.

---

## Conclusion

The engine's rules are sound. The problem on Day 33 was mechanical betting at full stake into deteriorating conditions that several signals were already broadcasting. The four signals above — overround, field size, steam direction, and rolling band performance — are the build targets.
