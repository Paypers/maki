"""Tests for the rolling scorecard and pipeline health.

The critical one is `TestNeverRefits`. A scorecard that regenerates the
recommendation it is grading would let every model improvement retroactively
improve its own track record. Scoring must read what was stored and nothing
else, and that is asserted directly rather than assumed from the code shape.
"""

from __future__ import annotations

import datetime
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.costs import CostConfig  # noqa: E402
from analysis.data import Observation  # noqa: E402
from analysis.health import (  # noqa: E402
    AlertState, HealthInputs, Level, assess, decide_alerts,
)
from analysis.scorecard import (  # noqa: E402
    IssuedRecommendation, render_text, score_stored,
)

START = datetime.date(2026, 1, 5)


def d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def obs(n, item="roll", made=10.0, wasted=2.0, refill=0.0):
    return Observation(date=d(n), item_key=item, made=made, refill=refill, wasted=wasted)


def rec(n, qty, baseline=None, item="roll", version="1.0.0", fallback=False):
    return IssuedRecommendation(
        business_date=d(n), item_key=item, recommended_qty=qty,
        baseline_qty=baseline, model_name="same_weekday_quantile",
        model_version=version, generated_at=f"{d(n)}T05:00:00", is_fallback=fallback)


def cfg(price=10.0, cost=2.5):
    return CostConfig(prices={"roll": price, "other": price},
                      unit_costs={"roll": cost, "other": cost}, promo_weekdays=())


class TestNeverRefits:
    def test_scores_the_stored_quantity_not_a_recomputed_one(self):
        """The stored number here is one no sane rule would produce. If scoring
        ever regenerates instead of reading, this test fails."""
        observations = [obs(i, made=10, wasted=2) for i in range(10)]
        stored = [rec(i, qty=40.0, baseline=8.0) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9), window_days=30)
        # Demand was 8; making 40 wastes 32 units at c_o = 2.5, ten days over.
        assert card.model.total_cost == pytest.approx(10 * 32 * 2.5)
        assert card.model.units == pytest.approx(400.0)

    def test_a_later_model_change_cannot_alter_past_scores(self):
        observations = [obs(i) for i in range(10)]
        stored = [rec(i, qty=6.0, baseline=8.0) for i in range(10)]
        before = score_stored(stored, observations, cfg(), as_of=d(9))
        # A new version is deployed and issues different numbers going forward.
        # The old rows are untouched, so the old score must be untouched.
        stored_after = stored + [rec(i, qty=99.0, baseline=8.0, version="2.0.0")
                                 for i in range(10, 12)]
        after = score_stored([r for r in stored_after if r.model_version == "1.0.0"],
                             observations, cfg(), as_of=d(9))
        assert before.model.total_cost == after.model.total_cost

    def test_scoring_ignores_the_inputs_blob(self):
        """`inputs` is provenance, not an instruction. Corrupting it must not
        move a number, or the blob has become a second source of truth."""
        observations = [obs(i) for i in range(5)]
        clean = [rec(i, qty=7.0, baseline=8.0) for i in range(5)]
        dirty = [IssuedRecommendation(**{**vars(r), "inputs": {"qty": 999}})
                 for r in clean]
        a = score_stored(clean, observations, cfg(), as_of=d(4))
        b = score_stored(dirty, observations, cfg(), as_of=d(4))
        assert a.model.total_cost == b.model.total_cost


