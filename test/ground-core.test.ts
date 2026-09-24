import { describe, expect, it } from "vitest";
import {
  BRIDGE_COUNT,
  GROUND_H,
  GROUND_W,
  MAX_THREADS,
  NEIGHBOR_RADIUS,
  PROSPECT_COUNT,
  applyGroundOp,
  autoPlace,
  bridgeScore,
  decodeScene,
  groundKey,
  nearScore,
  neighborhood,
  parseGroundOp,
  pruneToAnchors,
  queryVector,
  toExcalidrawScene,
  topK,
  type GroundScene,
} from "../src/ground-core";

const scene = (words: [string, number, number][], threads: [string, string][] = []): GroundScene => ({
  words: words.map(([text, x, y]) => ({ text, tier: 1, x, y, pinnedAt: 1 })),
  threads: threads.map(([a, b]) => ({ a, b })),
});
const anchors = (...texts: string[]) => texts.map((text) => ({ text, tier: 2 as const, pinnedAt: 1 }));

describe("pruneToAnchors — the ephemerality guard", () => {
  it("drops a word that is no longer an anchor, and every thread touching it", () => {
    const s = scene([["a", 10, 10], ["b", 200, 10], ["c", 400, 10]], [["a", "b"], ["b", "c"], ["a", "c"]]);
    const out = pruneToAnchors(s, anchors("a", "c"));
    expect(out.words.map((w) => w.text)).toEqual(["a", "c"]);
    expect(out.threads).toEqual([{ a: "a", b: "c" }]);
  });

  it("never invents a word that is not an anchor", () => {
    const out = pruneToAnchors(scene([["ghost", 1, 1]]), anchors());
    expect(out.words).toEqual([]);
  });

  it("places an anchor that was pinned elsewhere (same session, /app or /drift)", () => {
    const out = pruneToAnchors(scene([["a", 10, 10]]), anchors("a", "pinned in the field"));
    expect(out.words.map((w) => w.text)).toEqual(["a", "pinned in the field"]);
    const placed = out.words[1]!;
    expect(placed.x).toBeGreaterThanOrEqual(0);
    expect(placed.x).toBeLessThanOrEqual(GROUND_W);
    expect(placed.y).toBeLessThanOrEqual(GROUND_H);
  });

  it("matches anchors by normalised text and adopts the anchor's spelling", () => {
    const out = pruneToAnchors(scene([["  Night  Bus ", 5, 5]]), anchors("night bus"));
    expect(out.words).toHaveLength(1);
    expect(out.words[0]!.text).toBe("night bus");
    expect(out.words[0]!.x).toBe(5);
  });

  it("is idempotent — a second read agrees with the first", () => {
    const once = pruneToAnchors(scene([]), anchors("a", "b", "c", "d"));
    expect(pruneToAnchors(once, anchors("a", "b", "c", "d"))).toEqual(once);
  });

  it("a word unpinned and pinned again comes back fresh — no old position, no old threads", () => {
    const s = scene([["a", 10, 10], ["b", 700, 300]], [["a", "b"]]);
    const repinned = [{ text: "a", tier: 2 as const, pinnedAt: 1 }, { text: "b", tier: 2 as const, pinnedAt: 99 }];
    const out = pruneToAnchors(s, repinned);
    expect(out.threads).toEqual([]);
    const b = out.words.find((w) => w.text === "b")!;
    expect(b.pinnedAt).toBe(99);
    expect([b.x, b.y]).not.toEqual([700, 300]);
  });

  it("drops a duplicate persisted entry for one anchor", () => {
    const out = pruneToAnchors(scene([["a", 10, 10], ["A", 500, 10]]), anchors("a"));
    expect(out.words).toHaveLength(1);
    expect(out.words[0]!.x).toBe(10);
  });

  it("drops a self-thread even if one was persisted", () => {
    const out = pruneToAnchors(scene([["a", 1, 1]], [["a", "A"]]), anchors("a"));
    expect(out.threads).toEqual([]);
  });
});

