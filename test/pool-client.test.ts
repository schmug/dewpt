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
// Mirrors the module's BUCKETS constant and iteration order. prime() refills
// buckets in this order, and (per this file's fetchMock) each bucket's fetch
// resolves and shifts its response off `responses` in that same order — so
// pushing responses in this order reaches buckets by position.
const ALL_BUCKETS = ["w0a0", "w0a1", "w1a0", "w1a1", "w2a0", "w2a1"];
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

  /** Seed a `prime()` call so every bucket agrees on the same axis set — a
   *  real session's six buckets all query one source of truth and would
   *  never independently observe a DIFFERENT axis set from each other at
   *  rest. Without this, an unseeded bucket's response would fall through to
   *  the mock's empty default and look like a bogus reversion to zero axes,
   *  which — now that the axis set is global to the client, not per bucket —
   *  would spuriously flush every buffer. `content` maps specific buckets to
   *  real batches; every other bucket gets an empty batch under the same
   *  axisIds. */
  function primeAll(axisIds: string[], content: Record<string, Served[]> = {}) {
    for (const bucket of ALL_BUCKETS) {
      responses.push({ condensed: content[bucket] ?? [], axisIds });
    }
  }

  it("discards buffered words when the axis set changes under them", async () => {
    const client = createPoolClient("session-1");
    primeAll(["axis-a"], { [BUCKET]: batch("one-axis", 12, [0.1]) });
    client.prime();
    await settle();

    // Draw down to arm a refill. Whatever is left is shaped for ["axis-a"].
    const drawnBefore = drainToRefill(client, 12);
    expect(drawnBefore.length).toBeGreaterThan(0);
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
    primeAll(["axis-a"], { [BUCKET]: batch("first", 12, [0.1]) });
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

  it("flushes every bucket's buffer when a changed axis set is observed on just one bucket's refill", async () => {
    // field.js drains all six buckets into one shared visible field, so the
    // axis set must be global to the client: a change seen by BUCKET's
    // refill has to invalidate OTHER_BUCKET's buffer too, even though
    // OTHER_BUCKET never refills itself in this test.
    const OTHER_BUCKET = "w0a1";
    const client = createPoolClient("session-cross-bucket");

    primeAll(["axis-a"], {
      [BUCKET]: batch("a-one", 12, [0.1]),
      [OTHER_BUCKET]: batch("b-one", 12, [0.1]),
    });
    client.prime();
    await settle();

    // Sanity-check OTHER_BUCKET actually holds pre-change words before we
    // assert they're gone.
    const beforeChange = client.draw(OTHER_BUCKET);
    expect(beforeChange?.text.startsWith("b-one")).toBe(true);

    // Drain BUCKET to arm its own refill, then answer with a new axis set.
    drainToRefill(client, 12);
    responses.push({ condensed: batch("a-two", 12, [0.1, 0.2]), axisIds: ["axis-a", "axis-b"] });
    client.draw(BUCKET); // dips BUCKET below LOW_WATER, kicking ITS refill
    await settle();

    // OTHER_BUCKET never refilled, but its stale one-axis words must be gone
    // regardless — the axis set is global, not scoped to whichever bucket
    // happened to refill.
    expect(client.draw(OTHER_BUCKET)).toBeNull();
  });

  it("flushes no bucket's buffer when the axis set is unchanged, regardless of which bucket refills", async () => {
    const OTHER_BUCKET = "w0a1";
    const client = createPoolClient("session-cross-bucket-unchanged");

    primeAll(["axis-a"], {
      [BUCKET]: batch("a-first", 12, [0.1]),
      [OTHER_BUCKET]: batch("b-first", 12, [0.1]),
    });
    client.prime();
    await settle();

    drainToRefill(client, 12);
    responses.push({ condensed: batch("a-second", 12, [0.3]), axisIds: ["axis-a"] });
    client.draw(BUCKET);
    await settle();

    // OTHER_BUCKET was never touched by this refill and the axis set didn't
    // change, so its original words must still be sitting there untouched.
    expect(client.draw(OTHER_BUCKET)?.text.startsWith("b-first")).toBe(true);
  });

  it("treats a reordered axis set as a different one", async () => {
    // Order is what indexes coords, so a reorder invalidates just as hard as a
    // membership change — and is easy to miss with a set-based comparison.
    const client = createPoolClient("session-3");
    primeAll(["axis-a", "axis-b"], { [BUCKET]: batch("ab", 12, [0.1, 0.2]) });
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
