"""Pipeline health, degradation, and when to wake someone up.

Three things live here.

`HealthStatus` is what the morning sheet asks before it prints its banner. The
sheet must render no matter what has failed overnight -- an operator standing at
a kiosk at 5am is not helped by an error page -- but it must also say plainly
which parts are stale, rather than presenting yesterday's answer as today's.

`assess` turns raw facts (when did ingest last succeed, did the retrain work,
how is the rolling score doing) into that status. It is pure, so the awkward
cases are unit-testable rather than discovered in production at dawn.

`AlertDecision` adds the thing that makes alerting survivable: a cooldown. An
alert that fires every hour for the same condition trains you to ignore it, at
which point the alerting is worse than none. A condition alerts once, then stays
quiet until it either clears or the cooldown expires.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from enum import Enum


class Level(str, Enum):
    OK = "ok"
    STALE = "stale"          # running, but on older data than it should be
    DEGRADED = "degraded"    # a component failed; a fallback is carrying it
    FAILED = "failed"        # nothing usable

    @property
    def rank(self) -> int:
        return {"ok": 0, "stale": 1, "degraded": 2, "failed": 3}[self.value]


@dataclass(frozen=True)
class Finding:
    level: Level
    code: str
    message: str


@dataclass(frozen=True)
class HealthStatus:
    level: Level
    findings: tuple[Finding, ...]
    checked_at: str

    @property
    def degraded(self) -> bool:
        return self.level is not Level.OK

    @property
    def summary(self) -> str:
        if not self.findings:
            return "All good: ingest current, rule fitted, score healthy."
        return " ".join(f.message for f in self.findings)

    def worst(self) -> Finding | None:
        return max(self.findings, key=lambda f: f.level.rank, default=None)


@dataclass(frozen=True)
class HealthInputs:
    """Raw facts. Deliberately plain so `assess` stays pure and testable."""

    now: str                                   # ISO timestamp
    last_ingest_ok: str | None = None          # ISO timestamp
    last_ingest_error: str | None = None
    last_retrain_ok: str | None = None
    last_retrain_error: str | None = None
    latest_business_date: str | None = None    # newest day with data
    expected_business_date: str | None = None  # newest day we should have
    score_vs_baseline_pct: float | None = None
    model_available: bool = True


#: Thresholds. Config, not constants scattered through the logic.
INGEST_STALE_HOURS = 30          # a daily job that missed one run
INGEST_FAILED_HOURS = 54         # missed two
RETRAIN_STALE_DAYS = 10          # a weekly job that missed one run
SCORE_ALERT_PCT = 10.0           # rule this much worse than baseline


def assess(inputs: HealthInputs,
           *,
           ingest_stale_hours: float = INGEST_STALE_HOURS,
           ingest_failed_hours: float = INGEST_FAILED_HOURS,
           retrain_stale_days: float = RETRAIN_STALE_DAYS,
           score_alert_pct: float = SCORE_ALERT_PCT) -> HealthStatus:
    findings: list[Finding] = []
    now = _parse(inputs.now)

    # --- ingest -----------------------------------------------------------
    if inputs.last_ingest_ok is None:
        findings.append(Finding(Level.FAILED, "ingest_never",
                                "Ingest has never completed."))
    else:
        age = (now - _parse(inputs.last_ingest_ok)).total_seconds() / 3600.0
        if age >= ingest_failed_hours:
            findings.append(Finding(
                Level.FAILED, "ingest_failed",
                f"No successful ingest for {age:.0f}h - the data behind today's "
                "numbers is old."))
        elif age >= ingest_stale_hours:
            findings.append(Finding(
                Level.STALE, "ingest_stale",
                f"Last ingest was {age:.0f}h ago; a run looks to have been missed."))
    if inputs.last_ingest_error:
        findings.append(Finding(Level.DEGRADED, "ingest_error",
                                f"Last ingest attempt failed: {inputs.last_ingest_error}"))

    # --- missing days -----------------------------------------------------
    if inputs.latest_business_date and inputs.expected_business_date:
        gap = _days_between(inputs.latest_business_date, inputs.expected_business_date)
        if gap >= 2:
            findings.append(Finding(
                Level.DEGRADED, "data_gap",
                f"{gap} day(s) of entries missing - newest recorded day is "
                f"{inputs.latest_business_date}."))
        elif gap == 1:
            findings.append(Finding(
                Level.STALE, "data_gap",
                f"Yesterday ({inputs.expected_business_date}) has no entries yet."))

    # --- model ------------------------------------------------------------
    if not inputs.model_available:
        findings.append(Finding(
            Level.DEGRADED, "no_model",
            "No fitted model available - falling back to the trailing rule."))
    if inputs.last_retrain_error:
        findings.append(Finding(Level.DEGRADED, "retrain_error",
                                f"Last retrain failed: {inputs.last_retrain_error}"))
    elif inputs.last_retrain_ok:
        age_days = (now - _parse(inputs.last_retrain_ok)).total_seconds() / 86400.0
        if age_days >= retrain_stale_days:
            findings.append(Finding(
                Level.STALE, "retrain_stale",
                f"Last retrain was {age_days:.0f} days ago."))

    # --- score ------------------------------------------------------------
    if inputs.score_vs_baseline_pct is not None:
        if inputs.score_vs_baseline_pct > score_alert_pct:
            findings.append(Finding(
                Level.DEGRADED, "score_regression",
                f"Over the last 30 days the rule would have cost "
                f"{inputs.score_vs_baseline_pct:.0f}% MORE than the naive baseline."))

    level = max((f.level for f in findings), key=lambda l: l.rank, default=Level.OK)
    return HealthStatus(level=level, findings=tuple(findings), checked_at=inputs.now)


# ------------------------------------------------------------- alerting ----

@dataclass
class AlertState:
    """When each condition last alerted. Persisted between runs."""

    last_sent: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"last_sent": dict(self.last_sent)}

    @classmethod
    def from_dict(cls, raw: dict | None) -> "AlertState":
        return cls(last_sent=dict((raw or {}).get("last_sent", {})))


@dataclass(frozen=True)
class AlertDecision:
    send: tuple[Finding, ...]
    suppressed: tuple[Finding, ...]
    state: AlertState


def decide_alerts(status: HealthStatus, state: AlertState,
                  *, cooldown_hours: float = 12.0,
                  min_level: Level = Level.DEGRADED) -> AlertDecision:
    """Which findings to actually send.

    Only DEGRADED and above by default: a stale-by-one-run ingest is worth
    showing on the sheet but not worth a 5am phone buzz.

    The cooldown is what keeps alerting usable. A condition that is still true
    tomorrow is still true; repeating it hourly only teaches you to swipe it
    away, and then the one that matters gets swiped too.
    """
    now = _parse(status.checked_at)
    send, suppressed = [], []
    last = dict(state.last_sent)

    for finding in status.findings:
        if finding.level.rank < min_level.rank:
            suppressed.append(finding)
            continue
        previous = last.get(finding.code)
        if previous is not None:
            age = (now - _parse(previous)).total_seconds() / 3600.0
            if age < cooldown_hours:
                suppressed.append(finding)
                continue
        send.append(finding)
        last[finding.code] = status.checked_at

    # A condition that has cleared must forget its cooldown, so that if it
    # comes back tomorrow it alerts again instead of being silently swallowed.
    active = {f.code for f in status.findings}
    last = {code: when for code, when in last.items() if code in active}

    return AlertDecision(tuple(send), tuple(suppressed), AlertState(last))


def _parse(ts: str) -> datetime.datetime:
    value = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return value.replace(tzinfo=None) if value.tzinfo else value


def _days_between(a: str, b: str) -> int:
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days
