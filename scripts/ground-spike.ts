// The ground spike: can a person FEEL where they are on the ground?
//
// The ground design (docs/superpowers/specs/2026-09-24-sky-and-ground-design.md)
// rests on one assumption: re-ranking the pool the SessionDO already holds, by
// the geometry of pinned words on the ground, steers what condenses in a way a
// reader can recognise — without any inline AI call. Two gestures carry it:
//
//   prospect beside a cluster  -> top-k of the pool by cosine to the cluster's
//                                 query vector (src/ground-core.ts nearScore)
//   a thread between two words -> top-k by min(cos(c,A), cos(c,B)) (bridgeScore)
//
// If a seed-conditioned pool is too homogeneous (every cluster pulls the same
// words — hubness), or the bridge collapses onto one end, the ground is
// decoration and the design goes back to the drawing board.
//
// The instrument is a BLIND LLM JUDGE doing forced choice, because every cheap
// embedding statistic this repo has tried to grade a direction with came back
// null (docs/measurements/2026-08-22-workstream-b-null-result.md). The
// embedding numbers below (jaccard, echo) are diagnostics; the judge decides.
//
//   attribution  judge sees the three note groups + 5 condensed words and names
//                the group they appeared beside. Chance 1/3.
//   bridge       judge sees X, Y and three phrases — best by bridgeScore, best
//                by closeness to X alone, best by closeness to Y alone — and
//                picks the one that connects both. Chance 1/3.
//   control      5 RANDOM pool words with a randomly assigned "true" group.
//                Should land near 1/3; if it does not, the judge is reading
//                something other than the steering.
//
// The pool is generated WITHOUT anchors — seed only — at production band and
// dedupe parity. In the app, pinned words also condition generation, which can
// only help; this measures the harder case where re-ranking does all the work.
//
// Pass/fail thresholds are pre-registered in scripts/ground-judge.ts (PASS).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run ground-spike
//   npm run ground-spike -- --fake          # offline plumbing check, meaningless numbers
//   options: --max-requests=120 (hard stop)

import { embedTexts, generateCandidates, type AiRunner } from "../src/generation";
import { fakeAiRunner } from "../src/dev-fake-ai";
import { bridgeScore, nearScore, queryVector, topK, PROSPECT_COUNT } from "../src/ground-core";
import { cosineSim } from "../src/pool-core";
import { ALT_ABSTRACTION, BUCKET_KEYS, DEDUPE_COSINE, TIER_STRANGENESS, type Alt, type Tier } from "../src/types";
import {
  attributeMessages, binomTail, bridgeMessages, distinctPicks, meanJaccard, mulberry32, parsePick, PASS, shuffle,
  verdict,
} from "./ground-judge";
import { cloudflareRunner, CF_EMBED_MODEL, CF_GEN_MODEL, numberFlag, parseArgs } from "./runner-lib";

const BANDS = BUCKET_KEYS.map((bucket) => ({
  strangeness: TIER_STRANGENESS[Number(bucket[1]) as Tier],
  altitude: ALT_ABSTRACTION[Number(bucket[3]) as Alt],
}));
const PER_BAND = 24;

/** What a person might have on their ground: three groups of their own notes
 *  per seed, each a distinct sub-theme. Hand-written and committed so the
 *  spike is arguable — and a known bias: real clusters may be subtler than
 *  these. Group 0's first note in each pair is a thread endpoint. */
const GROUNDS: { seed: string; groups: string[][] }[] = [
  {
    seed: "public transit",
    groups: [
      ["last train home", "night bus regulars", "empty platform at 2am"],
      ["fare capping", "step-free access at every station", "free transit for students"],
      ["subway map typography", "station mosaics", "color-coded lines"],
    ],
  },
  {
    seed: "home cooking",
    groups: [
      ["grandmother's recipe cards", "sunday dinners", "garlic sizzling in oil"],
      ["meal prep containers", "cooking on a tight budget", "freezer dumplings"],
      ["knife skills", "seasoning cast iron", "controlling the heat"],
    ],
  },
  {
    seed: "friendship",
    groups: [
      ["long-distance calls", "friends in other time zones", "letters that take weeks"],
      ["standing weekly dinner", "inside jokes", "birthday traditions"],
      ["apologizing first", "the fight we never talk about", "forgiving an old friend"],
    ],
  },
];

