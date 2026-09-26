// Pure logic for Marginalia's margin (/margin/): request parsing, the focus
// the SessionDO holds, and the query a margin draw ranks by. No bindings, no
// storage, no I/O.
//
// The premise (spec §2.E): the paragraph under the writer's caret conditions
// the margin, by RE-RANKING the pool the session already holds. The pool-reuse
// spike measured that this follows the writer into later paragraphs (11/15
// against a pre-registered bar of 8; docs/measurements/2026-09-26-marginalia-
// pool-reuse-spike.md). Plan: .claude/plans/marginalia-slice.md.
//
// Ephemerality: the paragraph's TEXT never outlives the request. The DO embeds
// it and keeps only focusFrom()'s output, in memory. test/margin-core.test.ts
// checks the DO shell for storage and log calls.

import { cosineSim } from "./pool-core";

/** Longest paragraph a focus request may carry. UNMEASURED: well inside what
 *  bge-m3 accepts, and far past a paragraph anyone writes in a margin tool. */
export const MAX_PARAGRAPH_CHARS = 4000;

/** Words per margin draw: one field-sized burst (SPEC.md core loop step 3). */
export const MARGIN_DRAW_COUNT = 5;

const MAX_VISIBLE = 40;
const MAX_WORD_CHARS = 64; // src/index.ts MAX_TEXT_CHARS

export function parseFocusBody(raw: unknown): { text: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const t = (raw as Record<string, unknown>).text;
  if (typeof t !== "string") return null;
  const text = t.trim();
  if (!text || text.length > MAX_PARAGRAPH_CHARS) return null;
  return { text };
}

/** `{visible?}`: what the margin already shows, so a draw does not condense a
 *  twin. Always parses; a missing or malformed list is an empty one. */
export function parseMarginDrawBody(raw: unknown): { visible: string[] } {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>).visible : undefined;
  if (!Array.isArray(v)) return { visible: [] };
  return { visible: v.filter((t): t is string => typeof t === "string" && t.length <= MAX_WORD_CHARS).slice(0, MAX_VISIBLE) };
}

/** What the DO keeps of a focused paragraph: its embedding and when it landed.
 *  Deliberately no text field. Null for a missing or broken vector, so a bad
 *  embed leaves the previous focus in place. */
export interface MarginFocus {
  embedding: number[];
  at: number;
}

export function focusFrom(embedding: number[] | undefined, now: number): MarginFocus | null {
  if (!embedding || embedding.length === 0 || !embedding.every(Number.isFinite)) return null;
  return { embedding, at: now };
}

/** The focused paragraph once there is one; the seed before that; nothing
 *  until the pump has embedded the seed (the margin waits on its buffer). */
export function marginQuery(focus: MarginFocus | null, seedEmbedding: number[] | null): { mode: "focus" | "seed"; query: number[] } | null {
  if (focus) return { mode: "focus", query: focus.embedding };
  if (seedEmbedding && seedEmbedding.length > 0) return { mode: "seed", query: seedEmbedding };
  return null;
}

export function marginScore(query: number[]): (c: { embedding: number[] }) => number {
  return (c) => cosineSim(c.embedding, query);
}
