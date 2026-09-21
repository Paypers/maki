/**
 * The shared entry grid used by both the production and waste screens.
 *
 * Speed comes from pre-fill: the operator touches only the rows that differ from
 * the expected value. Typing thirty numbers is three minutes; correcting four is
 * under a minute, which is the whole requirement.
 *
 * `touched` is tracked per row and surfaced visually, so at a glance you can see
 * what you changed from the default before committing. In `blankUntouched`
 * mode an untouched row shows no number at all -- an em dash -- because on the
 * leftovers count a zero nobody looked at is not an observation.
 */

import type { ReactNode } from "react";
import type { Item } from "../lib/types";
import { Icon } from "../components/Icon";

export interface RowSpec {
  item: Item;
  /** Pre-filled value. */
  value: number;
  /** Reason, naive baseline and confidence, shown under the item name. */
  hint?: string;
  /** Shown only when the number cannot be trusted at face value. */
  caveat?: string;
  deltaLabel?: string;
  deltaDirection?: "up" | "down" | "none";
  /** A small figure beside the name -- a ten-day sparkline, or a "made" count. */
  aside?: ReactNode;
}

interface Props {
  rows: RowSpec[];
  touched: Set<number>;
  onChange: (itemId: number, value: number) => void;
  max?: number;
  /** Untouched rows render as an em dash rather than their pre-filled value. */
  blankUntouched?: boolean;
  /** Whether any row carries an `aside`; sets the grid so columns line up. */
  hasAside?: boolean;
}

export function QuantityList({
  rows, touched, onChange, max = 99, blankUntouched = false, hasAside = false,
}: Props) {
  const clamp = (n: number) => Math.max(0, Math.min(max, n));

  return (
    <div>
      {rows.map(({ item, value, hint, caveat, deltaLabel, deltaDirection, aside }) => {
        const isTouched = touched.has(item.itemId);
        const blank = blankUntouched && !isTouched;
        return (
          <div className={`row${hasAside ? "" : " no-spark"}`} key={item.itemId}>
            <label className="name" htmlFor={`q-${item.itemId}`}>
              {item.displayName}
            </label>

            {hasAside && <div className="aside">{aside ?? null}</div>}

            {deltaLabel !== undefined && (
              // Direction is carried by the sign and the number, never by colour
              // alone: the good/critical pair is indistinguishable under deuteranopia.
              <span className={`delta ${deltaDirection ?? "none"}`}>{deltaLabel}</span>
            )}

            {/* One control, not three. As separate outlined buttons this put
                three borders on every row -- ninety-three on a full sheet --
                and read as three unrelated things rather than one number. */}
            <div className={`stepper${isTouched ? " touched" : ""}${blank ? " blank" : ""}`}>
              <button
                className="step"
                disabled={value <= 0 && !blank}
                aria-label={`One fewer ${item.displayName}`}
                onClick={() => onChange(item.itemId, clamp(blank ? 0 : value - 1))}
              >
                <Icon name="minus" size={16} />
              </button>

              <input
                id={`q-${item.itemId}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={max}
                value={value}
                aria-label={blank ? `${item.displayName}: not counted yet` : undefined}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => onChange(item.itemId, clamp(Number(e.target.value || 0)))}
              />

              <button
                className="step"
                disabled={value >= max}
                aria-label={`One more ${item.displayName}`}
                onClick={() => onChange(item.itemId, clamp(blank ? 1 : value + 1))}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>

            {(hint || caveat) && (
              <small className={`why${caveat ? " caveat" : ""}`}
                     title={[caveat, hint].filter(Boolean).join(" — ")}>
                {caveat && <Icon name="alert" size={13} className="ico" />}
                <span>{hint ?? caveat}</span>
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}
