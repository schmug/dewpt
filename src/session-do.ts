// One SessionDO per dewpt session. Holds the seed, params, anchors, candidate
// pool, exclude LRU and evaporated ring buffer (all via PoolCore), and runs
// alarm-driven background generation. Serving never waits on generation: draw
// answers from whatever is pooled and the alarm pump refills behind it.

import { DurableObject } from "cloudflare:workers";
import { fakeAiRunner } from "./dev-fake-ai";
import { embedTexts, generateCandidates, type AiRunner } from "./generation";
import { PoolCore } from "./pool-core";
import {
  ALT_ABSTRACTION,
  TIER_STRANGENESS,
  bucketAlt,
  bucketTier,
  type Anchor,
  type BucketKey,
  type Candidate,
  type DewptParams,
  type EvaporatedWord,
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

function fromBlob(blob: ArrayBuffer): number[] {
  return Array.from(new Float32Array(blob));
}

export class SessionDO extends DurableObject<Env> {
  private core!: PoolCore;
  private meta: Meta | null = null;
  private pumping = false;
  private pumpFailures = 0;
  private devFakeAi: AiRunner | null = null;

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
      this.putMeta("invalidatedAt", "0");
      await this.ensurePump(0);
    }
    return this.info();
  }

  async getInfo(): Promise<SessionInfo | null> {
    return this.meta ? this.info() : null;
  }

  /** Serve candidates from a bucket. Never generates inline. */
  async drawPool(
    bucket: BucketKey,
    count: number,
  ): Promise<{ condensed: Served[]; depths: SessionInfo["depths"] } | null> {
    if (!this.meta) return null;
    const served = this.core.draw(bucket, count, Date.now());
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
    return { condensed: served, depths: this.core.depths() };
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

    this.core = new PoolCore({
      params: meta.has("params") ? JSON.parse(meta.get("params")!) : undefined,
      seedEmbedding: meta.has("seedEmbedding") ? JSON.parse(meta.get("seedEmbedding")!) : null,
      invalidatedAt: meta.has("invalidatedAt") ? Number(meta.get("invalidatedAt")) : 0,
      candidates,
      anchors,
      exclude,
      evaporated,
    });
  }

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  private persistInvalidation(): void {
    this.putMeta("invalidatedAt", String(this.core.serialize().invalidatedAt));
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
