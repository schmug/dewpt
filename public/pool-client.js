// Local per-bucket buffers between the field and the session DO's pool API.
// draw() is synchronous and never blocks — the field drips from these buffers
// and refills happen in the background. An empty buffer just means "no word
// this tick"; the field's loop tries again on its own schedule.

const BUCKETS = ['w0a0', 'w0a1', 'w1a0', 'w1a1', 'w2a0', 'w2a1'];
const LOW_WATER = 8; // refill a bucket's buffer below this
const DRAW_COUNT = 12; // words per refill request
const REFILL_COOLDOWN_MS = 600;

/** Ordered comparison — axis order is what indexes coords, so a reorder is as
 *  much a mismatch as a different membership. */
function sameAxisIds(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function createPoolClient(sessionId) {
  const buffers = new Map(BUCKETS.map(b => [b, []]));
  // The axisIds every buffered word, in every bucket, was drawn under. This is
  // global to the client rather than per bucket: field.js drains all six
  // buckets into one shared visible field, so a word from any bucket can end
  // up next to a word from any other. If two buckets held different axis
  // sets, that shared field would mix differently-shaped coords with nothing
  // to tell them apart — the exact mismatch axisIds exists to prevent, just
  // moved up one level. So refills are per-bucket, but the axis set they're
  // checked against — and the flush they trigger on a change — is not.
  let currentAxisIds = [];
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
      const { condensed, axisIds = [] } = await res.json();
      // Buffered items are the server's Served objects: {text, tier, alt,
      // seedDist, coords}. coords is one raw cosine per ready axis, needing
      // normalizeCoords() against the visible set before use as layout
      // positions. field.js currently keeps only {text, tier}; map mode
      // (workstream A) is what consumes coords.
      if (!sameAxisIds(currentAxisIds, axisIds)) {
        // The axis set changed under us. Old coords — across EVERY bucket,
        // not just this one — are shaped for the old set and cannot be
        // reconciled, so all buffered words go rather than silently mixing
        // shapes into the shared visible field. Losing a few buffered words
        // is free: they are ephemeral by design.
        for (const buffer of buffers.values()) buffer.length = 0;
        currentAxisIds = axisIds;
      }
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
