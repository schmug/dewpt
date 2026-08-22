// Committed so the numbers in docs/measurements/2026-08-22-drift-mechanic-spikes.md
// are reproducible, per the same rule that keeps axis-spike.ts and
// axis-layout-prototype.ts in the tree. Re-run it before changing the rewrite
// prompt or REWRITE_FEWSHOT, since every figure below is measured through them.
//
// Question: does repeatedly pushing along ONE named semantic axis produce a
// KNEE — a step at which the direction is exhausted and cards stop differing —
// and does it happen at a playable step count? That knee is the fail state
// issue #43's mechanic (b) ("a journey") needs in order to be truthful. If
// there is no knee, (b)'s meters are a fiction and (a) ("a navigator") is the
// honest mechanic.
//
// This walks the chain a swipe app would walk: same target every step, because
// that is what "swipe left five times" means. board-calibrate.ts's header
// records that an earlier version of ITS chain did this by accident and saw a
// flat cos-to-phrase trajectory, read there as the first hop exhausting the
// station. That is prior evidence for an EARLY knee; this measures it.
//
// Everything the model sees comes from the shipped generateRewrites/expandPole,
// so a constant measured here transfers. REST-from-node, so WARP and Access do
// not apply (CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run axis-walk

import { generateRewrites, scoreCandidates, selectChild, type Candidate } from "../src/board/rewrite";
import { ARRIVAL_COSINE, TETHER_FLOOR } from "../src/board/types";
import { expandPole, type AiRunner } from "../src/generation";
import { cloudflareRunner, CF_GEN_MODEL } from "./runner-lib";
import { cosine, embedTexts, requireCreds, sub } from "./axis-lib";

const STEPS = 15;
const FANOUT = 8;

/** Fresh of the board's few-shots on purpose. REWRITE_FEWSHOT demonstrates
 *  "urban gardening" -> a physical object, and "security awareness training"
 *  -> a mystical practice. Reusing either seed or either validated axis from
 *  the design doc would measure recall of the few-shot, not the mechanic. */
const SEED = "public transit";
const POS_TERM = "playful";
const NEG_TERM = "solemn";

// ── seeded random-pair null ────────────────────────────────────────────────
// Workstream B of the axis-measurement doc: "An axis that fails to beat this is
// not an axis." Seeded, because that doc also says an unseeded null reports a
// different chance line every run. Shaped like an expanded pole phrase so the
// only difference from the real target is that it names no coherent quality.
const NULL_SEED = 0x5eed1;
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NULL_ADJ = ["brittle", "salted", "vertical", "borrowed", "humming", "opaque", "second-hand", "lukewarm"];
const NULL_NOUN = ["harbour", "ledger", "kiln", "tramline", "almanac", "gasket", "orchard", "vestibule"];
const NULL_PRED = [
  "kept for the winter", "measured in thirds", "left facing north",
  "counted twice on Sundays", "issued without a number", "folded before use",
];
function nullPhrase(): string {
  const r = mulberry32(NULL_SEED);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  return `a ${pick(NULL_ADJ)} ${pick(NULL_NOUN)} ${pick(NULL_PRED)}`;
}

let requests = 0;
function counted(ai: AiRunner): AiRunner {
  return { run: (m, i) => { requests++; return ai.run(m, i); } };
}
async function embed(accountId: string, token: string, texts: string[]): Promise<number[][]> {
  requests++;
  return embedTexts(accountId, token, texts);
}

/** Mean pairwise cosine inside one fan-out. Rising = the candidates are
 *  converging on each other, i.e. the direction has stopped generating
 *  variety. This is the "cards stop differing" half of pole capture. */
function diversity(vs: number[][]): number {
  if (vs.length < 2) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) { s += cosine(vs[i]!, vs[j]!); n++; }
  return s / n;
}

interface Step {
  step: number; text: string;
  arrival: number;      // cos(card, target phrase) — ARRIVAL_COSINE is exhaustion
  tetherSeed: number;   // cos(card, seed) — still about the seed?
  tetherParent: number; // cos(card, previous card) — the shipped floor's quantity
  fanoutDiv: number;    // mean pairwise cos within the fan-out
  axisDisp: number;     // cos(card - seed, posVec - negVec) — moved along the AXIS?
}

