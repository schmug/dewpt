import { describe, expect, it } from "vitest";

import { generateCandidates } from "../src/generation";
import { createOllamaRunner, createOpenAiRunner } from "../src/local-runners";

type Call = { url: string; init: RequestInit };

/** Records every request and replies with a canned JSON body. */
function stubFetch(reply: unknown, status = 200): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

const chatReply = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });

describe("createOpenAiRunner — chat", () => {
  it("posts messages to /chat/completions and returns an envelope generation.ts understands", async () => {
    const { calls, fetchImpl } = stubFetch(chatReply('["alpha","beta"]'));
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1", fetchImpl });

    const words = await generateCandidates(ai, "qwen3:8b", {
      seed: "urban gardening",
      strangeness: 0.85,
      altitude: 0.3,
      anchors: [],
      exclude: [],
      count: 2,
    });

    expect(words).toEqual(["alpha", "beta"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    const body = bodyOf(calls[0]!);
    expect(body.model).toBe("qwen3:8b");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.temperature).toBeCloseTo(1.11, 2);
    expect(body.max_tokens).toBe(1024);
  });

  it("sends no Authorization header when no key is configured", async () => {
    const { calls, fetchImpl } = stubFetch(chatReply("[]"));
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1", fetchImpl });
    await ai.run("m", { messages: [{ role: "user", content: "hi" }] });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("sends a bearer token when a key is configured", async () => {
    const { calls, fetchImpl } = stubFetch(chatReply("[]"));
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:1234/v1", apiKey: "sk-local", fetchImpl });
    await ai.run("m", { messages: [{ role: "user", content: "hi" }] });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-local");
  });

  it("merges chatOptions into the request body", async () => {
    const { calls, fetchImpl } = stubFetch(chatReply("[]"));
    const ai = createOpenAiRunner({
      baseUrl: "http://x/v1",
      chatOptions: { chat_template_kwargs: { enable_thinking: false } },
      fetchImpl,
    });
    await ai.run("qwen3.5:4b", { messages: [], temperature: 0.9 });
    const body = bodyOf(calls[0]!);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.temperature).toBe(0.9);
  });

  it("lets chatOptions override a generation default like max_tokens", async () => {
    // Reasoning models spend the token budget before emitting any content, so
    // raising the ceiling has to be reachable without editing generation.ts.
    const { calls, fetchImpl } = stubFetch(chatReply("[]"));
    const ai = createOpenAiRunner({ baseUrl: "http://x/v1", chatOptions: { max_tokens: 4096 }, fetchImpl });
    await ai.run("m", { messages: [], max_tokens: 1024 });
    expect(bodyOf(calls[0]!).max_tokens).toBe(4096);
  });

  it("does not leak chatOptions into embedding requests", async () => {
    const { calls, fetchImpl } = stubFetch({ data: [{ index: 0, embedding: [1] }] });
    const ai = createOpenAiRunner({ baseUrl: "http://x/v1", chatOptions: { max_tokens: 4096 }, fetchImpl });
    await ai.run("bge-m3", { text: ["a"] });
    expect(bodyOf(calls[0]!)).toEqual({ model: "bge-m3", input: ["a"] });
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { calls, fetchImpl } = stubFetch(chatReply("[]"));
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1/", fetchImpl });
    await ai.run("m", { messages: [] });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
  });
});

describe("createOpenAiRunner — embeddings", () => {
  it("posts to /embeddings and reshapes OpenAI's envelope into bare vectors", async () => {
    const { calls, fetchImpl } = stubFetch({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
    });
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1", fetchImpl });

    const result = (await ai.run("bge-m3", { text: ["a", "b"] })) as { data: number[][] };

    expect(result.data).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
    expect(bodyOf(calls[0]!)).toEqual({ model: "bge-m3", input: ["a", "b"] });
  });

  it("restores order when the server returns embeddings out of index order", async () => {
    // The OpenAI spec does not promise ordering; pairing by position would
    // silently mis-assign every vector to the wrong word.
    const { fetchImpl } = stubFetch({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const ai = createOpenAiRunner({ baseUrl: "http://x/v1", fetchImpl });
    const result = (await ai.run("bge-m3", { text: ["a", "b"] })) as { data: number[][] };
    expect(result.data).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("throws when the server returns the wrong number of vectors", async () => {
    const { fetchImpl } = stubFetch({ data: [{ index: 0, embedding: [1, 0] }] });
    const ai = createOpenAiRunner({ baseUrl: "http://x/v1", fetchImpl });
    await expect(ai.run("bge-m3", { text: ["a", "b"] })).rejects.toThrow(/1 embedding.*2 text/i);
  });
});

describe("createOllamaRunner", () => {
  // Ollama's OpenAI-compatible route cannot switch a reasoning model's thinking
  // off — measured against qwen3.5:4b, `chat_template_kwargs.enable_thinking`
  // was ignored and 4096 tokens went to hidden reasoning with empty content.
  // The native route's top-level `think` flag does work, which is the whole
  // reason this second transport exists.
  it("posts to /api/chat with thinking off and maps max_tokens onto num_predict", async () => {
    const { calls, fetchImpl } = stubFetch({ message: { content: '["a"]' }, done_reason: "stop" });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", fetchImpl });

    await ai.run("qwen3.5:4b", { messages: [{ role: "user", content: "hi" }], temperature: 1.1, max_tokens: 1024 });

    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(bodyOf(calls[0]!)).toEqual({
      model: "qwen3.5:4b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      think: false,
      options: { temperature: 1.1, num_predict: 1024 },
    });
  });

  it("returns chat content in an envelope generation.ts can read", async () => {
    const { fetchImpl } = stubFetch({ message: { content: '["alpha","beta"]', thinking: "" } });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", fetchImpl });
    const words = await generateCandidates(ai, "qwen3.5:4b", {
      seed: "s", strangeness: 0.5, altitude: 0.3, anchors: [], exclude: [], count: 2,
    });
    expect(words).toEqual(["alpha", "beta"]);
  });

  it("keeps thinking on when asked", async () => {
    const { calls, fetchImpl } = stubFetch({ message: { content: "[]" } });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", think: true, fetchImpl });
    await ai.run("m", { messages: [] });
    expect(bodyOf(calls[0]!).think).toBe(true);
  });

  it("posts embeddings to /api/embed and unwraps them", async () => {
    const { calls, fetchImpl } = stubFetch({ embeddings: [[1, 0], [0, 1]] });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", fetchImpl });
    const result = (await ai.run("bge-m3", { text: ["a", "b"] })) as { data: number[][] };
    expect(result.data).toEqual([[1, 0], [0, 1]]);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/embed");
    expect(bodyOf(calls[0]!)).toEqual({ model: "bge-m3", input: ["a", "b"] });
  });

  it("throws when the embedding count does not match the input", async () => {
    const { fetchImpl } = stubFetch({ embeddings: [[1, 0]] });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", fetchImpl });
    await expect(ai.run("bge-m3", { text: ["a", "b"] })).rejects.toThrow(/1 embedding.*2 text/i);
  });

  it("reports a model that answered with nothing but hidden reasoning", async () => {
    // The exact failure this transport exists to avoid — surface it rather than
    // returning an empty string that reads downstream as "the model had no ideas".
    const { fetchImpl } = stubFetch({ message: { content: "", thinking: "hmm ".repeat(500) }, done_reason: "length" });
    const ai = createOllamaRunner({ baseUrl: "http://localhost:11434", fetchImpl });
    await expect(ai.run("m", { messages: [] })).rejects.toThrow(/reasoning|thinking/i);
  });
});

describe("createOpenAiRunner — failures", () => {
  it("surfaces the server's error message on a non-2xx response", async () => {
    const { fetchImpl } = stubFetch({ error: { message: "model 'nope' not found" } }, 404);
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1", fetchImpl });
    await expect(ai.run("nope", { messages: [] })).rejects.toThrow(/404.*model 'nope' not found/);
  });

  it("still throws usefully when the error body is not JSON", async () => {
    const fetchImpl = (async () =>
      new Response("upstream connect error", { status: 502 })) as unknown as typeof fetch;
    const ai = createOpenAiRunner({ baseUrl: "http://x/v1", fetchImpl });
    await expect(ai.run("m", { messages: [] })).rejects.toThrow(/502/);
  });

  it("names the endpoint when the connection is refused, not just ECONNREFUSED", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const ai = createOpenAiRunner({ baseUrl: "http://localhost:11434/v1", fetchImpl });
    await expect(ai.run("m", { messages: [] })).rejects.toThrow(/localhost:11434/);
  });
});
