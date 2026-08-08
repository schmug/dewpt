// Backend selection for the eval scripts. Node-side, so it may use process.env
// — unlike eval-lib.ts. Local Ollama is the default because it costs nothing
// and needs no credentials; --workers-ai selects production's actual path.
//
// Parsing here is deliberately strict. This is an eval harness: an argument it
// cannot honour must not be ignored, because the run still produces numbers and
// those numbers get attributed to whatever the parser fell back to. Every
// malformed, misspelled or space-separated flag throws by name instead.

import { localAiRunner, parseChatOptions, restAiRunner } from "../src/ai-runner";
import type { AiRunner } from "../src/generation";

export interface EvalRunner {
  runner: AiRunner;
  backend: "local" | "workers-ai";
  genModel: string;
  embedModel: string;
}

const DEFAULT_LOCAL_BASE = "http://localhost:11434/v1";
const DEFAULT_LOCAL_GEN = "qwen3.5:4b";
const DEFAULT_LOCAL_EMBED = "bge-m3";
const DEFAULT_CF_GEN = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_CF_EMBED = "@cf/baai/bge-m3";

/** Every flag the eval scripts accept, and whether it carries `=value`.
 *  `--models`, `--record` and `--judge` belong to the sibling matrix script,
 *  which routes its whole argv through here; they are listed so that script's
 *  arguments are not rejected as unknown.
 *
 *  A Map, not an object literal, because the keys are attacker-shaped input:
 *  argv. `KNOWN_FLAGS["toString"]` on a literal reaches Object.prototype, and
 *  --toString= was accepted and then silently ignored — the one outcome this
 *  parser exists to prevent. Tightening the guard to `=== undefined` would not
 *  have helped: the inherited value is a *function*, not undefined. A Map has
 *  no prototype chain for its keys, so the fix lives in the table rather than
 *  in one call site, and `.get()` is typed `… | undefined`, which makes the
 *  compiler insist on the guard instead of promising a value that isn't there. */
const KNOWN_FLAGS = new Map<string, "value" | "bare" | "boolean">([
  ["workers-ai", "boolean"],
  ["model", "value"],
  ["embed-model", "value"],
  ["base-url", "value"],
  ["chat-options", "value"],
  ["models", "value"],
  ["judge", "value"],
  ["record", "bare"],
]);

const FLAG_LIST = [...KNOWN_FLAGS.keys()].map((name) => `--${name}`).join(", ");

const TRUE_VALUES = new Set(["true", "1"]);
const FALSE_VALUES = new Set(["false", "0"]);

function flagName(arg: string): string {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  return eq === -1 ? body : body.slice(0, eq);
}

/** Rejects anything the parser cannot honour, before any of it is read. Each
 *  case here was a silent misparse: an unknown flag ran the wrong backend, a
 *  space-separated value ran the wrong model, an empty value beat both the
 *  default and the env fallback. */
function assertFlagSyntax(argv: string[]): void {
  for (const arg of argv) {
    // "--" is the conventional end-of-options separator, not a flag.
    if (!arg.startsWith("--") || arg === "--") continue;
    const name = flagName(arg);
    const kind = KNOWN_FLAGS.get(name);
    if (kind === undefined) throw new Error(`unknown flag: --${name}. This script accepts ${FLAG_LIST}`);

    const eq = arg.indexOf("=");
    if (eq === -1) {
      // `--model gpt-x` parses as a bare --model plus a positional argument.
      // Guessing that the next token is the value is how CLIs swallow a seed
      // phrase; refusing outright is the only safe reading.
      if (kind === "value") {
        throw new Error(`--${name} needs a value: write --${name}=value (space-separated values are not supported)`);
      }
      continue;
    }
    if (kind === "bare") throw new Error(`--${name} takes no value; write it bare, not --${arg.slice(2)}`);
    if (arg.slice(eq + 1) === "") throw new Error(`--${name}= was given an empty value; omit the flag to use the default`);
  }
}

/** Last-wins, because wrapper scripts append overrides after a base argv and
 *  first-wins drops them without a word. */
function flag(argv: string[], name: string): string | undefined {
  // The trailing "=" in the prefix is load-bearing: without it `--models=a,b`
  // would satisfy flag(argv, "model").
  const prefix = `--${name}=`;
  let hit: string | undefined;
  for (const arg of argv) if (arg.startsWith(prefix)) hit = arg;
  if (hit === undefined) return undefined;
  // Slice rather than split: values legitimately contain "=" (query strings,
  // JSON), and splitting would truncate at the first one.
  const value = hit.slice(prefix.length);
  // "" is not a value, and neither is "   " — same rule the CLOUDFLARE_* trim
  // applies below: a whitespace-only value is unset. `??` only falls back on
  // nullish, so returning either here beats both the default and the env
  // fallback; --base-url="   " posted to "   /embeddings" and --model="   "
  // named a model no server has.
  if (value.trim() === "") throw new Error(`--${name}= was given an empty value; omit the flag to use the default`);
  return value;
}

/** `--workers-ai`, `--workers-ai=true` and `--workers-ai=1` all mean the same
 *  thing. An exact-string `argv.includes` check silently ran the local backend
 *  for the latter two and labelled the results "workers-ai". */
function boolFlag(argv: string[], name: string): boolean {
  let value: string | undefined;
  const prefix = `--${name}=`;
  for (const arg of argv) {
    if (arg === `--${name}`) value = "true";
    else if (arg.startsWith(prefix)) value = arg.slice(prefix.length);
  }
  if (value === undefined) return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(`--${name}=${value} is not a boolean; use --${name}, --${name}=true or --${name}=false`);
}

export function resolveEvalRunner(argv: string[]): EvalRunner {
  assertFlagSyntax(argv);

  if (boolFlag(argv, "workers-ai")) {
    // Trimmed before the guard, matching aiMode/selectAiRunner: a
    // whitespace-only value is unset, and untrimmed it builds
    // https://api.cloudflare.com/client/v4/accounts/%20%20/ai/run/…
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !token) {
      throw new Error('--workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (token needs "Workers AI - Read")');
    }
    return {
      runner: restAiRunner(accountId, token),
      backend: "workers-ai",
      genModel: flag(argv, "model") ?? DEFAULT_CF_GEN,
      embedModel: flag(argv, "embed-model") ?? DEFAULT_CF_EMBED,
    };
  }
  const baseUrl = flag(argv, "base-url") ?? process.env.LOCAL_AI_BASE_URL ?? DEFAULT_LOCAL_BASE;
  // Same validator the Worker uses on the same value. A bare JSON.parse here
  // accepted `[1,2]` and spread it into the chat body as {"0":1,"1":2}, and
  // silently no-opped on a scalar — which presents as "the thinking model
  // still returns nothing", the exact symptom chatOptions exists to fix.
  const chatOptions = parseChatOptions(flag(argv, "chat-options") ?? process.env.LOCAL_AI_CHAT_OPTIONS);
  return {
    runner: localAiRunner({ baseUrl, chatOptions }),
    backend: "local",
    genModel: flag(argv, "model") ?? DEFAULT_LOCAL_GEN,
    embedModel: flag(argv, "embed-model") ?? DEFAULT_LOCAL_EMBED,
  };
}
