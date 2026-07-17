import { describe, expect, it } from "vitest";

// public/preseed-pool.js is plain JS served raw from public/ (no build step),
// so it sits outside tsconfig's include — same arrangement as the hint-machine
// browser mirror; the cast pins the surface the client relies on.
// @ts-expect-error — public/preseed-pool.js ships untyped
import * as poolUntyped from "../public/preseed-pool.js";

type MetaPick = { text: string; tier: 0 | 1 | 2 } | null;
const { META_POOL, metaTierWeights, drawMetaWord } = poolUntyped as {
  META_POOL: readonly [readonly string[], readonly string[], readonly string[]];
  metaTierWeights: (strange01: number) => [number, number, number];
  drawMetaWord: (
    strange01: number,
    visible: Set<string>,
    rand?: () => number,
  ) => MetaPick;
};

describe("meta-word pool (issue #11 — pre-seed empty state)", () => {
  it("carries three tiers, each with enough words to keep the field alive", () => {
    expect(META_POOL).toHaveLength(3);
    for (const tier of META_POOL) expect(tier.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the starter pool from docs/explainer-research.md (sentinels per tier)", () => {
    expect(META_POOL[0]).toContain("play, not productivity");
    expect(META_POOL[1]).toContain("raise the dewpoint for stranger air");
    expect(META_POOL[2]).toContain("thought, at its dew point");
  });

  it("is all-lowercase copy with no duplicates across tiers", () => {
    const all = META_POOL.flat();
    for (const text of all) {
      expect(text).toBe(text.toLowerCase());
      expect(text.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("metaTierWeights — mirrors field.js tierWeights (pinless branch)", () => {
  it("normalizes to 1 across the dewpoint range", () => {
    for (const s of [0, 0.25, 0.35, 0.5, 0.75, 1]) {
      const [w0, w1, w2] = metaTierWeights(s);
      expect(w0 + w1 + w2).toBeCloseTo(1, 10);
      for (const w of [w0, w1, w2]) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it("low dewpoint condenses the obvious: tier 0 dominates, tier 2 vanishes", () => {
    const [w0, , w2] = metaTierWeights(0);
    expect(w0).toBeGreaterThan(0.8);
    expect(w2).toBe(0);
  });

  it("high dewpoint precipitates far-field vapor: tier 2 dominates, tier 0 vanishes", () => {
    const [w0, , w2] = metaTierWeights(1);
    expect(w2).toBeGreaterThan(0.8);
    expect(w0).toBe(0);
  });

  it("matches the demo's curve exactly (s^1.4 / (1-s)^1.4, floor 0.15 on w1)", () => {
    const s = 0.35;
    const r2 = Math.pow(s, 1.4);
    const r0 = Math.pow(1 - s, 1.4);
    const r1 = Math.max(0.15, 1 - r2 - r0);
    const sum = r0 + r1 + r2;
    const [w0, w1, w2] = metaTierWeights(s);
    expect(w0).toBeCloseTo(r0 / sum, 10);
    expect(w1).toBeCloseTo(r1 / sum, 10);
    expect(w2).toBeCloseTo(r2 / sum, 10);
  });
});

describe("drawMetaWord", () => {
  it("draws from the wanted tier when it has fresh words", () => {
    // rand → 0: tier pick lands in w0 (dewpoint 0 → tier 0), index pick → first entry
    const pick = drawMetaWord(0, new Set(), () => 0);
    expect(pick).not.toBeNull();
    expect(pick!.tier).toBe(0);
    expect(META_POOL[0]).toContain(pick!.text);
  });

  it("never redraws a word that is already visible", () => {
    const visible = new Set(META_POOL[0].slice(1)); // everything in t0 but the survivor
    const survivor = META_POOL[0][0];
    const pick = drawMetaWord(0, visible, () => 0);
    expect(pick).toEqual({ text: survivor, tier: 0 });
  });

  it("falls back to a neighboring tier rather than stalling the field", () => {
    const visible = new Set(META_POOL[0]); // preferred tier exhausted
    const pick = drawMetaWord(0, visible, () => 0);
    expect(pick).not.toBeNull();
    expect(pick!.tier).toBe(1); // nearest tier to the wanted one
    expect(META_POOL[1]).toContain(pick!.text);
  });

  it("returns null only when the whole pool is on the field", () => {
    const visible = new Set(META_POOL.flat());
    expect(drawMetaWord(0.5, visible, () => 0)).toBeNull();
  });
});
