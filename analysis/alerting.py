"""Sending an alert to a phone, without taking on a vendor.

`Notifier` is a two-method protocol. `WebhookNotifier` POSTs JSON to a URL,
which is all that ntfy.sh, Pushover, Telegram bots, Slack and Discord actually
need -- so the transport is a config value rather than a dependency, and can be
changed without touching this project. Nothing here imports a vendor SDK and
nothing calls a Google API.

Uses urllib from the standard library on purpose. This runs unattended at 3am;
an alerting path that can itself fail to import is not alerting.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Alert:
    title: str
    body: str
    severity: str          # "info" | "warning" | "critical"


class Notifier(Protocol):
    name: str

    def send(self, alert: Alert) -> bool: ...


class ConsoleNotifier:
    """Prints. The default, so an unconfigured system is loud rather than silent."""

    name = "console"

    def __init__(self, stream=None):
        import sys
        self._stream = stream or sys.stdout

    def send(self, alert: Alert) -> bool:
        self._stream.write(f"\n[{alert.severity.upper()}] {alert.title}\n"
                           f"{alert.body}\n")
        return True


class WebhookNotifier:
    """POST a JSON body to a URL.

    `template` maps this project's fields onto whatever the receiving service
    expects, so pointing at a different one is a config change:

        ntfy.sh    {"topic": "...", "title": "{title}", "message": "{body}"}
        Slack      {"text": "*{title}*\\n{body}"}
        Telegram   {"chat_id": "...", "text": "{title}\\n{body}"}
    """

    name = "webhook"

    def __init__(self, url: str, template: dict | None = None,
                 headers: dict | None = None, timeout: float = 10.0):
        self.url = url
        self.template = template or {"title": "{title}", "message": "{body}",
                                     "priority": "{severity}"}
        self.headers = {"Content-Type": "application/json", **(headers or {})}
        self.timeout = timeout

    def _render(self, alert: Alert) -> dict:
        def fill(value):
            if isinstance(value, str):
                return (value.replace("{title}", alert.title)
                             .replace("{body}", alert.body)
                             .replace("{severity}", alert.severity))
            if isinstance(value, dict):
                return {k: fill(v) for k, v in value.items()}
            return value
        return fill(self.template)

    def send(self, alert: Alert) -> bool:
        data = json.dumps(self._render(alert)).encode("utf-8")
        request = urllib.request.Request(self.url, data=data, headers=self.headers,
                                         method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, OSError, TimeoutError):
            # A failed alert must never take down the job that raised it. The
            # caller records the failure; raising here would mean a wobbly
            # notification service could stop the morning sheet being produced.
            return False


class NullNotifier:
    name = "null"

    def send(self, alert: Alert) -> bool:  # noqa: ARG002
        return True


def from_env(env: dict | None = None) -> Notifier:
    """Build a notifier from the environment.

        ALERT_WEBHOOK_URL       where to POST
        ALERT_WEBHOOK_TEMPLATE  optional JSON body template
        ALERT_WEBHOOK_HEADERS   optional JSON headers (auth tokens go here)

    With no URL set this returns ConsoleNotifier, not NullNotifier: an
    unconfigured alerting path should be visible in the logs, not silent.
    """
    env = env if env is not None else os.environ
    url = env.get("ALERT_WEBHOOK_URL")
    if not url:
        return ConsoleNotifier()
    return WebhookNotifier(
        url,
        template=json.loads(env["ALERT_WEBHOOK_TEMPLATE"])
        if env.get("ALERT_WEBHOOK_TEMPLATE") else None,
        headers=json.loads(env["ALERT_WEBHOOK_HEADERS"])
        if env.get("ALERT_WEBHOOK_HEADERS") else None,
    )


def build_alert(findings, *, checked_at: str, context: str = "") -> Alert:
    """Turn health findings into one message, worst first."""
    ordered = sorted(findings, key=lambda f: -f.level.rank)
    worst = ordered[0]
    severity = "critical" if worst.level.rank >= 3 else "warning"
    lines = [f"- {f.message}" for f in ordered]
    if context:
        lines += ["", context]
    lines += ["", f"checked {checked_at}"]
    title = ("Kiosk: pipeline failure" if severity == "critical"
             else "Kiosk: needs attention")
    return Alert(title=title, body="\n".join(lines), severity=severity)
