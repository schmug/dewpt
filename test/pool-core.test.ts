import { describe, expect, it } from "vitest";
import { PoolCore, cosineSim } from "../src/pool-core";
import {
  BUCKET_KEYS,
  DEFAULT_PARAMS,
  EVAPORATED_CAP,
  EXCLUDE_CAP,
  FRESH_TARGET,
  GEN_BATCH,
  TARGET_DEPTH,
  type BucketKey,
} from "../src/types";

/** Unit vector along axis i in a `dim`-dimensional space — orthogonal to every other axis. */
function axisEmb(i: number, dim = 8): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = 1;
  return v;
}

/** Distinct orthogonal embeddings for n words. Pass startAxis to keep words
 *  from separate calls orthogonal to each other too. */
function entries(texts: string[], startAxis = 0): { text: string; embedding: number[] }[] {
  const dim = Math.max(16, startAxis + texts.length);
  return texts.map((text, i) => ({ text, embedding: axisEmb(startAxis + i, dim) }));
}

function texts(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
}

describe("cosineSim", () => {
  it("is 1 for identical vectors, 0 for orthogonal", () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe("bucketing", () => {
  it("serves candidates only from the bucket they were added to", () => {
    const core = new PoolCore();
    core.addCandidates("w1a0", entries(["phishing bingo"]), 1000);
    expect(core.draw("w0a0", 5, 2000)).toEqual([]);
    const served = core.draw("w1a0", 5, 2000);
    expect(served.map((s) => s.text)).toEqual(["phishing bingo"]);
  });

  it("stamps served words with tier and alt parsed from the bucket key", () => {
    const core = new PoolCore();
    core.addCandidates("w2a1", entries(["folk immunity"]), 1000);
    const [served] = core.draw("w2a1", 1, 2000);
    expect(served.tier).toBe(2);
    expect(served.alt).toBe(1);
  });

  it("reports per-bucket depths", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a", "b", "c"]), 1000);
    core.addCandidates("w2a1", entries(["d"], 3), 1000);
    const depths = core.depths();
    expect(depths.w0a0.total).toBe(3);
    expect(depths.w2a1.total).toBe(1);
    expect(depths.w1a0.total).toBe(0);
  });
});

describe("draw", () => {
  it("removes served candidates from the pool", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a", "b"]), 1000);
    core.draw("w0a0", 2, 2000);
    expect(core.depths().w0a0.total).toBe(0);
    expect(core.draw("w0a0", 2, 3000)).toEqual([]);
  });

  it("returns at most count candidates and never throws on an empty bucket", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a", "b", "c"]), 1000);
    expect(core.draw("w0a0", 2, 2000)).toHaveLength(2);
    expect(core.draw("w1a1", 4, 2000)).toEqual([]);
  });

  it("serves fresh (post-invalidation) candidates before stale ones", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["stale one", "stale two"]), 1000);
    // Per-bucket invalidation (issue #3) only stamps hot buckets, so invalidate
    // w0a0 by making it hot: low dewpoint + altitude make the concrete/common
    // bucket the hottest. (A high-dewpoint change would make w0a0 cold, leaving
    // its candidates fresh — the deliberate new behavior.)
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 2000);
    core.addCandidates("w0a0", entries(["fresh one"]).map((e) => ({ ...e, embedding: axisEmb(5) })), 3000);
    const served = core.draw("w0a0", 1, 4000);
    expect(served[0]!.text).toBe("fresh one");
  });

  it("keeps serving stale candidates after invalidation (old pool never stalls)", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["stale one"]), 1000);
    // Make w0a0 hot so its candidate is genuinely stale under per-bucket
    // invalidation, then confirm draw still serves it (never-stall).
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 2000);
    expect(core.depths().w0a0.fresh).toBe(0); // stamped stale, but still pooled
    const served = core.draw("w0a0", 3, 3000);
    expect(served.map((s) => s.text)).toEqual(["stale one"]);
  });
});

