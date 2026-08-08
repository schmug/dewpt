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
// REST-from-node like calibrate.ts and the axis spikes, so it is unaffected by
// the local wrangler-dev egress issues (see CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run board-calibrate
//
// The token needs "Workers AI - Read".

import { scoreCandidates } from "../src/board/rewrite";
import { auc, cosine, embedTexts, requireCreds } from "./axis-lib";

const GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Hops per chain in the progression probe. Long enough that a crawl shows up
 *  as a flat trajectory, short enough to keep this one cheap run. */
const CHAIN_HOPS = 5;

/** Candidates generated per hop inside the chain probe. Held fixed so the
 *  progression result is about selection, not about fan-out width. */
const CHAIN_FANOUT = 8;

/** Monotonic trajectories required for the "chains progress" verdict. */
const MONOTONIC_REQUIRED = 2;

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

/** Shared by the fan-out width measurement and the chain probe, so both are
 *  measuring the same generation shape. */
const REWRITE_SYSTEM = `You rewrite a short fragment into a NEW short fragment that moves it toward a target quality while staying recognisably derived from it.

Rules:
- Respond with a JSON array of strings only. No prose, no code fences.
- Each item is 1-5 words.
- Every item must be a rewrite of the given fragment, not a new topic.
- No duplicates.`;

