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
