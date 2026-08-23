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
  MAX_REACH: number;
  SEED_TETHER_MIN: number;
  isTethered(c: Candidate, min?: number): boolean;
  nextCard(cs: Candidate[], pos: number[], range: Range, seen: Set<string>, maxReach?: number): Candidate | null;
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
    // "ok" sits inside MAX_REACH on purpose; at [0.9,0.9] it would be 0.566
    // from centre and correctly excluded by the reach bound, which would make
    // this pass for the wrong reason.
    const cs = [cand("broken", [0.5], 1), cand("ok", [0.6, 0.6], 1)];
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

describe("the edge is LOCAL, not global (critic cycle 1, blocker)", () => {
  const range = { lo: [0, 0], hi: [1, 1] };

  it("does not show a candidate beyond the maximum reach", () => {
    // Before this, nextCard returned the globally nearest unseen candidate, so
    // localSupply could report zero supply while a distant card rendered — the
    // surface claiming a position it was not showing.
    const far = [cand("far away", [0.99, 0.99])];
    expect(position.nextCard(far, [0.0, 0.0], range, new Set())).toBeNull();
  });

  it("still shows a candidate inside the reach", () => {
    const near = [cand("close by", [0.05, 0.05])];
    expect(position.nextCard(near, [0.0, 0.0], range, new Set())!.text).toBe("close by");
  });

  it("agrees with localSupply: zero supply nearby means no card", () => {
    // These two must never disagree. If supply is 0 within SUPPLY_RADIUS and a
    // card still renders, the edge is a fiction.
    const cs = [cand("far", [0.9, 0.9])];
    const pos = [0.0, 0.0];
    const supply = position.localSupply(cs, pos, range, new Set(), position.SUPPLY_RADIUS);
    const card = position.nextCard(cs, pos, range, new Set());
    expect(supply).toBe(0);
    expect(card).toBeNull();
  });

  it("keeps MAX_REACH above SUPPLY_RADIUS so top-up fires before the edge", () => {
    expect(position.MAX_REACH).toBeGreaterThan(position.SUPPLY_RADIUS);
  });
});

describe("seed retention is an INVARIANT, not a statistical tendency (cycle 2, blocker)", () => {
  const range = { lo: [0, 0], hi: [1, 1] };
  const tethered = (text: string, coords: number[], seedDist: number) =>
    ({ text, tier: 1, alt: 0, seedDist, coords, arrivedAt: 1 });

  it("never surfaces a card below the anisotropy floor", () => {
    // 0.414 is the measured mean cosine between two UNRELATED bge-m3 phrases.
    // Below it, a candidate is not distinguishable from a random one, so it
    // cannot be presented as being about the seed. Ranking used to consider
    // only axis distance, so a nearby-but-unrelated card won at the extremes.
    const untethered = tethered("unrelated", [0.5, 0.5], 1 - 0.30); // cosine 0.30
    expect(position.nextCard([untethered], [0.5, 0.5], range, new Set())).toBeNull();
  });

  it("prefers a tethered card over a nearer untethered one", () => {
    const near = tethered("near but unrelated", [0.50, 0.50], 1 - 0.20);
    const far = tethered("further but tethered", [0.56, 0.56], 1 - 0.60);
    expect(position.nextCard([near, far], [0.5, 0.5], range, new Set())!.text)
      .toBe("further but tethered");
  });

  it("admits a card exactly at the floor", () => {
    const edge = tethered("exactly at the floor", [0.5, 0.5], 1 - position.SEED_TETHER_MIN);
    expect(position.nextCard([edge], [0.5, 0.5], range, new Set())!.text).toBe("exactly at the floor");
  });

  it("fails closed on a missing seedDist", () => {
    const unscored = { text: "unscored", tier: 1, alt: 0, coords: [0.5, 0.5], arrivedAt: 1 } as never;
    expect(position.isTethered(unscored)).toBe(false);
  });

  it("localSupply counts only cards that could actually be shown", () => {
    // Otherwise supply reads healthy while every draw is rejected at ranking,
    // which is cycle 1's supply/card disagreement coming back from the other side.
    const cs = [tethered("untethered", [0.5, 0.5], 1 - 0.10)];
    expect(position.localSupply(cs, [0.5, 0.5], range, new Set(), 0.15)).toBe(0);
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())).toBeNull();
  });
});
