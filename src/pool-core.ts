// Pure pool logic for a dewpt session: bucketed candidate pool, lazy
// invalidation, embedding dedupe, exclude LRU, evaporated ring buffer.
// No bindings, no storage, no I/O — the SessionDO hydrates and persists this.

import { axisVector, coordsFor } from "./axis-core";
import {
  BUCKET_KEYS,
  DEDUPE_COSINE,
  DEFAULT_PARAMS,
  EVAPORATED_CAP,
  EXCLUDE_CAP,
  FRESH_TARGET,
  GEN_BATCH,
  HOT_AFFINITY_FRAC,
  MAX_AXES,
  TARGET_DEPTH,
  bucketAlt,
  bucketTier,
  type Anchor,
  type Axis,
  type BucketKey,
  type Candidate,
  type DewptParams,
  type EvaporatedWord,
  type SerializedAxis,
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

/** Per-bucket "stale since" timestamps. A candidate is fresh when it was
 *  generated strictly after its own bucket's stamp, so invalidating one bucket
 *  never touches another's freshness (issue #3). */
export type InvalidationStamps = Record<BucketKey, number>;

function zeroStamps(): InvalidationStamps {
  return Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])) as InvalidationStamps;
}

export interface PoolCoreState {
  params: DewptParams;
  seedEmbedding: number[] | null;
  invalidatedAt: InvalidationStamps;
  candidates: Candidate[];
  anchors: Anchor[];
  axes: Axis[];
  exclude: ExcludeEntry[]; // oldest-served first
  evaporated: EvaporatedWord[]; // most recent first
}

export class PoolCore {
  private params: DewptParams;
  private seedEmbedding: number[] | null;
  private invalidatedAt: InvalidationStamps;
  private buckets: Map<BucketKey, Candidate[]>;
  private anchorList: Anchor[];
  private axisList: Axis[];
  private excludeMap: Map<string, ExcludeEntry>; // insertion order = oldest first
  private evaporatedList: EvaporatedWord[];

  constructor(state?: Partial<PoolCoreState>) {
    this.params = { ...DEFAULT_PARAMS, ...state?.params };
    this.seedEmbedding = state?.seedEmbedding ?? null;
    // Fill any missing bucket keys (partial or legacy-scalar-derived state) with 0.
    this.invalidatedAt = { ...zeroStamps(), ...(state?.invalidatedAt ?? {}) };
    this.buckets = new Map(BUCKET_KEYS.map((k) => [k, []]));
    for (const c of state?.candidates ?? []) this.buckets.get(c.bucket)?.push(c);
    this.anchorList = [...(state?.anchors ?? [])];
    this.axisList = [...(state?.axes ?? [])];
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
    const axisVecs = this.readyAxisVectors();
    return picked.map((c) => ({
      text: c.text,
      tier,
      alt,
      seedDist: c.seedDist,
      coords: coordsFor(c.embedding, axisVecs),
    }));
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
   *  Only the buckets the new sliders make hot are stamped stale, so a slider
   *  move that warms a previously-cold bucket is what finally refreshes it
   *  (deferred, not forgotten). Drizzle is spawn rate only and never invalidates. */
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
    if (invalidates) this.invalidateHot(now);
    return { ...this.params };
  }

  getParams(): DewptParams {
    return { ...this.params };
  }

  // ---- anchors ------------------------------------------------------------

  pin(text: string, tier: Tier, now: number): Anchor[] {
    this.insertAnchor(text, tier, now);
    return this.anchors();
  }

  /** Add a user-supplied word/phrase mid-session as a pinned anchor. Rides the
   *  same mechanic as pin() — the text need never have appeared in the pool, so
   *  a user can inject an idea the model never offered — and reports whether it
   *  was newly added so a duplicate stays a no-op (no redundant invalidation or
   *  regeneration). */
  addWord(text: string, tier: Tier, now: number): { anchors: Anchor[]; added: boolean } {
    const added = this.insertAnchor(text, tier, now);
    return { anchors: this.anchors(), added };
  }

  /** Shared anchor intake for pin()/addWord(): dedupe by normalized text, drop
   *  the word from every bucket and the evaporated ring, and invalidate the
   *  pool. Returns whether a new anchor was actually created. */
  private insertAnchor(text: string, tier: Tier, now: number): boolean {
    const key = norm(text);
    if (!key || this.anchorList.some((a) => norm(a.text) === key)) return false;
    this.anchorList.push({ text: text.trim(), tier, embedding: null, pinnedAt: now });
    for (const [bucket, pool] of this.buckets) {
      this.buckets.set(
        bucket,
        pool.filter((c) => norm(c.text) !== key),
      );
    }
    this.evaporatedList = this.evaporatedList.filter((e) => norm(e.text) !== key);
    this.invalidateHot(now);
    return true;
  }

