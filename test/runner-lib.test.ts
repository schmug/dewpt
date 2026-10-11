// parseArgs + resolveBackend are CLI parsing for the measurement scripts, which
// makes every silent misparse a correctness bug rather than an ergonomics one:
// a dropped --gen-model does not fail, it attributes real numbers to a model
// that never ran. These cases were ported from the deleted eval-runner parser
// (#65), which had probed them; resolveBackend had not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CF_GEN_MODEL, cloudflareRunner, parseArgs, resolveBackend } from "../scripts/runner-lib";

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GEN_API_KEY"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
type EnvPatch = Partial<Record<EnvKey, string>>;

const CF_CREDS: EnvPatch = { CLOUDFLARE_ACCOUNT_ID: "acct123", CLOUDFLARE_API_TOKEN: "tok456" };

let savedEnv: EnvPatch = {};
let errors: string[] = [];

class Exit extends Error {}

function setEnv(patch: EnvPatch): void {
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
}

/** Stub global fetch and record what the resolved runner actually sent. */
function captureFetch(body: unknown) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const resolveGen = (argv: string[]) => resolveBackend(parseArgs(argv).flags, "gen", CF_GEN_MODEL);

/** resolveBackend reports a bad argument on stderr and exits; surface both. */
function refusal(argv: string[]): string {
  expect(() => resolveGen(argv)).toThrow(Exit);
  return errors.join("\n");
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(`exit ${code}`);
  }) as typeof process.exit);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseArgs", () => {
  it("keeps everything after the first '=' as the value", () => {
    // Query strings and JSON both carry "=" inside the value.
    const { flags } = parseArgs(["--gen-endpoint=http://h/v1?a=b&c=d", '--gen-body={"k":"a=b"}']);
    expect(flags.get("gen-endpoint")).toBe("http://h/v1?a=b&c=d");
    expect(flags.get("gen-body")).toBe('{"k":"a=b"}');
  });

  it("takes the last value when a flag repeats", () => {
    // Wrapper scripts append overrides after a base argv; first-wins drops them.
    expect(parseArgs(["--gen-model=first", "--gen-model=second"]).flags.get("gen-model")).toBe("second");
  });

  it("leaves positional arguments (seeds) alone", () => {
    expect(parseArgs(["a seed phrase", "--gen-model=m"]).positional).toEqual(["a seed phrase"]);
  });

  it("keys on own entries only, so prototype-named flags are inert", () => {
    // An object-literal table here would answer `constructor`, `toString` and
    // friends from Object.prototype. A Map has no prototype chain for keys.
    const { flags } = parseArgs(["--toString=zzz", "--__proto__=zzz"]);
    expect(flags.get("toString")).toBe("zzz");
    expect(flags.get("valueOf")).toBeUndefined();
    expect(flags.get("constructor")).toBeUndefined();
  });
});

describe("resolveBackend: what it resolves to", () => {
  it("falls back to Workers AI on the default model with no flags", () => {
    setEnv(CF_CREDS);
    const backend = resolveGen([]);
    expect(backend).toMatchObject({ model: CF_GEN_MODEL, local: false, label: `${CF_GEN_MODEL} @ Workers AI` });
  });

  it("takes a Workers AI model override", () => {
    setEnv(CF_CREDS);
    expect(resolveGen(["--gen-model=@cf/x"]).model).toBe("@cf/x");
  });

  it("selects an OpenAI-compatible endpoint with --gen-endpoint and --gen-model", () => {
    const backend = resolveGen(["--gen-endpoint=http://localhost:11434/v1", "--gen-model=qwen3.5:4b"]);
    expect(backend).toMatchObject({ model: "qwen3.5:4b", local: true, label: "qwen3.5:4b @ http://localhost:11434/v1" });
  });

  it("selects Ollama's native route with --gen-api=ollama", () => {
    const backend = resolveGen(["--gen-endpoint=http://localhost:11434", "--gen-model=m", "--gen-api=ollama"]);
    expect(backend.label).toMatch(/ollama native, thinking off/);
  });

  it("resolves each role independently", () => {
    setEnv(CF_CREDS);
    const flags = parseArgs(["--gen-endpoint=http://h/v1", "--gen-model=m"]).flags;
    expect(resolveBackend(flags, "gen", CF_GEN_MODEL).local).toBe(true);
    expect(resolveBackend(flags, "embed", "@cf/baai/bge-m3").local).toBe(false);
  });

  it("ignores prototype-named flags rather than reading them as configuration", () => {
    setEnv(CF_CREDS);
    expect(resolveGen(["--constructor=zzz", "--__proto__=zzz"]).local).toBe(false);
  });
});

