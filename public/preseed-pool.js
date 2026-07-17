// The pre-seed meta-word pool (issue #11): a small static, client-side set of
// words *about dewpt, in dewpt's voice*, organized by the existing dewpoint
// tiers. Before a seed exists the field spawns these through the normal
// machinery so a cold visitor watches condensation and evaporation happen at
// zero stakes — no AI call, no network, nothing to wait for. Starter copy is
// decided in docs/explainer-research.md; served raw from public/ (no build
// step) and exercised directly by test/preseed-pool.test.ts.

/** Meta-words by tier: pale slate (obvious) → lilac (stranger) → warm ember
 *  (far-field), matching SPEC.md's color language.
 *  @type {readonly [readonly string[], readonly string[], readonly string[]]} */
export const META_POOL = [
  [
    "vapor, waiting",
    "words condense here",
    "then evaporate",
    "unpinned words don't last",
    "seed it with a topic",
    "ideas as weather",
    "play, not productivity",
  ],
  [
    "latent space, lightly disturbed",
    "the obvious condenses first",
    "raise the dewpoint for stranger air",
    "prospect the blank space",
    "a ghost trail of what faded",
    "the field never sits still",
  ],
  [
    "invisible vapor, made visible",
    "meaning precipitates",
    "everything here is weather",
    "the map has white space — go there",
    "thought, at its dew point",
  ],
];

/** Tier weights for a dewpoint setting — the pinless branch of field.js's
 *  tierWeights, kept in lockstep so the empty state's strangeness curve is a
 *  truthful preview of the seeded field (there are no anchors to bias it yet).
 *  @param {number} strange01 dewpoint slider, 0..1
 *  @returns {[number, number, number]} normalized [w0, w1, w2] */
export function metaTierWeights(strange01) {
  const s = Math.min(1, strange01);
  const w2 = Math.pow(s, 1.4);
  const w0 = Math.pow(1 - s, 1.4);
  const w1 = Math.max(0.15, 1 - w2 - w0);
  const sum = w0 + w1 + w2;
  return [w0 / sum, w1 / sum, w2 / sum];
}

/** Draw one meta-word not currently on the field. Prefers the tier the
 *  dewpoint asks for, then the nearest tiers — the pool is small, and a thin
 *  tier must not stall the pre-seed field. Null only when the whole pool is
 *  visible (the spawn tick just skips, exactly like field.js on a dry bucket).
 *  @param {number} strange01 dewpoint slider, 0..1
 *  @param {Set<string>} visible texts currently on the field
 *  @param {() => number} [rand] injectable for tests
 *  @returns {{ text: string, tier: number } | null} */
export function drawMetaWord(strange01, visible, rand = Math.random) {
  const [w0, w1] = metaTierWeights(strange01);
  const r = rand();
  const want = r < w0 ? 0 : r < w0 + w1 ? 1 : 2;
  const tiers = [0, 1, 2].sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  for (const tier of tiers) {
    const fresh = META_POOL[tier].filter(text => !visible.has(text));
    if (fresh.length) {
      return { text: fresh[Math.floor(rand() * fresh.length)], tier };
    }
  }
  return null;
}
