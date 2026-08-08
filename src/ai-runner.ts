// Chooses the AiRunner the session uses. Three sources, in precedence order:
// the offline fake (DEV_FAKE_AI=1), a local OpenAI-compatible server
// (LOCAL_AI_BASE_URL), and the Workers AI binding. Production is Workers AI;
// the other two exist because this machine's dev runtime frequently cannot
// reach it — see the WARP and Access traps in CLAUDE.md.

import { fakeAiRunner } from "./dev-fake-ai";
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

interface EmbeddingRow {
  index?: number;
  embedding?: number[];
}

const BODY_SNIPPET_CHARS = 200;

/** An AiRunner over an OpenAI-compatible HTTP API (Ollama, llama.cpp's server,
 *  LM Studio, vLLM). Translates in both directions so the rest of the app keeps
 *  speaking the Workers AI binding's shapes:
 *
 *  - `{ text }` → POST /embeddings, and the `{ data: [{ embedding }] }`
 *    envelope back into the `{ data: number[][] }` embedTexts expects.
 *  - anything else → POST /chat/completions. `messages`, `temperature` and
 *    `max_tokens` already share OpenAI's names, so they pass straight through,
 *    and generation.ts's extractResponse already reads `choices[0].message`. */
export function localAiRunner(config: LocalAiConfig): AiRunner {
  const trim = (url: string) => url.replace(/\/+$/, "");
  const chatBase = trim(config.baseUrl);
  const embedBase = config.embedBaseUrl ? trim(config.embedBaseUrl) : chatBase;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  async function post(root: string, path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${root}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, BODY_SNIPPET_CHARS);
      throw new Error(`local AI ${root}${path} returned ${response.status}: ${detail}`);
    }
    return response.json();
  }

  return {
    async run(model, inputs) {
      if (inputs.text === undefined) {
        return post(chatBase, "/chat/completions", { model, ...inputs, ...config.chatOptions });
      }

      const input = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
      const body = (await post(embedBase, "/embeddings", { model, input })) as { data?: EmbeddingRow[] };
      const rows = body?.data;
      if (!Array.isArray(rows)) throw new Error(`local AI ${embedBase}/embeddings returned no embedding rows`);
      // OpenAI does not promise `data` comes back in request order, and a
      // misordered row would attach the wrong vector to every candidate.
      const vectors: number[][] = [];
      rows.forEach((row, i) => {
        vectors[row?.index ?? i] = row?.embedding as number[];
      });
      return { data: vectors };
    },
  };
}

/** Workers AI over its REST API rather than a binding. Scripts run in node with
 *  no binding available, and this path is also unaffected by the wrangler-dev
 *  egress traps documented in CLAUDE.md. */
export function restAiRunner(accountId: string, token: string): AiRunner {
  return {
    async run(model, inputs) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });
      const body = (await response.json()) as {
        success: boolean;
        result?: unknown;
        errors?: { message: string }[];
      };
      if (!response.ok || !body.success) {
        const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
        throw new Error(`Workers AI call failed for ${model}: ${detail}`);
      }
      return body.result;
    },
  };
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

/** Exported so the node-side eval scripts validate the same value the same way.
 *  Two parsers for one option is how the eval harness ends up posting garbage
 *  keys the Worker would have rejected. */
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