class TestThreeWayComparison:
    def test_scores_rule_baseline_and_operator_together(self):
        observations = [obs(i, made=10, wasted=2) for i in range(10)]  # demand 8
        stored = [rec(i, qty=8.0, baseline=5.0) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9))
        assert card.model.total_cost == pytest.approx(0.0)      # exactly right
        assert card.baseline.total_cost > 0                      # short by 3
        assert card.operator.total_cost > 0                      # made 10, wasted 2
        assert card.vs_baseline < 0

    def test_baseline_is_skipped_when_it_was_never_stored(self):
        """Old rows predating baseline capture must not be silently scored as
        zero, which would make the baseline look free."""
        observations = [obs(i) for i in range(5)]
        stored = [rec(i, qty=8.0, baseline=None) for i in range(5)]
        card = score_stored(stored, observations, cfg(), as_of=d(4))
        assert card.baseline.n_scored == 0
        assert card.baseline.total_cost == 0.0

    def test_adherence_measures_how_often_you_took_the_advice(self):
        observations = [obs(i, made=8, wasted=0) for i in range(10)]
        stored = [rec(i, qty=8.0 if i < 6 else 3.0, baseline=5.0) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9))
        assert card.adherence == pytest.approx(0.6)


class TestWindowAndCoverage:
    def test_only_the_window_is_scored(self):
        observations = [obs(i) for i in range(60)]
        stored = [rec(i, 8.0, 8.0) for i in range(60)]
        card = score_stored(stored, observations, cfg(), as_of=d(59), window_days=30)
        assert card.days == 30
        assert card.window_start == d(30)

    def test_recommendations_without_outcomes_are_reported_not_dropped(self):
        """A gap in the pipeline has to be visible. Quietly excluding days is
        how a broken ingest goes unnoticed for a month."""
        observations = [obs(i) for i in range(5)]
        stored = [rec(i, 8.0, 8.0) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9))
        assert card.issued == 10
        assert card.scored == 5
        assert card.missing_actuals == 5
        assert card.coverage == pytest.approx(0.5)
        assert "no recorded outcome" in render_text(card)

    def test_an_item_with_no_price_is_counted_as_missing(self):
        observations = [obs(i, item="unpriced") for i in range(5)]
        stored = [rec(i, 8.0, 8.0, item="unpriced") for i in range(5)]
        card = score_stored(stored, observations, cfg(), as_of=d(4))
        assert card.scored == 0 and card.missing_actuals == 5

    def test_fallback_share_is_reported(self):
        observations = [obs(i) for i in range(10)]
        stored = [rec(i, 8.0, 8.0, fallback=i < 4) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9))
        assert card.fallback_share == pytest.approx(0.4)

    def test_empty_input_renders_without_crashing(self):
        card = score_stored([], [], cfg(), as_of=d(0))
        assert card.issued == 0 and card.scored == 0
        assert "ROLLING SCORECARD" in render_text(card)


class TestCensoringCarriesThrough:
    def test_a_recommendation_above_supply_on_a_sold_out_day_is_flagged(self):
        """The scorecard must inherit the backtest's honesty about unobserved
        demand, or the two would disagree about what a dollar means."""
        observations = [Observation(d(i), "roll", made=5, refill=0, wasted=0)
                        for i in range(10)]
        stored = [rec(i, qty=9.0, baseline=5.0) for i in range(10)]
        card = score_stored(stored, observations, cfg(), as_of=d(9))
        assert card.model.unidentified_share == pytest.approx(1.0)
        assert card.baseline.unidentified_share == 0.0


