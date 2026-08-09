// Route shape and the wire contract for /api/board/*.
//
// There is no Durable Object test harness in this repo (issue #31), so nothing
// here drives BoardDO as an object — not its alarm loop, not its rehydration.
// What IS exercised is everything either side of it: the belt's projection onto
// the wire, the real route table from src/index.ts driven against a stub DO
// stub, and the two pieces of the pump that were lifted out of the DO exactly
// so they could be reached without one — `candidateWidth` and `selectFan`.
// `cloudflare:workers` does not resolve under plain vitest, so it is stubbed;
// that stub is only needed because src/index.ts and board-do.ts reference the
// DO base class, and it does not touch any code under test.

import { describe, expect, it, vi } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { scoreCandidates } from "../src/board/rewrite";
import { CANDIDATES_PER_HOP, DEFAULT_STATION_TERMS, SEED_FANOUT, TETHER_FLOOR, type Station } from "../src/board/types";
import { cosineSim } from "../src/pool-core";
import { DEDUPE_COSINE } from "../src/types";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// Imported after the vi.mock above purely for readability — vitest hoists the
// mock above every import regardless of where it is written.
import { candidateWidth, pumpDelayMs, selectFan } from "../src/board/board-do";
import worker, { assertNoEmbeddings } from "../src/index";

/** Collect every key at any depth. The substring form of this guard
 *  (`JSON.stringify(view)).not.toContain("embedding")`) is WRONG: a card whose
 *  text contains the word "embedding" — entirely plausible on a board of
 *  LLM-generated fragments — fails it with nothing leaked. Same helper shape as
 *  test/board-belt-core.test.ts. */
function keysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      keysDeep(inner, found);
    }
  }
  return found;
}

function readyStations(): Station[] {
  return DEFAULT_STATION_TERMS.map((term, i) => ({
    id: `s${i}`,
    order: i + 1,
    term,
    phrase: `a ${term} kind of thing`,
    expanded: true,
    embedding: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0],
  }));
}

// ── the belt's projection onto the wire ─────────────────────────────────────

describe("board wire format", () => {
  it("ships three default stations", () => {
    expect(new BeltCore({ stations: readyStations() }).view().stations).toHaveLength(3);
  });

  it("carries the expanded phrase, which is what the user edits and what gets embedded", () => {
    const [first] = new BeltCore({ stations: readyStations() }).view().stations;
    expect(first!.term).toBe("concretize");
    expect(first!.phrase).not.toBe("concretize");
  });

  it("contains no embedding key anywhere, at any depth", () => {
    const belt = new BeltCore({ stations: readyStations() });
    belt.addSeed("word embedding tricks", 1000); // the input that broke the old substring guard
    belt.applySeedFan(belt.lineages()[0]!.id, [{ text: "rooftop bee lease", embedding: [1, 0, 0] }], 1001);
    const view = belt.view();
    expect(keysDeep(view)).not.toContain("embedding");
    // ...and the text itself survived, which the substring guard forbade.
    expect(JSON.stringify(view)).toContain("word embedding tricks");
  });

  it("uses a key walk that would actually catch a leak", () => {
    // serialize() legitimately carries embeddings. If keysDeep cannot find one
    // here it cannot find one on the wire either, and the guard above passes
    // vacuously.
    const belt = new BeltCore({ stations: readyStations() });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [{ text: "rooftop bee lease", embedding: [1, 0, 0] }], 1001);
    expect(keysDeep(JSON.parse(JSON.stringify(belt.serialize())))).toContain("embedding");
  });

  it("marks a station not ready while its pole is still being embedded", () => {
    const pending = readyStations();
    pending[1]!.embedding = null;
    expect(new BeltCore({ stations: pending }).view().stations[1]!.ready).toBe(false);
  });
});

// ── the seed fan ────────────────────────────────────────────────────────────
//
// The fan is the one place where a hop takes several children out of one
// generation call, and it under-filled silently: `Math.max(CANDIDATES_PER_HOP,
// hop.count)` asked for 4 candidates to fill 3 slots. The board then shipped
// two rows where SEED_FANOUT promises three, permanently — a spawned lineage
// asks for one child from then on, so there is no second chance at a fan.

/** Synthetic embeddings with hand-chosen geometry, so "3 candidates survive the
 *  tether floor and two of them are near-duplicates" is a fact of the fixture
 *  rather than a hope about a model. Eight dimensions: e0 is the parent, e1 the
 *  station phrase, e2+ mutually orthogonal noise that keeps distinct candidates
 *  distinct. */
const FAN_DIM = 8;

