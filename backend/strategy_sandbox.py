"""
CHIMERA Lay Engine — Strategy Rule Sandbox (FSU9)
=================================================
Temporary rule testing environment for the CHIMERA AI agent (Claude).

Allows Claude to define, evaluate, and discard rule configurations without
touching production code or live betting logic. Sandbox rules and trays are
held in memory only — they persist for the lifetime of the process.

Architecture note: This module is FSU9 (Strategy Sandbox), designed as if it
were a standalone Fractional Services Unit with its own endpoint namespace
(/api/strategy/sandbox/...).  When FSU9 is extracted from the monolith, this
module moves out cleanly — only the base URL in the AI agent's tool
definitions changes.

── SANDBOX RULES ────────────────────────────────────────────────────────────
Rule types:
  STAKE_MODIFIER   — scales the bet stake by a multiplier when conditions fire
  BET_FILTER       — vetoes the bet entirely when conditions fire
  SIGNAL_AMPLIFIER — scales the signal confidence before stake calculation

Condition fields (derived from the Betfair market snapshot at evaluation time):
  exchange_overround  — sum(1 / back_odds) across active runners
  favourite_price     — best back price of the market favourite
  price_gap_1_2       — decimal-odds gap between 1st and 2nd favourite
  price_gap_2_3       — decimal-odds gap between 2nd and 3rd favourite
  runner_count        — number of active runners in the market

── SANDBOX TRAYS ─────────────────────────────────────────────────────────────
A SandboxTray is a full rule-testing workspace modelled on the CHIMERA rule
specification format (see Developer Handover docs).  Each tray tracks the
complete lifecycle of one rule under test:

  PENDING    → rule defined, not yet tested
  RUNNING    → backtest job in progress
  COMPLETED  → results available, awaiting decision
  PROMOTED   → approved for deployment as a production rule
  DISCARDED  → test concluded, rule rejected

Tray fields mirror the standard rule spec format:
  rule_family, priority, purpose, inputs_required, checkpoints,
  derived_metrics, threshold_bands, sub_rules, expected_output,
  lay_action, lay_multiplier, severity, reason_codes,
  backtest_config, backtest_results, agent_analysis
"""

from __future__ import annotations

import uuid
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("strategy_sandbox")

# ── Valid condition fields ────────────────────────────────────────────────────
VALID_FIELDS = {
    "exchange_overround",
    "favourite_price",
    "price_gap_1_2",
    "price_gap_2_3",
    "runner_count",
}

VALID_OPERATORS = {"gt", "lt", "gte", "lte", "eq"}
VALID_RULE_TYPES = {"STAKE_MODIFIER", "BET_FILTER", "SIGNAL_AMPLIFIER"}


# ── Data models ───────────────────────────────────────────────────────────────

@dataclass
class SandboxCondition:
    field: str      # one of VALID_FIELDS
    operator: str   # one of VALID_OPERATORS
    value: float


@dataclass
class SandboxEffect:
    stake_multiplier: float = 1.0    # for STAKE_MODIFIER
    skip: bool = False               # for BET_FILTER
    signal_multiplier: float = 1.0   # for SIGNAL_AMPLIFIER
    reason: str = ""


@dataclass
class SandboxRule:
    id: str
    name: str
    description: str
    rule_type: str                          # STAKE_MODIFIER | BET_FILTER | SIGNAL_AMPLIFIER
    conditions: list[SandboxCondition]
    effect: SandboxEffect
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "rule_type": self.rule_type,
            "conditions": [
                {"field": c.field, "operator": c.operator, "value": c.value}
                for c in self.conditions
            ],
            "effect": {
                "stake_multiplier": self.effect.stake_multiplier,
                "skip": self.effect.skip,
                "signal_multiplier": self.effect.signal_multiplier,
                "reason": self.effect.reason,
            },
            "created_at": self.created_at,
            "enabled": self.enabled,
        }


@dataclass
class SandboxEvalResult:
    skip: bool = False
    stake_multiplier: float = 1.0
    signal_multiplier: float = 1.0
    triggered_rules: list[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "skip": self.skip,
            "stake_multiplier": self.stake_multiplier,
            "signal_multiplier": self.signal_multiplier,
            "triggered_rules": self.triggered_rules,
            "reason": self.reason,
        }


# ── Market context helper ─────────────────────────────────────────────────────

