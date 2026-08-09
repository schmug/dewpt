// SPIKE: does a local (or small) model hold dewpt's strangeness bands apart the
// way llama-3.3-70b does?
//
// This is the gating question for running dewpt on a local or on-device LLM.
// Generation quality is the risk, not speed — the candidate pool already hides
// latency, but nothing hides a model that ignores the strangeness parameter and
// emits the same register at every setting. That failure is invisible in
// calibrate.ts's word lists (the words still look fine) and obvious here: band
// collapse reads as an adjacent-band AUC near 0.5.
//
// Method: generate at strangeness 0.2 / 0.5 / 0.85, embed every candidate with
// ONE fixed embedder, score each by distance from the seed (the same
// `1 − cosine` PoolCore stores), and report the probability that a word from
// the stranger band outranks a word from the nearer one.
//
// The embedder is deliberately held constant while the generator varies, so a
// difference in the headline number is a difference between generators. Run the
// Workers AI baseline first, then compare.
//
// Results on 2026-08-08, seed "urban gardening", 2 × 20 per band, bge-m3
// embedder throughout — adjacent-band AUC:
//
//   llama-3.3-70b-fp8-fast (Workers AI)   0.686   baseline; 2.0-2.8s per call
//   qwen3.5:4b (local, ollama)            0.533   collapsed; 1.7s per call
//   qwen2.5-coder:7b (local, ollama)      0.477   collapsed; 1.9s per call
//
// Two things that reading the word lists would not have told you. First, speed
// is not the constraint — the local models were FASTER than the 70b, and the
// pool hides latency anyway; they simply do not respond to the strangeness
// parameter. Second, qwen3.5:4b echoed 10-15% of each band verbatim from the
// few-shot examples below, so part of what looks like on-brief output is the
// prompt being read back.
//
// The baseline's own low->mid AUC is 0.575, near chance, while mid->high is
// 0.796. Even the 70b barely separates the first two bands on this seed — worth
// a look before blaming any local model for the same failure.
//
// Usage:
//   # baseline (both roles on Workers AI)
//   npm run band-spike -- "urban gardening"
//
//   # local generator, same Workers AI embedder — the comparison that matters.
//   # Use the ollama transport for any reasoning model (qwen3, deepseek-r1, …):
//   # it is the only route that reliably turns thinking off. Note the base URL
//   # has no /v1 on this transport.
//   npm run band-spike -- "urban gardening" \
//     --gen-endpoint=http://localhost:11434 --gen-api=ollama --gen-model=qwen3.5:4b \
//     --baseline=0.686
//
//   # a non-reasoning model is fine over the OpenAI-compatible route
//   npm run band-spike -- "urban gardening" \
//     --gen-endpoint=http://localhost:11434/v1 --gen-model=qwen2.5-coder:7b --baseline=0.686
//
//   # fully local (needs an embedding model too, e.g. `ollama pull bge-m3`)
//   npm run band-spike -- "urban gardening" \
//     --gen-endpoint=http://localhost:11434 --gen-api=ollama --gen-model=qwen3.5:4b \
//     --embed-endpoint=http://localhost:11434 --embed-api=ollama --embed-model=bge-m3
//
// Options: --count=24 --repeats=2 --altitude=0.3 --baseline=<auc> --gen-key= --embed-key=
//          --gen-api=ollama|openai   transport (default openai)
//          --think                   keep reasoning on (ollama transport)
//          --no-think                best-effort thinking-off on the openai route
//          --gen-body='{"max_tokens":4096}'   raw request-body overrides

import { type BandSample, bandReport } from "../src/band-metrics";
import { FEWSHOT_EXEMPLARS, bandTemperature, embedTexts, generateCandidates } from "../src/generation";
import { CF_EMBED_MODEL, CF_GEN_MODEL, numberFlag, parseArgs, resolveBackend } from "./runner-lib";

const BANDS = [
  { label: "low", strangeness: 0.2, blurb: "near-field: the obvious condenses" },
  { label: "mid", strangeness: 0.5, blurb: "mid-field: playful, sideways" },
  { label: "high", strangeness: 0.85, blurb: "far-field: surreal but tethered" },
];

const RULE = "═".repeat(78);

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

/** Deliberately shy of absolute quality grades: the only threshold that means
 *  something on its own is chance, where the strangeness parameter provably did
 *  nothing. Everything else is a comparison against the model you would other-
 *  wise ship, which is what --baseline is for. */
