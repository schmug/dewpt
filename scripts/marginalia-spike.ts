// The Marginalia pool-reuse spike (spec §2.E): in Marginalia the paragraph
// under your cursor seeds the margin. For the margin never to wait, the words
// for the NEXT paragraph must come from the pool already built, re-ranked. Does
// a reader place those words beside the paragraph the writer has moved to, or
// beside the one the pool was built for?
//
// Plan: .claude/plans/marginalia-pool-reuse.md. Bars pre-registered in
// scripts/marginalia-judge.ts (MARGINALIA_PASS) before any real run.
//
// Per essay:
//   pool   seedFrom(paragraph 1), 200 chars max (production parity), through
//          the shipped generation at band and dedupe parity (ground-harness).
//   move   the writer moves to paragraph 2, then 3, then 4. Each move draws 5
//          words with PoolCore.drawRanked by nearScore toward that paragraph's
//          bge-m3 embedding, consuming, as the app would. No new generation.
//   judge  the judge sees paragraphs k-1, k and k+1 (unlabelled, never in reading
//          order twice) plus the 5 words, and names the paragraph they belong
//          beside. The trial is asked in all 3 cyclic ROTATIONS, and it is
//          correct if paragraph k wins a majority. A judge that answers by
//          position scores 0.
//
// Essays are hand-written for this spike and committed. The bias: written
// knowing the test. None of their topics appeared in the ground spikes.
//
//   npm run marginalia-spike -- --binding     # Access + OAuth; pause WARP
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run marginalia-spike
//   npm run marginalia-spike -- --fake        # offline plumbing check, meaningless numbers
//   options: --max-requests=140 (hard stop; lower it to what the budget has left)

import { embedTexts } from "../src/generation";
import { nearScore, topK } from "../src/ground-core";
import { PoolCore, cosineSim } from "../src/pool-core";
import type { Candidate } from "../src/types";
import { binomTail, meanJaccard, mulberry32 } from "./ground-judge";
import { BANDS, PER_BAND, buildPool, makeJudge, requestCap, retryTransient, spikeRunner } from "./ground-harness";
import { positionMaxTail } from "./ground-prospect-judge";
import { MARGINALIA_PASS, ROTATIONS, majorityChance, marginaliaVerdict, paragraphMessages, seedFrom, trialCorrect } from "./marginalia-judge";
import { CF_EMBED_MODEL, CF_GEN_MODEL, numberFlag, parseArgs } from "./runner-lib";

/** Five paragraphs each. Adjacent paragraphs drift the way a draft does: same
 *  essay, a new sub-theme. Moves are judged into paragraphs 2, 3 and 4; 1 and 5
 *  exist so every target has a paragraph on each side. */
