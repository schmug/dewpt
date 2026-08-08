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

// ── vector math and ranking metrics ────────────────────────────────────────

// These now live in eval-vec.ts, which must stay free of node APIs so tests can
// import it — this file reads process.env below. Re-exported here so the axis
// spikes keep their existing import site.
//
// auc: probability a random positive outranks a random negative (Mann-Whitney
// U); 1.0 = perfect ordering, 0.5 = chance. The spikes' headline number.
// cohensD: standardised mean difference — how far apart the two groups sit, in
// pooled standard deviations. AUC says "ordered correctly", d says "by a wide
// margin".
export { auc, cohensD, cosine, dot, mean, norm, sub } from "./eval-vec";

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
