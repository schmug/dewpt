// Pure pieces of the Marginalia pool-reuse spike (scripts/marginalia-spike.ts):
// its pre-registered bars and verdict, rotation scoring, the judge prompt, and
// the seed cut. Shared helpers (binomTail, parsePick) live in
// scripts/ground-judge.ts; positionMaxTail in scripts/ground-prospect-judge.ts.
//
// Rotation, not shuffling: the llama-3.3-70b judge leaned toward display
// position 2 in both ground spikes. Every trial is therefore asked once in each
// cyclic rotation of its three options, and scored by majority. A judge that
// answers by position picks each option once and never wins a trial.

import type { ChatMessage } from "../src/generation";
import type { Verdict } from "./ground-judge";

// ── pre-registered verdict ──────────────────────────────────────────────────
// Fixed 2026-09-26, BEFORE any real run of this spike (plan:
// .claude/plans/marginalia-pool-reuse.md). Do not tune after seeing data;
// change these only in a commit that says so and why, with Cory's sign-off.

export const MARGINALIA_PASS = {
  /** Correct trials needed: the words drawn for paragraph k are placed beside
   *  paragraph k in a majority of rotations, for >= 8 of 15 trials (5 essays x
   *  moves to paragraphs 2, 3, 4). Under a uniform judge a trial is correct with
   *  p0 = majorityChance(3, 3) = 7/27, and P(X >= 8 | n=15, p0) = 0.0215. */
  correctMin: 8,
  trials: 15,
  /** Instrument validity, not a pass bar. If any display position takes >= 24
   *  of the 45 judge calls the run is INVALID. Under a judge uniform over
   *  positions the chance of that is positionMaxTail(24, 45, 3) = 0.0134. */
  positionMax: 24,
} as const;

/** Position -> option index, one row per rotation. Each option sits in each
 *  position exactly once (a cyclic Latin square). */
export const ROTATIONS: readonly (readonly number[])[] = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];

/** P(one option wins a strict majority of `rotations` independent uniform
 *  picks among `options`). For 3 and 3 that is 7/27. */
export function majorityChance(options: number, rotations: number): number {
  const p = 1 / options;
  let total = 0, logC = 0;
  for (let i = 0; i <= rotations; i++) {
    if (i > 0) logC += Math.log(rotations - i + 1) - Math.log(i);
    if (2 * i > rotations) total += Math.exp(logC + i * Math.log(p) + (rotations - i) * Math.log(1 - p));
  }
  return total;
}

/** `votes` are the option indices the judge chose, one per rotation (null =
 *  unjudged, a vote for nothing). Correct when the target wins a strict majority. */
export function trialCorrect(votes: readonly (number | null)[], target: number): boolean {
  return votes.filter((v) => v === target).length * 2 > votes.length;
}

export function marginaliaVerdict(t: { correct: number; byPosition: number[] }): Verdict {
  const maxP = Math.max(0, ...t.byPosition);
  const calls = MARGINALIA_PASS.trials * ROTATIONS.length;
  if (maxP >= MARGINALIA_PASS.positionMax) {
    return { outcome: "INVALID", reasons: [`judge answered one position ${maxP}/${calls} times — position-driven, not content-driven`] };
  }
  if (t.correct < MARGINALIA_PASS.correctMin) {
    return { outcome: "FAIL", reasons: [`${t.correct}/${MARGINALIA_PASS.trials} trials correct < ${MARGINALIA_PASS.correctMin}`] };
  }
  return { outcome: "PASS", reasons: [] };
}

// ── judge prompt ────────────────────────────────────────────────────────────
// Blind: the judge sees three paragraphs and five words, never how the words
// were chosen or which paragraph came first.

const PARAGRAPH_SYSTEM = `You look at a draft someone is writing.

Three of its paragraphs are shown, numbered. A few words appeared in the margin, right beside ONE of them.
Decide which paragraph the words appeared beside — the paragraph they most belong with.

Respond with JSON only, exactly: {"choice": N} where N is the paragraph number. No prose, no code fences.`;

export function paragraphMessages(paragraphs: readonly string[], words: readonly string[]): ChatMessage[] {
  const p = paragraphs.map((t, i) => `Paragraph ${i + 1}: ${t}`).join("\n\n");
  return [
    { role: "system", content: PARAGRAPH_SYSTEM },
    { role: "user", content: `${p}\n\nWords in the margin: ${words.join("; ")}\n\nWhich paragraph? Reply {"choice": N}.` },
  ];
}

// ── seed ────────────────────────────────────────────────────────────────────

/** Production parity: /api/session caps a seed at MAX_SEED_CHARS = 200
 *  (src/index.ts). Cut the paragraph at the last sentence end within `max`;
 *  failing that, at the last word boundary. */
export function seedFrom(paragraph: string, max = 200): string {
  const text = paragraph.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) if (m.index! + 1 <= max) cut = m.index! + 1;
  if (cut > 0) return text.slice(0, cut);
  const space = text.lastIndexOf(" ", max);
  return (space > 0 ? text.slice(0, space) : text.slice(0, max)).trim();
}
