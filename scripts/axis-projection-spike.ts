// Companion to axis-walk-spike.ts. Committed so the numbers in
// docs/measurements/2026-08-22-drift-mechanic-spikes.md are reproducible.
//
// The walk spike killed the rewrite-chain (translation) mechanic: the seed was
// abandoned at step 2 while TETHER_FLOOR still read 0.4+, and mean displacement
// along the named axis was +0.096 against a 0.414 anisotropy baseline. The
// recommendation was projection instead — generate a pool from the seed ONCE,
// then let the swipe RE-RANK it by position along the named axis. Nothing is
// ever rewritten, so the seed survives by construction.
//
// This probes the four things that has to be true:
//
//   1. TURNOVER    — moving position changes which cards surface. If the top-k
//                    is the same everywhere, the swipe is decoration.
//   2. LEGIBILITY  — the + end actually reads as the + pole. Null axis is the
//                    chance line (workstream B of the axis-measurement doc).
//   3. RETENTION   — candidates at the EXTREMES still relate to the seed. This
//                    is the head-to-head against the walk's step-2 abandonment.
//   4. INDEPENDENCE— two named axes are not the same axis. If they correlate,
//                    a 2D swipe grid silently collapses to 1D.
//
// Generation is the shipped generateCandidates over the DO's 6 bands, so the
// pool is the pool the app would have. Everything after that is pure math and
// costs nothing. REST-from-node, so WARP and Access do not apply (CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run axis-projection

import { generateCandidates, expandPole, type AiRunner } from "../src/generation";
import { cloudflareRunner, CF_GEN_MODEL } from "./runner-lib";
import { cosine, embedTexts, requireCreds, sub } from "./axis-lib";

/** The DO's six buckets: 3 strangeness tiers x 2 altitudes. Representative
 *  values per band, matching calibrate.ts's 0.2 / 0.5 / 0.85. */
const BANDS = [
  { strangeness: 0.2, altitude: 0.25 }, { strangeness: 0.2, altitude: 0.75 },
  { strangeness: 0.5, altitude: 0.25 }, { strangeness: 0.5, altitude: 0.75 },
  { strangeness: 0.85, altitude: 0.25 }, { strangeness: 0.85, altitude: 0.75 },
];
const PER_BAND = 24;
const TOP_K = 5;        // cards visible at one position
const SWEEP = 11;       // positions sampled across the normalized axis

const SEEDS = ["public transit", "home cooking"];

/** solemn<->playful is the walk spike's axis, kept for the head-to-head.
 *  concrete<->abstract is the design doc's positive control (AUC 0.980). */
const AXES = [
  { name: "solemn -> playful", neg: "solemn", pos: "playful" },
  { name: "concrete -> abstract", neg: "concrete", pos: "abstract" },
];

// Seeded random-pair null, same construction and seed as the walk spike so the
// two runs share a chance line.
const NULL_SEED = 0x5eed1;
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const A = ["brittle", "salted", "vertical", "borrowed", "humming", "opaque", "second-hand", "lukewarm"];
const N = ["harbour", "ledger", "kiln", "tramline", "almanac", "gasket", "orchard", "vestibule"];
const P = ["kept for the winter", "measured in thirds", "left facing north",
           "counted twice on Sundays", "issued without a number", "folded before use"];
function nullPair(): [string, string] {
  const r = mulberry32(NULL_SEED);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  return [`a ${pick(A)} ${pick(N)} ${pick(P)}`, `a ${pick(A)} ${pick(N)} ${pick(P)}`];
}

let requests = 0;
function counted(ai: AiRunner): AiRunner {
  return { run: (m, i) => { requests++; return ai.run(m, i); } };
}
async function embed(id: string, tok: string, texts: string[]): Promise<number[][]> {
  requests += Math.ceil(texts.length / 96);
  return embedTexts(id, tok, texts);
}

function normalize(v: number[]): number[] {
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo;
  return span === 0 ? v.map(() => 0.5) : v.map((x) => (x - lo) / span);
}
function sd(v: number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}
/** The design doc's legibility metric: fraction in the middle fifth of the
 *  observed range. ~0.20 is even spread, >0.40 is clumping. */
function midShare(norm: number[]): number {
  return norm.filter((x) => x >= 0.4 && x <= 0.6).length / norm.length;
}
function pearson(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) || 1);
}
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  —  ");
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

interface Pool { seed: string; seedEmb: number[]; texts: string[]; embs: number[][] }

async function buildPool(ai: AiRunner, id: string, tok: string, seed: string): Promise<Pool> {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const band of BANDS) {
    const out = await generateCandidates(ai, CF_GEN_MODEL, {
      seed, strangeness: band.strangeness, altitude: band.altitude,
      anchors: [], exclude: [], count: PER_BAND,
    });
    for (const t of out) {
      const key = t.trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); texts.push(t.trim()); }
    }
  }
  const all = await embed(id, tok, [seed, ...texts]);
  return { seed, seedEmb: all[0]!, texts, embs: all.slice(1) };
}