def _build_market_context(runners) -> dict:
    """
    Derive sandbox condition fields from a list of Runner objects.
    Returns a dict of { field_name: float } using back prices.
    """
    active = sorted(
        [
            r for r in runners
            if getattr(r, "status", "ACTIVE") == "ACTIVE"
            and getattr(r, "best_available_to_back", None)
            and r.best_available_to_back > 1.0
        ],
        key=lambda r: r.best_available_to_back,
    )

    ctx: dict = {"runner_count": float(len(active))}

    if active:
        ctx["favourite_price"] = active[0].best_available_to_back

        # Overround
        implied = [1.0 / r.best_available_to_back for r in active]
        ctx["exchange_overround"] = round(sum(implied), 4)

        # Price gaps
        ctx["price_gap_1_2"] = round(
            active[1].best_available_to_back - active[0].best_available_to_back, 4
        ) if len(active) >= 2 else 0.0

        ctx["price_gap_2_3"] = round(
            active[2].best_available_to_back - active[1].best_available_to_back, 4
        ) if len(active) >= 3 else 0.0
    else:
        ctx.update({
            "favourite_price": 0.0,
            "exchange_overround": 0.0,
            "price_gap_1_2": 0.0,
            "price_gap_2_3": 0.0,
        })

    return ctx


def _evaluate_condition(cond: SandboxCondition, ctx: dict) -> bool:
    """Return True if the condition is satisfied by the market context."""
    actual = ctx.get(cond.field)
    if actual is None:
        return False
    ops = {
        "gt":  lambda a, b: a > b,
        "lt":  lambda a, b: a < b,
        "gte": lambda a, b: a >= b,
        "lte": lambda a, b: a <= b,
        "eq":  lambda a, b: abs(a - b) < 1e-9,
    }
    fn = ops.get(cond.operator)
    return bool(fn(actual, cond.value)) if fn else False


# ── Rule Sandbox ──────────────────────────────────────────────────────────────

class RuleSandbox:
    """
    In-memory store for temporary sandbox rules.
    Thread-safe for concurrent backtest jobs.
    """

    def __init__(self):
        self._rules: dict[str, SandboxRule] = {}

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def add_rule(
        self,
        name: str,
        description: str,
        rule_type: str,
        conditions: list[dict],
        effect: dict,
    ) -> tuple[Optional[SandboxRule], Optional[str]]:
        """
        Create and store a new sandbox rule.
        Returns (rule, None) on success or (None, error_message) on validation failure.
        """
        # Validate rule_type
        if rule_type not in VALID_RULE_TYPES:
            return None, f"Invalid rule_type '{rule_type}'. Must be one of: {sorted(VALID_RULE_TYPES)}"

        # Validate and parse conditions
        parsed_conditions = []
        for i, c in enumerate(conditions):
            f_name = c.get("field", "")
            op = c.get("operator", "")
            val = c.get("value")
            if f_name not in VALID_FIELDS:
                return None, f"Condition {i}: invalid field '{f_name}'. Valid: {sorted(VALID_FIELDS)}"
            if op not in VALID_OPERATORS:
                return None, f"Condition {i}: invalid operator '{op}'. Valid: {sorted(VALID_OPERATORS)}"
            if val is None or not isinstance(val, (int, float)):
                return None, f"Condition {i}: 'value' must be a number"
            parsed_conditions.append(SandboxCondition(field=f_name, operator=op, value=float(val)))

        # Parse effect
        parsed_effect = SandboxEffect(
            stake_multiplier=float(effect.get("stake_multiplier", 1.0)),
            skip=bool(effect.get("skip", False)),
            signal_multiplier=float(effect.get("signal_multiplier", 1.0)),
            reason=str(effect.get("reason", "")),
        )

        rule = SandboxRule(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            rule_type=rule_type,
            conditions=parsed_conditions,
            effect=parsed_effect,
        )
        self._rules[rule.id] = rule
        logger.info(f"Sandbox rule added: {rule.id} — {rule.name} ({rule.rule_type})")
        return rule, None

    def remove_rule(self, rule_id: str) -> bool:
        """Remove a rule by ID. Returns True if removed, False if not found."""
        if rule_id in self._rules:
            del self._rules[rule_id]
            logger.info(f"Sandbox rule removed: {rule_id}")
            return True
        return False

    def clear(self) -> int:
        """Remove all rules. Returns the count removed."""
        count = len(self._rules)
        self._rules.clear()
        logger.info(f"Sandbox cleared ({count} rules removed)")
        return count

    def list_rules(self) -> list[dict]:
        return [r.to_dict() for r in self._rules.values()]

    def get_rule(self, rule_id: str) -> Optional[SandboxRule]:
        return self._rules.get(rule_id)

    def size(self) -> int:
        return len(self._rules)

    # ── Evaluation ───────────────────────────────────────────────────────────

    def evaluate(self, runners) -> SandboxEvalResult:
        """
        Evaluate all enabled sandbox rules against the current market snapshot.

        Rules are applied in insertion order.  For STAKE_MODIFIER rules, all
        multipliers are compounded.  The first BET_FILTER that fires wins and
        skips the bet.  SIGNAL_AMPLIFIER multipliers are compounded.

        Returns a SandboxEvalResult describing the net effect to apply.
        """
        if not self._rules:
            return SandboxEvalResult()

        ctx = _build_market_context(runners)
        result = SandboxEvalResult()
        reasons = []

        for rule in self._rules.values():
            if not rule.enabled:
                continue

            # All conditions must be satisfied (AND logic)
            if not all(_evaluate_condition(c, ctx) for c in rule.conditions):
                continue

            # Rule fires
            result.triggered_rules.append(rule.name)
            eff = rule.effect

            if rule.rule_type == "BET_FILTER" and eff.skip:
                result.skip = True
                reasons.append(f"FILTER '{rule.name}': {eff.reason or 'bet vetoed'}")
                break  # First firing filter wins

            elif rule.rule_type == "STAKE_MODIFIER":
                result.stake_multiplier = round(
                    result.stake_multiplier * eff.stake_multiplier, 4
                )
                reasons.append(
                    f"STAKE '{rule.name}': ×{eff.stake_multiplier}"
                    + (f" — {eff.reason}" if eff.reason else "")
                )

            elif rule.rule_type == "SIGNAL_AMPLIFIER":
                result.signal_multiplier = round(
                    result.signal_multiplier * eff.signal_multiplier, 4
                )
                reasons.append(
                    f"SIGNAL '{rule.name}': ×{eff.signal_multiplier}"
                    + (f" — {eff.reason}" if eff.reason else "")
                )

        result.reason = "; ".join(reasons) if reasons else "No sandbox rules triggered"
        return result


