import { describe, expect, it } from "vitest";
import {
  addDays, currentBizDate, isoWeekday, outstandingTasks, previousDay,
  toBizDate, weeksBack, type DayState,
} from "./businessDay";

describe("business date", () => {
  it("uses local calendar days, not UTC", () => {
    // 00:30 local on Sep 2. As a UTC instant this is still Sep 1 in Maryland,
    // and using the UTC date would file the whole day's waste one day early.
    expect(toBizDate(new Date(2026, 8, 2, 0, 30))).toBe("2026-09-02");
    expect(toBizDate(new Date(2026, 8, 2, 23, 59))).toBe("2026-09-02");
  });

  it("flips at the rollover hour", () => {
    const justAfterMidnight = new Date(2026, 8, 2, 0, 30);
    expect(currentBizDate(justAfterMidnight, 0)).toBe("2026-09-02");
    // With a 4am rollover the same instant still belongs to the previous day.
    expect(currentBizDate(justAfterMidnight, 4)).toBe("2026-09-01");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(weeksBack("2026-09-02", 1)).toBe("2026-08-26");
  });

  it("survives a DST transition", () => {
    // US DST ends 2026-11-01. Naive 24h arithmetic lands on the wrong day here.
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(previousDay("2026-11-01")).toBe("2026-10-31");
  });

  it("maps ISO weekdays with Monday as 1", () => {
    expect(isoWeekday("2026-08-31")).toBe(1); // Monday
    expect(isoWeekday("2026-09-06")).toBe(7); // Sunday
  });
});

describe("outstanding tasks", () => {
  const today = "2026-09-02";
  const day = (d: Partial<DayState> & { date: string }): DayState => ({
    hasProduction: true, productionConfirmed: true,
    wasteConfirmed: true, isOutage: false, ...d,
  });

  it("asks for yesterday's waste before today's production", () => {
    const tasks = outstandingTasks(
      [day({ date: "2026-09-01", wasteConfirmed: false })], today);
    expect(tasks[0]).toMatchObject({ date: "2026-09-01", kind: "waste" });
    expect(tasks.some((t) => t.date === today && t.kind === "production")).toBe(true);
  });

  it("surfaces every missed day, oldest first", () => {
    const tasks = outstandingTasks([
      day({ date: "2026-08-30", wasteConfirmed: false }),
      day({ date: "2026-08-31", wasteConfirmed: false }),
      day({ date: "2026-09-01", wasteConfirmed: false }),
    ], today).filter((t) => t.kind === "waste");
    expect(tasks.map((t) => t.date)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(tasks[0].isBackfill).toBe(true);
  });

  it("never asks for waste on a day with no production", () => {
    const tasks = outstandingTasks(
      [day({ date: "2026-09-01", hasProduction: false, wasteConfirmed: false })], today);
    expect(tasks.some((t) => t.kind === "waste")).toBe(false);
  });

  it("skips outage days entirely", () => {
    const tasks = outstandingTasks(
      [day({ date: "2026-09-01", wasteConfirmed: false, isOutage: true })], today);
    expect(tasks.some((t) => t.date === "2026-09-01")).toBe(false);
  });

  it("does not chase production older than yesterday", () => {
    // A day that was never recorded is lost. Inventing it a week later would be
    // fabrication, not backfill.
    const tasks = outstandingTasks([
      day({ date: "2026-09-01", productionConfirmed: false }),
    ], today);
    const dates = tasks.filter((t) => t.kind === "production").map((t) => t.date);
    expect(dates).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("invents no past task on a first run with no history at all", () => {
    // This is what a fresh install sees. It used to lead with "Plan <yesterday>"
    // -- a task for a day the app had never seen, sorted ahead of today because
    // its date was older. The only thing outstanding on day one is day one.
    const tasks = outstandingTasks([], today);
    expect(tasks.map((t) => [t.date, t.kind])).toEqual([[today, "production"]]);
  });

  it("still offers yesterday when yesterday left a trace", () => {
    // Quantities entered and never confirmed: a real half-finished day, and the
    // one case where backfilling production is a record rather than a guess.
    const tasks = outstandingTasks([
      day({ date: "2026-09-01", hasProduction: true, productionConfirmed: false }),
    ], today);
    expect(tasks.some((t) => t.date === "2026-09-01" && t.kind === "production"))
      .toBe(true);
  });

  it("puts today's plan first when yesterday is a blank", () => {
    // Ordering is by date, so anything admitted for yesterday outranks today.
    // That is correct for waste and wrong for a day that does not exist.
    const tasks = outstandingTasks([], today);
    expect(tasks[0]?.date).toBe(today);
  });

  it("is empty once everything is confirmed", () => {
    const days = [day({ date: "2026-09-01" }), day({ date: today })];
    expect(outstandingTasks(days, today)).toEqual([]);
  });
});
