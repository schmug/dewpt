// Pure pool logic for a dewpt session: bucketed candidate pool, lazy
// invalidation, embedding dedupe, exclude LRU, evaporated ring buffer.
// No bindings, no storage, no I/O — the SessionDO hydrates and persists this.

import {
  BUCKET_KEYS,
  DEDUPE_COSINE,
  DEFAULT_PARAMS,
  EVAPORATED_CAP,
  EXCLUDE_CAP,
  FRESH_TARGET,
  GEN_BATCH,
  TARGET_DEPTH,
  bucketAlt,
  bucketTier,
  type Anchor,
  type BucketKey,
  type Candidate,
  type DewptParams,
  type EvaporatedWord,
  type Served,
  type Tier,
} from "./types";

export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

interface ExcludeEntry {
  text: string;
  servedAt: number;
}

export interface PoolCoreState {
  params: DewptParams;
  seedEmbedding: number[] | null;
  invalidatedAt: number;
  candidates: Candidate[];
  anchors: Anchor[];
  exclude: ExcludeEntry[]; // oldest-served first
  evaporated: EvaporatedWord[]; // most recent first
}

export class PoolCore {
  private params: DewptParams;
  private seedEmbedding: number[] | null;
  private invalidatedAt: number;
  private buckets: Map<BucketKey, Candidate[]>;
  private anchorList: Anchor[];
  private excludeMap: Map<string, ExcludeEntry>; // insertion order = oldest first
  private evaporatedList: EvaporatedWord[];

  constructor(state?: Partial<PoolCoreState>) {
    this.params = { ...DEFAULT_PARAMS, ...state?.params };
    this.seedEmbedding = state?.seedEmbedding ?? null;
    this.invalidatedAt = state?.invalidatedAt ?? 0;
    this.buckets = new Map(BUCKET_KEYS.map((k) => [k, []]));
    for (const c of state?.candidates ?? []) this.buckets.get(c.bucket)?.push(c);
    this.anchorList = [...(state?.anchors ?? [])];
    this.excludeMap = new Map();
    for (const e of state?.exclude ?? []) this.excludeMap.set(norm(e.text), e);
    this.evaporatedList = [...(state?.evaporated ?? [])];
  }

  // ---- serving ------------------------------------------------------------

  /** Serve up to `count` candidates from a bucket, fresh-first. Never blocks,
   *  never generates — an empty bucket just serves nothing. */
  draw(bucket: BucketKey, count: number, now: number): Served[] {
    const pool = this.buckets.get(bucket)!;
    const fresh: Candidate[] = [];
    const stale: Candidate[] = [];
    for (const c of pool) (this.isFresh(c) ? fresh : stale).push(c);

    const picked: Candidate[] = [];
    for (const group of [fresh, stale]) {
      while (picked.length < count && group.length > 0) {
        const i = Math.floor(Math.random() * group.length);
        picked.push(group.splice(i, 1)[0]!);
      }
    }

    const pickedSet = new Set(picked);
    this.buckets.set(
      bucket,
      pool.filter((c) => !pickedSet.has(c)),
    );
    for (const c of picked) this.noteServed(c.text, now);

    const tier = bucketTier(bucket);
    const alt = bucketAlt(bucket);
    return picked.map((c) => ({ text: c.text, tier, alt, seedDist: c.seedDist }));
  }

  depths(): Record<BucketKey, { total: number; fresh: number }> {
    const out = {} as Record<BucketKey, { total: number; fresh: number }>;
    for (const key of BUCKET_KEYS) {
      const pool = this.buckets.get(key)!;
      out[key] = { total: pool.length, fresh: pool.filter((c) => this.isFresh(c)).length };
    }
    return out;
  }

  // ---- intake -------------------------------------------------------------

