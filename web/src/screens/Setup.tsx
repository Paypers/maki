/**
 * Everything that is not today's work, on ONE level.
 *
 * These used to be spread across a Baseline tab, a Menu tab and a More page
 * that itself led to Settings, Cloud, Weather and a spreadsheet check -- two
 * and three taps deep, each behind a name that did not say what was in it.
 * Here every one is a single row that says what it is AND what it is set to,
 * so most visits end on this screen without opening anything.
 */

import { useState } from "react";
import type { Settings } from "../lib/types";
import { AMBITION_NAMES } from "../lib/model";
import { lookInfo, lookOf } from "../lib/theme";
import { CANONICAL_HOST } from "../lib/canonical";
import { checkForUpdate } from "../lib/appUpdate";
import * as cloud from "../lib/cloud";
import { Icon } from "../components/Icon";
import { ScreenHeader } from "../components/ScreenHeader";

export type SetupTarget =
  | "items" | "recipes" | "templates" | "settings" | "weather" | "cloud" | "reconcile";

interface Props {
  settings: Settings;
  itemCount: number;
  pending: number;
  onOpen: (target: SetupTarget) => void;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const BRIGHTNESS: Record<string, string> = { system: "match phone", dark: "dark", light: "light" };

function Row({ label, value, tone, onClick }: {
  label: string; value?: string; tone?: "rule" | "ok" | "dim"; onClick?: () => void;
}) {
  const body = (
    <>
      <span className="label">{label}</span>
      {value && <span className={`value${tone ? ` ${tone}` : ""}`}>{value}</span>}
      {onClick && <Icon name="chevron" size={16} className="chev" />}
    </>
  );
  return onClick
    ? <button className="setrow" onClick={onClick}>{body}</button>
    : <div className="setrow">{body}</div>;
}

export function Setup({ settings, itemCount, pending, onOpen }: Props) {
  const [update, setUpdate] = useState<string | null>(null);

  const promo = settings.promoWeekdays.length
    ? settings.promoWeekdays.map((d) => WEEKDAYS[d - 1]).join(", ") : "none";
  const cloudState = cloud.syncStatus(pending).label;

  async function check() {
    setUpdate("Checking…");
    const r = await checkForUpdate();
    setUpdate(r === null ? "Can't check from here"
      : r ? "Newer version found — use the bar at the bottom"
      : "You're on the newest version");
  }

  return (
    <div>
      <ScreenHeader title="Setup" eyebrow="Everything else, one level" />

      <h2 className="setgroup">Menu &amp; money</h2>
      <section className="setlist">
        <Row label="Items" value={`${itemCount} on the sheet`} onClick={() => onOpen("items")} />
        <Row label="Costs & recipes" value="cost per item" onClick={() => onOpen("recipes")} />
        <Row label="Usual amounts" value="one list per weekday" onClick={() => onOpen("templates")} />
      </section>

      <h2 className="setgroup">Planning</h2>
      <section className="setlist">
        <Row label="Ambition" value={AMBITION_NAMES[settings.ambition] ?? "Balanced"}
             tone="rule" onClick={() => onOpen("settings")} />
        <Row label="Rule suggestions on Make" value={settings.showSuggestions ? "On" : "Off"}
             tone={settings.showSuggestions ? "rule" : "dim"} onClick={() => onOpen("settings")} />
        <Row label="Promo days" value={promo} onClick={() => onOpen("settings")} />
        <Row label="Your time per roll, share kept"
             value={`$${settings.labourPerRoll.toFixed(2)} · ${Math.round(settings.saleShare * 100)}%`}
             onClick={() => onOpen("settings")} />
        <Row label="Day rollover, leftovers" onClick={() => onOpen("settings")} />
      </section>

      <h2 className="setgroup">Weather</h2>
      <section className="setlist">
        <Row label="Store location"
             value={settings.location ? `ZIP ${settings.location.zip}` : "not set"}
             tone={settings.location ? undefined : "dim"} onClick={() => onOpen("weather")} />
        <Row label="Forecast & rain effect"
             value={settings.location && settings.weatherEnabled ? "On" : "Off"}
             tone={settings.location && settings.weatherEnabled ? "ok" : "dim"}
             onClick={() => onOpen("weather")} />
      </section>

      <h2 className="setgroup">Your data</h2>
      <section className="setlist">
        <Row label="Cloud sync" value={cloudState} onClick={() => onOpen("cloud")} />
        <Row label="Backup file" value="export or restore" onClick={() => onOpen("settings")} />
        <Row label="Opening history" value="check for anything missing" onClick={() => onOpen("settings")} />
        <Row label="Sheet check" value="compare with paper" onClick={() => onOpen("reconcile")} />
      </section>

      <h2 className="setgroup">App</h2>
      <section className="setlist">
        <Row label="Theme"
             value={`${lookInfo(lookOf(settings.look)).name} · ${BRIGHTNESS[settings.theme] ?? "match phone"}`}
             onClick={() => onOpen("settings")} />
        <Row label="Address" value={CANONICAL_HOST} />
        <Row label="Check for an update" value={update ?? undefined} onClick={() => void check()} />
      </section>
    </div>
  );
}
