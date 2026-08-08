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

import { buildRewriteMessages, generateRewrites } from "../src/board/rewrite";
import type { AiRunner } from "../src/generation";

describe("buildRewriteMessages", () => {
  const inputs = { fragment: "urban gardening", target: "a surreal, dreamlike version", count: 8, exclude: ["rooftop bee lease"] };

  it("puts the fragment, target and count in the final user turn", () => {
    const messages = buildRewriteMessages(inputs);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("urban gardening");
    expect(last.content).toContain("a surreal, dreamlike version");
    expect(last.content).toContain("8");
  });

  it("carries the exclusion list so the model avoids the lineage's own history", () => {
    expect(buildRewriteMessages(inputs).at(-1)!.content).toContain("rooftop bee lease");
  });

  it("opens with a system turn and includes few-shot demonstrations", () => {
    const messages = buildRewriteMessages(inputs);
    expect(messages[0]!.role).toBe("system");
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThan(0);
  });

  it("never mentions the weather vocabulary — prompts use plain concepts", () => {
    const all = buildRewriteMessages(inputs).map((m) => m.content).join(" ").toLowerCase();
    for (const term of ["dewpoint", "drizzle", "condensate", "evaporated"]) {
      expect(all).not.toContain(term);
    }
  });
});

describe("generateRewrites", () => {
  function runnerReturning(payload: unknown): AiRunner {
    return { async run() { return payload; } };
  }

  it("parses a plain JSON array", async () => {
    const ai = runnerReturning({ response: JSON.stringify(["lathe confessional", "hammer that dreams"]) });
    await expect(generateRewrites(ai, "m", { fragment: "tool libraries", target: "x", count: 2, exclude: [] }))
      .resolves.toEqual(["lathe confessional", "hammer that dreams"]);
  });

  it("recovers an array buried in prose", async () => {
    const ai = runnerReturning({ response: 'Sure! ["rain barrel", "seed swap"] hope that helps' });
    await expect(generateRewrites(ai, "m", { fragment: "gardening", target: "x", count: 2, exclude: [] }))
      .resolves.toEqual(["rain barrel", "seed swap"]);
  });

  it("returns an empty list rather than throwing on junk", async () => {
    const ai = runnerReturning({ response: "I'm sorry, I can't help with that." });
    await expect(generateRewrites(ai, "m", { fragment: "x", target: "y", count: 4, exclude: [] }))
      .resolves.toEqual([]);
  });

  it("drops items longer than five words, per the fragment register", async () => {
    const ai = runnerReturning({ response: JSON.stringify(["rooftop bee lease", "this phrase is far too long to be a fragment"]) });
    await expect(generateRewrites(ai, "m", { fragment: "x", target: "y", count: 2, exclude: [] }))
      .resolves.toEqual(["rooftop bee lease"]);
  });
});