describe("dedupe", () => {
  it("rejects a candidate whose embedding cosine vs an existing pool entry exceeds 0.92", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", [{ text: "phishing drill", embedding: [1, 0, 0] }], 1000);
    const res = core.addCandidates(
      "w0a0",
      [
        { text: "phish drills", embedding: [0.99, 0.141, 0] }, // cos ≈ 0.99
        { text: "poster contest", embedding: [0.9, 0.436, 0] }, // cos = 0.9 — kept
      ],
      2000,
    );
    expect(res.added).toEqual(["poster contest"]);
    expect(core.depths().w0a0.total).toBe(2);
  });

  it("rejects a candidate too close to a pinned anchor's embedding", () => {
    const core = new PoolCore();
    core.pin("security mascot", 1, 1000);
    core.setAnchorEmbedding("security mascot", [0, 1, 0]);
    const res = core.addCandidates("w1a0", [{ text: "the mascot of security", embedding: [0.05, 0.999, 0] }], 2000);
    expect(res.added).toEqual([]);
  });

  it("rejects exact text duplicates case- and whitespace-insensitively", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", [{ text: "Password Day", embedding: [1, 0] }], 1000);
    const res = core.addCandidates("w0a0", [{ text: "  password   day ", embedding: [0, 1] }], 2000);
    expect(res.added).toEqual([]);
  });

  it("rejects candidates whose text was recently served (exclude LRU)", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["habit"]), 1000);
    core.draw("w0a0", 1, 2000);
    const res = core.addCandidates("w0a0", [{ text: "habit", embedding: axisEmb(7) }], 3000);
    expect(res.added).toEqual([]);
  });
});

describe("exclude LRU", () => {
  it(`caps at ${EXCLUDE_CAP} and evicts the oldest served text`, () => {
    const core = new PoolCore();
    const all = texts("word", EXCLUDE_CAP + 1);
    // serve "word 0" alone so it is deterministically the oldest LRU entry,
    // then the rest in batches small enough to stay under the depth cap
    core.addCandidates("w0a0", entries(all.slice(0, 1)), 500);
    core.draw("w0a0", 1, 600);
    const BATCH = 50; // 6 × 50 = the remaining 300
    for (let i = 1; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      core.addCandidates("w0a0", entries(batch, i), 1000 + i);
      core.draw("w0a0", batch.length, 2000 + i);
    }
    expect(core.excludeSize()).toBe(EXCLUDE_CAP);
    // the first-served word fell out of the LRU, so it may be pooled again
    const res = core.addCandidates("w0a0", [{ text: "word 0", embedding: axisEmb(350, 400) }], 5000);
    expect(res.added).toEqual(["word 0"]);
    // the second-served word is still excluded
    const res2 = core.addCandidates("w0a0", [{ text: "word 1", embedding: axisEmb(351, 400) }], 5000);
    expect(res2.added).toEqual([]);
  });

  it("includes recent serves and anchors in the prompt exclusion list, most recent first", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["alpha"]), 1000);
    core.draw("w0a0", 1, 2000);
    core.addCandidates("w0a0", entries(["beta"], 1), 2500);
    core.draw("w0a0", 1, 3000);
    core.pin("gamma", 2, 4000);
    const excl = core.excludeForPrompt(10);
    expect(excl).toContain("alpha");
    expect(excl).toContain("beta");
    expect(excl).toContain("gamma");
    expect(excl.indexOf("beta")).toBeLessThan(excl.indexOf("alpha"));
  });

  it("honors the excludeForPrompt limit", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(texts("w", 30)), 1000);
    core.draw("w0a0", 30, 2000);
    expect(core.excludeForPrompt(5)).toHaveLength(5);
  });
});

