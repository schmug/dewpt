// Workstream B for dewpt: does any cheap statistic tell a real user-named axis
// from a random one, over a real pool, with a chance line under it?
//
// The axis-measurement doc's workstream B scores coherence against a
// 1/sqrt(n-1) chance line assuming 16 curated pairs per axis. A dewpt axis is
// ONE pair, so that construction does not port. What ports is a PERMUTATION
// TEST: build the chance line from K seeded random-pair null axes computed over
// the same pool, and read the real axis as a percentile against it. That needs
// no curated pairs, and it rehabilitates a partly-circular statistic, because
// the same circularity applies to every null.
//
// This must be allowed to return a null result. Measured in
// docs/measurements/2026-08-22-drift-mechanic-spikes.md, no statistic already to
// hand has any power: poleLean swings 0.20 real against 0.176-0.231 null (null
// HIGHEST on one seed), sd is 0.044-0.061 for both, midShare 0.29-0.45 for both.
// So the job is to FIND a statistic, not to apply one.
//
// GROUND TRUTH is an LLM judge: sample candidates from the pool, have the model
// rate each on the axis, and take AUC of the projection against those ratings —
// scripts/axis-spike.ts's method moved from hand-labelled word lists onto real
// pool candidates. src/metrics.ts owns AUC so there stays exactly one in this
// codebase. The judge's ratings also give the NULLS a free chance line: AUC of a
// null axis's projection against the REAL axis's ratings is exactly "how well
// does a random direction predict this axis's ordering", at no extra inference.
//
// CANDIDATE CHEAP PROXIES, both unmeasured before this run:
//   poleCoherence  mean pairwise cos among top-k at each pole. Non-circular —
//                  never references the axis vector.
//   interPoleMargin cos between the two pole-end centroids. Lower = separated.
// If either tracks judgeAUC across the matrix, it can ship in axis-lint.js
// stage 2 and the judge stays in scripts/. If neither does, stage 2 ships empty.
//
// REST-from-node, so WARP and Access do not apply (CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run axis-power

import { generateCandidates, expandPole, type AiRunner, type ChatMessage } from "../src/generation";
import { auc } from "../src/metrics";
import { ALT_ABSTRACTION, BUCKET_KEYS, DEDUPE_COSINE, TIER_STRANGENESS, type Alt, type Tier } from "../src/types";
import { cloudflareRunner, CF_GEN_MODEL } from "./runner-lib";
import { cosine, embedTexts, mean as meanVec, requireCreds, sub } from "./axis-lib";

/** Built from the SHIPPED constants. This file previously hard-coded
 *  0.2/0.5/0.85 x 0.25/0.75 while describing its input as a real pool; production
 *  is TIER_STRANGENESS 0.15/0.5/0.85 and ALT_ABSTRACTION 0.2/0.8. Cycle 2. */
const BANDS = BUCKET_KEYS.map((bucket) => ({
  strangeness: TIER_STRANGENESS[Number(bucket[1]) as Tier],
  altitude: ALT_ABSTRACTION[Number(bucket[3]) as Alt],
}));
const PER_BAND = 24;
const JUDGED = 40;      // candidates rated per (seed, axis)
const TOP_K = 8;        // pole-end sample for the cheap proxies
const NULLS = 200;      // permutation nulls. Free — pure maths on existing vectors.

/** Three seeds, deliberately unlike each other. The pills this ranks are shown
 *  to every user against whatever they type, so an axis that only works on
 *  concrete nouns is not a recommendation. Still thin — three is not many. */
const SEEDS = ["public transit", "home cooking", "friendship"];

/** Three real axes and one surface control. concrete<->abstract is the design
 *  doc's validated case (AUC 0.980 on hand-labelled words); solemn<->playful is
 *  the known mush this whole workstream exists because of; practical<->mystical
 *  scored 1.000 there. The surface control is `X` / `more X`, which ports from
 *  the doc unchanged and pins what a pure token-difference achieves — it is
 *  deliberately NOT expanded, since expanding it would destroy what it measures. */