const ESSAYS: { title: string; paragraphs: string[] }[] = [
  {
    title: "restoring an old bicycle",
    paragraphs: [
      "The bicycle was in my grandfather's shed, under a tarp that had turned to dust. A steel frame, rust blooming through green paint, both tyres flat and cracked. I decided that afternoon to bring it back, mostly because nobody else would.",
      "Taking it apart took a month. Every bolt had seized. I soaked them in penetrating oil overnight, sorted the small parts into a muffin tin, and photographed each step so I could put it back together. The chrome came up under steel wool, pitted but bright.",
      "The wheels defeated me, so I took them to the community bike workshop on Thursdays. A retired mechanic showed me how to true a rim, a quarter turn of a spoke at a time, listening to the tension like a string on an instrument. Patience was most of the lesson.",
      "The first ride was at dusk, through the old part of the city. The gears clicked in a way no new bike does. I rode past the bus stop I used to wait at every morning and understood that my commute had just changed for good.",
      "Last spring I gave the bicycle to my niece. She painted it yellow, which my grandfather would have hated and then quietly admired. Some objects are only ever on loan, and the work you put into them is the part that stays with you.",
    ],
  },
  {
    title: "keeping bees",
    paragraphs: [
      "My first hive arrived in a cardboard box that hummed. Five frames of bees, a queen I could not find, and a neighbour watching over the fence with open alarm. I set it at the back of the garden, facing the morning sun, and waited to be stung.",
      "Inspections became a weekly ritual. A few puffs of smoke at the entrance, the lid eased off, each frame lifted slowly into the light. I learned to read the brood pattern, to spot the long body of the queen, to tell capped honey from capped larvae.",
      "In June the colony swarmed. Half the bees poured out and hung from the plum tree in a dripping cluster the size of a football. I shook them into a box at dusk. Scouts had been out all day voting on a new home, and I had simply offered one first.",
      "The harvest was sticky and slow. I sliced the wax cappings off with a warm knife and spun the frames in a borrowed extractor. The honey tasted of lime blossom and something darker, the whole summer's flowers in one jar on the kitchen table.",
      "Now it is winter and the hive is silent. The bees cluster around the queen and shiver to keep her warm. I worry about mites, about damp, about the long cold, and there is nothing to do but put my ear to the wood and listen.",
    ],
  },
  {
    title: "moving to a new city",
    paragraphs: [
      "I arrived with two suitcases and a key to an apartment that smelled of fresh paint. The walls were bare, the fridge was empty, and I did not know a single person within four hundred kilometres. That first night I sat on the floor and ate crackers.",
      "I learned the neighbourhood with my feet. The corner shop that stayed open late, the baker who remembered my order by the third week, the shortcut through the park that saved ten minutes and cost me a wet shoe every time it rained.",
      "The loneliness arrived on Sundays. Weekdays had work to fill them, but Sunday was long and silent. I ate lunch alone at the window counter of a café and listened to other people's conversations as though they were radio plays.",
      "Work was its own new country. New names, a coffee machine with rules nobody explained, meetings where everyone already knew what had been decided. For months I felt like a guest who had been handed the wrong seating card.",
      "A year later I hosted a dinner. Eight chairs, three of them borrowed, and a table full of people I had met here. When the last guest left I washed the plates slowly, and the apartment no longer smelled of paint.",
    ],
  },
  {
    title: "working the night shift",
    paragraphs: [
      "My first night shift on the ward began at nine. By three in the morning the corridors were hushed and the fluorescent lights hummed louder than anything else. Nobody tells you how large a hospital feels when it is asleep.",
      "Patients do not sleep the way healthy people do. At night the fear comes up. A man told me about a brother he had not spoken to in thirty years. A woman asked me to hold her hand until the pain medication took hold, and I did.",
      "My body never agreed to the schedule. I slept in daylight behind blackout curtains with earplugs in, ate breakfast at six in the evening, and timed my coffee like a medication. On days off I was a stranger to my own clock.",
      "At dawn came the handover. I walked the day staff from bed to bed and passed on each patient's night, the numbers on the chart and the things that never make it onto the chart. Then I signed my notes and stepped out into the morning.",
      "Life outside went on without me. I missed birthdays and weddings, and my friends learned to text rather than call. But I also knew the city at noon on a Tuesday, the empty streets and the quiet cafés, a strange freedom I had not expected.",
    ],
  },
  {
    title: "learning to swim as an adult",
    paragraphs: [
      "I was afraid of water for thirty-four years. A wave had knocked me over as a child and I had kept my distance ever since. The adult beginners' class met on Wednesday nights, and I signed up before I could change my mind.",
      "The first lessons were about breathing. Blow bubbles, the instructor said, as if I were five. Breathe out under the water, turn your head, breathe in. Then floating, with her hand under my back until I felt it leave and I did not sink.",
      "Then came technique. Kick from the hips, not the knees. Reach long, rotate the body, keep the head still. I counted strokes per length and my goggles fogged every time. The pool clock became the most honest thing in my week.",
      "In August I swam in the lake. No lane ropes, no wall to grab, cold dark water under me and weeds brushing my feet. Halfway out the panic rose, and I rolled onto my back and breathed until it passed. Then I swam on.",
      "Learning to swim changed more than my weekends. It taught me that fear can be taught its limits, a length at a time. I trust my body in a new way, and the water, which used to be a wall, is now the quietest place I know.",
    ],
  },
];

const MOVES = [1, 2, 3]; // 0-based target paragraphs: the writer moves to paragraphs 2, 3, 4
const K = 5;
const RNG_SEED = 0x3a41; // only the fake judge uses it

const { flags } = parseArgs(process.argv.slice(2));
const FAKE = flags.has("fake");
const MAX_REQUESTS = numberFlag(flags, "max-requests", 140);
let spent = () => 0; // read by the failure path too, so a crash still reports its cost

const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "  —  ");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const LABEL = ["prev", "HERE", "next"]; // option index -> what it is, for the log only

