import { describe, expect, it } from "vitest";
import { hasArrived, scoreCandidates, selectChild } from "../src/board/rewrite";

/** Unit vector in 3-space, so the projections below are hand-checkable. */
function unit(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

const PARENT = [1, 0, 0];
const PHRASE = [0, 1, 0];

describe("scoreCandidates", () => {
  it("scores a candidate by how much of its displacement lands along phrase - parent", () => {
    const [halfway] = scoreCandidates(PARENT, PHRASE, [{ text: "halfway", embedding: unit([1, 1, 0]) }]);
    // displacement (-0.293, 0.707, 0) against station vector (-1, 1, 0)
    expect(halfway!.score).toBeCloseTo(0.924, 2);
    expect(halfway!.tether).toBeCloseTo(0.707, 2);
  });

  it("gives the phrase itself the maximum score and zero tether", () => {
    const [arrived] = scoreCandidates(PARENT, PHRASE, [{ text: "arrived", embedding: PHRASE }]);
    expect(arrived!.score).toBeCloseTo(1, 5);
    expect(arrived!.tether).toBeCloseTo(0, 5);
  });

  it("gives a candidate identical to the parent a zero score", () => {
    const [stuck] = scoreCandidates(PARENT, PHRASE, [{ text: "stuck", embedding: PARENT }]);
    expect(stuck!.score).toBeCloseTo(0, 5);
  });
});

describe("selectChild", () => {
  const candidates = [
    { text: "halfway", embedding: unit([1, 1, 0]) },  // score .924, tether .707
    { text: "timid", embedding: unit([3, 1, 0]) },    // score .811, tether .949
    { text: "untethered", embedding: PHRASE },        // score 1.00, tether 0
  ];

  it("picks the highest-scoring candidate that clears the tether floor", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.5 });
    expect(picked?.text).toBe("halfway");
  });

  it("never picks a candidate below the tether floor even when it scores highest", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.9 });
    expect(picked?.text).toBe("timid");
  });

  it("returns null when every candidate fails the floor, rather than lowering it", () => {
    expect(selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.99 })).toBeNull();
  });

  it("rejects a candidate that near-duplicates the lineage's own history", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, {
      tetherFloor: 0.5,
      exclude: [unit([1, 1, 0])],
    });
    expect(picked?.text).toBe("timid");
  });
});

describe("hasArrived", () => {
  it("is true when the parent has effectively reached the station phrase", () => {
    expect(hasArrived(PHRASE, PHRASE, 0.9)).toBe(true);
  });

  it("is false while there is still distance to travel", () => {
    expect(hasArrived(PARENT, PHRASE, 0.9)).toBe(false);
  });
});
