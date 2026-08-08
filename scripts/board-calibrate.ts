// M0 calibration for the conveyor board. Measures the three constants the
// design cannot guess — TETHER_FLOOR, ARRIVAL_COSINE and CANDIDATES_PER_HOP —
// and then answers the question those three do not: walked down the real belt,
// does a card DEVELOP, or does it circle?
//
// Section 4 walks the belt the board actually runs: one seed, then ONE hop
// through each of DEFAULT_STATION_TERMS in order, a DIFFERENT target at every
// hop. An earlier version applied a single station phrase five times over. The
// belt cannot do that — a card passes each station exactly once — and the flat
// cos-to-phrase trajectory it produced was mostly the first hop exhausting the
// only station on offer, read as a selection failure. That verdict answered a
// question the board does not ask.
//
// The worry the section is really there to test is structural. `scoreCandidates`
// scores a candidate by the COSINE between its displacement and the station
// vector: alignment, not distance. It is magnitude-independent, so a tiny nudge
// exactly along `phrase - parent` outscores a large, mostly-aligned move.
// Argmax-by-alignment could therefore pick a minimally-moved child at every
// station, leaving a card that has visited three directions and still reads as
// its seed.
//
// Everything the model sees comes from `generateRewrites` and `expandPole` — the
// same functions, prompts, few-shots and temperatures the BoardDO ships. A
// constant measured against a different prompt does not transfer, so this script
// owns no prompt of its own, and it does not hand-write the station phrases
// either: the expansion step is part of what ships and part of what is measured.
//
// The separation AUC is a GATE and is evaluated after ~3 requests, before the
// ~40 that follow. A failed gate costs three calls, not the whole run.
//
// REST-from-node like calibrate.ts and the axis spikes, so it is unaffected by
// the local wrangler-dev egress issues (see CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run board-calibrate
//
// The token needs "Workers AI - Read".

import { pathToFileURL } from "node:url";
import { generateRewrites, scoreCandidates, selectChild } from "../src/board/rewrite";
import { DEFAULT_STATION_TERMS } from "../src/board/types";
import { expandPole, type AiRunner } from "../src/generation";
import { DEDUPE_COSINE } from "../src/types";
import { auc, cosine, embedTexts, requireCreds } from "./axis-lib";

const GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The mechanic's gate. Below this, genuine rewrites and non-sequiturs are not
 *  separable by cosine-against-parent and no tether floor can be chosen. */
const GATE_AUC = 0.8;

/** Hops per chain — one per station, because that is the belt. Not a tuning
 *  knob: `DEFAULT_STATION_TERMS` decides it, and a card passes each station
 *  exactly once. */
const CHAIN_HOPS = DEFAULT_STATION_TERMS.length;

/** Candidates generated per hop inside the chain probe. Held fixed so the
 *  development result is about selection, not about fan-out width. */
const CHAIN_FANOUT = 8;

/** Fan-out widths compared in section 3. */
const FANOUT_SWEEP = [4, 8, 12];

/** Minimum cosine gain against a hop's OWN station for that hop to count as
 *  having worked. A MAGNITUDE, deliberately: a sign-only test passes a hop that
 *  gained +0.0001, which is a station that did nothing. See the printed
 *  justification in section 4 — arguable, and meant to be. */
const MIN_STATION_GAIN = 0.02;

/** Fraction of hops that must clear MIN_STATION_GAIN against their own station. */
const MIN_WORKING_HOP_FRACTION = 2 / 3;

/** Complete chains that must end further from their seed than their own largest
 *  single hop. This is the develop-or-circle term. */
const ACCUMULATING_REQUIRED = 2;

/** Complete chains needed before the verdict rule can be evaluated at all.
 *  DERIVED from the rule, never hardcoded: term 3 asks for ACCUMULATING_REQUIRED
 *  accumulating chains, so at fewer complete chains than that the rule cannot
 *  pass whatever the belt did, and a negative verdict would be a fact about the
 *  sample size rather than about the board. The previous version guarded on
 *  `completeChains === 0` while requiring 2 monotonic chains, so a run with one
 *  complete chain printed a confident failure it could not have avoided. */
const MIN_COMPLETE_CHAINS = ACCUMULATING_REQUIRED;

/** Survivors of the tether floor a hop must have, on EVERY probe, for a fan-out
 *  width to be recommended. Three rather than one because production's
 *  `selectChild` then drops near-duplicates of the lineage's own history, so a
 *  hop needs spares — and because "did at least one survive" saturates at 3/3
 *  immediately and cannot discriminate between widths at all. */
const MIN_SURVIVORS_PER_HOP = 3;

/** Below this much mean survivor gain, the next width up is buying nothing. */
const SURVIVOR_STABILITY_EPS = 1.0;

/** Minimum hop size for the progression verdict, as a fraction of the room the
 *  tether floor leaves. See the printed justification in section 4 — this is a
 *  judgement call and is meant to be arguable. */
const MIN_HOP_MOVE_FRACTION = 0.25;

/** Percentile of the genuine tether distribution the floor is set at. */
const TETHER_PERCENTILE = 0.05;

interface Probe {
  parent: string;
  phrase: string;
  genuine: string[];
  nonSequitur: string[];
}

/** Hand-built probes: a parent fragment, a station phrase, genuine rewrites
 *  along that direction, and non-sequiturs that are plausible English but not
 *  derived from the parent. The non-sequiturs are what TETHER_FLOOR must
 *  exclude. */
