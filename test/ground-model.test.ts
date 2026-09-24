import { describe, expect, it } from "vitest";
// public/ground/ground-model.js is plain JS served raw from public/ (no build
// step), outside tsconfig's include — the same arrangement as belt-model.js.
// The interface below pins the surface under test.
// @ts-expect-error — public/ground/ground-model.js ships untyped
import * as groundModelUntyped from "../public/ground/ground-model.js";

type Pt = { x: number; y: number };
type Box = Pt & { w: number; h: number };
const {
  CAP, GROUND_H, GROUND_W, bucketOrder, dewSpots, wordWidth, groundScale, landingSpot, normKey, room, skyToRetire,
  tierWeights, toGround, toScreen, ttl,
} = groundModelUntyped as {
  CAP: number;
  GROUND_H: number;
  GROUND_W: number;
  bucketOrder: (r1: number, r2: number, dewpoint: number, altitude: number) => string[];
  dewSpots: (cx: number, cy: number, widths: number[], occupied: Box[], rand: () => number, lineH?: number) => Pt[];
  wordWidth: (text: string, fontPx: number, scale: number) => number;
  groundScale: (w: number, h: number) => number;
  landingSpot: (boxes: Box[], x: number, width: number, lineH?: number) => Pt;
  normKey: (t: string) => string;
  room: (sky: number, dew: number) => number;
  skyToRetire: (sky: number, dew: number, incoming: number) => number;
  tierWeights: (d: number) => number[];
  toGround: (p: Pt, s: number) => Pt;
  toScreen: (p: Pt, s: number) => Pt;
  ttl: (kind: string, r: number) => number;
};
import { GROUND_H as SERVER_H, GROUND_W as SERVER_W } from "../src/ground-core";

describe("ground-model mirrors the server", () => {
  it("uses the same ground coordinate space as src/ground-core.ts", () => {
    expect([GROUND_W, GROUND_H]).toEqual([SERVER_W, SERVER_H]);
  });
  it("keeps the field's legibility cap", () => {
    expect(CAP).toBe(14);
  });
});

describe("CAP is shared by sky and dew", () => {
  it("room never goes negative", () => {
    expect(room(10, 2)).toBe(2);
    expect(room(14, 3)).toBe(0);
  });
  it("dew retires just enough sky words to fit", () => {
    expect(skyToRetire(12, 0, 5)).toBe(3);
    expect(skyToRetire(4, 2, 5)).toBe(0);
  });
});

describe("bucketOrder", () => {
  it("tries every bucket exactly once, starting with the dice's choice", () => {
    const order = bucketOrder(0, 0.9, 0.35, 0.25);
    expect(order[0]).toBe("w0a0");
    expect(order[1]).toBe("w0a1");
    expect(new Set(order).size).toBe(6);
  });
  it("high dewpoint favours the far tier", () => {
    const w = tierWeights(0.95);
    expect(w[2]).toBeGreaterThan(w[0]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe("coordinates", () => {
  it("round-trips and clamps", () => {
    const s = groundScale(600, 600);
    expect(s).toBeCloseTo(0.5);
    const p = toGround(toScreen({ x: 300, y: 200 }, s), s);
    expect(p.x).toBeCloseTo(300);
    expect(toGround({ x: -10, y: 1e6 }, s)).toEqual({ x: 0, y: GROUND_H });
    expect(toGround({ x: 5, y: 5 }, 0)).toEqual({ x: 5, y: 5 });
  });
});

describe("placement", () => {
  it("landingSpot lands under the word, and clears boxes already there — including ones still falling", () => {
    const a = landingSpot([], 400, 200, 34);
    expect(a.x).toBe(300);
    const taken = [{ ...a, w: 200, h: 34 }];
    const b = landingSpot(taken, 400, 220, 34);
    const hit = b.x < a.x + 200 && a.x < b.x + 220 && b.y < a.y + 34 && a.y < b.y + 34;
    expect(hit).toBe(false);
    const c = landingSpot([...taken, { ...b, w: 220, h: 34 }], 400, 180, 34);
    for (const q of [...taken, { ...b, w: 220, h: 34 }]) {
      expect(c.x < q.x + q.w && q.x < c.x + 180 && c.y < q.y + q.h && q.y < c.y + 34).toBe(false);
    }
  });
  it("dewSpots stays on the ground and keeps word boxes apart", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const widths = [220, 180, 260, 140, 200];
    const occupied = [{ x: 540, y: 150, w: 160, h: 30 }];
    const spots = dewSpots(600, 210, widths, occupied, rand, 30);
    expect(spots).toHaveLength(5);
    const boxes = spots.map((p, i) => ({ ...p, w: widths[i]!, h: 30 }));
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(GROUND_W);
      expect(b.y + b.h).toBeLessThanOrEqual(GROUND_H);
    }
    const hit = (a: typeof boxes[number], b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (let i = 0; i < boxes.length; i++) {
      expect(hit(boxes[i]!, occupied[0]!)).toBe(false);
      for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i]!, boxes[j]!)).toBe(false);
    }
  });
  it("wordWidth grows with the text and shrinks with zoom", () => {
    expect(wordWidth("abcd", 20, 1)).toBeGreaterThan(wordWidth("ab", 20, 1));
    expect(wordWidth("abcd", 20, 2)).toBeLessThan(wordWidth("abcd", 20, 1));
  });
});

describe("lifetimes", () => {
  it("sky keeps the field's 5–10 s; dew lingers 7–12 s", () => {
    expect(ttl("sky", 0)).toBe(5000);
    expect(ttl("sky", 1)).toBe(10000);
    expect(ttl("dew", 0)).toBe(7000);
    expect(ttl("dew", 1)).toBe(12000);
  });
  it("normKey matches the server's groundKey", () => {
    expect(normKey("  Night   Bus ")).toBe("night bus");
  });
});