function mix(parts: [number, number][]): number[] {
  const v = new Array<number>(FAN_DIM).fill(0);
  for (const [coefficient, axis] of parts) v[axis] = coefficient;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / mag);
}

const FAN_PARENT = mix([[1, 0]]);
const FAN_PHRASE = mix([[1, 1]]);

/** In the order a generation call returns them, so slicing to a width models
 *  what a narrower request actually receives. The first four are M0's measured
 *  minimum: three above the floor, one below it. */
const FAN_CANDIDATES = [
  { text: "cand-top", embedding: mix([[0.5, 0], [0.6, 1], [0.7, 2]]) },
  { text: "cand-twin", embedding: mix([[0.5, 0], [0.61, 1], [0.7, 2]]) }, // near-duplicate of cand-top
  { text: "cand-third", embedding: mix([[0.5, 0], [0.45, 1], [0.7, 3]]) },
  { text: "cand-low", embedding: mix([[0.15, 0], [0.5, 1], [0.7, 4]]) }, // below TETHER_FLOOR
  { text: "cand-fourth", embedding: mix([[0.5, 0], [0.4, 1], [0.7, 5]]) },
  { text: "cand-fifth", embedding: mix([[0.5, 0], [0.35, 1], [0.7, 6]]) },
];

/** What the DO passes as history on a seed's first hop: the seed's own
 *  embedding, so a child cannot restate it. */
const FAN_HISTORY = [FAN_PARENT];

describe("candidateWidth", () => {
  it("adds a candidate per extra child rather than taking a maximum", () => {
    // CANDIDATES_PER_HOP is calibrated PER CHILD, so the two quantities add.
    // Math.max(4, 3) = 4 is the starved formula this replaces.
    expect(candidateWidth(SEED_FANOUT)).toBe(CANDIDATES_PER_HOP + SEED_FANOUT - 1);
    expect(candidateWidth(SEED_FANOUT)).toBeGreaterThan(Math.max(CANDIDATES_PER_HOP, SEED_FANOUT));
    for (const k of [2, 3, 4, 7, 12]) expect(candidateWidth(k)).toBe(CANDIDATES_PER_HOP + k - 1);
  });

  it("leaves a single-child hop at the calibrated width", () => {
    // Every hop after the fan asks for one child, and 4 is what M0 measured for
    // exactly that case. Widening it would spend quota on every hop of every
    // lineage, which the calibration does not support.
    expect(candidateWidth(1)).toBe(CANDIDATES_PER_HOP);
  });

  it("follows SEED_FANOUT, so raising the fan cannot outrun the request", () => {
    // The starved formula saturated: at SEED_FANOUT 5 or 9 it still asked for
    // max(4, k), which is k — one candidate per slot and no spares at all.
    for (const fanout of [5, 9]) {
      expect(candidateWidth(fanout)).toBeGreaterThan(fanout);
    }
  });
});

