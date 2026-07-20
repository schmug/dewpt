import { afterEach, describe, expect, it, vi } from "vitest";

// public/axes.js is plain JS served raw from public/ (no build step), so it
// sits outside tsconfig's include — same arrangement as public/pool-client.js's
// mirror in test/pool-client.test.ts; the cast pins the surface under test.
// @ts-expect-error — public/axes.js ships untyped
import * as axesClientUntyped from "../public/axes.js";

interface AxisClientError extends Error {
  status?: number;
  payload?: unknown;
}

const { createAxisClient } = axesClientUntyped as {
  createAxisClient: (sessionId: string) => {
    axes: () => unknown[];
    list: () => Promise<unknown[]>;
    create: (negTerm: string, posTerm: string) => Promise<unknown[]>;
    remove: (id: string) => Promise<unknown[]>;
  };
};

/** Runs `client.create(...)` and returns the thrown error, or fails the test
 *  if nothing was thrown — call() must surface a non-2xx as a rejection. */
async function captureError(run: () => Promise<unknown>): Promise<AxisClientError> {
  try {
    await run();
  } catch (err) {
    return err as AxisClientError;
  }
  throw new Error("expected call() to throw, but it resolved");
}

describe("axis client error payloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the server's message and axes payload on a 409", async () => {
    const axesPayload = [{ id: "axis-1" }, { id: "axis-2" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "at most 3 axes", axes: axesPayload }),
      })),
    );

    const client = createAxisClient("session-1");
    const error = await captureError(() => client.create("hot", "cold"));

    // The thrown error's message must include the server's explanation, not
    // a generic "request failed" placeholder — reverting call()'s body-read
    // back to a bare throw on !res.ok would lose this.
    expect(error.message).toContain("at most 3 axes");
    expect(error.status).toBe(409);
    // The route pairs `error` with the current `axes` specifically so the
    // client can repaint without a follow-up GET; that payload must survive
    // onto the thrown error.
    expect((error.payload as { axes: unknown[] }).axes).toEqual(axesPayload);
  });

  it("does not itself throw when the error response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      })),
    );

    const client = createAxisClient("session-2");
    // The .catch(() => null) around the body read must absorb the JSON
    // parse failure itself; if it didn't, this would reject with a
    // SyntaxError instead of the intended "axis request failed: 500" error.
    const error = await captureError(() => client.create("hot", "cold"));

    expect(error.message).toBe("axis request failed: 500");
    expect(error.status).toBe(500);
    expect(error.payload).toBeNull();
  });
});
