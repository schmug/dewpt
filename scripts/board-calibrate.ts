// M0 calibration for the conveyor board. Measures the three constants the
// design cannot guess — TETHER_FLOOR, ARRIVAL_COSINE and CANDIDATES_PER_HOP —
// and then answers the question those three do not: does a chain of hops
// actually PROGRESS, or does it crawl?
//
// The crawl worry is structural. `scoreCandidates` scores a candidate by the
// COSINE between its displacement and the station vector: alignment, not
// distance. It is magnitude-independent, so a tiny nudge exactly along
// `phrase - parent` outscores a large, mostly-aligned move. Argmax-by-alignment
// could therefore pick a minimally-moved child every hop, leaving a card barely
// travelled after five of them and every lineage reading the same. Section 4
// runs real chains and measures it instead of assuming either way.
//
// Everything the model sees comes from `generateRewrites` in src/board/rewrite.ts
// — the same function, prompt, few-shots and temperature the BoardDO ships. A
// constant measured against a different prompt does not transfer, so this script
// owns no prompt of its own.
//
// The separation AUC is a GATE and is evaluated after ~3 requests, before the
// ~51 that follow. A failed gate costs three calls, not the whole run.
//
// REST-from-node like calibrate.ts and the axis spikes, so it is unaffected by
// the local wrangler-dev egress issues (see CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run board-calibrate
//
// The token needs "Workers AI - Read".

import { pathToFileURL } from "node:url";
import { generateRewrites, scoreCandidates, selectChild } from "../src/board/rewrite";
import type { AiRunner } from "../src/generation";
import { DEDUPE_COSINE } from "../src/types";
import { auc, cosine, embedTexts, requireCreds } from "./axis-lib";

const GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The mechanic's gate. Below this, genuine rewrites and non-sequiturs are not
 *  separable by cosine-against-parent and no tether floor can be chosen. */
const GATE_AUC = 0.8;

/** Hops per chain in the progression probe. Long enough that a crawl shows up
 *  as a flat trajectory, short enough to keep this one cheap run. */
const CHAIN_HOPS = 5;

/** Candidates generated per hop inside the chain probe. Held fixed so the
 *  progression result is about selection, not about fan-out width. */
const CHAIN_FANOUT = 8;

/** Fan-out widths compared in section 3. */
const FANOUT_SWEEP = [4, 8, 12];

/** Monotonic trajectories required for the "chains progress" verdict. */
const MONOTONIC_REQUIRED = 2;

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
/** Per probe: one seed embedding, then a generation + an embedding per hop.
 *  Chains that break early cost less; this is the ceiling. */
const SECTION4_MAX_REQUESTS = PROBES.length * (1 + CHAIN_HOPS * 2);
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
  const recommended = rows.find((r) => Math.min(...r.survivors) >= MIN_SURVIVORS_PER_HOP) ?? null;
  const next = recommended ? rows.find((r) => r.n > recommended.n) ?? null : null;
  return {
    recommended,
    next,
    marginalSurvivors: recommended && next ? mean(next.survivors) - mean(recommended.survivors) : Number.NaN,
  };
}

export interface ChainStats {
  /** Per-hop cos-to-phrase deltas, complete chains only. */
  completeDeltas: number[];
  /** Per-hop `1 - cosine(child, parent)`, complete chains only. */
  completeMoves: number[];
  /** The same two series for chains that broke — reported, never aggregated. */
  brokenDeltas: number[];
  brokenMoves: number[];
  completeChains: number;
  brokenChains: number;
  monotonicChains: number;
  chainCount: number;
  tetherFloor: number;
}

export type ChainOutcome = "PROGRESS" | "DO NOT PROGRESS" | "INCONCLUSIVE";

export interface ChainVerdict {
  outcome: ChainOutcome;
  meanDelta: number;
  meanMove: number;
  medianMove: number;
  moveCap: number;
  minHopMove: number;
  deltaOk: boolean;
  moveOk: boolean;
  monoOk: boolean;
}

/** Three terms, all required. The magnitude term is the point: without it a
 *  chain advancing +0.001 per hop is monotonic with a positive mean and would
 *  print PROGRESS — which IS the crawl this section exists to detect.
 *
 *  INCONCLUSIVE is a distinct outcome, not a flavour of failure. `mean([])` is
 *  0, so a run where every chain broke produces the same empty aggregate as a
 *  crawl; conflating them reports a selection problem when the real cause was
 *  total generation failure. */
