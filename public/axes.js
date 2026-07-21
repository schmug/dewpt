// Client-side axis data path. No rendering — workstream A owns pixels.
// normalizeCoords mirrors src/axis-core.ts (tested there); the duplication
// follows the existing src/hint-machine.ts <-> public/hint-machine.js pattern.

/** Min-max onto 0..1. Normalization belongs on the client because it must run
 *  against the VISIBLE set, which the server does not know. Raw cosines sit in
 *  a narrow band near zero — rendered unnormalized, every word lands in a few
 *  central pixels. */
export function normalizeCoords(values) {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span === 0) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / span);
}

export function createAxisClient(sessionId) {
  let current = [];

  async function call(path, options) {
    // No try/catch around fetch, unlike pool-client.js's refill: that is a
    // background top-up that swallows errors to protect the render loop, while
    // axis creation is a foreground user action whose failure must surface.
    const res = await fetch(`/api/session/${sessionId}${path}`, options);
    // Read the body either way. The server's 409 (cap) and 422 (degenerate
    // poles) both carry `error` plus the current `axes`, specifically so a
    // client can explain the refusal and repaint without a follow-up GET.
    // .catch() covers a non-JSON body — a platform 500 is not JSON, and the
    // error path must not itself throw.
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(payload?.error ?? `axis request failed: ${res.status}`);
      error.status = res.status;
      error.payload = payload; // callers reach payload.axes to repaint
      throw error;
    }
    current = payload?.axes ?? [];
    return current;
  }

  return {
    axes() {
      return current;
    },
    list() {
      return call('/axes');
    },
    /** Slow by design — the server expands both pole terms with an LLM call
     *  before embedding them. Callers should show progress, and must never
     *  block the field on this. */
    create(negTerm, posTerm) {
      return call('/axes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ negTerm, posTerm }),
      });
    },
    remove(id) {
      return call(`/axes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
