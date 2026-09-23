/**
 * The opening-history import.
 *
 * This runs once, writes 6,800 rows, and is then invisible. If it files a day
 * against the wrong date or turns an uncounted cell into an observed zero,
 * nothing downstream will complain -- it will just quietly train on a year of
 * wrong numbers. Hence tests on the pure expansion rather than on the write.
 */

import { describe, expect, it } from "vitest";
import { expandHistory, mergeHistoryDays, type HistoryFile } from "./store";

const file = (over: Partial<HistoryFile> = {}): HistoryFile => ({
  generatedAt: "2026-09-09T00:00:00.000Z",
  fromDate: "2026-05-08", toDate: "2026-05-09",
  archivedItems: [],
  dates: ["2026-05-08", "2026-05-09"],
  outages: [],
  rows: [],
  ...over,
});

describe("expandHistory", () => {
  it("maps a row's date index to the right calendar day", () => {
    const { entries } = expandHistory(file({ rows: [[1, 7, 5, null, 2]] }));
    expect(entries.every((e) => e.businessDate === "2026-05-09")).toBe(true);
  });

  it("splits one row into made, refill and waste entries", () => {
    const { entries } = expandHistory(file({ rows: [[0, 7, 5, 2, 1]] }));
    expect(entries.map((e) => [e.entryType, e.quantity])).toEqual([
      ["made", 5], ["refill", 2], ["waste", 1],
    ]);
  });

  it("keeps a counted zero and drops an uncounted blank", () => {
    // The distinction this whole project rests on. A zero waste figure is an
    // observation -- the item sold out. A null is the absence of one.
    const { entries } = expandHistory(file({ rows: [[0, 7, 5, null, 0]] }));
    expect(entries.map((e) => e.entryType)).toEqual(["made", "waste"]);
    expect(entries.find((e) => e.entryType === "waste")!.quantity).toBe(0);

    const blank = expandHistory(file({ rows: [[0, 7, 5, null, null]] }));
    expect(blank.entries.map((e) => e.entryType)).toEqual(["made"]);
  });

  it("stamps waste the morning after the day it belongs to", () => {
    // Waste is counted the next morning. Stamping it on the same clock as
    // production would make a correction look older than the thing it corrects
    // wherever the log is read in recordedAt order.
    const { entries } = expandHistory(file({ rows: [[0, 7, 5, null, 1]] }));
    const made = entries.find((e) => e.entryType === "made")!;
    const waste = entries.find((e) => e.entryType === "waste")!;
    expect(waste.businessDate).toBe("2026-05-08");
    expect(waste.recordedAt > made.recordedAt).toBe(true);
    expect(waste.recordedAt.startsWith("2026-05-09")).toBe(true);
  });

  it("is idempotent -- a second import adds nothing", () => {
    const f = file({ rows: [[0, 7, 5, null, 1], [1, 7, 4, null, 0]] });
    const first = expandHistory(f);
    expect(first.entries.length).toBe(4);
    const again = expandHistory(f, new Set(first.entries.map((e) => e.mutationId)));
    expect(again.entries).toEqual([]);
  });

  it("does not mutate the set it is given", () => {
    const known = new Set<string>();
    expandHistory(file({ rows: [[0, 7, 5, null, 1]] }), known);
    expect(known.size).toBe(0);
  });

  it("dedupes a row repeated inside one file", () => {
    const { entries } = expandHistory(
      file({ rows: [[0, 7, 5, null, 1], [0, 7, 5, null, 1]] }));
    expect(entries.length).toBe(2);
  });

  it("confirms both halves of every day it covers", () => {
    // The workbook is a closed record. Leaving these unconfirmed would put 117
    // finished days into the outstanding-task list.
    const { days } = expandHistory(file({ rows: [[0, 7, 5, null, 1], [1, 7, 4, null, 0]] }));
    expect(days.map((d) => d.businessDate)).toEqual(["2026-05-08", "2026-05-09"]);
    expect(days.every((d) => d.productionConfirmedAt && d.wasteConfirmedAt)).toBe(true);
  });

  it("leaves an uncounted day's waste open, so it lands in the task list", () => {
    // A day whose waste column was blank all the way down was never counted.
    // Stamping it confirmed would record "nothing came back" as a measurement
    // on a day nobody measured -- and every item would read as censored at
    // the ceiling, which walks every future recommendation upward.
    const { days } = expandHistory(file({
      rows: [[0, 7, 5, null, 1], [1, 7, 4, null, null]],
      uncounted: ["2026-05-09"],
    }));
    const [counted, open] = days;
    expect(counted.businessDate).toBe("2026-05-08");
    expect(counted.wasteConfirmedAt).not.toBeNull();
    expect(open.businessDate).toBe("2026-05-09");
    expect(open.productionConfirmedAt).not.toBeNull();   // it did trade
    expect(open.wasteConfirmedAt).toBeNull();            // and was never counted
  });

  it("writes no waste entry at all for an uncounted day", () => {
    // Not even a zero. Absence is not zero is the whole invariant.
    const { entries } = expandHistory(file({
      rows: [[0, 7, 5, null, null]], uncounted: ["2026-05-08"],
    }));
    expect(entries.map((e) => e.entryType)).toEqual(["made"]);
  });

  it("treats a file with no uncounted list as all counted", () => {
    // Older history files predate the field; they must not all become open.
    const { days } = expandHistory(file({ rows: [[0, 7, 5, null, 1]] }));
    expect(days[0].wasteConfirmedAt).not.toBeNull();
  });

  it("carries the outage flag through", () => {
    const { days } = expandHistory(
      file({ rows: [[0, 7, 5, null, 1]], outages: ["2026-05-08"] }));
    expect(days[0].isOutage).toBe(true);
  });

  it("skips a row whose date index is out of range", () => {
    // A truncated or hand-edited file must not produce entries dated
    // "undefined", which would sort ahead of every real day.
    const { entries, days } = expandHistory(file({ rows: [[9, 7, 5, null, 1]] }));
    expect(entries).toEqual([]);
    expect(days).toEqual([]);
  });

  it("survives an empty file", () => {
    expect(expandHistory(file())).toEqual({ entries: [], days: [], corrections: 0 });
  });
});