# ══════════════════════════════════════════════════════════════════════════════
#  SANDBOX TRAYS  (FSU9 — Strategy Sandbox)
# ══════════════════════════════════════════════════════════════════════════════

TRAY_STATUSES = {"PENDING", "RUNNING", "COMPLETED", "PROMOTED", "DISCARDED"}


@dataclass
class SandboxTray:
    """
    Full rule-testing workspace modelled on the CHIMERA rule specification format.

    Fields mirror the standard Developer Handover doc format:
      rule_family, priority, purpose, inputs_required, checkpoints,
      derived_metrics, threshold_bands, sub_rules, expected_output,
      lay_action, lay_multiplier, severity, reason_codes

    Plus lifecycle tracking: backtest_config, backtest_job_id,
    backtest_results, agent_analysis, status.
    """
    id: str
    name: str                           # Display name, e.g. "TOP2_CONCENTRATION Test"
    rule_family: str                    # Rule family code, e.g. "TOP2_CONCENTRATION"
    test_instruction: str               # What was given to the agent to test
    # ── Spec fields (from rule spec document format) ──────────────────────────
    priority: str = ""                  # Pipeline position description
    purpose: str = ""                   # Objective / what problem this solves
    inputs_required: list = field(default_factory=list)   # Market data fields needed
    checkpoints: list = field(default_factory=list)       # e.g. ["T-30","T-15","T-5","T-1"]
    derived_metrics: list = field(default_factory=list)   # [{name, formula, description}]
    threshold_bands: list = field(default_factory=list)   # [{name, field, operator, value, severity}]
    sub_rules: list = field(default_factory=list)         # Individual rule definitions with trigger/effect
    expected_output: dict = field(default_factory=dict)   # The state object shape this rule returns
    lay_action: str = ""                # WATCH | SUPPRESS | BLOCK | ALLOW
    lay_multiplier: float = 1.0         # Stake multiplier when triggered
    severity: str = ""                  # mild | medium | strong | extreme
    reason_codes: list = field(default_factory=list)      # ["TOP2_COMBINED_STRONG", ...]
    # ── Sandbox rules linked to this tray ────────────────────────────────────
    sandbox_rule_ids: list = field(default_factory=list)
    # ── Backtest lifecycle ────────────────────────────────────────────────────
    backtest_config: dict = field(default_factory=dict)
    backtest_job_id: str = ""
    backtest_results: dict = field(default_factory=dict)
    # ── Agent output ─────────────────────────────────────────────────────────
    agent_analysis: str = ""
    notes: str = ""
    # ── Status ───────────────────────────────────────────────────────────────
    status: str = "PENDING"             # PENDING | RUNNING | COMPLETED | PROMOTED | DISCARDED
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    completed_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "rule_family": self.rule_family,
            "test_instruction": self.test_instruction,
            "priority": self.priority,
            "purpose": self.purpose,
            "inputs_required": self.inputs_required,
            "checkpoints": self.checkpoints,
            "derived_metrics": self.derived_metrics,
            "threshold_bands": self.threshold_bands,
            "sub_rules": self.sub_rules,
            "expected_output": self.expected_output,
            "lay_action": self.lay_action,
            "lay_multiplier": self.lay_multiplier,
            "severity": self.severity,
            "reason_codes": self.reason_codes,
            "sandbox_rule_ids": self.sandbox_rule_ids,
            "backtest_config": self.backtest_config,
            "backtest_job_id": self.backtest_job_id,
            "backtest_results": self.backtest_results,
            "agent_analysis": self.agent_analysis,
            "notes": self.notes,
            "status": self.status,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


