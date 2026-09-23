"""Scheduled jobs: nightly ingest, weekly retrain, daily score, morning sheet.

    python tools/jobs.py ingest      # nightly
    python tools/jobs.py retrain     # weekly
    python tools/jobs.py score       # daily, after ingest
    python tools/jobs.py prep        # early morning, produces the sheet
    python tools/jobs.py status      # what state is everything in

Every job:

  * records a run in state/job_runs.json whether it succeeds or fails, so the
    health check has something to read and a silent failure is impossible;
  * is safe to re-run -- a scheduler that fires twice must not double-count;
  * never raises out of `main`. A crashed job that takes the morning sheet with
    it is the failure mode this whole phase exists to prevent.

The morning sheet is generated LAST and from whatever is available. If ingest
failed, it prints on older data and says so. If the model is missing, it prints
from the trailing rule and says so. It always prints.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import importlib.util
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.alerting import build_alert, from_env  # noqa: E402
from analysis.data import (  # noqa: E402
    add_days, load_observations, outage_dates_from,
)
from analysis.health import (  # noqa: E402
    AlertState, HealthInputs, Level, assess, decide_alerts,
)
from analysis.prepsheet import build_prep_sheet, render_text  # noqa: E402
from analysis.scorecard import IssuedRecommendation, score_stored  # noqa: E402
from analysis.scorecard import render_text as render_scorecard  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "rb", os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_backtest.py"))
_rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rb)

STATE_DIR = "state"
RUNS = "job_runs.json"
RECS = "recommendations.json"
ALERTS = "alert_state.json"


def now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


# ------------------------------------------------------------- state io ----

def _path(state_dir: str, name: str) -> str:
    return os.path.join(state_dir, name)


def read_json(state_dir: str, name: str, default):
    path = _path(state_dir, name)
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        # Corrupt state must not stop the pipeline; it degrades to "unknown",
        # which the health check will report as such.
        return default


def write_json(state_dir: str, name: str, value) -> None:
    os.makedirs(state_dir, exist_ok=True)
    path = _path(state_dir, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2, default=str)
    os.replace(tmp, path)  # atomic: a crash mid-write cannot corrupt the file


def record_run(state_dir: str, job: str, ok: bool, message: str = "",
               metrics: dict | None = None) -> None:
    runs = read_json(state_dir, RUNS, {})
    entry = runs.setdefault(job, {})
    stamp = now()
    entry["last_attempt"] = stamp
    entry["last_status"] = "ok" if ok else "error"
    entry["last_message"] = message
    entry["last_metrics"] = metrics or {}
    if ok:
        entry["last_ok"] = stamp
        entry["last_error"] = None
    else:
        entry["last_error"] = message
    write_json(state_dir, RUNS, runs)


# ---------------------------------------------------------------- jobs -----

def job_ingest(args) -> dict:
    """Re-read the source data and report what is now available.

    Idempotent by construction: it recomputes from the source rather than
    appending, so a scheduler that fires twice produces the same state.
    """
    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    observations = load_observations(
        os.path.join(args.extract_dir, "daily_log.csv"), outages)
    if not observations:
        raise RuntimeError("ingest produced no observations")
    latest = max(o.date for o in observations)
    return {"observations": len(observations),
            "days": len({o.date for o in observations}),
            "latest_business_date": latest,
            "items": len({o.item_key for o in observations})}


def job_retrain(args) -> dict:
    """Re-measure the deployed rule on all history, and refuse it if it slips.

    Scored with analysis/evidence.py, NOT the lower-bound cost harness: that
    harness reads a sold-out day's demand as exactly what was made, so it
    charges every roll above that as waste and would refuse any rule that makes
    more of an item that sells out -- which is the point of the rule.

    Refuses when either:
      * the rule's estimated profit falls below the old same-weekday rule's, or
      * its chances run OVER what sold by more than 10 points in the band where
        break-even sits -- over-confidence is what makes a rule over-make. It
        normally runs under (the rolls it can be checked on are the ones the
        operator chose to make, on days they expected to be busy), so a
        cautious gap is reported, not refused.
    """
    from analysis.evidence import calibration, compare, extra_roll_rate
    from analysis.policies import SameWeekdayQuantile
    from analysis.rollchance import RollChance

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    observations = load_observations(
        os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _rb.build_costs(args.extract_dir, args.markdown_share)
    dates = sorted({o.date for o in observations})
    start, end = add_days(dates[0], 28), dates[-1]

    rule, old = RollChance(), SameWeekdayQuantile(window=8, min_observations=4, floor=1)
    rate = extra_roll_rate(observations)
    result = compare(observations, [old, rule], costs, start=start, end=end,
                     continuation=rate.rate)
    r, o = result.rules[rule.name], result.rules[old.name]
    zone_pred, zone_sold, zone_n = calibration(observations, start=start, end=end).zone()
    metrics = {
        "rule": rule.name, "version": rule.version, "days": len(r.days),
        "profit_per_day_est": round(r.per_day("profit_est"), 2),
        "profit_per_day_worst": round(r.per_day("profit_low"), 2),
        "old_rule_profit_per_day_est": round(o.per_day("profit_est"), 2),
        "operator_profit_per_day": round(result.you.per_day("profit_est"), 2),
        "extra_roll_rate": round(rate.rate, 3),
        "calibration_zone": [round(zone_pred, 3), round(zone_sold, 3), zone_n],
    }
    if r.profit_est < o.profit_est:
        raise RuntimeError(
            f"refusing to promote: estimated ${r.per_day('profit_est'):.2f}/day against "
            f"${o.per_day('profit_est'):.2f}/day for the old rule on full history")
    if zone_n and zone_pred - zone_sold > 0.10:
        raise RuntimeError(
            f"refusing to promote: rolls predicted {zone_pred:.0%} to sell sold only "
            f"{zone_sold:.0%} -- the rule has become over-confident; re-run "
            "tools/compare_rules.py")
    return metrics


def job_prep(args) -> dict:
    """Produce the morning sheet and STORE what it recommended.

    Storing at issue time is what makes the scorecard honest later. A number
    that is not written down now can only be reconstructed by refitting, and a
    refit score is a score of a model grading its own homework.
    """
    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    observations = load_observations(
        os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _rb.build_costs(args.extract_dir, args.markdown_share)

    latest = max((o.date for o in observations), default=None)
    date = args.date or (add_days(latest, 1) if latest else now()[:10])

    from analysis.data import isoweekday
    import importlib.util as _il
    mps = _il.spec_from_file_location(
        "mps", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "make_prep_sheet.py"))
    mp = _il.module_from_spec(mps)
    mps.loader.exec_module(mp)
    templates = mp.load_template(args.seed)

    # Backfill exists so the scorecard has something to grade before a month of
    # real mornings has passed. It is only defensible because the rule is
    # deterministic and build_prep_sheet uses strictly-prior data, so a
    # backfilled row is byte-identical to what that morning would have issued.
    # It is NOT a refit, and the rows are marked so the two can never be
    # confused -- a fitted model must never be backfilled this way.
    dates = [add_days(date, -i) for i in range(args.backfill, -1, -1)]

    stored = read_json(args.state_dir, RECS, [])
    known = {(r["business_date"], r["item_key"], r["model_version"]) for r in stored}
    added = 0
    sheet = None
    # Health is read, not computed, so a broken health check cannot stop the
    # sheet being produced.
    health = _current_health(args, observations)
    for target in dates:
        sheet = build_prep_sheet(target, observations, costs,
                                 template=templates.get(isoweekday(target)),
                                 health=health if target == date else None)
        added += _store_lines(sheet, stored, known, backfilled=target != date)
    write_json(args.state_dir, RECS, stored)

    text = render_text(sheet)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    if not args.quiet:
        print(text)
    return {"date": sheet.date, "lines": len(sheet.lines), "stored": added,
            "total_recommended": sheet.total_recommended}


def _current_health(args, observations):
    """Best-effort health for the sheet banner. Never raises."""
    try:
        runs = read_json(args.state_dir, RUNS, {})
        ingest, retrain = runs.get("ingest", {}), runs.get("retrain", {})
        score = runs.get("score", {})
        latest = max((o.date for o in observations), default=None)
        return assess(HealthInputs(
            now=now(),
            last_ingest_ok=ingest.get("last_ok"),
            last_ingest_error=ingest.get("last_error"),
            last_retrain_ok=retrain.get("last_ok"),
            last_retrain_error=retrain.get("last_error"),
            latest_business_date=latest,
            expected_business_date=args.expected_date or latest,
            score_vs_baseline_pct=(score.get("last_metrics") or {}).get("vs_baseline_pct"),
            model_available=False))
    except Exception:  # noqa: BLE001 - the sheet matters more than the banner
        return None


def _store_lines(sheet, stored, known, *, backfilled: bool) -> int:
    added = 0
    for line in sheet.lines:
        if line.recommended is None:
            continue
        key = (sheet.date, line.item_key, sheet.model_version)
        if key in known:
            continue  # re-running the job must not duplicate a day
        known.add(key)
        stored.append(dataclasses.asdict(IssuedRecommendation(
            business_date=sheet.date, item_key=line.item_key,
            recommended_qty=line.recommended, baseline_qty=line.baseline,
            model_name=sheet.model_name, model_version=sheet.model_version,
            generated_at=sheet.generated_at, is_fallback=line.is_fallback,
            inputs={"confidence": line.confidence,
                    "sellout_rate": round(line.sellout_rate, 3),
                    "critical_ratio": line.critical_ratio,
                    "n_weekday_observations": line.n_weekday_observations,
                    # Marked so a backfilled row can never be mistaken for one
                    # that was genuinely issued on the morning it names.
                    "backfilled": backfilled},
        )))
        added += 1
    return added


def job_score(args) -> dict:
    """Rolling scorecard from STORED recommendations. Never refits."""
    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    observations = load_observations(
        os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _rb.build_costs(args.extract_dir, args.markdown_share)

    stored = [IssuedRecommendation(**r) for r in read_json(args.state_dir, RECS, [])]
    as_of = args.date or max((o.date for o in observations), default=now()[:10])
    card = score_stored(stored, observations, costs, as_of=as_of,
                        window_days=args.window_days)
    if not args.quiet:
        print(render_scorecard(card))
    return {"window": f"{card.window_start}..{card.window_end}",
            "issued": card.issued, "scored": card.scored,
            "vs_baseline_pct": (round(card.vs_baseline_pct, 2)
                                if card.scored else None),
            "coverage": round(card.coverage, 3),
            "adherence": round(card.adherence, 3)}


def job_status(args) -> dict:
    """Assess health, print it, and alert if something warrants waking someone."""
    runs = read_json(args.state_dir, RUNS, {})
    ingest = runs.get("ingest", {})
    retrain = runs.get("retrain", {})
    score = runs.get("score", {})

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    try:
        observations = load_observations(
            os.path.join(args.extract_dir, "daily_log.csv"), outages)
        latest = max((o.date for o in observations), default=None)
    except (OSError, ValueError):
        latest = None

    status = assess(HealthInputs(
        now=now(),
        last_ingest_ok=ingest.get("last_ok"),
        last_ingest_error=ingest.get("last_error"),
        last_retrain_ok=retrain.get("last_ok"),
        last_retrain_error=retrain.get("last_error"),
        latest_business_date=latest,
        expected_business_date=args.expected_date or latest,
        score_vs_baseline_pct=(score.get("last_metrics") or {}).get("vs_baseline_pct"),
        model_available=False,   # Phase 4: no fitted model earned its place yet
    ))

    if not args.quiet:
        print(f"health: {status.level.value.upper()}")
        for finding in status.findings:
            print(f"  [{finding.level.value}] {finding.message}")
        if not status.findings:
            print("  " + status.summary)

    state = AlertState.from_dict(read_json(args.state_dir, ALERTS, None))
    decision = decide_alerts(status, state, cooldown_hours=args.cooldown_hours)
    sent = 0
    if decision.send and not args.no_alert:
        notifier = from_env()
        alert = build_alert(decision.send, checked_at=status.checked_at,
                            context="Run `python tools/jobs.py status` for detail.")
        # A failed notification must not fail the job, or a flaky push service
        # takes the pipeline down with it.
        sent = 1 if notifier.send(alert) else 0
        if not sent and not args.quiet:
            print("  (could not deliver the alert; it stays pending)")
    if sent or not decision.send:
        write_json(args.state_dir, ALERTS, decision.state.to_dict())

    return {"level": status.level.value,
            "findings": [f.code for f in status.findings],
            "alerts_sent": sent,
            "alerts_suppressed": len(decision.suppressed)}


JOBS = {"ingest": job_ingest, "retrain": job_retrain, "prep": job_prep,
        "score": job_score, "status": job_status}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("job", choices=sorted(JOBS))
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--state-dir", default=STATE_DIR)
    ap.add_argument("--seed", default=os.path.join("web", "src", "data", "seed.json"))
    ap.add_argument("--date", default=None)
    ap.add_argument("--expected-date", default=None)
    ap.add_argument("--window-days", type=int, default=30)
    ap.add_argument("--backfill", type=int, default=0,
                    help="also issue sheets for the N preceding days, "
                         "marked as backfilled")
    ap.add_argument("--markdown-share", type=float, default=0.0)
    ap.add_argument("--cooldown-hours", type=float, default=12.0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-alert", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    try:
        metrics = JOBS[args.job](args) or {}
    except Exception as exc:  # noqa: BLE001 - a job must never crash the scheduler
        message = f"{type(exc).__name__}: {exc}"
        record_run(args.state_dir, args.job, ok=False, message=message)
        print(f"job '{args.job}' FAILED: {message}", file=sys.stderr)
        if os.environ.get("JOBS_TRACEBACK"):
            traceback.print_exc()
        # Non-zero so a scheduler notices, but the failure is already recorded
        # and the next job in the chain can still run on older data.
        return 1

    record_run(args.state_dir, args.job, ok=True, metrics=metrics)
    if not args.quiet:
        print(f"\njob '{args.job}' ok: "
              + ", ".join(f"{k}={v}" for k, v in metrics.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