describe("selectFan", () => {
  it("has the geometry it claims: three survivors, one near-duplicate pair", () => {
    // Without this the fill tests below could pass for the wrong reason.
    const narrow = FAN_CANDIDATES.slice(0, candidateWidth(1));
    const scored = scoreCandidates(FAN_PARENT, FAN_PHRASE, narrow);
    expect(scored.filter((c) => c.tether >= TETHER_FLOOR)).toHaveLength(3);
    expect(scored.find((c) => c.text === "cand-low")!.tether).toBeLessThan(TETHER_FLOOR);
    expect(cosineSim(FAN_CANDIDATES[0]!.embedding, FAN_CANDIDATES[1]!.embedding)).toBeGreaterThan(DEDUPE_COSINE);
    expect(cosineSim(FAN_CANDIDATES[0]!.embedding, FAN_CANDIDATES[2]!.embedding)).toBeLessThan(DEDUPE_COSINE);
  });

  it("under-fills at the old width, which is the defect the width fix exists for", () => {
    // Not a regression guard: this pins WHY the width had to change. Four
    // candidates for three slots loses a whole child to one sibling collision.
    const chosen = selectFan(FAN_PARENT, FAN_PHRASE, FAN_CANDIDATES.slice(0, 4), SEED_FANOUT, FAN_HISTORY, "l1");
    expect(chosen).toHaveLength(2);
  });

  it("fills every slot at the new width, against that same collision", () => {
    const width = candidateWidth(SEED_FANOUT);
    const chosen = selectFan(FAN_PARENT, FAN_PHRASE, FAN_CANDIDATES.slice(0, width), SEED_FANOUT, FAN_HISTORY, "l1");
    expect(chosen).toHaveLength(SEED_FANOUT);
    expect(new Set(chosen.map((c) => c.text)).size).toBe(SEED_FANOUT); // and all distinct
  });

  it("never picks a sibling that near-duplicates one already chosen", () => {
    const chosen = selectFan(FAN_PARENT, FAN_PHRASE, FAN_CANDIDATES, SEED_FANOUT, FAN_HISTORY, "l1");
    for (const a of chosen) {
      for (const b of chosen) {
        if (a.text === b.text) continue;
        expect(cosineSim(a.embedding, b.embedding)).toBeLessThanOrEqual(DEDUPE_COSINE);
      }
    }
  });

  it("reports an under-fill instead of shipping a short board silently", () => {
    // The whole fix exists so a board that promises three rows ships three. If
    // it under-fills anyway, that has to be diagnosable from a log line rather
    // than from a user counting rows.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      selectFan(FAN_PARENT, FAN_PHRASE, FAN_CANDIDATES.slice(0, 4), SEED_FANOUT, FAN_HISTORY, "l-short");
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(warn.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(line).toMatchObject({ level: "warn", lineage: "l-short", requested: SEED_FANOUT, delivered: 2 });

      warn.mockClear();
      selectFan(FAN_PARENT, FAN_PHRASE, FAN_CANDIDATES, SEED_FANOUT, FAN_HISTORY, "l-full");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── the route-boundary guard ────────────────────────────────────────────────

describe("assertNoEmbeddings", () => {
  // BeltCore.view()'s comment calls itself the only path to the wire, but
  // lineages(), serialize(), stations() and hungry() all expose embeddings, so
  // that guarantee rests entirely on BoardDO discipline. This is the check that
  // does not.
  it("passes a clean view through", () => {
    expect(() => assertNoEmbeddings(new BeltCore({ stations: readyStations() }).view())).not.toThrow();
  });

  it("throws on an embedding nested at any depth", () => {
    const belt = new BeltCore({ stations: readyStations() });
    belt.addSeed("urban gardening", 1000);
    // serialize() is the shape a careless refactor would reach for.
    expect(() => assertNoEmbeddings(belt.serialize())).toThrow(/embedding/);
  });

  it("finds an embedding buried under arrays and objects", () => {
    expect(() => assertNoEmbeddings({ a: [{ b: { c: [{ embedding: [1, 2] }] } }] })).toThrow(/embedding/);
  });

  it("does not fire on a card whose text merely mentions embeddings", () => {
    expect(() => assertNoEmbeddings({ lineages: [{ cards: [{ text: "word embedding tricks" }] }] })).not.toThrow();
  });
});

// ── the route table ─────────────────────────────────────────────────────────

interface BoardStub {
  init?: () => Promise<unknown>;
  getView?: () => Promise<unknown>;
  seed?: (text: string) => Promise<unknown>;
}

/** Drive the real exported fetch handler against a stub BOARD_DO. */
function callRoute(
  stub: BoardStub,
  request: Request,
): { response: Promise<Response>; names: string[] } {
  const names: string[] = [];
  const env = {
    BOARD_DO: {
      getByName(name: string) {
        names.push(name);
        return stub;
      },
    },
  };
  const handler = worker as unknown as { fetch(request: Request, env: unknown): Promise<Response> };
  return { response: handler.fetch(request, env), names };
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://dewpt.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const BOARD_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CLEAN_VIEW = { stations: [], lineages: [], evaporated: [] };

describe("POST /api/board", () => {
  it("creates a board and answers 201 with the id it minted", async () => {
    const { response, names } = callRoute({ init: async () => CLEAN_VIEW }, post("/api/board"));
    const res = await response;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(names[0]);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("keeps its own id when the view carries one, rather than adopting the view's", async () => {
    // `json({ id, ...view })` spreads the view AFTER the id, so a BoardView that
    // ever grew its own `id` would silently win and the client would poll the
    // wrong board forever. The route's id must be the one that survives.
    const { response, names } = callRoute(
      { init: async () => ({ ...CLEAN_VIEW, id: "a-view-owned-id" }) },
      post("/api/board"),
    );
    const res = await response;
    expect(res.status).toBe(201); // so this cannot pass vacuously off a 404
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(names[0]);
    expect(body.id).not.toBe("a-view-owned-id");
  });
});

describe("GET /api/board/:id", () => {
  it("returns the view", async () => {
    const { response, names } = callRoute(
      { getView: async () => ({ ...CLEAN_VIEW, lineages: [{ id: "l1", cards: [], arrived: false, atEdge: false }] }) },
      new Request(`https://dewpt.test/api/board/${BOARD_ID}`),
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(names[0]).toBe(BOARD_ID);
    expect(((await res.json()) as { lineages: unknown[] }).lineages).toHaveLength(1);
  });

  it("404s an unknown board", async () => {
    const res = await callRoute({ getView: async () => null }, new Request(`https://dewpt.test/api/board/${BOARD_ID}`)).response;
    expect(res.status).toBe(404);
  });

  it("400s an id that is not a uuid", async () => {
    const res = await callRoute({}, new Request("https://dewpt.test/api/board/not-a-uuid")).response;
    expect(res.status).toBe(400);
  });

  it("404s an unknown subpath", async () => {
    const res = await callRoute({}, new Request(`https://dewpt.test/api/board/${BOARD_ID}/nope`)).response;
    expect(res.status).toBe(404);
  });

  it("refuses to serve a view that leaked an embedding", async () => {
    const leaky = { ...CLEAN_VIEW, lineages: [{ id: "l1", cards: [{ id: "c1", text: "x", embedding: [0.1, 0.2] }] }] };
    const res = await callRoute({ getView: async () => leaky }, new Request(`https://dewpt.test/api/board/${BOARD_ID}`)).response;
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(keysDeep(body)).not.toContain("embedding");
    expect(JSON.stringify(body)).not.toContain("0.2");
  });
});

describe("POST /api/board/:id/seed", () => {
  it("accepts a seed and returns the view", async () => {
    const seen: string[] = [];
    const { response } = callRoute(
      {
        seed: async (text) => {
          seen.push(text);
          return { view: CLEAN_VIEW, accepted: true };
        },
      },
      post(`/api/board/${BOARD_ID}/seed`, { text: "  urban gardening  " }),
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(seen).toEqual(["urban gardening"]); // trimmed by parseText
  });

  it("answers 409 with the view attached when the board is full", async () => {
    // A full board answering 200 with an unchanged view makes the typed word
    // vanish with no error and nothing for `if (!res.ok)` to catch. The view
    // rides along so the client can repaint without a follow-up GET, matching
    // how the axes route pairs a non-2xx with payload data.
    const view = { ...CLEAN_VIEW, lineages: [{ id: "l1", cards: [], arrived: false, atEdge: false }] };
    const res = await callRoute(
      { seed: async () => ({ view, accepted: false }) },
      post(`/api/board/${BOARD_ID}/seed`, { text: "one too many" }),
    ).response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; lineages: unknown[] };
    expect(body.error).toMatch(/full/i);
    expect(body.lineages).toHaveLength(1);
  });

  it("404s a seed against an unknown board", async () => {
    const res = await callRoute({ seed: async () => null }, post(`/api/board/${BOARD_ID}/seed`, { text: "x" })).response;
    expect(res.status).toBe(404);
  });

  it("400s an empty or oversized seed", async () => {
    const empty = await callRoute({}, post(`/api/board/${BOARD_ID}/seed`, { text: "   " })).response;
    expect(empty.status).toBe(400);
    const huge = await callRoute({}, post(`/api/board/${BOARD_ID}/seed`, { text: "x".repeat(65) })).response;
    expect(huge.status).toBe(400);
  });

  it("400s a non-object body", async () => {
    const res = await callRoute({}, post(`/api/board/${BOARD_ID}/seed`)).response;
    expect(res.status).toBe(400);
  });
});

describe("pumpDelayMs", () => {
  const BACKOFF = 500;

  it("waits out the dwell when the only work is a lineage still dwelling", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 9000, edgeParked: false, beltNow: 1000 })).toBe(8000);
  });

  it("never returns less than the backoff, so a saturated board still backs off", () => {
    expect(pumpDelayMs({ backoffMs: 30_000, nextHopAt: 1100, edgeParked: false, beltNow: 1000 })).toBe(30_000);
  });

  it("keeps polling at the backoff while anything is parked at the edge", () => {
    // An edge-parked lineage needs the tick that evicts it, and that tick is
    // due continuously rather than at a computed instant. Letting a long dwell
    // win here would hold a finished card on the belt for the whole dwell past
    // its EDGE_DWELL_MS — visibly wrong, and it breaks ephemerality's timing.
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 20_000, edgeParked: true, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("treats an overdue hop as due now rather than as a negative delay", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 500, edgeParked: false, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("falls back to the backoff when there is no work at all", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: null, edgeParked: false, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("never returns a negative or non-finite delay", () => {
    for (const nextHopAt of [null, -1e9, 0, 1e9]) {
      for (const beltNow of [0, 1e9]) {
        const delay = pumpDelayMs({ backoffMs: BACKOFF, nextHopAt, edgeParked: false, beltNow });
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
