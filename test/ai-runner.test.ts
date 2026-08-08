import { afterEach, describe, expect, it, vi } from "vitest";
import { aiMode, localAiRunner, selectAiRunner } from "../src/ai-runner";
import { embedTexts, generateCandidates, type AiRunner } from "../src/generation";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Stub global fetch and record what the runner sent. */
function captureFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return reply(url, init);
  });
  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

function genInputs() {
  return { seed: "urban gardening", strangeness: 0.5, altitude: 0.2, anchors: [], exclude: [], count: 2 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localAiRunner", () => {
  it("sends chat inputs to /chat/completions in a body generateCandidates can parse", async () => {
    const { calls } = captureFetch(() =>
      jsonResponse({ choices: [{ message: { content: '["rooftop bee lease", "alley orchard map"]' } }] }),
    );
    const runner = localAiRunner({ baseUrl: "http://localhost:11434/v1" });

    const words = await generateCandidates(runner, "qwen3:8b", genInputs(), 0.9);

    expect(words).toEqual(["rooftop bee lease", "alley orchard map"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.body.model).toBe("qwen3:8b");
    expect(calls[0]!.body.temperature).toBe(0.9);
    expect(calls[0]!.body.max_tokens).toBe(1024);
    expect(Array.isArray(calls[0]!.body.messages)).toBe(true);
  });

  it("reshapes the OpenAI embedding envelope into the rows embedTexts expects", async () => {
    // The spec does not promise ordered `data`, and a row/text misalignment
    // would silently attach the wrong vector to every candidate.
    const { calls } = captureFetch(() =>
      jsonResponse({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      }),
    );
    const runner = localAiRunner({ baseUrl: "http://localhost:11434/v1" });

    const vectors = await embedTexts(runner, "bge-m3", ["first", "second"]);

    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
    expect(calls[0]!.body.input).toEqual(["first", "second"]);
    expect(calls[0]!.body.model).toBe("bge-m3");
  });

  it("throws with the status and endpoint when the server rejects the request", async () => {
    captureFetch(() => jsonResponse({ error: "model not found" }, 404));
    const runner = localAiRunner({ baseUrl: "http://localhost:11434/v1" });

    await expect(runner.run("missing-model", { text: ["probe"] })).rejects.toThrow(/404/);
  });

  it("sends a bearer token only when a key is configured", async () => {
    const keyed = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
    await localAiRunner({ baseUrl: "http://localhost:1234/v1", apiKey: "sk-local" }).run("m", { text: ["a"] });
    expect(new Headers(keyed.calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-local");

    vi.unstubAllGlobals();
    const bare = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
    await localAiRunner({ baseUrl: "http://localhost:1234/v1" }).run("m", { text: ["a"] });
    expect(new Headers(bare.calls[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("merges chatOptions into chat bodies, letting them override the defaults", async () => {
    // Thinking models spend the whole max_tokens budget on `message.reasoning`
    // and return an empty `content`, which parses to zero candidates and an
    // empty field. Ollama's OpenAI layer honours reasoning_effort:"none" —
    // measured against qwen3.5:4b — but that is not a param generation.ts
    // should know about, so it arrives as config.
    const { calls } = captureFetch(() => jsonResponse({ choices: [{ message: { content: "[]" } }] }));
    const runner = localAiRunner({
      baseUrl: "http://localhost:11434/v1",
      chatOptions: { reasoning_effort: "none", max_tokens: 4096 },
    });

    await runner.run("qwen3.5:4b", { messages: [], temperature: 0.9, max_tokens: 1024 });

    expect(calls[0]!.body.reasoning_effort).toBe("none");
    expect(calls[0]!.body.max_tokens).toBe(4096);
    expect(calls[0]!.body.temperature).toBe(0.9);
  });

  it("keeps chatOptions off embedding requests", async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

    await localAiRunner({
      baseUrl: "http://localhost:11434/v1",
      chatOptions: { reasoning_effort: "none" },
    }).run("bge-m3", { text: ["a"] });

    expect(calls[0]!.body).toEqual({ model: "bge-m3", input: ["a"] });
  });

  it("sends embeddings to embedBaseUrl while chat stays on baseUrl", async () => {
    // mlx_lm.server (which is how Maple runs) serves /v1/chat/completions and
    // /v1/completions — there is no /v1/embeddings. Generation and embedding
    // therefore have to be able to live on different hosts.
    const { calls } = captureFetch((url) =>
      url.endsWith("/embeddings")
        ? jsonResponse({ data: [{ index: 0, embedding: [1] }] })
        : jsonResponse({ choices: [{ message: { content: "[]" } }] }),
    );
    const runner = localAiRunner({
      baseUrl: "http://localhost:8080/v1",
      embedBaseUrl: "http://localhost:11434/v1",
    });

    await runner.run("maple", { messages: [] });
    await runner.run("bge-m3", { text: ["a"] });

    expect(calls[0]!.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(calls[1]!.url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("keeps embeddings on baseUrl when no embedBaseUrl is given", async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

    await localAiRunner({ baseUrl: "http://localhost:11434/v1" }).run("bge-m3", { text: ["a"] });

    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

    await localAiRunner({ baseUrl: "http://localhost:11434/v1/" }).run("m", { text: ["a"] });

    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
  });
});

describe("aiMode", () => {
  // /api/debug/ai reports this. CLAUDE.md sends you to that probe before
  // debugging app code, so it has to name the backend that actually answered —
  // a probe that says "ok" for Workers AI while the DO is generating against
  // Ollama is worse than no probe.
  it("names the backend selectAiRunner would pick", () => {
    expect(aiMode({ AI: {} })).toBe("workers-ai");
    expect(aiMode({ AI: {}, LOCAL_AI_BASE_URL: "http://localhost:11434/v1" })).toBe("local");
    expect(aiMode({ AI: {}, LOCAL_AI_BASE_URL: "http://localhost:11434/v1", DEV_FAKE_AI: "1" })).toBe("fake");
  });

  it("ignores a blank LOCAL_AI_BASE_URL rather than reporting a local backend", () => {
    expect(aiMode({ AI: {}, LOCAL_AI_BASE_URL: "   " })).toBe("workers-ai");
  });
});

describe("selectAiRunner", () => {
  function bindingSpy() {
    const run = vi.fn(async () => ({ data: [[0.5]] }));
    return { run, binding: { run } as unknown as { run: AiRunner["run"] } };
  }

  it("routes through the local endpoint when LOCAL_AI_BASE_URL is set", async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [0.1] }] }));
    const { run, binding } = bindingSpy();

    const runner = selectAiRunner({ AI: binding, LOCAL_AI_BASE_URL: "http://localhost:11434/v1" });
    await runner.run("bge-m3", { text: ["a"] });

    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the Workers AI binding when no local endpoint is configured", async () => {
    const { impl } = captureFetch(() => jsonResponse({}));
    const { run, binding } = bindingSpy();

    const result = await selectAiRunner({ AI: binding }).run("@cf/baai/bge-m3", { text: ["a"] });

    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["a"] });
    expect(result).toEqual({ data: [[0.5]] });
    expect(impl).not.toHaveBeenCalled();
  });

  it("passes LOCAL_AI_CHAT_OPTIONS through to chat requests", async () => {
    const { calls } = captureFetch(() => jsonResponse({ choices: [{ message: { content: "[]" } }] }));

    await selectAiRunner({
      AI: bindingSpy().binding,
      LOCAL_AI_BASE_URL: "http://localhost:11434/v1",
      LOCAL_AI_CHAT_OPTIONS: '{"reasoning_effort":"none"}',
    }).run("qwen3.5:4b", { messages: [] });

    expect(calls[0]!.body.reasoning_effort).toBe("none");
  });

  it("splits chat and embedding hosts via LOCAL_AI_EMBED_BASE_URL", async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));

    await selectAiRunner({
      AI: bindingSpy().binding,
      LOCAL_AI_BASE_URL: "http://localhost:8080/v1",
      LOCAL_AI_EMBED_BASE_URL: "http://localhost:11434/v1/",
    }).run("bge-m3", { text: ["a"] });

    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("fails loudly on malformed LOCAL_AI_CHAT_OPTIONS instead of dropping it", () => {
    // Silently ignoring it would present as "thinking model still returns
    // nothing", which is the exact symptom the option exists to fix.
    expect(() =>
      selectAiRunner({
        AI: bindingSpy().binding,
        LOCAL_AI_BASE_URL: "http://localhost:11434/v1",
        LOCAL_AI_CHAT_OPTIONS: "reasoning_effort=none",
      }),
    ).toThrow(/LOCAL_AI_CHAT_OPTIONS/);
  });

  it("prefers the offline fake over a configured local endpoint when DEV_FAKE_AI=1", async () => {
    // DEV_FAKE_AI is the last-resort no-egress escape hatch; if it did not win,
    // a stale LOCAL_AI_BASE_URL in .dev.vars would keep the dev server trying
    // to reach a host it cannot open a socket to.
    const { impl } = captureFetch(() => jsonResponse({}));
    const { run, binding } = bindingSpy();

    const result = (await selectAiRunner({
      AI: binding,
      DEV_FAKE_AI: "1",
      LOCAL_AI_BASE_URL: "http://localhost:11434/v1",
    }).run("m", { text: ["a"] })) as { data: number[][] };

    expect(result.data).toHaveLength(1);
    expect(impl).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