const PROBES: Probe[] = [
  {
    parent: "urban gardening",
    phrase: "a physical object you can touch",
    genuine: ["rooftop bee lease", "balcony planter boxes", "rain barrel", "window herb box", "compost bin"],
    nonSequitur: ["quarterly earnings call", "saxophone reed", "lighthouse keeper", "gingham tablecloth", "referendum ballot"],
  },
  {
    parent: "tool libraries",
    phrase: "a surreal, dreamlike version",
    genuine: ["lathe confessional", "hammer that remembers", "borrowed-wrench oracle", "saw with a conscience", "drill that dreams"],
    nonSequitur: ["monsoon season", "escalator maintenance", "porcelain figurine", "tuesday afternoon", "meridian line"],
  },
  {
    parent: "security awareness training",
    phrase: "a mystical or magical practice",
    genuine: ["threat-model tarot deck", "phishing ouija board", "firewall gargoyles", "breach divination", "password incantation"],
    nonSequitur: ["linoleum flooring", "tributary river", "cardigan sweater", "handshake protocol fee", "photosynthesis rate"],
  },
];

// ── cost accounting ────────────────────────────────────────────────────────
// Derived, not hardcoded, so the printed estimate cannot drift from the loops.

/** One embedding call per probe: parent + phrase + genuine + non-sequiturs all
 *  fit in a single chunk. */
const SECTION1_REQUESTS = PROBES.length;
/** Per width per probe: one generation, one embedding. */
const SECTION3_REQUESTS = FANOUT_SWEEP.length * PROBES.length * 2;
/** One generation per station term to expand it, then a single embedding call
 *  covering every station phrase AND every seed together — they all fit in one
 *  chunk, and batching them is why the belt walk costs less than the five-hop
 *  loop it replaces. Then a generation + an embedding per hop. Chains that break
 *  early cost less; this is the ceiling. */
const SECTION4_MAX_REQUESTS =
  DEFAULT_STATION_TERMS.length + 1 + PROBES.length * CHAIN_HOPS * 2;
const POST_GATE_MAX_REQUESTS = SECTION3_REQUESTS + SECTION4_MAX_REQUESTS;
const TOTAL_MAX_REQUESTS = SECTION1_REQUESTS + POST_GATE_MAX_REQUESTS;

/** Structural subset of the Workers AI binding, over REST. Lets this script run
 *  the production `generateRewrites` unchanged, from node. */
function restRunner(accountId: string, token: string): AiRunner {
  return {
    async run(model, inputs) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });
      const body = (await res.json()) as { success: boolean; result?: unknown; errors?: { message: string }[] };
      if (!res.ok || !body.success) {
        const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
        throw new Error(`Workers AI call failed for ${model}: ${detail}`);
      }
      return body.result;
    },
  };
}

/** Linear-interpolation percentile (the R-7 / `PERCENTILE.INC` definition):
 *  the value at fractional index `p * (n - 1)`, interpolating between the two
 *  neighbouring order statistics. p=0 gives the minimum, p=0.5 the median,
 *  p=1 the maximum.
 *
 *  This replaces a version that floored the index. At n=15, `Math.floor(0.05 *
 *  14)` is 0, so what was labelled the 5th percentile was in fact the single
 *  lowest observation — the most outlier-sensitive order statistic there is,
 *  and a floor that by construction retains 100% of the sample rather than the
 *  ~95% claimed. */
export function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const lower = sorted[lo]!;
  if (lo === hi) return lower;
  return lower + (sorted[hi]! - lower) * (idx - lo);
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

function median(xs: number[]): number {
  return pct(xs, 0.5);
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
}

/** `mean([])` is 0 here, and `+0.000` reads as a measured zero rather than as
 *  "nothing was measured". Empty must be visibly absent instead. */
export function signedMeanOrNa(xs: number[]): string {
  return xs.length === 0 ? "n/a" : signed(mean(xs));
}

export function fixedMeanOrNa(xs: number[], digits = 3): string {
  return xs.length === 0 ? "n/a" : mean(xs).toFixed(digits);
}

/** `Math.min()` of nothing is `Infinity`, which compares as larger than every
 *  threshold and turns "no data" into "passed". NaN fails every comparison
 *  instead, which is the correct behaviour for an absent measurement. */
export function minOf(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : Math.min(...xs);
}

/** Same trap from the other side: `Math.max()` of nothing is `-Infinity`, which
 *  every value beats. */
export function maxOf(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : Math.max(...xs);
}

function countOrNa(x: number): string {
  return Number.isFinite(x) ? String(x) : "n/a";
}

function share(count: number, total: number): string {
  return total === 0 ? "n/a" : `${((count / total) * 100).toFixed(0)}% (${count}/${total})`;
}

function verdictTerm(ok: boolean): string {
  return ok ? "[pass]" : "[FAIL]";
}

export interface WidthRow {
  n: number;
  parsed: number[];
  survivors: number[];
  lifts: number[];
}

/** The fan-out recommendation, as a function of the measurement rather than of
 *  the reader's eye. Rows must be in ascending `n` order. */
export function recommendWidth(rows: WidthRow[]): {
  recommended: WidthRow | null;
  next: WidthRow | null;
  marginalSurvivors: number;
} {
  // `minOf` rather than `Math.min(...)`: an empty `survivors` array yields
  // Infinity, which clears every threshold, so a row that measured NOTHING would
  // be returned as the recommendation. Unreachable from main(), which pushes one
  // entry per probe, but this function is exported and the trap is silent.
  const recommended = rows.find((r) => minOf(r.survivors) >= MIN_SURVIVORS_PER_HOP) ?? null;
  const next = recommended ? rows.find((r) => r.n > recommended.n) ?? null : null;
  return {
    recommended,
    next,
    marginalSurvivors: recommended && next ? mean(next.survivors) - mean(recommended.survivors) : Number.NaN,
  };
}

