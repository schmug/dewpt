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
//   bridge       judge sees X, Y and four phrases — best by the shipped bridge
//                score, the pool's most CENTRAL word (the hub arm: min-cosine
//                favours central words, so a pass must beat a generic hub), best
//                by closeness to X alone, best by closeness to Y alone — and
//                picks the one that connects both. Chance 1/4.
//   validity     option order is shuffled per trial, so chance is analytic. A
//                judge that answers by position is not reading content; if one
//                position dominates, the run is INVALID rather than PASS/FAIL.
//
// It drives the SHIPPED path, not a re-implementation: notes are laid out on a
// ground scene, prospects go through planProspect (neighbourhood + Gaussian
// weights) and PoolCore.drawRanked (consuming, so the second window is what a
// second prospect would really get), bridges through planBridge/planScore.
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
import {
  nearScore, planBridge, planProspect, planScore, topK, PROSPECT_COUNT,
  type AnchorWithEmbedding, type GroundScene,
} from "../src/ground-core";
import { PoolCore, cosineSim } from "../src/pool-core";
import { ALT_ABSTRACTION, BUCKET_KEYS, DEDUPE_COSINE, TIER_STRANGENESS, type Alt, type BucketKey, type Candidate, type Tier } from "../src/types";
import {
  attributeMessages, binomTail, bridgeMessages, centrality, distinctPicks, meanJaccard, mulberry32, parsePick, PASS,
  shuffle, verdict, type SpikeTallies,
} from "./ground-judge";
import { cloudflareRunner, CF_EMBED_MODEL, CF_GEN_MODEL, numberFlag, parseArgs } from "./runner-lib";

