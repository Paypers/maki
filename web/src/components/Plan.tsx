/**
 * The plan ahead, as the screens show it: the notice that says these are
 * estimates, and the list of what one day is likely to need.
 *
 * The notice is not decoration. A number for next Friday looks exactly like
 * a number for today, and the one for Friday will move -- so wherever a plan
 * appears, the notice sits above it and says how much such numbers have
 * moved lately, measured on this kiosk's own record.
 */

import type { Drift, DayPlan, PlannedItem } from "../lib/plan";
import type { Item } from "../lib/types";
import { usd } from "../lib/money";
import { Icon } from "./Icon";

function driftLine(drift: (Drift | null)[]): string | null {
  const [day, week] = drift;
  if (!day && !week) return null;
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  const parts: string[] = [];
  if (day) parts.push(`a day ahead for ${pct(day.exact)} of items`);
  if (week) parts.push(`a week ahead for ${pct(week.exact)}`);
  const within = week ?? day!;
  return `Lately, the estimate matched that morning's number ${parts.join(", and ")}; ` +
    `${pct(within.withinOne)} were within one roll.`;
}

/**
 * "Estimates, not orders", with the measured drift. `compact` is the one-line
 * form for cards; the full form is for the screens that list a plan.
 */
export function PlanNotice({ drift, suggestions, compact = false }: {
  drift: (Drift | null)[];
  /** False when rule suggestions are switched off: the plan is your usual amounts. */
  suggestions: boolean;
  compact?: boolean;
}) {
  const measured = suggestions ? driftLine(drift) : null;
  if (compact) {
    return (
      <p className="plan-note compact">
        <Icon name="clock" size={14} className="ico" />
        <span>
          <strong>Estimates</strong> — worked out again every morning from the newest
          counts, so they will change.{measured ? ` ${measured}` : ""}
        </span>
      </p>
    );
  }
  return (
    <div className="plan-note" role="note">
      <Icon name="clock" size={16} className="ico" />
      <div>
        <strong>Estimates, not orders.</strong>{" "}
        {suggestions
          ? <>Each morning the rule works every day out again from the newest counts,
              so these numbers change as days are counted — and when you change the
              ambition level, prices or the menu. On the day, follow Make.</>
          : <>Suggestions are switched off, so these are your usual amounts for each
              weekday. On the day, follow Make.</>}
        {measured && <p>{measured}</p>}
        {suggestions && !measured && (
          <p>Not enough counted days yet to say how much they usually move.</p>
        )}
        <p>Weather is not included: it is only ever applied by hand, on the day.</p>
      </div>
    </div>
  );
}

/** "+": includes a roll the rule is trying. "*": your usual amount. */
export function planMark(p: PlannedItem): string {
  if (p.source === "usual") return "*";
  return p.climbSteps > 0 || p.testing ? "+" : "";
}

/** What one day is likely to need, item by item, with the rule's reason. */
export function PlanLines({ plan, items }: { plan: DayPlan; items: Item[] }) {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const marked = plan.items.some((p) => planMark(p));
  return (
    <>
      <div className="cols plan-cols">
        <div>Item</div>
        <div className="r">Est. rolls</div>
      </div>
      <div className="plan-lines">
        {plan.items.map((p) => {
          const item = byId.get(p.itemId);
          if (!item) return null;
          const mark = planMark(p);
          return (
            <div className="plan-line" key={p.itemId}>
              <span className="nm">
                {item.displayName}
                <small className={p.source === "usual" ? "usual" : "why"}>
                  {p.source === "usual" ? "your usual — the rule has no opinion on it yet"
                    : p.climbSteps > 0 ? `${p.reason ?? ""} · likeliest to change`
                    : p.testing ? `${p.reason ?? ""} · kept only if it keeps selling out`
                    : p.reason}
                </small>
              </span>
              <span className={`q num ${p.source}`}>
                {p.qty}{mark && <sup>{mark}</sup>}
              </span>
            </div>
          );
        })}
      </div>
      {marked && <PlanKey />}
    </>
  );
}

/** Rolls, ingredients and trial rolls across one or more planned days. */
export function PlanStats({ plans }: { plans: DayPlan[] }) {
  const open = plans.filter((p) => !p.closed);
  const total = open.reduce((s, p) => s + p.total, 0);
  const ingredients = open.reduce((s, p) => s + p.ingredients, 0);
  const floor = open.some((p) => p.ingredientsIsFloor);
  const trial = open.reduce((s, p) => s + p.extraRolls + p.tests, 0);
  return (
    <div className="stats plan-stats">
      <div className="stat">
        <div className="label">est. rolls</div>
        <div className="value rule">~{total.toLocaleString("en-US")}</div>
      </div>
      <div className="stat">
        <div className="label">ingredients{floor ? ", at least" : ""}</div>
        <div className="value">~{usd(ingredients)}</div>
      </div>
      <div className="stat">
        <div className="label">trial rolls</div>
        <div className="value">{trial}</div>
      </div>
    </div>
  );
}

export function PlanKey() {
  return (
    <p className="plan-key">
      <span><b>5<sup>+</sup></b> includes an extra or test roll — the likeliest to change</span>
      <span><b className="usual">3<sup>*</sup></b> your usual amount</span>
    </p>
  );
}
