# CHIMERA Lay Engine — v2.1 Change Document
## 11 February 2026

---

## WHAT WAS (v2.0)

### Rules (rules.py)
- **No filters.** Every UK/IE WIN market was processed regardless of racing discipline.
- **No discipline detection.** The engine had no concept of flat vs jumps racing.
- **Rule 1:** Favourite odds < 2.0 → £3 lay on favourite
- **Rule 2:** Favourite odds 2.0–5.0 → £2 lay on favourite
- **Rule 3A:** Favourite odds > 5.0 AND gap to 2nd fav < 2 → £1 fav + £1 2nd fav
- **Rule 3B:** Favourite odds > 5.0 AND gap to 2nd fav ≥ 2 → £1 fav only

### Engine (engine.py)
- **Dedup:** Single layer only — `processed_runners` set using `(runner_name, race_time)` tuples
- **Timestamp:** Generated at placement time in `_place_bet` but no explicit `placed_at` field
- **Bet records:** No venue, discipline, or market_name metadata stored on each bet

### API (main.py)
- **Version:** 1.1.0
- **No filter endpoints.** No way to toggle filters at runtime.
- **Rules endpoint:** Static, no filter information

---

## WHAT IS NOW (v2.1)

### Change 1: JUMPS-ONLY FILTER (P1 — rules.py)

**What:** New `JUMPS_ONLY` flag (default: `True`) that skips all flat racing markets before any rule evaluation occurs.

**How it works:**
1. New function `detect_discipline(market_name)` parses Betfair market names using regex
2. Matches jumps keywords: `Hrd`, `Hrdl`, `Hurdle`, `Chs`, `Chase`, `Steeple`, `NHF`, `INHF`, `NH`
3. If no jumps keyword found → classified as `FLAT`
4. When `JUMPS_ONLY=True`, flat markets are immediately skipped with reason logged

**Example classifications:**
| Market Name | Discipline |
|---|---|
| `2m5f Hcap Hrd` | JUMPS |
| `2m3f Hcap Chs` | JUMPS |
| `1m7f INHF` | JUMPS |
| `7f Hcap` | FLAT |
| `1m Class Stks` | FLAT |

**Impact on rules:** Rules 1–3B are UNCHANGED. The filter runs BEFORE rule evaluation. If a market passes the filter, the same rules apply exactly as before.

**Rationale:** 2-day live testing showed jumps 79.2% strike rate vs flat 53.8%. The jumps-only filter would have converted Day 2 from £0.00 (breakeven) to +£6.97.

**Toggle:** `POST /api/filters/jumps-only` flips the flag at runtime. No restart needed.

---

### Change 2: MINIMUM ODDS FLOOR (P2 — rules.py)

**What:** New `MIN_ODDS` setting (default: `2.0`) that skips any market where the favourite's odds are below this threshold.

**How it works:**
1. After discipline check passes, favourite is identified normally
2. If `fav.best_available_to_lay < MIN_ODDS`, market is skipped with reason logged
3. When `MIN_ODDS=2.0`, this effectively disables Rule 1 (which handles odds < 2.0)

**Impact on rules:** Rule 1 is no longer reachable when `MIN_ODDS=2.0`. Rules 2, 3A, 3B are unaffected.

**Rationale:** Sub-2.0 favourites won 50% of the time in jumps and 0% in flat over 2 days. The market correctly prices these — they're dangerous to lay.

**Toggle:** `POST /api/filters/min-odds?value=2.0` sets the floor. Use `value=0` to disable.

---

### Change 3: DUPLICATE BET HARDENING (P0 — engine.py)

**What:** Added a second deduplication layer using `(selection_id, market_id)` tuples alongside the existing `(runner_name, race_time)` check.

**Before (v2.0):** Single dedup via `processed_runners` set
```python
runner_key = (instruction.runner_name, market["race_time"])
if runner_key in self.processed_runners:
    continue
```

