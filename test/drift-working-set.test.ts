import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — public/drift/working-set.js ships untyped
import * as wsUntyped from "../public/drift/working-set.js";

interface Item { text: string; tier: number; alt: number; seedDist: number; coords: number[]; arrivedAt: number }
interface WorkingSet {
  prime(): Promise<void>;
  all(): Item[];
  topUp(): Promise<void>;
  axisIds(): string[];
  failedBuckets(): string[];
  emptyBuckets(): string[];
  throttledFor(): number;
  onFlush(cb: () => void): void;
  size(): number;
}

const ws = wsUntyped as {
  BUCKETS: string[];
  DRAW_COUNT: number;
  createWorkingSet(id: string, opts?: { fetchImpl?: typeof fetch }): WorkingSet;
};

function served(text: string, coords: number[] = [0.1, 0.2]) {
  return { text, tier: 1, alt: 0, seedDist: 0.4, coords };
}

/** Answers every /pool draw with `bodyFor(bucket)`. */
function poolFetch(bodyFor: (bucket: string) => unknown, status = 200) {
  return vi.fn(async (url: string) => {
    const bucket = new URL(url, "http://x").searchParams.get("bucket")!;
    return { ok: status === 200, status, json: async () => bodyFor(bucket) } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("prime", () => {
  it("draws every bucket and keeps what arrives", async () => {
    const fetchImpl = poolFetch((b) => ({ condensed: [served(`${b}-1`), served(`${b}-2`)], axisIds: ["ax", "ay"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length * 2);
    expect(set.axisIds()).toEqual(["ax", "ay"]);
  });

  it("survives a partial failure and keeps the buckets that answered", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const bucket = new URL(url, "http://x").searchParams.get("bucket")!;
      if (bucket === "w0a0") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ condensed: [served(bucket)], axisIds: ["ax"] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length - 1);
  });

  it("drops rows whose coords are empty rather than ranking them at a fake position", async () => {
    // coords: [] means the draw beat the axes to readiness. Such a row has no
    // position at all; rendering it would put it wherever the maths happens to
    // land.
    const fetchImpl = poolFetch(() => ({
      condensed: [served("good", [0.1, 0.2]), { ...served("bad"), coords: [] }],
      axisIds: ["ax", "ay"],
    }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.all().every((i) => i.coords.length === 2)).toBe(true);
    expect(set.all().some((i) => i.text === "bad")).toBe(false);
  });

  it("stamps a strictly increasing arrivedAt so fresh-first tie-breaks work", async () => {
    const fetchImpl = poolFetch((b) => ({ condensed: [served(`${b}-1`), served(`${b}-2`)], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    const stamps = set.all().map((i) => i.arrivedAt);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("all() is non-consuming", () => {
  it("returns the same candidates on repeated reads", async () => {
    // pool-client.js's draw() does buffer.shift(). Projection re-ranks the SAME
    // set every time position moves, so consuming here would empty the surface
    // one swipe at a time.
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    const first = set.all().map((i) => i.text);
    const second = set.all().map((i) => i.text);
    expect(second).toEqual(first);
    expect(set.size()).toBe(ws.BUCKETS.length);
  });
});

describe("axisIds flush", () => {
  it("discards the whole set and notifies when the axis set changes", async () => {
    // coords are shaped for a specific axis set; mixing shapes would rank
    // differently-scored candidates against each other with nothing to tell
    // them apart. pool-client.js flushes every buffer for the same reason.
    let ids = ["ax"];
    const fetchImpl = poolFetch(() => ({ condensed: [served("a", [0.1])], axisIds: ids }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    const onFlush = vi.fn();
    set.onFlush(onFlush);
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length);

    ids = ["ax", "ay"];
    await set.topUp();
    expect(onFlush).toHaveBeenCalled();
    // Only the post-flush draws survive; nothing scored against ["ax"] remains.
    expect(set.axisIds()).toEqual(["ax", "ay"]);
  });

  it("does not flush when the axis set is unchanged", async () => {
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    const onFlush = vi.fn();
    set.onFlush(onFlush);
    await set.prime();
    await set.topUp();
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe("topUp", () => {
  it("does not run twice concurrently", async () => {
    // Draws are DESTRUCTIVE server-side: drawPool DELETEs the rows it returns.
    // A double top-up drains the DO faster than its pump refills.
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await Promise.all([set.topUp(), set.topUp()]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(ws.BUCKETS.length);
  });

  it("never stores an embedding key", async () => {
    // Guards the 245 KB wire mistake from the client side.
    const fetchImpl = poolFetch(() => ({
      condensed: [{ ...served("a"), embedding: [1, 2, 3] }],
      axisIds: ["ax"],
    }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    for (const item of set.all()) expect(Object.keys(item)).not.toContain("embedding");
  });
});

describe("429 is a state, not an error (critic cycle 2 follow-up)", () => {
  function throttlingFetch(status: number, retryAfter?: string) {
    return vi.fn(async () => ({
      ok: status < 400, status,
      headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
      json: async () => ({}),
    })) as unknown as typeof fetch;
  }

  it("stops drawing entirely while throttled", async () => {
    // Six buckets x every retry is exactly how a rate limit becomes a console
    // full of 429s. Once throttled, the client must go quiet.
    const fetchImpl = throttlingFetch(429, "30");
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    const callsAfterFirst = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(ws.BUCKETS.length);
    await set.topUp();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
           "kept drawing through a 429").toBe(callsAfterFirst);
  });

  it("honours Retry-After when the server offers one", async () => {
    const set = ws.createWorkingSet("s1", { fetchImpl: throttlingFetch(429, "30") });
    await set.prime();
    expect(set.throttledFor()).toBeGreaterThan(20_000);
    expect(set.throttledFor()).toBeLessThanOrEqual(30_000);
  });

  it("falls back to a default wait when Retry-After is absent", async () => {
    const set = ws.createWorkingSet("s1", { fetchImpl: throttlingFetch(429) });
    await set.prime();
    expect(set.throttledFor()).toBeGreaterThan(0);
  });

  it("does not report throttling for an ordinary failure", async () => {
    const set = ws.createWorkingSet("s1", { fetchImpl: throttlingFetch(500) });
    await set.prime();
    expect(set.throttledFor()).toBe(0);
    expect(set.failedBuckets().length).toBe(ws.BUCKETS.length);
  });
});
