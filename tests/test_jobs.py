"""Tests for the scheduled job runner and the alerting transport.

What matters here is the failure behaviour, because that is the whole point of
Phase 6:

  * a job that fails must RECORD the failure, not vanish;
  * a job that fails must not stop the next one running on older data;
  * the morning sheet must print even when everything upstream is broken;
  * a wobbly notification service must not take the pipeline down with it.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

from analysis.alerting import (  # noqa: E402
    Alert, ConsoleNotifier, NullNotifier, WebhookNotifier, build_alert, from_env,
)
from analysis.health import Finding, Level  # noqa: E402

import jobs  # noqa: E402


class TestStateIO:
    def test_missing_state_returns_the_default(self, tmp_path):
        assert jobs.read_json(str(tmp_path), "nope.json", {"a": 1}) == {"a": 1}

    def test_corrupt_state_degrades_instead_of_crashing(self, tmp_path):
        """A truncated write at 3am must not stop the morning sheet."""
        path = tmp_path / "runs.json"
        path.write_text("{not json", encoding="utf-8")
        assert jobs.read_json(str(tmp_path), "runs.json", {}) == {}

    def test_writes_are_atomic(self, tmp_path):
        """Written via a temp file and renamed, so a crash mid-write cannot
        leave a half-written file behind."""
        jobs.write_json(str(tmp_path), "x.json", {"a": 1})
        assert json.loads((tmp_path / "x.json").read_text()) == {"a": 1}
        assert not list(tmp_path.glob("*.tmp"))

    def test_a_successful_run_is_recorded(self, tmp_path):
        jobs.record_run(str(tmp_path), "ingest", ok=True, metrics={"days": 5})
        entry = jobs.read_json(str(tmp_path), jobs.RUNS, {})["ingest"]
        assert entry["last_status"] == "ok"
        assert entry["last_ok"] and entry["last_error"] is None
        assert entry["last_metrics"] == {"days": 5}

    def test_a_failure_is_recorded_and_keeps_the_last_success(self, tmp_path):
        """Health needs both: what broke now, and when it last worked."""
        jobs.record_run(str(tmp_path), "ingest", ok=True)
        first_ok = jobs.read_json(str(tmp_path), jobs.RUNS, {})["ingest"]["last_ok"]
        jobs.record_run(str(tmp_path), "ingest", ok=False, message="disk full")
        entry = jobs.read_json(str(tmp_path), jobs.RUNS, {})["ingest"]
        assert entry["last_status"] == "error"
        assert entry["last_error"] == "disk full"
        assert entry["last_ok"] == first_ok


def run_job(job: str, tmp_path, *extra) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "jobs.py"), job,
         "--state-dir", str(tmp_path), "--quiet", "--no-alert", *extra],
        capture_output=True, text=True, cwd=ROOT)


class TestJobRunner:
    def test_a_failing_job_exits_nonzero_and_records_why(self, tmp_path):
        result = run_job("ingest", tmp_path, "--extract-dir", str(tmp_path / "gone"))
        assert result.returncode == 1
        assert "FAILED" in result.stderr
        entry = jobs.read_json(str(tmp_path), jobs.RUNS, {})["ingest"]
        assert entry["last_status"] == "error"
        assert entry["last_error"]

    def test_a_failing_job_never_raises_out_of_main(self, tmp_path):
        """A traceback escaping the runner would take the scheduler with it."""
        result = run_job("ingest", tmp_path, "--extract-dir", str(tmp_path / "gone"))
        assert "Traceback" not in result.stderr

    def test_status_runs_even_when_nothing_else_ever_has(self, tmp_path):
        result = run_job("status", tmp_path)
        assert result.returncode == 0
        entry = jobs.read_json(str(tmp_path), jobs.RUNS, {})["status"]
        assert "ingest_never" in entry["last_metrics"]["findings"]

    @pytest.mark.skipif(not os.path.exists(os.path.join(ROOT, "data", "daily_log.csv")),
                        reason="needs the extracted seed data")
    def test_the_sheet_still_prints_when_ingest_has_never_run(self, tmp_path):
        """The mandated degradation path: everything upstream broken, the sheet
        still comes out and says why."""
        result = run_job("prep", tmp_path)
        assert result.returncode == 0
        entry = jobs.read_json(str(tmp_path), jobs.RUNS, {})["prep"]
        assert entry["last_metrics"]["lines"] > 0

    @pytest.mark.skipif(not os.path.exists(os.path.join(ROOT, "data", "daily_log.csv")),
                        reason="needs the extracted seed data")
    def test_prep_is_idempotent(self, tmp_path):
        """A scheduler that fires twice must not store the day twice, or the
        scorecard would double-count it."""
        run_job("prep", tmp_path)
        first = len(jobs.read_json(str(tmp_path), jobs.RECS, []))
        result = run_job("prep", tmp_path)
        second = len(jobs.read_json(str(tmp_path), jobs.RECS, []))
        assert first == second and first > 0
        assert jobs.read_json(str(tmp_path), jobs.RUNS, {})["prep"][
            "last_metrics"]["stored"] == 0
        assert result.returncode == 0


class TestAlerting:
    def test_console_notifier_writes_the_message(self):
        buf = io.StringIO()
        assert ConsoleNotifier(buf).send(Alert("t", "b", "warning"))
        assert "WARNING" in buf.getvalue() and "t" in buf.getvalue()

    def test_webhook_template_maps_onto_the_target_service(self):
        hook = WebhookNotifier("http://example.invalid",
                               template={"text": "*{title}*\n{body}"})
        rendered = hook._render(Alert("Broken", "details", "critical"))
        assert rendered == {"text": "*Broken*\ndetails"}

    def test_a_dead_webhook_returns_false_rather_than_raising(self):
        """A flaky push service must not take down the job that raised the
        alert -- the caller records the failure and carries on."""
        hook = WebhookNotifier("http://127.0.0.1:9/never", timeout=0.2)
        assert hook.send(Alert("t", "b", "warning")) is False

    def test_from_env_defaults_to_console_not_silence(self):
        """An unconfigured alert path should be visible in the logs. Silently
        succeeding is how you find out months later that it never worked."""
        assert isinstance(from_env({}), ConsoleNotifier)

    def test_from_env_builds_a_webhook_when_configured(self):
        notifier = from_env({"ALERT_WEBHOOK_URL": "https://ntfy.sh/x",
                             "ALERT_WEBHOOK_TEMPLATE": '{"message": "{body}"}'})
        assert isinstance(notifier, WebhookNotifier)
        assert notifier.template == {"message": "{body}"}

    def test_the_null_notifier_is_opt_in_only(self):
        assert NullNotifier().send(Alert("t", "b", "info")) is True

    def test_alert_body_leads_with_the_worst_finding(self):
        alert = build_alert(
            [Finding(Level.STALE, "a", "minor thing"),
             Finding(Level.FAILED, "b", "the bad thing")],
            checked_at="2026-09-06T05:00:00")
        assert alert.severity == "critical"
        assert alert.body.index("the bad thing") < alert.body.index("minor thing")

    def test_a_degraded_only_alert_is_a_warning_not_a_crisis(self):
        alert = build_alert([Finding(Level.DEGRADED, "a", "model missing")],
                            checked_at="2026-09-06T05:00:00")
        assert alert.severity == "warning"
        assert "needs attention" in alert.title
