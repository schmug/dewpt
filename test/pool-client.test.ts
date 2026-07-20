import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// public/pool-client.js is plain JS served raw from public/ (no build step), so
// it sits outside tsconfig's include — same arrangement as the preseed-pool and
// hint-machine browser mirrors; the cast pins the surface under test.
// @ts-expect-error — public/pool-client.js ships untyped
import * as poolClientUntyped from "../public/pool-client.js";

interface Served {
  text: string;
  tier: 0 | 1 | 2;
  alt: 0 | 1;
  seedDist: number;
  coords: number[];
}

const { createPoolClient } = poolClientUntyped as {
  createPoolClient: (sessionId: string) => {
    draw: (bucket: string) => Served | null;
    prime: () => void;
  };
};

const BUCKET = "w0a0";
const LOW_WATER = 8; // mirrors the module constant
const REFILL_COOLDOWN_MS = 600; // mirrors the module constant

/** One refill's worth of words, tagged so the test can tell batches apart. */
function batch(prefix: string, count: number, coords: number[]): Served[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `${prefix}-${i}`,
    tier: 0 as const,
    alt: 0 as const,
    seedDist: 0.5,
    coords,
  }));
}

/** Drain until the buffer dips below LOW_WATER, which is what arms the next
 *  refill. Returns everything drawn so the caller can inspect provenance. */
function drainToRefill(client: { draw: (b: string) => Served | null }, have: number): Served[] {
  const out: Served[] = [];
  while (have - out.length >= LOW_WATER) {
    const word = client.draw(BUCKET);
    if (!word) break;
    out.push(word);
  }
  return out;
}

describe("pool client axis-set invalidation", () => {
  let responses: { condensed: Served[]; axisIds: string[] }[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    responses = [];
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? { condensed: [], axisIds: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Refills are rate-limited per bucket; jump past the cooldown between them. */
  async function settle() {
    await vi.waitFor(() => expect(responses).toHaveLength(0));
    vi.setSystemTime(Date.now() + REFILL_COOLDOWN_MS + 1);
  }

  it("discards buffered words when the axis set changes under them", async () => {
    const client = createPoolClient("session-1");
    responses.push({ condensed: batch("one-axis", 12, [0.1]), axisIds: ["axis-a"] });
    client.prime();
    await settle();

    // Draw down to arm a refill. Whatever is left is shaped for ["axis-a"].
    const drawnBefore = drainToRefill(client, 12);
    expect(drawnBefore.every((w) => w.coords.length === 1)).toBe(true);

    // The refill comes back scored against a second, newly-ready axis.
    responses.push({ condensed: batch("two-axis", 12, [0.1, 0.2]), axisIds: ["axis-a", "axis-b"] });
    client.draw(BUCKET); // dips below LOW_WATER, kicking the refill
    await settle();

    // Every word still buffered must carry the NEW coord shape. A leftover
    // one-axis word here is the bug: its coords[0] is fine but it has no
    // coords[1], and nothing downstream could tell it apart.
    const remaining: Served[] = [];
    for (let i = 0; i < 12; i++) {
      const word = client.draw(BUCKET);
      if (!word) break;
      remaining.push(word);
    }
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every((w) => w.text.startsWith("two-axis"))).toBe(true);
    expect(remaining.every((w) => w.coords.length === 2)).toBe(true);
  });

  it("keeps buffered words when the axis set is unchanged", async () => {
    const client = createPoolClient("session-2");
    responses.push({ condensed: batch("first", 12, [0.1]), axisIds: ["axis-a"] });
    client.prime();
    await settle();

    drainToRefill(client, 12);
    responses.push({ condensed: batch("second", 12, [0.3]), axisIds: ["axis-a"] });
    client.draw(BUCKET);
    await settle();

    const remaining: Served[] = [];
    for (let i = 0; i < 24; i++) {
      const word = client.draw(BUCKET);
      if (!word) break;
      remaining.push(word);
    }
    // The same axis set means the older words are still comparable, so they
    // must survive rather than being thrown away on every refill.
    expect(remaining.some((w) => w.text.startsWith("first"))).toBe(true);
    expect(remaining.some((w) => w.text.startsWith("second"))).toBe(true);
  });

  it("treats a reordered axis set as a different one", async () => {
    // Order is what indexes coords, so a reorder invalidates just as hard as a
    // membership change — and is easy to miss with a set-based comparison.
    const client = createPoolClient("session-3");
    responses.push({ condensed: batch("ab", 12, [0.1, 0.2]), axisIds: ["axis-a", "axis-b"] });
    client.prime();
    await settle();

    drainToRefill(client, 12);
    responses.push({ condensed: batch("ba", 12, [0.2, 0.1]), axisIds: ["axis-b", "axis-a"] });
    client.draw(BUCKET);
    await settle();

    const remaining: Served[] = [];
    for (let i = 0; i < 24; i++) {
      const word = client.draw(BUCKET);
      if (!word) break;
      remaining.push(word);
    }
    expect(remaining.every((w) => w.text.startsWith("ba"))).toBe(true);
  });
});
