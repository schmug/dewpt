// Route shape and the wire contract for /api/board/*.
//
// There is no Durable Object test harness in this repo (issue #31), so nothing
// here exercises BoardDO itself — not its alarm loop, not its pump, not
// rehydration. What IS exercised is everything either side of it: the belt's
// projection onto the wire, and the real route table from src/index.ts driven
// against a stub DO stub. `cloudflare:workers` does not resolve under plain
// vitest, so it is stubbed; that stub is only needed because src/index.ts
// re-exports the DO classes, and it does not touch any code under test.

import { describe, expect, it, vi } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { DEFAULT_STATION_TERMS, type Station } from "../src/board/types";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// Imported after the vi.mock above purely for readability — vitest hoists the
// mock above every import regardless of where it is written.
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