describe("autoPlace", () => {
  it("keeps a gap from placed words and is deterministic", () => {
    const placed = scene([["x", GROUND_W / 2, GROUND_H / 2]]).words;
    const p = autoPlace(placed, "new word");
    expect(Math.hypot(p.x - GROUND_W / 2, p.y - GROUND_H / 2)).toBeGreaterThanOrEqual(90);
    expect(autoPlace(placed, "new word")).toEqual(p);
  });
});

describe("parseGroundOp — untrusted input", () => {
  it("accepts well-formed ops", () => {
    expect(parseGroundOp({ op: "move", text: "a", x: 1, y: 2 })).toEqual({ op: "move", text: "a", x: 1, y: 2 });
    expect(parseGroundOp({ op: "thread", a: "a", b: "b" })).toEqual({ op: "thread", a: "a", b: "b" });
  });
  it.each([
    null,
    "move",
    { op: "move", text: "a", x: "1", y: 2 },
    { op: "move", text: "a", x: Infinity, y: 2 },
    { op: "move", text: "", x: 1, y: 2 },
    { op: "move", text: "x".repeat(65), x: 1, y: 2 },
    { op: "thread", a: "a", b: " A " },
    { op: "thread", a: "a" },
    { op: "place", text: "a", x: 1, y: 1 },
  ])("rejects %j", (raw) => {
    expect(parseGroundOp(raw)).toBeNull();
  });
});

describe("applyGroundOp", () => {
  const base = scene([["a", 10, 10], ["b", 300, 10]]);

  it("moves a word and clamps it to the ground", () => {
    const { scene: s, ok } = applyGroundOp(base, { op: "move", text: "a", x: -50, y: 99999 });
    expect(ok).toBe(true);
    expect(s.words[0]).toMatchObject({ x: 0, y: GROUND_H });
  });

  it("refuses to move or thread a word that is not on the ground — only pinning places words", () => {
    expect(applyGroundOp(base, { op: "move", text: "zzz", x: 1, y: 1 })).toMatchObject({ ok: false, reason: "unknown-word" });
    expect(applyGroundOp(base, { op: "thread", a: "a", b: "zzz" })).toMatchObject({ ok: false, reason: "unknown-word" });
  });

  it("threads are unordered and deduplicated", () => {
    const one = applyGroundOp(base, { op: "thread", a: "a", b: "b" }).scene;
    const two = applyGroundOp(one, { op: "thread", a: "B", b: "a" }).scene;
    expect(two.threads).toEqual([{ a: "a", b: "b" }]);
    const cut = applyGroundOp(two, { op: "unthread", a: "b", b: "a" }).scene;
    expect(cut.threads).toEqual([]);
  });

  it("caps threads", () => {
    const many = scene(Array.from({ length: 30 }, (_, i) => [`w${i}`, i * 10, 0] as [string, number, number]));
    let s = many;
    let refused = 0;
    for (let i = 1; i < 30; i++) {
      const r = applyGroundOp(s, { op: "thread", a: "w0", b: `w${i}` });
      if (!r.ok) { refused++; expect(r.reason).toBe("thread-cap"); }
      s = r.scene;
    }
    expect(s.threads).toHaveLength(MAX_THREADS);
    expect(refused).toBe(29 - MAX_THREADS);
  });
});

describe("decodeScene", () => {
  it("survives corrupt or hostile persisted JSON", () => {
    expect(decodeScene(undefined)).toEqual({ words: [], threads: [] });
    expect(decodeScene("{not json")).toEqual({ words: [], threads: [] });
    expect(decodeScene(JSON.stringify({ words: [{ text: "a", x: "1", y: 1, tier: 1, pinnedAt: 1 }, { text: "b", x: 1, y: 1, tier: 7, pinnedAt: 1 }, { text: "c", x: 1, y: 1, tier: 1 }] })).words).toEqual([]);
  });
});

