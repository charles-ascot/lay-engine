# BSP Optimiser — Rule Specification

**Rule ID:** `BSP_OPTIMISER`
**Module:** `engine.py` — `_register_bsp_candidate()` / `_bsp_monitor_loop()`
**UI Tab:** BSP Optimiser (Lay Engine frontend)
**Version:** 1.0 — March 2026

---

## 1. Strategy Overview

The BSP Optimiser exploits a consistent market dynamic in UK/IE horse racing: favourites that trade at a compressed pre-race price relative to their Betfair Starting Price (BSP) tend to contract further in-running after the off.

The strategy has two phases:

1. **Pre-race** — the market-implied favourite is identified and its BSP proxy is recorded at the point the engine places its regular lay bet.
2. **In-running** — once the market goes in-play and BSP is reconciled, a second lay bet is placed if the Last Traded Price (LTP) contracts to a target defined as a percentage below BSP.

The thesis: the crowd continues to push short-priced favourites even harder after the off, creating a lay opportunity at a price that is materially lower (shorter) than BSP — meaning the backer gets worse value, and the layer collects the overround.

---

## 2. Execution Logic

### 2.1 Candidate Registration (pre-race)

Triggered from `_process_market()` immediately after the standard lay bet decision is made.

**Steps:**

1. Filter to `ACTIVE` runners that have a `best_available_to_lay` price.
2. Identify the **favourite** as the runner with the lowest best-available-to-lay price.
3. Apply the `max_bsp` filter — if the favourite's proxy price exceeds the configured ceiling, skip the market.
4. Compute the **contraction target**:

   ```
   target = bsp_proxy × (1 - contraction_threshold_pct / 100)
   ```

   Example: `bsp_proxy = 3.00`, `contraction_threshold_pct = 10` → `target = 2.70`

5. Store the candidate in `engine._bsp_candidates[market_id]` with:
   - `selection_id`, `runner_name`
   - `bsp_proxy` (best-available-to-lay at registration time)
   - `target` (computed above)
   - `venue`, `race_time`, `country`
   - `registered_at` (Unix timestamp)
   - `bet_placed = False`

### 2.2 In-Play Monitoring

A dedicated daemon thread (`_bsp_monitor_loop`) runs every **3 seconds** while the engine is active.

For each registered candidate:

1. Call `betfair_client.get_inplay_ltp(market_id)` → returns `{in_play, status, bsp_reconciled, runners: {sel_id: {ltp, actual_sp}}}`.
2. If the market is not yet in-play, skip (keep waiting).
3. If the market is `CLOSED` or `SUSPENDED` and not in-play, discard.
4. Once in-play, check if `actual_sp` has been reconciled. If so, **recalculate the target** using the real BSP in place of the proxy.
5. Compare the runner's current `ltp` against `target`:
   - `ltp <= target` → **place the lay bet** (target hit).
   - `ltp > target` and elapsed time since registration > **360 seconds** (6 minutes in-play) → discard (timed out).
6. Candidates are automatically dropped after **1 hour** from registration (catches pre-race delays).

### 2.3 Bet Placement

When the target is hit:

- **Dry Run mode** (either engine-level or rule-level `dry_run = True`): bet is recorded to `engine.bets_placed` with `"betfair_response": {"status": "DRY_RUN"}` and `"rule_applied": "BSP_OPTIMISER"`.
- **Live mode**: `betfair_client.place_lay_order(market_id, selection_id, price=ltp, size=stake)` is called.

Stake is read from settings at the moment of placement (not at registration), so mid-session setting changes take effect immediately.

---

## 3. Configuration Parameters

All settings are stored in `engine.settings["bsp_optimiser"]` and persisted to GCS.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Master on/off switch for the live rule |
| `dry_run` | bool | `true` | Rule-level dry run (independent of engine dry run) |
| `contraction_threshold_pct` | float | `10.0` | % the in-play LTP must fall below BSP to trigger |
| `stake_pts` | float | `2.0` | Lay stake in points (× point value = £ stake) |
| `max_bsp` | float \| null | `null` | Upper BSP filter — skip favourites above this price |

---

## 4. Analysis Tool

The **Analysis sub-tab** in the BSP Optimiser UI allows retrospective testing of any threshold setting against historical stream data before enabling the live rule.

### 4.1 Data Pipeline

```
FSU1 (betfair-historic-adv)
  └─ GET /api/bsp-analysis/{date}
        └─ Scans .bz2 stream files
        └─ Extracts BSP (bspReconciled), pre-off LTP, in-play min/max LTP
  └─ Lay Engine enriches with RP Scraper (race class, going, pattern)
  └─ Computes contraction_pct, hit flag per runner
  └─ Aggregates to summary + BSP band breakdown
```

### 4.2 Key Output Fields (per runner row)