describe("invalidation", () => {
  it("a slider change stamps the buckets it makes hot stale, leaving now-cold buckets fresh", () => {
    // Per-bucket invalidation (issue #3): raising altitude to 0.8 makes the
    // abstract bucket w0a1 hot and the concrete bucket w0a0 cold. Only the hot
    // bucket is stamped stale (fresh -> 0, total kept). The cold bucket keeps
    // serving fresh candidates and refreshes lazily if a later move warms it up.
    // (Previously a single global stamp zeroed *every* bucket's fresh depth.)
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a", "b"]), 1000);
    core.addCandidates("w0a1", entries(["c", "d"], 2), 1000);
    expect(core.depths().w0a0.fresh).toBe(2);
    expect(core.depths().w0a1.fresh).toBe(2);
    core.setParams({ altitude: 0.8 }, 2000);
    expect(core.depths().w0a1.fresh).toBe(0); // warmed -> stale (will regenerate)
    expect(core.depths().w0a1.total).toBe(2); // nothing dropped (lazy)
    expect(core.depths().w0a0.fresh).toBe(2); // cooled -> deferred, still fresh
    expect(core.depths().w0a0.total).toBe(2);
  });

  it("drizzle-only changes do not invalidate (spawn rate has no generation effect)", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a"]), 1000);
    core.setParams({ drizzle: 0.9 }, 2000);
    expect(core.depths().w0a0.fresh).toBe(1);
  });

  it("pinning invalidates (anchors bias all future generation)", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a"]), 1000);
    core.pin("rituals", 1, 2000);
    expect(core.depths().w0a0.fresh).toBe(0);
  });

  it("unpinning invalidates too", () => {
    const core = new PoolCore();
    core.pin("rituals", 1, 1000);
    core.addCandidates("w0a0", entries(["a"]), 2000);
    core.unpin("rituals", 3000);
    expect(core.depths().w0a0.fresh).toBe(0);
  });

  it("clamps params to [0,1] and returns the merged result", () => {
    const core = new PoolCore();
    const params = core.setParams({ dewpoint: 1.7, drizzle: -2 }, 1000);
    expect(params.dewpoint).toBe(1);
    expect(params.drizzle).toBe(0);
    expect(params.altitude).toBe(DEFAULT_PARAMS.altitude);
  });
});

describe("pool overflow", () => {
  it(`evicts oldest stale candidates beyond ${TARGET_DEPTH}, keeping fresh ones`, () => {
    const core = new PoolCore();
    const old = texts("old", TARGET_DEPTH);
    core.addCandidates("w0a0", entries(old), 1000);
    // Per-bucket invalidation only stamps hot buckets, so drive w0a0 hot (low
    // dewpoint + altitude make the concrete/common bucket the hottest) to mark
    // its existing candidates stale before topping up with fresh ones.
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 2000);
    const fresh = texts("fresh", 10).map((text, i) => ({ text, embedding: axisEmb(TARGET_DEPTH + i, 128) }));
    core.addCandidates("w0a0", fresh, 3000);
    const depths = core.depths();
    expect(depths.w0a0.total).toBe(TARGET_DEPTH);
    expect(depths.w0a0.fresh).toBe(10);
  });
});

describe("genPlan", () => {
  it("targets the bucket the current params make hottest when everything is empty", () => {
    const core = new PoolCore();
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 1000);
    expect(core.genPlan(2000)?.bucket).toBe("w0a0");
    core.setParams({ dewpoint: 0.9, altitude: 0.1 }, 3000);
    expect(core.genPlan(4000)?.bucket).toBe("w2a0");
  });

  it("moves on to other buckets once the hottest is full and fresh", () => {
    const core = new PoolCore();
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 1000);
    core.addCandidates("w0a0", entries(texts("w", TARGET_DEPTH)), 2000);
    const plan = core.genPlan(3000);
    expect(plan).not.toBeNull();
    expect(plan!.bucket).not.toBe("w0a0");
  });

  it("returns null when every bucket is at target depth and fresh", () => {
    const core = new PoolCore();
    let axis = 0;
    for (const bucket of BUCKET_KEYS) {
      const batch = texts(bucket, TARGET_DEPTH).map((text) => ({ text, embedding: axisEmb(axis++, 512) }));
      core.addCandidates(bucket as BucketKey, batch, 1000);
    }
    expect(core.genPlan(2000)).toBeNull();
  });

  it("asks for at most one generation batch", () => {
    const core = new PoolCore();
    const plan = core.genPlan(1000);
    expect(plan!.need).toBeGreaterThan(0);
    expect(plan!.need).toBeLessThanOrEqual(GEN_BATCH);
  });

  it("wants fresh candidates for a hot bucket after invalidation even at full depth", () => {
    const core = new PoolCore();
    core.setParams({ dewpoint: 0.1, altitude: 0.1 }, 1000);
    core.addCandidates("w0a0", entries(texts("w", TARGET_DEPTH)), 2000);
    core.pin("rituals", 1, 3000); // invalidates; depth still full
    const plan = core.genPlan(4000);
    expect(plan).not.toBeNull();
    // FRESH_TARGET fresh candidates satisfy a full-depth stale bucket
    expect(plan!.need).toBeLessThanOrEqual(FRESH_TARGET);
  });
});

