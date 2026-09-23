/**
 * ZIP handling.
 *
 * This file exists because of one bug report: "why does it not recognize
 * 210934". Two separate faults were behind it.
 *
 *   The input truncated at five characters and the button silently disabled
 *   itself, so a six-digit ZIP produced no message and no lookup. The app did
 *   nothing and said nothing.
 *
 *   And the lookup itself was a PLACE-NAME search with holes in its postcode
 *   coverage: 21093 -- a real Maryland ZIP, and almost certainly what was
 *   meant -- returned no results, which the app reported as "No US location
 *   found", blaming the operator for a ZIP that was perfectly valid.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZip, zipProblem } from "./weather";

describe("zipProblem", () => {
  it("accepts a five-digit ZIP", () => {
    expect(zipProblem("21093")).toBeNull();
    expect(zipProblem(" 21201 ")).toBeNull();
  });

  it("accepts ZIP+4", () => {
    expect(zipProblem("21093-4567")).toBeNull();
  });

  it("explains a six-digit ZIP instead of swallowing the digit", () => {
    // The actual report. Silence was the bug; a sentence is the fix.
    const msg = zipProblem("210934");
    expect(msg).toContain("6 digits");
    expect(msg).toContain("five");
    expect(msg).toContain("21093");        // names the ZIP they probably meant
  });

  it("does not invent a ZIP+4 it was never given", () => {
    // "210934" padded to "21093-4000" would suggest a real-looking postcode
    // that is not the operator's. Only nine digits earn the +4 wording.
    expect(zipProblem("210934")).not.toContain("-");
    expect(zipProblem("210934567")).toContain("21093-4567");
  });

  it("explains a short one too", () => {
    expect(zipProblem("2109")).toContain("4 digits");
    expect(zipProblem("2")).toContain("1 digit");   // not "1 digits"
  });

  it("says nothing about an empty field", () => {
    // Nagging before anything is typed is noise, not help.
    expect(zipProblem("")).toBeNull();
    expect(zipProblem("   ")).toBeNull();
  });

  it("lets a town name through to the lookup", () => {
    expect(zipProblem("Lutherville, MD")).toBeNull();
  });
});

const zippo = (zip: string) => ({
  "post code": zip,
  places: [{ "place name": "Lutherville Timonium", state: "Maryland",
             latitude: "39.4332", longitude: "-76.6546" }],
});

const meteo = (name: string) => ({
  results: [{ id: 1, name, admin1: "Maryland", latitude: 39.29,
              longitude: -76.61, timezone: "America/New_York" }],
});

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const { status, body } = handler(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveZip", () => {
  it("resolves a ZIP the place search cannot find", async () => {
    // 21093 is the regression. Open-Meteo answers 200 with no results at all;
    // the postcode dataset knows it perfectly well.
    mockFetch((url) =>
      url.includes("zippopotam") ? { status: 200, body: zippo("21093") }
                                 : { status: 200, body: {} });
    const loc = await resolveZip("21093");
    expect(loc.label).toBe("Lutherville Timonium, Maryland");
    expect(loc.latitude).toBeCloseTo(39.4332, 4);
    expect(loc.zip).toBe("21093");
  });

  it("prefers the postcode dataset over the place search", async () => {
    // Both answer; the authoritative one wins. A place search that matches a
    // ZIP to some unrelated town is worse than no answer.
    mockFetch((url) =>
      url.includes("zippopotam") ? { status: 200, body: zippo("21093") }
                                 : { status: 200, body: meteo("Somewhere Else") });
    expect((await resolveZip("21093")).label).toBe("Lutherville Timonium, Maryland");
  });

  it("falls back to the place search when the postcode dataset is down", async () => {
    mockFetch((url) =>
      url.includes("zippopotam") ? { status: 503, body: {} }
                                 : { status: 200, body: meteo("Baltimore") });
    expect((await resolveZip("21201")).label).toBe("Baltimore, Maryland");
  });

  it("takes the first five digits of a ZIP+4", async () => {
    let asked = "";
    mockFetch((url) => {
      if (url.includes("zippopotam")) { asked = url; return { status: 200, body: zippo("21093") }; }
      return { status: 200, body: {} };
    });
    await resolveZip("21093-4567");
    expect(asked).toContain("/21093");
    expect(asked).not.toContain("4567");
  });

  it("resolves a town name", async () => {
    mockFetch(() => ({ status: 200, body: meteo("Lutherville") }));
    const loc = await resolveZip("Lutherville, MD");
    expect(loc.label).toBe("Lutherville, Maryland");
  });

  it("rejects six digits before making any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(resolveZip("210934")).rejects.toThrow(/six|5|five/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tells you to try a town name when a valid ZIP finds nothing", async () => {
    // 404 from the postcode dataset is a real answer: no such ZIP. The message
    // must not dead-end.
    mockFetch((url) =>
      url.includes("zippopotam") ? { status: 404, body: {} }
                                 : { status: 200, body: {} });
    await expect(resolveZip("99999")).rejects.toThrow(/town/i);
  });

  it("refuses an empty field without calling anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(resolveZip("  ")).rejects.toThrow(/ZIP code/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