| Field | Source | Description |
|---|---|---|
| `bsp` | Stream `marketDefinition.runners[].bsp` | Betfair Starting Price |
| `pre_off_ltp` | Stream LTP on `inPlay` transition | Last trade immediately before off |
| `contraction_pct` | Computed | `(1 - in_play_min / bsp) × 100` |
| `inplay_min` | Stream LTP minimum post-off | Best in-play contraction achieved |
| `inplay_max` | Stream LTP maximum post-off | Worst drift post-off |
| `won` | Stream `winner` flag | Whether the runner won the race |
| `hit` | Computed | `inplay_min <= bsp × threshold` |

### 4.3 Summary Cards

| Card | Meaning |
|---|---|
| Days Analysed | Calendar days processed from FSU1 data |
| Markets | Unique races where a favourite was tracked |
| Favourites | Total qualifying favourites across all markets |
| Qualified | Favourites where `hit = true` (target was reached in-play) |
| Win Rate | `qualified / favourites × 100` |
| Avg Contraction | Mean `contraction_pct` across all favourites |
| Avg BSP | Mean BSP of all favourites in the sample |

### 4.4 BSP Band Breakdown

Results are segmented into four BSP bands to identify where the edge is strongest:

| Band | Notes |
|---|---|
| Under 2.0 | Very short favourites — high hit rate, very small margin |
| 2.0 – 3.0 | Core range for UK flat/jump favourites |
| 3.0 – 5.0 | Mid-range — often higher contraction magnitude |
| 5.0+ | Longer shots — less reliable, more drift risk |

---

## 5. Backtest vs Live Consistency

The same `contraction_threshold_pct` parameter governs both the analysis tool and the live rule, so the threshold validated in Analysis can be transferred directly to Live Settings with no conversion.

| Mode | Trigger | Data source |
|---|---|---|
| Analysis | Manual, via UI | FSU1 historical stream files (`.bz2`) |
| Live | Automatic, per market | Betfair Exchange API (`listMarketBook`) |

---

## 6. Integration with Lay Engine Pipeline

The BSP Optimiser runs **after** the standard lay bet decision in the main processing loop. It is additive — it does not gate or modify the primary lay bet. A market can produce both a standard lay bet and a BSP in-play lay bet independently.

Pipeline position:

```
SHORT_PRICE_CONTROL → Rules → JOFS → Signal Filters → MOM
  → Sandbox (FSU9) → AI Agents → Stake Sizing → [standard lay bet]
  → _register_bsp_candidate()                  [BSP candidate stored]
        ...
  → _bsp_monitor_loop() [background, 3s interval]
        → actual BSP reconciled → target updated
        → LTP hits target → in-play lay placed
```

---

## 7. Risk Controls

- **Max BSP filter** — prevents the rule from chasing long-priced runners where in-play swings are unpredictable.
- **In-play timeout** — 360 seconds (6 minutes). If the target is not reached within this window the candidate is dropped. This prevents holding exposure through the full race.
- **Registration timeout** — 1 hour. Handles edge cases where a market is registered but never goes in-play (abandoned races, late suspensions).
- **One bet per market** — `bet_placed` flag ensures only one in-play lay is placed per candidate, regardless of how many further contractions occur.
- **Rule-level dry run** — `dry_run` setting is independent of the engine's global dry run flag, allowing the rule to paper-trade while the rest of the engine runs live (or vice versa).

---

## 8. Bet Record Fields

Every BSP Optimiser bet appended to `engine.bets_placed` includes the following additional fields beyond the standard bet schema:

| Field | Value |
|---|---|
| `rule_applied` | `"BSP_OPTIMISER"` |
| `bsp_proxy` | BSP or pre-race proxy at time of placement |
| `target` | Computed target price that triggered the bet |
| `dry_run` | `true` / `false` |

---

## 9. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/bsp-optimiser/run` | Start an analysis job. Returns `job_id`. |
| `GET` | `/api/bsp-optimiser/job/{job_id}` | Poll job status and result. |
| `GET` | `/api/bsp-optimiser/settings` | Retrieve live rule settings + active candidates. |
| `POST` | `/api/bsp-optimiser/settings` | Update one or more live rule settings. |

---

## 10. Suggested Calibration Workflow

1. Run Analysis over a 30–60 day window with `contraction_threshold_pct = 10`, `max_bsp = 6`.
2. Review the **BSP Band Breakdown** — identify which bands show a qualified % above 50%.
3. Tighten or relax the threshold in increments of 2–3%, re-running each time.
4. Once a threshold shows consistent hit rate in the 2.0–5.0 BSP range, transfer to Live Settings.
5. Enable with `dry_run = true` for 1–2 weeks of paper trading before going live.
6. Monitor active candidates via the Live Rule Settings sub-tab during sessions.
