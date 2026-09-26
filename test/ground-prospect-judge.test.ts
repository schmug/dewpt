import { describe, expect, it } from "vitest";
import { binomTail } from "../scripts/ground-judge";
import {
  PROSPECT_PASS, jaccardSplit, neighbourSummary, positionMaxTail, prospectVerdict,
} from "../scripts/ground-prospect-judge";

describe("pre-registered numbers", () => {
  it("match the exact values the measurement doc quotes", () => {
    // A doc number that drifts from these is wrong.
    expect(binomTail(PROSPECT_PASS.attributeMin, PROSPECT_PASS.attributeN, 1 / 3)).toBeCloseTo(0.0144, 4);
    expect(positionMaxTail(PROSPECT_PASS.positionMax, PROSPECT_PASS.attributeN, 3)).toBeCloseTo(0.0118, 4);
  });
});

describe("positionMaxTail", () => {
  it("is exact on cases small enough to count by hand", () => {
    // 2 trials, 2 positions: P(some position gets both) = 2/4.
    expect(positionMaxTail(2, 2, 2)).toBeCloseTo(0.5, 12);
    // 3 trials, 3 positions: P(max >= 2) = 1 - 3!/27.
    expect(positionMaxTail(2, 3, 3)).toBeCloseTo(1 - 6 / 27, 12);
    expect(positionMaxTail(0, 5, 3)).toBe(1);
    expect(positionMaxTail(6, 5, 3)).toBe(0);
  });
  it("equals m x the binomial tail when two positions cannot both reach k (2k > n)", () => {
    // the events "position i gets >= k" are then disjoint, so the union is a plain sum
    expect(positionMaxTail(12, 18, 3)).toBeCloseTo(3 * binomTail(12, 18, 1 / 3), 12);
  });
});

describe("jaccardSplit", () => {
  // groups 0 and 2 are the neighbouring pair; 1 is the odd one out
  const sets = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 3, 9]];
  it("bars on the non-neighbour pairs and reports the neighbour pair apart", () => {
    const s = jaccardSplit(sets, [0, 2]);
    expect(s.bar).toBe(0);
    expect(s.neighbour).toBeCloseTo(3 / 5, 12);
  });
  it("is NaN when a group has no near plan, so the verdict cannot pass on it", () => {
    const s = jaccardSplit([sets[0]!, null, sets[2]!], [0, 2]);
    expect(Number.isNaN(s.bar)).toBe(true);
  });
});

describe("neighbourSummary", () => {
  it("counts trials at the neighbouring groups and misses into the sibling", () => {
    const trials = [
      { group: 0, picked: 0 }, // neighbour, correct
      { group: 0, picked: 2 }, // neighbour, into sibling
      { group: 2, picked: 1 }, // neighbour, wrong but not the sibling
      { group: 2, picked: null }, // neighbour, unjudged: a miss, not a sibling pick
      { group: 1, picked: 1 }, // odd one out: not counted
    ];
    expect(neighbourSummary(trials, [0, 2])).toEqual({ n: 4, correct: 1, intoSibling: 1 });
  });
});

describe("prospectVerdict", () => {
  const good = { attribute: { correct: 11, judged: 18, byPosition: [6, 6, 6] }, jaccard: 0.2 };
  it("passes only when every pre-registered bar is met", () => {
    expect(prospectVerdict(good).outcome).toBe("PASS");
    expect(prospectVerdict({ ...good, attribute: { ...good.attribute, correct: 10 } }).outcome).toBe("FAIL");
    expect(prospectVerdict({ ...good, jaccard: 0.26 }).outcome).toBe("FAIL");
    expect(prospectVerdict({ ...good, jaccard: NaN }).outcome).toBe("FAIL");
  });
  it("counts unjudged trials as misses, never shrinking n", () => {
    const r = prospectVerdict({ ...good, attribute: { correct: 10, judged: 12, byPosition: [4, 4, 4] } });
    expect(r.outcome).toBe("FAIL");
    expect(r.reasons[0]).toContain("6 unjudged");
  });
  it("calls a position-driven judge INVALID rather than PASS or FAIL", () => {
    expect(prospectVerdict({ ...good, attribute: { ...good.attribute, byPosition: [12, 3, 3] } }).outcome).toBe("INVALID");
    expect(prospectVerdict({ ...good, attribute: { ...good.attribute, byPosition: [11, 4, 3] } }).outcome).toBe("PASS");
  });
});
