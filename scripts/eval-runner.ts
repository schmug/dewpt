// Backend selection for the eval scripts. Node-side, so it may use process.env
// — unlike eval-lib.ts. Local Ollama is the default because it costs nothing
// and needs no credentials; --workers-ai selects production's actual path.

import { localAiRunner, restAiRunner } from "../src/ai-runner";
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

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

export function resolveEvalRunner(argv: string[]): EvalRunner {
  if (argv.includes("--workers-ai")) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
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
  const rawChatOptions = flag(argv, "chat-options") ?? process.env.LOCAL_AI_CHAT_OPTIONS;
  return {
    runner: localAiRunner({
      baseUrl,
      chatOptions: rawChatOptions ? (JSON.parse(rawChatOptions) as Record<string, unknown>) : undefined,
    }),
    backend: "local",
    genModel: flag(argv, "model") ?? DEFAULT_LOCAL_GEN,
    embedModel: flag(argv, "embed-model") ?? DEFAULT_LOCAL_EMBED,
  };
}
