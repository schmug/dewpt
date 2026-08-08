// Prompt calibration harness. Prints three labeled candidate batches for a
// seed (strangeness 0.2 / 0.5 / 0.85, altitude 0.3) so generation quality can
// be eyeballed and src/generation.ts iterated on without touching the app.
//
// This is the eyeball tool. For a number — whether the bands are actually
// separated in embedding space — use scripts/band-spike.ts.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run calibrate -- "your seed here"
//   options: --model=@cf/… (default: llama-3.3-70b-instruct-fp8-fast) --count=24
//
//   Against a local OpenAI-compatible server instead (Ollama, LM Studio, …):
//   npm run calibrate -- "your seed here" --gen-endpoint=http://localhost:11434/v1 --gen-model=qwen3:8b
//
// The API token needs the "Workers AI - Read" permission.

import { bandTemperature, generateCandidates } from "../src/generation";
import { CF_GEN_MODEL, numberFlag, parseArgs, resolveBackend } from "./runner-lib";

const BATCHES = [
  { label: "strangeness 0.2  (near-field: the obvious condenses)", strangeness: 0.2 },
  { label: "strangeness 0.5  (mid-field: playful, sideways)", strangeness: 0.5 },
  { label: "strangeness 0.85 (far-field: surreal but tethered)", strangeness: 0.85 },
];
const ALTITUDE = 0.3;

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const seed = positional.join(" ").trim();

  if (!seed) {
    console.error('usage: npm run calibrate -- "your seed phrase" [--model=@cf/…] [--count=24]');
    console.error("       [--gen-endpoint=http://localhost:11434/v1 --gen-model=qwen3:8b]");
    process.exit(1);
  }

  // `--model` stays supported as the original spelling of `--gen-model`.
  if (flags.has("model") && !flags.has("gen-model")) flags.set("gen-model", flags.get("model")!);
  const gen = resolveBackend(flags, "gen", CF_GEN_MODEL);
  const count = numberFlag(flags, "count", 24);

  console.log(`seed:  ${seed}`);
  console.log(`model: ${gen.label}   altitude: ${ALTITUDE}   count: ${count}\n`);

  const results = await Promise.all(
    BATCHES.map((batch) =>
      generateCandidates(gen.ai, gen.model, {
        seed,
        strangeness: batch.strangeness,
        altitude: ALTITUDE,
        anchors: [],
        exclude: [],
        count,
      }),
    ),
  );

  for (const [i, batch] of BATCHES.entries()) {
    const words = results[i]!;
    console.log(`── ${batch.label} ── temperature ${bandTemperature(batch.strangeness).toFixed(2)}, ${words.length}/${count} parsed`);
    for (const word of words) console.log(`   ${word}`);
    if (words.length === 0) console.log("   (nothing parseable came back — inspect the prompt or model)");
    console.log("");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
