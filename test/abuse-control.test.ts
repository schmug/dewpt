import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import {
  budgetedAiRunner,
  estimateAiUnits,
  type AccountBudgetEnv,
  type AiPermit,
} from "../src/ai-budget";
import type { AiRunner } from "../src/generation";
import worker from "../src/index";

function budgetEnv(options: {
  acquire: (capability: string, units: number) => Promise<AiPermit>;
  release?: (permitId: string) => Promise<void>;
}) {
  const getByName = vi.fn(() => ({
    acquireAi: options.acquire,
    releaseAi: options.release ?? (async () => {}),
  }));
  return { env: { ACCOUNT_BUDGET: { getByName } } as AccountBudgetEnv, getByName };
}

describe("estimateAiUnits", () => {
  it("charges declared generation output as well as prompt input", () => {
    const promptOnly = estimateAiUnits({ messages: [{ role: "user", content: "hello" }] });
    const generated = estimateAiUnits({ messages: [{ role: "user", content: "hello" }], max_tokens: 1024 });
    expect(generated).toBeGreaterThanOrEqual(promptOnly + 1024);
  });

  it("charges larger embedding batches more than a probe", () => {
    expect(estimateAiUnits({ text: ["x".repeat(4_000)] })).toBeGreaterThan(
      estimateAiUnits({ text: ["probe"] }),
    );
  });
});

describe("budgetedAiRunner", () => {
  it("does not touch Workers AI when the account or capability budget denies the call", async () => {
    const acquire = vi.fn(async () => ({
      granted: false as const,
      retryAfterSeconds: 37,
      reason: "ai:account:minute",
    }));
    const { env } = budgetEnv({ acquire });
    const run = vi.fn(async () => ({ data: [[1]] }));

    await expect(budgetedAiRunner(env, "session:s1", { run }).run("embed", { text: ["probe"] }))
      .rejects.toMatchObject({ retryAfterSeconds: 37 });
    expect(run).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledWith("session:s1", expect.any(Number));
  });

  it("releases the concurrency lease after a successful call", async () => {
    const release = vi.fn(async () => {});
    const { env, getByName } = budgetEnv({
      acquire: async () => ({ granted: true, permitId: "permit-1" }),
      release,
    });
    const raw: AiRunner = { run: vi.fn(async () => ({ response: "ok" })) };

    await expect(budgetedAiRunner(env, "board:b1", raw).run("gen", { max_tokens: 10 })).resolves.toEqual({ response: "ok" });
    expect(getByName).toHaveBeenCalledWith("account");
    expect(release).toHaveBeenCalledWith("permit-1");
  });

  it("releases the concurrency lease when the provider throws", async () => {
    const release = vi.fn(async () => {});
    const { env } = budgetEnv({
      acquire: async () => ({ granted: true, permitId: "permit-2" }),
      release,
    });
    const raw: AiRunner = { run: vi.fn(async () => { throw new Error("provider down"); }) };

    await expect(budgetedAiRunner(env, "diagnostic", raw).run("embed", { text: ["probe"] }))
      .rejects.toThrow("provider down");
    expect(release).toHaveBeenCalledWith("permit-2");
  });
});

describe("POST /api/session admission", () => {
  function sessionRequest(): Request {
    return new Request("https://dewpt.test/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ seed: "urban gardening" }),
    });
  }

  function sessionEnv(
    clientAdmit: (kind: "request" | "creation") => Promise<{ allowed: boolean; retryAfterSeconds: number }>,
  ) {
    const init = vi.fn(async (id: string) => ({ id }));
    const getByName = vi.fn(() => ({ init }));
    return {
      env: {
        CLIENT_RATE_LIMIT: { getByName: () => ({ admit: clientAdmit }) },
        ACCOUNT_BUDGET: {
          getByName: () => ({ admitCreation: async () => ({ allowed: true, retryAfterSeconds: 0 }) }),
        },
        SESSION_DO: { getByName },
      },
      getByName,
      init,
    };
  }

  it("returns 429 before minting a SessionDO when creation admission is exhausted", async () => {
    const { env, getByName, init } = sessionEnv(async (kind) =>
      kind === "creation"
        ? { allowed: false, retryAfterSeconds: 23 }
        : { allowed: true, retryAfterSeconds: 0 },
    );
    const handler = worker as unknown as { fetch(request: Request, env: unknown): Promise<Response> };

    const response = await handler.fetch(sessionRequest(), env);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    expect(getByName).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it("preserves successful creation below both request limits", async () => {
    const { env, getByName, init } = sessionEnv(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const handler = worker as unknown as { fetch(request: Request, env: unknown): Promise<Response> };

    const response = await handler.fetch(sessionRequest(), env);

    expect(response.status).toBe(201);
    expect(getByName).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
  });
});