describe("a newer file that corrects days already loaded", () => {
  // Sep 20 and 21 first arrived as placeholder sheets: a stock "made" column
  // and no leftover count. The filled-in sheets came later. Deterministic ids
  // meant the second import skipped them, leaving placeholder production and
  // a day still marked uncounted on every phone that had loaded the first.
  const first = file({ uncounted: ["2026-05-08"], rows: [[0, 7, 2, null, null], [0, 8, 2, null, null]] });
  const fixed = file({ generatedAt: "2026-09-23T12:00:00.000Z",
                       rows: [[0, 7, 5, null, 3]] });          // item 8 no longer made

  /** What the store holds after loading `f`, as the importer sees it. */
  function stored(f: HistoryFile) {
    const { entries, days } = expandHistory(f);
    const latest = new Map(entries.map((e) => [`${e.businessDate}|${e.itemId}|${e.entryType}`, e]));
    return { entries, days, ids: new Set(entries.map((e) => e.mutationId)), latest };
  }

  it("replaces a sheet figure with the corrected one, as a later entry", () => {
    const s = stored(first);
    const { entries, corrections } = expandHistory(fixed, s.ids, s.latest);
    const made = entries.find((e) => e.itemId === 7 && e.entryType === "made")!;
    expect(made.quantity).toBe(5);
    expect(made.recordedAt > s.latest.get("2026-05-08|7|made")!.recordedAt).toBe(true);
    // And the count that was missing arrives as an ordinary new entry.
    expect(entries.find((e) => e.itemId === 7 && e.entryType === "waste")!.quantity).toBe(3);
    expect(corrections).toBeGreaterThanOrEqual(1);
  });

  it("zeroes production the corrected sheet no longer has", () => {
    const s = stored(first);
    const { entries } = expandHistory(fixed, s.ids, s.latest);
    const dropped = entries.find((e) => e.itemId === 8 && e.entryType === "made")!;
    expect(dropped.quantity).toBe(0);
  });

  it("never overrides a figure the operator entered in the app", () => {
    const s = stored(first);
    const typed = { ...s.latest.get("2026-05-08|7|made")!, quantity: 4,
                    mutationId: "a1b2c3", recordedAt: "2026-05-08T11:00:00.000Z" };
    s.latest.set("2026-05-08|7|made", typed);
    const { entries } = expandHistory(fixed, s.ids, s.latest);
    expect(entries.find((e) => e.itemId === 7 && e.entryType === "made")).toBeUndefined();
  });

  it("is idempotent: the same corrected file twice corrects once", () => {
    const s = stored(first);
    const once = expandHistory(fixed, s.ids, s.latest);
    const ids = new Set([...s.ids, ...once.entries.map((e) => e.mutationId)]);
    const latest = new Map(s.latest);
    for (const e of once.entries) latest.set(`${e.businessDate}|${e.itemId}|${e.entryType}`, e);
    expect(expandHistory(fixed, ids, latest).entries).toEqual([]);
  });

  it("marks a newly counted day counted, and never overwrites a real stamp", () => {
    const s = stored(first);
    const { days } = expandHistory(fixed, s.ids, s.latest);
    const merged = mergeHistoryDays(s.days, days);
    expect(merged).toHaveLength(1);
    expect(merged[0].wasteConfirmedAt).not.toBeNull();

    // Counted in the app already: the app's own stamp stands.
    const real = [{ ...s.days[0], wasteConfirmedAt: "2026-05-09T07:41:00.000Z" }];
    expect(mergeHistoryDays(real, days)).toEqual([]);
  });

  it("does not reopen a counted day the file calls uncounted", () => {
    const counted = [{ businessDate: "2026-05-08", isOutage: false,
                       productionConfirmedAt: "x", wasteConfirmedAt: "y" }];
    expect(mergeHistoryDays(counted, stored(first).days)).toEqual([]);
  });
});
