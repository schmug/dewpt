// Pure pieces of the ground spike: trial construction, judge prompts, answer
// parsing, and the binomial tail. Free of node APIs so test/ground-judge.test.ts
// can import it — critic cycle 3 found a judge parser in this repo that
// accepted malformed answers, and that is not a bug to repeat untested.

import type { ChatMessage } from "../src/generation";

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** P(X >= k) for X ~ Binomial(n, p). Exact, by summing the pmf. */
export function binomTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let logC = 0; // log C(n, i), built up incrementally
  let total = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

/** Walk several ranked lists in turn, taking from each the highest-ranked item
 *  not already taken, starting at 0-based `rank`. The FIRST list keeps its true
 *  rank; later lists skip collisions. Returns null if any list runs dry. */
export function distinctPicks(lists: readonly (readonly number[])[], rank: number): number[] | null {
  const taken = new Set<number>();
  const out: number[] = [];
  for (const list of lists) {
    let pick: number | undefined;
    for (let r = rank; r < list.length; r++) {
      if (!taken.has(list[r]!)) { pick = list[r]; break; }
    }
    if (pick === undefined) return null;
    taken.add(pick);
    out.push(pick);
  }
  return out;
}

// ── judge prompts ───────────────────────────────────────────────────────────
// The judge never sees how a set was chosen, only groups and words. It is the
// non-circular instrument: every embedding statistic in this repo that tried
// to grade a direction without one came back null
// (docs/measurements/2026-08-22-workstream-b-null-result.md).

const ATTRIBUTE_SYSTEM = `You look at a person's whiteboard.

They arranged their notes into groups. Then a few new words appeared on the board, right next to ONE of the groups.
Decide which group the new words appeared next to — the group they most belong with.

Respond with JSON only, exactly: {"group": N} where N is the group number. No prose, no code fences.`;

export function attributeMessages(groups: readonly (readonly string[])[], words: readonly string[]): ChatMessage[] {
  const g = groups.map((grp, i) => `Group ${i + 1}: ${grp.join("; ")}`).join("\n");
  return [
    { role: "system", content: ATTRIBUTE_SYSTEM },
    { role: "user", content: `${g}\n\nNew words: ${words.join("; ")}\n\nWhich group? Reply {"group": N}.` },
  ];
}

const BRIDGE_SYSTEM = `You judge connections between ideas.

You are given two ideas, X and Y, and a numbered list of phrases.
Pick the ONE phrase that best connects X and Y — that relates to both of them at once, rather than to only one.

Respond with JSON only, exactly: {"choice": N} where N is the phrase number. No prose, no code fences.`;

export function bridgeMessages(x: string, y: string, options: readonly string[]): ChatMessage[] {
  const list = options.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    { role: "system", content: BRIDGE_SYSTEM },
    { role: "user", content: `X: ${x}\nY: ${y}\n\n${list}\n\nWhich phrase connects X and Y? Reply {"choice": N}.` },
  ];
}

/** Parse `{"<key>": N}` with N in 1..n; returns the 0-based index or null.
 *  Anything else — prose, an out-of-range number, a list — is null, and the
 *  caller counts the trial as unjudged rather than guessing. */
export function parsePick(raw: unknown, key: "group" | "choice", n: number): number | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
  const v = (parsed as Record<string, unknown>)[key];
  const num = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(num) || num < 1 || num > n) return null;
  return num - 1;
}

/** Mean pairwise Jaccard overlap between index sets. 0 = every cluster pulls a
 *  disjoint set; 1 = every cluster pulls the same set (hubness). */
export function meanJaccard(sets: readonly (readonly number[])[]): number {
  let s = 0, n = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = new Set(sets[i]), b = new Set(sets[j]);
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      s += union === 0 ? 0 : inter / union;
      n++;
    }
  }
  return n === 0 ? NaN : s / n;
}

// ── pre-registered verdict ──────────────────────────────────────────────────
// Fixed BEFORE the first real run (2026-09-24). Do not tune after seeing data;
// change them only in a commit that says so and why.

export const PASS = {
  /** Attribution: correct group for >= 11 of 18 steered trials. Chance is 1/3;
   *  P(X >= 11 | n=18, p=1/3) ~ 0.012. */
  attributeMin: 11,
  attributeN: 18,
  /** Bridge: the bridge-ranked phrase chosen in >= 10 of 18 three-way trials.
   *  Chance is 1/3; P(X >= 10 | n=18) ~ 0.033. */
  bridgeMin: 10,
  bridgeN: 18,
  /** Hubness: mean top-10 Jaccard between clusters of one seed <= 0.25. Above
   *  that, different clusters pull substantially the same words and the ground
   *  cannot be felt no matter what the judge says. */
  jaccardMax: 0.25,
} as const;

export interface SpikeTallies {
  attribute: { correct: number; judged: number };
  bridge: { chosen: number; judged: number };
  jaccard: number;
}

export function verdict(t: SpikeTallies): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  // An unjudged trial (malformed answer twice) counts as a miss, never as a
  // pass and never dropped from the denominator — dropping it would let a
  // flaky judge shrink n toward whatever happened to succeed.
  if (t.attribute.correct < PASS.attributeMin) {
    reasons.push(`attribution ${t.attribute.correct}/${PASS.attributeN} < ${PASS.attributeMin} (${PASS.attributeN - t.attribute.judged} unjudged)`);
  }
  if (t.bridge.chosen < PASS.bridgeMin) {
    reasons.push(`bridge ${t.bridge.chosen}/${PASS.bridgeN} < ${PASS.bridgeMin} (${PASS.bridgeN - t.bridge.judged} unjudged)`);
  }
  if (!(t.jaccard <= PASS.jaccardMax)) reasons.push(`top-10 jaccard ${t.jaccard.toFixed(3)} > ${PASS.jaccardMax}`);
  return { pass: reasons.length === 0, reasons };
}