const AXES = [
  // Two with prior evidence, kept as anchors so this run is comparable to the
  // earlier ones.
  { name: "concrete -> abstract", neg: "concrete", pos: "abstract", expand: true },
  { name: "practical -> mystical", neg: "practical", pos: "mystical", expand: true },
  // The known-mush axis, kept as a NEGATIVE reference. If a candidate cannot
  // beat this it does not belong on a pill.
  { name: "solemn -> playful", neg: "solemn", pos: "playful", expand: true },
  // Candidates being auditioned for the compass.
  { name: "simple -> intricate", neg: "simple", pos: "intricate", expand: true },
  { name: "ancient -> futuristic", neg: "ancient", pos: "futuristic", expand: true },
  { name: "intimate -> industrial", neg: "intimate", pos: "industrial", expand: true },
  { name: "calm -> frantic", neg: "calm", pos: "frantic", expand: true },
  { name: "natural -> synthetic", neg: "natural", pos: "synthetic", expand: true },
  // The lexical ceiling. Nothing at or below this is an axis.
  { name: "SURFACE playful -> more playful", neg: "playful", pos: "more playful", expand: false },
];

const NULL_SEED = 0xb1a5e;
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let requests = 0;
function counted(ai: AiRunner): AiRunner {
  return { run: (m, i) => { requests++; return ai.run(m, i); } };
}
async function embed(id: string, tok: string, texts: string[]): Promise<number[][]> {
  requests += Math.ceil(texts.length / 96);
  return embedTexts(id, tok, texts);
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  —  ");
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

// ── the judge ───────────────────────────────────────────────────────────────

const JUDGE_K = 10;     // items forced to each pole -> balanced 10+/10- groups

// FORCED CHOICE, not free rating. A first pass rated every item 0-10 and kept
// >=7 / <=3; because most pool candidates are genuinely neutral on any given
// axis, that produced label sets as lopsided as 1+/28- and pushed the null's
// p95 to 0.91-1.00, where nothing can be discriminated. Asking for the K
// extremes at each end guarantees K+/K- in every cell and gives the null
// distribution a real spread to sit in.
const JUDGE_SYSTEM = `You sort short phrases onto a semantic axis.

You are given two descriptive phrases naming the two ends of an axis, and a numbered list of items.
Pick the items that sit FURTHEST toward each end.

Rules:
- Respond with JSON only, exactly: {"low": [numbers], "high": [numbers]}. No prose, no code fences.
- Each list holds item NUMBERS from the list given, not the text.
- The two lists must not overlap.
- Return exactly the requested count in each list. If few items feel extreme, still return that many — pick the most extreme available.`;

function judgeMessages(lowPhrase: string, highPhrase: string, items: string[], k: number): ChatMessage[] {
  const numbered = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content:
        `LOW end:  ${lowPhrase}\nHIGH end: ${highPhrase}\n\n${numbered}\n\n` +
        `Return {"low": [...], "high": [...]} with exactly ${k} numbers in each list. No other text.`,
    },
  ];
}

/** Returns 0-based index sets, or null so a malformed batch degrades to
 *  "unrated" rather than killing the run. Enforces range and disjointness —
 *  an overlapping pick would put the same candidate in both groups and inflate
 *  AUC toward 0.5 without anything looking wrong. */
function parsePicks(raw: unknown, n: number): { low: number[]; high: number[] } | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
  const obj = parsed as { low?: unknown; high?: unknown };
  const clean = (v: unknown): number[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.map((x) => (typeof x === "number" ? x : Number(x)) - 1);
    return out.every((i) => Number.isInteger(i) && i >= 0 && i < n) ? [...new Set(out)] : null;
  };
  const low = clean(obj.low), high = clean(obj.high);
  if (!low || !high || low.length === 0 || high.length === 0) return null;
  const highSet = new Set(high);
  if (low.some((i) => highSet.has(i))) return null;
  return { low, high };
}

