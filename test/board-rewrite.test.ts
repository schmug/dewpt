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
    // Nothing on the production embedding path normalizes or asserts magnitude
    // and no doc records the assumption, so this is the only place it is
    // checked rather than assumed. Off the sphere it does not hold: see the
    // score comment.
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

  it("is NOT monotone in travel once the phrase is not orthogonal to the parent", () => {
    // The two tests above both put the phrase 90° from the parent — the one
    // pole angle at which monotonicity survives, and the reason four earlier
    // versions of the score comment claimed it in general. Move the phrase to
    // 45° and a candidate that travelled 60° scores BELOW one that travelled
    // 40°, at tether 0.500: inside the 0.5 floor, not safely beyond it. The
    // score peaks when the candidate reaches the phrase and falls away past it.
    // This test exists so "higher score means further" cannot be reasserted.
    const scored = scoreCandidates(
      PARENT,
      along(45),
      [40, 45, 60].map((d) => ({ text: `${d}deg`, embedding: along(d) })),
    );
    expect(scored[1]!.score).toBeCloseTo(1, 6);
    expect(scored[2]!.score).toBeLessThan(scored[0]!.score);
    expect(scored[2]!.tether).toBeCloseTo(0.5, 6);
  });

  it("lets a barely-moved candidate outscore a real traveller off the unit sphere", () => {
    // `parent + 0.001·(phrase − parent)` sits just off the sphere at magnitude
    // ≈0.999 and scores a perfect 1.0 for travelling a thousandth of the way,
    // beating a genuine 60° traveller at 0.9659. Monotonicity in travel is a
    // property of the formula PLUS unit-normalized inputs; nothing in this repo
    // normalizes or asserts embedding magnitude, so this is where that
    // assumption is checked rather than assumed.
    const crawler = PARENT.map((p, i) => p + 0.001 * (PHRASE[i]! - p));
    const scored = scoreCandidates(PARENT, PHRASE, [
      { text: "crawler", embedding: crawler },
      { text: "traveller", embedding: along(60) },
    ]);
    expect(scored[0]!.score).toBeCloseTo(1, 6);
    expect(scored[1]!.score).toBeCloseTo(0.9659, 4);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
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

  it("picks the candidate AT the phrase, not the one that travelled furthest", () => {
    // Companion to the non-monotonicity test above, at the level that matters:
    // what selectChild actually returns. With the phrase 45° from the parent
    // all three clear a 0.5 floor, and the furthest traveller does not win —
    // 60° scores 0.9914, exactly what 30° scores, while 45°, sitting on the
    // phrase, takes it at 1.0. What this maximises is alignment; distance only
    // tracks it when the parent and phrase happen to be orthogonal.
    const picked = selectChild(
      PARENT,
      along(45),
      [30, 45, 60].map((d) => ({ text: `${d}deg`, embedding: along(d) })),
      { tetherFloor: 0.5 },
    );
    expect(picked?.text).toBe("45deg");
  });

  it("rejects a NaN tether that arrives with a finite, near-maximal score", () => {
    // REMOVING `Number.isFinite(c.tether)` FROM selectChild MUST TURN THIS RED.
    // The -Infinity argmax seed does not subsume that guard: the seed only
    // stops a non-finite SCORE from winning. Here the score is finite and
    // nearly 1, because the huge shared first component cancels in both
    // displacements and the cosine is then computed on small, well-conditioned
    // differences — while the tether takes the raw vectors, whose norms
    // overflow to Infinity, giving Infinity/Infinity = NaN. `NaN < floor` is
    // false, so without the guard the floor admits it and a NaN-tethered
    // candidate is returned as the winner.
    const parent = [1e200, 1, 0];
    const phrase = [1e200, 0, 1];
    const candidates = [{ text: "overflow", embedding: [1e200, 0, 1] }];
    const [scored] = scoreCandidates(parent, phrase, candidates);
    expect(Number.isFinite(scored!.score)).toBe(true);
    expect(scored!.score).toBeGreaterThan(0.99);
    expect(Number.isNaN(scored!.tether)).toBe(true);
    expect(selectChild(parent, phrase, candidates, { tetherFloor: 0.5 })).toBeNull();
  });

  it("returns null when a non-finite station phrase poisons every score", () => {
    // The mirror shape — non-finite score, finite tether clearing the floor —
    // exists as an INPUT: a NaN in the phrase embedding makes every score NaN
    // while the tether stays clean at 0.914. It is NOT a test of the
    // `Number.isFinite(c.score)` guard and does not claim to be: a NaN score
    // already loses `c.score > -Infinity`, so this returns null with or without
    // that half of the guard. No input makes that half load-bearing, because a
    // non-finite cosine can only be NaN or -Infinity — Cauchy-Schwarz keeps the
    // ratio finite whenever both norms are — and neither beats the seed. This
    // pins the behaviour, not the guard.
    const picked = selectChild(PARENT, [NaN, 1, 0], [{ text: "clean", embedding: unit([9, 4, 0]) }], {
      tetherFloor: 0.5,
    });
    expect(picked).toBeNull();
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

import { fakeAiRunner } from "../src/dev-fake-ai";
import { expandPole, parsePolePhrase } from "../src/generation";

describe("fakeAiRunner — board support", () => {
  it("returns rewrites of the fragment, not field words", async () => {
    const ai = fakeAiRunner();
    const out = await generateRewrites(ai, "m", {
      fragment: "tool libraries",
      target: "a surreal, dreamlike version",
      count: 4,
      exclude: [],
    });
    expect(out).toHaveLength(4);
    for (const item of out) expect(item).toContain("tool libraries");
    expect(out).not.toContain("phishing drill");
  });

  it("returns distinct rewrites across successive hops so dedupe has work to do", async () => {
    const ai = fakeAiRunner();
    const inputs = { fragment: "vacant lot", target: "a physical object you can touch", count: 3, exclude: [] };
    const first = await generateRewrites(ai, "m", inputs);
    const second = await generateRewrites(ai, "m", inputs);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it("expands a pole to a phrase instead of silently degrading", async () => {
    const pole = await expandPole(fakeAiRunner(), "m", "make strange");
    expect(pole.expanded).toBe(true);
    expect(pole.phrase).not.toBe("make strange");
    expect(pole.phrase.split(" ").length).toBeGreaterThanOrEqual(4);
  });

  // The fake's phrase is embedded and used as an axis pole exactly as the real
  // model's is, so it has to honour POLE_SYSTEM_PROMPT's contract rather than
  // merely survive parsePolePhrase. A long user term must not push it past the
  // 8-word ceiling.
  it("keeps the expanded phrase inside the pole contract for a long term", async () => {
    const pole = await expandPole(fakeAiRunner(), "m", "somewhere between dread and delight now");
    expect(pole.expanded).toBe(true);
    expect(parsePolePhrase(JSON.stringify({ phrase: pole.phrase }))).toBe(pole.phrase);
    expect(pole.phrase).toMatch(/^(a|an|something) /);
    const words = pole.phrase.split(" ").length;
    expect(words).toBeGreaterThanOrEqual(4);
    expect(words).toBeLessThanOrEqual(8);
  });

  // The whole defect is a request shape the fake does not recognise being
  // answered with field words instead of an error. Fixing pole expansion and
  // rewrites without closing the fall-through would leave the mechanism in
  // place for the next caller.
  it("rejects an unrecognised request shape rather than answering with field words", async () => {
    const ai = fakeAiRunner();
    await expect(
      ai.run("m", {
        messages: [{ role: "user", content: `${JSON.stringify({ mood: "blue" })}\nReturn a JSON array.` }],
      }),
    ).rejects.toThrow(/unrecognised request/i);
  });

  // A five-word fragment is in register for the board's own prompt, but
  // generateRewrites runs the fake's output through cleanList, which drops
  // anything over five words. A space-separated marker would push every child
  // to six and the lineage would starve on an empty list.
  it("keeps a five-word parent's rewrites inside the fragment register", async () => {
    const out = await generateRewrites(fakeAiRunner(), "m", {
      fragment: "a lot behind the church",
      target: "a mystical or magical practice",
      count: 3,
      exclude: [],
    });
    expect(out).toHaveLength(3);
    for (const item of out) expect(item).toContain("a lot behind the church");
    expect(new Set(out).size).toBe(3);
  });

  it("still serves the field's bucketed pools unchanged", async () => {
    const ai = fakeAiRunner();
    const result = (await ai.run("m", {
      messages: [{ role: "user", content: `${JSON.stringify({ seed: "x", strangeness: 0.2, altitude: 0.2, count: 2 })}\nReturn a JSON array.` }],
    })) as { response: string };
    expect(JSON.parse(result.response)).toEqual(["phishing drill", "password day"]);
  });
});

/** A fragment of exactly `chars` characters in exactly `words` words, so the
 *  ceilings below are hit exactly rather than approximately. */
function fragmentOf(chars: number, words: number): string {
  const letters = chars - (words - 1);
  const base = Math.floor(letters / words);
  const extra = letters % words;
  return Array.from({ length: words }, (_, i) => "x".repeat(base + (i < extra ? 1 : 0))).join(" ");
}

/** The parent-derived part of a child: everything before the trailing marker,
 *  whether the marker was joined with a space or a hyphen. */
function stemOf(child: string): string {
  return child.replace(/[ -]\d+$/, "");
}

// generation.ts's `cleanList` enforces TWO ceilings — five words AND 64
// characters — and drops a violating item in full rather than trimming it. The
// hyphenated marker closes only the word half. The character half is reachable,
// not theoretical: index.ts caps typed text at that same 64, so a 62-64
// character card is admissible everywhere text enters the system. It is also
// the worse failure of the two, because it arrives mid-lineage — the marker
// grows a digit at the tenth child, so a 62-character parent hops three times
// and then returns nothing at all, for no visible reason.
describe("fakeAiRunner — rewrites stay inside both of cleanList's ceilings", () => {
  const CASES: { chars: number; words: number; first: (f: string) => string; keepsWholeParent: boolean }[] = [
    // 61 + " 1" = 63 characters in two words: the spaced marker still fits, and
    // has to keep fitting. A fix that hyphenates or truncates unconditionally
    // fails here rather than passing quietly.
    { chars: 61, words: 1, first: (f) => `${f} 1`, keepsWholeParent: true },
    // 62 + " 1" = 64: the longest parent the spaced marker fits behind.
    { chars: 62, words: 1, first: (f) => `${f} 1`, keepsWholeParent: true },
    // 63 + " 1" = 65, and 63 + "-1" = 65 too — hyphenating is not enough, the
    // parent itself has to give up a character.
    { chars: 63, words: 1, first: (f) => `${f.slice(0, 62)}-1`, keepsWholeParent: false },
    { chars: 64, words: 1, first: (f) => `${f.slice(0, 62)}-1`, keepsWholeParent: false },
    // Over both ceilings at once: five words and the full 64 characters.
    { chars: 64, words: 5, first: (f) => `${f.slice(0, 62)}-1`, keepsWholeParent: false },
    // Only the word ceiling bites. Hyphenation removes one space, so six words
    // stay six words; the sixth word is what has to go.
    { chars: 46, words: 6, first: (f) => `${f.split(" ").slice(0, 5).join(" ")}-1`, keepsWholeParent: false },
  ];

  for (const { chars, words, first, keepsWholeParent } of CASES) {
    it(`returns every rewrite asked for, for a ${chars}-character ${words}-word fragment`, async () => {
      const fragment = fragmentOf(chars, words);
      expect(fragment).toHaveLength(chars);
      expect(fragment.split(" ")).toHaveLength(words);

      const out = await generateRewrites(fakeAiRunner(), "m", {
        fragment,
        target: "a mystical or magical practice",
        count: 5,
        exclude: [],
      });

      expect(out).toHaveLength(5);
      expect(new Set(out).size).toBe(5);
      expect(out[0]).toBe(first(fragment));
      for (const item of out) {
        expect(item.length, item).toBeLessThanOrEqual(64);
        expect(item.split(" ").length, item).toBeLessThanOrEqual(5);
        // The parent stays recognisable: every child opens with a leading
        // prefix of it — the whole parent wherever both ceilings allow one.
        expect(fragment.startsWith(stemOf(item)), item).toBe(true);
        if (keepsWholeParent) expect(item).toContain(fragment);
      }
    });
  }

  // The mid-lineage case, which is what makes the character ceiling a silent
  // fault rather than a loud one: children 1-9 fit and children 10+ do not, so
  // the belt stalls partway through a chain that started fine.
  it("keeps serving a 62-character parent once the marker reaches two digits", async () => {
    const ai = fakeAiRunner();
    const fragment = fragmentOf(62, 5);
    const inputs = { fragment, target: "a mystical or magical practice", count: 3, exclude: [] };
    const hops: string[][] = [];
    for (let hop = 0; hop < 5; hop++) hops.push(await generateRewrites(ai, "m", inputs));

    hops.forEach((hop, i) => expect(hop, `hop ${i + 1}`).toHaveLength(3));
    const all = hops.flat();
    expect(new Set(all).size).toBe(15);
    // Children 10-15 are the ones the old three-character marker could not fit.
    expect(all.filter((t) => /-1\d$/.test(t))).toHaveLength(6);
    for (const item of all) {
      expect(item.length, item).toBeLessThanOrEqual(64);
      expect(item.split(" ").length, item).toBeLessThanOrEqual(5);
      expect(fragment.startsWith(stemOf(item)), item).toBe(true);
    }
  });
});

/** dev-fake-ai's POOLS, restated rather than imported: the demo's pre-baked
 *  pools are a fixture other work reads, and a test that imported the thing
 *  under test could not fail when it changed. */
const FIELD_POOLS: Record<string, string[]> = {
  w0a0: ["phishing drill", "password day", "poster contest", "lunch-and-learn", "badge stickers", "monthly newsletter", "quiz with prizes", "report button", "welcome-back training", "door-lock checks"],
  w0a1: ["habit", "repetition", "trust", "reminders", "routine", "vigilance", "compliance", "muscle memory", "recognition", "baseline"],
  w1a0: ["hallway escape room", "security mascot", "phishing bingo", "staff CTF night", "spot-the-fake wall", "incident tabletop game", "security fortune cookies", "fake-invoice bake-off", "lanyard trading cards", "two-minute mystery emails"],
  w1a1: ["play", "curiosity", "friendly rivalry", "storytelling", "folklore", "street smarts", "rituals", "bragging rights", "shared vocabulary", "near-miss stories"],
  w2a0: ["haunted inbox exhibit", "phish sommelier tasting", "threat-model tarot deck", "cafeteria con-artist theater", "lock-picking petting zoo", "malware aquarium", "ransomware campfire stories", "gossip-powered honeypot", "social-engineering improv night", "breach museum field trip"],
  w2a1: ["immune system", "superstition", "herd instinct", "antibodies", "myth-making", "communal grooming", "tribal memory", "dread as teacher", "apprenticeship of doubt", "folk immunity"],
};

/** One field-generation request. The runner defaults to a fresh one so each
 *  case starts at cursor 0 and independent cases can be awaited concurrently
 *  without sharing a counter. */
async function fieldWords(strangeness: number, altitude: number, count: number, ai = fakeAiRunner()): Promise<string[]> {
  const result = (await ai.run("m", {
    messages: [{ role: "user", content: `${JSON.stringify({ seed: "x", strangeness, altitude, count })}\nReturn a JSON array.` }],
  })) as { response: string };
  return JSON.parse(result.response) as string[];
}

// The single check above — bucket w0a0, count 2, cursor 0 — is the whole of the
// committed defence of a fixture that is supposed to be byte-identical forever.
// It would miss a tier-boundary flip, the altitude boundary, the wrap suffix,
// and five of the six pools. These generalise it on every one of those axes.
describe("fakeAiRunner — field generation is a frozen fixture", () => {
  it("serves each of the six buckets from its own pool, in order", async () => {
    const cases = [
      { strangeness: 0.0, altitude: 0.0, bucket: "w0a0" },
      { strangeness: 0.0, altitude: 1.0, bucket: "w0a1" },
      { strangeness: 0.5, altitude: 0.0, bucket: "w1a0" },
      { strangeness: 0.5, altitude: 1.0, bucket: "w1a1" },
      { strangeness: 1.0, altitude: 0.0, bucket: "w2a0" },
      { strangeness: 1.0, altitude: 1.0, bucket: "w2a1" },
    ];
    const got = await Promise.all(cases.map((c) => fieldWords(c.strangeness, c.altitude, 10)));
    cases.forEach((c, i) => expect(got[i], c.bucket).toEqual(FIELD_POOLS[c.bucket]));
  });

  // `strangeness < 0.33 ? 0 : strangeness <= 0.66 ? 1 : 2` — exclusive below,
  // inclusive above, so both boundary values belong to tier 1.
  it("flips tier at 0.33 and 0.66, with both boundaries in the middle tier", async () => {
    const cases = [
      { strangeness: 0.3299999, bucket: "w0a0" },
      { strangeness: 0.33, bucket: "w1a0" },
      { strangeness: 0.66, bucket: "w1a0" },
      { strangeness: 0.6600001, bucket: "w2a0" },
    ];
    const got = await Promise.all(cases.map((c) => fieldWords(c.strangeness, 0, 3)));
    cases.forEach((c, i) => expect(got[i], `strangeness ${c.strangeness}`).toEqual(FIELD_POOLS[c.bucket].slice(0, 3)));
  });

  // `altitude >= 0.5 ? 1 : 0` — 0.5 itself is the abstract half.
  it("flips altitude at 0.5, inclusive", async () => {
    const [below, at] = await Promise.all([fieldWords(0, 0.4999999, 3), fieldWords(0, 0.5, 3)]);
    expect(below).toEqual(FIELD_POOLS.w0a0.slice(0, 3));
    expect(at).toEqual(FIELD_POOLS.w0a1.slice(0, 3));
  });

  it("wraps a ten-word pool with a numeric generation suffix", async () => {
    const base = FIELD_POOLS.w1a0;
    expect(await fieldWords(0.5, 0.2, 25)).toEqual([
      ...base,
      ...base.map((w) => `${w} 2`),
      ...base.slice(0, 5).map((w) => `${w} 3`),
    ]);
  });

  it("advances the bucket cursor across calls rather than restarting at zero", async () => {
    const ai = fakeAiRunner();
    const base = FIELD_POOLS.w2a1;
    expect(await fieldWords(0.9, 0.9, 6, ai)).toEqual(base.slice(0, 6));
    expect(await fieldWords(0.9, 0.9, 6, ai)).toEqual([
      ...base.slice(6),
      ...base.slice(0, 2).map((w) => `${w} 2`),
    ]);
  });
});
