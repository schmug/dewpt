// Weather vocabulary per SPEC.md: dewpoint/altitude/drizzle params, condensate,
// evaporated. "Strangeness" appears only inside generation prompts.

export type Tier = 0 | 1 | 2;
export type Alt = 0 | 1;
export type BucketKey = `w${Tier}a${Alt}`;

export const BUCKET_KEYS: readonly BucketKey[] = ["w0a0", "w0a1", "w1a0", "w1a1", "w2a0", "w2a1"];

export interface DewptParams {
  dewpoint: number; // 0..1
  altitude: number; // 0..1
  drizzle: number; // 0..1 — spawn rate only, never affects generation
}

// Demo slider defaults: dewpoint 35, altitude 25, drizzle 50.
export const DEFAULT_PARAMS: DewptParams = { dewpoint: 0.35, altitude: 0.25, drizzle: 0.5 };

export interface Candidate {
  text: string;
  bucket: BucketKey;
  embedding: number[];
  seedDist: number; // cosine distance from the seed embedding
  generatedAt: number;
}

export interface Anchor {
  text: string;
  tier: Tier;
  embedding: number[] | null; // filled in lazily (embedded before next generation)
  pinnedAt: number;
}

export interface EvaporatedWord {
  text: string;
  tier: Tier;
  evaporatedAt: number;
}

export interface Served {
  text: string;
  tier: Tier;
  alt: Alt;
  seedDist: number;
  coords: number[]; // one raw cosine per ready axis, in axis order; [] when none
}

export interface SessionInfo {
  id: string;
  seed: string;
  params: DewptParams;
  anchors: { text: string; tier: Tier; pinnedAt: number }[];
  evaporated: EvaporatedWord[];
  depths: Record<BucketKey, { total: number; fresh: number }>;
  createdAt: number;
}

export const TARGET_DEPTH = 60; // scored candidates per bucket (spec)
export const FRESH_TARGET = 24; // fresh candidates wanted per hot bucket after invalidation
// A bucket is "hot" (worth regenerating on a pin/param change) when its affinity
// is at least this fraction of the hottest bucket's affinity. Scopes per-bucket
// invalidation to the buckets the current sliders actually draw from (issue #3):
// cold buckets keep serving stale candidates and refresh lazily when they warm up.
export const HOT_AFFINITY_FRAC = 0.5;
export const GEN_BATCH = 24; // candidates requested per generation call (spec: 20–30)
export const DEDUPE_COSINE = 0.92; // near-duplicate threshold (spec)
export const EXCLUDE_CAP = 300; // LRU of recently served texts (spec: ~300)
export const EVAPORATED_CAP = 20; // ring buffer of expired words (spec)

// Characteristic generation targets per band. Tiers map to the demo's t0/t1/t2
// color language; alts to concrete/abstract.
export const TIER_STRANGENESS: Record<Tier, number> = { 0: 0.15, 1: 0.5, 2: 0.85 };
export const ALT_ABSTRACTION: Record<Alt, number> = { 0: 0.2, 1: 0.8 };

export function bucketKey(tier: Tier, alt: Alt): BucketKey {
  return `w${tier}a${alt}`;
}

export function bucketTier(bucket: BucketKey): Tier {
  return Number(bucket[1]) as Tier;
}

export function bucketAlt(bucket: BucketKey): Alt {
  return Number(bucket[3]) as Alt;
}

/** One end of a user-named axis. `term` is what the user typed; `phrase` is the
 *  LLM-expanded descriptive form that actually gets embedded — bare terms lose
 *  ~0.34 AUC to polysemy, so `phrase` is never optional. */
export interface AxisPole {
  term: string;
  phrase: string;
  /** False when expansion failed and `phrase` is just the bare term. A bare
   *  pole scores AUC 0.640 against 0.980 for an expanded one, so a degraded
   *  pole must stay visible rather than passing as a normal axis. */
  expanded: boolean;
  embedding: number[] | null; // filled in lazily, like Anchor.embedding
}

export interface Axis {
  id: string;
  neg: AxisPole;
  pos: AxisPole;
  createdAt: number;
}

/** Axis as sent to the client — no embeddings on the wire, ever. */
export interface SerializedAxis {
  id: string;
  neg: { term: string; phrase: string };
  pos: { term: string; phrase: string };
  ready: boolean; // both poles embedded, so coordinates are being served
  degraded: boolean; // at least one pole fell back to its bare term
}

/** Guards the case where `pos - neg` lands on (or near) the zero vector: every
 *  word would score ~0 on this axis while it still reports ready:true,
 *  degraded:false. Distinct pole terms can land here because the few-shot
 *  expansion prompt in generation.ts pins phrasing tightly — "sea" and
 *  "ocean" both expanding to the literal string "a large body of salt water"
 *  is plausible, and identical text embeds to cosine 1.0.
 *
 *  What this does NOT do: detect two poles that merely *mean* the same thing
 *  while worded differently. Measured against real bge-m3 embeddings, pairs
 *  that are genuine paraphrase collisions ("a physical object you can touch"
 *  vs "a tangible object you can hold", "a feeling of happiness" vs "a sense
 *  of joy and gladness", ...) scored 0.79-0.92 cosine — and legitimate,
 *  useful antonym axes ("a warm colour" vs "a cool colour", "a slightly
 *  formal tone" vs "a slightly casual tone", ...) scored 0.59-0.92, the same
 *  range. "a warm colour"/"a cool colour" landed at 0.9201 cosine — identical
 *  to the top paraphrase collision. No cosine threshold separates the two
 *  sets: antonym poles sit close together in embedding space precisely
 *  because sharing topic and context is what lets `pos - neg` isolate an axis
 *  at all. Lowering this constant would reject valid narrow axes without
 *  catching any more paraphrase collisions — it is not a dial worth turning.
 *  What it reliably catches is the narrower, literal-text case above. */
export const DEGENERATE_POLE_COSINE = 0.98;

export const MAX_AXES = 3; // one per spatial dimension
export const MAX_POLE_TERM_CHARS = 48;
export const MAX_POLE_PHRASE_CHARS = 120;
