// Rewrite scoring for the conveyor board.
//
// A direction needs two poles. THE PARENT CARD IS THE NEGATIVE POLE and the
// station phrase is the positive one, so the intended move is
// `phrase - parent` and a candidate is judged by how much of its own
// displacement lands along it. This keeps the pair construction the axis spike
// measured at mean AUC 0.843 against 0.763 for a single term — scoring
// candidates against the phrase embedding alone is the weaker construction and
// looks identical from the outside.

import { axisVector, coordsFor } from "../axis-core";
import { parseCandidateList, type AiRunner, type ChatMessage } from "../generation";
import { cosineSim } from "../pool-core";
import { DEDUPE_COSINE } from "../types";
import { ARRIVAL_COSINE, TETHER_FLOOR } from "./types";

export interface Candidate {
  text: string;
  embedding: number[];
}

export interface ScoredCandidate extends Candidate {
  /** COSINE between the candidate's displacement from the parent
   *  (`candidate - parent`) and the intended direction (`phrase - parent`):
   *  alignment, not distance. Served raw, exactly as `coordsFor` serves the
   *  field.
   *
   *  FOR UNIT-NORMALIZED EMBEDDINGS IT IS MONOTONE IN TRAVEL, so a higher
   *  score does also mean further. A candidate that has travelled θ from the
   *  parent at off-aim angle φ scores (sin(θ/2) + cos(θ/2)·cos φ)/√2, which
   *  rises with θ for every φ as long as the tether stays non-negative:
   *  verified over a (θ ≤ 90°, φ) grid at 1°/5° resolution, zero
   *  counterexamples. It DOES turn over past a quarter-turn (2185
   *  counterexamples out to θ = 179°), but that is the negative-tether region,
   *  which TETHER_FLOOR rejects long before — at 0.5 it confines candidates to
   *  θ ≤ 60°, well inside. Along the aimed great circle the formula reduces to
   *  sin(45° + θ/2): measured 0.7373 at tether 0.9962 through to 1.0000 at
   *  tether 0.0000.
   *
   *  The reason is geometric — a small displacement from a unit vector is
   *  necessarily tangential, so its alignment with `phrase - parent` is
   *  floored at 1/√2 ≈ 0.707. A 1° nudge scores 0.713 and loses to a 70°
   *  traveller that is 15° off-aim (0.965). On the sphere the crawler cannot
   *  win.
   *
   *  IT CAN WIN OFF THE SPHERE: `parent + 0.001·(phrase - parent)`, magnitude
   *  0.9993, scores a perfect 1.0000. So "higher means further" is not a
   *  property of this formula, it is a property of the formula PLUS
   *  unit-normalized inputs. `bge-m3` returns normalized vectors, so the crawl
   *  pathology is not expected in practice — but NOTHING IN THIS REPO
   *  NORMALIZES OR ASSERTS EMBEDDING MAGNITUDE, and no doc records the
   *  assumption. That unpinned assumption is the real hazard: an embedding
   *  source returning unnormalized vectors would silently flip what this rule
   *  selects for, from "moved furthest" to "moved least, most precisely", with
   *  no error anywhere. test/board-rewrite.test.ts pins the unit-vector
   *  behaviour so the assumption is at least checked; whether alignment
   *  selection makes a chain progress rather than crawl on real embeddings is
   *  measured by scripts/board-calibrate.ts.
   *
   *  The tether is a separate floor rather than a term in this score because
   *  on the unit sphere the two are in direct opposition — score rises exactly
   *  as tether falls — so they must stay independently tunable. */
  score: number;
  /** Cosine against the parent. Low means the "rewrite" drifted off-topic. */
  tether: number;
}