  unpin(text: string, now: number): Anchor[] {
    const key = norm(text);
    const before = this.anchorList.length;
    this.anchorList = this.anchorList.filter((a) => norm(a.text) !== key);
    if (this.anchorList.length !== before) this.invalidateHot(now);
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

  // ---- axes -----------------------------------------------------------------

  addAxis(axis: Axis): boolean {
    if (this.axisList.length >= MAX_AXES) return false;
    this.axisList.push(axis);
    return true;
  }

  removeAxis(id: string): boolean {
    const before = this.axisList.length;
    this.axisList = this.axisList.filter((a) => a.id !== id);
    return this.axisList.length < before;
  }

  /** Copy-on-read, matching `anchors()` one section above. A live reference
   *  would let `core.axes().push(...)` add a fourth axis straight past the
   *  MAX_AXES guard, and would alias into `serialize()`'s snapshot — `addAxis`
   *  pushes in place, so an earlier snapshot's `axes` would grow after the
   *  fact, breaking the point-in-time contract every other serialized field
   *  honors. The hot path reads `this.axisList` directly, so this costs
   *  nothing per draw. */
  axes(): Axis[] {
    return this.axisList.map((a) => ({ ...a }));
  }

  /** Client-facing view. Embeddings are deliberately absent — they never go on
   *  the wire (1024 dims x 60 candidates would be ~245 KB per bucket). */
  serializedAxes(): SerializedAxis[] {
    return this.axisList.map((a) => ({
      id: a.id,
      neg: { term: a.neg.term, phrase: a.neg.phrase },
      pos: { term: a.pos.term, phrase: a.pos.phrase },
      ready: a.neg.embedding !== null && a.pos.embedding !== null,
      degraded: !a.neg.expanded || !a.pos.expanded,
    }));
  }

  unembeddedPoles(): { axisId: string; pole: "neg" | "pos"; phrase: string }[] {
    const out: { axisId: string; pole: "neg" | "pos"; phrase: string }[] = [];
    for (const axis of this.axisList) {
      for (const pole of ["neg", "pos"] as const) {
        if (axis[pole].embedding === null) out.push({ axisId: axis.id, pole, phrase: axis[pole].phrase });
      }
    }
    return out;
  }

  setPoleEmbedding(axisId: string, pole: "neg" | "pos", embedding: number[]): void {
    const axis = this.axisList.find((a) => a.id === axisId);
    if (axis) axis[pole].embedding = embedding;
  }

  /** Fully-embedded axes, in axis order. The single source both readyAxisVectors
   *  and readyAxisIds derive from, so the vectors a draw is scored against and
   *  the ids reported alongside it cannot drift out of correspondence. */
  private readyAxes(): Axis[] {
    return this.axisList.filter((a) => a.neg.embedding !== null && a.pos.embedding !== null);
  }

  /** Axis vectors for every fully-embedded axis, in axis order. An axis with a
   *  pending pole contributes no coordinate rather than a wrong one. */
  private readyAxisVectors(): number[][] {
    return this.readyAxes().map((a) => axisVector(a.neg.embedding!, a.pos.embedding!));
  }

  /** Ids of the axes `Served.coords` is indexed by, in the same order. Without
   *  this the client cannot tell which axis `coords[i]` belongs to: coords index
   *  the READY subset while serializedAxes() reports every axis, so one pending
   *  axis shifts the whole mapping. Ships with every draw for that reason. */
  readyAxisIds(): string[] {
    return this.readyAxes().map((a) => a.id);
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
      invalidatedAt: this.getInvalidatedAt(),
      candidates: this.allCandidates().map((c) => ({ ...c })),
      anchors: this.anchors(),
      axes: this.axes(),
      exclude: [...this.excludeMap.values()].map((e) => ({ ...e })),
      evaporated: this.evaporated(),
    };
  }

  /** The per-bucket staleness stamps — a cheap copy for persistence (the DO
   *  serializes just this into its meta table, without dumping the whole pool). */
  getInvalidatedAt(): InvalidationStamps {
    return { ...this.invalidatedAt };
  }

  // ---- internals ------------------------------------------------------------

  private isFresh(c: Candidate): boolean {
    return c.generatedAt > this.invalidatedAt[c.bucket];
  }

  /** Mark every hot bucket stale as of `now`. Cold buckets keep their prior
   *  stamp, so their candidates stay fresh and aren't regenerated until a later
   *  slider/anchor change warms them up. The hottest bucket always qualifies, so
   *  an invalidating event never becomes a silent no-op. */
  private invalidateHot(now: number): void {
    for (const bucket of this.hotBuckets()) this.invalidatedAt[bucket] = now;
  }

  /** Buckets whose affinity is within HOT_AFFINITY_FRAC of the hottest bucket's,
   *  using the same affinity() the client draws by — the single hotness source. */
  private hotBuckets(): Set<BucketKey> {
    const affinities = BUCKET_KEYS.map((b) => [b, this.affinity(b)] as const);
    const max = Math.max(...affinities.map(([, a]) => a));
    // Degenerate params (all-zero affinity) — treat every bucket as hot.
    if (max <= 0) return new Set(BUCKET_KEYS);
    const threshold = HOT_AFFINITY_FRAC * max;
    return new Set(affinities.filter(([, a]) => a >= threshold).map(([b]) => b));
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