describe("anchors", () => {
  it("pin records the anchor with its tier; unpin removes it", () => {
    const core = new PoolCore();
    core.pin("street smarts", 1, 1000);
    expect(core.anchors()).toEqual([
      expect.objectContaining({ text: "street smarts", tier: 1, pinnedAt: 1000 }),
    ]);
    core.unpin("street smarts", 2000);
    expect(core.anchors()).toEqual([]);
  });

  it("pinning a pooled word removes it from the pool", () => {
    const core = new PoolCore();
    core.addCandidates("w1a1", entries(["folklore"]), 1000);
    core.pin("folklore", 1, 2000);
    expect(core.depths().w1a1.total).toBe(0);
  });

  it("pin is idempotent per text", () => {
    const core = new PoolCore();
    core.pin("folklore", 1, 1000);
    core.pin("folklore", 1, 2000);
    expect(core.anchors()).toHaveLength(1);
  });
});

describe("addWord (user-injected words, issue #20)", () => {
  it("adds a word that never appeared in any bucket as an anchor", () => {
    const core = new PoolCore();
    const { anchors, added } = core.addWord("petrichor", 1, 1000);
    expect(added).toBe(true);
    expect(anchors).toEqual([expect.objectContaining({ text: "petrichor", tier: 1, pinnedAt: 1000 })]);
    // it steers generation: anchors feed the prompt exclusion/flavor list
    expect(core.excludeForPrompt(10)).toContain("petrichor");
  });

  it("invalidates the pool so fresh generation is queued (the word becomes a live anchor)", () => {
    const core = new PoolCore();
    core.addCandidates("w0a0", entries(["a", "b"]), 1000);
    expect(core.depths().w0a0.fresh).toBe(2);
    core.addWord("petrichor", 1, 2000);
    expect(core.depths().w0a0.fresh).toBe(0); // every bucket's candidates are now stale
    expect(core.genPlan(3000)).not.toBeNull(); // a regeneration pass is wanted
  });

  it("dedupes against an existing anchor without duplicating it or bumping its tier", () => {
    const core = new PoolCore();
    core.pin("petrichor", 2, 1000);
    const { anchors, added } = core.addWord("  PETRICHOR ", 0, 2000); // case/space-insensitive
    expect(added).toBe(false);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual(expect.objectContaining({ text: "petrichor", tier: 2, pinnedAt: 1000 }));
  });

  it("does not re-invalidate the pool on a duplicate add", () => {
    const core = new PoolCore();
    core.addWord("petrichor", 1, 1000);
    core.addCandidates("w0a0", entries(["fresh"]), 2000); // fresh: generated after the invalidation
    expect(core.depths().w0a0.fresh).toBe(1);
    core.addWord("petrichor", 1, 3000); // duplicate — must not re-stamp invalidatedAt
    expect(core.depths().w0a0.fresh).toBe(1);
  });

  it("pulls a pooled word out of the pool when the user adds its exact text", () => {
    const core = new PoolCore();
    core.addCandidates("w1a1", entries(["folklore"]), 1000);
    const { added } = core.addWord("folklore", 1, 2000);
    expect(added).toBe(true);
    expect(core.depths().w1a1.total).toBe(0); // no longer both anchor and candidate
  });

  it("pulls the word out of the evaporated ring when it is added", () => {
    const core = new PoolCore();
    core.evaporate("petrichor", 1, 1000);
    core.addWord("petrichor", 1, 2000);
    expect(core.evaporated()).toEqual([]);
  });

  it("ignores empty or whitespace-only text", () => {
    const core = new PoolCore();
    expect(core.addWord("   ", 1, 1000).added).toBe(false);
    expect(core.anchors()).toEqual([]);
  });

  it("survives a serialize/rehydrate round-trip (persists across resume)", () => {
    const a = new PoolCore();
    a.addWord("petrichor", 1, 1000);
    const b = new PoolCore(a.serialize());
    expect(b.anchors()).toEqual([expect.objectContaining({ text: "petrichor", tier: 1 })]);
  });
});