**After (v2.1):** Double dedup via both sets
```python
runner_key = (instruction.runner_name, market["race_time"])
selection_key = (instruction.selection_id, market_id)

if runner_key in self.processed_runners:
    continue  # Logged as "SKIPPED DUPLICATE (runner_key)"
if selection_key in self.processed_selections:
    continue  # Logged as "SKIPPED DUPLICATE (selection_key)"
```

**New state:** `processed_selections` set added to:
- `__init__` (initialization)
- `_save_state` / `_load_state` (persistence)
- `_check_day_rollover` (midnight reset)
- `reset_bets` (manual reset)

**Why both layers?**
- `runner_key` catches: same horse appearing in different scans with different market IDs
- `selection_key` catches: same market processed twice in one scan cycle (the bug seen at 09:40 on 10 Feb)

---

### Change 4: TIMESTAMP + METADATA ON BET RECORDS (P0 — engine.py)

**What:** `_place_bet` now accepts the full `market` dict and enriches every bet record with:

| New Field | Value | Purpose |
|---|---|---|
| `placed_at` | ISO timestamp at moment of placement | Explicit placement time (separate from any scan timestamp) |
| `venue` | e.g. "Ayr", "Lingfield" | Post-race venue analysis |
| `discipline` | "JUMPS" or "FLAT" | Post-race discipline analysis |
| `race_time` | ISO datetime | Links bet to specific race |
| `market_name` | Full Betfair market name | Audit trail |

**Before (v2.0):**
```python
def _place_bet(self, instruction):
    bet_record = {
        **instruction.to_dict(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        ...
    }
```

**After (v2.1):**
```python
def _place_bet(self, instruction, market: dict):
    placed_at = datetime.now(timezone.utc).isoformat()
    bet_record = {
        **instruction.to_dict(),
        "venue": market.get("venue", "Unknown"),
        "discipline": detect_discipline(market.get("market_name", "")),
        "race_time": market.get("race_time", ""),
        "market_name": market.get("market_name", ""),
        "placed_at": placed_at,
        "timestamp": placed_at,  # backward compat
        ...
    }
```

---

### Change 5: API UPDATES (main.py)

**Version bumped:** 1.1.0 → 2.1.0

**New endpoints:**
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/filters` | Returns current filter settings |
| `POST` | `/api/filters/jumps-only` | Toggles jumps-only on/off |
| `POST` | `/api/filters/min-odds?value=X` | Sets minimum odds floor |

**Updated endpoint:**
- `GET /api/rules` now includes a `filters` section showing current `jumps_only` and `min_odds` values

---

## FILES CHANGED

| File | Lines Changed | Summary |
|---|---|---|
| `backend/rules.py` | +69 lines | Discipline detection, JUMPS_ONLY filter, MIN_ODDS filter, discipline field on RuleResult |
| `backend/engine.py` | +32 lines | processed_selections dedup, placed_at timestamp, venue/discipline metadata on bet records |
| `backend/main.py` | +45 lines | Version bump, filter endpoints, updated rules display |

## DEFAULTS ON FIRST RUN

| Setting | Default | Effect |
|---|---|---|
| `JUMPS_ONLY` | `True` | Only jumps races will be processed |
| `MIN_ODDS` | `2.0` | Favourites below 2.0 will be skipped |

## BACKWARD COMPATIBILITY

- All existing rules (1, 2, 3A, 3B) are unchanged
- The `timestamp` field is preserved on bet records for backward compatibility
- Frontend does not require changes (new data fields are additive)
- State file format is backward compatible (new fields have safe defaults)

## TESTING

All 9 test cases pass:
- ✓ Rule 1 (sub-2.0): £3 lay
- ✓ Rule 2 (2.0-5.0): £2 lay
- ✓ Rule 3A (>5.0, gap<2): £1+£1 lay
- ✓ Discipline detection: 8 market name patterns
- ✓ Jumps-only filter: Flat correctly SKIPPED
- ✓ Jumps-only filter: Jumps correctly ALLOWED
- ✓ Min odds filter: 1.5 correctly SKIPPED (min 2.0)
- ✓ Min odds filter: 2.5 correctly ALLOWED (min 2.0)
- ✓ Combined filters: Jumps @ 3.0 → ALLOWED, £2 lay