export function chainProgressionVerdict(s: ChainStats): ChainVerdict {
  const moveCap = 1 - s.tetherFloor;
  const minHopMove = MIN_HOP_MOVE_FRACTION * moveCap;
  const meanDelta = mean(s.completeDeltas);
  const meanMove = mean(s.completeMoves);
  const deltaOk = meanDelta > 0;
  const moveOk = meanMove >= minHopMove;
  const monoOk = s.monotonicChains >= MONOTONIC_REQUIRED;
  const outcome: ChainOutcome =
    s.completeChains === 0 ? "INCONCLUSIVE" : deltaOk && moveOk && monoOk ? "PROGRESS" : "DO NOT PROGRESS";
  return {
    outcome,
    meanDelta,
    meanMove,
    medianMove: median(s.completeMoves),
    moveCap,
    minHopMove,
    deltaOk,
    moveOk,
    monoOk,
  };
}

async function main(): Promise<void> {
  // Cost first, before anything can be spent — including before the credential
  // check, so a run without credentials still tells you what a real one costs.
  console.log(
    `cost estimate: up to ${TOTAL_MAX_REQUESTS} Workers AI requests ` +
      `(${SECTION1_REQUESTS} embeddings to reach the gate, then up to ${POST_GATE_MAX_REQUESTS} more: ` +
      `${SECTION3_REQUESTS} for the fan-out sweep, up to ${SECTION4_MAX_REQUESTS} for the chains).`,
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
  console.log("\n=== GATE ===");
  if (tetherAuc < GATE_AUC) {
    console.log(`  separation AUC ${tetherAuc.toFixed(3)} < ${GATE_AUC.toFixed(2)}  ->  FAIL`);
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
    const minSurvivors = Math.min(...row.survivors);
    const withAny = row.survivors.filter((s) => s > 0).length;
    console.log(
      `  n=${String(n).padStart(2)}  parsed ${row.parsed.join("/")}` +
        `   survivors ${row.survivors.join("/")} (mean ${mean(row.survivors).toFixed(1)}, min ${minSurvivors})` +
        `   probes with >=1: ${withAny}/${PROBES.length}` +
        `   argmax lift over mean ${signed(mean(row.lifts))}`,
    );
  }

  const { recommended, next, marginalSurvivors } = recommendWidth(rows);
  if (recommended) {
    console.log(`  RECOMMENDATION: CANDIDATES_PER_HOP = ${recommended.n}`);
    console.log(`    smallest tested n where every probe kept >= ${MIN_SURVIVORS_PER_HOP} candidates above the floor.`);
    if (next) {
      console.log(
        `    going to n=${next.n} adds ${marginalSurvivors.toFixed(1)} survivors per hop on average` +
          ` — ${marginalSurvivors < SURVIVOR_STABILITY_EPS ? `under ${SURVIVOR_STABILITY_EPS.toFixed(1)}, so the extra width is buying nothing` : `still scaling, so a wider sweep may be worth measuring`}.`,
      );
    } else {
      console.log(`    n=${recommended.n} is the widest tested value, so the marginal return above it is unmeasured.`);
    }
  } else {
    const widest = rows[rows.length - 1]!;
    console.log(`  RECOMMENDATION: none of ${FANOUT_SWEEP.join(", ")} met the criterion.`);
    console.log(`    Best tested is n=${widest.n} (min survivors ${Math.min(...widest.survivors)}). Widen the sweep`);
    console.log(`    above ${widest.n} and re-run before writing a constant; do not adopt a value the`);
    console.log(`    measurement did not support.`);
  }

  // ── 4. CHAIN PROGRESSION ────────────────────────────────────────────────
  // `score` is alignment, not distance, so argmax may prefer a minimally-moved
  // child every hop. Run real chains through the production selection path and
  // watch both cosine-to-phrase AND the size of each hop.
  const moveCap = 1 - floor;

  console.log("\n=== CHAIN PROGRESSION ===");
  console.log(`  ${CHAIN_HOPS} sequential hops per probe, ${CHAIN_FANOUT} candidates each, same station phrase every hop.`);
  console.log(`  The child is chosen by production's selectChild: argmax score among candidates`);
  console.log(`  with tether >= ${floor.toFixed(3)} that do not exceed DEDUPE_COSINE ${DEDUPE_COSINE} against anything`);
  console.log(`  already in the lineage. The prompt also receives the lineage's texts as its`);
  console.log(`  exclusion list, exactly as the BoardDO hop does.`);
  console.log(`  "moved" is 1 - cosine(child, its own parent): the hop's actual size.`);
  console.log(`  CAVEAT: moved is structurally capped at 1 - TETHER_FLOOR = ${moveCap.toFixed(3)}. Hop size and`);
  console.log(`  the floor are NOT independent variables — raising the floor mechanically shrinks`);
  console.log(`  the largest hop this test can ever observe, and shrinks this threshold with it.`);

  const completeDeltas: number[] = [];
  const completeMoves: number[] = [];
  const brokenDeltas: number[] = [];
  const brokenMoves: number[] = [];
  let monotonicChains = 0;
  let completeChains = 0;
  let brokenChains = 0;

  for (const probe of PROBES) {
    const seed = await embedTexts(accountId, token, [probe.parent, probe.phrase]);
    const phraseVec = seed[1]!;
    let parentVec = seed[0]!;
    let parentText = probe.parent;
    let prevCos = cosine(parentVec, phraseVec);

    const historyVecs: number[][] = [parentVec];
    const historyTexts: string[] = [probe.parent];
    const trajectory: number[] = [];
    const deltas: number[] = [];
    const moves: number[] = [];
    let broke = false;

    console.log(`\n  ${probe.parent}  ->  ${probe.phrase}`);
    console.log(`    hop 0  cos-to-phrase ${prevCos.toFixed(3)}                        "${probe.parent}"  (seed)`);

    for (let hop = 1; hop <= CHAIN_HOPS; hop++) {
      const items = await generateRewrites(ai, GEN_MODEL, {
        fragment: parentText,
        target: probe.phrase,
        count: CHAIN_FANOUT,
        exclude: historyTexts,
      });
      if (items.length === 0) {
        console.log(`    hop ${hop}  CHAIN BROKEN: the model returned no parsable candidates`);
        broke = true;
        break;
      }
      const vecs = await embedTexts(accountId, token, items);
      const candidates = items.map((text, i) => ({ text, embedding: vecs[i]! }));
      const scored = scoreCandidates(parentVec, phraseVec, candidates);
      const best = selectChild(parentVec, phraseVec, candidates, { tetherFloor: floor, exclude: historyVecs });
      if (best === null) {
        const aboveFloor = scored.filter((c) => c.tether >= floor).length;
        const why =
          aboveFloor === 0
            ? `no candidate cleared the tether floor (best tether ${Math.max(...scored.map((c) => c.tether)).toFixed(3)})`
            : `all ${aboveFloor} candidates above the floor near-duplicated the lineage (DEDUPE_COSINE ${DEDUPE_COSINE})`;
        console.log(`    hop ${hop}  CHAIN BROKEN: ${why}`);
        broke = true;
        break;
      }

      const cos = cosine(best.embedding, phraseVec);
      const moved = 1 - cosine(best.embedding, parentVec);
      trajectory.push(cos);
      deltas.push(cos - prevCos);
      moves.push(moved);
      console.log(
        `    hop ${hop}  cos-to-phrase ${cos.toFixed(3)} (${signed(cos - prevCos)})  moved ${moved.toFixed(3)}  "${best.text}"`,
      );

      prevCos = cos;
      parentVec = best.embedding;
      parentText = best.text;
      historyVecs.push(best.embedding);
      historyTexts.push(best.text);
    }

    // Broken chains are held out of the aggregates. A chain breaks precisely
    // when its parent has drifted, so its hops are not a random sample of hops
    // and folding them in biases the global mean. They are reported separately
    // rather than discarded.
    if (broke) {
      brokenChains++;
      brokenDeltas.push(...deltas);
      brokenMoves.push(...moves);
    } else {
      completeChains++;
      completeDeltas.push(...deltas);
      completeMoves.push(...moves);
    }
    const isMonotonic = !broke && deltas.length === CHAIN_HOPS && deltas.every((d) => d > 0);
    if (isMonotonic) monotonicChains++;

    console.log(`    trajectory  ${trajectory.length > 0 ? trajectory.map((c) => c.toFixed(3)).join("  ") : "(none — chain broke on the first hop)"}`);
    console.log(
      `    mean per-hop increase ${signed(mean(deltas))}   mean moved ${moves.length > 0 ? mean(moves).toFixed(3) : "n/a"}   monotonic: ${isMonotonic ? "yes" : "no"}`,
    );
  }

  const verdict = chainProgressionVerdict({
    completeDeltas,
    completeMoves,
    brokenDeltas,
    brokenMoves,
    completeChains,
    brokenChains,
    monotonicChains,
    chainCount: PROBES.length,
    tetherFloor: floor,
  });

  console.log("\n  --- chain progression summary ---");
  console.log(`  chains completing all ${CHAIN_HOPS} hops:  ${completeChains}/${PROBES.length}`);
  console.log(`  chains that broke:              ${brokenChains}/${PROBES.length}`);
  if (brokenChains > 0) {
    console.log(
      `    their ${brokenDeltas.length} partial hops are EXCLUDED from the aggregates below (a chain breaks`,
    );
    console.log(`    precisely when the parent has drifted, so they are not a random sample).`);
    console.log(
      `    for the record, those hops: mean delta ${signed(mean(brokenDeltas))}  mean moved ${brokenMoves.length > 0 ? mean(brokenMoves).toFixed(3) : "n/a"}`,
    );
  }

  if (verdict.outcome === "INCONCLUSIVE") {
    console.log(`  mean per-hop increase:  n/a`);
    console.log(`  per-hop movement:       n/a`);
    console.log(
      `  VERDICT: INCONCLUSIVE — every chain broke before completing ${CHAIN_HOPS} hops, so there is no`,
    );
    console.log(`  trajectory to judge. This is a generation or tether failure, NOT a crawl: the two`);
    console.log(`  produce the same empty aggregate and must not be reported as the same result.`);
    console.log(`  Fix the break cause shown per-probe above and re-run before drawing any`);
    console.log(`  conclusion about whether selection makes chains progress.`);
    return;
  }

  console.log(`  mean per-hop increase in cos-to-phrase:  ${signed(verdict.meanDelta)}  (over ${completeDeltas.length} hops of complete chains)`);
  console.log(
    `  per-hop movement:  mean ${verdict.meanMove.toFixed(3)}   median ${verdict.medianMove.toFixed(3)}   (structural cap ${verdict.moveCap.toFixed(3)})`,
  );
  console.log(`  monotonically increasing trajectories:   ${monotonicChains}/${PROBES.length}`);

  console.log(`\n  verdict rule — all three terms required:`);
  console.log(`    1. mean per-hop increase in cos-to-phrase > 0`);
  console.log(`    2. mean per-hop movement >= ${verdict.minHopMove.toFixed(3)}`);
  console.log(`       = ${(MIN_HOP_MOVE_FRACTION * 100).toFixed(0)}% of the structural headroom (1 - TETHER_FLOOR = ${verdict.moveCap.toFixed(3)}).`);
  console.log(`       WHY ${(MIN_HOP_MOVE_FRACTION * 100).toFixed(0)}%: the floor caps a hop at ${verdict.moveCap.toFixed(3)}; a hop using under a quarter of`);
  console.log(`       that is a nudge, and ${CHAIN_HOPS} of them leave a card still reading as its seed.`);
  console.log(`       Without this term a chain advancing +0.001 per hop counts as PROGRESS —`);
  console.log(`       which is exactly the crawl this section exists to detect. The 25% is a`);
  console.log(`       judgement call, not a measurement: disagree with it by changing`);
  console.log(`       MIN_HOP_MOVE_FRACTION, and note it moves when TETHER_FLOOR moves.`);
  console.log(`    3. at least ${MONOTONIC_REQUIRED} of ${PROBES.length} trajectories monotonic`);
  console.log(
    `  terms: ${verdictTerm(verdict.deltaOk)} delta ${signed(verdict.meanDelta)}   ` +
      `${verdictTerm(verdict.moveOk)} movement ${verdict.meanMove.toFixed(3)} vs ${verdict.minHopMove.toFixed(3)}   ` +
      `${verdictTerm(verdict.monoOk)} monotonic ${monotonicChains}/${PROBES.length} vs ${MONOTONIC_REQUIRED}`,
  );
  console.log(`  VERDICT: chains ${verdict.outcome} on this measurement.`);
  if (verdict.outcome === "DO NOT PROGRESS") {
    console.log(`  The failing term(s) are marked above. This test measures the trajectory that`);
    console.log(`  selection produced; it does not isolate a cause, so do not record one. Whether`);
    console.log(`  the fix is a magnitude term in the score, a per-hop minimum move, a different`);
    console.log(`  fan-out, or a different prompt is a separate question and a separate experiment.`);
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
