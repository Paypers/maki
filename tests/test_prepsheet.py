"""Tests for the morning prep sheet.

The two that matter:

  * the sheet never sees the day it is planning for. A prep sheet built with
    same-day data would look excellent and be worthless.
  * the recommendation comes from the policy the backtest actually scored, so
    what appears on the sheet is a number with provenance.
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
from analysis.prepsheet import (  # noqa: E402
    build_prep_sheet, render_text,
)

START = datetime.date(2026, 1, 5)  # Monday


def d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def obs(n, item="roll", made=10.0, wasted=2.0, refill=0.0):
    return Observation(date=d(n), item_key=item, made=made, refill=refill, wasted=wasted)


def cfg(promo=(), price=10.0, cost=2.5):
    return CostConfig(prices={"roll": price, "other": price, "thin": price},
                      unit_costs={"roll": cost, "other": cost, "thin": cost},
                      promo_weekdays=promo)


class TestNoLookAhead:
    def test_the_planned_day_is_excluded(self):
        """Data for the target date must not reach the recommender."""
        history = [obs(i, made=10, wasted=2) for i in range(28)]
        poisoned = history + [obs(28, made=999, wasted=0)]
        a = build_prep_sheet(d(28), history, cfg(), generated_at="t")
        b = build_prep_sheet(d(28), poisoned, cfg(), generated_at="t")
        assert a.lines == b.lines

    def test_future_data_cannot_change_the_sheet(self):
        history = [obs(i) for i in range(40)]
        past_only = [o for o in history if o.date < d(28)]
        a = build_prep_sheet(d(28), history, cfg(), generated_at="t")
        b = build_prep_sheet(d(28), past_only, cfg(), generated_at="t")
        assert a.lines == b.lines


class TestAlwaysShowsTheBaseline:
    def test_every_line_carries_a_baseline(self):
        sheet = build_prep_sheet(d(28), [obs(i) for i in range(28)], cfg())
        assert sheet.lines
        for line in sheet.lines:
            assert line.baseline is not None

    def test_totals_expose_both_numbers(self):
        sheet = build_prep_sheet(d(28), [obs(i) for i in range(28)], cfg())
        assert sheet.total_recommended > 0
        assert sheet.total_baseline > 0

    def test_the_rule_is_named_and_versioned(self):
        sheet = build_prep_sheet(d(28), [obs(i) for i in range(28)], cfg())
        assert sheet.model_name == "roll_chance"
        assert sheet.model_version


class TestConfidence:
    def test_thin_history_is_low_confidence(self):
        sheet = build_prep_sheet(d(10), [obs(i) for i in range(10)], cfg())
        assert all(ln.confidence == "low" for ln in sheet.lines)

    def test_an_item_that_sells_out_most_days_is_never_high_confidence(self):
        """Heavy censoring means demand was never observed. More such days must
        not buy confidence -- that is the failure mode this guards."""
        history = [obs(i, made=10, wasted=0) for i in range(70)]
        sheet = build_prep_sheet(d(70), history, cfg())
        line = sheet.lines[0]
        assert line.sellout_rate == 1.0
        assert line.confidence == "low"

    def test_long_clean_history_earns_high_confidence(self):
        history = [obs(i, made=10, wasted=3) for i in range(70)]
        sheet = build_prep_sheet(d(70), history, cfg())
        assert sheet.lines[0].confidence == "high"

    def test_confidence_is_always_a_known_level(self):
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], cfg())
        assert all(ln.confidence in ("low", "medium", "high") for ln in sheet.lines)


class TestReasons:
    def test_every_line_has_a_reason(self):
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], cfg())
        assert all(ln.reason for ln in sheet.lines)

    def test_a_promo_day_is_called_out_at_sheet_level_not_on_every_line(self):
        """The promotion applies to all thirty lines equally, so repeating it on
        each one crowds out the item-specific reason and tells you nothing. It
        belongs in the notes."""
        wednesday = d(30)
        assert datetime.date.fromisoformat(wednesday).isoweekday() == 3
        sheet = build_prep_sheet(wednesday, [obs(i) for i in range(30)],
                                 cfg(promo=(3,)))
        assert any("Buy-2-get-1" in n for n in sheet.notes)
        assert not all("promo" in ln.reason for ln in sheet.lines)

    def test_reasons_are_item_specific_not_all_identical(self):
        """A sheet where every line says the same thing is not giving reasons."""
        history = [obs(i, item="roll", made=10, wasted=0) for i in range(40)]
        history += [obs(i, item="other", made=10, wasted=6) for i in range(40)]
        sheet = build_prep_sheet(d(40), history, cfg(promo=(3,)))
        assert len({ln.reason for ln in sheet.lines}) > 1

    def test_promo_appears_as_a_suffix_on_an_otherwise_steady_item(self):
        """Half the recent days sold out and half had leftovers, so neither the
        'nudging up' nor the 'trimming' branch fires and the steady wording --
        which is where the promo suffix lives -- is what shows."""
        wednesday = d(30)
        history = [obs(i, made=10, wasted=1 if i % 2 == 0 else 0) for i in range(30)]
        sheet = build_prep_sheet(wednesday, history, cfg(promo=(3,)))
        assert any("promo day" in ln.reason for ln in sheet.lines)

    def test_heavy_selling_out_tests_one_more_and_says_so(self):
        """An item that sells out every day has demand the record cannot see.
        The rule goes exactly one above the most made, and the line says it is
        a test rather than dressing it up as a forecast."""
        history = [obs(i, made=10, wasted=0) for i in range(40)]
        sheet = build_prep_sheet(d(40), history, cfg())
        line = sheet.lines[0]
        assert line.recommended == 11
        assert "testing" in line.reason
        assert line.caveat and "more than the most you made" in line.caveat
        assert any("one extra roll at a time" in n for n in sheet.notes)

    def test_the_reason_quotes_the_chance_and_the_break_even(self):
        history = [obs(i, made=10, wasted=1 if i % 2 else 0) for i in range(40)]
        sheet = build_prep_sheet(d(40), history, cfg())
        # cost 2.5 / price 10: a roll is worth making if it sells 25% of days.
        assert "needs 25%" in sheet.lines[0].reason

    def test_persistent_waste_is_cited_with_the_chance_of_one_more(self):
        history = [obs(i, made=10, wasted=6) for i in range(40)]
        sheet = build_prep_sheet(d(40), history, cfg())
        reason = sheet.lines[0].reason
        assert reason.startswith("left over 60 across last 10")
        assert "a 5th sells" in reason and "needs 25%" in reason


class TestTemplateIntegration:
    def test_the_operator_plan_is_carried_through(self):
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], cfg(),
                                 template={"roll": 12.0})
        assert sheet.lines[0].your_plan == 12.0
        assert sheet.lines[0].delta_vs_plan is not None

    def test_the_plan_is_used_when_there_is_no_usable_history(self):
        """A rule fitted to almost nothing is worse than the operator's own
        judgement, so the plan wins rather than being overridden."""
        sheet = build_prep_sheet(d(4), [obs(i, item="thin") for i in range(4)],
                                 cfg(), template={"thin": 7.0}, items=["thin"])
        line = sheet.lines[0]
        assert line.is_fallback
        assert line.recommended == 7.0

    def test_delta_is_none_without_a_template(self):
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], cfg())
        assert sheet.lines[0].delta_vs_plan is None
        assert sheet.total_plan is None


class TestDegradation:
    def test_the_rule_is_the_model_and_the_sheet_is_not_degraded(self):
        """The per-roll rule is scored and deployed; nothing is standing in for
        a missing model any more, so the sheet does not claim otherwise."""
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], cfg())
        assert sheet.degraded is False
        assert sheet.degraded_reason is None

    def test_renders_with_no_history_at_all(self):
        sheet = build_prep_sheet(d(1), [], cfg(), items=["roll"])
        text = render_text(sheet)
        assert "PREP SHEET" in text
        assert sheet.lines[0].confidence == "low"

    def test_render_includes_every_item_and_the_banner(self):
        history = [obs(i, item="roll") for i in range(40)]
        history += [obs(i, item="other") for i in range(40)]
        sheet = build_prep_sheet(d(40), history, cfg())
        text = render_text(sheet)
        assert "roll" in text and "other" in text
        assert "TOTAL" in text
        assert sheet.model_version in text

    def test_missing_price_does_not_break_the_sheet(self):
        costs = CostConfig(prices={}, unit_costs={}, promo_weekdays=())
        sheet = build_prep_sheet(d(40), [obs(i) for i in range(40)], costs)
        assert sheet.lines[0].critical_ratio is None
        assert render_text(sheet)


class TestDeterminism:
    def test_same_inputs_give_the_same_sheet(self):
        history = [obs(i, made=10, wasted=i % 4) for i in range(50)]
        a = build_prep_sheet(d(50), history, cfg(), generated_at="t")
        b = build_prep_sheet(d(50), history, cfg(), generated_at="t")
        assert a == b


class TestActiveItems:
    def test_discontinued_items_are_left_off_the_sheet(self):
        """The roster churned six times in 117 days. An item nobody has made in
        three weeks is off the menu, and printing it is worse than useless."""
        history = [obs(i, item="roll") for i in range(60)]
        history += [obs(i, item="retired") for i in range(20)]  # stops at day 19
        sheet = build_prep_sheet(d(60), history, cfg())
        keys = {ln.item_key for ln in sheet.lines}
        assert "roll" in keys
        assert "retired" not in keys

    def test_a_recently_added_item_is_included(self):
        history = [obs(i, item="roll") for i in range(60)]
        history += [obs(i, item="new") for i in range(50, 60)]
        sheet = build_prep_sheet(d(60), history, cfg())
        assert "new" in {ln.item_key for ln in sheet.lines}

    def test_an_explicit_item_list_overrides_the_activity_filter(self):
        history = [obs(i, item="retired") for i in range(20)]
        sheet = build_prep_sheet(d(60), history, cfg(), items=["retired"])
        assert [ln.item_key for ln in sheet.lines] == ["retired"]


class TestRenderIsPrintable:
    def test_output_is_pure_ascii(self):
        """The sheet gets printed and piped through consoles that mangle
        anything else."""
        history = [obs(i, item="roll", made=10, wasted=0) for i in range(40)]
        history += [obs(i, item="other", made=10, wasted=6) for i in range(40)]
        text = render_text(build_prep_sheet(d(40), history, cfg(promo=(3,))))
        text.encode("ascii")  # raises if anything non-ASCII slipped in
