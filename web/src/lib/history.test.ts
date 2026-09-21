/**
 * The opening-history import.
 *
 * This runs once, writes 6,800 rows, and is then invisible. If it files a day
 * against the wrong date or turns an uncounted cell into an observed zero,
 * nothing downstream will complain -- it will just quietly train on a year of
 * wrong numbers. Hence tests on the pure expansion rather than on the write.
 */

import { describe, expect, it } from "vitest";
import { expandHistory, type HistoryFile } from "./store";

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
    expect(expandHistory(file())).toEqual({ entries: [], days: [] });
  });
});