# ── Tray management mixed into RuleSandbox ────────────────────────────────────
# (Trays and rules share the same singleton so Claude can link them by ID.)

def _extend_rule_sandbox_with_trays(cls):
    """Monkey-patch tray CRUD onto RuleSandbox at class definition time."""

    def _init_trays(self):
        if not hasattr(self, "_trays"):
            self._trays: dict[str, SandboxTray] = {}

    def create_tray(self, data: dict) -> tuple[Optional[SandboxTray], Optional[str]]:
        _init_trays(self)
        rule_family = data.get("rule_family", "").strip()
        name = data.get("name", rule_family or "Unnamed Tray").strip()
        if not rule_family:
            return None, "'rule_family' is required"
        tray = SandboxTray(
            id=str(uuid.uuid4()),
            name=name,
            rule_family=rule_family,
            test_instruction=data.get("test_instruction", ""),
            priority=data.get("priority", ""),
            purpose=data.get("purpose", ""),
            inputs_required=data.get("inputs_required", []),
            checkpoints=data.get("checkpoints", []),
            derived_metrics=data.get("derived_metrics", []),
            threshold_bands=data.get("threshold_bands", []),
            sub_rules=data.get("sub_rules", []),
            expected_output=data.get("expected_output", {}),
            lay_action=data.get("lay_action", ""),
            lay_multiplier=float(data.get("lay_multiplier", 1.0)),
            severity=data.get("severity", ""),
            reason_codes=data.get("reason_codes", []),
            sandbox_rule_ids=data.get("sandbox_rule_ids", []),
            backtest_config=data.get("backtest_config", {}),
            backtest_job_id=data.get("backtest_job_id", ""),
            agent_analysis=data.get("agent_analysis", ""),
            notes=data.get("notes", ""),
            status=data.get("status", "PENDING"),
        )
        self._trays[tray.id] = tray
        logger.info(f"Sandbox tray created: {tray.id} — {tray.name} ({tray.rule_family})")
        return tray, None

    def update_tray(self, tray_id: str, updates: dict) -> tuple[Optional[SandboxTray], Optional[str]]:
        _init_trays(self)
        tray = self._trays.get(tray_id)
        if not tray:
            return None, f"Tray '{tray_id}' not found"
        updatable = {
            "name", "purpose", "priority", "inputs_required", "checkpoints",
            "derived_metrics", "threshold_bands", "sub_rules", "expected_output",
            "lay_action", "lay_multiplier", "severity", "reason_codes",
            "sandbox_rule_ids", "backtest_config", "backtest_job_id",
            "backtest_results", "agent_analysis", "notes",
        }
        for key, val in updates.items():
            if key in updatable and hasattr(tray, key):
                setattr(tray, key, val)
        # Handle status separately with validation
        if "status" in updates:
            new_status = updates["status"].upper()
            if new_status not in TRAY_STATUSES:
                return None, f"Invalid status '{new_status}'. Must be one of: {sorted(TRAY_STATUSES)}"
            tray.status = new_status
            if new_status in ("COMPLETED", "PROMOTED", "DISCARDED") and not tray.completed_at:
                tray.completed_at = datetime.now(timezone.utc).isoformat()
        logger.info(f"Sandbox tray updated: {tray_id} status={tray.status}")
        return tray, None

    def get_tray(self, tray_id: str) -> Optional[SandboxTray]:
        _init_trays(self)
        return self._trays.get(tray_id)

    def list_trays(self) -> list[dict]:
        _init_trays(self)
        return [t.to_dict() for t in self._trays.values()]

    def delete_tray(self, tray_id: str) -> bool:
        _init_trays(self)
        if tray_id in self._trays:
            del self._trays[tray_id]
            logger.info(f"Sandbox tray deleted: {tray_id}")
            return True
        return False

    def tray_count(self) -> int:
        _init_trays(self)
        return len(self._trays)

    cls.create_tray = create_tray
    cls.update_tray = update_tray
    cls.get_tray = get_tray
    cls.list_trays = list_trays
    cls.delete_tray = delete_tray
    cls.tray_count = tray_count
    return cls


RuleSandbox = _extend_rule_sandbox_with_trays(RuleSandbox)
