// Pure projection math for user-named semantic axes. No bindings, no storage,
// no I/O — the SessionDO supplies embeddings and persists the results.
//
// An axis is a PAIR of poles (pos - neg), not a single term: measured mean AUC
// 0.843 vs 0.763. See docs/latent-space-navigation-design.md.

import { cosineSim } from "./pool-core";
import { MAX_POLE_TERM_CHARS } from "./types";

/** Direction from the negative pole to the positive pole. */
export function axisVector(neg: number[], pos: number[]): number[] {
  const n = Math.min(neg.length, pos.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = pos[i]! - neg[i]!;
  return out;
}

/** One raw cosine per axis, in axis order. Raw on purpose: the useful range is
 *  narrow (sd ~0.05-0.07 near zero) and normalization depends on the visible
 *  set, which only the client knows. cosineSim returns 0 for a zero vector, so
 *  a degenerate axis yields 0 rather than NaN. */
export function coordsFor(vec: number[], axisVecs: number[][]): number[] {
  return axisVecs.map((av) => cosineSim(vec, av));
}

/** Min-max onto 0..1 for layout. A degenerate range centers rather than
 *  dividing by zero. Mirrored in public/axes.js for the client. */
export function normalizeCoords(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span === 0) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / span);
}

/** Both poles of an axis. Identical poles are rejected: pos - neg would be the
 *  zero vector, which projects everything to 0 — a silently dead axis. Lives
 *  here rather than in index.ts so it is testable without pulling in the
 *  Durable Object and its cloudflare:workers import. */
export function parsePoleTerms(body: Record<string, unknown>): { negTerm: string; posTerm: string } | null {
  const neg = body.negTerm;
  const pos = body.posTerm;
  if (typeof neg !== "string" || typeof pos !== "string") return null;
  const negTerm = neg.trim();
  const posTerm = pos.trim();
  if (!negTerm || !posTerm) return null;
  if (negTerm.length > MAX_POLE_TERM_CHARS || posTerm.length > MAX_POLE_TERM_CHARS) return null;
  if (negTerm.toLowerCase() === posTerm.toLowerCase()) return null;
  return { negTerm, posTerm };
}
