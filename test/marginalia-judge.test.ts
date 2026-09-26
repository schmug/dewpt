import { describe, expect, it } from "vitest";
import { binomTail } from "../scripts/ground-judge";
import { positionMaxTail } from "../scripts/ground-prospect-judge";
import {
  MARGINALIA_PASS, ROTATIONS, majorityChance, marginaliaVerdict, paragraphMessages, seedFrom, trialCorrect,
} from "../scripts/marginalia-judge";

describe("pre-registered numbers", () => {
  it("match the exact values the measurement doc quotes", () => {
    // A doc number that drifts from these is wrong.
    expect(majorityChance(3, 3)).toBeCloseTo(7 / 27, 12);
    expect(binomTail(MARGINALIA_PASS.correctMin, MARGINALIA_PASS.trials, majorityChance(3, 3))).toBeCloseTo(0.0215, 4);
    expect(positionMaxTail(MARGINALIA_PASS.positionMax, MARGINALIA_PASS.trials * ROTATIONS.length, 3)).toBeCloseTo(0.0134, 4);
  });
});

describe("rotation", () => {
  it("is a Latin square: every option sits in every position exactly once", () => {
    for (let pos = 0; pos < 3; pos++) expect(ROTATIONS.map((r) => r[pos]).sort()).toEqual([0, 1, 2]);
    for (const r of ROTATIONS) expect([...r].sort()).toEqual([0, 1, 2]);
  });
  it("a judge that always answers the same position never scores a trial", () => {
    for (let pos = 0; pos < 3; pos++) {
      const votes = ROTATIONS.map((r) => r[pos]!); // option shown at that position in each rotation
      for (let target = 0; target < 3; target++) expect(trialCorrect(votes, target)).toBe(false);
    }
  });
  it("a trial is correct only when the target wins a majority of rotations", () => {
    expect(trialCorrect([1, 1, 0], 1)).toBe(true);
    expect(trialCorrect([1, 1, 1], 1)).toBe(true);
    expect(trialCorrect([1, null, 0], 1)).toBe(false); // an unjudged rotation is a vote for nothing
    expect(trialCorrect([null, null, null], 1)).toBe(false);
  });
});

describe("marginaliaVerdict", () => {
  const good = { correct: 8, byPosition: [15, 15, 15] };
  it("passes only at or above the pre-registered bar", () => {
    expect(marginaliaVerdict(good).outcome).toBe("PASS");
    expect(marginaliaVerdict({ ...good, correct: 7 }).outcome).toBe("FAIL");
  });
  it("calls a position-driven judge INVALID rather than PASS or FAIL", () => {
    expect(marginaliaVerdict({ ...good, byPosition: [24, 11, 10] }).outcome).toBe("INVALID");
    expect(marginaliaVerdict({ ...good, byPosition: [23, 11, 11] }).outcome).toBe("PASS");
  });
});

describe("paragraphMessages", () => {
  it("shows numbered paragraphs and the words, and never the method", () => {
    const text = paragraphMessages(["alpha para", "beta para", "gamma para"], ["x", "y"]).map((m) => m.content).join("\n");
    expect(text).toContain("Paragraph 2: beta para");
    expect(text).toContain('{"choice": N}');
    expect(text).not.toMatch(/cosine|embedding|rank|pool|seed|steer|rotation|previous|next/i);
  });
});

describe("seedFrom", () => {
  it("cuts at the last sentence boundary within the limit", () => {
    const p = "First sentence here. Second one is a bit longer than the first. " + "x".repeat(200);
    expect(seedFrom(p, 200)).toBe("First sentence here. Second one is a bit longer than the first.");
  });
  it("keeps a short paragraph whole", () => {
    expect(seedFrom("  A short paragraph.  ", 200)).toBe("A short paragraph.");
  });
  it("falls back to a word boundary when no sentence ends in time, and never exceeds the limit", () => {
    const s = seedFrom(`${"word ".repeat(60)}end.`, 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith("word")).toBe(true);
  });
});
