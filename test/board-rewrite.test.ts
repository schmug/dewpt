import { describe, expect, it } from "vitest";
import { hasArrived, scoreCandidates, selectChild } from "../src/board/rewrite";
import { ARRIVAL_COSINE } from "../src/board/types";
import { DEGENERATE_POLE_COSINE } from "../src/types";

/** Unit vector in 3-space, so the projections below are hand-checkable. */
function unit(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

/** Unit vector `deg` degrees of travel from PARENT, rotated `offAim` degrees
 *  out of the PARENT→PHRASE plane, so travel is a single readable number. */
function along(deg: number, offAim = 0): number[] {
  const r = (deg * Math.PI) / 180;
  const p = (offAim * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r) * Math.cos(p), Math.sin(r) * Math.sin(p)];
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

  it("gives a candidate identical to the parent a zero score and a full tether", () => {
    // The phrase is deliberately NOT orthogonal to the parent here. Against an
    // orthogonal phrase this case is vacuous: cosine(PARENT, PHRASE) is 0
    // anyway, so an implementation that ignored displacement entirely and
    // scored the candidate straight against the phrase would also return 0 and
    // the test would prove nothing. At 45° that wrong implementation returns
    // 0.707 and one returning the tether returns 1; only zero displacement
    // gives 0.
    const nearPhrase = unit([1, 1, 0]);
    const [stuck] = scoreCandidates(PARENT, nearPhrase, [{ text: "stuck", embedding: PARENT }]);
    expect(stuck!.score).toBe(0);
    expect(stuck!.tether).toBe(1);
  });

  it("scores further travel higher, for unit-normalized embeddings", () => {
    // Pins the assumption the score comment documents. On the unit sphere the
    // score is monotone in travel — a candidate cannot win by moving less.
    // Nothing in the repo normalizes or asserts embedding magnitude and no doc
    // records the assumption, so this is the only place it is checked rather
    // than assumed. Off the sphere it does not hold: see the score comment.
    const scored = scoreCandidates(
      PARENT,
      PHRASE,
      [5, 10, 30, 60, 80].map((d) => ({ text: `${d}deg`, embedding: along(d) })),
    );
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i]!.score).toBeGreaterThan(scored[i - 1]!.score);
      // ...and the tether falls as the score rises: the two really do pull in
      // opposite directions, which is why the floor is separate from the score.
      expect(scored[i]!.tether).toBeLessThan(scored[i - 1]!.tether);
    }
    expect(scored[0]!.score).toBeCloseTo(0.7373, 4);
    expect(scored[4]!.score).toBeCloseTo(0.9962, 4);
  });

  it("stays monotone in travel even for a badly aimed move", () => {
    // The comment claims monotonicity for every off-aim angle, not just for
    // candidates travelling straight down the station direction. 40° off-aim
    // scores worse throughout, but still rewards travelling further.
    const scored = scoreCandidates(
      PARENT,
      PHRASE,
      [5, 10, 30, 60, 80].map((d) => ({ text: `${d}deg`, embedding: along(d, 40) })),
    );
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i]!.score).toBeGreaterThan(scored[i - 1]!.score);
    }
    // ...and being off-aim genuinely costs score at equal travel.
    const aimed = scoreCandidates(PARENT, PHRASE, [{ text: "aimed", embedding: along(30) }]);
    expect(scored[2]!.score).toBeLessThan(aimed[0]!.score);
  });

  it("throws rather than truncating when a candidate's embedding has a different width", () => {
    expect(() =>
      scoreCandidates([1, 0, 0, 0], [0, 1, 0, 0], [{ text: "short", embedding: [1, 0, 0] }]),
    ).toThrow(/dimension/i);
  });

  it("throws when the parent and station phrase embeddings disagree in width", () => {
    expect(() => scoreCandidates([1, 0, 0, 0], PHRASE, [])).toThrow(/dimension/i);
  });
});

