// One SessionDO per dewpt session. Holds the seed, params, anchors, candidate
// pool, exclude LRU and evaporated ring buffer (all via PoolCore), and runs
// alarm-driven background generation. Serving never waits on generation: draw
// answers from whatever is pooled and the alarm pump refills behind it.

import { DurableObject } from "cloudflare:workers";
import { axisFromRow, axisToRow, isDegeneratePole } from "./axis-core";
import { fakeAiRunner } from "./dev-fake-ai";
import { embedTexts, expandPole, generateCandidates, type AiRunner } from "./generation";
import { PoolCore } from "./pool-core";
import {
  ALT_ABSTRACTION,
  BUCKET_KEYS,
  MAX_AXES,
  TIER_STRANGENESS,
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
  type SessionInfo,
  type Tier,
} from "./types";

const PROMPT_EXCLUDE_LIMIT = 80;
const PUMP_RETRY_BASE_MS = 400;
const PUMP_RETRY_MAX_MS = 30_000;

interface Meta {
  id: string;
  seed: string;
  createdAt: number;
}

function toBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

/** Parse the persisted per-bucket invalidation stamps. Backward compatible with
 *  the legacy single-scalar representation (a plain number string): an old
 *  session's global stamp is spread across every bucket, so nothing regresses on
 *  the first resume after upgrade. Kept synchronous and cheap for hydrate(). */
function hydrateInvalidation(raw: string | undefined): Record<BucketKey, number> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "number") {
      return Object.fromEntries(BUCKET_KEYS.map((b) => [b, parsed])) as Record<BucketKey, number>;
    }
    if (parsed && typeof parsed === "object") return parsed as Record<BucketKey, number>;
  } catch {
    // Corrupt/unrecognized value — start fresh (PoolCore fills zeros).
  }
  return undefined;
}

function fromBlob(blob: ArrayBuffer): number[] {
  return Array.from(new Float32Array(blob));
}

