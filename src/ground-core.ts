// Pure logic for the ground: the surface under the weather where pinned words
// land and the user arranges them. No bindings, no storage, no I/O — the
// SessionDO hydrates a scene, calls in here, and persists the result.
//
// The ground holds ONLY what the anchors table holds (pinned or user-added
// words) plus threads between two of them. Nothing unpinned is ever placed
// here, and pruneToAnchors() is applied on every read and write, so unpinning
// a word from any surface removes it from the ground and cuts its threads.
// That is the ephemerality guardrail (SPEC.md, CLAUDE.md), enforced in one
// function with its own tests, rather than a convention.
//
// Spatial arrangement feeds back into the weather through two gestures, both
// served by RE-RANKING the pool the DO already holds — never by an inline AI
// call, so pool depth is untouched:
//   prospect at a point  → the pinned words near that point, weighted by
//                          ground distance, form a query; the pool is ranked
//                          by cosine to it.
//   a thread A — B       → the pool is ranked by min(cos(c,A), cos(c,B)), the
//                          candidates that sit near BOTH ends at once.
// Whether that re-ranking is perceptible is the riskiest assumption of this
// design; scripts/ground-spike.ts measures it with a blind judge.

import { cosineSim } from "./pool-core";
import type { Tier } from "./types";

// ── geometry ───────────────────────────────────────────────────────────────

/** Ground coordinate space. The client scales it to whatever rectangle it has,
 *  so positions survive a resize and mean the same thing on every device. */
export const GROUND_W = 1200;
export const GROUND_H = 420;

/** UNMEASURED — a judgement call, not a result. How far (ground units) a pinned
 *  word reaches when a prospect lands near it. ~1/5 of the ground width: close
 *  enough that "next to this cluster" means one cluster, not the whole ground. */
export const NEIGHBOR_RADIUS = 240;
/** UNMEASURED. Gaussian falloff inside the radius; the nearest word dominates
 *  but its neighbours still tilt the query. */
export const NEIGHBOR_SIGMA = 120;
/** Words condensed per ground prospect. Matches the field's 4–5 word burst
 *  (SPEC.md core loop step 3). */
export const PROSPECT_COUNT = 5;
/** Words condensed along a thread. Fewer than a prospect: a thread asks one
 *  question ("what connects these?"), and three answers can sit along it
 *  without overprinting at the field's density cap. UNMEASURED. */
export const BRIDGE_COUNT = 3;
/** Hard cap on threads. A legibility limit like the field's CAP = 14, not a
 *  performance guard. UNMEASURED. */
export const MAX_THREADS = 24;

export interface GroundWord {
  /** The anchor's text, as the anchors table spells it. */
  text: string;
  tier: Tier;
  x: number;
  y: number;
}

export interface Thread {
  a: string;
  b: string;
}

export interface GroundScene {
  words: GroundWord[];
  threads: Thread[];
}

export const EMPTY_SCENE: GroundScene = { words: [], threads: [] };

export function groundKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function clampPoint(x: number, y: number): { x: number; y: number } {
  return { x: clamp(x, 0, GROUND_W), y: clamp(y, 0, GROUND_H) };
}

function sameThread(t: Thread, a: string, b: string): boolean {
  const ka = groundKey(a);
  const kb = groundKey(b);
  const ta = groundKey(t.a);
  const tb = groundKey(t.b);
  return (ta === ka && tb === kb) || (ta === kb && tb === ka);
}

// ── the ephemerality guard ──────────────────────────────────────────────────

export interface AnchorLike {
  text: string;
  tier: Tier;
}

/** Reconcile the scene with the anchors table: drop words that are no longer
 *  anchors (and every thread touching them), and place anchors that have never
 *  been placed — a word pinned from /app or /drift lands here too, because
 *  it is one session. Placement is deterministic so two reads agree. */