function verdict(adjacentAuc: number, monotonic: boolean, baseline: number): string {
  if (!Number.isFinite(adjacentAuc)) return "NO VERDICT — a band came back empty; fix parsing or the model first";
  if (adjacentAuc < 0.55) return "COLLAPSED — indistinguishable from chance; this model ignores strangeness";
  if (!monotonic) return "DISORDERED — bands separate, but not in strangeness order";

  if (!Number.isFinite(baseline)) return "ordered and separated — compare against a baseline to judge the margin";
  const delta = adjacentAuc - baseline;
  if (Math.abs(delta) <= 0.05) return "MATCHES BASELINE — this model holds the bands as well as the reference";
  return delta > 0
    ? "BEATS BASELINE — separates the bands better than the reference model"
    : "BELOW BASELINE — the bands are meaningfully more smeared than the reference";
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const seed = positional.join(" ").trim();
  if (!seed) {
    console.error('usage: npm run band-spike -- "your seed phrase" [--gen-endpoint=… --gen-model=…]');
    console.error("see the header of scripts/band-spike.ts for the full option list");
    process.exit(1);
  }

  const gen = resolveBackend(flags, "gen", CF_GEN_MODEL);
  const embed = resolveBackend(flags, "embed", CF_EMBED_MODEL);
  const count = numberFlag(flags, "count", 24);
  const repeats = numberFlag(flags, "repeats", 2);
  const altitude = numberFlag(flags, "altitude", 0.3);
  const baseline = flags.has("baseline") ? numberFlag(flags, "baseline", NaN) : NaN;

  console.log(RULE);
  console.log(`BAND SEPARATION SPIKE — seed: "${seed}"`);
  console.log(RULE);
  console.log(`  generator: ${gen.label}`);
  console.log(`  embedder:  ${embed.label}${embed.local ? "" : "   (held constant — the measuring instrument)"}`);
  // Any deviation from the baseline request body is disclosed: it is the first
  // thing to suspect when two runs disagree.
  for (const [role, backend] of [["gen", gen], ["embed", embed]] as const) {
    const options = backend.chatOptions;
    if (Object.keys(options).length > 0) console.log(`  ${role} body overrides: ${JSON.stringify(options)}`);
  }
  console.log(`  altitude ${altitude}   ${repeats} × ${count} candidates per band, generated sequentially\n`);

  const seedVec = (await embedTexts(embed.ai, embed.model, [seed]))[0]!;
  console.log(`  seed embedded: ${seedVec.length} dims\n`);

  const samples: BandSample[] = [];
  for (const band of BANDS) {
    const texts: string[] = [];
    let elapsed = 0;
    for (let r = 0; r < repeats; r++) {
      const started = Date.now();
      // `exclude` carries what this band already produced, exactly as the DO's
      // pump does — so repeats stress the no-duplicates instruction too.
      const batch = await generateCandidates(gen.ai, gen.model, {
        seed,
        strangeness: band.strangeness,
        altitude,
        anchors: [],
        exclude: [...texts],
        count,
      });
      elapsed += Date.now() - started;
      texts.push(...batch);
    }

    const embeddings = texts.length > 0 ? await embedTexts(embed.ai, embed.model, texts) : [];
    samples.push({ label: band.label, strangeness: band.strangeness, requested: count * repeats, texts, embeddings });

    const perCall = elapsed / repeats / 1000;
    console.log(
      `  ${band.label.padEnd(5)} strangeness ${band.strangeness}  temp ${bandTemperature(band.strangeness).toFixed(2)}  ` +
        `${String(texts.length).padStart(3)}/${count * repeats} parsed  ${perCall.toFixed(1)}s per call`,
    );
    console.log(`        ${texts.slice(0, 6).join(" · ") || "(nothing parseable came back)"}`);
  }

  const report = bandReport(seedVec, samples, { exemplars: FEWSHOT_EXEMPLARS });

  console.log("\n" + RULE);
  console.log("PER-BAND — seed distance is 1 − cosine, the same quantity PoolCore stores");
  console.log(RULE + "\n");
  const bandHeader = [
    "band".padEnd(8), "yield".padStart(8), "mean dist".padStart(12), "sd".padStart(9),
    "near-dupes".padStart(12), "echoed".padStart(9),
  ].join("");
  console.log(bandHeader);
  console.log("─".repeat(bandHeader.length));
  for (const b of report.bands) {
    console.log(
      [
        b.label.padEnd(8),
        `${Math.round(b.yield * 100)}%`.padStart(8),
        fmt(b.meanSeedDist, 4).padStart(12),
        fmt(b.sdSeedDist, 4).padStart(9),
        `${Math.round(b.nearDuplicateRate * 100)}%`.padStart(12),
        `${Math.round(b.echoRate * 100)}%`.padStart(9),
      ].join(""),
    );
  }
  console.log(`\n  mean seed distance rises with strangeness: ${report.monotonic ? "yes" : "NO"}`);
  console.log("  (near-dupes = share of within-band pairs the pool would reject as duplicates)");
  console.log("  (echoed = share copied verbatim from the prompt's few-shot examples)");

  console.log("\n" + RULE);
  console.log("SEPARATION — P(a random word from the stranger band sits farther from the seed)");
  console.log(RULE + "\n");
  const pairHeader = ["pair".padEnd(16), "AUC".padStart(9), "Cohen's d".padStart(12), "".padStart(14)].join("");
  console.log(pairHeader);
  console.log("─".repeat(pairHeader.length));
  for (const p of report.pairs) {
    console.log(
      [
        `${p.from} → ${p.to}`.padEnd(16),
        fmt(p.auc).padStart(9),
        fmt(p.cohensD, 2).padStart(12),
        (p.adjacent ? "adjacent" : "extremes").padStart(14),
      ].join(""),
    );
  }

  console.log("\n" + RULE);
  console.log(`HEADLINE — mean adjacent-band AUC: ${fmt(report.adjacentAuc)}`);
  if (Number.isFinite(baseline)) {
    const delta = report.adjacentAuc - baseline;
    console.log(`           against baseline ${fmt(baseline)}: ${delta >= 0 ? "+" : ""}${fmt(delta)}`);
  } else {
    console.log("           (run without --gen-endpoint to record the Workers AI baseline, then pass --baseline=…)");
  }
  console.log(`           ${verdict(report.adjacentAuc, report.monotonic, baseline)}`);
  console.log(RULE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
