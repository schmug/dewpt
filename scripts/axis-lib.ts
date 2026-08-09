// Shared harness for the axis-projection spikes (axis-spike.ts,
// axis-phrasing-spike.ts). Vector math, ranking metrics, and a REST embedder.
//
// REST-from-node rather than a Worker binding, matching calibrate.ts — that
// path is unaffected by the local wrangler-dev egress issues.

export const EMBED_MODEL = "@cf/baai/bge-m3";
const EMBED_CHUNK = 96;

/** Words unrelated to any tested axis. They should land mid-range; if they
 *  colonise a pole, the projection is responding to something other than the
 *  named dimension. Treat as a diagnostic hint, not a metric — unlabelled words
 *  do have genuine positions on these axes. */
export const DISTRACTORS = [
  "tuesday", "saxophone", "photosynthesis", "cardigan", "referendum",
  "lighthouse", "gingham", "quarterly", "meridian", "porcelain",
  "tributary", "handshake", "linoleum", "monsoon", "escalator",
];

// ── vector math ────────────────────────────────────────────────────────────

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

export function sub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]!);
}

export function mean(vs: number[][]): number[] {
  const out = new Array(vs[0]!.length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i]!;
  return out.map((x) => x / vs.length);
}

export function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b) || 1);
}

// ── ranking metrics ────────────────────────────────────────────────────────
// Re-exported from src/metrics.ts, which band-spike.ts also uses. One AUC in
// the codebase, so two spikes cannot disagree about what the number means.

export { auc, cohensD } from "../src/metrics";

// ── Workers AI ─────────────────────────────────────────────────────────────

export function requireCreds(): { accountId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment");
    console.error('the API token needs the "Workers AI - Read" permission');
    process.exit(1);
  }
  return { accountId, token };
}

export async function embedTexts(accountId: string, token: string, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const chunk = texts.slice(i, i + EMBED_CHUNK);
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBED_MODEL}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: chunk }),
    });
    const body = (await res.json()) as {
      success: boolean;
      result?: { data?: number[][] };
      errors?: { message: string }[];
    };
    if (!res.ok || !body.success) {
      const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new Error(`embed failed: ${detail}`);
    }
    const data = body.result?.data;
    if (!Array.isArray(data) || data.length !== chunk.length) {
      throw new Error(`expected ${chunk.length} vectors, got ${Array.isArray(data) ? data.length : "none"}`);
    }
    out.push(...data);
  }
  return out;
}
