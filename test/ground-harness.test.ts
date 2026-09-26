import { describe, expect, it } from "vitest";
import { requestCap, retryTransient } from "../scripts/ground-harness";

const transient = () => new Error("Error: internal error; reference = a5jg02arvil2m1q2qajm2gj7");

function flaky(failures: (() => Error)[]) {
  let calls = 0;
  return {
    calls: () => calls,
    ai: {
      async run() {
        const fail = failures[calls++];
        if (fail) throw fail();
        return { ok: true };
      },
    },
  };
}

describe("retryTransient", () => {
  it("retries the binding's transient internal error and returns the answer", async () => {
    const f = flaky([transient]);
    await expect(retryTransient(f.ai, 3, 0).run("m", {})).resolves.toEqual({ ok: true });
    expect(f.calls()).toBe(2);
  });
  it("does not retry anything else — a cap stop or a WARP timeout must surface", async () => {
    const f = flaky([() => new Error("request cap 62 reached — stopping, not overspending")]);
    await expect(retryTransient(f.ai, 3, 0).run("m", {})).rejects.toThrow("request cap");
    expect(f.calls()).toBe(1);
  });
  it("gives up after the allowed attempts", async () => {
    const f = flaky([transient, transient, transient, transient]);
    await expect(retryTransient(f.ai, 3, 0).run("m", {})).rejects.toThrow("internal error");
    expect(f.calls()).toBe(3);
  });
  it("counts every attempt against the request cap when wrapped outside it", async () => {
    const f = flaky([transient]);
    const capped = requestCap(f.ai, 70);
    await retryTransient(capped.ai, 3, 0).run("m", {});
    expect(capped.spent()).toBe(2);
  });
});