export class SessionDO extends DurableObject<Env> {
  private core!: PoolCore;
  private meta: Meta | null = null;
  private pumping = false;
  private pumpFailures = 0;
  private devFakeAi: AiRunner | null = null;
  /** Axis creations past the cap guard but not yet added to the core. See the
   *  comment in createAxis for why the guard cannot rely on axes().length alone. */
  private axisCreationsInFlight = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // sql.exec is synchronous; blockConcurrencyWhile only guards first-run schema setup
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.hydrate();
    });
  }

  // ---- RPC ------------------------------------------------------------------

  /** Create the session (idempotent) and kick the first generation pass. */
  async init(id: string, seed: string, params?: Partial<DewptParams>): Promise<SessionInfo> {
    if (!this.meta) {
      this.meta = { id, seed: seed.trim(), createdAt: Date.now() };
      if (params) this.core.setParams(params, 0);
      this.putMeta("meta", JSON.stringify(this.meta));
      this.putMeta("params", JSON.stringify(this.core.getParams()));
      this.persistInvalidation();
      await this.ensurePump(0);
    }
    return this.info();
  }

  async getInfo(): Promise<SessionInfo | null> {
    return this.meta ? this.info() : null;
  }

  /** Serve candidates from a bucket. Never generates inline.
   *
   *  `axisIds` names the axes each word's `coords` are indexed by. It is not
   *  redundant with the axis list from /axes: coords cover only the READY axes,
   *  so the two lists differ whenever an axis is still embedding, and a client
   *  buffering words across time needs to know which set a given word was
   *  scored under. */
  async drawPool(
    bucket: BucketKey,
    count: number,
  ): Promise<{ condensed: Served[]; depths: SessionInfo["depths"]; axisIds: string[] } | null> {
    if (!this.meta) return null;
    const served = this.core.draw(bucket, count, Date.now());
    // Read in the same synchronous slice as the draw. Taken after the await
    // below, a concurrent pump could have embedded another pole in between and
    // we would label these coords with an axis set they were not scored against.
    const axisIds = this.core.readyAxisIds();
    if (served.length > 0) {
      const texts = served.map((s) => s.text);
      this.ctx.storage.sql.exec(
        `DELETE FROM pool WHERE text IN (${texts.map(() => "?").join(",")})`,
        ...texts,
      );
      const now = Date.now();
      for (const text of texts) {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO exclude (text, served_at) VALUES (?, ?)", text, now);
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM exclude WHERE text NOT IN (SELECT text FROM exclude ORDER BY served_at DESC, rowid DESC LIMIT 300)",
      );
    }
    if (this.core.genPlan(Date.now())) await this.ensurePump(0);
    return { condensed: served, depths: this.core.depths(), axisIds };
  }

  /** M1 prospecting: the client serves the burst from its local buffers; this
   *  is the background top-up for the dewpoint-bumped buckets. */
  async prospect(_buckets: BucketKey[]): Promise<void> {
    if (!this.meta) return;
    await this.ensurePump(0);
  }

  async updateParams(patch: Partial<DewptParams>): Promise<DewptParams | null> {
    if (!this.meta) return null;
    const params = this.core.setParams(patch, Date.now());
    this.putMeta("params", JSON.stringify(params));
    this.persistInvalidation();
    await this.ensurePump(0);
    return params;
  }

  async pin(text: string, tier: Tier): Promise<SessionInfo["anchors"] | null> {
    if (!this.meta) return null;
    this.core.pin(text, tier, Date.now());
    this.persistAnchors();
    this.persistEvaporated(); // pin prunes the word from the evaporated ring
    this.persistInvalidation();
    this.ctx.storage.sql.exec("DELETE FROM pool WHERE lower(trim(text)) = lower(trim(?))", text);
    await this.ensurePump(0); // embeds the new anchor, then regenerates
    return this.publicAnchors();
  }

  /** A user injects their own word/phrase mid-session. Rides the anchor path:
   *  the word becomes a pinned anchor that steers every subsequent generation.
   *  A duplicate is a no-op — no redundant embed/regeneration is queued. */
  async addWord(text: string, tier: Tier): Promise<SessionInfo["anchors"] | null> {
    if (!this.meta) return null;
    const { added } = this.core.addWord(text, tier, Date.now());
    if (added) {
      this.persistAnchors();
      this.persistEvaporated(); // the word may have been resting in the evaporated ring
      this.persistInvalidation();
      this.ctx.storage.sql.exec("DELETE FROM pool WHERE lower(trim(text)) = lower(trim(?))", text);
      await this.ensurePump(0); // embeds the new anchor, then regenerates
    }
    return this.publicAnchors();
  }

  async unpin(text: string): Promise<SessionInfo["anchors"] | null> {
    if (!this.meta) return null;
    this.core.unpin(text, Date.now());
    this.persistAnchors();
    this.persistInvalidation();
    await this.ensurePump(0);
    return this.publicAnchors();
  }

  async evaporate(text: string, tier: Tier): Promise<EvaporatedWord[] | null> {
    if (!this.meta) return null;
    const evaporated = this.core.evaporate(text, tier, Date.now());
    this.persistEvaporated();
    return evaporated;
  }

  async restore(text: string): Promise<{ restored: EvaporatedWord | null; evaporated: EvaporatedWord[] } | null> {
    if (!this.meta) return null;
    const result = this.core.restore(text);
    this.persistEvaporated();
    return result;
  }

  /** Create an axis from two pole terms. Expands each term to a descriptive
   *  phrase (mandatory — bare terms lose ~0.34 AUC to polysemy), embeds both
   *  phrases, then stores the axis. Slow and explicitly user-initiated; it must
   *  never sit in the pool-serving path. Returns null when the session is
   *  unknown, or `{ axes, created: false, reason }` when the axis was refused —
   *  "cap" at MAX_AXES, "degenerate" when the two expansions collapsed onto
   *  each other. `negPhrase`/`posPhrase` accompany "degenerate" so the route can
   *  show the user the phrases that collided; the axis itself is gone by then. */
  async createAxis(
    negTerm: string,
    posTerm: string,
  ): Promise<
    | { created: true; axes: SerializedAxis[] }
    | { created: false; reason: "cap"; axes: SerializedAxis[] }
    | { created: false; reason: "degenerate"; axes: SerializedAxis[]; negPhrase: string; posPhrase: string }
    | null
  > {
    if (!this.meta) return null;
    // At cap: report it rather than returning the unchanged list, which the
    // route would otherwise answer with a 201 for a request it silently
    // dropped — the same silent-failure shape identical poles are rejected for.
    //
    // Counts in-flight creations too. Durable Objects are single-threaded per
    // slice but not atomic across awaits that aren't storage-gated, and the
    // expandPole calls below are two such awaits. Without the reservation, a
    // double-tap at 2/3 axes lets both requests clear this guard and pay for
    // LLM calls before the loser discovers the cap at addAxis().
    if (this.core.axes().length + this.axisCreationsInFlight >= MAX_AXES) {
      return { axes: this.core.serializedAxes(), created: false, reason: "cap" };
    }
    this.axisCreationsInFlight++;
    try {
      const ai = this.aiRunner();
      const [neg, pos] = await Promise.all([
        expandPole(ai, this.env.GEN_MODEL, negTerm),
        expandPole(ai, this.env.GEN_MODEL, posTerm),
      ]);

      const axis = {
        id: crypto.randomUUID(),
        neg: { term: negTerm, phrase: neg.phrase, expanded: neg.expanded, embedding: null },
        pos: { term: posTerm, phrase: pos.phrase, expanded: pos.expanded, embedding: null },
        createdAt: Date.now(),
      };
      // Belt-and-braces: the reservation above should make this unreachable in
      // practice, but addAxis's own cap check stays as a second line of
      // defense in case the reservation is ever removed or miscounted.
      if (!this.core.addAxis(axis)) return { axes: this.core.serializedAxes(), created: false, reason: "cap" };

      // Embed both poles now so coordinates start flowing immediately. On failure
      // the axis persists unembedded and reports ready:false; the next pump picks
      // up the pending poles.
      // The catch wraps the embed call ONLY. Widening it to cover the
      // degeneracy check below would let a throw there fall through to the
      // created:true return, resurrecting an axis this method just removed.
      let vecs: number[][] | null = null;
      let embedFailed = false;
      try {
        vecs = await embedTexts(ai, this.env.EMBED_MODEL, [neg.phrase, pos.phrase]);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "axis pole embed failed", axisId: axis.id, error: String(error) }));
        // The axis is persisted unembedded, and only the pump's unembeddedPoles()
        // pass can finish it — but the alarm reschedules itself only while
        // genPlan() has work, so against a full pool nothing would ever wake it
        // and the axis would stay ready:false forever. Kick the pump explicitly.
        // Deliberately absent from the success path: a created axis does not
        // invalidate the pool and must not trigger regeneration. Deferred until
        // after persistAxes() below (not fired here) so that if ensurePump's
        // alarm write throws, the axis this method reports failed is not
        // simultaneously written to storage by it — storage state must match
        // what the caller is told.
        embedFailed = true;
      }

      if (vecs) {
        // Reject a degenerate pair here rather than at parse time: distinct terms
        // can still expand onto the same (or near-identical) phrase, and only the
        // embeddings show it. pos - neg would be ~zero, scoring every word 0 while
        // the axis reported itself ready and healthy — the silent-dead-axis
        // failure the identical-term check exists to prevent. This is a narrower
        // guard than "poles that mean the same thing": see isDegeneratePole in
        // axis-core.ts and DEGENERATE_POLE_COSINE in types.ts for why cosine
        // cannot detect general semantic collapse, only literal-text collisions.
        // Only this branch removes the axis; the embed-failure path above must
        // keep it for the pump to retry.
        if (isDegeneratePole(vecs[0]!, vecs[1]!)) {
          this.core.removeAxis(axis.id);
          this.persistAxes();
          return {
            axes: this.core.serializedAxes(),
            created: false,
            reason: "degenerate",
            negPhrase: neg.phrase,
            posPhrase: pos.phrase,
          };
        }
        this.core.setPoleEmbedding(axis.id, "neg", vecs[0]!);
        this.core.setPoleEmbedding(axis.id, "pos", vecs[1]!);
      }

      this.persistAxes();
      // Kicked here, after the axis is durably persisted, rather than inside
      // the catch above: if ensurePump's alarm write were to throw there,
      // createAxis would reject without ever reaching persistAxes(), while
      // core.addAxis had already put the axis in memory — the caller would be
      // told creation failed, yet a later unrelated persistAxes() call would
      // still write it. Ordering the pump kick after persistAxes() keeps
      // storage consistent with what this method reports either way.
      if (embedFailed) await this.ensurePump(0);
      return { axes: this.core.serializedAxes(), created: true };
    } finally {
      this.axisCreationsInFlight--;
    }
  }

  async removeAxis(id: string): Promise<SerializedAxis[] | null> {
    if (!this.meta) return null;
    if (this.core.removeAxis(id)) this.persistAxes();
    return this.core.serializedAxes();
  }

  async listAxes(): Promise<SerializedAxis[] | null> {
    if (!this.meta) return null;
    return this.core.serializedAxes();
  }

  // ---- generation pump --------------------------------------------------------

  async alarm(): Promise<void> {
    console.log(JSON.stringify({ level: "info", message: "pump tick", session: this.meta?.id, pumping: this.pumping }));
    if (!this.meta || this.pumping) return;
    this.pumping = true;
    const genStart = Date.now();
    try {
      const ai = this.aiRunner();

      if (!this.core.getSeedEmbedding()) {
        const [vec] = await embedTexts(ai, this.env.EMBED_MODEL, [this.meta.seed]);
        if (vec) {
          this.core.setSeedEmbedding(vec);
          this.putMeta("seedEmbedding", JSON.stringify(vec));
        }
      }

      const unembedded = this.core.anchors().filter((a) => a.embedding === null);
      if (unembedded.length > 0) {
        const vecs = await embedTexts(ai, this.env.EMBED_MODEL, unembedded.map((a) => a.text));
        unembedded.forEach((a, i) => {
          if (vecs[i]) this.core.setAnchorEmbedding(a.text, vecs[i]!);
        });
        this.persistAnchors();
      }

      const pendingPoles = this.core.unembeddedPoles();
      if (pendingPoles.length > 0) {
        const vecs = await embedTexts(ai, this.env.EMBED_MODEL, pendingPoles.map((p) => p.phrase));
        pendingPoles.forEach((p, i) => this.core.setPoleEmbedding(p.axisId, p.pole, vecs[i]!));
        this.persistAxes();
      }

      const plan = this.core.genPlan(Date.now());
      if (plan) {
        const tier = bucketTier(plan.bucket);
        const alt = bucketAlt(plan.bucket);
        const texts = await generateCandidates(ai, this.env.GEN_MODEL, {
          seed: this.meta.seed,
          strangeness: TIER_STRANGENESS[tier],
          altitude: ALT_ABSTRACTION[alt],
          anchors: this.core.anchors().map((a) => a.text),
          exclude: this.core.excludeForPrompt(PROMPT_EXCLUDE_LIMIT),
          count: Math.min(30, plan.need + 6), // headroom for dedupe attrition
        });
        let addedCount = 0;
        if (texts.length > 0) {
          const vecs = await embedTexts(ai, this.env.EMBED_MODEL, texts);
          // stamp with the generation start time so a pin that landed mid-flight
          // correctly marks this batch stale
          const { added, rejected } = this.core.addCandidates(
            plan.bucket,
            texts.map((text, i) => ({ text, embedding: vecs[i]! })),
            genStart,
          );
          addedCount = added.length;
          this.persistBucket(plan.bucket);
          console.log(
            JSON.stringify({
              level: "info",
              message: "pump generated",
              bucket: plan.bucket,
              added: added.length,
              rejected: rejected.length,
              ms: Date.now() - genStart,
            }),
          );
        }
        // a generation that yields nothing new counts as a soft failure so the
        // alarm backs off instead of spinning on a model that repeats itself
        this.pumpFailures = addedCount > 0 ? 0 : this.pumpFailures + 1;
      } else {
        this.pumpFailures = 0;
      }
    } catch (error) {
      this.pumpFailures++;
      console.error(
        JSON.stringify({ level: "error", message: "generation pump failed", failures: this.pumpFailures, error: String(error) }),
      );
    } finally {
      this.pumping = false;
    }

    if (this.core.genPlan(Date.now())) {
      const delay = Math.min(PUMP_RETRY_MAX_MS, PUMP_RETRY_BASE_MS * 2 ** this.pumpFailures);
      await this.ensurePump(delay);
    }
  }

  private async ensurePump(delayMs: number): Promise<void> {
    const target = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > target) await this.ctx.storage.setAlarm(target);
  }

  private aiRunner(): AiRunner {
    // dev-only escape hatch for local runtimes with no egress; see dev-fake-ai.ts
    if ((this.env as Env & { DEV_FAKE_AI?: string }).DEV_FAKE_AI === "1") {
      this.devFakeAi ??= fakeAiRunner();
      return this.devFakeAi;
    }
    const ai = this.env.AI;
    return {
      run: (model, inputs) => ai.run(model as Parameters<typeof ai.run>[0], inputs as Parameters<typeof ai.run>[1]),
    };
  }

  // ---- persistence --------------------------------------------------------------

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pool (
        text TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        embedding BLOB NOT NULL,
        seed_dist REAL NOT NULL,
        generated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchors (
        text TEXT PRIMARY KEY,
        tier INTEGER NOT NULL,
        embedding BLOB,
        pinned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exclude (text TEXT PRIMARY KEY, served_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evaporated (text TEXT PRIMARY KEY, tier INTEGER NOT NULL, evaporated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS axes (
        id TEXT PRIMARY KEY,
        neg_term TEXT NOT NULL,
        neg_phrase TEXT NOT NULL,
        neg_expanded INTEGER NOT NULL,
        neg_embedding BLOB,
        pos_term TEXT NOT NULL,
        pos_phrase TEXT NOT NULL,
        pos_expanded INTEGER NOT NULL,
        pos_embedding BLOB,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private hydrate(): void {
    const meta = new Map(
      this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta").toArray().map((r) => [r.key, r.value]),
    );
    this.meta = meta.has("meta") ? (JSON.parse(meta.get("meta")!) as Meta) : null;

    const candidates: Candidate[] = this.ctx.storage.sql
      .exec<{ text: string; bucket: string; embedding: ArrayBuffer; seed_dist: number; generated_at: number }>(
        "SELECT text, bucket, embedding, seed_dist, generated_at FROM pool",
      )
      .toArray()
      .map((r) => ({
        text: r.text,
        bucket: r.bucket as BucketKey,
        embedding: fromBlob(r.embedding),
        seedDist: r.seed_dist,
        generatedAt: r.generated_at,
      }));

    const anchors: Anchor[] = this.ctx.storage.sql
      .exec<{ text: string; tier: number; embedding: ArrayBuffer | null; pinned_at: number }>(
        "SELECT text, tier, embedding, pinned_at FROM anchors",
      )
      .toArray()
      .map((r) => ({
        text: r.text,
        tier: r.tier as Tier,
        embedding: r.embedding ? fromBlob(r.embedding) : null,
        pinnedAt: r.pinned_at,
      }));

    const exclude = this.ctx.storage.sql
      .exec<{ text: string; served_at: number }>("SELECT text, served_at FROM exclude ORDER BY served_at ASC, rowid ASC")
      .toArray()
      .map((r) => ({ text: r.text, servedAt: r.served_at }));

    const evaporated: EvaporatedWord[] = this.ctx.storage.sql
      .exec<{ text: string; tier: number; evaporated_at: number }>(
        "SELECT text, tier, evaporated_at FROM evaporated ORDER BY evaporated_at DESC",
      )
      .toArray()
      .map((r) => ({ text: r.text, tier: r.tier as Tier, evaporatedAt: r.evaporated_at }));

    const axes: Axis[] = this.ctx.storage.sql
      .exec<{
        id: string; neg_term: string; neg_phrase: string; neg_expanded: number; neg_embedding: ArrayBuffer | null;
        pos_term: string; pos_phrase: string; pos_expanded: number; pos_embedding: ArrayBuffer | null; created_at: number;
      }>(
        "SELECT id, neg_term, neg_phrase, neg_expanded, neg_embedding, pos_term, pos_phrase, pos_expanded, pos_embedding, created_at FROM axes",
      )
      .toArray()
      // Blobs decode here; the column <-> Axis mapping itself lives in
      // axis-core.ts, where it is round-trip tested without a DO harness.
      .map((r) =>
        axisFromRow({
          ...r,
          neg_embedding: r.neg_embedding ? fromBlob(r.neg_embedding) : null,
          pos_embedding: r.pos_embedding ? fromBlob(r.pos_embedding) : null,
        }),
      );

    this.core = new PoolCore({
      params: meta.has("params") ? JSON.parse(meta.get("params")!) : undefined,
      seedEmbedding: meta.has("seedEmbedding") ? JSON.parse(meta.get("seedEmbedding")!) : null,
      invalidatedAt: hydrateInvalidation(meta.get("invalidatedAt")),
      candidates,
      anchors,
      exclude,
      evaporated,
      axes,
    });
  }

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  private persistInvalidation(): void {
    // Per-bucket stamps serialize as a small JSON object in the single meta key.
    this.putMeta("invalidatedAt", JSON.stringify(this.core.getInvalidatedAt()));
  }

  private persistBucket(bucket: BucketKey): void {
    this.ctx.storage.sql.exec("DELETE FROM pool WHERE bucket = ?", bucket);
    for (const c of this.core.serialize().candidates.filter((c) => c.bucket === bucket)) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO pool (text, bucket, embedding, seed_dist, generated_at) VALUES (?, ?, ?, ?, ?)",
        c.text,
        c.bucket,
        toBlob(c.embedding),
        c.seedDist,
        c.generatedAt,
      );
    }
  }

  private persistAnchors(): void {
    this.ctx.storage.sql.exec("DELETE FROM anchors");
    for (const a of this.core.anchors()) {
      this.ctx.storage.sql.exec(
        "INSERT INTO anchors (text, tier, embedding, pinned_at) VALUES (?, ?, ?, ?)",
        a.text,
        a.tier,
        a.embedding ? toBlob(a.embedding) : null,
        a.pinnedAt,
      );
    }
  }

  private persistAxes(): void {
    this.ctx.storage.sql.exec("DELETE FROM axes");
    for (const a of this.core.axes()) {
      const row = axisToRow(a);
      this.ctx.storage.sql.exec(
        "INSERT INTO axes (id, neg_term, neg_phrase, neg_expanded, neg_embedding, pos_term, pos_phrase, pos_expanded, pos_embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.neg_term,
        row.neg_phrase,
        row.neg_expanded,
        row.neg_embedding ? toBlob(row.neg_embedding) : null,
        row.pos_term,
        row.pos_phrase,
        row.pos_expanded,
        row.pos_embedding ? toBlob(row.pos_embedding) : null,
        row.created_at,
      );
    }
  }

  private persistEvaporated(): void {
    this.ctx.storage.sql.exec("DELETE FROM evaporated");
    for (const e of this.core.evaporated()) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO evaporated (text, tier, evaporated_at) VALUES (?, ?, ?)",
        e.text,
        e.tier,
        e.evaporatedAt,
      );
    }
  }

  // ---- shapes ---------------------------------------------------------------------

  private publicAnchors(): SessionInfo["anchors"] {
    return this.core.anchors().map((a) => ({ text: a.text, tier: a.tier, pinnedAt: a.pinnedAt }));
  }

  private info(): SessionInfo {
    const meta = this.meta!;
    return {
      id: meta.id,
      seed: meta.seed,
      createdAt: meta.createdAt,
      params: this.core.getParams(),
      anchors: this.publicAnchors(),
      evaporated: this.core.evaporated(),
      depths: this.core.depths(),
    };
  }
}