function extract(result: unknown): unknown {
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r?.response === "string") return r.response;
  return r?.choices?.[0]?.message?.content;
}

/** One call per cell — forced choice must see the whole sample at once to pick
 *  extremes, so this cannot be batched the way free rating was. Retries once,
 *  since a single malformed object would otherwise lose a whole cell. */
async function judge(
  ai: AiRunner, low: string, high: string, items: string[],
): Promise<{ low: number[]; high: number[] } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.run(CF_GEN_MODEL, {
        messages: judgeMessages(low, high, items, JUDGE_K),
        temperature: 0.1,
        max_tokens: 512,
      });
      const picks = parsePicks(extract(res), items.length);
      if (picks) return picks;
    } catch { /* fall through to retry */ }
  }
  return null;
}

// ── statistics ──────────────────────────────────────────────────────────────

/** Mean pairwise cosine inside a set. Higher = tighter cluster. */
function coherence(vs: number[][]): number {
  if (vs.length < 2) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) { s += cosine(vs[i]!, vs[j]!); n++; }
  return s / n;
}

interface Stats { poleCoherence: number; interPoleMargin: number; poleLean: number }

/** Every cheap statistic for one axis vector over one pool, computed the same
 *  way for a real axis and for a null so the permutation test is apples to
 *  apples. */
function statsFor(embs: number[][], axisVec: number[], negEmb: number[], posEmb: number[]): Stats {
  const coords = embs.map((e) => cosine(e, axisVec));
  const order = coords.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  const lowIdx = order.slice(0, TOP_K).map((o) => o.i);
  const highIdx = order.slice(-TOP_K).map((o) => o.i);
  const low = lowIdx.map((i) => embs[i]!);
  const high = highIdx.map((i) => embs[i]!);
  return {
    poleCoherence: (coherence(low) + coherence(high)) / 2,
    interPoleMargin: cosine(meanVec(low), meanVec(high)),
    poleLean: avg(high.map((e) => cosine(e, posEmb) - cosine(e, negEmb)))
            - avg(low.map((e) => cosine(e, posEmb) - cosine(e, negEmb))),
  };
}

/** Fraction of the null distribution the real value exceeds. For margin, lower
 *  is better, so the caller inverts. */
function percentile(value: number, nulls: number[]): number {
  const below = nulls.filter((n) => n < value).length;
  return below / nulls.length;
}

interface Pool { seed: string; texts: string[]; embs: number[][] }

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
  const rawEmbs = await embed(id, tok, texts);
  // PoolCore drops near-duplicates by embedding cosine, not by exact text.
  // Calling a text-deduped list "a real pool" was the other half of cycle 2's
  // parity finding.
  const keptTexts: string[] = [];
  const keptEmbs: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    if (keptEmbs.some((e) => cosine(e, rawEmbs[i]!) > DEDUPE_COSINE)) continue;
    keptTexts.push(texts[i]!);
    keptEmbs.push(rawEmbs[i]!);
  }
  console.log(`  (dedupe: ${texts.length} raw -> ${keptTexts.length} kept at cosine > ${DEDUPE_COSINE})`);
  return { seed, texts: keptTexts, embs: keptEmbs };
}

interface Cell {
  seed: string; axis: string;
  judgeAUC: number; nullAUCp50: number; nullAUCp95: number; aucPercentile: number;
  rated: number; pos: number; neg: number;
  coh: number; cohPct: number;
  margin: number; marginPct: number;
  lean: number; leanPct: number;
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();
  const ai = counted(cloudflareRunner(accountId, token));
  console.log(`bands ${BANDS.length}x${PER_BAND}  judged ${JUDGED}  topK ${TOP_K}  nulls ${NULLS}  model ${CF_GEN_MODEL}`);