/** Embeddings meet here from two different eras: the station phrase and the
 *  lineage's own history are read back from storage as float32 blobs, while a
 *  candidate's embedding was computed moments ago. Both `axisVector` and
 *  `cosineSim` silently truncate to the shorter of their inputs, so a 1024-dim
 *  persisted vector against a 384-dim fresh one returns a confident number
 *  computed on a prefix — measured score -0.749 with tether 0.993, sailing
 *  over the floor on meaningless math. `EMBED_MODEL` is a plain var in
 *  wrangler.jsonc with no data migration behind it, so swapping models is a
 *  one-line change.
 *
 *  This THROWS rather than skipping the offending candidate, deliberately.
 *  Every embedding on a board comes from the single configured model, so a
 *  mismatch is never a property of one bad candidate — it is a configuration
 *  or migration fault that has already corrupted the whole board. Rejecting
 *  the candidate would launder that global fault into a per-hop quality
 *  signal: lineages would fail hops, reach MAX_HOP_FAILURES and release at the
 *  edge, which is indistinguishable from the model simply writing bad
 *  rewrites. The board would look alive and be wrong. A throw cannot be
 *  mistaken for anything else, and it costs nothing while the invariant holds,
 *  which for a correctly configured board is always. */
function assertSameDim(expected: number, actual: number, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `board scoring: ${what} has ${actual} dimensions, expected ${expected} (embedding model mismatch?)`,
    );
  }
}

export function scoreCandidates(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
): ScoredCandidate[] {
  const dim = parentEmb.length;
  assertSameDim(dim, phraseEmb.length, "the station phrase embedding");
  const stationVec = axisVector(parentEmb, phraseEmb);
  return candidates.map((c) => {
    assertSameDim(dim, c.embedding.length, `candidate "${c.text}"`);
    return {
      ...c,
      score: coordsFor(axisVector(parentEmb, c.embedding), [stationVec])[0] ?? 0,
      tether: cosineSim(c.embedding, parentEmb),
    };
  });
}

export interface SelectOptions {
  tetherFloor?: number;
  dedupeCosine?: number;
  /** Embeddings the child must not near-duplicate: the lineage's own history
   *  plus anything else the caller wants excluded. */
  exclude?: number[][];
}

/** Highest-scoring candidate that clears the tether floor and duplicates
 *  nothing excluded. Returns null when none qualify — the caller retries or
 *  releases the lineage. It must NEVER lower the floor to find a winner; that
 *  turns a quality guard into a no-op. */
export function selectChild(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
  opts: SelectOptions = {},
): ScoredCandidate | null {
  const floor = opts.tetherFloor ?? TETHER_FLOOR;
  const dedupe = opts.dedupeCosine ?? DEDUPE_COSINE;
  const exclude = opts.exclude ?? [];
  for (const e of exclude) assertSameDim(parentEmb.length, e.length, "an excluded embedding");
  let best: ScoredCandidate | null = null;
  // Seeded at -Infinity rather than at the first candidate. `best === null ||
  // c.score > best.score` takes candidate 0 unconditionally, and a non-finite
  // score there is then undisplaceable — every later `c.score > NaN` is false
  // — so one malformed embedding at index 0 silently discards every valid
  // candidate behind it. Against -Infinity a NaN never wins, and neither does
  // a -Infinity, which is the correct answer for both.
  let bestScore = -Infinity;
  for (const c of scoreCandidates(parentEmb, phraseEmb, candidates)) {
    // Reject non-finite outright, BEFORE the guards below. NaN fails every
    // comparison, so `c.tether < floor` reads as satisfied for a NaN tether
    // and the floor admits it — a quality guard turned into a no-op, which is
    // exactly what this function must never do.
    if (!Number.isFinite(c.score) || !Number.isFinite(c.tether)) continue;
    if (c.tether < floor) continue;
    // The dedupe check has the same shape and so needs the same treatment from
    // the other side: a non-finite similarity (a corrupt vector in `exclude`)
    // cannot demonstrate the candidate is distinct, so it fails closed. The
    // cost is a null return and a counted hop failure; the alternative is
    // silently readmitting the lineage's own history.
    if (exclude.some((e) => {
      const sim = cosineSim(e, c.embedding);
      return !Number.isFinite(sim) || sim > dedupe;
    })) continue;
    if (c.score > bestScore) {
      best = c;
      bestScore = c.score;
    }
  }
  return best;
}

