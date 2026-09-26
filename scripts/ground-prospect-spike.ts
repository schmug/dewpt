// The prospect-only ground spike: does prospecting beside a cluster of pinned
// words condense words a reader can place next to THAT cluster, even when a
// neighbouring cluster sits on an adjacent sub-theme?
//
// Why it exists: the first ground spike (scripts/ground-spike.ts) came back
// INVALID on 2026-09-24 because its bridge judge answered by position
// (docs/measurements/2026-09-24-sky-and-ground-spike.md). The bridge was
// dropped as a way of generating words (spec Appendix B), leaving prospect as
// the candidate gesture. That run's attribution reading (13/18) is NOT this
// spike's evidence: its verdict came from a combined gate, and reusing its data
// for a split chosen afterwards would be post-hoc. So this is fresh data: three
// new seeds and new notes, with bars pre-registered in
// scripts/ground-prospect-judge.ts (PROSPECT_PASS) before any real run.
//
// The hard case: in every seed, groups 0 and 2 sit on neighbouring sub-themes
// that a reader could plausibly confuse; group 1 is the odd one out. On the
// ground the neighbours are the two OUTER clusters (800 units apart), so each
// prospect still plans "near" on its own cluster only. A prospect that does not
// makes the run INVALID. Attribution on the neighbouring groups, and misses
// into the sibling, are printed as a diagnostic, not a second bar.
//
// It drives the SHIPPED path: notes on a ground scene, planProspect
// (neighbourhood + Gaussian weights) → planScore → PoolCore.drawRanked,
// consuming, two bursts per cluster. The pool is seed-only at production band
// and dedupe parity (scripts/ground-harness.ts). The judge is blind forced
// choice, options shuffled per trial; a malformed answer is retried once and
// then counted as a miss.
//
//   npm run ground-prospect-spike -- --binding   # Access + OAuth; pause WARP
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run ground-prospect-spike
//   npm run ground-prospect-spike -- --fake      # offline plumbing check, meaningless numbers
//   options: --max-requests=70 (hard stop)

import { embedTexts } from "../src/generation";
import { nearScore, planProspect, planScore, topK, PROSPECT_COUNT, type AnchorWithEmbedding, type GroundScene } from "../src/ground-core";
import { PoolCore, cosineSim } from "../src/pool-core";
import { DEDUPE_COSINE, type Candidate } from "../src/types";
import { attributeMessages, binomTail, mulberry32, shuffle } from "./ground-judge";
import { BANDS, CENTRES, OFFSETS, PER_BAND, buildPool, makeJudge, requestCap, spikeRunner } from "./ground-harness";
import { PROSPECT_PASS, jaccardSplit, neighbourSummary, positionMaxTail, prospectVerdict } from "./ground-prospect-judge";
import { CF_EMBED_MODEL, CF_GEN_MODEL, numberFlag, parseArgs } from "./runner-lib";

/** Hand-written and committed so the spike is arguable. Groups 0 and 2 are the
 *  neighbouring pair in every seed; group 1 is the odd one out. None of these
 *  seeds or notes appear in the 2026-09-24 run. */
const NEIGHBOURS: [number, number] = [0, 2];
const GROUNDS: { seed: string; groups: string[][] }[] = [
  {
    seed: "gardening",
    groups: [
      ["turning the compost pile", "worm castings", "coffee grounds in the soil"], // soil and compost
      ["swapping cuttings with neighbours", "community garden waitlist", "leaving zucchini on doorsteps"],
      ["fish emulsion feed", "mulching with straw", "nitrogen from cover crops"], // feeding the plants
    ],
  },
  {
    seed: "running",
    groups: [
      ["interval sessions on the track", "tempo run tuesdays", "building weekly mileage"], // training
      ["running club after work", "the quiet of a 6am run", "a friend who waits at the corner"],
      ["race-day pacing strategy", "tapering before the marathon", "negative splits"], // racing
    ],
  },
  {
    seed: "learning a language",
    groups: [
      ["flashcards on the commute", "spaced repetition streak", "words that won't stick"], // vocabulary
      ["ordering coffee abroad", "a tandem partner on video", "freezing mid-sentence"],
      ["verb conjugation tables", "gendered nouns", "the subjunctive mood"], // grammar
    ],
  },
];

const WINDOWS = [0, PROSPECT_COUNT]; // ranks 1-5, then 6-10: does steering survive a second prospect?
const RNG_SEED = 0x9e05;

const { flags } = parseArgs(process.argv.slice(2));
const FAKE = flags.has("fake");
const MAX_REQUESTS = numberFlag(flags, "max-requests", 70);

let spent = () => 0; // read by the failure path too, so a crash still reports its cost

const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  —  ");