/** One card's walk down the belt. `texts[0]` is the seed and `texts[k]` is the
 *  child chosen at station k, so the array read left to right IS the chain. */
export interface ChainRecord {
  seed: string;
  texts: string[];
  /** Per-hop `cos(card_k, phrase_k) - cos(card_k-1, phrase_k)`: the gain against
   *  the station THIS hop was passing. Not comparable to another hop's
   *  cos-to-phrase, but perfectly comparable to its own before-value, which is
   *  the only comparison a one-shot station supports. */
  gains: number[];
  /** Per-hop `1 - cosine(child, its own parent)`: the hop's actual size. */
  moves: number[];
  /** `1 - cosine(final card, seed)`. 0 when the chain broke before any hop. */
  travel: number;
  /** True when the card passed every station. */
  complete: boolean;
}

export interface ChainStats {
  chains: ChainRecord[];
  tetherFloor: number;
}

export type ChainOutcome = "DEVELOP" | "DO NOT DEVELOP" | "INCONCLUSIVE";

export interface ChainVerdict {
  outcome: ChainOutcome;
  completeChains: number;
  brokenChains: number;
  workingHops: number;
  totalHops: number;
  minWorkingHops: number;
  meanGain: number;
  meanMove: number;
  medianMove: number;
  moveCap: number;
  minHopMove: number;
  accumulatingChains: number;
  meanTravel: number;
  stationOk: boolean;
  moveOk: boolean;
  accumulationOk: boolean;
}

/** Three terms, all required, all computed over COMPLETE chains only — a chain
 *  breaks precisely when its parent has drifted, so its hops are not a random
 *  sample of hops and folding them in biases every mean.
 *
 *  1. STATION SUCCESS. Each station gets exactly one shot at a card, so the
 *     per-hop question is not "is the trajectory rising" but "did this hop move
 *     the card toward the station it was passing". Counted with a MAGNITUDE
 *     (MIN_STATION_GAIN), not a sign: a sign-only term passes +0.0001 and calls
 *     a station that did nothing a success.
 *  2. HOP SIZE. The crawl detector. Argmax-by-alignment can prefer a minimal
 *     nudge, and three nudges leave a card reading as its seed.
 *  3. ACCUMULATION. The develop-or-circle term, and the one the old fixed-target
 *     "monotonic trajectory" count was standing in for. It needs no threshold of
 *     its own: a chain that doubled back lands within one hop's reach of its
 *     seed however large the hops were.
 *
 *  INCONCLUSIVE is a distinct outcome, not a flavour of failure, and it triggers
 *  on "not enough complete chains to evaluate the rule" — MIN_COMPLETE_CHAINS,
 *  derived from term 3 — rather than on zero. Between those two the rule cannot
 *  pass whatever the belt did, so a negative verdict there measures the sample,
 *  not the board. */
export function chainDevelopmentVerdict(s: ChainStats): ChainVerdict {
  const complete = s.chains.filter((c) => c.complete);
  const gains = complete.flatMap((c) => c.gains);
  const moves = complete.flatMap((c) => c.moves);
  const travels = complete.map((c) => c.travel);

  const moveCap = 1 - s.tetherFloor;
  const minHopMove = MIN_HOP_MOVE_FRACTION * moveCap;
  const totalHops = gains.length;
  const workingHops = gains.filter((g) => Number.isFinite(g) && g >= MIN_STATION_GAIN).length;
  const minWorkingHops = Math.ceil(MIN_WORKING_HOP_FRACTION * totalHops);
  // Ended further from the seed than any ONE of its own hops could have taken
  // it. `maxOf` returns NaN for a hopless chain, and `travel > NaN` is false, so
  // such a chain cannot count as accumulating.
  const accumulatingChains = complete.filter((c) => c.travel > maxOf(c.moves)).length;

  const stationOk = totalHops > 0 && workingHops >= minWorkingHops;
  const moveOk = moves.length > 0 && mean(moves) >= minHopMove;
  const accumulationOk = accumulatingChains >= ACCUMULATING_REQUIRED;

  const outcome: ChainOutcome =
    complete.length < MIN_COMPLETE_CHAINS
      ? "INCONCLUSIVE"
      : stationOk && moveOk && accumulationOk
        ? "DEVELOP"
        : "DO NOT DEVELOP";

  return {
    outcome,
    completeChains: complete.length,
    brokenChains: s.chains.length - complete.length,
    workingHops,
    totalHops,
    minWorkingHops,
    meanGain: mean(gains),
    meanMove: mean(moves),
    medianMove: median(moves),
    moveCap,
    minHopMove,
    accumulatingChains,
    meanTravel: mean(travels),
    stationOk,
    moveOk,
    accumulationOk,
  };
}