const WINDOWS = [0, PROSPECT_COUNT]; // ranks 1-5, then 6-10: does steering survive a second prospect?
const BRIDGE_RANKS = [0, 1];
const RNG_SEED = 0x6d0d;

// ── accounting ──────────────────────────────────────────────────────────────

const { flags } = parseArgs(process.argv.slice(2));
const FAKE = flags.has("fake");
const MAX_REQUESTS = numberFlag(flags, "max-requests", 120);
let requests = 0;

function capped(ai: AiRunner): AiRunner {
  return {
    run(model, inputs) {
      if (requests >= MAX_REQUESTS) throw new Error(`request cap ${MAX_REQUESTS} reached — stopping, not overspending`);
      requests++;
      return ai.run(model, inputs);
    },
  };
}

function extract(result: unknown): unknown {
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r?.response === "string") return r.response;
  return r?.choices?.[0]?.message?.content;
}

// ── pool at production parity ───────────────────────────────────────────────

interface Pool { texts: string[]; embs: number[][] }

async function buildPool(ai: AiRunner, seed: string, exclude: string[]): Promise<Pool> {
  const seen = new Set(exclude.map((t) => t.trim().toLowerCase()));
  const texts: string[] = [];
  for (const band of BANDS) {
    const out = await generateCandidates(ai, CF_GEN_MODEL, {
      seed, strangeness: band.strangeness, altitude: band.altitude, anchors: [], exclude: [], count: PER_BAND,
    });
    for (const t of out) {
      const key = t.trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); texts.push(t.trim()); }
    }
  }
  const raw = await embedTexts(ai, CF_EMBED_MODEL, texts);
  const kept: Pool = { texts: [], embs: [] };
  for (let i = 0; i < texts.length; i++) {
    if (kept.embs.some((e) => cosineSim(e, raw[i]!) > DEDUPE_COSINE)) continue;
    kept.texts.push(texts[i]!);
    kept.embs.push(raw[i]!);
  }
  console.log(`  pool: ${texts.length} raw -> ${kept.texts.length} kept at cosine > ${DEDUPE_COSINE}`);
  return kept;
}

// ── the judge ───────────────────────────────────────────────────────────────

async function ask(ai: AiRunner, messages: ReturnType<typeof attributeMessages>, key: "group" | "choice", n: number, rand: () => number): Promise<number | null> {
  if (FAKE) return Math.floor(rand() * n); // plumbing only: a coin, not a judge
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.run(CF_GEN_MODEL, { messages, temperature: 0.1, max_tokens: 32 });
      const pick = parsePick(extract(res), key, n);
      if (pick !== null) return pick;
    } catch (err) {
      if (String(err).includes("request cap")) throw err;
    }
  }
  return null;
}

const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  —  ");