describe("evaporated ring buffer", () => {
  it("keeps the most recent first and caps at " + EVAPORATED_CAP, () => {
    const core = new PoolCore();
    for (let i = 0; i < EVAPORATED_CAP + 5; i++) core.evaporate(`word ${i}`, 0, 1000 + i);
    const ev = core.evaporated();
    expect(ev).toHaveLength(EVAPORATED_CAP);
    expect(ev[0]!.text).toBe(`word ${EVAPORATED_CAP + 4}`);
    // oldest five fell off
    expect(ev.some((e) => e.text === "word 0")).toBe(false);
  });

  it("re-evaporating a word moves it to the front without duplicating", () => {
    const core = new PoolCore();
    core.evaporate("mist", 0, 1000);
    core.evaporate("haze", 1, 2000);
    core.evaporate("mist", 0, 3000);
    const ev = core.evaporated();
    expect(ev.map((e) => e.text)).toEqual(["mist", "haze"]);
  });

  it("restore removes the word from the buffer and returns it", () => {
    const core = new PoolCore();
    core.evaporate("mist", 2, 1000);
    const { restored } = core.restore("mist");
    expect(restored).toEqual(expect.objectContaining({ text: "mist", tier: 2 }));
    expect(core.evaporated()).toEqual([]);
  });

  it("restore of an unknown word returns null", () => {
    const core = new PoolCore();
    expect(core.restore("nothing").restored).toBeNull();
  });

  it("never admits a pinned anchor (condensate and evaporated stay disjoint)", () => {
    const core = new PoolCore();
    core.pin("lock-picking petting zoo", 2, 1000);
    const ev = core.evaporate("lock-picking petting zoo", 2, 2000);
    expect(ev).toEqual([]);
  });

  it("pinning a word removes it from the evaporated buffer", () => {
    const core = new PoolCore();
    core.evaporate("street smarts", 1, 1000);
    core.pin("street smarts", 1, 2000);
    expect(core.evaporated()).toEqual([]);
  });
});

describe("seed distance scoring", () => {
  it("scores candidates by cosine distance from the seed embedding", () => {
    const core = new PoolCore();
    core.setSeedEmbedding([1, 0, 0]);
    core.addCandidates(
      "w0a0",
      [
        { text: "near", embedding: [1, 0, 0] },
        { text: "far", embedding: [0, 1, 0] },
      ],
      1000,
    );
    const served = core.draw("w0a0", 2, 2000);
    const near = served.find((s) => s.text === "near")!;
    const far = served.find((s) => s.text === "far")!;
    expect(near.seedDist).toBeCloseTo(0);
    expect(far.seedDist).toBeCloseTo(1);
  });
});