describe("neighborhood", () => {
  it("weights nearer words more and ignores words beyond the radius", () => {
    const s = scene([["near", 100, 100], ["mid", 250, 100], ["far", 100 + NEIGHBOR_RADIUS + 1, 100]]);
    const n = neighborhood(s, 100, 100);
    expect(n.map((x) => x.text)).toEqual(["near", "mid"]);
    expect(n[0]!.weight).toBeGreaterThan(n[1]!.weight);
  });
  it("is empty on open ground", () => {
    expect(neighborhood(scene([["a", 0, 0]]), GROUND_W, GROUND_H)).toEqual([]);
  });
});

describe("queryVector", () => {
  it("is the normalised weighted mean of unit vectors", () => {
    const q = queryVector([
      { embedding: [2, 0], weight: 1 },
      { embedding: [0, 5], weight: 1 },
    ])!;
    expect(q[0]).toBeCloseTo(Math.SQRT1_2);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2);
  });
  it("skips unembedded anchors and returns null when none are ready", () => {
    expect(queryVector([{ embedding: null, weight: 1 }])).toBeNull();
    expect(queryVector([{ embedding: null, weight: 1 }, { embedding: [0, 3], weight: 0.2 }])).toEqual([0, 1]);
  });
});

describe("scores and ranking", () => {
  const X = [1, 0, 0];
  const Y = [0, 1, 0];
  const pool = [
    [1, 0, 0], // synonym of X
    [0, 1, 0], // synonym of Y
    [1, 1, 0], // between
    [0, 0, 1], // unrelated
  ];

  it("bridgeScore prefers the candidate near BOTH ends over a synonym of one", () => {
    const ranked = topK(pool, bridgeScore(X, Y), 4);
    expect(ranked[0]).toBe(2);
  });

  it("nearScore ranks by closeness to the query", () => {
    expect(topK(pool, nearScore(X), 1)).toEqual([0]);
  });

  it("topK is stable on ties and honours skip", () => {
    expect(topK([1, 1, 1], () => 0, 2)).toEqual([0, 1]);
    expect(topK([5, 4, 3], (v) => v, 2, (v) => v === 5)).toEqual([1, 2]);
  });

  it("condenses a field-sized burst and a smaller thread answer", () => {
    expect(PROSPECT_COUNT).toBeGreaterThanOrEqual(4);
    expect(PROSPECT_COUNT).toBeLessThanOrEqual(5);
    expect(BRIDGE_COUNT).toBeLessThan(PROSPECT_COUNT);
  });
});

describe("toExcalidrawScene — M5 export", () => {
  const s = scene([["night bus", 100, 100], ["fare capping", 500, 300]], [["night bus", "fare capping"]]);
  const out = toExcalidrawScene(s, "public transit") as { type: string; version: number; elements: Record<string, unknown>[]; appState: Record<string, unknown> };

  it("is an Excalidraw v2 file on the night background", () => {
    expect(out.type).toBe("excalidraw");
    expect(out.version).toBe(2);
    expect(out.appState.viewBackgroundColor).toBe("#0d0c14");
  });

  it("has one text element per word and one bound arrow per thread, with bindings on both sides", () => {
    const texts = out.elements.filter((e) => e.type === "text");
    const arrows = out.elements.filter((e) => e.type === "arrow");
    expect(texts.map((t) => t.text)).toEqual(["night bus", "fare capping"]);
    expect(arrows).toHaveLength(1);
    const arrow = arrows[0]!;
    const ids = texts.map((t) => t.id);
    expect((arrow.startBinding as { elementId: string }).elementId).toBe(ids[0]);
    expect((arrow.endBinding as { elementId: string }).elementId).toBe(ids[1]);
    for (const t of texts) expect(t.boundElements).toEqual([{ type: "arrow", id: arrow.id }]);
  });

  it("uses stable ids so two exports of one ground diff cleanly", () => {
    expect(toExcalidrawScene(s, "public transit")).toEqual(out);
    expect(new Set(out.elements.map((e) => e.id)).size).toBe(out.elements.length);
  });

  it("carries the words verbatim — no HTML, no escaping games", () => {
    const hostile = scene([["</script><b>x</b>", 1, 1]]);
    const t = (toExcalidrawScene(hostile, "s").elements as Record<string, unknown>[])[0]!;
    expect(t.text).toBe("</script><b>x</b>");
    expect(groundKey(t.text as string)).toBe("</script><b>x</b>");
  });
});