describe("selectChild", () => {
  // Ordered so that the winner is neither first nor last: a "return the first
  // qualifying candidate" implementation returns `timid`, a "return the last"
  // one returns `oblique`, and only an argmax returns `halfway`.
  const candidates = [
    { text: "timid", embedding: unit([3, 1, 0]) },    // score .811, tether .949
    { text: "untethered", embedding: PHRASE },        // score 1.00, tether .000
    { text: "halfway", embedding: unit([1, 1, 0]) },  // score .924, tether .707
    { text: "oblique", embedding: unit([2, 1, 1]) },  // score .691, tether .816
  ];

  it("picks the highest-scoring candidate that clears the tether floor", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.5 });
    expect(picked?.text).toBe("halfway");
  });

  it("picks the best of several qualifying candidates even when it is last", () => {
    const ordered = [
      { text: "oblique", embedding: unit([2, 1, 1]) },  // score .691
      { text: "timid", embedding: unit([3, 1, 0]) },    // score .811
      { text: "halfway", embedding: unit([1, 1, 0]) },  // score .924
    ];
    const picked = selectChild(PARENT, PHRASE, ordered, { tetherFloor: 0.5 });
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

  it("rejects a candidate with a non-finite embedding instead of admitting it", () => {
    // `NaN < floor` is false, so a naive floor check ADMITS a NaN tether: the
    // guard reads as satisfied and the quality floor becomes a no-op.
    const picked = selectChild(PARENT, PHRASE, [{ text: "nan", embedding: [NaN, 1, 0] }], {
      tetherFloor: 0.5,
    });
    expect(picked).toBeNull();
  });

  it("never lets a non-finite score win, even from the front of the list", () => {
    // An argmax seeded with candidate 0 takes the NaN unconditionally and is
    // then undisplaceable, silently discarding every valid candidate after it.
    const picked = selectChild(PARENT, PHRASE, [{ text: "nan", embedding: [NaN, 1, 0] }, ...candidates], {
      tetherFloor: 0.5,
    });
    expect(picked?.text).toBe("halfway");
  });

  it("fails closed when an excluded embedding is non-finite", () => {
    // A NaN similarity cannot show the candidate is distinct from the history,
    // and `NaN > dedupe` is false — so a naive check readmits it.
    const picked = selectChild(PARENT, PHRASE, [{ text: "halfway", embedding: unit([1, 1, 0]) }], {
      tetherFloor: 0.5,
      exclude: [[NaN, 0, 0]],
    });
    expect(picked).toBeNull();
  });

  it("throws when an excluded embedding has a different width", () => {
    expect(() =>
      selectChild(PARENT, PHRASE, [{ text: "halfway", embedding: unit([1, 1, 0]) }], {
        tetherFloor: 0.5,
        exclude: [[1, 0, 0, 0]],
      }),
    ).toThrow(/dimension/i);
  });
});

describe("hasArrived", () => {
  it("is true when the parent has effectively reached the station phrase", () => {
    expect(hasArrived(PHRASE, PHRASE, 0.9)).toBe(true);
  });

  it("is false while there is still distance to travel", () => {
    expect(hasArrived(PARENT, PHRASE, 0.9)).toBe(false);
  });

  it("counts a card exactly at the threshold as arrived — the boundary is inclusive", () => {
    // cosine([3,4,0], [1,0,0]) is 3/5, which is exactly the double 0.6, so this
    // sits ON the threshold with no floating-point slack. ARRIVAL_COSINE is
    // slated for recalibration, which is when a `>`/`>=` slip starts to bite.
    expect(hasArrived([3, 4, 0], PARENT, 0.6)).toBe(true);
  });

  it("is false a hair below the threshold", () => {
    expect(hasArrived([3, 4, 0], PARENT, 0.6000001)).toBe(false);
  });

  it("throws rather than truncating when the two embeddings disagree in width", () => {
    expect(() => hasArrived([1, 0, 0, 0], PHRASE, 0.9)).toThrow(/dimension/i);
  });
});

describe("board constants", () => {
  it("keeps ARRIVAL_COSINE distinct from DEGENERATE_POLE_COSINE", () => {
    // src/board/types.ts documents at length that these must not be the same
    // number — DEGENERATE_POLE_COSINE was tuned pole-against-pole and does not
    // transfer to card-against-phrase. Nothing else enforces it.
    expect(ARRIVAL_COSINE).not.toBe(DEGENERATE_POLE_COSINE);
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
