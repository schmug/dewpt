// Chooses the AiRunner the session uses. Three sources, in precedence order:
// the offline fake (DEV_FAKE_AI=1), a local OpenAI-compatible server
// (LOCAL_AI_BASE_URL), and the Workers AI binding. Production is Workers AI;
// the other two exist because this machine's dev runtime frequently cannot
// reach it — see the WARP and Access traps in CLAUDE.md.

import { fakeAiRunner } from "./dev-fake-ai";
import { budgetedAiRunner, type AccountBudgetEnv } from "./ai-budget";
import { createOpenAiRunner } from "./local-runners";
import type { AiRunner } from "./generation";

export interface LocalAiConfig {
  /** Root of the OpenAI-compatible API, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Where `/embeddings` goes, when that is not the chat server. `mlx_lm.server`
   *  — how Maple runs — serves `/v1/chat/completions` and `/v1/completions`
   *  only, so a local setup routinely needs generation on one host and
   *  embedding on another. Defaults to `baseUrl`. */
  embedBaseUrl?: string;
  /** Optional; Ollama ignores it, LM Studio and vLLM may require one. Sent to
   *  both hosts — fine for localhost servers, worth splitting if either is ever
   *  remote. */
  apiKey?: string;
  /** Extra fields merged into every chat body, after the defaults so they win.
   *  The case this exists for: a thinking model spends the whole max_tokens
   *  budget on `message.reasoning` and returns an empty `content`, which parses
   *  to zero candidates and an empty field. Ollama's OpenAI layer honours
   *  `{"reasoning_effort":"none"}` — measured against qwen3.5:4b, which goes
   *  from 0 words to 8. Config rather than a generation.ts param because the
   *  spelling is server-specific: `chat_template_kwargs.enable_thinking` and
   *  `think` are both silently ignored by Ollama. */
  chatOptions?: Record<string, unknown>;
}

/** The Worker's local-model runner: main's OpenAI-compatible client
 *  (createOpenAiRunner) behind the LOCAL_AI_* config. The only thing added here
 *  is the host split — chat on `baseUrl`, embeddings on `embedBaseUrl` — so
 *  there is one OpenAI client in the codebase, not two. chatOptions ride on
 *  chat requests only; createOpenAiRunner never merges them into embeddings. */
export function localAiRunner(config: LocalAiConfig): AiRunner {
  const chat = createOpenAiRunner({ baseUrl: config.baseUrl, apiKey: config.apiKey, chatOptions: config.chatOptions });
  if (!config.embedBaseUrl) return chat;
  const embed = createOpenAiRunner({ baseUrl: config.embedBaseUrl, apiKey: config.apiKey });
  return { run: (model, inputs) => (inputs.text === undefined ? chat : embed).run(model, inputs) };
}

export interface AiEnv {
  /** The Workers AI binding. Typed loosely on purpose: the generated `Ai` type
   *  overloads `run` per model id, and dewpt's model names come from vars, so
   *  it crosses that boundary with one cast — here rather than at every call. */
  AI: unknown;
  DEV_FAKE_AI?: string;
  LOCAL_AI_BASE_URL?: string;
  /** Only needed when the chat server has no /v1/embeddings. See LocalAiConfig. */
  LOCAL_AI_EMBED_BASE_URL?: string;
  LOCAL_AI_API_KEY?: string;
  /** JSON object, e.g. `{"reasoning_effort":"none"}`. See LocalAiConfig. */
  LOCAL_AI_CHAT_OPTIONS?: string;
}

/** Exported so node-side scripts can validate the same value the same way.
 *  Two parsers for one option is how a harness ends up posting garbage keys
 *  the Worker would have rejected. */
export function parseChatOptions(raw: string | undefined): Record<string, unknown> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // Loud on purpose. Dropping it would present as "the thinking model still
  // returns nothing", which is the exact symptom the option exists to fix.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`LOCAL_AI_CHAT_OPTIONS must be a JSON object, got: ${text.slice(0, 80)}`);
  }
  return parsed as Record<string, unknown>;
}

export type AiMode = "fake" | "local" | "workers-ai";

/** The single place precedence is decided, so /api/debug/ai can report the
 *  backend that will actually answer instead of re-deriving it. DEV_FAKE_AI
 *  wins over a configured local endpoint: it is the last-resort hatch for a
 *  runtime with no egress at all, and a stale LOCAL_AI_BASE_URL left in
 *  .dev.vars would otherwise keep it trying to open a socket. */
export function aiMode(env: AiEnv): AiMode {
  if (env.DEV_FAKE_AI === "1") return "fake";
  return env.LOCAL_AI_BASE_URL?.trim() ? "local" : "workers-ai";
}

export function selectAiRunner(env: AiEnv): AiRunner {
  const mode = aiMode(env);
  if (mode === "fake") return fakeAiRunner();

  const baseUrl = env.LOCAL_AI_BASE_URL?.trim();
  if (mode === "local" && baseUrl) {
    return localAiRunner({
      baseUrl,
      embedBaseUrl: env.LOCAL_AI_EMBED_BASE_URL?.trim() || undefined,
      apiKey: env.LOCAL_AI_API_KEY?.trim() || undefined,
      chatOptions: parseChatOptions(env.LOCAL_AI_CHAT_OPTIONS),
    });
  }

  const binding = env.AI as AiRunner;
  return { run: (model, inputs) => binding.run(model, inputs) };
}

/** Production Worker/DO entry point. Backend selection stays independently
 * testable above, while every live inference path is required to name the
 * capability whose work is charged against the shared account budget. */
export function selectBudgetedAiRunner(env: AiEnv & AccountBudgetEnv, capability: string): AiRunner {
  return budgetedAiRunner(env, capability, selectAiRunner(env));
}