export function pruneToAnchors(scene: GroundScene, anchors: readonly AnchorLike[]): GroundScene {
  const live = new Map(anchors.map((a) => [groundKey(a.text), a]));
  const words = scene.words
    .filter((w) => live.has(groundKey(w.text)))
    .map((w) => ({ ...w, text: live.get(groundKey(w.text))!.text }));
  const placed = new Set(words.map((w) => groundKey(w.text)));
  for (const a of anchors) {
    const key = groundKey(a.text);
    if (placed.has(key)) continue;
    const at = autoPlace(words, a.text);
    words.push({ text: a.text, tier: a.tier, ...at });
    placed.add(key);
  }
  const threads = scene.threads.filter(
    (t) => placed.has(groundKey(t.a)) && placed.has(groundKey(t.b)) && groundKey(t.a) !== groundKey(t.b),
  );
  return { words, threads };
}

/** A free spot for a word that arrived without a position. Walks a golden-angle
 *  spiral from a text-hashed start near the centre, taking the first point far
 *  enough from every placed word. Deterministic in (placed, text). */
export function autoPlace(placed: readonly GroundWord[], text: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  const start = ((h >>> 0) % 360) * (Math.PI / 180);
  const minGap = 90;
  for (let i = 0; i < 400; i++) {
    const r = 18 * Math.sqrt(i);
    const theta = start + i * 2.39996;
    const p = clampPoint(GROUND_W / 2 + r * Math.cos(theta) * 1.8, GROUND_H / 2 + r * Math.sin(theta));
    if (placed.every((w) => Math.hypot(w.x - p.x, w.y - p.y) >= minGap)) return p;
  }
  return { x: GROUND_W / 2, y: GROUND_H / 2 };
}

// ── operations (untrusted input) ────────────────────────────────────────────

export type GroundOp =
  | { op: "move"; text: string; x: number; y: number }
  | { op: "thread"; a: string; b: string }
  | { op: "unthread"; a: string; b: string };

const MAX_OP_TEXT = 64;

/** Validate a client-supplied op. Returns null for anything malformed — the
 *  route answers 400 and the scene is untouched. */
export function parseGroundOp(raw: unknown): GroundOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= MAX_OP_TEXT ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (r.op === "move") {
    const text = str(r.text), x = num(r.x), y = num(r.y);
    return text && x !== null && y !== null ? { op: "move", text, x, y } : null;
  }
  if (r.op === "thread" || r.op === "unthread") {
    const a = str(r.a), b = str(r.b);
    if (!a || !b || groundKey(a) === groundKey(b)) return null;
    return { op: r.op, a, b };
  }
  return null;
}

/** Apply an op to an ALREADY-PRUNED scene. Ops naming words that are not on
 *  the ground are refused rather than creating them — only pinning puts a
 *  word on the ground. */
export function applyGroundOp(
  scene: GroundScene,
  op: GroundOp,
): { scene: GroundScene; ok: boolean; reason?: "unknown-word" | "thread-cap" } {
  const has = (t: string) => scene.words.some((w) => groundKey(w.text) === groundKey(t));
  if (op.op === "move") {
    if (!has(op.text)) return { scene, ok: false, reason: "unknown-word" };
    const p = clampPoint(op.x, op.y);
    return {
      scene: {
        words: scene.words.map((w) => (groundKey(w.text) === groundKey(op.text) ? { ...w, ...p } : w)),
        threads: scene.threads,
      },
      ok: true,
    };
  }
  if (!has(op.a) || !has(op.b)) return { scene, ok: false, reason: "unknown-word" };
  if (op.op === "unthread") {
    return { scene: { words: scene.words, threads: scene.threads.filter((t) => !sameThread(t, op.a, op.b)) }, ok: true };
  }
  if (scene.threads.some((t) => sameThread(t, op.a, op.b))) return { scene, ok: true };
  if (scene.threads.length >= MAX_THREADS) return { scene, ok: false, reason: "thread-cap" };
  const text = (t: string) => scene.words.find((w) => groundKey(w.text) === groundKey(t))!.text;
  return { scene: { words: scene.words, threads: [...scene.threads, { a: text(op.a), b: text(op.b) }] }, ok: true };
}

/** Defensive decode of a persisted scene. Corrupt JSON yields the empty scene
 *  rather than a DO that cannot start. */