/** True when the card has effectively reached the station's phrase, so this
 *  direction is exhausted for this idea. Not a failure — information.
 *
 *  Inclusive at the threshold, and pinned as such by test/board-rewrite.test.ts:
 *  ARRIVAL_COSINE is scheduled for recalibration in M0, which is precisely when
 *  an undetected `>`/`>=` flip would start to matter. Dimension-guarded for the
 *  same reason as scoreCandidates — a card embedded before an EMBED_MODEL swap
 *  meeting a station embedded after it would otherwise compare truncated
 *  prefixes and declare arrival (or refuse it) on nonsense. */
export function hasArrived(
  parentEmb: number[],
  phraseEmb: number[],
  arrivalCosine: number = ARRIVAL_COSINE,
): boolean {
  assertSameDim(parentEmb.length, phraseEmb.length, "the station phrase embedding");
  return cosineSim(parentEmb, phraseEmb) >= arrivalCosine;
}

export interface RewriteInputs {
  fragment: string;
  /** The station's expanded descriptive phrase, never its bare term. */
  target: string;
  count: number;
  exclude: string[];
}

const REWRITE_SYSTEM_PROMPT = `You rewrite a short fragment into a NEW short fragment that moves it toward a target quality while staying recognisably derived from it.

Rules:
- Respond with a JSON array of strings only. No prose, no code fences, no keys.
- Each item is 1-5 words. No sentences, no explanations.
- Every item must be a rewrite of the given fragment, carrying something of it forward. A new topic is a failure, however good it sounds.
- Move decisively toward the target. An item that would fit the original fragment equally well has not moved.
- Never repeat anything in the exclusion list, and avoid trivial variants of it.
- No duplicates within your answer.`;

/** Two demonstrations, from different domains so the model does not overfit to
 *  one, showing the move that matters: the child keeps the parent's subject and
 *  changes its character. */
const REWRITE_FEWSHOT: { inputs: RewriteInputs; out: string[] }[] = [
  {
    inputs: { fragment: "urban gardening", target: "a physical object you can touch", count: 5, exclude: [] },
    out: ["rooftop bee lease", "balcony planter boxes", "rain barrel", "window herb box", "sidewalk seed bomb"],
  },
  {
    inputs: { fragment: "security awareness training", target: "a mystical or magical practice", count: 5, exclude: [] },
    out: ["threat-model tarot deck", "phishing ouija board", "firewall gargoyles", "breach divination", "password incantation"],
  },
];

function rewritePayload(inputs: RewriteInputs): string {
  const payload = JSON.stringify({
    fragment: inputs.fragment,
    target: inputs.target,
    exclude: inputs.exclude,
    count: inputs.count,
  });
  return `${payload}\nReturn a JSON array of exactly ${inputs.count} strings. No other text.`;
}

export function buildRewriteMessages(inputs: RewriteInputs): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: REWRITE_SYSTEM_PROMPT }];
  for (const shot of REWRITE_FEWSHOT) {
    messages.push({ role: "user", content: rewritePayload(shot.inputs) });
    messages.push({ role: "assistant", content: JSON.stringify(shot.out) });
  }
  messages.push({ role: "user", content: rewritePayload(inputs) });
  return messages;
}

/** Temperature is fixed rather than banded: unlike the field, the board's
 *  variety comes from the station phrase, not from a strangeness slider. */
const REWRITE_TEMPERATURE = 0.9;

export async function generateRewrites(ai: AiRunner, model: string, inputs: RewriteInputs): Promise<string[]> {
  const result = await ai.run(model, {
    messages: buildRewriteMessages(inputs),
    temperature: REWRITE_TEMPERATURE,
    max_tokens: 512,
  });
  return parseCandidateList(extractRewriteResponse(result), inputs.count);
}

/** Mirrors generation.ts's envelope handling; kept local because that module
 *  does not export its version. */
function extractRewriteResponse(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result === "string" || Array.isArray(result)) return result;
  if (typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  if (obj.response !== undefined) return obj.response;
  const choices = obj.choices as { message?: { content?: unknown } }[] | undefined;
  if (Array.isArray(choices) && choices[0]?.message?.content !== undefined) return choices[0].message.content;
  if (obj.output_text !== undefined) return obj.output_text;
  if (obj.result !== undefined) return extractRewriteResponse(obj.result);
  return null;
}