  // Pole phrases, once. The surface control is deliberately unexpanded.
  const poleTexts: string[] = [];
  const axisMeta: { name: string; low: string; high: string }[] = [];
  for (const ax of AXES) {
    const low = ax.expand ? (await expandPole(ai, CF_GEN_MODEL, ax.neg)).phrase : ax.neg;
    const high = ax.expand ? (await expandPole(ai, CF_GEN_MODEL, ax.pos)).phrase : ax.pos;
    axisMeta.push({ name: ax.name, low, high });
    poleTexts.push(low, high);
    console.log(`  ${ax.name}\n    low  "${low}"\n    high "${high}"`);
  }
  const poleEmbs = await embed(accountId, token, poleTexts);

  const cells: Cell[] = [];
  for (const seed of SEEDS) {
    const pool = await buildPool(ai, accountId, token, seed);
    console.log(`\n${"═".repeat(78)}\nseed "${seed}" — ${pool.texts.length} unique candidates`);

    // One seeded null set per pool, shared across axes so every axis is scored
    // against the same chance line.
    const r = mulberry32(NULL_SEED);
    const nullVecs: number[][] = [];
    for (let k = 0; k < NULLS; k++) {
      const a = Math.floor(r() * pool.texts.length);
      let b = Math.floor(r() * pool.texts.length);
      if (b === a) b = (b + 1) % pool.texts.length;
      nullVecs.push(sub(pool.embs[b]!, pool.embs[a]!));
    }

    for (let i = 0; i < axisMeta.length; i++) {
      const meta = axisMeta[i]!;
      const negEmb = poleEmbs[i * 2]!, posEmb = poleEmbs[i * 2 + 1]!;
      const axisVec = sub(posEmb, negEmb);

      // Ground truth. STRIDED, not the first JUDGED: buildPool appends band by
      // band, so slice(0, 40) of a 136-item pool is bands 1-2 only — the judge
      // would never see a high-strangeness candidate. A deterministic stride
      // spreads the sample across all six.
      const stride = Math.max(1, Math.floor(pool.texts.length / JUDGED));
      const pick: number[] = [];
      for (let j = 0; j < pool.texts.length && pick.length < JUDGED; j += stride) pick.push(j);
      const sample = pick.map((j) => pool.texts[j]!);
      const sampleEmbs = pick.map((j) => pool.embs[j]!);

      const picks = await judge(ai, meta.low, meta.high, sample);
      const posScores: number[] = [], negScores: number[] = [];
      const nullPos: number[][] = [], nullNeg: number[][] = [];
      if (picks) {
        for (const j of picks.high) { posScores.push(cosine(sampleEmbs[j]!, axisVec)); nullPos.push(sampleEmbs[j]!); }
        for (const j of picks.low) { negScores.push(cosine(sampleEmbs[j]!, axisVec)); nullNeg.push(sampleEmbs[j]!); }
      }
      const judgeAUC = auc(posScores, negScores);

      // The nulls' chance line for AUC, free: how well does a random direction
      // predict THIS axis's judge ordering?
      const nullAUCs = nullVecs
        .map((nv) => auc(nullPos.map((e) => cosine(e, nv)), nullNeg.map((e) => cosine(e, nv))))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const p = (q: number) => nullAUCs[Math.min(nullAUCs.length - 1, Math.floor(q * nullAUCs.length))] ?? NaN;

      const real = statsFor(pool.embs, axisVec, negEmb, posEmb);
      const nullStats = nullVecs.map((nv) => statsFor(pool.embs, nv, negEmb, posEmb));

      cells.push({
        seed, axis: meta.name,
        judgeAUC,
        nullAUCp50: p(0.5), nullAUCp95: p(0.95),
        aucPercentile: nullAUCs.length ? percentile(judgeAUC, nullAUCs) : NaN,
        rated: posScores.length + negScores.length, pos: posScores.length, neg: negScores.length,
        coh: real.poleCoherence, cohPct: percentile(real.poleCoherence, nullStats.map((n) => n.poleCoherence)),
        margin: real.interPoleMargin,
        // lower margin = better separated, so invert to keep "high percentile = more axis-like"
        marginPct: 1 - percentile(real.interPoleMargin, nullStats.map((n) => n.interPoleMargin)),
        lean: real.poleLean, leanPct: percentile(real.poleLean, nullStats.map((n) => n.poleLean)),
      });

      const c = cells[cells.length - 1]!;
      console.log(
        `\n  ${meta.name}\n` +
        `    judgeAUC ${f(c.judgeAUC)}  (n=${c.rated}: ${c.pos}+/${c.neg}-)   ` +
        `null p50 ${f(c.nullAUCp50)}  p95 ${f(c.nullAUCp95)}  → pctile ${f(c.aucPercentile)}\n` +
        `    poleCoherence  ${f(c.coh)}  pctile ${f(c.cohPct)}\n` +
        `    interPoleMargin ${f(c.margin)}  pctile ${f(c.marginPct)} (inverted)\n` +
        `    poleLean       ${f(c.lean)}  pctile ${f(c.leanPct)}  [known circular]`,
      );
    }
  }