async function main(): Promise<void> {
  const runner = await spikeRunner(flags);
  const capped = requestCap(runner.ai, MAX_REQUESTS);
  spent = capped.spent;
  const ai = capped.ai;
  const rand = mulberry32(RNG_SEED);
  const judge = makeJudge(ai, FAKE, rand);

  const trialsPerSeed = 3 * WINDOWS.length;
  console.log(`ground prospect spike  model ${FAKE ? "FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)" : `${CF_GEN_MODEL} + ${CF_EMBED_MODEL} via ${runner.via}`}`);
  console.log(`bands ${BANDS.length}x${PER_BAND}  prospect k=${PROSPECT_COUNT}  windows ${WINDOWS.map((w) => `${w + 1}-${w + PROSPECT_COUNT}`).join(", ")}  neighbours = groups ${NEIGHBOURS.map((g) => g + 1).join(" & ")}  rng 0x${RNG_SEED.toString(16)}`);
  console.log(`expected requests: ${GROUNDS.length * BANDS.length} generation + ~${GROUNDS.length * 3} embedding + ${GROUNDS.length * trialsPerSeed} judge (up to ${GROUNDS.length * trialsPerSeed * 2} with retries); hard cap ${MAX_REQUESTS}`);

  const byPosition = [0, 0, 0];
  let correct = 0, judged = 0, notNear = 0, echoes = 0, echoN = 0;
  const perWindow = WINDOWS.map(() => ({ correct: 0, n: 0 }));
  const trials: { group: number; picked: number | null }[] = [];
  const barJ: number[] = [], neighbourJ: number[] = [];

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

    const anchors: AnchorWithEmbedding[] = notes.map((text) => ({ text, tier: 1, pinnedAt: 1, embedding: embOf.get(text)! }));
    const scene: GroundScene = {
      words: ground.groups.flatMap((group, g) =>
        group.map((text, k) => ({ text, tier: 1 as const, pinnedAt: 1, x: CENTRES[g]!.x + OFFSETS[k]!.x, y: CENTRES[g]!.y + OFFSETS[k]!.y }))),
      threads: [],
    };

    const top10: (number[] | null)[] = [];
    for (let g = 0; g < ground.groups.length; g++) {
      const group = ground.groups[g]!;
      const plan = planProspect(scene, anchors, CENTRES[g]!.x, CENTRES[g]!.y);
      if (plan.mode !== "near" || plan.basis.some((t) => !group.includes(t))) {
        notNear++;
        console.log(`  !! prospect at group ${g + 1} did not plan "near" on that group alone: ${plan.mode} ${plan.basis.join(", ")}`);
      }
      top10.push(plan.mode === "near" ? topK(pool.embs.map((_, i) => i), (i) => nearScore(plan.query)(pool.embs[i]!), 10) : null);
      for (let w = 0; w < WINDOWS.length; w++) {
        const served = core.drawRanked(planScore(plan, rand), PROSPECT_COUNT, w, new Set(notes.map((t) => t.toLowerCase())));
        const words = served.map((s) => s.text);
        for (const t of words) {
          echoN++;
          if (group.some((n) => cosineSim(pool.embs[idxOf.get(t)!]!, embOf.get(n)!) > DEDUPE_COSINE)) echoes++;
        }
        const order = shuffle([0, 1, 2], rand); // position -> group index
        const pick = await judge(attributeMessages(order.map((o) => ground.groups[o]!), words), "group", 3);
        const pickedGroup = pick === null ? null : order[pick]!;
        const ok = pickedGroup === g;
        if (pick !== null) { judged++; byPosition[pick]!++; }
        if (ok) { correct++; perWindow[w]!.correct++; }
        perWindow[w]!.n++;
        trials.push({ group: g, picked: pickedGroup });
        const tag = NEIGHBOURS.includes(g) ? " (neighbour)" : "";
        console.log(`  prospect at group ${g + 1}${tag} [${w === 0 ? "first" : "second"} burst]  judge=${pickedGroup === null ? "?" : `group ${pickedGroup + 1}`} ${ok ? "✓" : "✗"}  ${words.join(" · ")}`);
      }
    }
    const split = jaccardSplit(top10, NEIGHBOURS);
    barJ.push(split.bar);
    neighbourJ.push(split.neighbour);
    console.log(`  top-10 overlap (jaccard): non-neighbour pairs ${f3(split.bar)}   neighbour pair ${f3(split.neighbour)}`);
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const jaccard = mean(barJ);
  const v = prospectVerdict({ attribute: { correct, judged, byPosition }, jaccard });
  const nb = neighbourSummary(trials, NEIGHBOURS);
  const n = PROSPECT_PASS.attributeN;
  console.log(`\n${"═".repeat(78)}\nRESULT`);
  console.log(`  attribution   ${correct}/${n} correct  (judged ${judged})  chance 1/3  P(X>=k)=${binomTail(correct, n, 1 / 3).toFixed(4)}   pass >= ${PROSPECT_PASS.attributeMin}`);
  perWindow.forEach((w, i) => console.log(`    ${i === 0 ? "first" : "second"} burst: ${w.correct}/${w.n}`));
  console.log(`    judge answers by position: ${byPosition.join("/")}   (INVALID at >= ${PROSPECT_PASS.positionMax}; P=${positionMaxTail(PROSPECT_PASS.positionMax, n, 3).toFixed(4)} under a uniform judge)`);
  console.log(`  hubness       mean top-10 jaccard, non-neighbour pairs ${f3(jaccard)} (per seed ${barJ.map(f3).join(", ")})   pass <= ${PROSPECT_PASS.jaccardMax}`);
  console.log(`  neighbours    ${nb.correct}/${nb.n} correct at the neighbouring groups; ${nb.intoSibling} of ${nb.n - nb.correct} misses went to the sibling   [diagnostic]`);
  console.log(`                neighbour-pair top-10 jaccard ${f3(mean(neighbourJ))} (per seed ${neighbourJ.map(f3).join(", ")})   [diagnostic]`);
  console.log(`  echo          ${echoes}/${echoN} steered words are near-duplicates (cos > ${DEDUPE_COSINE}) of a note  [diagnostic]`);
  if (notNear) console.log(`  !! ${notNear} prospects did not plan "near" on their own cluster — the layout is wrong; treat the run as INVALID`);
  const outcome = notNear ? "INVALID" : v.outcome;
  console.log(`\nVERDICT: ${outcome}${v.reasons.length ? `  — ${v.reasons.join("; ")}` : ""}`);
  console.log(`requests spent: ${spent()}`);
  await runner.dispose?.();
}

main().catch((err) => {
  console.error(err);
  console.error(`requests spent before failure: ${spent()}`);
  process.exit(1);
});
