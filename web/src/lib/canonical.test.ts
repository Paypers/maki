import { describe, expect, it } from "vitest";
import { CANONICAL_HOST, isThrowawayCopy } from "./canonical";

describe("isThrowawayCopy", () => {
  it("is false on the one real address", () => {
    expect(isThrowawayCopy(CANONICAL_HOST)).toBe(false);
    expect(isThrowawayCopy("MAKI-KIOSK.pages.dev")).toBe(false);
  });

  it("is true on a per-deploy address -- the ones that strand data", () => {
    expect(isThrowawayCopy("6f5b0e9d.maki-kiosk.pages.dev")).toBe(true);
    expect(isThrowawayCopy("54d16c0a.maki-kiosk.pages.dev")).toBe(true);
  });

  it("stays quiet in development", () => {
    // The banner is for the kiosk, not for the preview server.
    expect(isThrowawayCopy("localhost")).toBe(false);
    expect(isThrowawayCopy("127.0.0.1")).toBe(false);
  });

  it("does not match a look-alike domain", () => {
    expect(isThrowawayCopy("evilmaki-kiosk.pages.dev")).toBe(false);
    expect(isThrowawayCopy("maki-kiosk.pages.dev.example.com")).toBe(false);
  });
});
