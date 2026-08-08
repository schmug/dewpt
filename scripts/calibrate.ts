// Prompt calibration harness. Prints three labeled candidate batches for a
// seed (strangeness 0.2 / 0.5 / 0.85, altitude 0.3) so generation quality can
// be eyeballed and src/generation.ts iterated on without touching the app.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run calibrate -- "your seed here"
//   options: --model=@cf/… (default: llama-3.3-70b-instruct-fp8-fast) --count=24
//
// The API token needs the "Workers AI - Read" permission.

import { restAiRunner } from "../src/ai-runner";
import { bandTemperature, generateCandidates } from "../src/generation";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const BATCHES = [
  { label: "strangeness 0.2  (near-field: the obvious condenses)", strangeness: 0.2 },
  { label: "strangeness 0.5  (mid-field: playful, sideways)", strangeness: 0.5 },
  { label: "strangeness 0.85 (far-field: surreal but tethered)", strangeness: 0.85 },
];
const ALTITUDE = 0.3;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map(
    args.filter((a) => a.startsWith("--")).map((a) => {
      const [key, ...rest] = a.slice(2).split("=");
      return [key!, rest.join("=")] as const;
    }),
  );
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!seed) {
    console.error('usage: npm run calibrate -- "your seed phrase" [--model=@cf/…] [--count=24]');
    process.exit(1);
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment");
    process.exit(1);
  }

  const model = flags.get("model") || DEFAULT_MODEL;
  const count = Number(flags.get("count")) || 24;
  const ai = restAiRunner(accountId, token);

  console.log(`seed:  ${seed}`);
  console.log(`model: ${model}   altitude: ${ALTITUDE}   count: ${count}\n`);

  const results = await Promise.all(
    BATCHES.map((batch) =>
      generateCandidates(ai, model, {
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
