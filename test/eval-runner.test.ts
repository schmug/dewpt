// resolveEvalRunner is CLI argument parsing for an eval harness, which makes
// every silent misparse a correctness bug rather than an ergonomics one: a
// dropped --model does not fail, it attributes real numbers to a model that
// never ran. So the bar here is that anything the parser cannot honour throws
// by name, and nothing is quietly ignored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEvalRunner } from "../scripts/eval-runner";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "LOCAL_AI_BASE_URL",
  "LOCAL_AI_CHAT_OPTIONS",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
type EnvPatch = Partial<Record<EnvKey, string>>;

let savedEnv: Partial<Record<EnvKey, string>> = {};

function setEnv(patch: EnvPatch): void {
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
}

/** Stub global fetch and record what the resolved runner actually sent. */
function captureFetch(body: unknown = { data: [{ index: 0, embedding: [1] }] }) {
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

const CF_CREDS: EnvPatch = { CLOUDFLARE_ACCOUNT_ID: "acct123", CLOUDFLARE_API_TOKEN: "tok456" };

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

describe("resolveEvalRunner: what it resolves to", () => {
  const cases: { name: string; argv: string[]; env?: EnvPatch; want: { backend: string; genModel: string; embedModel: string } }[] = [
    {
      name: "no flags is the local backend on the Ollama defaults",
      argv: [],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "bge-m3" },
    },
    {
      name: "--model= overrides the local generation model",
      argv: ["--model=gpt-x"],
      want: { backend: "local", genModel: "gpt-x", embedModel: "bge-m3" },
    },
    {
      name: "--embed-model= overrides the local embedding model",
      argv: ["--embed-model=e5-small"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "e5-small" },
    },
    {
      name: "--workers-ai selects the REST backend on the @cf defaults",
      argv: ["--workers-ai"],
      env: CF_CREDS,
      want: { backend: "workers-ai", genModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", embedModel: "@cf/baai/bge-m3" },
    },
    {
      name: "--workers-ai takes model overrides too",
      argv: ["--workers-ai", "--model=@cf/x", "--embed-model=@cf/y"],
      env: CF_CREDS,
      want: { backend: "workers-ai", genModel: "@cf/x", embedModel: "@cf/y" },
    },
    // Defect 4: `argv.includes("--workers-ai")` is exact-match, so the two
    // spellings every other CLI accepts silently ran the LOCAL backend and
    // labelled the numbers "workers-ai".
    {
      name: "--workers-ai=true selects the REST backend",
      argv: ["--workers-ai=true"],
      env: CF_CREDS,
      want: { backend: "workers-ai", genModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", embedModel: "@cf/baai/bge-m3" },
    },
    {
      name: "--workers-ai=1 selects the REST backend",
      argv: ["--workers-ai=1"],
      env: CF_CREDS,
      want: { backend: "workers-ai", genModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", embedModel: "@cf/baai/bge-m3" },
    },
    {
      name: "--workers-ai=false stays local",
      argv: ["--workers-ai=false"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "bge-m3" },
    },
    {
      name: "--workers-ai=0 stays local",
      argv: ["--workers-ai=0"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "bge-m3" },
    },
    // Last-wins: wrapper scripts append overrides after the base argv, and
    // first-wins drops them without a word.
    {
      name: "a repeated --model= takes the last value, not the first",
      argv: ["--model=first", "--model=second"],
      want: { backend: "local", genModel: "second", embedModel: "bge-m3" },
    },
    {
      name: "a repeated --embed-model= takes the last value",
      argv: ["--embed-model=first", "--embed-model=second"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "second" },
    },
    // Load-bearing and easy to "simplify" into a real bug: the search prefix
    // includes the trailing "=", which is the only reason the sibling script's
    // --models= does not satisfy flag(argv, "model").
    {
      name: "--models= (plural, the sibling script's flag) does not satisfy --model",
      argv: ["--models=a,b"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "bge-m3" },
    },
    {
      name: "the sibling script's flags are accepted, not rejected as unknown",
      argv: ["--models=a,b", "--record", "--judge=qwen3.5:4b"],
      want: { backend: "local", genModel: "qwen3.5:4b", embedModel: "bge-m3" },
    },
    {
      name: "positional arguments (seeds) are left alone",
      argv: ["a seed phrase", "--model=m"],
      want: { backend: "local", genModel: "m", embedModel: "bge-m3" },
    },
  ];

  for (const { name, argv, env, want } of cases) {
    it(name, () => {
      if (env) setEnv(env);
      const resolved = resolveEvalRunner(argv);
      expect(resolved.backend).toBe(want.backend);
      expect(resolved.genModel).toBe(want.genModel);
      expect(resolved.embedModel).toBe(want.embedModel);
    });
  }
});

describe("resolveEvalRunner: what it refuses", () => {
  const cases: { name: string; argv: string[]; env?: EnvPatch; message: RegExp }[] = [
    // Defect 1: --chat-options went through a bare JSON.parse while the Worker
    // read the same value through parseChatOptions. Dropping or mangling it
    // presents as "the thinking model still returns nothing", which is the
    // exact symptom the option exists to fix.
    { name: "--chat-options= that is not JSON at all", argv: ["--chat-options=notjson"], message: /must be a JSON object/ },
    { name: "LOCAL_AI_CHAT_OPTIONS that is not JSON at all", argv: [], env: { LOCAL_AI_CHAT_OPTIONS: "notjson" }, message: /must be a JSON object/ },
    { name: "--chat-options= holding a JSON array", argv: ["--chat-options=[1,2]"], message: /must be a JSON object/ },
    { name: "--chat-options= holding a JSON number", argv: ["--chat-options=5"], message: /must be a JSON object/ },
    { name: "--chat-options= holding JSON null", argv: ["--chat-options=null"], message: /must be a JSON object/ },
    { name: "--chat-options= holding a JSON string", argv: ['--chat-options="str"'], message: /must be a JSON object/ },

    // Defect 2: `??` only falls back on nullish, and flag() returned "" — so an
    // empty value beat both the default and the env fallback.
    { name: "--base-url= with an empty value", argv: ["--base-url="], message: /--base-url/ },
    {
      name: "--base-url= with an empty value even when LOCAL_AI_BASE_URL is set",
      argv: ["--base-url="],
      env: { LOCAL_AI_BASE_URL: "http://configured/v1" },
      message: /--base-url/,
    },
    { name: "--model= with an empty value", argv: ["--model="], message: /--model/ },
    { name: "--embed-model= with an empty value", argv: ["--embed-model="], message: /--embed-model/ },
    { name: "--chat-options= with an empty value", argv: ["--chat-options="], message: /--chat-options/ },
    { name: "--workers-ai= with an empty value", argv: ["--workers-ai="], env: CF_CREDS, message: /--workers-ai/ },

    // Defect 3: space-separated values were silently ignored, so the run was
    // attributed to a model that never ran. The worst failure mode here.
    { name: "space-separated --base-url", argv: ["--base-url", "http://h/v1"], message: /--base-url=/ },
    { name: "space-separated --model", argv: ["--model", "gpt-x"], message: /--model=/ },
    { name: "space-separated --embed-model", argv: ["--embed-model", "bge-m3"], message: /--embed-model=/ },
    { name: "space-separated --chat-options", argv: ["--chat-options", "{}"], message: /--chat-options=/ },
    { name: "space-separated --models (sibling flag)", argv: ["--models", "a,b"], message: /--models=/ },
    { name: "space-separated --judge (sibling flag)", argv: ["--judge", "m"], message: /--judge=/ },

    // Defect 4: an unrecognised flag was accepted silently, so a typo in the
    // backend switch quietly ran the wrong backend.
    { name: "a typo'd --workers-ai", argv: ["--wrokers-ai"], message: /unknown flag: --wrokers-ai/ },
    { name: "a typo'd --model", argv: ["--modle=typo"], message: /unknown flag: --modle/ },
    { name: "--workers-ai= with a value that is neither true nor false", argv: ["--workers-ai=yes"], env: CF_CREDS, message: /--workers-ai/ },
    { name: "--record= given a value it does not take", argv: ["--record=true"], message: /--record/ },

    // Defect 6: the allowlist was an object literal, so the lookup reached
    // Object.prototype and every name inherited from it was accepted and then
    // silently ignored — the misparse this whole parser exists to prevent.
    // Note the guard has to be membership, not value: the inherited value is a
    // function (or, for --__proto__, an object), so a `=== undefined` check
    // would not fire either.
    { name: "--constructor=, inherited from Object.prototype", argv: ["--constructor=zzz"], message: /unknown flag: --constructor/ },
    { name: "--toString=, inherited from Object.prototype", argv: ["--toString=zzz"], message: /unknown flag: --toString/ },
    { name: "--valueOf=, inherited from Object.prototype", argv: ["--valueOf=zzz"], message: /unknown flag: --valueOf/ },
    { name: "--__proto__=, inherited from Object.prototype", argv: ["--__proto__=zzz"], message: /unknown flag: --__proto__/ },
    { name: "--hasOwnProperty=, inherited from Object.prototype", argv: ["--hasOwnProperty=zzz"], message: /unknown flag: --hasOwnProperty/ },
    { name: "--isPrototypeOf=, inherited from Object.prototype", argv: ["--isPrototypeOf=zzz"], message: /unknown flag: --isPrototypeOf/ },
    // Bare, so it lands in the other branch of assertFlagSyntax: an inherited
    // name is not "value", so it fell through the space-separated check too.
    { name: "a bare --toString, inherited from Object.prototype", argv: ["--toString"], message: /unknown flag: --toString/ },

    // Defect 7: --x= was rejected but --x="   " was not, so a whitespace-only
    // value beat both the default and the env fallback exactly as the empty one
    // used to. --base-url="   " posted to "   /embeddings"; --model="   "
    // resolved to a genModel no server has. Same rule the CLOUDFLARE_* trim
    // already applied: a whitespace-only value is unset.
    { name: "--base-url= with a spaces-only value", argv: ["--base-url=   "], message: /--base-url= was given an empty value/ },
    { name: "--base-url= with a tab-only value", argv: ["--base-url=\t"], message: /--base-url= was given an empty value/ },
    {
      name: "--base-url= with a spaces-only value even when LOCAL_AI_BASE_URL is set",
      argv: ["--base-url=   "],
      env: { LOCAL_AI_BASE_URL: "http://configured/v1" },
      message: /--base-url= was given an empty value/,
    },
    { name: "--model= with a spaces-only value", argv: ["--model=   "], message: /--model= was given an empty value/ },
    { name: "--model= with a tab-only value", argv: ["--model=\t"], message: /--model= was given an empty value/ },
    { name: "--embed-model= with a spaces-only value", argv: ["--embed-model=   "], message: /--embed-model= was given an empty value/ },
    { name: "--embed-model= with a tab-only value", argv: ["--embed-model=\t"], message: /--embed-model= was given an empty value/ },

    // Defect 5: whitespace-only credentials passed the guard and built
    // https://api.cloudflare.com/client/v4/accounts/  /ai/run/…
    { name: "--workers-ai with a whitespace-only account id", argv: ["--workers-ai"], env: { CLOUDFLARE_ACCOUNT_ID: "  ", CLOUDFLARE_API_TOKEN: "tok" }, message: /CLOUDFLARE_ACCOUNT_ID/ },
    { name: "--workers-ai with a whitespace-only token", argv: ["--workers-ai"], env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "   " }, message: /CLOUDFLARE_API_TOKEN/ },
    { name: "--workers-ai with no credentials at all", argv: ["--workers-ai"], message: /CLOUDFLARE_ACCOUNT_ID/ },
  ];

  for (const { name, argv, env, message } of cases) {
    it(`rejects ${name}`, () => {
      if (env) setEnv(env);
      expect(() => resolveEvalRunner(argv)).toThrow(message);
    });
  }

  it("names the flags it does accept when it rejects an unknown one", () => {
    expect(() => resolveEvalRunner(["--nope"])).toThrow(/--workers-ai/);
    expect(() => resolveEvalRunner(["--nope"])).toThrow(/--chat-options/);
    expect(() => resolveEvalRunner(["--nope"])).toThrow(/--embed-model/);
  });
});

describe("resolveEvalRunner: the runner it hands back", () => {
  it("posts local requests to the Ollama default when nothing configures a base URL", async () => {
    const calls = captureFetch();
    await resolveEvalRunner([]).runner.run("bge-m3", { text: ["a"] });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("uses LOCAL_AI_BASE_URL when no --base-url is given", async () => {
    setEnv({ LOCAL_AI_BASE_URL: "http://configured:8080/v1" });
    const calls = captureFetch();
    await resolveEvalRunner([]).runner.run("bge-m3", { text: ["a"] });
    expect(calls[0]!.url).toBe("http://configured:8080/v1/embeddings");
  });

  it("lets --base-url= win over LOCAL_AI_BASE_URL", async () => {
    setEnv({ LOCAL_AI_BASE_URL: "http://configured:8080/v1" });
    const calls = captureFetch();
    await resolveEvalRunner(["--base-url=http://flag:9090/v1"]).runner.run("bge-m3", { text: ["a"] });
    expect(calls[0]!.url).toBe("http://flag:9090/v1/embeddings");
  });

  it("takes the last --base-url= when it is repeated", async () => {
    const calls = captureFetch();
    await resolveEvalRunner(["--base-url=http://first/v1", "--base-url=http://second/v1"]).runner.run("m", { text: ["a"] });
    expect(calls[0]!.url).toBe("http://second/v1/embeddings");
  });

  it("round-trips a --base-url= value containing '=' rather than truncating at the first one", async () => {
    // The reason flag() slices instead of splitting. Query strings and JSON
    // both carry "=" inside the value.
    const calls = captureFetch();
    await resolveEvalRunner(["--base-url=http://h/v1?a=b&c=d"]).runner.run("m", { text: ["a"] });
    expect(calls[0]!.url).toBe("http://h/v1?a=b&c=d/embeddings");
  });

  it("merges a valid --chat-options= into chat bodies", async () => {
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveEvalRunner(['--chat-options={"reasoning_effort":"none"}']).runner.run("qwen3.5:4b", { messages: [] });
    expect(calls[0]!.body.reasoning_effort).toBe("none");
  });

  it("round-trips a --chat-options= value containing '='", async () => {
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveEvalRunner(['--chat-options={"k":"a=b"}']).runner.run("qwen3.5:4b", { messages: [] });
    expect(calls[0]!.body.k).toBe("a=b");
  });

  it("takes the last --chat-options= when it is repeated", async () => {
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveEvalRunner(['--chat-options={"a":1}', '--chat-options={"b":2}']).runner.run("m", { messages: [] });
    expect(calls[0]!.body.b).toBe(2);
    expect(calls[0]!.body.a).toBeUndefined();
  });

  it("reads LOCAL_AI_CHAT_OPTIONS when no --chat-options is given", async () => {
    setEnv({ LOCAL_AI_CHAT_OPTIONS: '{"reasoning_effort":"none"}' });
    const calls = captureFetch({ choices: [{ message: { content: "[]" } }] });
    await resolveEvalRunner([]).runner.run("m", { messages: [] });
    expect(calls[0]!.body.reasoning_effort).toBe("none");
  });

  it("trims padded credentials out of the Workers AI URL and header", async () => {
    setEnv({ CLOUDFLARE_ACCOUNT_ID: "  acct123  ", CLOUDFLARE_API_TOKEN: "  tok456  " });
    const calls = captureFetch({ success: true, result: { response: "[]" } });
    await resolveEvalRunner(["--workers-ai"]).runner.run("@cf/m", { messages: [] });
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/m");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok456");
  });
});