describe("persistence round-trip", () => {
  it("serialize/rehydrate preserves pool, anchors, exclude order, evaporated and invalidation stamps", () => {
    const a = new PoolCore();
    a.setSeedEmbedding([1, 0, 0]);
    a.setParams({ dewpoint: 0.7 }, 1000);
    // Per-bucket invalidation only stamps hot buckets, so keep the candidate in
    // w2a0 — the bucket a tier-2 pin at dewpoint 0.7 makes hottest — to prove
    // the per-bucket stamp survives a serialize/rehydrate round-trip.
    a.addCandidates("w2a0", entries(["kept word"]), 2000);
    a.addCandidates("w0a0", entries(["served word"], 1), 2000);
    a.draw("w0a0", 1, 3000);
    a.pin("anchor word", 2, 4000);
    a.evaporate("gone word", 1, 5000);

    const b = new PoolCore(a.serialize());
    expect(b.depths().w2a0.total).toBe(1);
    expect(b.depths().w2a0.fresh).toBe(0); // pin at t=4000 stamped hot w2a0, staling the t=2000 candidate
    expect(b.anchors()).toHaveLength(1);
    expect(b.evaporated().map((e) => e.text)).toEqual(["gone word"]);
    expect(b.excludeForPrompt(10)).toContain("served word");
    // still excluded: re-adding the served word is rejected
    expect(b.addCandidates("w0a0", [{ text: "served word", embedding: axisEmb(6) }], 6000).added).toEqual([]);
    expect(b.getParams().dewpoint).toBe(0.7);
  });
});

