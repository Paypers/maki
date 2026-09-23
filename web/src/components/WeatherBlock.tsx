/**
 * What the weather has done to this kiosk, stated at the confidence the data
 * actually supports.
 *
 * The hard part of this panel is not drawing it, it is refusing to overclaim.
 * A four-month sample of one kiosk will usually produce a point estimate that
 * looks meaningful -- "rain costs you 7%" -- and usually cannot distinguish
 * it from chance. Rendering that as a bare number would be the most damaging
 * thing this app could do, because it is exactly the kind of number an
 * operator would change their prep around.
 *
 * So the estimate and its uncertainty are given the same visual weight, and
 * the verdict line is written in words rather than left to the reader to
 * infer from a t-statistic they did not ask for.
 */

import { useState } from "react";
import type { WeatherEffect, BandEffect } from "../lib/weatherEffect";
import { MIN_BAND_DAYS, MIN_T } from "../lib/weatherEffect";
import { BAND_LABEL } from "../lib/weather";
import { Icon } from "./Icon";

function verdict(b: BandEffect): { text: string; tone: "solid" | "weak" | "none" } {
  if (b.n < MIN_BAND_DAYS) {
    return { text: `only ${b.n} day${b.n === 1 ? "" : "s"} on record`, tone: "none" };
  }
  if (b.t >= MIN_T) {
    return { text: `clear in ${b.n} days`, tone: "solid" };
  }
  // The common case, and the one worth being careful about.
  return { text: `${b.n} days, not yet separable from chance`, tone: "weak" };
}

export function WeatherBlock({ effect }: { effect: WeatherEffect }) {
  const [open, setOpen] = useState(false);

  if (effect.insufficient) {
    return (
      <div className="card">
        <div className="eyebrow">Weather</div>
        <p className="hint" style={{ marginTop: 10 }}>
          Not enough matched days yet. Once there are a few weeks of counted
          days with weather against them, this will show what rain actually
          does to your sales — and say so plainly if it turns out to do
          nothing.
        </p>
      </div>
    );
  }

  const bands = effect.byBand.filter((b) => b.n > 0);
  const worst = Math.max(1, ...bands.map((b) => Math.abs(b.pct)));
  const anySolid = bands.some((b) => b.usable);

  return (
    <div className="card">
      <div className="head-row">
        <div className="eyebrow">Weather</div>
        <span className="eyebrow small">{effect.matched} days matched</span>
      </div>

      <p className="hint" style={{ marginTop: 10 }}>
        Each bar is how much you sold on those days compared with{" "}
        <strong>the same weekday when it was dry</strong> — so Wednesday's
        promo and the weekend rhythm are already taken out.
      </p>

      <div className="wx-bands">
        {bands.map((b) => {
          const v = verdict(b);
          const w = Math.min(100, (Math.abs(b.pct) / worst) * 100);
          return (
            <div className="wx-band" key={b.band}>
              <div className="wx-row">
                <span className="wx-name">{BAND_LABEL[b.band]}</span>
                <span className={`wx-pct t-${v.tone}`}>
                  {b.pct > 0 ? "+" : ""}{b.pct}%
                </span>
              </div>
              <div className="wx-track">
                <div className={`wx-fill t-${v.tone}`} style={{ width: `${w}%` }} />
              </div>
              <div className={`wx-verdict t-${v.tone}`}>{v.text}</div>
            </div>
          );
        })}
      </div>

      {/* The honest headline. Written out, because "t = 1.8" is not a
          sentence anyone should have to translate at 5am. */}
      <div className={`banner wx-verdict-banner${anySolid ? "" : " soft"}`}>
        <Icon name={anySolid ? "trend" : "clock"} size={16} className="ico" />
        <span>
          {anySolid
            ? "This is a real pattern in your own numbers — the suggestion on the production sheet uses it."
            : "The direction is consistent, but with this much history it could still be chance. Nothing is applied automatically; the production sheet will offer it and let you decide."}
        </span>
      </div>

      <button className="link" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide the details" : "How this was worked out"}
      </button>

      {open && (
        <div className="wx-detail">
          <ul className="plain">
            <li>
              Every rainy day is compared with <strong>its own weekday's dry
              average</strong>, then those ratios are pooled. Comparing all wet
              days with all dry days would mostly measure which weekdays
              happened to be rainy.
            </li>
            <li>
              Rain is measured <strong>during your trading hours only</strong>.
              A storm at 3am does not keep anyone out of a shop that opens at 8.
            </li>
            <li>
              This is a <strong>whole-day</strong> effect, applied to every item
              equally. With {effect.matched} days and thirty-odd items, a
              per-item weather figure would be noise wearing a number's
              clothes. That becomes possible after a couple of years.
            </li>
            <li>
              <strong>{Math.round(effect.censoredShare * 100)}% of item-days sold
              out.</strong> On those, sales measure your shelf rather than your
              customers, which pushes any measured effect <em>toward</em> zero —
              so the real effect is likely a little larger than shown.
            </li>
            {effect.tempRange && (
              <li>
                Your record covers <strong>{Math.round(effect.tempRange[0])}–
                {Math.round(effect.tempRange[1])}°F</strong>. Outside that the
                app says nothing rather than guessing — a rule fitted in July
                has no claim on a January morning.
              </li>
            )}
            {effect.excluded > 0 && (
              <li>
                {effect.excluded} day{effect.excluded === 1 ? "" : "s"} you
                marked unusual {effect.excluded === 1 ? "was" : "were"} held out.
              </li>
            )}
          </ul>
          <p className="hint">
            Temperature was tested and showed nothing across the range on
            record, so there is no temperature adjustment. If that changes as
            the record grows, it will appear here.
          </p>
        </div>
      )}
    </div>
  );
}