async function main(): Promise<void> {
  const runner = await spikeRunner(flags);
  const capped = requestCap(runner.ai, MAX_REQUESTS);
  spent = capped.spent;
  const ai = retryTransient(capped.ai); // outside the cap: every retry is counted
  const judge = makeJudge(ai, FAKE, mulberry32(RNG_SEED));

  const trials = ESSAYS.length * MOVES.length;
  const calls = trials * ROTATIONS.length;
  console.log(`marginalia pool-reuse spike  model ${FAKE ? "FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)" : `${CF_GEN_MODEL} + ${CF_EMBED_MODEL} via ${runner.via}`}`);
  console.log(`bands ${BANDS.length}x${PER_BAND}  k=${K} per move  ${ESSAYS.length} essays x ${MOVES.length} moves = ${trials} trials x ${ROTATIONS.length} rotations = ${calls} judge calls`);
  console.log(`expected requests: ${ESSAYS.length * BANDS.length} generation + ~${ESSAYS.length * 3} embedding + ${calls} judge (up to ${calls * 2} with retries); hard cap ${MAX_REQUESTS}`);

  const byPosition = [0, 0, 0];
  let correct = 0, behind = 0, ahead = 0, split = 0, unjudged = 0;
  const perMove = MOVES.map(() => ({ correct: 0, n: 0 }));
  const jaccards: number[] = [], cosGap: number[] = [], depthLeft: number[] = [];

  for (const essay of ESSAYS) {
    const seed = seedFrom(essay.paragraphs[0]!);
    console.log(`\n${"═".repeat(78)}\nessay "${essay.title}"  seed (${seed.length} chars): ${seed}`);
    const pool = await buildPool(ai, seed, []);
    const embs = await embedTexts(ai, CF_EMBED_MODEL, [seed, ...essay.paragraphs]);
    const seedEmb = embs[0]!;
    const paraEmb = essay.paragraphs.map((_, i) => embs[i + 1]!);

    const candidates: Candidate[] = pool.texts.map((text, i) => ({
      text, bucket: pool.buckets[i]!, embedding: pool.embs[i]!, seedDist: 1 - cosineSim(seedEmb, pool.embs[i]!), generatedAt: 0,
    }));
    const core = new PoolCore({ candidates, seedEmbedding: seedEmb });
    const idxOf = new Map(pool.texts.map((t, i) => [t, i]));

    // Diagnostic: do the three targets pull the same words from the untouched pool?
    jaccards.push(meanJaccard(MOVES.map((k) => topK(pool.embs, nearScore(paraEmb[k]!), 10))));

    for (let m = 0; m < MOVES.length; m++) {
      const k = MOVES[m]!;
      const score = nearScore(paraEmb[k]!);
      const served = core.drawRanked((c) => score(c.embedding), K, m);
      const words = served.map((s) => s.text);
      for (const t of words) {
        const e = pool.embs[idxOf.get(t)!]!;
        cosGap.push(cosineSim(e, paraEmb[k]!) - cosineSim(e, paraEmb[k - 1]!));
      }
      const options = [essay.paragraphs[k - 1]!, essay.paragraphs[k]!, essay.paragraphs[k + 1]!]; // target = option 1
      const votes: (number | null)[] = [];
      for (const order of ROTATIONS) {
        const pick = await judge(paragraphMessages(order.map((o) => options[o]!), words), "choice", 3);
        if (pick === null) { unjudged++; votes.push(null); continue; }
        byPosition[pick]!++;
        votes.push(order[pick]!);
      }
      const ok = trialCorrect(votes, 1);
      if (ok) { correct++; perMove[m]!.correct++; }
      else if (trialCorrect(votes, 0)) behind++;
      else if (trialCorrect(votes, 2)) ahead++;
      else split++;
      perMove[m]!.n++;
      const v = votes.map((x) => (x === null ? "?" : LABEL[x])).join("/");
      console.log(`  -> paragraph ${k + 1}  votes ${v.padEnd(14)} ${ok ? "✓" : "✗"}  ${words.join(" · ")}`);
    }
    const left = Object.values(core.depths()).reduce((a, d) => a + d.total, 0);
    depthLeft.push(left);
    console.log(`  top-10 overlap across targets (jaccard) ${f3(jaccards.at(-1)!)}   pool left after paragraph 4: ${left}/${pool.texts.length}`);
  }

  const v = marginaliaVerdict({ correct, byPosition });
  const n = MARGINALIA_PASS.trials;
  const p0 = majorityChance(3, ROTATIONS.length);
  console.log(`\n${"═".repeat(78)}\nRESULT`);
  console.log(`  follows the writer   ${correct}/${n} trials correct (majority of ${ROTATIONS.length} rotations)  chance ${f3(p0)}  P(X>=k)=${binomTail(correct, n, p0).toFixed(4)}   pass >= ${MARGINALIA_PASS.correctMin}`);
  perMove.forEach((w, i) => console.log(`    into paragraph ${MOVES[i]! + 1}: ${w.correct}/${w.n}`));
  console.log(`    misses: ${behind} stuck on the previous paragraph · ${ahead} placed on the next · ${split} no majority   [diagnostic]`);
  console.log(`    judge answers by position: ${byPosition.join("/")} of ${calls} calls, ${unjudged} unjudged   (INVALID at >= ${MARGINALIA_PASS.positionMax}; P=${positionMaxTail(MARGINALIA_PASS.positionMax, calls, 3).toFixed(4)} under a uniform judge)`);
  console.log(`  overlap       mean top-10 jaccard across a draft's targets ${f3(mean(jaccards))} (per essay ${jaccards.map(f3).join(", ")})   [diagnostic]`);
  console.log(`  cosine gap    served words: mean cos(target) - cos(previous) ${f3(mean(cosGap))}   [diagnostic]`);
  console.log(`  pool depth    left after paragraph 4: ${depthLeft.join(", ")}   [diagnostic]`);
  console.log(`\nVERDICT: ${v.outcome}${v.reasons.length ? `  — ${v.reasons.join("; ")}` : ""}`);
  console.log(`requests spent: ${spent()}`);
  await runner.dispose?.();
}

main().catch((err) => {
  console.error(err);
  console.error(`requests spent before failure: ${spent()}`);
  process.exit(1);
});