  // ── does any cheap proxy track ground truth? ──
  console.log(`\n${"═".repeat(78)}\nDOES A CHEAP PROXY TRACK judgeAUC?  (n=${cells.length} cells)`);
  const usable = cells.filter((c) => Number.isFinite(c.judgeAUC));
  function pearson(a: number[], b: number[]): number {
    const ma = avg(a), mb = avg(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
    return num / (Math.sqrt(da * db) || 1);
  }
  const truth = usable.map((c) => c.judgeAUC);
  for (const [name, vals] of [
    ["poleCoherence", usable.map((c) => c.coh)],
    ["interPoleMargin", usable.map((c) => c.margin)],
    ["poleLean (circular)", usable.map((c) => c.lean)],
  ] as [string, number[]][]) {
    console.log(`  r(${name}, judgeAUC) = ${f(pearson(vals, truth))}`);
  }

  console.log(`\n  cell summary (judgeAUC vs its own null chance line):`);
  console.log(`  ${"seed".padEnd(15)} ${"axis".padEnd(32)} judgeAUC  nullp95  beats?`);
  for (const c of cells) {
    const beats = Number.isFinite(c.judgeAUC) && c.judgeAUC > c.nullAUCp95;
    console.log(`  ${c.seed.padEnd(15)} ${c.axis.padEnd(32)}  ${f(c.judgeAUC)}   ${f(c.nullAUCp95)}   ${beats ? "YES" : "no"}`);
  }
  // ── ranking, which is the point of this run ───────────────────────────────
  console.log(`\n${"═".repeat(78)}\nAXIS RANKING — mean judgeAUC across ${SEEDS.length} seeds`);
  const byAxis = new Map<string, number[]>();
  for (const c of cells) {
    if (!Number.isFinite(c.judgeAUC)) continue;
    if (!byAxis.has(c.axis)) byAxis.set(c.axis, []);
    byAxis.get(c.axis)!.push(c.judgeAUC);
  }
  const surfaceMean = avg(byAxis.get("SURFACE playful -> more playful") ?? [NaN]);
  const ranked = [...byAxis.entries()]
    .map(([axis, v]) => ({ axis, mean: avg(v), n: v.length, spread: Math.max(...v) - Math.min(...v) }))
    .sort((a, b) => b.mean - a.mean);
  console.log(`\n  ${"axis".padEnd(34)} mean   spread  n   vs lexical ceiling`);
  for (const r of ranked) {
    const verdict = r.axis.startsWith("SURFACE") ? "— the ceiling itself"
      : r.mean > surfaceMean + 0.10 ? "RECOMMEND"
      : r.mean > surfaceMean ? "marginal"
      : "REJECT — at or below the ceiling";
    console.log(`  ${r.axis.padEnd(34)} ${f(r.mean)}  ${f(r.spread)}   ${r.n}   ${verdict}`);
  }
  console.log(`\n  lexical ceiling (X / more X) = ${f(surfaceMean)}. An axis must clear it by a`);
  console.log(`  clear margin to earn a pill; "marginal" means the evidence does not separate it.`);

  console.log(`\nrequests spent: ${requests}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