  /** Add generated candidates to a bucket, deduping by exclude LRU, anchor
   *  texts, pooled texts, and embedding cosine (> DEDUPE_COSINE) against the
   *  pool and anchors. Evicts oldest stale candidates beyond TARGET_DEPTH. */
  addCandidates(
    bucket: BucketKey,
    entries: { text: string; embedding: number[] }[],
    now: number,
  ): { added: string[]; rejected: { text: string; reason: string }[] } {
    const added: string[] = [];
    const rejected: { text: string; reason: string }[] = [];
    const pool = this.buckets.get(bucket)!;

    for (const entry of entries) {
      const text = entry.text.trim();
      const key = norm(text);
      if (!key) {
        rejected.push({ text: entry.text, reason: "empty" });
        continue;
      }
      if (this.excludeMap.has(key)) {
        rejected.push({ text, reason: "recently served" });
        continue;
      }
      if (this.anchorList.some((a) => norm(a.text) === key)) {
        rejected.push({ text, reason: "pinned anchor" });
        continue;
      }
      if (this.allCandidates().some((c) => norm(c.text) === key)) {
        rejected.push({ text, reason: "already pooled" });
        continue;
      }
      const tooClose =
        this.allCandidates().some((c) => cosineSim(c.embedding, entry.embedding) > DEDUPE_COSINE) ||
        this.anchorList.some((a) => a.embedding !== null && cosineSim(a.embedding, entry.embedding) > DEDUPE_COSINE);
      if (tooClose) {
        rejected.push({ text, reason: "near-duplicate" });
        continue;
      }
      pool.push({
        text,
        bucket,
        embedding: entry.embedding,
        seedDist: this.seedEmbedding ? 1 - cosineSim(this.seedEmbedding, entry.embedding) : 0,
        generatedAt: now,
      });
      added.push(text);
    }

    if (pool.length > TARGET_DEPTH) {
      // Evict stale-first, oldest-first, keeping the pool at target depth.
      const ranked = [...pool].sort(
        (a, b) => Number(this.isFresh(a)) - Number(this.isFresh(b)) || a.generatedAt - b.generatedAt,
      );
      const evict = new Set(ranked.slice(0, pool.length - TARGET_DEPTH));
      this.buckets.set(
        bucket,
        pool.filter((c) => !evict.has(c)),
      );
    }

    return { added, rejected };
  }

  // ---- invalidation -------------------------------------------------------