const BANDS = BUCKET_KEYS.map((bucket) => ({
  bucket,
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

interface Pool { texts: string[]; embs: number[][]; buckets: BucketKey[] }

async function buildPool(ai: AiRunner, seed: string, exclude: string[]): Promise<Pool> {
  const seen = new Set(exclude.map((t) => t.trim().toLowerCase()));
  const texts: string[] = [];
  const buckets: BucketKey[] = [];
  for (const band of BANDS) {
    const out = await generateCandidates(ai, CF_GEN_MODEL, {
      seed, strangeness: band.strangeness, altitude: band.altitude, anchors: [], exclude: [], count: PER_BAND,
    });
    for (const t of out) {
      const key = t.trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); texts.push(t.trim()); buckets.push(band.bucket); }
    }
  }
  const raw = await embedTexts(ai, CF_EMBED_MODEL, texts);
  const kept: Pool = { texts: [], embs: [], buckets: [] };
  for (let i = 0; i < texts.length; i++) {
    if (kept.embs.some((e) => cosineSim(e, raw[i]!) > DEDUPE_COSINE)) continue;
    kept.texts.push(texts[i]!);
    kept.embs.push(raw[i]!);
    kept.buckets.push(buckets[i]!);
  }
  console.log(`  pool: ${texts.length} raw -> ${kept.texts.length} kept at cosine > ${DEDUPE_COSINE}`);
  return kept;
}

/** Lay the three groups out as clusters on a ground, far enough apart that a
 *  prospect at one cluster's centre reaches only that cluster (groups 400
 *  units apart; NEIGHBOR_RADIUS is 240; notes within ~70 of their centre). */
const CENTRES = [{ x: 200, y: 210 }, { x: 600, y: 210 }, { x: 1000, y: 210 }];
const OFFSETS = [{ x: -60, y: -30 }, { x: 40, y: 10 }, { x: -20, y: 50 }];

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

  const judgeCalls = GROUNDS.length * (3 * WINDOWS.length + 3 * BRIDGE_RANKS.length);
  console.log(`ground spike  model ${FAKE ? "FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)" : `${CF_GEN_MODEL} + ${CF_EMBED_MODEL}`}`);
  console.log(`bands ${BANDS.length}x${PER_BAND}  prospect k=${PROSPECT_COUNT}  windows ${WINDOWS.map((w) => `${w + 1}-${w + PROSPECT_COUNT}`).join(", ")}  rng 0x${RNG_SEED.toString(16)}`);
  console.log(`expected requests: ${GROUNDS.length * BANDS.length} generation + ~${GROUNDS.length * 3} embedding + ${judgeCalls} judge (up to ${judgeCalls * 2} with retries); hard cap ${MAX_REQUESTS}`);

  const tallies: SpikeTallies = {
    attribute: { correct: 0, judged: 0, byPosition: [0, 0, 0] },
    bridge: { chosen: 0, hub: 0, judged: 0, byPosition: [0, 0, 0, 0] },
    jaccard: NaN,
  };
  const perWindow = WINDOWS.map(() => ({ correct: 0, n: 0 }));
  const bridgeWhich = { bridge: 0, hub: 0, nearX: 0, nearY: 0, none: 0 };
  const jaccards: number[] = [];
  let echoes = 0, echoN = 0, notNear = 0;

  for (const ground of GROUNDS) {
    console.log(`\n${"═".repeat(78)}\nseed "${ground.seed}"`);
    const notes = ground.groups.flat();
    const pool = await buildPool(ai, ground.seed, notes);
    const embs = await embedTexts(ai, CF_EMBED_MODEL, [ground.seed, ...notes]);
    const seedEmb = embs[0]!;
    const embOf = new Map(notes.map((t, i) => [t, embs[i + 1]!]));

    // The session's pool, as the DO would hold it.
    const candidates: Candidate[] = pool.texts.map((text, i) => ({
      text, bucket: pool.buckets[i]!, embedding: pool.embs[i]!, seedDist: 1 - cosineSim(seedEmb, pool.embs[i]!), generatedAt: 0,
    }));
    const core = new PoolCore({ candidates, seedEmbedding: seedEmb });
    const idxOf = new Map(pool.texts.map((t, i) => [t, i]));
    const alive = new Set(pool.texts.map((_, i) => i));

    // The ground: three clusters of pinned notes.
    const anchors: AnchorWithEmbedding[] = notes.map((text) => ({ text, tier: 1, pinnedAt: 1, embedding: embOf.get(text)! }));
    const scene: GroundScene = {
      words: ground.groups.flatMap((group, g) =>
        group.map((text, k) => ({ text, tier: 1 as const, pinnedAt: 1, x: CENTRES[g]!.x + OFFSETS[k]!.x, y: CENTRES[g]!.y + OFFSETS[k]!.y }))),
      threads: [],
    };

    // ── attribution: prospect at each cluster's centre, twice ───────────────
    const top10: number[][] = [];
    for (let g = 0; g < ground.groups.length; g++) {
      const group = ground.groups[g]!;
      const plan = planProspect(scene, anchors, CENTRES[g]!.x, CENTRES[g]!.y);
      if (plan.mode !== "near" || plan.basis.some((t) => !group.includes(t))) {
        notNear++;
        console.log(`  !! prospect at group ${g + 1} did not plan "near" on that group alone: ${plan.mode} ${plan.basis.join(", ")}`);
      }
      if (plan.mode === "near") {
        top10.push(topK(pool.embs.map((_, i) => i), (i) => nearScore(plan.query)(pool.embs[i]!), 10));
      }
      for (let w = 0; w < WINDOWS.length; w++) {
        const served = core.drawRanked(planScore(plan, rand), PROSPECT_COUNT, w, new Set(notes.map((t) => t.toLowerCase())));
        const words = served.map((s) => s.text);
        for (const t of words) {
          alive.delete(idxOf.get(t)!);
          echoN++;
          if (group.some((n) => cosineSim(pool.embs[idxOf.get(t)!]!, embOf.get(n)!) > DEDUPE_COSINE)) echoes++;
        }
        const order = shuffle([0, 1, 2], rand); // position -> group index
        const pick = await ask(ai, attributeMessages(order.map((o) => ground.groups[o]!), words), "group", 3, rand);
        const correct = pick !== null && order[pick] === g;
        if (pick !== null) { tallies.attribute.judged++; tallies.attribute.byPosition[pick]!++; }
        if (correct) { tallies.attribute.correct++; perWindow[w]!.correct++; }
        perWindow[w]!.n++;
        console.log(`  prospect at group ${g + 1} [${w === 0 ? "first" : "second"} burst]  judge=${pick === null ? "?" : `group ${order[pick]! + 1}`} ${correct ? "✓" : "✗"}  ${words.join(" · ")}`);
      }
    }
    const jac = meanJaccard(top10);
    jaccards.push(jac);
    console.log(`  top-10 overlap between groups (mean jaccard): ${f3(jac)}`);

    // ── bridges, over what the prospects left in the pool ───────────────────
    const aliveIdx = [...alive];
    const central = centrality(aliveIdx.map((i) => pool.embs[i]!), cosineSim);
    const centralOf = new Map(aliveIdx.map((i, k) => [i, central[k]!]));
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    for (const [ga, gb] of pairs) {
      const x = ground.groups[ga]![0]!, y = ground.groups[gb]![0]!;
      const threaded: GroundScene = { words: scene.words, threads: [{ a: x, b: y }] };
      const plan = planBridge(threaded, anchors, x, y);
      if (!plan || plan.mode !== "bridge") { console.log(`  !! no bridge plan for "${x}" — "${y}"`); continue; }
      const score = planScore(plan, rand);
      const depth = 8;
      const lists = [
        topK(aliveIdx, (i) => score(candidates[i]!), depth),
        topK(aliveIdx, (i) => centralOf.get(i)!, depth),
        topK(aliveIdx, (i) => cosineSim(pool.embs[i]!, embOf.get(x)!), depth),
        topK(aliveIdx, (i) => cosineSim(pool.embs[i]!, embOf.get(y)!), depth),
      ].map((l) => l.map((k) => aliveIdx[k]!));
      for (const r of BRIDGE_RANKS) {
        const picks = distinctPicks(lists, r);
        if (!picks) { bridgeWhich.none++; console.log(`  thread "${x}" — "${y}" rank ${r + 1}: lists ran dry, scored as a miss`); continue; }
        const order = shuffle([0, 1, 2, 3], rand); // position -> arm (0 bridge, 1 hub, 2 nearX, 3 nearY)
        const options = order.map((o) => pool.texts[picks[o]!]!);
        const pick = await ask(ai, bridgeMessages(x, y, options), "choice", 4, rand);
        const label = ["bridge", "hub", "near X", "near Y"];
        if (pick !== null) {
          tallies.bridge.judged++;
          tallies.bridge.byPosition[pick]!++;
          const arm = order[pick]!;
          if (arm === 0) { tallies.bridge.chosen++; bridgeWhich.bridge++; }
          else if (arm === 1) { tallies.bridge.hub++; bridgeWhich.hub++; }
          else if (arm === 2) bridgeWhich.nearX++;
          else bridgeWhich.nearY++;
        } else bridgeWhich.none++;
        console.log(`  thread "${x}" — "${y}" rank ${r + 1}: judge=${pick === null ? "?" : label[order[pick]!]}  [bridge: ${pool.texts[picks[0]!]} | hub: ${pool.texts[picks[1]!]} | nearX: ${pool.texts[picks[2]!]} | nearY: ${pool.texts[picks[3]!]}]`);
      }
    }
  }

  tallies.jaccard = jaccards.reduce((a, b) => a + b, 0) / jaccards.length;
  const v = verdict(tallies);
  console.log(`\n${"═".repeat(78)}\nRESULT`);
  console.log(`  attribution   ${tallies.attribute.correct}/${PASS.attributeN} correct  (judged ${tallies.attribute.judged})  chance 1/3  P(X>=k)=${binomTail(tallies.attribute.correct, PASS.attributeN, 1 / 3).toFixed(4)}   pass >= ${PASS.attributeMin}`);
  perWindow.forEach((w, i) => console.log(`    ${i === 0 ? "first" : "second"} burst: ${w.correct}/${w.n}`));
  console.log(`    judge answers by position: ${tallies.attribute.byPosition.join("/")}   (INVALID at >= ${PASS.positionMaxAttribute})`);
  console.log(`  bridge        ${tallies.bridge.chosen}/${PASS.bridgeN} chose the bridge  (judged ${tallies.bridge.judged})  chance 1/4  P(X>=k)=${binomTail(tallies.bridge.chosen, PASS.bridgeN, 1 / 4).toFixed(4)}   pass >= ${PASS.bridgeMin} and > hub`);
  console.log(`    judge chose: bridge ${bridgeWhich.bridge} · hub ${bridgeWhich.hub} · near X ${bridgeWhich.nearX} · near Y ${bridgeWhich.nearY} · unjudged ${bridgeWhich.none}`);
  console.log(`    judge answers by position: ${tallies.bridge.byPosition.join("/")}   (INVALID at >= ${PASS.positionMaxBridge})`);
  console.log(`  hubness       mean top-10 jaccard ${f3(tallies.jaccard)} (per seed ${jaccards.map(f3).join(", ")})   pass <= ${PASS.jaccardMax}`);
  console.log(`  echo          ${echoes}/${echoN} steered words are near-duplicates (cos > ${DEDUPE_COSINE}) of a note  [diagnostic]`);
  if (notNear) console.log(`  !! ${notNear} prospects did not plan "near" on their own cluster — the layout is wrong; treat the run as INVALID`);
  const outcome = notNear ? "INVALID" : v.outcome;
  console.log(`\nVERDICT: ${outcome}${v.reasons.length ? `  — ${v.reasons.join("; ")}` : ""}`);
  console.log(`requests spent: ${requests}`);
}

main().catch((err) => {
  console.error(err);
  console.error(`requests spent before failure: ${requests}`);
  process.exit(1);
});
