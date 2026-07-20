// Pure projection math for user-named semantic axes. No bindings, no storage,
// no I/O — the SessionDO supplies embeddings and persists the results.
//
// An axis is a PAIR of poles (pos - neg), not a single term: measured mean AUC
// 0.843 vs 0.763. See docs/latent-space-navigation-design.md.

import { cosineSim } from "./pool-core";
import { DEGENERATE_POLE_COSINE, MAX_POLE_TERM_CHARS, type Axis } from "./types";

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

/** The `axes` table's column shape, with embeddings already decoded from their
 *  BLOBs. Blob encode/decode stays in session-do.ts so this module keeps no
 *  storage dependency and the mapping below stays testable without a DO. */
export interface AxisRow {
  id: string;
  neg_term: string;
  neg_phrase: string;
  neg_expanded: number;
  neg_embedding: number[] | null;
  pos_term: string;
  pos_phrase: string;
  pos_expanded: number;
  pos_embedding: number[] | null;
  created_at: number;
}

/** Row -> Axis. The `expanded` conversion is the load-bearing part: SQLite has
 *  no boolean, and inverting either direction silently flips `degraded` for
 *  every axis on session resume. Round-tripped in test/axis-core.test.ts. */
export function axisFromRow(row: AxisRow): Axis {
  return {
    id: row.id,
    neg: {
      term: row.neg_term,
      phrase: row.neg_phrase,
      expanded: row.neg_expanded !== 0,
      embedding: row.neg_embedding,
    },
    pos: {
      term: row.pos_term,
      phrase: row.pos_phrase,
      expanded: row.pos_expanded !== 0,
      embedding: row.pos_embedding,
    },
    createdAt: row.created_at,
  };
}

/** Axis -> row. The exact inverse of axisFromRow. */
export function axisToRow(axis: Axis): AxisRow {
  return {
    id: axis.id,
    neg_term: axis.neg.term,
    neg_phrase: axis.neg.phrase,
    neg_expanded: axis.neg.expanded ? 1 : 0,
    neg_embedding: axis.neg.embedding,
    pos_term: axis.pos.term,
    pos_phrase: axis.pos.phrase,
    pos_expanded: axis.pos.expanded ? 1 : 0,
    pos_embedding: axis.pos.embedding,
    created_at: axis.createdAt,
  };
}

/** True when two pole embeddings are similar enough that `pos - neg` is
 *  effectively the zero vector — see DEGENERATE_POLE_COSINE in types.ts for
 *  what this catches (poles that expanded to identical/near-identical text)
 *  and what it cannot (paraphrases that merely mean the same thing; cosine
 *  can't separate those from legitimate antonym axes). Pulled out of
 *  SessionDO.createAxis as a pure predicate so it is testable without a DO
 *  harness: test/axis-core.test.ts drives it with synthetic unit vectors
 *  (identical, orthogonal, and a measured near-threshold pair), no embedding
 *  call of any kind required. */
export function isDegeneratePole(negEmbedding: number[], posEmbedding: number[]): boolean {
  return cosineSim(negEmbedding, posEmbedding) > DEGENERATE_POLE_COSINE;
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
