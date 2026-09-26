import { describe, expect, it } from "vitest";
import {
  PASS, attributeMessages, binomTail, bridgeMessages, centrality, distinctPicks, meanJaccard, mulberry32, parsePick, shuffle, verdict,
} from "../scripts/ground-judge";

describe("parsePick", () => {
  it("reads a clean or fenced answer", () => {
    expect(parsePick('{"group": 2}', "group", 3)).toBe(1);
    expect(parsePick('```json\n{"choice": "3"}\n```', "choice", 3)).toBe(2);
  });
  it.each([
    ['{"group": 0}'],
    ['{"group": 4}'],
    ['{"group": 1.5}'],
    ['{"group": [1]}'],
    ['{"choice": 1}'],
    ["group 2"],
    ["{broken"],
  ])("rejects %s", (raw) => {
    expect(parsePick(raw, "group", 3)).toBeNull();
  });
  it("rejects non-strings", () => {
    expect(parsePick(2, "group", 3)).toBeNull();
  });
});

describe("binomTail", () => {
  it("matches the pre-registered p-values", () => {
    // The exact values the docs quote — a doc number that drifts from these is wrong.
    expect(binomTail(PASS.attributeMin, PASS.attributeN, 1 / 3)).toBeCloseTo(0.0144, 4);
    expect(binomTail(PASS.bridgeMin, PASS.bridgeN, 1 / 4)).toBeCloseTo(0.0193, 4);
    expect(binomTail(0, 10, 0.5)).toBe(1);
    expect(binomTail(11, 10, 0.5)).toBe(0);
    expect(binomTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 10);
  });
});

describe("distinctPicks", () => {
  it("keeps the first list's true rank and skips collisions in later lists", () => {
    expect(distinctPicks([[5, 6], [5, 7], [7, 8]], 0)).toEqual([5, 7, 8]);
  });
  it("returns null when a list runs dry", () => {
    expect(distinctPicks([[1], [1]], 0)).toBeNull();
  });
});

describe("meanJaccard", () => {
  it("is 0 for disjoint sets and 1 for identical ones", () => {
    expect(meanJaccard([[1, 2], [3, 4], [5, 6]])).toBe(0);
    expect(meanJaccard([[1, 2], [1, 2]])).toBe(1);
  });
});

describe("prompts never leak the method", () => {
  it("attribution shows groups and words only", () => {
    const text = attributeMessages([["a"], ["b"], ["c"]], ["x", "y"]).map((m) => m.content).join("\n");
    expect(text).not.toMatch(/cosine|embedding|bridge|rank|steer/i);
  });
  it("bridge shows X, Y and unlabeled options only", () => {
    const text = bridgeMessages("x", "y", ["p", "q", "r"]).map((m) => m.content).join("\n");
    expect(text).not.toMatch(/cosine|embedding|near X|near Y|rank/i);
  });
});

describe("shuffle", () => {
  it("is a deterministic permutation", () => {
    const a = shuffle([0, 1, 2, 3], mulberry32(7));
    expect([...a].sort()).toEqual([0, 1, 2, 3]);
    expect(shuffle([0, 1, 2, 3], mulberry32(7))).toEqual(a);
  });
});

describe("verdict", () => {
  const good = {
    attribute: { correct: 11, judged: 18, byPosition: [6, 6, 6] },
    bridge: { chosen: 9, hub: 3, judged: 18, byPosition: [5, 5, 4, 4] },
    jaccard: 0.2,
  };
  it("passes only when every pre-registered bar is met", () => {
    expect(verdict(good).outcome).toBe("PASS");
    expect(verdict({ ...good, jaccard: 0.26 }).outcome).toBe("FAIL");
    expect(verdict({ ...good, bridge: { ...good.bridge, chosen: 8 } }).outcome).toBe("FAIL");
  });
  it("fails a bridge that does not beat the hub, however often it is chosen", () => {
    expect(verdict({ ...good, bridge: { ...good.bridge, chosen: 9, hub: 9 } }).outcome).toBe("FAIL");
  });
  it("counts unjudged trials as misses, never shrinking n", () => {
    const r = verdict({ ...good, attribute: { correct: 10, judged: 12, byPosition: [4, 4, 4] } });
    expect(r.outcome).toBe("FAIL");
    expect(r.reasons[0]).toContain("6 unjudged");
  });
  it("calls a position-driven judge INVALID rather than PASS or FAIL — it can fail", () => {
    expect(verdict({ ...good, attribute: { ...good.attribute, byPosition: [12, 3, 3] } }).outcome).toBe("INVALID");
    expect(verdict({ ...good, bridge: { ...good.bridge, byPosition: [10, 4, 2, 2] } }).outcome).toBe("INVALID");
    expect(verdict({ ...good, attribute: { ...good.attribute, byPosition: [11, 4, 3] } }).outcome).toBe("PASS");
  });
});

describe("centrality", () => {
  it("ranks the word nearest everything highest", () => {
    const cos = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]!;
    const c = centrality([[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]], cos);
    expect(c[2]).toBeGreaterThan(c[0]!);
    expect(c[2]).toBeGreaterThan(c[1]!);
  });
});
