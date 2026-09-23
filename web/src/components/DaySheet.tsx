/**
 * One day, opened from the calendar or the home strip.
 *
 * A sheet rather than a screen because it is a glance, not a destination: you
 * tap a day to remember what happened, and either close it or act on it. It
 * slides from the bottom so the thumb is already where the actions are.
 *
 * Everything it can say about a day it says honestly. A day that traded but
 * was never counted shows a dash for leftovers, not a zero, and offers the
 * count as its primary action.
 */

import { useEffect, useRef } from "react";
import type { BizDate } from "../lib/businessDay";
import { daysBetween, formatShort, weekdayName } from "../lib/businessDay";
import type { DayStat } from "../lib/dayStats";
import { wasteRate } from "../lib/dayStats";
import type { Entry, Item } from "../lib/types";
import { currentQuantities } from "../lib/store";
import { Icon } from "./Icon";

interface Props {
  day: DayStat;
  today: BizDate;
  items: Item[];
  /** Every entry for this date, for the per-item breakdown. */
  entries: Entry[];
  onClose: () => void;
  onCountWaste: (date: BizDate) => void;
  onEditProduction: (date: BizDate) => void;
}

function relative(date: BizDate, today: BizDate): string {
  const n = daysBetween(date, today);
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 0) return `in ${-n} days`;
  return `${n} days ago`;
}

export function DaySheet({
  day, today, items, entries, onClose, onCountWaste, onEditProduction,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus starts on the close button so a keyboard user is
  // not dropped at the top of the page behind the sheet.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byItem = new Map(items.map((i) => [i.itemId, i]));
  const made = currentQuantities(entries, "made");
  const refill = currentQuantities(entries, "refill");
  const waste = currentQuantities(entries, "waste");

  const lines = [...made.keys()]
    .map((itemId) => {
      const item = byItem.get(itemId);
      const supply = (made.get(itemId)?.quantity ?? 0) + (refill.get(itemId)?.quantity ?? 0);
      const left = day.wasteConfirmed ? (waste.get(itemId)?.quantity ?? 0) : null;
      return { item, supply, left };
    })
    .filter((l) => l.item && l.supply > 0)
    .sort((a, b) => (b.left ?? -1) - (a.left ?? -1) || b.supply - a.supply);

  const rate = wasteRate(day);
  const isFuture = day.phase === "future";

  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true"
         aria-label={`${weekdayName(day.date)} ${formatShort(day.date)}`}>
      <button className="sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-head">
          <div>
            <div className="eyebrow">
              {weekdayName(day.date)} · {relative(day.date, today)}
            </div>
            <h2>{formatShort(day.date)}</h2>
          </div>
          <button className="ghost sheet-x" ref={closeRef} onClick={onClose}
                  aria-label="Close">
            <Icon name="plus" size={18} className="rot45" />
          </button>
        </div>

        {isFuture && (
          <p className="hint">Hasn't happened yet.</p>
        )}

        {day.phase === "outage" && (
          <div className="banner">
            <Icon name="clock" size={16} className="ico" />
            <span>Marked closed. No production, and nothing to count.</span>
          </div>
        )}

        {day.phase === "empty" && !isFuture && (
          <p className="hint">
            Nothing recorded. Either the kiosk didn't trade, or the day was
            never entered — the app can't tell which, so it doesn't guess.
          </p>
        )}

        {(day.phase === "open" || day.phase === "closed") && (
          <>
            <div className="stats">
              <div className="stat">
                <div className="label">made</div>
                <div className="value">{day.made}</div>
              </div>
              <div className={`stat${day.wasted !== null ? " accent" : ""}`}>
                <div className="label">left over</div>
                <div className="value">{day.wasted ?? "—"}</div>
              </div>
              <div className="stat">
                <div className="label">sold out</div>
                <div className="value">{day.soldOut ?? "—"}</div>
              </div>
            </div>

            {day.wasteCost !== null && day.wasteCost > 0 && (
              <p className="hint sheet-cost">
                That's <strong>${day.wasteCost.toFixed(0)}</strong> thrown away
                {rate !== null && <> · {Math.round(rate * 100)}% of what you made</>}
                {day.costIsFloor && " — at least; some items have no recipe"}.
              </p>
            )}

            {day.phase === "open" && (
              <div className="banner">
                <Icon name="alert" size={16} className="ico" />
                <span>
                  Leftovers were never counted for this day, so it can't be
                  scored and the rule can't learn from it.
                </span>
              </div>
            )}

            {lines.length > 0 && (
              <>
                <div className="cols sheet-cols">
                  <div>Item</div>
                  <div className="r">Made</div>
                  <div className="r">Left</div>
                </div>
                <div className="sheet-lines">
                  {lines.map(({ item, supply, left }) => (
                    <div className="sheet-line" key={item!.itemId}>
                      <span className="nm">{item!.displayName}</span>
                      <span className="num">{supply}</span>
                      <span className={`num${left ? " hot" : ""}`}>
                        {left === null ? "—" : left === 0 ? "0" : left}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <div className="sheet-actions">
          {day.needsWaste && (
            <button className="primary" onClick={() => onCountWaste(day.date)}>
              <Icon name="check" size={18} />
              Count leftovers
            </button>
          )}
          {!isFuture && day.phase !== "outage" && (
            <button onClick={() => onEditProduction(day.date)}>
              {day.productionConfirmed ? "Edit what was made" : "Enter what was made"}
            </button>
          )}
          {day.phase === "closed" && (
            <button onClick={() => onCountWaste(day.date)}>Correct the count</button>
          )}
        </div>
      </div>
    </div>
  );
}