export function decodeScene(raw: string | undefined): GroundScene {
  if (!raw) return { words: [], threads: [] };
  try {
    const v = JSON.parse(raw) as Partial<GroundScene>;
    const words = Array.isArray(v.words)
      ? v.words.filter(
          (w): w is GroundWord =>
            !!w && typeof w.text === "string" && Number.isFinite(w.x) && Number.isFinite(w.y) && [0, 1, 2].includes(w.tier as number),
        )
      : [];
    const threads = Array.isArray(v.threads)
      ? v.threads.filter((t): t is Thread => !!t && typeof t.a === "string" && typeof t.b === "string")
      : [];
    return { words, threads };
  } catch {
    return { words: [], threads: [] };
  }
}

// ── conditioning: where you are on the ground is what condenses ─────────────

export interface Neighbor {
  text: string;
  weight: number;
}

/** Pinned words within NEIGHBOR_RADIUS of (x, y), Gaussian-weighted by ground
 *  distance, heaviest first. Empty means open ground: nothing nearby to
 *  condense against. */
export function neighborhood(scene: GroundScene, x: number, y: number): Neighbor[] {
  const out: Neighbor[] = [];
  for (const w of scene.words) {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d > NEIGHBOR_RADIUS) continue;
    out.push({ text: w.text, weight: Math.exp(-(d * d) / (2 * NEIGHBOR_SIGMA * NEIGHBOR_SIGMA)) });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

function unit(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}

/** Weighted mean of unit-normalised embeddings, normalised. Returns null when
 *  no weighted item has an embedding yet (an anchor is embedded lazily, by the
 *  pump, just after it is pinned). */
export function queryVector(items: readonly { embedding: number[] | null; weight: number }[]): number[] | null {
  let acc: number[] | null = null;
  for (const it of items) {
    if (!it.embedding || it.embedding.length === 0 || !(it.weight > 0)) continue;
    const u = unit(it.embedding);
    if (!acc) acc = new Array<number>(u.length).fill(0);
    for (let i = 0; i < Math.min(acc.length, u.length); i++) acc[i]! += it.weight * u[i]!;
  }
  return acc ? unit(acc) : null;
}

/** Score for "condenses next to this cluster". */
export function nearScore(query: number[]): (embedding: number[]) => number {
  return (e) => cosineSim(e, query);
}

/** Score for "connects A and B": the weaker of the two affinities, so a
 *  candidate that is simply a near-synonym of one end scores no better than
 *  its affinity to the OTHER end. This is what stops a bridge collapsing onto
 *  one pole — the failure the axis walk showed a point-seeking loop falls into
 *  (docs/measurements/2026-08-22-drift-mechanic-spikes.md, run 1 null). */
export function bridgeScore(a: number[], b: number[]): (embedding: number[]) => number {
  return (e) => Math.min(cosineSim(e, a), cosineSim(e, b));
}

/** Indices of the top `k` items by score, highest first, skipping any index for
 *  which `skip` returns true. Stable on ties (lower index first) so the spike
 *  and the DO agree exactly. */
export function topK<T>(items: readonly T[], score: (item: T) => number, k: number, skip?: (item: T) => boolean): number[] {
  const scored: { i: number; s: number }[] = [];
  items.forEach((it, i) => {
    if (skip?.(it)) return;
    const s = score(it);
    if (Number.isFinite(s)) scored.push({ i, s });
  });
  scored.sort((p, q) => q.s - p.s || p.i - q.i);
  return scored.slice(0, Math.max(0, k)).map((p) => p.i);
}

// ── export (M5): the ground as an Excalidraw scene ──────────────────────────

/** Scene colours. Mirrors the palette in public/styles.css so an
 *  exported ground reads as dewpt when opened in Excalidraw. */
const EXPORT_BG = "#0d0c14";
const EXPORT_GOLD = "#f0d98c"; // --pin in public/styles.css
const EXPORT_THREAD = "#9a97b0"; // --label
/** Excalidraw's FONT_FAMILY enum: 5 = Excalifont, 6 = Nunito. Its font set is
 *  closed (no custom families), so Fraunces cannot travel with the file;
 *  Nunito is the calmest of the eight. */
const EXPORT_FONT = 6;
const EXPORT_SIZE = 20;

function stableId(prefix: string, text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

function seedFor(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h % 2147483647 || 1;
}

/** Where the ray from `from` toward `to` leaves a box of half-size (hw, hh)
 *  centred on `from`. */
export function edgePoint(from: { x: number; y: number }, to: { x: number; y: number }, hw: number, hh: number): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { ...from };
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: from.x + dx * Math.min(1, t), y: from.y + dy * Math.min(1, t) };
}

