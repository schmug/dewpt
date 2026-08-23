// Pure ranking core for the drift surface. No DOM, no fetch — everything here
// is testable from vitest with fixed vectors and no network.
//
// The mechanic is PROJECTION, not translation: a swipe moves your position and
// the pool is re-ranked, so a candidate is never rewritten and the seed can
// never be abandoned. Measured in
// docs/measurements/2026-08-22-drift-mechanic-spikes.md.

/** One swipe, as a fraction of the frozen span. MEASURED: a 10% step replaces
 *  3-5 of the 5 nearest candidates, so it is the smallest step already shown to
 *  change the neighbourhood. */
export const STEP = 0.1;

/** UNMEASURED, and must stay labelled until it isn't. Radius is 1.5 swipe
 *  steps, so a shortage is detected about a swipe and a half before you walk
 *  into it; the floor mirrors pool-client.js's LOW_WATER of 8. Both are
 *  guesses — see open question 1 in the spec. Measure against a real session
 *  before treating either as tuned. */
export const SUPPLY_RADIUS = 0.15;
export const SUPPLY_FLOOR = 8;

/** How far a card may sit from your position and still be shown. Beyond this,
 *  there is nothing here and the surface must say so rather than teleport you
 *  to the nearest thing anywhere in the pool.
 *
 *  Without a bound, `nextCard` returns the globally nearest unseen candidate,
 *  so `localSupply` can report zero supply while a card renders anyway — the
 *  surface then claims a position it is not actually showing you. That is the
 *  edge failing to exist, which is worse than an edge in the wrong place.
 *
 *  Set to three swipes. A swipe steps STEP, so a candidate further than
 *  3 x STEP is one you could not have reached from here in the moves you just
 *  made; presenting it as "here" is a lie about position. Must stay strictly
 *  greater than SUPPLY_RADIUS, or you would reach the edge before a top-up is
 *  ever triggered. REASONED, NOT MEASURED — the ratio to STEP is the argument,
 *  and it should be checked against a real session. */
export const MAX_REACH = 3 * STEP;

function usable(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Per-axis min/max over the primed set. Frozen once and only ever widened,
 *  because position is stored RAW: if the range moved, a stored position would
 *  drift semantically without the user touching the screen. */
export function freezeRange(candidates, axisCount) {
  const lo = [];
  const hi = [];
  for (let a = 0; a < axisCount; a++) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const c of candidates) {
      const v = c.coords?.[a];
      if (!usable(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    // A degenerate or empty axis gets a unit span CENTRED ON THE VALUE ITSELF,
    // not on zero. A zero span would divide by zero in toNormalized, land every
    // card at NaN, and empty the surface with no error anywhere — but a span of
    // [-0.5, 0.5] around zero is just as wrong when every candidate sits at,
    // say, 0.2: they would all normalize to 0.7 and sit off-centre on a gauge
    // that has nothing to be off-centre about. Centre it and they read 0.5.
    if (!usable(mn) || !usable(mx) || mn === mx) {
      const centre = usable(mn) ? mn : 0;
      mn = centre - 0.5;
      mx = centre + 0.5;
    }
    lo.push(mn);
    hi.push(mx);
  }
  return { lo, hi };
}

/** Monotone by construction — a top-up can only widen. Narrowing would move
 *  what an already-stored raw position means. */
export function widenRange(range, candidates) {
  const lo = [...range.lo];
  const hi = [...range.hi];
  for (let a = 0; a < lo.length; a++) {
    for (const c of candidates) {
      const v = c.coords?.[a];
      if (!usable(v)) continue;
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo, hi };
}

export function toNormalized(raw, range, axis) {
  const span = range.hi[axis] - range.lo[axis];
  return span === 0 ? 0.5 : (raw - range.lo[axis]) / span;
}

export function toRaw(norm, range, axis) {
  return range.lo[axis] + norm * (range.hi[axis] - range.lo[axis]);
}

/** Start mid-axis on every axis. */
export function initialPosition(range) {
  return range.lo.map((lo, a) => lo + (range.hi[a] - lo) / 2);
}

/** One swipe. `dir` is -1 or +1. The step scales to the RAW span so a swipe is
 *  always a tenth of the axis regardless of how wide the cosines happen to be. */
export function stepPosition(position, range, axis, dir, step = STEP) {
  const next = [...position];
  const span = range.hi[axis] - range.lo[axis];
  const moved = position[axis] + dir * step * span;
  next[axis] = Math.min(range.hi[axis], Math.max(range.lo[axis], moved));
  return next;
}

/** Euclidean distance in NORMALIZED space, so two axes with different raw spans
 *  contribute comparably. Licensed by the measured independence of two named
 *  axes (r -0.038 / +0.107); on correlated axes this would double-count one
 *  direction. A candidate missing any coord returns Infinity and can never win
 *  — the empty-coords guard, enforced at ranking as well as at ingest. */
export function distanceTo(candidate, position, range) {
  let sum = 0;
  for (let a = 0; a < range.lo.length; a++) {
    const v = candidate.coords?.[a];
    if (!usable(v)) return Infinity;
    const d = toNormalized(v, range, a) - toNormalized(position[a], range, a);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Nearest unseen candidate; null when nothing is reachable, which IS the edge
 *  rather than an error. Ties break toward the freshest arrival: the measured
 *  axis middle is a dense pile of near-ties (midShare 0.29-0.45), and fresh-first
 *  is what makes that pile a deep well rather than a fixed one. */
export function nextCard(candidates, position, range, seen, maxReach = MAX_REACH) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    const d = distanceTo(c, position, range);
    if (!Number.isFinite(d)) continue;
    // LOCAL, not global. A candidate outside the reach is not "here", and
    // showing it would misreport where you are standing.
    if (d > maxReach) continue;
    if (d < bestD || (d === bestD && best !== null && c.arrivedAt > best.arrivedAt)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Unseen candidates within `radius` of the position. The top-up trigger is
 *  LOCAL on purpose: a set of 180 can be plentiful overall and empty exactly
 *  where you stand, and a global count would let you walk into a hole while the
 *  client believes it is well stocked. */
export function localSupply(candidates, position, range, seen, radius) {
  let n = 0;
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    if (distanceTo(c, position, range) <= radius) n++;
  }
  return n;
}
