import { describe, expect, it } from "vitest";
import { describeSaveError } from "./saveError";

/** A DOMException-shaped error, which is what IndexedDB actually rejects with. */
const dom = (name: string, message = "") => ({ name, message });

describe("describeSaveError", () => {
  it("always says plainly that nothing was saved", () => {
    // The one fact the operator has to come away with. If a future branch
    // forgets it, they are left guessing whether to re-enter the day.
    for (const err of [dom("QuotaExceededError"), dom("VersionError"),
                       dom("AbortError"), dom("InvalidStateError"),
                       dom("UnknownError"), dom("Error", "disk on fire"),
                       new Error("boom"), null, undefined, "a string"]) {
      expect(describeSaveError(err)).toMatch(/nothing was saved/i);
    }
  });

  it("tells you to tap again only when tapping again might work", () => {
    // Out of space is the exception: retrying fails identically until space
    // is freed, so inviting a tap would be a lie.
    expect(describeSaveError(dom("QuotaExceededError"))).toMatch(/free up some space/i);
    expect(describeSaveError(dom("AbortError"))).toMatch(/tap again/i);
    expect(describeSaveError(dom("Error", "x"))).toMatch(/tap again/i);
  });

  it("sends an out-of-date tab to a restart, not to a retry", () => {
    const msg = describeSaveError(dom("VersionError"));
    expect(msg).toMatch(/open it again/i);
    expect(msg).not.toMatch(/still here/i);   // a reload loses the screen
  });

  it("reassures that the typed numbers survive, where they do", () => {
    expect(describeSaveError(dom("AbortError"))).toMatch(/still here/i);
    expect(describeSaveError(new Error("boom"))).toMatch(/still here/i);
  });

  it("includes an unrecognised error's own message", () => {
    expect(describeSaveError(dom("Error", "disk on fire"))).toContain("disk on fire");
  });

  it("survives being handed something that is not an error at all", () => {
    for (const junk of [null, undefined, "a string", 42, {}]) {
      expect(typeof describeSaveError(junk)).toBe("string");
      expect(describeSaveError(junk).length).toBeGreaterThan(20);
    }
  });
});