async function walk(
  label: string, ai: AiRunner, accountId: string, token: string,
  targetPhrase: string, targetEmb: number[], seedEmb: number[], axisVec: number[] | null,
): Promise<{ label: string; steps: Step[]; diedAt: number | null }> {
  const steps: Step[] = [];
  let current = SEED;
  let currentEmb = seedEmb;
  const historyTexts: string[] = [SEED];
  const historyEmbs: number[][] = [seedEmb];

  for (let step = 1; step <= STEPS; step++) {
    const texts = await generateRewrites(ai, CF_GEN_MODEL, {
      fragment: current, target: targetPhrase, count: FANOUT, exclude: historyTexts,
    });
    if (texts.length === 0) return { label, steps, diedAt: step };
    const embs = await embed(accountId, token, texts);
    const cands: Candidate[] = texts.map((text, i) => ({ text, embedding: embs[i]! }));

    const child = selectChild(currentEmb, targetEmb, cands, { exclude: historyEmbs });
    if (child === null) return { label, steps, diedAt: step };

    steps.push({
      step, text: child.text,
      arrival: cosine(child.embedding, targetEmb),
      tetherSeed: cosine(child.embedding, seedEmb),
      tetherParent: child.tether,
      fanoutDiv: diversity(embs),
      axisDisp: axisVec ? cosine(sub(child.embedding, seedEmb), axisVec) : NaN,
    });

    current = child.text;
    currentEmb = child.embedding;
    historyTexts.push(child.text);
    historyEmbs.push(child.embedding);
  }
  return { label, steps, diedAt: null };
}

function f(n: number): string { return Number.isFinite(n) ? n.toFixed(3) : "  —  "; }

function report(r: { label: string; steps: Step[]; diedAt: number | null }): void {
  console.log(`\n── ${r.label} ${"─".repeat(Math.max(0, 60 - r.label.length))}`);
  console.log("  step  arrival  tetherSeed  tetherPar  fanoutDiv  axisDisp  text");
  for (const s of r.steps) {
    const flag = s.arrival >= ARRIVAL_COSINE ? " ←exhausted" : "";
    console.log(
      `  ${String(s.step).padStart(4)}   ${f(s.arrival)}     ${f(s.tetherSeed)}     ` +
      `${f(s.tetherParent)}     ${f(s.fanoutDiv)}    ${f(s.axisDisp)}  ${s.text}${flag}`,
    );
  }
  if (r.diedAt !== null) console.log(`  CHAIN DIED at step ${r.diedAt} (no candidate cleared TETHER_FLOOR=${TETHER_FLOOR})`);
  const arrivals = r.steps.map((s) => s.arrival);
  const knee = r.steps.find((s) => s.arrival >= ARRIVAL_COSINE)?.step ?? null;
  const first = r.steps[0], last = r.steps[r.steps.length - 1];
  console.log(`  knee (first arrival >= ${ARRIVAL_COSINE}): ${knee ?? `none within ${r.steps.length}`}`);
  if (first && last) {
    console.log(`  arrival   ${f(first.arrival)} -> ${f(last.arrival)}   (max ${f(Math.max(...arrivals))})`);
    console.log(`  tetherSeed ${f(first.tetherSeed)} -> ${f(last.tetherSeed)}`);
    console.log(`  fanoutDiv ${f(first.fanoutDiv)} -> ${f(last.fanoutDiv)}`);
  }
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();
  const ai = counted(cloudflareRunner(accountId, token));

  console.log(`seed: "${SEED}"   steps: ${STEPS}   fanout: ${FANOUT}   model: ${CF_GEN_MODEL}`);

  const pos = await expandPole(ai, CF_GEN_MODEL, POS_TERM);
  const neg = await expandPole(ai, CF_GEN_MODEL, NEG_TERM);
  const nul = nullPhrase();
  console.log(`\nreal axis: "${NEG_TERM}" -> "${neg.phrase}" (expanded=${neg.expanded})`);
  console.log(`           "${POS_TERM}" -> "${pos.phrase}" (expanded=${pos.expanded})`);
  console.log(`null target (seeded random pair): "${nul}"`);

  const [seedEmb, posEmb, negEmb, nulEmb] = await embed(accountId, token, [SEED, pos.phrase, neg.phrase, nul]);
  const axisVec = sub(posEmb!, negEmb!);

  const real = await walk("REAL — push toward the expanded pole", ai, accountId, token, pos.phrase, posEmb!, seedEmb!, axisVec);
  report(real);
  const nullRun = await walk("NULL — push toward a seeded random phrase", ai, accountId, token, nul, nulEmb!, seedEmb!, axisVec);
  report(nullRun);

  console.log(`\nrequests spent: ${requests}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
