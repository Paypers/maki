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
import type { WeatherEffect } from "../lib/weatherEffect";
import { ScreenHeader } from "../components/ScreenHeader";
import { Calendar } from "./Calendar";
import { Insights } from "./Insights";

interface Props {
  today: BizDate;
  stats: DayStatIndex;
  items: Item[];
  weather: WeatherEffect | null;
  onPick: (date: BizDate) => void;
}

export function History({ today, stats, items, weather, onPick }: Props) {
  return (
    <div>
      <ScreenHeader title="History" eyebrow="Calendar & reports" />
      <Calendar today={today} stats={stats} onPick={onPick} embedded />
      <Insights today={today} items={items} weather={weather} embedded />
    </div>
  );
}
