/**
 * The money pieces every screen shares: the receipt and the period card.
 *
 * Form, chosen per the job:
 *   the receipt      part-to-whole of one number (sales), so a ledger: each
 *                    line with its dollars, its share of sales, and a thin
 *                    bar of that share. One neutral ink -- the lines are
 *                    labelled, so no colour has to carry identity, and amber
 *                    stays reserved for things you owe.
 *   the period card  one headline (projected profit) with the known part and
 *                    the estimated part side by side on a single meter: solid
 *                    is counted, faint is expected. Known and estimated
 *                    never share a number without saying which is which.
 */

import type { PeriodProjection, PeriodTotals } from "../lib/money";
import { share, usd } from "../lib/money";

/** One line of the receipt. */
function Line({ label, amount, of, sign, strong, note }: {
  label: string; amount: number; of: number; sign?: "−" | "="; strong?: boolean; note?: string;
}) {
  const pct = of > 0 ? Math.max(0, Math.min(100, (100 * amount) / of)) : 0;
  return (
    <div className={`ledger-line${strong ? " strong" : ""}`}>
      <span className="lk">{sign && <span className="sign">{sign}</span>}{label}
        {note && <small> {note}</small>}</span>
      <span className="lv num">{usd(amount)}</span>
      <span className="lp num">{share(amount, of)}</span>
      <span className="lbar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

/**
 * Where the sales went. `t` must be counted money only -- never mix an
 * estimate into a receipt without saying so (pass `estimated`).
 */
export function Ledger({ t, keepShare, estimated = false }: {
  t: Pick<PeriodTotals, "sales" | "fee" | "cost" | "wasteCost" | "profit">;
  keepShare: number;
  estimated?: boolean;
}) {
  const soldCost = t.cost - t.wasteCost;
  const cut = Math.round((1 - keepShare) * 100);
  const tilde = estimated ? "~" : "";
  return (
    <div className="ledger" role="table" aria-label="Where the sales went">
      <div className="ledger-head" role="row">
        <span>{tilde}Where the money went</span><span className="num">$</span>
        <span className="num">of sales</span>
      </div>
      <Line label="Sales" amount={t.sales} of={t.sales} />
      {cut > 0 && <Line sign="−" label={`Middle man (${cut}%)`} amount={t.fee} of={t.sales} />}
      <Line sign="−" label="Ingredients" note="rolls that sold" amount={soldCost} of={t.sales} />
      <Line sign="−" label="Thrown away" note="the loss" amount={t.wasteCost} of={t.sales} />
      <Line sign="=" label="Profit" amount={t.profit} of={t.sales} strong />
    </div>
  );
}

/** "Tue Sep 22, Wed Sep 23" -- or a count, past a few. */
function blankList(dates: string[]): string {
  const f = (d: string) => new Date(`${d}T12:00:00`)
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return dates.length <= 3 ? dates.map(f).join(", ") : `${dates.length} days`;
}

/** "Mon Sep 21 – Sun Sep 27" style range, short. */
function rangeLabel(from: string, to: string): string {
  const f = (d: string) => new Date(`${d}T12:00:00`)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(from)} – ${f(to)}`;
}

/**
 * A week or a month: counted so far, plus what the rest should bring.
 */
export function PeriodCard({ title, p, keepShare, showRange = true, hero = false }: {
  title: string; p: PeriodProjection; keepShare: number;
  /** Off for a month, whose name already says its range. */
  showRange?: boolean;
  /** The one card a screen is about. Plain in Default; the dark card in Washi
   *  and Bento (styles.css, section 16). */
  hero?: boolean;
}) {
  const days = Math.round((new Date(`${p.to}T12:00:00`).getTime()
    - new Date(`${p.from}T12:00:00`).getTime()) / 86_400_000) + 1;
  const estimated = p.aheadDays + p.uncountedDays;
  const total = p.total;
  const known = Math.max(0, p.actual.profit);
  const expected = Math.max(0, p.estimate.profit);
  const scale = Math.max(1, known + expected);
  const [lo, hi] = p.profitRange;
  const finished = estimated === 0;

  return (
    <section className={`card period${hero ? " hero" : ""}`} aria-label={title}>
      <div className="head-row">
        <div className="eyebrow">{title}{showRange ? ` · ${rangeLabel(p.from, p.to)}` : ""}</div>
        <span className="hint-inline nowrap">{p.countedDays} of {days} counted</span>
      </div>

      {!p.canProject ? (
        <p className="hint">Nothing counted yet — count a few days' leftovers and this fills in.</p>
      ) : (
        <>
          <div className="period-top">
            <div className="stat hero">
              <div className="label">{finished ? "Profit" : "Projected profit"}</div>
              <div className="value">{finished ? "" : "~"}{usd(total.profit)}</div>
              {!finished && (
                <div className="range num">likely {usd(lo)} – {usd(hi)}</div>
              )}
            </div>
            <div className="period-side">
              <div><span className="k">{finished ? "Sales" : "Sales, projected"}</span>
                <span className="v num">{finished ? "" : "~"}{usd(total.sales)}</span></div>
              <div><span className="k">Thrown away</span>
                <span className="v num">{finished ? "" : "~"}{usd(total.wasteCost)}
                  <small> · {share(total.wasteCost, total.sales)} of sales</small></span></div>
              <div><span className="k">Profit margin</span>
                <span className="v num">{share(total.profit, total.sales)}
                  <small> of sales</small></span></div>
            </div>
          </div>

          {!finished && (
            <div className="meter" role="img"
                 aria-label={`${usd(p.actual.profit)} counted so far, about ${usd(p.estimate.profit)} still expected`}>
              <span className="known" style={{ width: `${(100 * known) / scale}%` }} />
              <span className="expected" style={{ width: `${(100 * expected) / scale}%` }} />
            </div>
          )}
          <div className="meter-key">
            <span><i className="known" />{usd(p.actual.profit)} counted so far</span>
            {!finished && (
              <span><i className="expected" />~{usd(p.estimate.profit)} expected
                {" "}from {estimated} more day{estimated === 1 ? "" : "s"}</span>
            )}
          </div>
          {p.blankDays.length > 0 && (
            <p className="hint period-note">
              Nothing entered for {blankList(p.blankDays)}, so {p.blankDays.length === 1 ? "it counts" : "they count"} as
              $0. If the kiosk was open, enter {p.blankDays.length === 1 ? "that day" : "those days"} and this goes up.
            </p>
          )}
          {p.uncountedDays > 0 && (
            <p className="hint period-note">
              {p.uncountedDays} past day{p.uncountedDays === 1 ? " wasn't" : "s weren't"} counted,
              so {p.uncountedDays === 1 ? "it is" : "they are"} estimated too — count
              {p.uncountedDays === 1 ? " it" : " them"} and this gets exact.
            </p>
          )}
          {p.countedDays > 0 && (
            <details className="period-receipt">
              <summary>See the receipt · {p.countedDays} counted day{p.countedDays === 1 ? "" : "s"}</summary>
              <Ledger t={p.actual} keepShare={keepShare} />
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** The one footnote every money view carries. */
export function MoneyNote({ keepShare }: { keepShare: number }) {
  const cut = Math.round((1 - keepShare) * 100);
  return (
    <p className="hint money-note">
      Estimates: what sold × menu price{cut > 0 ? `, after the middle man's ${cut}%` : ""},
      Wednesdays at ⅔ for buy-2-get-1, ingredients from your recipes (still drafts).
      "Likely" means about 2 weeks in 3 land in that range.
    </p>
  );
}
