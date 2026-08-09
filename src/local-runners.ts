// An AiRunner backed by any OpenAI-compatible HTTP endpoint: Ollama
// (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1),
// llama.cpp's server, vLLM, or a hosted provider.
//
// This is the seam that lets a local model stand in for Workers AI. It is
// deliberately a faithful translation and nothing more — same messages, same
// temperature, same max_tokens as the Workers AI path — so that a measured
// difference in output is a difference between models, not between prompts.
// In particular it does NOT ask for JSON mode: the Workers AI baseline does not
// either, and parseCandidateList already copes with fenced or chatty output.

import type { AiRunner } from "./generation";

export interface OpenAiRunnerOptions {
  /** Endpoint root including the version segment, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Omitted for local runtimes, which accept any key or none. */
  apiKey?: string;
  /** Merged into chat request bodies, last, so it can override a generation
   *  default. Server-specific escape hatch — the case that forced it is
   *  reasoning models, which spend the whole `max_tokens` budget on hidden
   *  thinking and return empty content unless thinking is turned off
   *  (`{"chat_template_kwargs": {"enable_thinking": false}}` on Ollama). */
  chatOptions?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

interface EmbeddingItem {
  index?: number;
  embedding?: number[];
}

function errorMessage(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const fromError = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (fromError) detail = fromError;
  } catch {
    // non-JSON error bodies (proxies, gateways) still carry a useful status
  }
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

export function createOpenAiRunner(options: OpenAiRunnerOptions): AiRunner {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (cause) {
      // "fetch failed" on its own sends people hunting through app code; the
      // usual cause is simply that nothing is listening on that port.
      throw new Error(`could not reach ${url} — is the server running?`, { cause });
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`${url} failed — ${errorMessage(res.status, text)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${url} returned a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  return {
    async run(model, inputs) {
      // Same discriminator the Workers AI binding uses: an embedding request
      // carries `text`, a chat request carries `messages`.
      const texts = inputs.text;
      if (Array.isArray(texts)) {
        const body = (await post("/embeddings", { model, input: texts })) as { data?: EmbeddingItem[] };
        const data = body.data;
        if (!Array.isArray(data) || data.length !== texts.length) {
          const got = Array.isArray(data) ? data.length : 0;
          throw new Error(`${model} returned ${got} embeddings for ${texts.length} texts`);
        }
        // The API does not promise ordering, and pairing by array position
        // would silently attach every vector to the wrong word.
        const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vectors = ordered.map((item, i) => {
          if (!Array.isArray(item.embedding)) throw new Error(`${model} returned no embedding at index ${i}`);
          return item.embedding;
        });
        return { data: vectors };
      }

      // Chat: pass the generation options straight through and hand back the
      // raw envelope — generation.ts already unwraps `choices[0].message.content`.
      return await post("/chat/completions", { model, ...inputs, ...options.chatOptions });
    },
  };
}

export interface OllamaRunnerOptions {
  /** Server root WITHOUT a version segment, e.g. http://localhost:11434 */
  baseUrl: string;
  /** Defaults to false. Reasoning is left on only when explicitly asked for. */
  think?: boolean;
  fetchImpl?: typeof fetch;
}

/** An AiRunner over Ollama's native API rather than its OpenAI-compatible one.
 *
 *  Reason for existing: a reasoning model behind the OpenAI route cannot be
 *  told to stop reasoning. Measured on qwen3.5:4b with dewpt's own few-shot
 *  prompt, `chat_template_kwargs: {enable_thinking: false}` was ignored and the
 *  model spent the entire token budget — 1024, then 4096 — on hidden reasoning,
 *  returning empty content every time. The native route's top-level `think:
 *  false` produced a parseable answer in 1.9s. Since most current local models
 *  are reasoning models, the OpenAI route alone would rule out the interesting
 *  half of the field. */
export function createOllamaRunner(options: OllamaRunnerOptions): AiRunner {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const think = options.think ?? false;

  async function post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${base}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new Error(`could not reach ${url} — is ollama running?`, { cause });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} failed — ${errorMessage(res.status, text)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${url} returned a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  return {
    async run(model, inputs) {
      const texts = inputs.text;
      if (Array.isArray(texts)) {
        const body = await post("/api/embed", { model, input: texts });
        const embeddings = body.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
          const got = Array.isArray(embeddings) ? embeddings.length : 0;
          throw new Error(`${model} returned ${got} embeddings for ${texts.length} texts`);
        }
        return { data: embeddings as number[][] };
      }

      const { messages, temperature, max_tokens: maxTokens, ...rest } = inputs;
      const body = await post("/api/chat", {
        model,
        messages,
        stream: false,
        think,
        options: { temperature, num_predict: maxTokens },
        ...rest,
      });

      const message = (body.message ?? {}) as { content?: string; thinking?: string };
      const content = message.content ?? "";
      if (content.trim() === "" && (message.thinking ?? "").trim() !== "") {
        // Distinct from "the model had nothing to say": the answer was crowded
        // out. Reported here so it cannot be mistaken for a barren band.
        throw new Error(
          `${model} spent its whole budget on reasoning and returned no content ` +
            `(${message.thinking!.length} chars of thinking, done_reason=${String(body.done_reason)}) — ` +
            `raise num_predict or use a non-reasoning model`,
        );
      }
      return { response: content };
    },
  };
}
