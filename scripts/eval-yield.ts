/** Yield, zero-rate and throughput aggregation over generation calls.
 *
 *  Pure: no node APIs, no I/O — by convention, not by compiler. `tsconfig.json`
 *  sets `"types": []`, but that does not police this file: `@types/node` leaks
 *  in through vitest's own type surface, and `tsconfig.scripts.json` (which is
 *  what actually covers `scripts/**`) sets `"types": ["node"]`. So the
 *  typechecker will happily accept `process` or `node:fs` here. Keeping this
 *  module runtime-agnostic is a rule a dedicated test enforces, not the build. */

/** The spawn loop in public/field.js:162 — `interval = 2400 - drizzle * 19` ms
 *  plus `Math.random() * 400` of jitter, one spawn attempt per tick. The same
 *  formula is duplicated at public/preseed.js:73, so both are drift sites.
 *  `drizzle` is the `#flux` slider (public/index.html:118, `max="100"`, bound as
 *  `sliders.flux` in public/app.js:31). */
const BASE_INTERVAL_MS = 2400;
const MS_PER_DRIZZLE_STEP = 19;
const MAX_DRIZZLE = 100;
const JITTER_SPAN_MS = 400;

/** Shortest possible tick at drizzle 100: 500ms, jitter at its floor. */
const MIN_INTERVAL_MS = BASE_INTERVAL_MS - MAX_DRIZZLE * MS_PER_DRIZZLE_STEP;
/** Long-run average tick at drizzle 100: 700ms, jitter uniform over 0-400ms. */
const MEAN_INTERVAL_MS = MIN_INTERVAL_MS + JITTER_SPAN_MS / 2;

/** The loop's *asymptotic mean* spawn rate at drizzle 100, in words/sec (~1.43).
 *  Explicitly NOT a ceiling: half the ticks are faster than this. Also NOT pool
 *  consumption — see REQUIRED_THROUGHPUT on why spawns undercount draws. Useful
 *  for reasoning about steady-state drain, useless as a generation target. */
export const STEADY_SPAWN_RATE = 1000 / MEAN_INTERVAL_MS;

/** The instantaneous ceiling of the spawn loop at drizzle 100: 2.0 words/sec.
 *
 *  Treat this as a LOWER BOUND on the real generation requirement, not the
 *  requirement itself. Three things push the true number higher, none of them
 *  measured here:
 *
 *  - **Draw amplification.** This counts spawns, not pool words. `pickWord`
 *    (public/field.js:48) loops `while ((pick = drawWord(...)))` past any word
 *    already visible or pinned, and public/pool-client.js:68 draws destructively
 *    (`buffer.shift() ?? null`), so a collision drains a buffered word without
 *    spawning anything. One spawn can cost several words.
 *  - **Bursts.** Two paths bypass the loop entirely: a click-prospect fires 4
 *    spawns at 180ms (public/field.js:154) — 7.41 words/sec — and `start()`
 *    fires 6 at 350ms (public/field.js:170) — 3.43 words/sec. Neither is a
 *    generation-rate requirement: the client buffer and the DO's pool depth
 *    absorb them. They are recorded here so the next reader does not rediscover
 *    them and mistake either for the ceiling.
 *
 *  Pushing the other way, the realized rate is lower than either figure: the
 *  loop only spawns `if (visible.size < CAP)` (public/field.js:161) and `spawn`
 *  itself returns early at `visible.size >= CAP + 4`.
 *
 *  Sustained generation below this bound makes the field visibly wait, which
 *  CLAUDE.md classes as correctness, not performance. */
export const REQUIRED_THROUGHPUT = 1000 / MIN_INTERVAL_MS;

export interface CallResult {
  words: string[];
  elapsedMs: number;
}

/** Thrown when a metric is not computable from the inputs given. Every case
 *  below previously returned a plain number that read as a result — 0, NaN,
 *  Infinity, or a negative rate — and a non-finite or fail-open metric launders
 *  straight into a passing gate downstream. Refusing is the whole point. */
export class EvalMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalMetricError";
  }
}

/** No metric here is a rate *per call* that survives having no calls. Returning
 *  0 made a total generation outage look like a perfect zeroRate. */
function requireCalls(calls: CallResult[], metric: string): void {
  if (calls.length === 0) {
    throw new EvalMetricError(`${metric}: cannot compute a rate over zero calls`);
  }
}

/** Mean per-call fraction of the requested batch that parsed, each call clamped
 *  at 1.0 so one overproducing call cannot offset a dead one. (cleanList in
 *  src/generation.ts:149 caps parsed output at the requested count in practice,
 *  but this must not depend on its caller to stay in range.) */
export function meanYield(calls: CallResult[], requested: number): number {
  requireCalls(calls, "meanYield");
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new EvalMetricError(
      `meanYield: requested must be a finite number greater than 0, got ${requested}`,
    );
  }
  const total = calls.reduce((s, c) => s + Math.min(c.words.length / requested, 1), 0);
  return total / calls.length;
}

export function zeroRate(calls: CallResult[]): number {
  requireCalls(calls, "zeroRate");
  return calls.filter((c) => c.words.length === 0).length / calls.length;
}

export function throughput(calls: CallResult[]): number {
  requireCalls(calls, "throughput");
  let ms = 0;
  for (const c of calls) {
    if (!Number.isFinite(c.elapsedMs) || c.elapsedMs < 0) {
      throw new EvalMetricError(
        `throughput: every elapsedMs must be a finite number >= 0, got ${c.elapsedMs}`,
      );
    }
    ms += c.elapsedMs;
  }
  if (ms === 0) {
    throw new EvalMetricError(
      "throughput: total elapsed time is 0ms; a words-per-second rate is undefined",
    );
  }
  return (calls.reduce((s, c) => s + c.words.length, 0) / ms) * 1000;
}