class TestHealth:
    NOW = "2026-09-06T05:00:00"

    def test_healthy_pipeline_reports_ok(self):
        status = assess(HealthInputs(
            now=self.NOW, last_ingest_ok="2026-09-06T02:00:00",
            last_retrain_ok="2026-09-01T02:00:00",
            latest_business_date="2026-09-05", expected_business_date="2026-09-05",
            score_vs_baseline_pct=-12.0))
        assert status.level is Level.OK
        assert not status.degraded

    def test_a_missed_ingest_is_stale_not_failed(self):
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-04T22:00:00"))
        assert status.level is Level.STALE

    def test_two_missed_ingests_is_a_failure(self):
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-03T20:00:00"))
        assert status.level is Level.FAILED

    def test_never_having_ingested_is_a_failure(self):
        assert assess(HealthInputs(now=self.NOW)).level is Level.FAILED

    def test_a_missing_model_degrades_rather_than_fails(self):
        """The morning sheet still has to print. A missing model means falling
        back, not stopping."""
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-06T02:00:00",
                                     model_available=False))
        assert status.level is Level.DEGRADED
        assert any(f.code == "no_model" for f in status.findings)

    def test_a_score_regression_past_the_threshold_is_flagged(self):
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-06T02:00:00",
                                     score_vs_baseline_pct=25.0))
        assert any(f.code == "score_regression" for f in status.findings)

    def test_beating_the_baseline_raises_nothing(self):
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-06T02:00:00",
                                     score_vs_baseline_pct=-25.0))
        assert not any(f.code == "score_regression" for f in status.findings)

    def test_a_data_gap_is_detected(self):
        status = assess(HealthInputs(
            now=self.NOW, last_ingest_ok="2026-09-06T02:00:00",
            latest_business_date="2026-09-02", expected_business_date="2026-09-05"))
        assert any(f.code == "data_gap" for f in status.findings)

    def test_the_worst_finding_sets_the_level(self):
        status = assess(HealthInputs(
            now=self.NOW, last_ingest_ok="2026-09-03T20:00:00",
            model_available=False))
        assert status.level is Level.FAILED  # failed outranks degraded

    def test_summary_is_always_a_usable_sentence(self):
        for inputs in (HealthInputs(now=self.NOW,
                                    last_ingest_ok="2026-09-06T02:00:00"),
                       HealthInputs(now=self.NOW)):
            assert assess(inputs).summary.strip()


class TestAlertCooldown:
    NOW = "2026-09-06T05:00:00"

    def _failing(self, now=NOW):
        return assess(HealthInputs(now=now, last_ingest_ok=None))

    def test_a_new_condition_alerts(self):
        decision = decide_alerts(self._failing(), AlertState())
        assert [f.code for f in decision.send] == ["ingest_never"]

    def test_the_same_condition_does_not_alert_again_within_the_cooldown(self):
        """Alerting hourly about one broken thing trains you to ignore alerts,
        and then the one that matters gets ignored too."""
        first = decide_alerts(self._failing(), AlertState())
        again = decide_alerts(self._failing("2026-09-06T09:00:00"), first.state)
        assert not again.send
        assert [f.code for f in again.suppressed] == ["ingest_never"]

    def test_it_alerts_again_once_the_cooldown_expires(self):
        first = decide_alerts(self._failing(), AlertState())
        later = decide_alerts(self._failing("2026-09-07T05:00:00"), first.state,
                              cooldown_hours=12)
        assert [f.code for f in later.send] == ["ingest_never"]

    def test_a_cleared_condition_forgets_its_cooldown(self):
        """Otherwise a problem that recurs the next day is silently swallowed."""
        first = decide_alerts(self._failing(), AlertState())
        healthy = assess(HealthInputs(now="2026-09-06T06:00:00",
                                      last_ingest_ok="2026-09-06T02:00:00"))
        cleared = decide_alerts(healthy, first.state)
        assert cleared.state.last_sent == {}
        back = decide_alerts(self._failing("2026-09-06T07:00:00"), cleared.state)
        assert [f.code for f in back.send] == ["ingest_never"]

    def test_stale_alone_does_not_wake_anyone(self):
        status = assess(HealthInputs(now=self.NOW,
                                     last_ingest_ok="2026-09-04T22:00:00"))
        assert status.level is Level.STALE
        decision = decide_alerts(status, AlertState())
        assert not decision.send
        assert decision.suppressed

    def test_state_round_trips_through_json(self):
        import json
        first = decide_alerts(self._failing(), AlertState())
        restored = AlertState.from_dict(json.loads(json.dumps(first.state.to_dict())))
        again = decide_alerts(self._failing("2026-09-06T09:00:00"), restored)
        assert not again.send
