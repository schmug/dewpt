/** Yield, zero-rate and throughput aggregation over generation calls.
 *
 *  Pure: no node APIs, no I/O. A test importing this typechecks its whole
 *  graph under `tsconfig.json`'s `"types": []`, so nothing here may reach for
 *  `process`, `node:fs` or `node:os`. */

/** Words per second the field consumes at drizzle 100. public/field.js:162 sets
 *  the spawn interval to `2400 - drizzle * 19` ms plus 0-400ms of jitter and
 *  spawns one word per tick, so the mean interval bottoms out near 700ms.
 *  Sustained generation below this makes the field visibly wait, which
 *  CLAUDE.md classes as correctness, not performance. */
export const REQUIRED_THROUGHPUT = 1000 / 700;

export interface CallResult {
  words: string[];
  elapsedMs: number;
}

export function meanYield(calls: CallResult[], requested: number): number {
  if (calls.length === 0) return 0;
  const total = calls.reduce((s, c) => s + c.words.length / requested, 0);
  return total / calls.length;
}

export function zeroRate(calls: CallResult[]): number {
  if (calls.length === 0) return 0;
  return calls.filter((c) => c.words.length === 0).length / calls.length;
}

export function throughput(calls: CallResult[]): number {
  const ms = calls.reduce((s, c) => s + c.elapsedMs, 0);
  if (ms === 0) return 0;
  return (calls.reduce((s, c) => s + c.words.length, 0) / ms) * 1000;
}
