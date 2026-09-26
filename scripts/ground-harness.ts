// Shared plumbing for ground spikes written after 2026-09-25: runner choice,
// the request cap, the production-parity pool, the judge call, and the ground
// layout. Lifted verbatim from scripts/ground-spike.ts, which keeps its own
// frozen copies because it is the instrument behind a committed measurement
// (docs/measurements/2026-09-24-sky-and-ground-spike.md). Pure judge helpers
// live in scripts/ground-judge.ts.

import { embedTexts, generateCandidates, type AiRunner, type ChatMessage } from "../src/generation";
import { fakeAiRunner } from "../src/dev-fake-ai";
import { cosineSim } from "../src/pool-core";
import { ALT_ABSTRACTION, BUCKET_KEYS, DEDUPE_COSINE, TIER_STRANGENESS, type Alt, type BucketKey, type Tier } from "../src/types";
import { parsePick } from "./ground-judge";
import { bindingRunner, cloudflareRunner, CF_EMBED_MODEL, CF_GEN_MODEL } from "./runner-lib";

export const BANDS = BUCKET_KEYS.map((bucket) => ({
  bucket,
  strangeness: TIER_STRANGENESS[Number(bucket[1]) as Tier],
  altitude: ALT_ABSTRACTION[Number(bucket[3]) as Alt],
}));
export const PER_BAND = 24;

/** Cluster centres on the ground, 400 units apart; NEIGHBOR_RADIUS is 240 and
 *  notes sit within ~70 of their centre, so a prospect at one centre reaches
 *  only that cluster. The outer two are 800 apart. */
export const CENTRES = [{ x: 200, y: 210 }, { x: 600, y: 210 }, { x: 1000, y: 210 }];
export const OFFSETS = [{ x: -60, y: -30 }, { x: 40, y: 10 }, { x: -20, y: 50 }];

/** `--fake` → dev-fake-ai; `--binding` → wrangler's remote AI binding (Access
 *  + OAuth, pause WARP); otherwise Workers AI REST with CLOUDFLARE_ACCOUNT_ID /
 *  CLOUDFLARE_API_TOKEN. Exits with a message if REST creds are missing. */
export async function spikeRunner(flags: Map<string, string>): Promise<{ ai: AiRunner; via: string; dispose?: () => Promise<void> }> {
  if (flags.has("fake")) return { ai: fakeAiRunner(), via: "FAKE" };
  if (flags.has("binding")) {
    const { ai, dispose } = await bindingRunner();
    return { ai, via: "remote AI binding", dispose };
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI - Read), or pass --binding, or --fake for a plumbing check");
    process.exit(1);
  }
  return { ai: cloudflareRunner(accountId, token), via: "REST" };
}

/** Counts every model call and refuses the one past `max`, so a run cannot
 *  overspend the shared Workers AI budget. */
export function requestCap(ai: AiRunner, max: number): { ai: AiRunner; spent: () => number } {
  let requests = 0;
  return {
    ai: {
      run(model, inputs) {
        if (requests >= max) throw new Error(`request cap ${max} reached — stopping, not overspending`);
        requests++;
        return ai.run(model, inputs);
      },
    },
    spent: () => requests,
  };
}

function extract(result: unknown): unknown {
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r?.response === "string") return r.response;
  return r?.choices?.[0]?.message?.content;
}

export interface Pool { texts: string[]; embs: number[][]; buckets: BucketKey[] }

/** Seed-only generation over the six production bands, embedded and deduped at
 *  DEDUPE_COSINE — production parity. `exclude` keeps the notes themselves out. */
export async function buildPool(ai: AiRunner, seed: string, exclude: string[]): Promise<Pool> {
  const seen = new Set(exclude.map((t) => t.trim().toLowerCase()));
  const texts: string[] = [];
  const buckets: BucketKey[] = [];
  for (const band of BANDS) {
    const out = await generateCandidates(ai, CF_GEN_MODEL, {
      seed, strangeness: band.strangeness, altitude: band.altitude, anchors: [], exclude: [], count: PER_BAND,
    });
    for (const t of out) {
      const key = t.trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); texts.push(t.trim()); buckets.push(band.bucket); }
    }
  }
  const raw = await embedTexts(ai, CF_EMBED_MODEL, texts);
  const kept: Pool = { texts: [], embs: [], buckets: [] };
  for (let i = 0; i < texts.length; i++) {
    if (kept.embs.some((e) => cosineSim(e, raw[i]!) > DEDUPE_COSINE)) continue;
    kept.texts.push(texts[i]!);
    kept.embs.push(raw[i]!);
    kept.buckets.push(buckets[i]!);
  }
  console.log(`  pool: ${texts.length} raw -> ${kept.texts.length} kept at cosine > ${DEDUPE_COSINE}`);
  return kept;
}

/** The blind judge: one forced-choice call, retried once on a malformed answer,
 *  then null (the caller counts it as a miss). With `fake` it is a coin — the
 *  plumbing check makes no judge calls. */
export function makeJudge(ai: AiRunner, fake: boolean, rand: () => number) {
  return async (messages: ChatMessage[], key: "group" | "choice", n: number): Promise<number | null> => {
    if (fake) return Math.floor(rand() * n);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.run(CF_GEN_MODEL, { messages, temperature: 0.1, max_tokens: 32 });
        const pick = parsePick(extract(res), key, n);
        if (pick !== null) return pick;
      } catch (err) {
        if (String(err).includes("request cap")) throw err;
      }
    }
    return null;
  };
}
