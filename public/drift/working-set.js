// The resident candidate set for the drift surface. Owns all network.
//
// This is a SIBLING of public/pool-client.js, not a replacement, and the field
// keeps using that one. The difference is consumption: pool-client's draw() does
// buffer.shift(), which is right for a field that spawns a word and forgets it,
// and wrong here — projection re-ranks the SAME set every time position moves,
// so a consuming read would empty the surface one swipe at a time.
//
// Three server behaviours this has to respect:
//  - drawPool is DESTRUCTIVE. It DELETEs the rows it returns and pushes them
//    into a 300-entry exclude LRU, then kicks the regeneration pump. So the
//    server guarantees no candidate is served twice, this client owns whatever
//    it has drawn, and a reload loses the set.
//  - coords are computed AT DRAW TIME against whatever axes are ready. A draw
//    that beats the axes returns coords: [], which has no position at all.
//  - axisIds indexes coords. A changed axis set makes every held coord
//    unreadable, so the set is discarded rather than silently mixing shapes.

export const BUCKETS = ['w0a0', 'w0a1', 'w1a0', 'w1a1', 'w2a0', 'w2a1'];

/** MAX_DRAW_COUNT on the server is 30. Six buckets at 30 is a 180-candidate
 *  prime against the DO's TARGET_DEPTH of 60 x 6 = 360, so a prime takes about
 *  half the pool and the pump refills behind it. */
export const DRAW_COUNT = 30;

/** Session lifecycle and pinning live here so this module genuinely owns the
 *  network, rather than owning most of it while drift.js quietly fetches too.
 *  Axis requests remain in the shared public/axes.js, which predates this
 *  surface and is used by others — that is a deliberate exception, stated
 *  rather than glossed. Critic cycle 1. */
export async function createSession(seed, params, fetchImpl = fetch) {
  const res = await fetchImpl('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, ...params }),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status}`);
  return res.json();
}

/** Foreground user action: the caller must surface a failure rather than
 *  swallow it, unlike a background top-up. */
export async function pinWord(sessionId, text, tier, fetchImpl = fetch) {
  const res = await fetchImpl(`/api/session/${sessionId}/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, tier }),
  });
  if (!res.ok) throw new Error(`pin failed: ${res.status}`);
  return res.json();
}

export function createWorkingSet(sessionId, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  let items = [];
  let currentAxisIds = [];
  let arrivals = 0;
  let inflight = null;
  const flushHandlers = [];

  function sameAxisIds(a, b) {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /** Copy field by field rather than spreading the server row. A spread would
   *  carry through any key the server later adds — including an embedding, the
   *  245 KB mistake this is a client-side guard against. */
  function ingest(row) {
    return {
      text: row.text,
      tier: row.tier,
      alt: row.alt,
      seedDist: row.seedDist,
      coords: row.coords,
      arrivedAt: ++arrivals,
    };
  }

  async function drawBucket(bucket) {
    // No try/catch swallow at the call site: a bucket that fails is a bucket
    // that contributed nothing, and prime()/topUp() proceed with what arrived.
    const res = await doFetch(`/api/session/${sessionId}/pool?bucket=${bucket}&count=${DRAW_COUNT}`);
    if (!res.ok) return null;
    const body = await res.json();
    return { condensed: body.condensed ?? [], axisIds: body.axisIds ?? [] };
  }

  let lastFailedBuckets = [];

  async function draw() {
    const results = await Promise.all(
      BUCKETS.map((b) => drawBucket(b).catch(() => null)),
    );
    // Which buckets contributed nothing, so the caller can keep trying them in
    // the background instead of treating one bad pass as the final answer.
    lastFailedBuckets = BUCKETS.filter((_, i) => results[i] === null);
    for (const result of results) {
      if (!result) continue;
      if (!sameAxisIds(currentAxisIds, result.axisIds)) {
        // ADOPTION IS NOT A FLUSH. On the first draw currentAxisIds is [] and
        // the server returns the real set, which is not a change — there is
        // nothing stale to discard, and firing onFlush here would make the
        // caller reset a frozen range it has only just computed. Only an
        // already-adopted set changing underneath us is a flush.
        if (currentAxisIds.length > 0) {
          // Every held coord was scored against the old axis set and cannot be
          // reconciled. Losing the set is free — it is ephemeral by design —
          // and the caller must also reset its frozen range and seen set,
          // which is what onFlush is for.
          items = [];
          for (const cb of flushHandlers) cb();
        }
        currentAxisIds = result.axisIds;
      }
      for (const row of result.condensed) {
        // An empty coords array means the draw beat the axes to readiness.
        // Such a row has no position; ranking it would place it wherever the
        // maths happens to land.
        if (!Array.isArray(row.coords) || row.coords.length === 0) continue;
        items.push(ingest(row));
      }
    }
  }

  /** Serialized: draws are destructive, so two concurrent passes drain the DO
   *  faster than its pump refills. */
  function once() {
    if (inflight) return inflight;
    inflight = draw().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    prime: once,
    topUp: once,
    all: () => items,
    size: () => items.length,
    axisIds: () => currentAxisIds,
    /** Buckets that errored on the last pass. Empty means the pass was clean. */
    failedBuckets: () => [...lastFailedBuckets],
    onFlush(cb) { flushHandlers.push(cb); },
  };
}
