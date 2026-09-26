import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedFrom as spikeSeedFrom } from "../scripts/marginalia-judge";
// public/margin/margin-model.js is plain JS served raw from public/ (no build
// step), outside tsconfig's include — the same arrangement as the ground's
// model. The interface below pins the surface under test.
// @ts-expect-error — public/margin/margin-model.js ships untyped
import * as marginModelUntyped from "../public/margin/margin-model.js";

type Draft = { sessionId: string | null; paragraphs: string[]; notes: { text: string; tier: number; para: number }[] };
const { MARGIN_CAP, decodeDraft, encodeDraft, focusChanged, normKey, room, seedFrom, slotNear, ttl } = marginModelUntyped as {
  MARGIN_CAP: number;
  decodeDraft: (raw: string | null) => Draft;
  encodeDraft: (d: Draft) => string;
  focusChanged: (prev: { index: number; text: string } | null, next: { index: number; text: string }) => boolean;
  normKey: (t: string) => string;
  room: (onScreen: number) => number;
  seedFrom: (p: string, max?: number) => string;
  slotNear: (y: number, occupied: { y: number; h: number }[], lineH: number, minY: number, maxY: number) => number | null;
  ttl: (r: number) => number;
};

describe("seedFrom mirrors the spike's", () => {
  it("cuts identically on the spike's paragraphs and on edge cases", () => {
    const cases = [
      "The bicycle was in my grandfather's shed, under a tarp that had turned to dust. A steel frame, rust blooming through green paint, both tyres flat and cracked. I decided that afternoon to bring it back, mostly because nobody else would.",
      "  A short paragraph.  ",
      `${"word ".repeat(60)}end.`,
      "No end punctuation at all but long enough " + "to need a cut ".repeat(20),
      "Question? Exclamation! Then a long tail " + "x".repeat(300),
    ];
    for (const c of cases) expect(seedFrom(c)).toBe(spikeSeedFrom(c));
    for (const c of cases) expect(seedFrom(c).length).toBeLessThanOrEqual(200);
  });
});

describe("the margin cap", () => {
  it("is 7, under the field's legibility cap of 14", () => {
    const fieldCap = Number(/const CAP = (\d+);/.exec(readFileSync(new URL("../public/field.js", import.meta.url), "utf8"))?.[1]);
    expect(MARGIN_CAP).toBe(7);
    expect(MARGIN_CAP).toBeLessThan(fieldCap);
  });
  it("counts every word on screen, fading ones included", () => {
    expect(room(0)).toBe(7);
    expect(room(6)).toBe(1);
    expect(room(9)).toBe(0);
  });
});

describe("focusChanged — one focus request per settle, only when it means something", () => {
  it("fires for the first focus, a new paragraph, or an edited one", () => {
    expect(focusChanged(null, { index: 0, text: "a" })).toBe(true);
    expect(focusChanged({ index: 0, text: "a" }, { index: 1, text: "b" })).toBe(true);
    expect(focusChanged({ index: 0, text: "a" }, { index: 0, text: "a b" })).toBe(true);
  });
  it("stays quiet for the same paragraph unchanged, or an empty one", () => {
    expect(focusChanged({ index: 0, text: "a" }, { index: 0, text: " a " })).toBe(false);
    expect(focusChanged({ index: 0, text: "a" }, { index: 2, text: "   " })).toBe(false);
  });
});

describe("slotNear", () => {
  it("takes the first free line at or below the paragraph, then above it", () => {
    expect(slotNear(100, [], 24, 0, 500)).toBe(100);
    expect(slotNear(100, [{ y: 100, h: 24 }], 24, 0, 500)).toBe(124);
    expect(slotNear(100, [{ y: 100, h: 24 }, { y: 124, h: 24 }], 24, 0, 148)).toBe(76);
    expect(slotNear(0, [{ y: 0, h: 24 }], 24, 0, 24)).toBeNull();
  });
});

describe("draft persistence (browser-only)", () => {
  it("round-trips", () => {
    const d: Draft = { sessionId: "3f1c9a2e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", paragraphs: ["one", "two"], notes: [{ text: "bees", tier: 1, para: 1 }] };
    expect(decodeDraft(encodeDraft(d))).toEqual(d);
  });
  it("treats garbage as an empty page and drops malformed parts", () => {
    expect(decodeDraft(null)).toEqual({ sessionId: null, paragraphs: [], notes: [] });
    expect(decodeDraft("{not json")).toEqual({ sessionId: null, paragraphs: [], notes: [] });
    const d = decodeDraft(JSON.stringify({ sessionId: "nope", paragraphs: ["ok", 3], notes: [{ text: "x", tier: 9, para: 0 }, { text: "y", tier: 1, para: -1 }] }));
    expect(d).toEqual({ sessionId: null, paragraphs: ["ok"], notes: [] });
  });
});

describe("helpers", () => {
  it("ttl stays in the field's 5–10 s", () => {
    expect(ttl(0)).toBe(5000);
    expect(ttl(1)).toBe(10000);
  });
  it("normKey matches the server's key", () => {
    expect(normKey("  Night   Bus ")).toBe("night bus");
  });
});
