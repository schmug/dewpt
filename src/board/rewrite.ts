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
  /** COSINE between the candidate's displacement and the intended direction —
   *  alignment, not distance. Higher means better aimed, NOT further travelled:
   *  a tiny nudge exactly along `phrase - parent` outscores a large, mostly
   *  aligned move. That is deliberate (it is also what `coordsFor` does for the
   *  field, raw on purpose), and it is why the tether floor is a floor rather
   *  than part of the score — the two pull in opposite directions and must stay
   *  separable. Whether alignment-only selection actually makes a chain
   *  progress rather than crawl is measured by scripts/board-calibrate.ts. */
  score: number;
  /** Cosine against the parent. Low means the "rewrite" drifted off-topic. */
  tether: number;
}

export function scoreCandidates(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
): ScoredCandidate[] {
  const stationVec = axisVector(parentEmb, phraseEmb);
  return candidates.map((c) => ({
    ...c,
    score: coordsFor(axisVector(parentEmb, c.embedding), [stationVec])[0] ?? 0,
    tether: cosineSim(c.embedding, parentEmb),
  }));
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
  let best: ScoredCandidate | null = null;
  for (const c of scoreCandidates(parentEmb, phraseEmb, candidates)) {
    if (c.tether < floor) continue;
    if (exclude.some((e) => cosineSim(e, c.embedding) > dedupe)) continue;
    if (best === null || c.score > best.score) best = c;
  }
  return best;
}

/** True when the card has effectively reached the station's phrase, so this
 *  direction is exhausted for this idea. Not a failure — information. */
export function hasArrived(
  parentEmb: number[],
  phraseEmb: number[],
  arrivalCosine: number = ARRIVAL_COSINE,
): boolean {
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
