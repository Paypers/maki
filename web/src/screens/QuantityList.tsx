/**
 * The one entry list, used by Make, Count and Usual amounts.
 *
 * Every screen that asks for quantities draws them the same way, because the
 * operator should never have to re-learn a row: the item's name with a line of
 * record under it, one reference number, then the stepper. Only what the
 * reference column MEANS changes between screens -- the rule's suggestion on
 * Make (always blue: a number the rule produced, never one you entered), what
 * was made on Count.
 *
 * Items are drawn in the paper prep sheet's own blocks, in sheet order, so the
 * screen reads down the same way the case and the paper do.
 *
 * Speed comes from pre-fill: the operator touches only the rows that differ.
 * In `blankUntouched` mode an untouched row shows a dashed em dash instead of
 * a number, because on the leftovers count a zero nobody looked at is not an
 * observation.
 */

import type { ReactNode } from "react";
import type { Item } from "../lib/types";
import { Icon } from "../components/Icon";

export interface RowSpec {
  item: Item;
  /** Pre-filled value. */
  value: number;
  /** One short line under the name: the recent record, or why the rule differs. */
  meta?: ReactNode;
  /** Shown only when the number cannot be taken at face value. */
  caveat?: string;
  /** The rule's reasoning where it disagrees with the box, in the rule's blue:
   *  the chance of the roll in dispute against the chance it needs. */
  why?: string;
  /** The reference column. `rule` is the rule's number and is drawn blue. */
  ref?: { text: string; tone: "rule" | "plain" };
}

interface Props {
  rows: RowSpec[];
  touched: Set<number>;
  onChange: (itemId: number, value: number) => void;
  max?: number;
  /** Untouched rows render as an em dash rather than their pre-filled value. */
  blankUntouched?: boolean;
}

/** Consecutive rows that share a sheet block. Unlisted items form one last block. */
export function groupRows<T extends { item: Item }>(rows: T[]): T[][] {
  const out: T[][] = [];
  let key: number | null | undefined = undefined;
  for (const r of rows) {
    const g = r.item.sheetGroup ?? null;
    if (!out.length || g !== key) { out.push([]); key = g; }
    out[out.length - 1].push(r);
  }
  return out;
}

export function QuantityList({
  rows, touched, onChange, max = 99, blankUntouched = false,
}: Props) {
  const hasRef = rows.some((r) => r.ref);
  const clamp = (n: number) => Math.max(0, Math.min(max, n));

  return (
    <div className="qlist">
      {groupRows(rows).map((group) => (
        <div className="qgroup" key={group[0].item.itemId}>
          {group.map(({ item, value, meta, caveat, why, ref }) => {
            const isTouched = touched.has(item.itemId);
            const blank = blankUntouched && !isTouched;
            return (
              <div className={`row qrow${hasRef ? "" : " no-ref"}`} key={item.itemId}>
                <div className="qname">
                  <label className="name" htmlFor={`q-${item.itemId}`}>
                    {item.displayName}
                  </label>
                  {(meta || caveat) && (
                    <small className={`meta${caveat ? " caveat" : ""}`}>
                      {caveat && <Icon name="alert" size={12} className="ico" />}
                      <span>{meta}{meta && caveat ? " · " : ""}{caveat}</span>
                    </small>
                  )}
                  {why && <small className="why-rule">{why}</small>}
                </div>

                {hasRef && (
                  <span className={`qref num ${ref?.tone ?? "plain"}`}>{ref?.text ?? ""}</span>
                )}

                <div className={`stepper${isTouched ? " touched" : ""}${blank ? " blank" : ""}`}>
                  <button
                    className="step"
                    disabled={value <= 0 && !blank}
                    aria-label={`One fewer ${item.displayName}`}
                    onClick={() => onChange(item.itemId, clamp(blank ? 0 : value - 1))}
                  >
                    <Icon name="minus" size={18} />
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
                    disabled={value >= max && !blank}
                    aria-label={`One more ${item.displayName}`}
                    onClick={() => onChange(item.itemId, clamp(blank ? 1 : value + 1))}
                  >
                    <Icon name="plus" size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