async function generate(accountId: string, token: string, messages: unknown, temperature: number): Promise<string> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${GEN_MODEL}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages, temperature, max_tokens: 512 }),
  });
  const body = (await res.json()) as { success: boolean; result?: { response?: string }; errors?: { message: string }[] };
  if (!res.ok || !body.success) {
    throw new Error(`generate failed: ${body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
  }
  return body.result?.response ?? "";
}

/** Model output is untrusted: slice to the outermost brackets, parse, and drop
 *  anything that is not a non-empty string. Never throws. */
function parseArray(raw: string, n: number): string[] {
  let items: unknown[] = [];
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    items = start !== -1 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as unknown[]) : [];
  } catch {
    items = [];
  }
  if (!Array.isArray(items)) return [];
  return items.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, n);
}

async function candidatesFor(
  accountId: string,
  token: string,
  fragment: string,
  target: string,
  n: number,
): Promise<string[]> {
  const raw = await generate(accountId, token, [
    { role: "system", content: REWRITE_SYSTEM },
    { role: "user", content: `${JSON.stringify({ fragment, target, count: n })}\nReturn a JSON array of exactly ${n} strings.` },
  ], 0.9);
  return parseArray(raw, n);
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();

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
  // Keep ~95% of genuine rewrites; the floor sits just under their 5th pct.
  const floor = pct(genuineTethers, 0.05);
  const falseAccept = nonSequiturTethers.filter((t) => t >= floor).length / nonSequiturTethers.length;

  console.log("\n=== TETHER_FLOOR ===");
  console.log(`  separation AUC        ${tetherAuc.toFixed(3)}   (gate: >= 0.80)`);
  console.log(`  genuine  p05 ${pct(genuineTethers, 0.05).toFixed(3)}  p50 ${pct(genuineTethers, 0.5).toFixed(3)}`);
  console.log(`  non-seq  p50 ${pct(nonSequiturTethers, 0.5).toFixed(3)}  p95 ${pct(nonSequiturTethers, 0.95).toFixed(3)}`);
  console.log(`  proposed TETHER_FLOOR ${floor.toFixed(3)}  (admits ${(falseAccept * 100).toFixed(0)}% of non-sequiturs)`);

  const arrivals = arrivalByHop.flat();
  console.log("\n=== ARRIVAL_COSINE ===");
  console.log(`  genuine-rewrite cosine to phrase: p50 ${pct(arrivals, 0.5).toFixed(3)}  p95 ${pct(arrivals, 0.95).toFixed(3)}  max ${Math.max(...arrivals).toFixed(3)}`);
  console.log(`  proposed ARRIVAL_COSINE ${(pct(arrivals, 0.95) + 0.05).toFixed(3)}  (above p95, so a normal hop never false-reports arrival)`);

  // ── 3. CANDIDATES_PER_HOP ───────────────────────────────────────────────
  // For each N, how often does at least one live candidate clear the floor,
  // and how much better is argmax than an average candidate?
  console.log("\n=== CANDIDATES_PER_HOP ===");

  for (const n of [4, 8, 12]) {
    let yielded = 0;
    let lift = 0;
    for (const probe of PROBES) {
      const items = await candidatesFor(accountId, token, probe.parent, probe.phrase, n);
      if (items.length === 0) continue;
      const vecs = await embedTexts(accountId, token, [probe.parent, probe.phrase, ...items]);
      const scored = scoreCandidates(vecs[0]!, vecs[1]!, items.map((text, i) => ({ text, embedding: vecs[i + 2]! })));
      const live = scored.filter((c) => c.tether >= floor);
      if (live.length > 0) {
        yielded++;
        lift += Math.max(...live.map((c) => c.score)) - mean(scored.map((c) => c.score));
      }
    }
    console.log(`  n=${String(n).padStart(2)}  hops with a usable child: ${yielded}/${PROBES.length}   argmax lift over mean: ${(lift / PROBES.length).toFixed(3)}`);
  }

  // ── 4. CHAIN PROGRESSION ────────────────────────────────────────────────
  // `score` is alignment, not distance, so argmax may prefer a minimally-moved
  // child every hop. Run real chains — same station phrase each hop, argmax
  // among candidates clearing the floor — and watch cosine-to-phrase.
  console.log("\n=== CHAIN PROGRESSION ===");
  console.log(`  ${CHAIN_HOPS} sequential hops per probe, ${CHAIN_FANOUT} candidates each, same station`);
  console.log(`  phrase every hop, argmax by score among candidates with tether >= ${floor.toFixed(3)}.`);
  console.log(`  "moved" is 1 - cosine(child, its own parent): the hop's actual size.`);

  const allDeltas: number[] = [];
  let monotonicChains = 0;
  let completeChains = 0;

  for (const probe of PROBES) {
    const seed = await embedTexts(accountId, token, [probe.parent, probe.phrase]);
    const phraseVec = seed[1]!;
    let parentVec = seed[0]!;
    let parentText = probe.parent;
    let prevCos = cosine(parentVec, phraseVec);

    const trajectory: number[] = [];
    const deltas: number[] = [];
    let broke = false;

    console.log(`\n  ${probe.parent}  ->  ${probe.phrase}`);
    console.log(`    hop 0  cos-to-phrase ${prevCos.toFixed(3)}                        "${probe.parent}"  (seed)`);

    for (let hop = 1; hop <= CHAIN_HOPS; hop++) {
      const items = await candidatesFor(accountId, token, parentText, probe.phrase, CHAIN_FANOUT);
      if (items.length === 0) {
        console.log(`    hop ${hop}  CHAIN BROKEN: the model returned no parsable candidates`);
        broke = true;
        break;
      }
      const vecs = await embedTexts(accountId, token, items);
      const scored = scoreCandidates(parentVec, phraseVec, items.map((text, i) => ({ text, embedding: vecs[i]! })));
      const live = scored.filter((c) => c.tether >= floor);
      if (live.length === 0) {
        console.log(`    hop ${hop}  CHAIN BROKEN: no candidate cleared the tether floor (best tether ${Math.max(...scored.map((c) => c.tether)).toFixed(3)})`);
        broke = true;
        break;
      }
      const best = live.reduce((a, b) => (b.score > a.score ? b : a));

      const cos = cosine(best.embedding, phraseVec);
      const moved = 1 - cosine(best.embedding, parentVec);
      trajectory.push(cos);
      deltas.push(cos - prevCos);
      console.log(
        `    hop ${hop}  cos-to-phrase ${cos.toFixed(3)} (${signed(cos - prevCos)})  moved ${moved.toFixed(3)}  "${best.text}"`,
      );

      prevCos = cos;
      parentVec = best.embedding;
      parentText = best.text;
    }

    allDeltas.push(...deltas);
    const isMonotonic = !broke && deltas.length === CHAIN_HOPS && deltas.every((d) => d > 0);
    if (!broke) completeChains++;
    if (isMonotonic) monotonicChains++;

    console.log(`    trajectory  ${trajectory.length > 0 ? trajectory.map((c) => c.toFixed(3)).join("  ") : "(none — chain broke on the first hop)"}`);
    console.log(`    mean per-hop increase ${signed(mean(deltas))}   monotonic: ${isMonotonic ? "yes" : "no"}`);
  }

  const meanDelta = mean(allDeltas);
  const progresses = meanDelta > 0 && monotonicChains >= MONOTONIC_REQUIRED;

  console.log("\n  --- chain progression summary ---");
  console.log(`  mean per-hop increase in cos-to-phrase: ${signed(meanDelta)}  (over ${allDeltas.length} hops)`);
  console.log(`  monotonically increasing trajectories:  ${monotonicChains}/${PROBES.length}`);
  console.log(`  chains completing all ${CHAIN_HOPS} hops:            ${completeChains}/${PROBES.length}`);
  console.log(`  rule: chains PROGRESS when the mean per-hop increase is positive`);
  console.log(`        AND at least ${MONOTONIC_REQUIRED} of ${PROBES.length} trajectories are monotonic.`);
  console.log(
    `  VERDICT: chains ${progresses ? "PROGRESS" : "DO NOT PROGRESS (they crawl)"} — mean per-hop increase ${signed(meanDelta)} is ${meanDelta > 0 ? "positive" : "not positive"}, ${monotonicChains}/${PROBES.length} monotonic vs ${MONOTONIC_REQUIRED} required.`,
  );
  if (!progresses) {
    console.log(`  Argmax-by-alignment is picking minimally-moved children. Selection needs a`);
    console.log(`  magnitude term (or a per-hop minimum move) before Task 3 builds on it.`);
  }

  console.log("\nGATE: if separation AUC < 0.80, the rewrite mechanic does not work. Stop and report.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
