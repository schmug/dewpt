import { describe, expect, it } from "vitest";

// public/drift/position.js is plain JS served raw from public/ (no build step),
// so it sits outside tsconfig's include — same arrangement as
// public/pool-client.js's mirror in test/pool-client.test.ts.
// @ts-expect-error — public/drift/position.js ships untyped
import * as positionUntyped from "../public/drift/position.js";

interface Range { lo: number[]; hi: number[] }
interface Candidate { text: string; tier: number; alt: number; seedDist: number; coords: number[]; arrivedAt: number }

const position = positionUntyped as {
  STEP: number;
  SUPPLY_RADIUS: number;
  SUPPLY_FLOOR: number;
  freezeRange(candidates: Candidate[], axisCount: number): Range;
  widenRange(range: Range, candidates: Candidate[]): Range;
  toNormalized(raw: number, range: Range, axis: number): number;
  toRaw(norm: number, range: Range, axis: number): number;
  initialPosition(range: Range): number[];
  stepPosition(pos: number[], range: Range, axis: number, dir: number, step?: number): number[];
  distanceTo(c: Candidate, pos: number[], range: Range): number;
  nextCard(cs: Candidate[], pos: number[], range: Range, seen: Set<string>): Candidate | null;
  localSupply(cs: Candidate[], pos: number[], range: Range, seen: Set<string>, radius: number): number;
};

function cand(text: string, coords: number[], arrivedAt = 0): Candidate {
  return { text, tier: 1, alt: 0, seedDist: 0.5, coords, arrivedAt };
}

describe("freezeRange", () => {
  it("takes per-axis min and max across the set", () => {
    const r = position.freezeRange([cand("a", [-0.1, 0.2]), cand("b", [0.3, -0.4])], 2);
    expect(r.lo).toEqual([-0.1, -0.4]);
    expect(r.hi).toEqual([0.3, 0.2]);
  });

  it("gives a degenerate axis a unit span rather than a zero one", () => {
    // A zero span would make toNormalized divide by zero and every card land at
    // NaN, which ranks as unreachable and empties the surface silently.
    const r = position.freezeRange([cand("a", [0.2]), cand("b", [0.2])], 1);
    expect(r.hi[0]! - r.lo[0]!).toBeGreaterThan(0);
    expect(position.toNormalized(0.2, r, 0)).toBeCloseTo(0.5, 5);
  });

  it("ignores non-finite and missing coords instead of poisoning the range", () => {
    const r = position.freezeRange([cand("a", [0.1]), cand("b", [NaN]), cand("c", [])], 1);
    expect(Number.isFinite(r.lo[0]!)).toBe(true);
    expect(Number.isFinite(r.hi[0]!)).toBe(true);
  });
});

describe("widenRange", () => {
  it("widens for an out-of-range top-up", () => {
    const base = { lo: [0], hi: [1] };
    const r = position.widenRange(base, [cand("x", [1.5]), cand("y", [-0.5])]);
    expect(r.lo).toEqual([-0.5]);
    expect(r.hi).toEqual([1.5]);
  });

  it("is monotone — an inside candidate never narrows the range", () => {
    // Narrowing would move what a stored raw position means, which is exactly
    // the semantic drift the frozen range exists to prevent.
    const base = { lo: [0], hi: [1] };
    const r = position.widenRange(base, [cand("x", [0.5])]);
    expect(r.lo).toEqual([0]);
    expect(r.hi).toEqual([1]);
  });
});

describe("stepPosition", () => {
  it("moves one tenth of the frozen span per swipe", () => {
    const range = { lo: [0], hi: [1] };
    expect(position.stepPosition([0.5], range, 0, 1)[0]).toBeCloseTo(0.6, 5);
    expect(position.stepPosition([0.5], range, 0, -1)[0]).toBeCloseTo(0.4, 5);
  });

  it("scales the step to the raw span, not to 0..1", () => {
    const range = { lo: [-0.2], hi: [0.2] };  // span 0.4
    expect(position.stepPosition([0], range, 0, 1)[0]).toBeCloseTo(0.04, 5);
  });

  it("clamps at the edges instead of walking outside the coordinates", () => {
    const range = { lo: [0], hi: [1] };
    expect(position.stepPosition([0.95], range, 0, 1)[0]).toBe(1);
    expect(position.stepPosition([0.05], range, 0, -1)[0]).toBe(0);
  });

  it("leaves the other axis untouched", () => {
    const range = { lo: [0, 0], hi: [1, 1] };
    expect(position.stepPosition([0.5, 0.5], range, 0, 1)[1]).toBe(0.5);
  });
});

describe("nextCard", () => {
  const range = { lo: [0, 0], hi: [1, 1] };

  it("returns the nearest unseen candidate in normalized 2D", () => {
    const cs = [cand("far", [0.9, 0.9]), cand("near", [0.55, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("near");
  });

  it("skips anything already seen", () => {
    const cs = [cand("near", [0.5, 0.5]), cand("next", [0.7, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set(["near"]))!.text).toBe("next");
  });

  it("breaks a tie toward the freshest arrival", () => {
    // The measured axis middle is a dense pile of near-ties (midShare 0.29-0.45).
    // Fresh-first is what turns that pile into a deep well instead of a fixed one.
    const cs = [cand("old", [0.6, 0.5], 1), cand("new", [0.6, 0.5], 2)];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("new");
  });

  it("never returns a candidate with a missing or non-finite coord", () => {
    const cs = [cand("broken", [0.5], 1), cand("ok", [0.9, 0.9], 1)];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("ok");
  });

  it("returns null when everything is seen — that is the edge", () => {
    const cs = [cand("a", [0.5, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set(["a"]))).toBeNull();
  });
});

describe("localSupply", () => {
  const range = { lo: [0, 0], hi: [1, 1] };

  it("counts only unseen candidates inside the radius", () => {
    const cs = [cand("in", [0.52, 0.5]), cand("out", [0.95, 0.95]), cand("seen", [0.51, 0.5])];
    expect(position.localSupply(cs, [0.5, 0.5], range, new Set(["seen"]), 0.15)).toBe(1);
  });

  it("is local, not global — a full set far away reads as a shortage", () => {
    // A global count would let the user walk into a hole while the client
    // believes it is well stocked.
    const cs = Array.from({ length: 50 }, (_, i) => cand(`x${i}`, [0.95, 0.95], i));
    expect(position.localSupply(cs, [0.1, 0.1], range, new Set(), 0.15)).toBe(0);
  });
});

describe("unmeasured constants are labelled as such", () => {
  it("declares SUPPLY_RADIUS and SUPPLY_FLOOR", () => {
    expect(position.SUPPLY_RADIUS).toBeGreaterThan(0);
    expect(position.SUPPLY_FLOOR).toBeGreaterThan(0);
  });
});