/** An `.excalidraw` file (schema version 2) for the ground: one text element per
 *  pinned word, one bound, headless arrow per thread. Excalidraw's restore()
 *  recomputes text metrics on load, so widths here are estimates. The FORMAT
 *  is the interop decision; the Excalidraw runtime is not a dependency. */
export function toExcalidrawScene(scene: GroundScene, seed: string, now = 0): Record<string, unknown> {
  const idOf = new Map(scene.words.map((w) => [groundKey(w.text), stableId("w", groundKey(w.text))]));
  const threadIds = scene.threads.map((t) => stableId("t", `${groundKey(t.a)}|${groundKey(t.b)}`));
  const base = {
    angle: 0,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    version: 1,
    isDeleted: false,
    updated: now,
    link: null,
    locked: false,
  };
  const size = (w: GroundWord) => ({ width: Math.ceil(w.text.length * EXPORT_SIZE * 0.55), height: Math.ceil(EXPORT_SIZE * 1.25) });
  const texts = scene.words.map((w) => {
    const key = groundKey(w.text);
    const bound = scene.threads
      .map((t, i) => ({ t, id: threadIds[i]! }))
      .filter(({ t }) => groundKey(t.a) === key || groundKey(t.b) === key)
      .map(({ id }) => ({ type: "arrow", id }));
    return {
      ...base,
      id: idOf.get(key)!,
      type: "text",
      x: Math.round(w.x),
      y: Math.round(w.y),
      ...size(w),
      strokeColor: EXPORT_GOLD,
      seed: seedFor(key),
      versionNonce: seedFor(`${key}#`),
      boundElements: bound,
      text: w.text,
      originalText: w.text,
      fontSize: EXPORT_SIZE,
      fontFamily: EXPORT_FONT,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    };
  });
  const byKey = new Map(scene.words.map((w) => [groundKey(w.text), w]));
  const arrows = scene.threads.map((t, i) => {
    const a = byKey.get(groundKey(t.a))!;
    const b = byKey.get(groundKey(t.b))!;
    const sa = size(a), sb = size(b);
    // Centre to centre, then pulled back to each box's edge so the thread
    // meets the word rather than striking through it.
    const ca = { x: a.x + sa.width / 2, y: a.y + sa.height / 2 };
    const cb = { x: b.x + sb.width / 2, y: b.y + sb.height / 2 };
    const { x: x0, y: y0 } = edgePoint(ca, cb, sa.width / 2 + 6, sa.height / 2 + 6);
    const { x: x1, y: y1 } = edgePoint(cb, ca, sb.width / 2 + 6, sb.height / 2 + 6);
    return {
      ...base,
      id: threadIds[i]!,
      type: "arrow",
      x: Math.round(x0),
      y: Math.round(y0),
      width: Math.abs(Math.round(x1 - x0)),
      height: Math.abs(Math.round(y1 - y0)),
      strokeColor: EXPORT_THREAD,
      strokeStyle: "dashed",
      seed: seedFor(threadIds[i]!),
      versionNonce: seedFor(`${threadIds[i]!}#`),
      boundElements: null,
      points: [
        [0, 0],
        [Math.round(x1 - x0), Math.round(y1 - y0)],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: idOf.get(groundKey(t.a))!, focus: 0, gap: 6 },
      endBinding: { elementId: idOf.get(groundKey(t.b))!, focus: 0, gap: 6 },
      startArrowhead: null,
      endArrowhead: null,
      elbowed: false,
    };
  });
  return {
    type: "excalidraw",
    version: 2,
    source: `https://dewpt.cortech.online/ground/ — seed: ${seed}`,
    elements: [...texts, ...arrows],
    appState: { viewBackgroundColor: EXPORT_BG, gridSize: null },
    files: {},
  };
}

