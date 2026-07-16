// Local per-bucket buffers between the field and the session DO's pool API.
// draw() is synchronous and never blocks — the field drips from these buffers
// and refills happen in the background. An empty buffer just means "no word
// this tick"; the field's loop tries again on its own schedule.

const BUCKETS = ['w0a0', 'w0a1', 'w1a0', 'w1a1', 'w2a0', 'w2a1'];
const LOW_WATER = 8; // refill a bucket's buffer below this
const DRAW_COUNT = 12; // words per refill request
const REFILL_COOLDOWN_MS = 600;

export function createPoolClient(sessionId) {
  const buffers = new Map(BUCKETS.map(b => [b, []]));
  const inflight = new Set();
  const lastAttempt = new Map();

  async function refill(bucket) {
    if (inflight.has(bucket)) return;
    if (Date.now() - (lastAttempt.get(bucket) ?? 0) < REFILL_COOLDOWN_MS) return;
    inflight.add(bucket);
    lastAttempt.set(bucket, Date.now());
    try {
      const res = await fetch(`/api/session/${sessionId}/pool?bucket=${bucket}&count=${DRAW_COUNT}`);
      if (!res.ok) return;
      const { condensed } = await res.json();
      buffers.get(bucket).push(...condensed);
    } catch (err) {
      console.error('pool refill failed', bucket, err);
    } finally {
      inflight.delete(bucket);
    }
  }

  return {
    /** Synchronous draw from the local buffer; kicks a background refill when low. */
    draw(bucket) {
      const buffer = buffers.get(bucket);
      if (!buffer) return null;
      if (buffer.length < LOW_WATER) refill(bucket);
      return buffer.shift() ?? null;
    },
    /** Warm every bucket's buffer (used once at session start). */
    prime() {
      for (const bucket of BUCKETS) refill(bucket);
    },
  };
}