function analyseAxis(pool: Pool, axisName: string, negEmb: number[], posEmb: number[]): number[] {
  const axisVec = sub(posEmb, negEmb);
  const raw = pool.embs.map((e) => cosine(e, axisVec));
  const norm = normalize(raw);

  console.log(`\n  ── axis: ${axisName} ──`);
  console.log(`  spread: sd(raw) ${f(sd(raw))}  range ${f(Math.min(...raw))}..${f(Math.max(...raw))}` +
              `   midShare ${f(midShare(norm))}  (0.20 even, >0.40 clumping)`);

  // 1. TURNOVER — sweep position across the normalized axis, take the TOP_K
  //    nearest candidates at each stop, and count how much the view changes.
  const surfaced = new Set<number>();
  let overlapSum = 0, overlapN = 0;
  let prev: number[] = [];
  const snapshots: { pos: number; idx: number[] }[] = [];
  for (let s = 0; s < SWEEP; s++) {
    const pos = s / (SWEEP - 1);
    const idx = norm
      .map((c, i) => ({ i, d: Math.abs(c - pos) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, TOP_K)
      .map((x) => x.i);
    idx.forEach((i) => surfaced.add(i));
    if (prev.length) { overlapSum += idx.filter((i) => prev.includes(i)).length; overlapN++; }
    prev = idx;
    snapshots.push({ pos, idx });
  }
  console.log(`  turnover: ${surfaced.size}/${pool.texts.length} distinct candidates surfaced across the sweep` +
              `   mean overlap between adjacent stops ${f(overlapSum / overlapN)}/${TOP_K}`);

  // 2 + 3. LEGIBILITY and RETENTION at the two ends and the middle.
  for (const s of [snapshots[0]!, snapshots[Math.floor(SWEEP / 2)]!, snapshots[SWEEP - 1]!]) {
    const embs = s.idx.map((i) => pool.embs[i]!);
    const lean = mean(embs.map((e) => cosine(e, posEmb) - cosine(e, negEmb)));
    const tether = mean(embs.map((e) => cosine(e, pool.seedEmb)));
    // poleLean is CIRCULAR — it measures cos-to-pos minus cos-to-neg over
    // candidates sorted by projection onto (pos - neg), so it rises by
    // construction and cannot separate a real axis from the null. Measured:
    // real swings ~0.20, null 0.176-0.231, the null scoring HIGHEST on one
    // seed. Kept only as a printed diagnostic; do not gate on it. A
    // non-circular legibility metric is workstream B of the axis-measurement
    // doc and does not exist yet.
    console.log(`  pos ${s.pos.toFixed(1)}  poleLean ${lean >= 0 ? "+" : ""}${f(lean)}  ` +
                `tetherSeed ${f(tether)}   ${s.idx.map((i) => pool.texts[i]).join(" · ")}`);
  }
  return norm;
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();
  const ai = counted(cloudflareRunner(accountId, token));
  console.log(`bands: ${BANDS.length} x ${PER_BAND}   topK: ${TOP_K}   sweep: ${SWEEP}   model: ${CF_GEN_MODEL}`);

  const poles: { name: string; neg: number[]; pos: number[] }[] = [];
  const phrases: string[] = [];
  for (const ax of AXES) {
    const [n, p] = [await expandPole(ai, CF_GEN_MODEL, ax.neg), await expandPole(ai, CF_GEN_MODEL, ax.pos)];
    console.log(`axis "${ax.name}": "${n.phrase}"  <->  "${p.phrase}"  (expanded ${n.expanded}/${p.expanded})`);
    phrases.push(n.phrase, p.phrase);
  }
  const [nullNeg, nullPos] = nullPair();
  console.log(`null axis (seeded random pair): "${nullNeg}"  <->  "${nullPos}"`);
  phrases.push(nullNeg, nullPos);

  const poleEmbs = await embed(accountId, token, phrases);
  for (let i = 0; i < AXES.length; i++) poles.push({ name: AXES[i]!.name, neg: poleEmbs[i * 2]!, pos: poleEmbs[i * 2 + 1]! });
  poles.push({ name: "NULL (random pair)", neg: poleEmbs[AXES.length * 2]!, pos: poleEmbs[AXES.length * 2 + 1]! });

  for (const seed of SEEDS) {
    const pool = await buildPool(ai, accountId, token, seed);
    console.log(`\n${"═".repeat(72)}\nseed "${seed}"  —  ${pool.texts.length} unique candidates`);
    const coordSets = poles.map((p) => analyseAxis(pool, p.name, p.neg, p.pos));

    // 4. INDEPENDENCE — if two named axes correlate, a 2D swipe grid is 1D.
    console.log(`\n  ── axis independence (Pearson r over the pool) ──`);
    for (let i = 0; i < poles.length; i++)
      for (let j = i + 1; j < poles.length; j++)
        console.log(`  r(${poles[i]!.name}, ${poles[j]!.name}) = ${f(pearson(coordSets[i]!, coordSets[j]!))}`);
  }
  console.log(`\nrequests spent: ${requests}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