describe("per-bucket invalidation (issue #3)", () => {
  // Large enough that 6×TARGET_DEPTH fill axes plus every regeneration batch the
  // drain loop can emit stay distinct one-hot vectors (no axis-wrap collisions).
  const DIM = 1200;

  /** Fill helper yielding globally-distinct one-hot embeddings so nothing is
   *  ever rejected as a near-duplicate; a shared axis counter keeps candidates
   *  across buckets and across calls mutually orthogonal. */
  function makeFill() {
    let axis = 0;
    return (n: number, prefix = "c") =>
      Array.from({ length: n }, () => {
        const i = axis++;
        return { text: `${prefix} ${i}`, embedding: axisEmb(i, DIM) };
      });
  }

  /** Drive the alarm pump synchronously: repeatedly take the next plan and
   *  satisfy it with fresh candidates until nothing more is wanted. Returns the
   *  set of distinct buckets that were regenerated. */
  function drainPump(core: PoolCore, fill: ReturnType<typeof makeFill>, startNow: number): Set<BucketKey> {
    const regenerated = new Set<BucketKey>();
    let now = startNow;
    for (let guard = 0; guard < 30; guard++) {
      const plan = core.genPlan(now);
      if (!plan) return regenerated;
      regenerated.add(plan.bucket);
      core.addCandidates(plan.bucket, fill(plan.need), now);
      now += 100;
    }
    throw new Error("pump did not reach steady state");
  }

  it("a pin at default sliders regenerates at most 3 buckets (pump-loop proof, criterion #1)", () => {
    const core = new PoolCore(); // DEFAULT_PARAMS: dewpoint 0.35, altitude 0.25
    const fill = makeFill();
    for (const bucket of BUCKET_KEYS) core.addCandidates(bucket, fill(TARGET_DEPTH), 1000);
    for (const bucket of BUCKET_KEYS) expect(core.depths()[bucket].fresh).toBe(TARGET_DEPTH);

    core.pin("street smarts", 1, 2000); // one anchor, sliders untouched

    const regenerated = drainPump(core, fill, 3000);
    expect(regenerated.size).toBeGreaterThan(0); // the pin did trigger regeneration
    expect(regenerated.size).toBeLessThanOrEqual(3); // ...but not all six buckets
  });

  it("defers a cold bucket's refresh until a slider warms it (criterion #2)", () => {
    const core = new PoolCore();
    const fill = makeFill();
    for (const bucket of BUCKET_KEYS) core.addCandidates(bucket, fill(TARGET_DEPTH), 1000);

    core.pin("street smarts", 1, 2000); // default sliders keep the far corner w2a1 cold
    const regenerated = drainPump(core, fill, 3000);

    expect(regenerated.has("w2a1")).toBe(false); // never regenerated while cold
    expect(core.depths().w2a1.fresh).toBe(TARGET_DEPTH); // staleness deferred, not forgotten
    expect(core.genPlan(9000)).toBeNull(); // steady state — nothing else wanted

    // Move both sliders so the strange + abstract corner w2a1 becomes the hottest.
    core.setParams({ dewpoint: 0.95, altitude: 0.95 }, 9000);
    const plan = core.genPlan(9100);
    expect(plan).not.toBeNull();
    expect(plan!.bucket).toBe("w2a1"); // the warmed bucket is finally wanted
    expect(core.depths().w2a1.fresh).toBe(0); // its old candidates are now stale
  });

  it("stamps only the hot buckets stale, leaving cold buckets fresh", () => {
    const core = new PoolCore();
    const fill = makeFill();
    for (const bucket of BUCKET_KEYS) core.addCandidates(bucket, fill(4), 1000);

    core.pin("street smarts", 1, 2000);
    // Default sliders + a tier-1 anchor make w1a0 and w0a0 hottest; the strange,
    // abstract far corner w2a1 stays below the hotness threshold.
    expect(core.depths().w1a0.fresh).toBe(0);
    expect(core.depths().w0a0.fresh).toBe(0);
    expect(core.depths().w2a1.fresh).toBe(4);
  });

  it("stales an in-flight batch when a pin lands mid-generation, per bucket (criterion #3)", () => {
    // The pump captures genStart before calling the model, then stamps the
    // generated batch with genStart. A pin landing mid-flight stamps the hot
    // buckets at pin-time (> genStart), so their in-flight batch is stale.
    const core = new PoolCore();
    const genStart = 1000;
    core.pin("street smarts", 1, 2000); // lands mid-flight; stamps hot w1a0/w0a0 at 2000

    // The in-flight batch for hot bucket w1a0 completes and is added at genStart.
    core.addCandidates("w1a0", entries(["late arrival"]), genStart);
    expect(core.depths().w1a0.fresh).toBe(0); // genStart 1000 <= stamp 2000 -> stale

    // A batch for a bucket the pin left cold is still fresh (per-bucket, not global).
    core.addCandidates("w2a1", entries(["cold arrival"], 1), genStart);
    expect(core.depths().w2a1.fresh).toBe(1);
  });

  it("persists non-uniform per-bucket stamps across a serialize/rehydrate", () => {
    const a = new PoolCore();
    const fill = makeFill();
    a.addCandidates("w0a0", fill(1), 1000);
    a.addCandidates("w2a1", fill(1), 1000);
    a.setParams({ dewpoint: 0.1, altitude: 0.1 }, 2000); // stamps hot w0a0, leaves far w2a1 cold

    const stamps = a.getInvalidatedAt();
    expect(stamps.w0a0).toBe(2000);
    expect(stamps.w2a1).toBe(0);

    const b = new PoolCore(a.serialize());
    expect(b.getInvalidatedAt()).toEqual(stamps);
    expect(b.depths().w0a0.fresh).toBe(0); // stamp preserved
    expect(b.depths().w2a1.fresh).toBe(1);
  });

  it("accepts a legacy uniform stamp (scalar upgrade path)", () => {
    // On first resume after upgrade the DO spreads an old global scalar across
    // every bucket, so pre-stamp candidates stay stale and post-stamp stay fresh.
    const uniform = Object.fromEntries(BUCKET_KEYS.map((b) => [b, 5000])) as Record<BucketKey, number>;
    const core = new PoolCore({ invalidatedAt: uniform });
    core.addCandidates("w0a0", entries(["after"]), 6000); // generated after the stamp
    core.addCandidates("w1a0", entries(["before"], 1), 4000); // generated before the stamp
    expect(core.depths().w0a0.fresh).toBe(1);
    expect(core.depths().w1a0.fresh).toBe(0);
  });
});
