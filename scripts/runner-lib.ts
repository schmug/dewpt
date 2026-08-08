// Shared CLI plumbing for the spikes: flag parsing, and picking which model
// backend fills a role (generation or embedding).
//
// Two backends, one interface. Workers AI over REST-from-node (unaffected by
// the local wrangler-dev egress traps documented in CLAUDE.md), and any
// OpenAI-compatible endpoint via src/local-runners.ts. The roles are chosen
// independently on purpose: measuring a local generator against a Workers AI
// embedder keeps the measuring instrument fixed while the thing under test
// changes.

import type { AiRunner } from "../src/generation";
import { createOllamaRunner, createOpenAiRunner } from "../src/local-runners";

export const CF_GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const CF_EMBED_MODEL = "@cf/baai/bge-m3";

export interface ParsedArgs {
  flags: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, ...rest] = arg.slice(2).split("=");
    flags.set(key!, rest.join("="));
  }
  return { flags, positional };
}

export function numberFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`--${name} must be a number, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

export function cloudflareRunner(accountId: string, token: string): AiRunner {
  return {
    async run(model, inputs) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });
      const body = (await res.json()) as { success: boolean; result?: unknown; errors?: { message: string }[] };
      if (!res.ok || !body.success) {
        const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
        throw new Error(`Workers AI call failed for ${model}: ${detail}`);
      }
      return body.result;
    },
  };
}

export interface Backend {
  ai: AiRunner;
  model: string;
  /** Human-readable "model @ where", for the run header. */
  label: string;
  local: boolean;
  /** Non-default request options in effect, so a run can disclose them. */
  chatOptions: Record<string, unknown>;
}

/** Best-effort thinking-off for OpenAI-compatible servers. Unreliable, and
 *  measured to be so: on Ollama it suppressed thinking for a one-line prompt
 *  but was ignored for dewpt's ten-message few-shot prompt, where qwen3.5:4b
 *  still burned all 4096 tokens on reasoning and returned empty content. Use
 *  `--gen-api=ollama` for a switch that actually holds. Harmless on a
 *  non-reasoning model. */
const NO_THINK: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } };

function chatOptionsFor(flags: Map<string, string>, role: "gen" | "embed"): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (flags.has("no-think")) Object.assign(options, NO_THINK);

  const raw = flags.get(`${role}-body`);
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`--${role}-body must be a JSON object, got: ${raw}`);
      process.exit(1);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`--${role}-body must be a JSON object, got: ${raw}`);
      process.exit(1);
    }
    Object.assign(options, parsed);
  }
  return options;
}

/** Resolve one role (`gen` or `embed`) to a backend. `--<role>-endpoint` selects
 *  an OpenAI-compatible server; without it the role falls back to Workers AI. */
export function resolveBackend(flags: Map<string, string>, role: "gen" | "embed", cfDefaultModel: string): Backend {
  const endpoint = flags.get(`${role}-endpoint`);
  const model = flags.get(`${role}-model`);

  if (endpoint) {
    if (!model) {
      console.error(`--${role}-endpoint requires --${role}-model (local servers have no default)`);
      process.exit(1);
    }

    const api = flags.get(`${role}-api`) || "openai";
    if (api !== "openai" && api !== "ollama") {
      console.error(`--${role}-api must be "openai" or "ollama", got "${api}"`);
      process.exit(1);
    }

    if (api === "ollama") {
      // Native route: the only one that can switch a reasoning model off.
      const think = flags.has("think");
      return {
        ai: createOllamaRunner({ baseUrl: endpoint, think }),
        model,
        label: `${model} @ ${endpoint} (ollama native${think ? ", thinking on" : ", thinking off"})`,
        local: true,
        chatOptions: {},
      };
    }

    const apiKey = flags.get(`${role}-key`) || process.env[`${role.toUpperCase()}_API_KEY`];
    const chatOptions = chatOptionsFor(flags, role);
    return {
      ai: createOpenAiRunner({ baseUrl: endpoint, apiKey, chatOptions }),
      model,
      label: `${model} @ ${endpoint}`,
      local: true,
      chatOptions,
    };
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error(`the ${role} role falls back to Workers AI, which needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN`);
    console.error(`the API token needs the "Workers AI - Read" permission`);
    console.error(`(or point this role at a local server with --${role}-endpoint=… --${role}-model=…)`);
    process.exit(1);
  }
  const chosen = model || cfDefaultModel;
  return {
    ai: cloudflareRunner(accountId, token),
    model: chosen,
    label: `${chosen} @ Workers AI`,
    local: false,
    chatOptions: {},
  };
}