import { edgePoint, openScore, parseBridgeBody, parseProspectBody, planBridge, planProspect, planScore } from "../src/ground-core";

describe("planProspect / planBridge", () => {
  const s = scene([["night bus", 100, 100], ["last train", 160, 110], ["fare capping", 900, 400]], [["night bus", "fare capping"]]);
  const emb = (text: string, embedding: number[] | null) => ({ text, tier: 1 as const, pinnedAt: 1, embedding });
  const anchorsE = [emb("night bus", [1, 0, 0]), emb("last train", [0.8, 0.2, 0]), emb("fare capping", [0, 0, 1])];

  it("near a cluster, the query is built from that cluster only", () => {
    const plan = planProspect(s, anchorsE, 120, 100);
    expect(plan.mode).toBe("near");
    if (plan.mode !== "near") return;
    expect(plan.basis).toEqual(["night bus", "last train"]);
    expect(plan.query[2]).toBeCloseTo(0);
  });

  it("on open ground, or when nearby anchors are not embedded yet, falls back to open sky", () => {
    expect(planProspect(s, anchorsE, 600, 20).mode).toBe("open");
    expect(planProspect(s, [emb("night bus", null), emb("last train", null)], 120, 100).mode).toBe("open");
  });

  it("a bridge needs an existing thread", () => {
    expect(planBridge(s, anchorsE, "night bus", "last train")).toBeNull();
    const plan = planBridge(s, anchorsE, "Fare Capping", "night bus");
    expect(plan?.mode).toBe("bridge");
  });

  it("planScore routes each mode to its score", () => {
    const near = planScore({ mode: "near", query: [1, 0], basis: [] }, () => 0);
    expect(near({ embedding: [1, 0], seedDist: 0 })).toBeCloseTo(1);
    const bridge = planScore({ mode: "bridge", a: [1, 0], b: [0, 1], basis: ["a", "b"] }, () => 0);
    expect(bridge({ embedding: [1, 1], seedDist: 0 })).toBeGreaterThan(bridge({ embedding: [1, 0], seedDist: 0 }));
    const open = planScore({ mode: "open", basis: [] }, () => 0);
    expect(open({ embedding: [], seedDist: 0.7 })).toBeCloseTo(0.7);
    expect(openScore(() => 1)(0.5)).toBeCloseTo(0.65);
  });
});

describe("request bodies", () => {
  it("prospect clamps and caps visible", () => {
    const b = parseProspectBody({ x: -5, y: 1e9, visible: [...Array(60)].map((_, i) => `w${i}`).concat([7 as never]) });
    expect(b).toMatchObject({ x: 0, y: GROUND_H });
    expect(b!.visible).toHaveLength(40);
    expect(parseProspectBody({ x: NaN, y: 1 })).toBeNull();
    expect(parseProspectBody(null)).toBeNull();
  });
  it("bridge needs two different words", () => {
    expect(parseBridgeBody({ a: "x", b: "y" })).toEqual({ a: "x", b: "y", visible: [] });
    expect(parseBridgeBody({ a: "x", b: "X" })).toBeNull();
  });
});

describe("edgePoint", () => {
  it("leaves a box through its side for a horizontal ray and its top for a vertical one", () => {
    expect(edgePoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, 10)).toEqual({ x: 20, y: 0 });
    expect(edgePoint({ x: 0, y: 0 }, { x: 0, y: -100 }, 20, 10)).toEqual({ x: 0, y: -10 });
    expect(edgePoint({ x: 5, y: 5 }, { x: 5, y: 5 }, 20, 10)).toEqual({ x: 5, y: 5 });
  });
});