async function main(): Promise<void> {
  let base: AiRunner;
  if (FAKE) {
    base = fakeAiRunner();
  } else {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) {
      console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI - Read), or pass --fake for a plumbing check");
      process.exit(1);
    }
    base = cloudflareRunner(accountId, token);
  }
  const ai = capped(base);
  const rand = mulberry32(RNG_SEED);

  const judgeCalls = GROUNDS.length * (3 * WINDOWS.length + 3 * BRIDGE_RANKS.length + 3);
  console.log(`ground spike  model ${FAKE ? "FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)" : `${CF_GEN_MODEL} + ${CF_EMBED_MODEL}`}`);
  console.log(`bands ${BANDS.length}x${PER_BAND}  prospect k=${PROSPECT_COUNT}  windows ${WINDOWS.map((w) => `${w + 1}-${w + PROSPECT_COUNT}`).join(", ")}  rng 0x${RNG_SEED.toString(16)}`);
  console.log(`expected requests: ${GROUNDS.length * BANDS.length} generation + ~${GROUNDS.length * 3} embedding + ${judgeCalls} judge (up to ${judgeCalls * 2} with retries); hard cap ${MAX_REQUESTS}`);

  const tallies = { attribute: { correct: 0, judged: 0 }, bridge: { chosen: 0, judged: 0 }, jaccard: NaN };
  const control = { correct: 0, judged: 0, n: 0 };
  const perWindow = WINDOWS.map(() => ({ correct: 0, n: 0 }));
  const bridgePos = [0, 0, 0];
  const bridgeWhich = { bridge: 0, nearX: 0, nearY: 0, none: 0 };
  const jaccards: number[] = [];
  let echoes = 0, echoN = 0;

  for (const ground of GROUNDS) {
    console.log(`\n${"═".repeat(78)}\nseed "${ground.seed}"`);
    const notes = ground.groups.flat();
    const pool = await buildPool(ai, ground.seed, notes);
    const noteEmbs = await embedTexts(ai, CF_EMBED_MODEL, notes);
    const embOf = new Map(notes.map((t, i) => [t, noteEmbs[i]!]));
    const idx = pool.embs.map((_, i) => i);

    // ── attribution ─────────────────────────────────────────────────────────
    const top10: number[][] = [];
    for (let g = 0; g < ground.groups.length; g++) {
      const group = ground.groups[g]!;
      const q = queryVector(group.map((t) => ({ embedding: embOf.get(t)!, weight: 1 })))!;
      const ranked = topK(idx, (i) => nearScore(q)(pool.embs[i]!), 10);
      top10.push(ranked);
      for (const i of ranked.slice(0, PROSPECT_COUNT)) {
        echoN++;
        if (group.some((t) => cosineSim(pool.embs[i]!, embOf.get(t)!) > DEDUPE_COSINE)) echoes++;
      }
      for (let w = 0; w < WINDOWS.length; w++) {
        const words = ranked.slice(WINDOWS[w]!, WINDOWS[w]! + PROSPECT_COUNT).map((i) => pool.texts[i]!);
        const order = shuffle([0, 1, 2], rand); // position -> group index
        const pick = await ask(ai, attributeMessages(order.map((o) => ground.groups[o]!), words), "group", 3, rand);
        const correct = pick !== null && order[pick] === g;
        if (pick !== null) tallies.attribute.judged++;
        if (correct) { tallies.attribute.correct++; perWindow[w]!.correct++; }
        perWindow[w]!.n++;
        console.log(`  near group ${g + 1} [${WINDOWS[w]! + 1}-${WINDOWS[w]! + PROSPECT_COUNT}]  judge=${pick === null ? "?" : `group ${order[pick]! + 1}`} ${correct ? "✓" : "✗"}  ${words.join(" · ")}`);
      }
    }
    const jac = meanJaccard(top10);
    jaccards.push(jac);
    console.log(`  top-10 overlap between groups (mean jaccard): ${f3(jac)}`);

    // ── control: random words, random "true" group ──────────────────────────
    for (let c = 0; c < 3; c++) {
      const words = shuffle(idx, rand).slice(0, PROSPECT_COUNT).map((i) => pool.texts[i]!);
      const truth = Math.floor(rand() * 3);
      const order = shuffle([0, 1, 2], rand);
      const pick = await ask(ai, attributeMessages(order.map((o) => ground.groups[o]!), words), "group", 3, rand);
      control.n++;
      if (pick !== null) control.judged++;
      if (pick !== null && order[pick] === truth) control.correct++;
      console.log(`  control ${c + 1}  truth=group ${truth + 1}  judge=${pick === null ? "?" : `group ${order[pick]! + 1}`}  ${words.join(" · ")}`);
    }

    // ── bridges ─────────────────────────────────────────────────────────────
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    for (const [ga, gb] of pairs) {
      const x = ground.groups[ga]![0]!, y = ground.groups[gb]![0]!;
      const ex = embOf.get(x)!, ey = embOf.get(y)!;
      const depth = 6;
      const lists = [
        topK(idx, (i) => bridgeScore(ex, ey)(pool.embs[i]!), depth),
        topK(idx, (i) => cosineSim(pool.embs[i]!, ex), depth),
        topK(idx, (i) => cosineSim(pool.embs[i]!, ey), depth),
      ];
      for (const r of BRIDGE_RANKS) {
        const picks = distinctPicks(lists, r);
        if (!picks) { console.log(`  thread "${x}" — "${y}" rank ${r + 1}: lists ran dry, trial scored as a miss`); continue; }
        const order = shuffle([0, 1, 2], rand); // position -> which list (0 bridge, 1 nearX, 2 nearY)
        const options = order.map((o) => pool.texts[picks[o]!]!);
        const pick = await ask(ai, bridgeMessages(x, y, options), "choice", 3, rand);
        if (pick !== null) {
          tallies.bridge.judged++;
          bridgePos[pick]!++;
          const which = order[pick]!;
          if (which === 0) { tallies.bridge.chosen++; bridgeWhich.bridge++; }
          else if (which === 1) bridgeWhich.nearX++;
          else bridgeWhich.nearY++;
        } else bridgeWhich.none++;
        const label = ["bridge", "near X", "near Y"];
        console.log(`  thread "${x}" — "${y}" rank ${r + 1}: judge=${pick === null ? "?" : label[order[pick]!]}  [bridge: ${pool.texts[picks[0]!]} | nearX: ${pool.texts[picks[1]!]} | nearY: ${pool.texts[picks[2]!]}]`);
      }
    }
  }

  tallies.jaccard = jaccards.reduce((a, b) => a + b, 0) / jaccards.length;
  const v = verdict(tallies);
  console.log(`\n${"═".repeat(78)}\nRESULT`);
  console.log(`  attribution   ${tallies.attribute.correct}/${PASS.attributeN} correct  (judged ${tallies.attribute.judged})  chance 1/3  P(X>=k)=${binomTail(tallies.attribute.correct, PASS.attributeN, 1 / 3).toFixed(4)}   pass >= ${PASS.attributeMin}`);
  perWindow.forEach((w, i) => console.log(`    ranks ${WINDOWS[i]! + 1}-${WINDOWS[i]! + PROSPECT_COUNT}: ${w.correct}/${w.n}`));
  console.log(`  control       ${control.correct}/${control.n} "correct" on random words (judged ${control.judged})  — expect ~${(control.n / 3).toFixed(1)}`);
  console.log(`  bridge        ${tallies.bridge.chosen}/${PASS.bridgeN} chose the bridge  (judged ${tallies.bridge.judged})  chance 1/3  P(X>=k)=${binomTail(tallies.bridge.chosen, PASS.bridgeN, 1 / 3).toFixed(4)}   pass >= ${PASS.bridgeMin}`);
  console.log(`    judge chose: bridge ${bridgeWhich.bridge} · near X ${bridgeWhich.nearX} · near Y ${bridgeWhich.nearY} · unjudged ${bridgeWhich.none}   by position ${bridgePos.join("/")}`);
  console.log(`  hubness       mean top-10 jaccard ${f3(tallies.jaccard)} (per seed ${jaccards.map(f3).join(", ")})   pass <= ${PASS.jaccardMax}`);
  console.log(`  echo          ${echoes}/${echoN} steered words are near-duplicates (cos > ${DEDUPE_COSINE}) of a note`);
  console.log(`\nVERDICT: ${v.pass ? "PASS" : "FAIL"}${v.reasons.length ? `  — ${v.reasons.join("; ")}` : ""}`);
  console.log(`requests spent: ${requests}`);
}

main().catch((err) => {
  console.error(err);
  console.error(`requests spent before failure: ${requests}`);
  process.exit(1);
});
