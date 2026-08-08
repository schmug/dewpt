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
   *  field. That is the definition, and the only part of this comment that
   *  holds without qualification.
   *
   *  ITS ORDERING IS NOT GLOBALLY MONOTONE IN TRAVEL. Where a candidate ranks
   *  depends on three things, not one: the angle between parent and phrase, how
   *  far the candidate travelled, and whether the embeddings are
   *  unit-normalized. Earlier versions of this comment gave a closed form and a
   *  "higher means further" rule read off the orthogonal case alone; both were
   *  wrong away from it, so do not restate this as a formula. The regimes that
   *  are measured, each held by a named test in test/board-rewrite.test.ts:
   *
   *  - Phrase 90° from the parent, unit-normalized — monotone in travel:
   *    "scores further travel higher, for unit-normalized embeddings",
   *    "stays monotone in travel even for a badly aimed move".
   *  - Phrase 45° from the parent — not monotone: the score peaks when the
   *    candidate reaches the phrase and falls away past it, at a tether of
   *    0.500 that still clears TETHER_FLOOR: "is NOT monotone in travel once
   *    the phrase is not orthogonal to the parent", "picks the candidate AT the
   *    phrase, not the one that travelled furthest". ARRIVAL_COSINE = 0.9 lets
   *    a lineage run until the card is within acos(0.9) ≈ 26° of the phrase, so
   *    narrow pole angles are ordinary operation rather than a corner case.
   *  - Off the unit sphere — a 0.1% move outscores a 60° one: "lets a
   *    barely-moved candidate outscore a real traveller off the unit sphere".
   *
   *  Outside those three the ordering is unmeasured; do not assume it. NOTHING
   *  IN THIS REPO NORMALIZES OR ASSERTS EMBEDDING MAGNITUDE and no doc records
   *  the assumption, which is what keeps the third case reachable rather than
   *  theoretical.
   *
   *  The tether is a separate floor rather than a term in this score so the two
   *  stay independently tunable. */
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
 *  This THROWS rather than skipping the offending candidate. Every embedding on
 *  a board comes from the single configured model, so a mismatch is never a
 *  property of one bad candidate — it is a configuration or migration fault
 *  that has already corrupted the whole board.
 *
 *  Be exact about what the throw buys, though, because an earlier version of
 *  this comment was not: it buys a LOG LINE, not a distinguishable outcome. The
 *  planned caller (`pumpOnce`, in docs/superpowers/plans/) wraps the hop in a
 *  catch that logs and then calls `noteHopFailure` — so the lineage fails the
 *  hop, counts toward MAX_HOP_FAILURES and releases at the edge exactly as it
 *  would had this function quietly skipped the candidate. The difference is
 *  that `console.error` names the fault, where a skip would be silent and the
 *  board would merely look uninspired. Keep the throw for the diagnostic, not
 *  for a control-flow property it does not have. */
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
    //
    // THE TETHER HALF IS LOAD-BEARING AND THE -Infinity SEED DOES NOT SUBSUME
    // IT: a score can be finite and near-maximal while the tether is NaN, so
    // the seed lets that candidate win. Pinned by "rejects a NaN tether that
    // arrives with a finite, near-maximal score". The score half is defence in
    // depth and is NOT independently pinned — a non-finite cosine here can only
    // be NaN or -Infinity, and neither beats the seed.
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
