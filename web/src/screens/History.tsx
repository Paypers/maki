/**
 * Looking back, on one screen: the month, then the reports under it.
 *
 * These used to be two places -- a calendar reached from Today and an
 * "Insights" page under More -- and the question they answer is one question:
 * how has it been going? So they are one scroll.
 */

import type { BizDate } from "../lib/businessDay";
import type { DayStatIndex } from "../lib/dayStats";
import type { Item } from "../lib/types";
import type { Economics } from "../lib/money";
import type { WeatherEffect } from "../lib/weatherEffect";
import type { DayPlan } from "../lib/plan";
import { ScreenHeader } from "../components/ScreenHeader";
import { Calendar } from "./Calendar";
import { Insights } from "./Insights";

interface Props {
  today: BizDate;
  stats: DayStatIndex;
  items: Item[];
  weather: WeatherEffect | null;
  /** Prices, promo and the middle man's share, for every dollar on the screen. */
  econ: Economics;
  /** The rule's estimated plan for the next two weeks, by date. */
  plans: ReadonlyMap<BizDate, DayPlan>;
  onPick: (date: BizDate) => void;
}

export function History({ today, stats, items, weather, econ, plans, onPick }: Props) {
  // Only counted days have known sales and leftovers; the reports must not
  // read an uncounted day as "nothing left over".
  const counted = new Set(stats.dates.filter((d) => stats.byDate.get(d)?.wasteConfirmed));
  return (
    <div>
      <ScreenHeader title="History" eyebrow="Money & calendar" />
      <Calendar today={today} stats={stats} onPick={onPick} embedded keepShare={econ.saleShare}
                plans={plans} />
      <Insights today={today} items={items} weather={weather} embedded econ={econ}
                counted={counted} />
    </div>
  );
}
