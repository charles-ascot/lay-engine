"""
CHIMERA Lay Engine — Rule Tests
=================================
Verify all 4 rules produce correct outputs.
Run: python test_rules.py
"""

import sys
sys.path.insert(0, "backend")

from rules import Runner, apply_rules


def make_runners(odds_list):
    """Helper: create runners from a list of odds."""
    return [
        Runner(
            selection_id=1000 + i,
            runner_name=f"Horse_{i+1}",
            best_available_to_lay=odds,
            status="ACTIVE",
        )
        for i, odds in enumerate(odds_list)
    ]


def test_rule_1_odds_under_2():
    """Fav odds < 2.0 → £3 lay on favourite."""
    runners = make_runners([1.5, 3.0, 8.0, 12.0])
    result = apply_rules("M1", "Test Race", "Ascot", "2026-02-08T14:00:00Z", runners)

    assert not result.skipped, f"Should not skip: {result.skip_reason}"
    assert len(result.instructions) == 1, f"Expected 1 bet, got {len(result.instructions)}"
    assert result.instructions[0].size == 3.0, f"Expected £3 stake, got {result.instructions[0].size}"
    assert result.instructions[0].price == 1.5, f"Expected price 1.5, got {result.instructions[0].price}"
    assert result.instructions[0].runner_name == "Horse_1"
    # Liability = size * (price - 1) = 3 * 0.5 = 1.50
    assert result.instructions[0].liability == 1.5, f"Expected £1.50 liability, got {result.instructions[0].liability}"
    print("✓ RULE 1: Fav odds 1.5 → £3 lay, £1.50 liability")


def test_rule_1_edge_just_under_2():
    """Fav odds 1.99 → still Rule 1."""
    runners = make_runners([1.99, 4.0])
    result = apply_rules("M2", "Test", "York", "2026-02-08T14:30:00Z", runners)

    assert len(result.instructions) == 1
    assert result.instructions[0].size == 3.0
    print("✓ RULE 1 (edge): Fav odds 1.99 → £3 lay")


def test_rule_2_odds_2_to_5():
    """Fav odds 2.0–5.0 → £2 lay on favourite."""
    runners = make_runners([3.0, 5.5, 8.0])
    result = apply_rules("M3", "Test", "Cheltenham", "2026-02-08T15:00:00Z", runners)

    assert not result.skipped
    assert len(result.instructions) == 1
    assert result.instructions[0].size == 2.0, f"Expected £2, got {result.instructions[0].size}"
    assert result.instructions[0].price == 3.0
    # Liability = 2 * (3-1) = 4.00
    assert result.instructions[0].liability == 4.0, f"Expected £4.00, got {result.instructions[0].liability}"
    print("✓ RULE 2: Fav odds 3.0 → £2 lay, £4.00 liability")


def test_rule_2_edge_exactly_2():
    """Fav odds exactly 2.0 → Rule 2."""
    runners = make_runners([2.0, 6.0])
    result = apply_rules("M4", "Test", "Kempton", "2026-02-08T15:30:00Z", runners)

    assert len(result.instructions) == 1
    assert result.instructions[0].size == 2.0
    print("✓ RULE 2 (edge): Fav odds 2.0 → £2 lay")


def test_rule_2_edge_exactly_5():
    """Fav odds exactly 5.0 → Rule 2."""
    runners = make_runners([5.0, 8.0])
    result = apply_rules("M5", "Test", "Aintree", "2026-02-08T16:00:00Z", runners)

    assert len(result.instructions) == 1
    assert result.instructions[0].size == 2.0
    print("✓ RULE 2 (edge): Fav odds 5.0 → £2 lay")


def test_rule_3a_gap_under_2():
    """Fav odds > 5.0 and gap to 2nd fav < 2 → £1 fav + £1 2nd fav."""
    # Fav at 7.0, 2nd fav at 8.0 → gap = 1.0 < 2
    runners = make_runners([7.0, 8.0, 15.0, 20.0])
    result = apply_rules("M6", "Test", "Wolverhampton", "2026-02-08T16:30:00Z", runners)

    assert not result.skipped
    assert len(result.instructions) == 2, f"Expected 2 bets, got {len(result.instructions)}"
    assert result.instructions[0].size == 1.0, "Fav bet should be £1"
    assert result.instructions[0].runner_name == "Horse_1"
    assert result.instructions[1].size == 1.0, "2nd fav bet should be £1"
    assert result.instructions[1].runner_name == "Horse_2"
    # Fav liability = 1 * (7-1) = 6.00
    assert result.instructions[0].liability == 6.0
    # 2nd fav liability = 1 * (8-1) = 7.00
    assert result.instructions[1].liability == 7.0
    print("✓ RULE 3A: Fav 7.0, 2nd 8.0 (gap 1.0) → £1+£1, liabilities £6+£7")


