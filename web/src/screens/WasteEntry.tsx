/**
 * Count yesterday's leftovers. The first thing the operator does each morning.
 *
 * Roughly half of all item-days genuinely have no waste -- but a zero nobody
 * looked at is not an observation, it is a guess that the model will read as
 * "this sold out, make more". So a row you have not touched shows no number
 * at all, and the day cannot be confirmed until every row has been answered.
 *
 * Answering thirty-one rows one tap at a time every morning would be the
 * wrong price for that honesty, so there is one more control: "Rest sold
 * out" marks everything still blank as zero in a single, explicit, attested
 * tap. Same guarantee, one gesture.
 */

import { useEffect, useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { daysBetween, formatShort, weekdayName } from "../lib/businessDay";
import * as store from "../lib/store";
import type { Item } from "../lib/types";
import { describeSaveError } from "../lib/saveError";
import { QuantityList, type RowSpec } from "./QuantityList";
import { Icon } from "../components/Icon";
import { ScreenHeader } from "../components/ScreenHeader";
import { usd } from "../lib/money";

interface Props {
  date: BizDate;
  today: BizDate;
  items: Item[];
  /** Every day still waiting on a count, so they can all be done from here
   *  without going back to Today between them. */
  owed: BizDate[];
  onPickDate: (date: BizDate) => void;
  onDone: (date: BizDate) => void;
}

export function WasteEntry({ date, today, items, owed, onPickDate, onDone }: Props) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [made, setMade] = useState<Record<number, number>>({});
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const entries = await store.getEntries(date);
      if (!live) return;
      const madeMap = store.currentQuantities(entries, "made");
      const refill = store.currentQuantities(entries, "refill");
      const waste = store.currentQuantities(entries, "waste");
      const m: Record<number, number> = {};
      const w: Record<number, number> = {};
      for (const item of items) {
        m[item.itemId] =
          (madeMap.get(item.itemId)?.quantity ?? 0) + (refill.get(item.itemId)?.quantity ?? 0);
        w[item.itemId] = waste.get(item.itemId)?.quantity ?? 0;
      }
      setMade(m);
      setQty(w);
      // Rows with a recorded waste figure count as already answered.
      setTouched(new Set(waste.size ? [...waste.keys()] : []));
    })();
    return () => { live = false; };
  }, [date, items]);

  // Only items that were actually produced can have leftovers. Hiding the rest
  // is most of what keeps this screen short.
  const producible = useMemo(
    () => items.filter((i) => (made[i.itemId] ?? 0) > 0),
    [items, made],
  );

  const rows: RowSpec[] = producible.map((item) => ({
    item,
    value: qty[item.itemId] ?? 0,
    ref: { text: String(made[item.itemId] ?? 0), tone: "plain" },
  }));

  const counted = producible.filter((i) => touched.has(i.itemId));
  const remaining = producible.length - counted.length;
  const overCount = producible.filter((i) => (qty[i.itemId] ?? 0) > (made[i.itemId] ?? 0));
  const totalWaste = counted.reduce((s, i) => s + (qty[i.itemId] ?? 0), 0);
  // What the leftovers counted so far cost in ingredients -- the loss, in
  // dollars, growing as you count. Items with no recipe add nothing.
  const wasteDollars = counted.reduce(
    (s, i) => s + (qty[i.itemId] ?? 0) * (i.unitCost && i.unitCost > 0 ? i.unitCost : 0), 0);
  const soldOut = counted.filter((i) => (qty[i.itemId] ?? 0) === 0).length;

  function change(itemId: number, value: number) {
    setQty((q) => ({ ...q, [itemId]: value }));
    setTouched((t) => new Set(t).add(itemId));
  }

  /** Every blank row becomes an attested zero. One explicit tap, not a default. */
  function restSoldOut() {
    setQty((q) => {
      const next = { ...q };
      for (const i of producible) if (!touched.has(i.itemId)) next[i.itemId] = 0;
      return next;
    });
    setTouched(new Set(producible.map((i) => i.itemId)));
  }

  async function confirm() {
    setSaving(true);
    setProblem(null);
    const payload: Record<number, number> = {};
    for (const item of producible) payload[item.itemId] = qty[item.itemId] ?? 0;
    try {
      await store.saveEntries(date, "waste", payload);
      await store.confirmDay(date, "waste");
    } catch (err) {
      // Stay on this screen. The counts live in component state and nowhere
      // else yet, so navigating away on a failed write is how a morning's
      // count gets lost without anyone noticing it was ever at risk.
      setProblem(describeSaveError(err));
      setSaving(false);
      return;
    }
    void store.sync();
    onDone(date);
  }

  // The day switcher: every owed day plus the one open, oldest first.
  const days = [...new Set([...owed, date])].sort();
  const madeTotal = producible.reduce((s, i) => s + (made[i.itemId] ?? 0), 0);

  return (
    <div>
      <ScreenHeader
        title="Count"
        eyebrow={`What came back · ${weekdayName(date).slice(0, 3)} ${formatShort(date)}`} />

      {days.length > 1 && (
        <div className="daypick" role="tablist" aria-label="Days to count">
          {days.map((d) => {
            const age = daysBetween(d, today);
            const isOwed = owed.includes(d);
            const tag = !isOwed ? "counted"
              : age > 2 ? `${age} days late` : age === 1 ? "yesterday" : `${age} days ago`;
            return (
              <button key={d} role="tab" aria-selected={d === date}
                      className={`${d === date ? "on" : ""}${isOwed && age > 2 ? " late" : ""}${isOwed ? "" : " done"}`}
                      onClick={() => d !== date && onPickDate(d)}>
                <strong>{weekdayName(d).slice(0, 3)} {formatShort(d)}</strong>
                <span>{tag}</span>
              </button>
            );
          })}
        </div>
      )}

      <section className="totals" aria-label="Totals">
        <div><span className="k">Made</span><span className="v num dim">{madeTotal}</span></div>
        <div>
          <span className="k">Counted</span>
          <span className="v num">{counted.length}<small>/{producible.length}</small></span>
        </div>
        <div>
          <span className="k">Left over</span>
          <span className="v num">{counted.length ? totalWaste : "—"}</span>
        </div>
        <div>
          <span className="k">Thrown away</span>
          <span className="v num">{counted.length ? usd(wasteDollars) : "—"}</span>
        </div>
      </section>

      {producible.length === 0 ? (
        <div className="banner warn">
          <Icon name="alert" size={16} className="ico" />
          <span>No production recorded for this day, so there's nothing to count.
            Enter production first, or mark the day as closed.</span>
        </div>
      ) : (
        <p className="lede">
          A blank row is <strong>not counted yet</strong> — it is never read as
          zero. <strong>Rest sold out</strong> marks every blank as 0 in one tap.
        </p>
      )}

      <div className="cols qcols">
        <div>Item · sheet order</div>
        <div className="c">Made</div>
        <div className="c">Left</div>
      </div>
      <QuantityList rows={rows} touched={touched} onChange={change} blankUntouched />

      {overCount.length > 0 && (
        <div className="banner warn">
          <Icon name="alert" size={16} className="ico" />
          <span>
            More waste than was made on {overCount.length} item
            {overCount.length > 1 ? "s" : ""} ({overCount.map((i) => i.displayName).join(", ")}).
            That's possible if a refill went unrecorded — worth a second look.
          </span>
        </div>
      )}

      {remaining === 0 && producible.length > 0 && (
        <div className="stats">
          <div className="stat"><div className="label">Left over</div>
            <div className="value">{totalWaste}</div></div>
          <div className="stat"><div className="label">Sold out</div>
            <div className="value">{soldOut}</div></div>
          <div className="stat"><div className="label">Items</div>
            <div className="value">{producible.length}</div></div>
        </div>
      )}

      <div className="footer">
        {problem && (
          <div className="banner warn save-failed" role="alert">
            <Icon name="alert" size={16} className="ico" />
            <span>{problem}</span>
          </div>
        )}
        <div className="inner">
          <div className="tally">
            <div className="value">{counted.length}<span> / {producible.length}</span></div>
            <div className="label">counted</div>
          </div>
          {/* The primary action is always the next thing to do. While rows
              are blank that is attesting the rest sold out -- one explicit
              tap, labelled with how many it covers -- and only once every
              row is answered does it become Confirm. It never confirms a
              half-counted day. */}
          {remaining > 0 ? (
            <button className="primary rest" disabled={saving || !producible.length}
                    onClick={restSoldOut}>
              <Icon name="check" size={18} />
              Rest sold out ({remaining})
            </button>
          ) : (
            <button className="primary" disabled={saving || !producible.length}
                    onClick={confirm}>
              {saving ? "Saving…" : `Confirm ${totalWaste} left over`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
