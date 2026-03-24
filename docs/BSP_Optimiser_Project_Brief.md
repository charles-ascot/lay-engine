# CHIMERA — BSP Optimiser: Project Brief
### What We Built & Why It Was Hard
**Prepared for:** Mark
**Date:** 24 March 2026
**Author:** Charles Duckitt

---

## The Short Version

We built a new trading rule for the CHIMERA platform that automatically places lay bets on race favourites *during* a race, exploiting a consistent price compression pattern that occurs at the Betfair Starting Price. It comes with a full historical analysis tool so we can measure the edge before risking a penny in live markets.

Today, from scratch, in a single session.

---

## The Opportunity We're Trading

When a horse is a strong favourite, the betting market has a habit of continuing to push its price shorter (tighter) even *after* the race has started. This is driven by in-running traders piling on to back what looks like a certain winner — and it creates a predictable window where laying that favourite at a price *below* its Betfair Starting Price (BSP) is a statistically advantageous position.

In simple terms:

- The horse goes off at BSP 3.00
- Within the first 30–60 seconds of the race, the price trades down to 2.70
- We lay at 2.70 — meaning we are effectively getting better odds than the starting price for taking on the favourite

If we can reliably identify markets where this contraction happens and size appropriately, this is a genuine structural edge — not a gut call.

---

## What We Built

### 1. The Analysis Tool

Before switching anything on live, we need to know whether the edge actually exists in the data, how large it is, and in which conditions it's strongest.

We built a full retrospective analysis tool that:

- Scans across any date range of historical racing data (we have records going back to 2024)
- Identifies the BSP favourite in every race
- Measures what the price actually did in the first few minutes after the off
- Calculates how often the price contracted to a given target (e.g. "fell by at least 10% from BSP")
- Breaks down the results by BSP price band (e.g. favourites priced 2.0–3.0 vs 3.0–5.0) to find where the edge is sharpest
- Produces a downloadable spreadsheet of every single data point

You run this tool from the CHIMERA interface, set your date range and target threshold, hit Run, and within a few minutes you have a full statistical picture of what the market has done historically.

### 2. The Live Trading Rule

Once the analysis validates a threshold, it can be switched on as a live trading rule with a single toggle. When active:

- At the point the engine registers a standard lay bet, it simultaneously flags the favourite as a "BSP candidate"
- It records the pre-race price as a BSP proxy and calculates the target entry price
- The moment the race goes in-play, a background process starts monitoring the price every 3 seconds via the Betfair API
- When (or if) the price hits the target, a lay bet is placed automatically at that price
- If the price never contracts far enough within 6 minutes of the off, the position is safely abandoned — no bet is placed

The rule has its own dry-run mode, independent of the rest of the engine, so we can paper-trade it alongside real live bets to build confidence before full deployment.

---

## Why the Data Side Was Genuinely Complex

This is the part that looks simple from the outside but involved solving several non-trivial engineering problems.

### The Data Itself Lives in Two Formats in Two Time Periods

Betfair's historical market data is stored in a Google Cloud Storage bucket containing thousands of compressed stream files (one per race meeting, per day). But the format is not consistent:

- **Pre-2026 data (ADVANCED tier):** Full price ladder — every available price and volume at every point in time. This is the rich data needed for backtesting.
- **2026 onwards (BASIC tier):** Only the last-traded price is recorded — the full ladder is absent.

These files are not labelled or separated by Betfair — they are all in the same bucket and look identical from the outside. We had to build a routing layer that automatically detects which tier applies for any given date and adjusts accordingly, transparently, without the user needing to know or care.

### The Stream Format Is Not a Database

Each file is a compressed stream of thousands of JSON messages, recorded exactly as Betfair broadcast them in real time. There is no index, no schema, and no clean separation of events. To extract BSP from one of these files, you have to:

1. Decompress the file
2. Read through every single message line by line — which could be tens of thousands of lines per file
3. Identify the specific moment a `bspReconciled` flag appears in a `marketDefinition` message
4. At that same moment, read the `bsp` value attached to each runner
5. Separately, track the *last traded price* at the instant the `inPlay` flag flips to `true` (the exact pre-off price)
6. Then continue tracking the in-play LTP through all subsequent messages to find the minimum and maximum prices after the off

This has to be done for hundreds of files across a multi-week analysis window, each one potentially 50–100MB compressed. We built a dedicated extraction engine on FSU1 (our Data Replay service) that does all of this and returns clean, structured data to the analysis tool.

### The Date Ceiling Problem

The backtest interface had a hard-coded date ceiling of 31 December 2025 — meaning it was impossible to test anything using January or February 2026 data at all. We fixed this so the date picker always extends to the current date, and the data tier routing handles the format difference automatically.

### Making Historical and Live Use the Same Settings

One of the design goals was that the threshold you validate in the analysis tool should be the exact same number you configure in the live rule — no conversion, no ambiguity. This required aligning the way the analysis engine (which processes historical files) and the live trading rule (which polls the Betfair API in real time) both interpret the "contraction threshold" parameter. We standardised this to a single `contraction_threshold_pct` setting across the entire stack.

### The AI Agent Could Not See Recent History

A separate issue we also resolved today: the CHIMERA AI chat agent was only looking at the last 10 trading sessions and was ignoring all Dry Run sessions entirely. This meant it had a blind spot covering roughly six weeks of trading history. We corrected the history pipeline so the AI now has full visibility back to mid-February across all session types (Live and Dry Run), including daily performance summaries and stake exposure data.

---

## Current Status

| Component | Status |
|---|---|
| Historical analysis tool | Complete — live in UI |
| Live trading rule | Complete — ready for dry-run testing |
| BSP band breakdown in analysis | Complete |
| CSV data export | Complete |
| Dry-run mode (rule-level) | Complete |
| Integration with existing engine pipeline | Complete |
| Documentation | Complete |

The system is deployed and live on Cloud Run. No manual deployment was required — the platform auto-deploys on code push.

---

## Recommended Next Step

Run the analysis tool over the last 60 days of data at `contraction_threshold_pct = 10` and `max_bsp = 6.0`. Review the BSP band breakdown — specifically the hit rate in the 2.0–3.0 and 3.0–5.0 bands. If hit rate is consistently above 50% in those bands, enable the rule in dry-run mode for two weeks before going live.

---

*CHIMERA is a proprietary algorithmic trading platform built for Betfair Exchange markets.*
*All historical data is sourced from Betfair's official stream API. No third-party data providers are used for execution.*