def test_rule_3a_gap_exactly_1_99():
    """Gap of 1.99 → still Rule 3A (< 2)."""
    runners = make_runners([6.0, 7.99, 15.0])
    result = apply_rules("M7", "Test", "Lingfield", "2026-02-08T17:00:00Z", runners)

    assert len(result.instructions) == 2
    print("✓ RULE 3A (edge): Gap 1.99 → two bets")


def test_rule_3b_gap_2_or_more():
    """Fav odds > 5.0 and gap to 2nd fav ≥ 2 → £1 fav only."""
    # Fav at 6.0, 2nd fav at 10.0 → gap = 4.0 ≥ 2
    runners = make_runners([6.0, 10.0, 15.0])
    result = apply_rules("M8", "Test", "Newmarket", "2026-02-08T17:30:00Z", runners)

    assert not result.skipped
    assert len(result.instructions) == 1, f"Expected 1 bet, got {len(result.instructions)}"
    assert result.instructions[0].size == 1.0
    assert result.instructions[0].runner_name == "Horse_1"
    print("✓ RULE 3B: Fav 6.0, 2nd 10.0 (gap 4.0) → £1 fav only")


def test_rule_3b_gap_exactly_2():
    """Gap of exactly 2.0 → Rule 3B (≥ 2)."""
    runners = make_runners([7.0, 9.0, 20.0])
    result = apply_rules("M9", "Test", "Sandown", "2026-02-08T18:00:00Z", runners)

    assert len(result.instructions) == 1
    assert result.instructions[0].size == 1.0
    print("✓ RULE 3B (edge): Gap exactly 2.0 → one bet")


def test_no_runners():
    """No active runners → skip."""
    result = apply_rules("M10", "Test", "Empty", "2026-02-08T18:30:00Z", [])

    assert result.skipped
    print("✓ SKIP: No runners → skipped")


def test_no_lay_prices():
    """Runners exist but no lay prices → skip."""
    runners = [
        Runner(selection_id=1, runner_name="Ghost", status="ACTIVE", best_available_to_lay=None),
    ]
    result = apply_rules("M11", "Test", "NoPrice", "2026-02-08T19:00:00Z", runners)

    assert result.skipped
    print("✓ SKIP: No prices → skipped")


def test_favourite_identification():
    """Favourite is correctly identified as lowest-odds runner."""
    # Horse_3 has the lowest odds (1.8) despite being third in the list
    runners = make_runners([5.0, 3.0, 1.8, 10.0])
    result = apply_rules("M12", "Test", "Ascot", "2026-02-08T19:30:00Z", runners)

    assert result.favourite.runner_name == "Horse_3"
    assert result.favourite.best_available_to_lay == 1.8
    assert result.instructions[0].size == 3.0  # Rule 1: < 2.0
    print("✓ FAVOURITE: Horse_3 (1.8) correctly identified from unsorted list")


if __name__ == "__main__":
    print("=" * 60)
    print("CHIMERA Lay Engine — Rule Verification")
    print("=" * 60)
    print()

    tests = [
        test_rule_1_odds_under_2,
        test_rule_1_edge_just_under_2,
        test_rule_2_odds_2_to_5,
        test_rule_2_edge_exactly_2,
        test_rule_2_edge_exactly_5,
        test_rule_3a_gap_under_2,
        test_rule_3a_gap_exactly_1_99,
        test_rule_3b_gap_2_or_more,
        test_rule_3b_gap_exactly_2,
        test_no_runners,
        test_no_lay_prices,
        test_favourite_identification,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"✗ FAILED: {test.__name__} — {e}")
            failed += 1
        except Exception as e:
            print(f"✗ ERROR: {test.__name__} — {e}")
            failed += 1

    print()
    print("=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed, {len(tests)} total")
    print("=" * 60)

    if failed > 0:
        sys.exit(1)
    print("\n✓ ALL RULES VERIFIED — Engine logic is correct.")
