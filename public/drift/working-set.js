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
/** Thrown when the field's abuse control turns a request away. Carries the wait
 *  so callers can say how long rather than reporting a generic failure — a 429
 *  is the system working, and telling someone "could not start a session" when
 *  the truth is "wait 20 seconds" is the wrong sentence. */
export class ThrottledError extends Error {
  constructor(waitMs) {
    super(`rate limited for ${Math.ceil(waitMs / 1000)}s`);
    this.name = 'ThrottledError';
    this.waitMs = waitMs;
  }
}

function retryAfterMs(res, fallback = 15_000) {
  const after = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(after) && after > 0 ? after * 1000 : fallback;
}

export async function createSession(seed, params, fetchImpl = fetch) {
  const res = await fetchImpl('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, ...params }),
  });
  if (res.status === 429) throw new ThrottledError(retryAfterMs(res));
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`session create failed: ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
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
  if (res.status === 429) throw new ThrottledError(retryAfterMs(res));
  if (!res.ok) {
    // Carry the server's own explanation. A bare status turned one transient
    // 500 during a smoke run into an unfalsifiable mystery; the next occurrence
    // should say what the server thought was wrong.
    const detail = await res.text().catch(() => '');
    throw new Error(`pin failed: ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
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

  let throttledUntil = 0;

  async function drawBucket(bucket) {
    // No try/catch swallow at the call site: a bucket that fails is a bucket
    // that contributed nothing, and prime()/topUp() proceed with what arrived.
    const res = await doFetch(`/api/session/${sessionId}/pool?bucket=${bucket}&count=${DRAW_COUNT}`);
    if (res.status === 429) {
      // The field's own abuse control, not a fault. Honour Retry-After when it
      // is offered, and record that we are throttled so callers can say "busy"
      // instead of logging an error per bucket per attempt. A client that keeps
      // hammering through a 429 is the behaviour the limiter exists to stop.
      const after = Number(res.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 15_000;
      throttledUntil = Math.max(throttledUntil, Date.now() + waitMs);
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json();
    return { condensed: body.condensed ?? [], axisIds: body.axisIds ?? [] };
  }

  /** Per-bucket outcome of the LAST draw that touched it: 'ok' (it contributed
   *  rankable candidates), 'failed' (the request errored), 'empty' (200 with
   *  nothing usable — generation has not caught up there), or 'pending' (never
   *  drawn, or its rows were discarded by a flush). Kept per bucket rather than
   *  per pass because a retry draws only some buckets, and a bucket it did not
   *  touch keeps whatever it last earned. */
  const status = new Map(BUCKETS.map((b) => [b, 'pending']));

  async function draw(buckets) {
    const results = await Promise.all(
      buckets.map((b) => drawBucket(b).catch(() => null)),
    );
    buckets.forEach((bucket, i) => {
      const result = results[i];
      if (result === null) { status.set(bucket, 'failed'); return; }
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
          // which is what onFlush is for. Every bucket's contribution went with
          // it, so every bucket is owed a draw again.
          items = [];
          for (const b of BUCKETS) status.set(b, 'pending');
          currentAxisIds = result.axisIds;
          for (const cb of flushHandlers) cb();
        } else {
          currentAxisIds = result.axisIds;
        }
      }
      let kept = 0;
      for (const row of result.condensed) {
        // An empty coords array means the draw beat the axes to readiness.
        // Such a row has no position; ranking it would place it wherever the
        // maths happens to land.
        if (!Array.isArray(row.coords) || row.coords.length === 0) continue;
        items.push(ingest(row));
        kept++;
      }
      // A 200 carrying zero usable candidates is NOT a success. It means
      // generation has not caught up for that bucket, and treating it as done
      // is how a sparse pool got mistaken for a full one. Tracked separately
      // from a request failure because the two want different responses:
      // retry vs wait. Cycle 2.
      status.set(bucket, kept > 0 ? 'ok' : 'empty');
    });
  }

  const withStatus = (...wanted) => BUCKETS.filter((b) => wanted.includes(status.get(b)));

  /** Serialized: draws are destructive, so two concurrent passes drain the DO
   *  faster than its pump refills. */
  function once(buckets) {
    // Refuse to draw at all while throttled. Six buckets x every retry is
    // exactly how a rate limit turns into a console full of 429s.
    if (Date.now() < throttledUntil) return Promise.resolve();
    if (inflight) return inflight;
    if (buckets.length === 0) return Promise.resolve();
    inflight = draw(buckets).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    /** Draws every bucket. The opening pass, and a demand-driven top-up when
     *  local supply runs low, both want the whole spread. */
    prime: () => once(BUCKETS),
    topUp: () => once(BUCKETS),
    /** Draws ONLY the buckets still owed something — failed, empty, or never
     *  drawn. drawPool is destructive, so redrawing a healthy bucket to serve a
     *  retry aimed at another one drains it for nothing, and a single
     *  permanently-empty bucket would do that on every attempt. */
    retry: () => once(withStatus('failed', 'empty', 'pending')),
    all: () => items,
    size: () => items.length,
    axisIds: () => currentAxisIds,
    /** Buckets whose REQUEST errored on the last pass. */
    failedBuckets: () => withStatus('failed'),
    /** Buckets that answered 200 with nothing in them — generation has not
     *  caught up there yet. */
    emptyBuckets: () => withStatus('empty'),
    /** Milliseconds until the field will accept draws again, or 0. */
    throttledFor: () => Math.max(0, throttledUntil - Date.now()),
    onFlush(cb) { flushHandlers.push(cb); },
  };
}
