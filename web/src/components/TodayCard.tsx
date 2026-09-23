/**
 * Today's weather and what it points to, as one strip on the home screen.
 *
 * It used to be a card the height of half the screen. Everything it said is
 * still here -- the sky, the temperature and rain, the projection, what the
 * projection is compared against, and how much history is behind it -- in the
 * space of two lines, because the home screen's job is to show everything at
 * once and this is one thing among nine.
 *
 * The number still has to be impossible to mistake for a measurement, so:
 * observed facts on the left, the projection on the right with its comparison
 * spelled out ("vs usual Tue"), and a line underneath saying how much history
 * is behind it. Tone follows the weather block in History so the two never
 * disagree:
 *   t-solid  the estimate cleared both bars -- the app stands behind it
 *   t-weak   measured but inside the noise -- stated as a lean
 *   t-none   nothing to say -- the percentage is not shown at all
 *
 * Direction is carried by a glyph, never by colour alone.
 */

import type { TodayOutlook } from "../lib/todayOutlook";
import { Icon, skyIcon } from "./Icon";

interface Props {
  outlook: TodayOutlook;
  weekday: string;
  /** A location is set and weather is switched on. */
  configured: boolean;
  onOpenWeather: () => void;
}

const TONE: Record<TodayOutlook["confidence"], string> = {
  measured: "t-solid", weak: "t-weak", none: "t-none",
};

/** Sentence case for the sky, which `describe()` returns lowercased. */
function title(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function TodayCard({ outlook, weekday, configured, onOpenWeather }: Props) {
  const wd = weekday.slice(0, 3);

  // Nothing set up yet. An invitation, not an error.
  if (!configured) {
    return (
      <button className="wx-today wx-setup" onClick={onOpenWeather}>
        <Icon name="cloud" size={28} className="wx-glyph" />
        <span className="wx-main">
          <strong>Add your ZIP code for weather</strong>
          <span>See what rain has been doing to your sales.</span>
        </span>
        <Icon name="chevron" size={16} className="chev" />
      </button>
    );
  }

  // Set up, but the fetch has not landed. Normal on a cold start.
  if (!outlook.weather || !outlook.sky) {
    return (
      <button className="wx-today" onClick={onOpenWeather}>
        <Icon name="cloud" size={28} className="wx-glyph" />
        <span className="wx-main">
          <strong>Checking the forecast…</strong>
          {outlook.baseline !== null && (
            <span>{weekday}s average {Math.round(outlook.baseline)} sold</span>
          )}
        </span>
      </button>
    );
  }

  const w = outlook.weather;
  const tone = TONE[outlook.confidence];
  // A percentage is only drawn when something measured is behind it.
  const showPct = outlook.confidence !== "none" && Math.abs(outlook.pct) >= 0.5;
  const up = outlook.pct > 0;
  const n = outlook.weatherDays;

  const why = outlook.baseline === null
    ? `Not enough counted ${weekday}s yet for a baseline.`
    : !showPct
      ? `${weekday}s average ${Math.round(outlook.baseline)} sold; nothing in the weather points either way.`
      : outlook.confidence === "weak"
        ? `A lean, not a number — ${n} days like this, could still be chance.`
        : `Measured across ${n} days like this in your own record.`;

  return (
    <button className="wx-today" onClick={onOpenWeather}
            aria-label={`Today's weather: ${outlook.sky}. Open weather settings.`}>
      <Icon name={skyIcon(outlook.sky)} size={30} className="wx-glyph" />
      <span className="wx-main">
        <strong>{title(outlook.sky)}</strong>
        <span className="num">
          {Math.round(w.tempMin)}–{Math.round(w.tempMax)}°F
          {w.precip >= 0.01 && <> · {w.precip.toFixed(2)}″ rain</>}
          {w.snow >= 0.1 && <> · {w.snow.toFixed(1)}″ snow</>}
          {w.forecast ? "" : " · recorded"}
        </span>
      </span>
      {outlook.baseline !== null && (
        <span className="wx-proj">
          <span className="big num">~{outlook.projected} <small>sold</small></span>
          {showPct && (
            <span className={`delta-line ${tone}`}>
              <span aria-hidden="true">{up ? "▲" : "▼"}</span>{" "}
              <span className="num">{Math.abs(outlook.pct)}%</span>{" "}
              <span aria-hidden="true">vs usual {wd}</span>
              <span className="sr-only">{up ? "higher" : "lower"} than a usual {weekday}</span>
            </span>
          )}
        </span>
      )}
      <span className={`wx-why ${tone}`}>{why}</span>
    </button>
  );
}