async function main(): Promise<void> {
  // Cost first, before anything can be spent — including before the credential
  // check, so a run without credentials still tells you what a real one costs.
  console.log(
    `cost estimate: up to ${TOTAL_MAX_REQUESTS} Workers AI requests ` +
      `(${SECTION1_REQUESTS} embeddings to reach the gate, then up to ${POST_GATE_MAX_REQUESTS} more: ` +
      `${SECTION3_REQUESTS} for the fan-out sweep, up to ${SECTION4_MAX_REQUESTS} for the belt walk — ` +
      `${DEFAULT_STATION_TERMS.length} station expansions, 1 embedding for the phrases and seeds, ` +
      `and 2 per hop over ${PROBES.length} chains x ${CHAIN_HOPS} stations).`,
  );

  const { accountId, token } = requireCreds();
  const ai = restRunner(accountId, token);

  // ── 1. TETHER_FLOOR ─────────────────────────────────────────────────────
  // Do genuine rewrites and non-sequiturs separate by cosine-against-parent?
  const genuineTethers: number[] = [];
  const nonSequiturTethers: number[] = [];
  const arrivalByHop: number[][] = [];

  for (const probe of PROBES) {
    const texts = [probe.parent, probe.phrase, ...probe.genuine, ...probe.nonSequitur];
    const vecs = await embedTexts(accountId, token, texts);
    const [parentVec, phraseVec] = [vecs[0]!, vecs[1]!];
    const genuineVecs = vecs.slice(2, 2 + probe.genuine.length);
    const nonVecs = vecs.slice(2 + probe.genuine.length);

    for (const v of genuineVecs) genuineTethers.push(cosine(v, parentVec));
    for (const v of nonVecs) nonSequiturTethers.push(cosine(v, parentVec));

    // ── 2. ARRIVAL_COSINE ────────────────────────────────────────────────
    // How close to the phrase does a genuine rewrite actually land? Arrival
    // must sit ABOVE this, or every first hop reports arrival immediately.
    arrivalByHop.push(genuineVecs.map((v) => cosine(v, phraseVec)));

    // Sanity: the scoring function must rank genuine rewrites above
    // non-sequiturs on movement, not just on tether.
    const scored = scoreCandidates(parentVec, phraseVec, [
      ...probe.genuine.map((text, i) => ({ text, embedding: genuineVecs[i]! })),
      ...probe.nonSequitur.map((text, i) => ({ text, embedding: nonVecs[i]! })),
    ]);
    const g = scored.slice(0, probe.genuine.length).map((c) => c.score);
    const n = scored.slice(probe.genuine.length).map((c) => c.score);
    console.log(`\n${probe.parent}  ->  ${probe.phrase}`);
    console.log(`  movement AUC (genuine vs non-sequitur): ${auc(g, n).toFixed(3)}`);
    console.log(`  mean tether  genuine ${mean(genuineVecs.map((v) => cosine(v, parentVec))).toFixed(3)}  non-seq ${mean(nonVecs.map((v) => cosine(v, parentVec))).toFixed(3)}`);
  }

  const tetherAuc = auc(genuineTethers, nonSequiturTethers);
  const genuineP05 = pct(genuineTethers, TETHER_PERCENTILE);
  const genuineMin = Math.min(...genuineTethers);
  const floor = genuineP05;
  const retained = genuineTethers.filter((t) => t >= floor).length;
  const admitted = nonSequiturTethers.filter((t) => t >= floor).length;

  console.log("\n=== TETHER_FLOOR ===");
  console.log(`  separation AUC        ${tetherAuc.toFixed(3)}   (gate: >= ${GATE_AUC.toFixed(2)})`);
  console.log(
    `  genuine tethers (n=${genuineTethers.length})  p05 interpolated ${genuineP05.toFixed(3)}   observed minimum ${genuineMin.toFixed(3)}   p50 ${pct(genuineTethers, 0.5).toFixed(3)}`,
  );
  console.log(`  non-seq tethers (n=${nonSequiturTethers.length})  p50 ${pct(nonSequiturTethers, 0.5).toFixed(3)}   p95 ${pct(nonSequiturTethers, 0.95).toFixed(3)}`);
  console.log(`  proposed TETHER_FLOOR ${floor.toFixed(3)}  = the linear-interpolated 5th percentile of the`);
  console.log(`                        GENUINE tethers. Not their minimum: a floor at the minimum`);
  console.log(`                        retains 100% by construction and moves with one bad probe.`);
  console.log(`    genuine retention at that floor:  ${share(retained, genuineTethers.length)} of genuine rewrites survive`);
  console.log(`    non-sequitur admission:           ${share(admitted, nonSequiturTethers.length)} of non-sequiturs survive`);
  console.log(`  caveat: ${genuineTethers.length} hand-written genuine samples. p05 interpolates between the 1st and`);
  console.log(`          2nd order statistics at this size, so it is still sensitive to a single bad`);
  console.log(`          probe. Widen PROBES before treating this number as precise.`);

  const arrivals = arrivalByHop.flat();
  console.log("\n=== ARRIVAL_COSINE ===");
  console.log(`  genuine-rewrite cosine to phrase: p50 ${pct(arrivals, 0.5).toFixed(3)}  p95 ${pct(arrivals, 0.95).toFixed(3)}  max ${Math.max(...arrivals).toFixed(3)}`);
  console.log(`  proposed ARRIVAL_COSINE ${(pct(arrivals, 0.95) + 0.05).toFixed(3)}  (above the interpolated p95, so a normal hop`);
  console.log(`                          never false-reports arrival)`);

  // ── THE GATE ────────────────────────────────────────────────────────────
  // Everything above cost SECTION1_REQUESTS requests. Everything below costs
  // POST_GATE_MAX_REQUESTS. Decide here, not at the end of the run.
  // Written as "not >=" rather than "<" on purpose. A NaN AUC — an empty probe
  // set, a degenerate embedding — satisfies neither comparison, and `NaN <
  // GATE_AUC` is false, so the strict form would PASS the gate on a number that
  // does not exist and spend the whole post-gate budget on it.
  console.log("\n=== GATE ===");
  if (!(tetherAuc >= GATE_AUC)) {
    console.log(`  separation AUC ${tetherAuc.toFixed(3)} ${Number.isFinite(tetherAuc) ? `< ${GATE_AUC.toFixed(2)}` : "is not a number"}  ->  FAIL`);
    console.log(`  Genuine rewrites and non-sequiturs do not separate by cosine-against-parent,`);
    console.log(`  so no tether floor can be chosen and the rewrite mechanic does not work as`);
    console.log(`  designed. Stopping before the remaining ${POST_GATE_MAX_REQUESTS} requests.`);
    console.log(`  Report this number and the per-probe breakdown above. Do not start Task 3.`);
    process.exit(1);
  }
  console.log(`  separation AUC ${tetherAuc.toFixed(3)} >= ${GATE_AUC.toFixed(2)}  ->  PASS`);
  console.log(`  spent so far: ${SECTION1_REQUESTS} requests. Continuing will spend up to ${POST_GATE_MAX_REQUESTS} more`);
  console.log(`  (${SECTION3_REQUESTS} for the fan-out sweep, up to ${SECTION4_MAX_REQUESTS} for the chains).`);

  // ── 3. CANDIDATES_PER_HOP ───────────────────────────────────────────────
  // How much usable width does each fan-out actually buy? Counting probes that
  // yielded "at least one" survivor saturates at 3/3 and measures nothing, so
  // the instrument here is the NUMBER of candidates clearing the floor.
  console.log("\n=== CANDIDATES_PER_HOP ===");
  console.log(`  criterion: recommend the SMALLEST n where EVERY probe leaves at least`);
  console.log(`             ${MIN_SURVIVORS_PER_HOP} candidates above the tether floor. ${MIN_SURVIVORS_PER_HOP} rather than 1 because`);
  console.log(`             production's selectChild then drops near-duplicates of the lineage's`);
  console.log(`             own history (DEDUPE_COSINE = ${DEDUPE_COSINE}), so a hop needs spares — and`);
  console.log(`             because "at least one survived" saturates immediately and cannot`);
  console.log(`             discriminate between widths at all.`);
  console.log(`  candidates are parsed by production's parseCandidateList, which dedupes`);
  console.log(`  case-insensitively and enforces the 5-word / 64-char caps, so "parsed" is`);
  console.log(`  usually below n. That is the real width a hop gets.`);

  const rows: WidthRow[] = [];
  for (const n of FANOUT_SWEEP) {
    const row: WidthRow = { n, parsed: [], survivors: [], lifts: [] };
    for (const probe of PROBES) {
      const items = await generateRewrites(ai, GEN_MODEL, {
        fragment: probe.parent,
        target: probe.phrase,
        count: n,
        exclude: [],
      });
      row.parsed.push(items.length);
      if (items.length === 0) {
        row.survivors.push(0);
        continue;
      }
      const vecs = await embedTexts(accountId, token, [probe.parent, probe.phrase, ...items]);
      const candidates = items.map((text, i) => ({ text, embedding: vecs[i + 2]! }));
      const scored = scoreCandidates(vecs[0]!, vecs[1]!, candidates);
      row.survivors.push(scored.filter((c) => c.tether >= floor).length);
      const best = selectChild(vecs[0]!, vecs[1]!, candidates, { tetherFloor: floor });
      if (best) row.lifts.push(best.score - mean(scored.map((c) => c.score)));
    }
    rows.push(row);
    const minSurvivors = minOf(row.survivors);
    const withAny = row.survivors.filter((s) => s > 0).length;
    console.log(
      `  n=${String(n).padStart(2)}  parsed ${row.parsed.join("/")}` +
        `   survivors ${row.survivors.join("/")} (mean ${fixedMeanOrNa(row.survivors, 1)}, min ${countOrNa(minSurvivors)})` +
        `   probes with >=1: ${withAny}/${PROBES.length}` +
        // "n/a" rather than +0.000 when no probe yielded a selectable child:
        // an empty mean and a genuine zero lift are different findings.
        `   argmax lift over mean ${signedMeanOrNa(row.lifts)}`,
    );
  }

  const { recommended, next, marginalSurvivors } = recommendWidth(rows);
  if (recommended) {
    console.log(`  RECOMMENDATION: CANDIDATES_PER_HOP = ${recommended.n}`);
    console.log(`    smallest tested n where every probe kept >= ${MIN_SURVIVORS_PER_HOP} candidates above the floor.`);
    if (next) {
      console.log(`    going to n=${next.n} adds ${marginalSurvivors.toFixed(1)} survivors per hop on average.`);
      if (marginalSurvivors < SURVIVOR_STABILITY_EPS) {
        console.log(`    That is under ${SURVIVOR_STABILITY_EPS.toFixed(1)}, so the extra width is buying nothing.`);
      } else {
        // The old wording paired "recommend the SMALLEST n" with "still scaling,
        // so a wider sweep may be worth measuring" and read as internally at
        // odds. It was: the criterion is a sufficiency threshold, not a
        // maximisation, so a rising survivor count above the recommendation is
        // expected and is not an argument against it.
        console.log(`    Survivor count is still rising with width. That does NOT argue for a larger n:`);
        console.log(`    the criterion is a SUFFICIENCY threshold, not a maximum, and n=${recommended.n} already`);
        console.log(`    clears it — the extra survivors at n=${next.n} are spares nothing asked for. A wider`);
        console.log(`    sweep is worth measuring only if you raise MIN_SURVIVORS_PER_HOP above ${MIN_SURVIVORS_PER_HOP}.`);
      }
    } else {
      console.log(`    n=${recommended.n} is the widest tested value, so the marginal return above it is unmeasured.`);
    }
  } else {
    const widest = rows[rows.length - 1]!;
    console.log(`  RECOMMENDATION: none of ${FANOUT_SWEEP.join(", ")} met the criterion.`);
    console.log(`    Best tested is n=${widest.n} (min survivors ${countOrNa(minOf(widest.survivors))}). Widen the sweep`);
    console.log(`    above ${widest.n} and re-run before writing a constant; do not adopt a value the`);
    console.log(`    measurement did not support.`);
  }
  console.log(`  CAVEAT — sample size: ONE generation draw per (width, probe) pair, i.e. ${PROBES.length} samples`);
  console.log(`  per width, at production's REWRITE_TEMPERATURE (0.9 — deliberately high, for`);
  console.log(`  variety). Survivor counts at a given width WILL move run to run. Read the`);
  console.log(`  recommendation as "this width sufficed on one draw", not as a stable estimate,`);
  console.log(`  and note that the tether section states its own sample caveat separately — this`);
  console.log(`  one is not covered by it.`);

  // ── 4. CHAIN DEVELOPMENT ────────────────────────────────────────────────
  // The belt, walked as the board walks it: one seed, then one hop through each
  // station in DEFAULT_STATION_TERMS, in order, exactly once each. `score` is
  // alignment rather than distance, so argmax may prefer a minimally-moved child
  // at every station — three stations visited and a card that still reads as its
  // seed. Run it through the production selection path and measure.
  const moveCap = 1 - floor;

  console.log("\n=== CHAIN DEVELOPMENT ===");
  console.log(`  ${PROBES.length} chains. Each is ONE seed passed through ${CHAIN_HOPS} stations in order, a DIFFERENT`);
  console.log(`  target at every hop, each station used exactly once — the only shape the belt`);
  console.log(`  can produce. ${CHAIN_FANOUT} candidates per hop.`);
  console.log(`  The child is chosen by production's selectChild: argmax score among candidates`);
  console.log(`  with tether >= ${floor.toFixed(3)} that do not exceed DEDUPE_COSINE ${DEDUPE_COSINE} against anything`);
  console.log(`  already in the lineage. The prompt also receives the lineage's texts as its`);
  console.log(`  exclusion list, exactly as the BoardDO hop does.`);
  console.log(`  NOTE: an earlier version of this section re-applied ONE station phrase five`);
  console.log(`  times. That is a move the belt cannot make, and its flat cos-to-phrase`);
  console.log(`  trajectory was largely the first hop exhausting the only station on offer.`);

  // Station phrases come from production's expandPole, never hand-written here.
  // The expansion IS part of what a station is — a bare term costs ~0.34 AUC to
  // polysemy (docs/latent-space-navigation-design.md) — so writing the phrases
  // into this file would measure a belt the board does not run, and would hide
  // the failure mode where expansion silently degrades.
  console.log(`\n  stations, expanded by production's expandPole:`);
  const stations: { term: string; phrase: string; expanded: boolean; embedding: number[] }[] = [];
  const expansions: { term: string; phrase: string; expanded: boolean }[] = [];
  for (const term of DEFAULT_STATION_TERMS) {
    const pole = await expandPole(ai, GEN_MODEL, term);
    expansions.push({ term, phrase: pole.phrase, expanded: pole.expanded });
    console.log(
      `    "${term}"  ->  "${pole.phrase}"${pole.expanded ? "" : "   [DEGRADED — expansion failed; this is the bare term]"}`,
    );
  }
  const degraded = expansions.filter((e) => !e.expanded);
  if (degraded.length > 0) {
    console.log(`  WARNING: ${degraded.length} of ${expansions.length} stations fell back to the bare term. A bare pole scores`);
    console.log(`  AUC 0.640 against 0.980 for an expanded one, so every hop through`);
    console.log(`  ${degraded.map((e) => `"${e.term}"`).join(", ")} is measuring a degraded direction and that leg`);
    console.log(`  proves nothing about the belt. Re-run before reading those hops as evidence.`);
  }

  // One embedding call for every station phrase AND every seed. They fit in a
  // single chunk, and batching them is why this walk costs less than the
  // fixed-target loop it replaces despite adding the expansion step.
  const chainVecs = await embedTexts(accountId, token, [
    ...expansions.map((e) => e.phrase),
    ...PROBES.map((p) => p.parent),
  ]);
  for (let i = 0; i < expansions.length; i++) {
    stations.push({ ...expansions[i]!, embedding: chainVecs[i]! });
  }
  const seedVecs = chainVecs.slice(expansions.length);

  console.log(`\n  metrics. cos-to-phrase is NOT comparable across hops here, because the phrase`);
  console.log(`  changes every hop — a rising or falling trajectory of it would mean nothing and`);
  console.log(`  is not reported. What IS well defined:`);
  console.log(`    gain     cos(card_k, phrase_k) - cos(card_k-1, phrase_k). Did THIS hop move the`);
  console.log(`             card toward the station it was passing? Each station gets exactly one`);
  console.log(`             chance at a card, so this is the per-hop question the board asks.`);
  console.log(`    moved    1 - cos(card_k, card_k-1): the hop's actual size.`);
  console.log(`             CAVEAT: structurally capped at 1 - TETHER_FLOOR = ${moveCap.toFixed(3)}. Hop size and the`);
  console.log(`             floor are NOT independent variables — raising the floor mechanically`);
  console.log(`             shrinks the largest hop observable here, and the threshold with it.`);
  console.log(`    travel   1 - cos(final card, seed): how far the whole belt carried the card`);
  console.log(`             from where it started. The develop-or-circle number.`);
  console.log(`  And the chain texts. Whether a card DEVELOPED or merely toured three directions`);
  console.log(`  is a reading, not a number; the texts below are the evidence for it and they`);
  console.log(`  outrank every statistic in this section.`);

  const records: ChainRecord[] = [];

  for (let ci = 0; ci < PROBES.length; ci++) {
    const seedText = PROBES[ci]!.parent;
    const seedVec = seedVecs[ci]!;
    let parentVec = seedVec;
    let parentText = seedText;

    const historyVecs: number[][] = [seedVec];
    const historyTexts: string[] = [seedText];
    const texts: string[] = [seedText];
    const gains: number[] = [];
    const moves: number[] = [];
    let broke = false;

    console.log(`\n  seed: "${seedText}"`);

    for (let k = 0; k < stations.length; k++) {
      const station = stations[k]!;
      const items = await generateRewrites(ai, GEN_MODEL, {
        fragment: parentText,
        target: station.phrase,
        count: CHAIN_FANOUT,
        exclude: historyTexts,
      });
      if (items.length === 0) {
        console.log(`    station ${k + 1} "${station.term}"  CHAIN BROKEN: the model returned no parsable candidates`);
        broke = true;
        break;
      }
      const vecs = await embedTexts(accountId, token, items);
      const candidates = items.map((text, i) => ({ text, embedding: vecs[i]! }));
      const scored = scoreCandidates(parentVec, station.embedding, candidates);
      const best = selectChild(parentVec, station.embedding, candidates, {
        tetherFloor: floor,
        exclude: historyVecs,
      });
      if (best === null) {
        const aboveFloor = scored.filter((c) => c.tether >= floor).length;
        const why =
          aboveFloor === 0
            ? `no candidate cleared the tether floor (best tether ${maxOf(scored.map((c) => c.tether)).toFixed(3)})`
            : `all ${aboveFloor} candidates above the floor near-duplicated the lineage (DEDUPE_COSINE ${DEDUPE_COSINE})`;
        console.log(`    station ${k + 1} "${station.term}"  CHAIN BROKEN: ${why}`);
        broke = true;
        break;
      }

      const before = cosine(parentVec, station.embedding);
      const after = cosine(best.embedding, station.embedding);
      const moved = 1 - cosine(best.embedding, parentVec);
      gains.push(after - before);
      moves.push(moved);
      texts.push(best.text);
      console.log(
        `    station ${k + 1} "${station.term}"  gain ${signed(after - before)} (${before.toFixed(3)} -> ${after.toFixed(3)})` +
          `  moved ${moved.toFixed(3)}  "${best.text}"`,
      );

      parentVec = best.embedding;
      parentText = best.text;
      historyVecs.push(best.embedding);
      historyTexts.push(best.text);
    }

    const travel = 1 - cosine(parentVec, seedVec);
    records.push({ seed: seedText, texts, gains, moves, travel, complete: !broke });

    console.log(`    chain: ${texts.map((t) => `"${t}"`).join("  ->  ")}${broke ? "  [BROKE HERE]" : ""}`);
    console.log(
      `    travel from seed ${travel.toFixed(3)}   largest single hop ${moves.length > 0 ? maxOf(moves).toFixed(3) : "n/a"}` +
        `   accumulates: ${moves.length > 0 && travel > maxOf(moves) ? "yes" : "no"}`,
    );
  }

  const verdict = chainDevelopmentVerdict({ chains: records, tetherFloor: floor });
  const completeRecords = records.filter((c) => c.complete);
  const brokenRecords = records.filter((c) => !c.complete);

  console.log("\n  --- chain development summary ---");
  console.log(`  chains passing all ${CHAIN_HOPS} stations:  ${verdict.completeChains}/${PROBES.length}`);
  console.log(`  chains that broke:            ${verdict.brokenChains}/${PROBES.length}`);
  const brokenGains = brokenRecords.flatMap((c) => c.gains);
  const brokenMoves = brokenRecords.flatMap((c) => c.moves);
  if (brokenGains.length > 0) {
    console.log(`    their ${brokenGains.length} partial hops are EXCLUDED from the aggregates below (a chain breaks`);
    console.log(`    precisely when the parent has drifted, so they are not a random sample).`);
    console.log(`    for the record, those hops: mean gain ${signedMeanOrNa(brokenGains)}  mean moved ${fixedMeanOrNa(brokenMoves)}`);
  } else if (brokenRecords.length > 0) {
    console.log(`    every one of them broke on its FIRST station, so there are no partial hops to`);
    console.log(`    report and nothing was excluded from the aggregates.`);
  }

  if (verdict.outcome === "INCONCLUSIVE") {
    console.log(`  station success:  n/a`);
    console.log(`  per-hop movement: n/a`);
    console.log(`  travel from seed: n/a`);
    console.log(`  VERDICT: INCONCLUSIVE — ${verdict.completeChains} of ${PROBES.length} chains passed all ${CHAIN_HOPS} stations, and the rule`);
    console.log(`  needs ${MIN_COMPLETE_CHAINS} complete chains before it can pass at all (its accumulation term asks for`);
    console.log(`  ${ACCUMULATING_REQUIRED} accumulating chains, and only a complete chain can be one). Below that count a`);
    console.log(`  "DO NOT DEVELOP" verdict would be a fact about the sample size, not about the`);
    console.log(`  belt, so it is not printed. This is a generation or tether failure, NOT a`);
    console.log(`  crawl — the two produce the same empty aggregate and must not be reported as`);
    console.log(`  the same result. Fix the break cause shown per-chain above and re-run.`);
    return;
  }

  console.log(
    `  hops that moved the card toward their own station (gain >= ${MIN_STATION_GAIN.toFixed(3)}):  ` +
      `${share(verdict.workingHops, verdict.totalHops)}`,
  );
  console.log(`  mean gain per hop:  ${signedMeanOrNa(completeRecords.flatMap((c) => c.gains))}   (over ${verdict.totalHops} hops of complete chains)`);
  console.log(
    `  per-hop movement:  mean ${verdict.meanMove.toFixed(3)}   median ${verdict.medianMove.toFixed(3)}   (structural cap ${verdict.moveCap.toFixed(3)})`,
  );
  console.log(
    `  travel from seed:  ${completeRecords.map((c) => c.travel.toFixed(3)).join("  ")}   mean ${verdict.meanTravel.toFixed(3)}`,
  );
  console.log(`  chains ending further from the seed than their own largest hop:  ${verdict.accumulatingChains}/${verdict.completeChains}`);

  console.log(`\n  verdict rule — all three terms required, over complete chains only:`);
  console.log(`    1. STATION SUCCESS: at least ${(MIN_WORKING_HOP_FRACTION * 100).toFixed(0)}% of hops (${verdict.minWorkingHops} of ${verdict.totalHops}) gained >= ${MIN_STATION_GAIN.toFixed(3)}`);
  console.log(`       against THEIR OWN station. A station gets exactly one chance at a card, so`);
  console.log(`       a station that fails to move it is not a slow station, it is a dud; two`);
  console.log(`       thirds tolerates one dud leg in three and no more.`);
  console.log(`       The ${MIN_STATION_GAIN.toFixed(3)} is a MAGNITUDE on purpose. A sign-only term ("gain > 0")`);
  console.log(`       passes a hop that gained +0.0001 and prints it as a success, which is the`);
  console.log(`       crawl in a different coordinate. ${MIN_STATION_GAIN.toFixed(3)} sits about an order of magnitude`);
  console.log(`       below the first-hop gains a working station produced in run 1 (+0.097 to`);
  console.log(`       +0.257), so it excludes noise-scale change without demanding a strong hop`);
  console.log(`       every time. Judgement call: disagree by changing MIN_STATION_GAIN.`);
  console.log(`    2. HOP SIZE: mean per-hop movement >= ${verdict.minHopMove.toFixed(3)}`);
  console.log(`       = ${(MIN_HOP_MOVE_FRACTION * 100).toFixed(0)}% of the structural headroom (1 - TETHER_FLOOR = ${verdict.moveCap.toFixed(3)}).`);
  console.log(`       WHY ${(MIN_HOP_MOVE_FRACTION * 100).toFixed(0)}%: the floor caps a hop at ${verdict.moveCap.toFixed(3)}; a hop using under a quarter of`);
  console.log(`       that is a nudge, and ${CHAIN_HOPS} of them leave a card still reading as its seed.`);
  console.log(`       Judgement call, not a measurement: disagree by changing`);
  console.log(`       MIN_HOP_MOVE_FRACTION, and note it moves when TETHER_FLOOR moves.`);
  console.log(`    3. ACCUMULATION: at least ${ACCUMULATING_REQUIRED} of the ${verdict.completeChains} complete chains ended FURTHER from`);
  console.log(`       their seed than their own largest single hop. This is the develop-or-circle`);
  console.log(`       term and it needs no threshold of its own: a chain that doubled back lands`);
  console.log(`       within one hop's reach of the seed however big its hops were, and fails;`);
  console.log(`       a chain that kept going cannot. Disagree by changing ACCUMULATING_REQUIRED.`);
  console.log(`    NOT MEASURED: whether the development is any GOOD. No number here distinguishes`);
  console.log(`    a card that grew into something from one that was merely dragged somewhere`);
  console.log(`    else. Read the chain texts above for that and do not let these three terms`);
  console.log(`    stand in for the reading.`);
  console.log(
    `  terms: ${verdictTerm(verdict.stationOk)} stations ${verdict.workingHops}/${verdict.totalHops} vs ${verdict.minWorkingHops}   ` +
      `${verdictTerm(verdict.moveOk)} movement ${verdict.meanMove.toFixed(3)} vs ${verdict.minHopMove.toFixed(3)}   ` +
      `${verdictTerm(verdict.accumulationOk)} accumulation ${verdict.accumulatingChains}/${verdict.completeChains} vs ${ACCUMULATING_REQUIRED}`,
  );
  console.log(`  VERDICT: chains ${verdict.outcome} on this measurement.`);
  if (verdict.outcome === "DO NOT DEVELOP") {
    console.log(`  The failing term(s) are marked above. This test measures what selection did on`);
    console.log(`  the real belt; it does not isolate a cause, so do not record one. Whether the`);
    console.log(`  fix is a magnitude term in the score, a per-hop minimum move, a different`);
    console.log(`  fan-out, different station terms, or a different prompt is a separate question`);
    console.log(`  and a separate experiment.`);
  }
}

// Only run when invoked directly, so the estimator and the verdict can be
// probed from a scratch script without spending a single request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
