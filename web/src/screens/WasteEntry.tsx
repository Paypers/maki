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
import { formatShort, weekdayName } from "../lib/businessDay";
import * as store from "../lib/store";
import type { Item } from "../lib/types";
import { QuantityList, type RowSpec } from "./QuantityList";
import { Icon } from "../components/Icon";

interface Props {
  date: BizDate;
  items: Item[];
  onDone: (date: BizDate) => void;
  onCancel: () => void;
}

export function WasteEntry({ date, items, onDone, onCancel }: Props) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [made, setMade] = useState<Record<number, number>>({});
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

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
    aside: <span className="num made">{made[item.itemId] ?? 0}</span>,
  }));

  const counted = producible.filter((i) => touched.has(i.itemId));
  const remaining = producible.length - counted.length;
  const overCount = producible.filter((i) => (qty[i.itemId] ?? 0) > (made[i.itemId] ?? 0));
  const totalWaste = counted.reduce((s, i) => s + (qty[i.itemId] ?? 0), 0);
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
    const payload: Record<number, number> = {};
    for (const item of producible) payload[item.itemId] = qty[item.itemId] ?? 0;
    await store.saveEntries(date, "waste", payload);
    await store.confirmDay(date, "waste");
    void store.sync();
    onDone(date);
  }

  return (
    <div>
      <header className="bar">
        <h1>
          Leftovers
          <span className="sub">{weekdayName(date).slice(0, 3)} · {formatShort(date)} · counted this morning</span>
        </h1>
        <button className="ghost" onClick={onCancel} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
      </header>

      {producible.length === 0 ? (
        <div className="banner warn">
          <Icon name="alert" size={16} className="ico" />
          <span>No production recorded for this day, so there's nothing to count.
            Enter production first, or mark the day as closed.</span>
        </div>
      ) : (
        <div className="banner">
          <Icon name="clock" size={16} className="ico" />
          <span>Rows you haven't touched stay blank. A blank is not a zero — sold out is a tap.</span>
        </div>
      )}

      <div className="cols" style={{ gridTemplateColumns: "minmax(0,1fr) 44px 132px" }}>
        <div>Item</div>
        <div className="r">Made</div>
        <div className="c">Left</div>
      </div>
      <QuantityList rows={rows} touched={touched} onChange={change} hasAside blankUntouched />

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