  /** Merge a params patch. Dewpoint/altitude changes invalidate the pool
   *  lazily — nothing is dropped; candidates just stop counting as fresh.
   *  Drizzle is spawn rate only and never invalidates. */
  setParams(patch: Partial<DewptParams>, now: number): DewptParams {
    const next = { ...this.params };
    let invalidates = false;
    for (const key of ["dewpoint", "altitude", "drizzle"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const clamped = clamp01(value);
      if (clamped !== next[key]) {
        next[key] = clamped;
        if (key !== "drizzle") invalidates = true;
      }
    }
    this.params = next;
    if (invalidates) this.invalidatedAt = now;
    return { ...this.params };
  }

  getParams(): DewptParams {
    return { ...this.params };
  }

  // ---- anchors ------------------------------------------------------------

  pin(text: string, tier: Tier, now: number): Anchor[] {
    const key = norm(text);
    if (!this.anchorList.some((a) => norm(a.text) === key)) {
      this.anchorList.push({ text: text.trim(), tier, embedding: null, pinnedAt: now });
      for (const [bucket, pool] of this.buckets) {
        this.buckets.set(
          bucket,
          pool.filter((c) => norm(c.text) !== key),
        );
      }
      this.evaporatedList = this.evaporatedList.filter((e) => norm(e.text) !== key);
      this.invalidatedAt = now;
    }
    return this.anchors();
  }

  unpin(text: string, now: number): Anchor[] {
    const key = norm(text);
    const before = this.anchorList.length;
    this.anchorList = this.anchorList.filter((a) => norm(a.text) !== key);
    if (this.anchorList.length !== before) this.invalidatedAt = now;
    return this.anchors();
  }

  anchors(): Anchor[] {
    return this.anchorList.map((a) => ({ ...a }));
  }

  setAnchorEmbedding(text: string, embedding: number[]): void {
    const anchor = this.anchorList.find((a) => norm(a.text) === norm(text));
    if (anchor) anchor.embedding = embedding;
  }

  setSeedEmbedding(embedding: number[]): void {
    this.seedEmbedding = embedding;
  }

  getSeedEmbedding(): number[] | null {
    return this.seedEmbedding;
  }

  // ---- evaporated ring buffer ----------------------------------------------

  evaporate(text: string, tier: Tier, now: number): EvaporatedWord[] {
    const key = norm(text);
    // condensate and evaporated are disjoint: a pinned word never "expires",
    // even if a stale evaporate report races in after the pin
    if (this.anchorList.some((a) => norm(a.text) === key)) return this.evaporated();
    this.evaporatedList = this.evaporatedList.filter((e) => norm(e.text) !== key);
    this.evaporatedList.unshift({ text: text.trim(), tier, evaporatedAt: now });
    if (this.evaporatedList.length > EVAPORATED_CAP) this.evaporatedList.length = EVAPORATED_CAP;
    return this.evaporated();
  }

  restore(text: string): { restored: EvaporatedWord | null; evaporated: EvaporatedWord[] } {
    const key = norm(text);
    const i = this.evaporatedList.findIndex((e) => norm(e.text) === key);
    if (i === -1) return { restored: null, evaporated: this.evaporated() };
    const [restored] = this.evaporatedList.splice(i, 1);
    return { restored: restored ?? null, evaporated: this.evaporated() };
  }

  evaporated(): EvaporatedWord[] {
    return this.evaporatedList.map((e) => ({ ...e }));
  }

  // ---- generation planning --------------------------------------------------

  /** The next bucket worth generating for, weighted toward buckets the current
   *  params make hot. Null when every bucket is at depth and fresh. */
  genPlan(_now: number): { bucket: BucketKey; need: number } | null {
    let best: { bucket: BucketKey; need: number } | null = null;
    let bestScore = 0;
    for (const bucket of BUCKET_KEYS) {
      const pool = this.buckets.get(bucket)!;
      const fresh = pool.filter((c) => this.isFresh(c)).length;
      const needTotal = TARGET_DEPTH - pool.length;
      const needFresh = FRESH_TARGET - fresh;
      const rawNeed = Math.max(needTotal, needFresh, 0);
      if (rawNeed === 0) continue;
      const score = (rawNeed / TARGET_DEPTH) * (0.25 + this.affinity(bucket));
      if (score > bestScore) {
        bestScore = score;
        best = { bucket, need: Math.min(GEN_BATCH, rawNeed) };
      }
    }
    return best;
  }

  /** Recently served texts (most recent first) plus anchors, for the
   *  generation prompt's exclusion list. */
  excludeForPrompt(limit: number): string[] {
    const recent = [...this.excludeMap.values()].reverse().map((e) => e.text);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const text of [...recent, ...this.anchorList.map((a) => a.text)]) {
      const key = norm(text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  excludeSize(): number {
    return this.excludeMap.size;
  }

  // ---- persistence ----------------------------------------------------------

  serialize(): PoolCoreState {
    return {
      params: { ...this.params },
      seedEmbedding: this.seedEmbedding,
      invalidatedAt: this.invalidatedAt,
      candidates: this.allCandidates().map((c) => ({ ...c })),
      anchors: this.anchors(),
      exclude: [...this.excludeMap.values()].map((e) => ({ ...e })),
      evaporated: this.evaporated(),
    };
  }

  // ---- internals ------------------------------------------------------------

  private isFresh(c: Candidate): boolean {
    return c.generatedAt > this.invalidatedAt;
  }

  private allCandidates(): Candidate[] {
    return [...this.buckets.values()].flat();
  }

  private noteServed(text: string, now: number): void {
    const key = norm(text);
    this.excludeMap.delete(key);
    this.excludeMap.set(key, { text: text.trim(), servedAt: now });
    while (this.excludeMap.size > EXCLUDE_CAP) {
      const oldest = this.excludeMap.keys().next().value;
      if (oldest === undefined) break;
      this.excludeMap.delete(oldest);
    }
  }

  /** How likely the client is to draw from this bucket given current params —
   *  the demo's tierWeights() math (including pinned-tier blending) times the
   *  altitude split. */
  private affinity(bucket: BucketKey): number {
    const s = this.params.dewpoint;
    let w2 = Math.pow(s, 1.4);
    let w0 = Math.pow(1 - s, 1.4);
    let w1 = Math.max(0.15, 1 - w2 - w0);
    if (this.anchorList.length > 0) {
      const counts: [number, number, number] = [0, 0, 0];
      for (const a of this.anchorList) counts[a.tier]++;
      const n = this.anchorList.length;
      w0 = 0.7 * w0 + 0.3 * (counts[0] / n);
      w1 = 0.7 * w1 + 0.3 * (counts[1] / n);
      w2 = 0.7 * w2 + 0.3 * (counts[2] / n);
    }
    const sum = w0 + w1 + w2;
    const tierW = [w0 / sum, w1 / sum, w2 / sum][bucketTier(bucket)]!;
    const altW = bucketAlt(bucket) === 1 ? this.params.altitude : 1 - this.params.altitude;
    return tierW * altW;
  }
}