// ── plans: what the DO should draw for a gesture ────────────────────────────
// The DO executes these; deciding lives here so it is tested without a DO.

export interface AnchorWithEmbedding extends AnchorLike {
  embedding: number[] | null;
}

export type DrawPlan =
  /** Rank the pool by closeness to the query built from these pinned words. */
  | { mode: "near"; query: number[]; basis: string[] }
  /** Rank by min affinity to both ends of a thread. */
  | { mode: "bridge"; a: number[]; b: number[]; basis: [string, string] }
  /** Nothing pinned nearby (or not embedded yet): condense from open sky,
   *  slightly stranger than the ambient rate, as the field's prospect does. */
  | { mode: "open"; basis: string[] };

function embeddingOf(anchors: readonly AnchorWithEmbedding[], text: string): number[] | null {
  const a = anchors.find((x) => groundKey(x.text) === groundKey(text));
  return a?.embedding && a.embedding.length > 0 ? a.embedding : null;
}

export function planProspect(scene: GroundScene, anchors: readonly AnchorWithEmbedding[], x: number, y: number): DrawPlan {
  const near = neighborhood(scene, x, y);
  const query = queryVector(near.map((n) => ({ embedding: embeddingOf(anchors, n.text), weight: n.weight })));
  if (!query) return { mode: "open", basis: [] };
  return { mode: "near", query, basis: near.filter((n) => embeddingOf(anchors, n.text)).map((n) => n.text) };
}

export function planBridge(scene: GroundScene, anchors: readonly AnchorWithEmbedding[], a: string, b: string): DrawPlan | null {
  const threaded = scene.threads.some(
    (t) =>
      (groundKey(t.a) === groundKey(a) && groundKey(t.b) === groundKey(b)) ||
      (groundKey(t.a) === groundKey(b) && groundKey(t.b) === groundKey(a)),
  );
  if (!threaded) return null;
  const ea = embeddingOf(anchors, a);
  const eb = embeddingOf(anchors, b);
  if (!ea || !eb) return { mode: "open", basis: [] };
  return { mode: "bridge", a: ea, b: eb, basis: [a, b] };
}

/** Open-sky score: stranger first (higher seed distance), with a little
 *  jitter so two open prospects do not condense the same five words. */
export function openScore(rand: () => number): (seedDist: number) => number {
  return (seedDist) => seedDist + rand() * 0.15;
}

export function planScore(plan: DrawPlan, rand: () => number): (c: { embedding: number[]; seedDist: number }) => number {
  if (plan.mode === "near") {
    const s = nearScore(plan.query);
    return (c) => s(c.embedding);
  }
  if (plan.mode === "bridge") {
    const s = bridgeScore(plan.a, plan.b);
    return (c) => s(c.embedding);
  }
  const s = openScore(rand);
  return (c) => s(c.seedDist);
}

// ── request bodies (untrusted) ──────────────────────────────────────────────

const MAX_VISIBLE = 40;

function parseVisible(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string" && t.length <= MAX_OP_TEXT).slice(0, MAX_VISIBLE);
}

/** `{x, y, visible?}` — visible is what the client already shows, so the
 *  draw does not condense a duplicate beside its twin. */
export function parseProspectBody(raw: unknown): { x: number; y: number; visible: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== "number" || typeof r.y !== "number" || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  const p = clampPoint(r.x, r.y);
  return { ...p, visible: parseVisible(r.visible) };
}

export function parseBridgeBody(raw: unknown): { a: string; b: string; visible: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const op = parseGroundOp({ op: "thread", a: r.a, b: r.b });
  if (!op || op.op !== "thread") return null;
  return { a: op.a, b: op.b, visible: parseVisible(r.visible) };
}