describe("resolveBackend: what it refuses", () => {
  // Each of these used to fall through `||` to a default — the run went ahead
  // against a model or backend nobody asked for.
  const blank: { name: string; argv: string[]; flag: string }[] = [
    { name: "an empty --gen-endpoint=", argv: ["--gen-endpoint=", "--gen-model=m"], flag: "--gen-endpoint" },
    { name: "a spaces-only --gen-endpoint=", argv: ["--gen-endpoint=   ", "--gen-model=m"], flag: "--gen-endpoint" },
    { name: "a space-separated --gen-endpoint", argv: ["--gen-endpoint", "http://h/v1", "--gen-model=m"], flag: "--gen-endpoint" },
    { name: "an empty --gen-model= with an endpoint", argv: ["--gen-endpoint=http://h/v1", "--gen-model="], flag: "--gen-model" },
    { name: "a tab-only --gen-model=", argv: ["--gen-endpoint=http://h/v1", "--gen-model=\t"], flag: "--gen-model" },
    { name: "a space-separated --gen-model", argv: ["--gen-endpoint=http://h/v1", "--gen-model", "qwen"], flag: "--gen-model" },
    { name: "an empty --gen-model= on Workers AI", argv: ["--gen-model="], flag: "--gen-model" },
    { name: "an empty --gen-api=", argv: ["--gen-endpoint=http://h/v1", "--gen-model=m", "--gen-api="], flag: "--gen-api" },
    { name: "an empty --gen-key=", argv: ["--gen-endpoint=http://h/v1", "--gen-model=m", "--gen-key="], flag: "--gen-key" },
    { name: "an empty --gen-body=", argv: ["--gen-endpoint=http://h/v1", "--gen-model=m", "--gen-body="], flag: "--gen-body" },
  ];
  for (const { name, argv, flag } of blank) {
    it(`rejects ${name}, naming the flag`, () => {
      setEnv(CF_CREDS);
      expect(refusal(argv)).toContain(`${flag} needs a value`);
    });
  }

  const bodies = ["notjson", "[1,2]", "5", "null", '"str"'];
  for (const body of bodies) {
    it(`rejects --gen-body=${body}, which is not a JSON object`, () => {
      expect(refusal(["--gen-endpoint=http://h/v1", "--gen-model=m", `--gen-body=${body}`])).toMatch(/must be a JSON object/);
    });
  }

  it("rejects an endpoint without a model", () => {
    expect(refusal(["--gen-endpoint=http://h/v1"])).toMatch(/requires --gen-model/);
  });

  it("rejects an unknown --gen-api", () => {
    expect(refusal(["--gen-endpoint=http://h/v1", "--gen-model=m", "--gen-api=grpc"])).toMatch(/"openai" or "ollama"/);
  });

  it("rejects Workers AI with no credentials", () => {
    expect(refusal([])).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("rejects a whitespace-only account id", () => {
    setEnv({ CLOUDFLARE_ACCOUNT_ID: "  ", CLOUDFLARE_API_TOKEN: "tok" });
    expect(refusal([])).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("rejects a whitespace-only token", () => {
    setEnv({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "   " });
    expect(refusal([])).toMatch(/CLOUDFLARE_API_TOKEN/);
  });
});

describe("resolveBackend: the runner it hands back", () => {
  it("posts to the last --gen-endpoint= when it is repeated", async () => {
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveGen(["--gen-endpoint=http://first/v1", "--gen-endpoint=http://second/v1", "--gen-model=m"]).ai.run("m", {
      messages: [],
    });
    expect(calls[0]!.url).toBe("http://second/v1/chat/completions");
  });

  it("merges --gen-body= into chat bodies, '=' and all", async () => {
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    const backend = resolveGen(["--gen-endpoint=http://h/v1", "--gen-model=m", '--gen-body={"reasoning_effort":"none","k":"a=b"}']);
    await backend.ai.run("m", { messages: [] });
    expect(calls[0]!.body).toMatchObject({ reasoning_effort: "none", k: "a=b" });
    expect(backend.chatOptions).toEqual({ reasoning_effort: "none", k: "a=b" });
  });

  it("sends --gen-key= as a bearer token, ahead of GEN_API_KEY", async () => {
    setEnv({ GEN_API_KEY: "from-env" });
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveGen(["--gen-endpoint=http://h/v1", "--gen-model=m", "--gen-key=from-flag"]).ai.run("m", { messages: [] });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer from-flag");
  });

  it("trims padded credentials out of the Workers AI URL and header", async () => {
    setEnv({ CLOUDFLARE_ACCOUNT_ID: "  acct123  ", CLOUDFLARE_API_TOKEN: "  tok456  " });
    const calls = captureFetch({ success: true, result: { response: "[]" } });
    await resolveGen([]).ai.run("@cf/m", { messages: [] });
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/m");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok456");
  });
});

describe("cloudflareRunner", () => {
  it("posts to the Workers AI account endpoint and unwraps result", async () => {
    const calls = captureFetch({ success: true, result: { response: '["a"]' } });

    const out = await cloudflareRunner("acct123", "tok456").run("@cf/meta/llama", { messages: [] });

    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/meta/llama");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok456");
    expect(out).toEqual({ response: '["a"]' });
  });

  it("throws with the provider message when success is false", async () => {
    captureFetch({ success: false, errors: [{ message: "no such model" }] });

    await expect(cloudflareRunner("a", "t").run("@cf/nope", { messages: [] })).rejects.toThrow(/no such model/);
  });
});
