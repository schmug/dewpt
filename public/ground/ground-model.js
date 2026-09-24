// Pure layout and pacing for the ground page. No DOM — test/ground-model.test.ts
// imports this directly, the way belt-model.js and depth.js are tested.
//
// Two planes share one legibility budget. The sky is ambient weather drawn from
// the pool; dew is what condenses on the ground when you prospect beside your
// words or along a thread. Both are ephemeral, and TOGETHER they never exceed
// the field's CAP = 14 (a legibility limit, CLAUDE.md) — dew arriving pushes
// the oldest sky words out early rather than overprinting.

export const CAP = 14;
/** Server ground coordinate space; mirrors GROUND_W / GROUND_H in src/ground-core.ts. */
export const GROUND_W = 1200;
export const GROUND_H = 420;

const BUCKETS = ['w0a0', 'w0a1', 'w1a0', 'w1a1', 'w2a0', 'w2a1'];

/** Room left for new ephemeral words. Dew has priority: it answers a gesture. */
export function room(skyCount, dewCount) {
  return Math.max(0, CAP - skyCount - dewCount);
}

/** How many sky words must leave early so `incoming` dew fits under CAP. */
export function skyToRetire(skyCount, dewCount, incoming) {
  return Math.max(0, skyCount + dewCount + incoming - CAP);
}

/** Tier weights from dewpoint alone — the field's curve (field.js tierWeights)
 *  without the pinned-tier bias, since the ground conditions by place instead. */
export function tierWeights(dewpoint) {
  const s = Math.min(1, Math.max(0, dewpoint));
  const w2 = Math.pow(s, 1.4);
  const w0 = Math.pow(1 - s, 1.4);
  const w1 = Math.max(0.15, 1 - w2 - w0);
  const sum = w0 + w1 + w2;
  return [w0 / sum, w1 / sum, w2 / sum];
}

/** Buckets to try, in order: the one the dice chose, then its tier's other
 *  altitude, then every other bucket. The field has no fallback when its chosen
 *  bucket is empty and sits near-empty at cold start (audit, 2026-09-24); the
 *  sky should show whatever the pool has rather than skip a tick. */
export function bucketOrder(r1, r2, dewpoint, altitude) {
  const w = tierWeights(dewpoint);
  const tier = r1 < w[0] ? 0 : r1 < w[0] + w[1] ? 1 : 2;
  const alt = r2 < altitude ? 1 : 0;
  const first = `w${tier}a${alt}`;
  const sibling = `w${tier}a${1 - alt}`;
  return [first, sibling, ...BUCKETS.filter((b) => b !== first && b !== sibling)];
}

/** Uniform scale from ground units to pixels. Uniform on purpose: the server
 *  measures "nearby" in ground units, so a non-uniform stretch would make what
 *  looks near differ from what counts as near. */
export function groundScale(width, height) {
  return Math.min(width / GROUND_W, height / GROUND_H);
}

export function toScreen(p, scale) {
  return { x: p.x * scale, y: p.y * scale };
}

export function toGround(p, scale) {
  const s = scale > 0 ? scale : 1;
  return {
    x: Math.min(GROUND_W, Math.max(0, p.x / s)),
    y: Math.min(GROUND_H, Math.max(0, p.y / s)),
  };
}

/** Where a word pinned in the sky lands: straight below where it was, in the
 *  top band of the ground, nudged sideways off any word already there. */
export function landingSpot(words, groundX) {
  const y = 70;
  const minGap = 110;
  let x = Math.min(GROUND_W - 60, Math.max(20, groundX));
  for (let i = 0; i < 24; i++) {
    const clash = words.find((w) => Math.abs(w.x - x) < minGap && Math.abs(w.y - y) < 40);
    if (!clash) return { x, y };
    const step = (Math.floor(i / 2) + 1) * minGap * (i % 2 === 0 ? 1 : -1);
    x = Math.min(GROUND_W - 60, Math.max(20, groundX + step));
  }
  return { x, y: y + 60 };
}

/** Rough width of a word in ground units at a given on-screen font size.
 *  Fraunces runs ~0.5em per character; +12 for padding. Only used to keep
 *  boxes apart, so rough is fine. */
export function wordWidth(text, fontPx, scale) {
  const s = scale > 0 ? scale : 1;
  return (String(text).length * fontPx * 0.5 + 12) / s;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Top-left positions (ground units) for dew words of the given widths,
 *  condensing around (cx, cy): a loose ring that starts above the point, each
 *  box pushed outward until it clears every box in `occupied` ({x, y, w, h})
 *  and every dew box already placed. Deterministic given `rand`. */
export function dewSpots(cx, cy, widths, occupied, rand, lineH = 30) {
  const out = [];
  const taken = [...occupied];
  const n = widths.length;
  for (let i = 0; i < n; i++) {
    const w = widths[i];
    let best = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const theta = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2 + (rand() - 0.5) * 0.5 + attempt * 0.4;
      const r = 46 + attempt * 12;
      const x = Math.min(GROUND_W - w, Math.max(0, cx + Math.cos(theta) * r * 1.7 - w / 2));
      const y = Math.min(GROUND_H - lineH, Math.max(0, cy + Math.sin(theta) * r - lineH / 2));
      const box = { x, y, w, h: lineH };
      if (!taken.some((q) => overlaps(q, box))) { best = box; break; }
      if (!best) best = box;
    }
    out.push({ x: best.x, y: best.y });
    taken.push(best);
  }
  return out;
}

/** Midpoint of a thread, where its bridge mark sits and bridge dew condenses. */
export function threadMid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Lifetime of an ephemeral word, ms. Sky words keep the field's 5–10 s; dew
 *  lingers longer (7–12 s) because it answers a question you just asked. */
export function ttl(kind, r) {
  return kind === 'dew' ? 7000 + r * 5000 : 5000 + r * 5000;
}

export function normKey(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}
