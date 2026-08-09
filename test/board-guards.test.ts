// The four cross-cutting guards the conveyor-board design names under
// §Testing: never-blocks, wire format, ephemerality, capacity — plus a fifth
// the design doc does NOT name, read-path cost, added after the read path was
// found writing to storage on every poll. They live in one file because each of
// them spans several modules — the belt, the DO's read path and the route table
// — and because a reader looking for "the rules that must not silently rot"
// should find them together rather than scattered through the per-module
// suites.
//
// Each of these was checked by breaking the implementation and watching the
// test go red. A guard that has never failed is decoration, and this build has
// already shipped two of those. Where a guard could only be written as a
// vacuous check, it is paired with a companion assertion that proves the check
// can still see what it is looking for.
//
// LIMITS, stated up front so this file is not mistaken for proof that the board
// works: there is still no Durable Object test harness in this repo (issue
// #31), so most of BoardDO's alarm loop, pump and rehydration are only
// reachable lexically here — the never-blocks guard reads method bodies and
// asserts which symbols they do and do not name, which catches "someone
// awaited generation inside a state read" and nothing that blocks any other
// way.
//
// One exception, added for the rearm-after-a-throwing-load regression near
// the bottom of this file: a hand-rolled, `Map`-backed storage stub (no DO
// semantics — no serialization boundary, no real alarm-firing scheduler, no
// hibernation) lets a few tests construct a real `BoardDO` and drive
// `load()`/`alarm()`/`getView()`/`setControls()` directly. That is real
// coverage of this file's own control flow, but it is still not #31: nothing
// here proves how the actual Durable Object runtime behaves.

import { describe, expect, it, vi } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { beltNow, pauseClock, startedClock } from "../src/board/clock";
import {
  DEFAULT_BELT_SPEED,
  EDGE_DWELL_MS,
  GHOST_DEPTH,
  MAX_LINEAGES,
  SEED_FANOUT,
  type Station,
} from "../src/board/types";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// Imported after the mock purely for readability — vitest hoists vi.mock above
// every import regardless of where it is written. Neither import instantiates a
// DO; BoardDO is read as a value, never constructed.
import { BoardDO, beltFingerprint } from "../src/board/board-do";
import worker from "../src/index";

// ── helpers ─────────────────────────────────────────────────────────────────

/** `n` ready stations with mutually orthogonal unit embeddings. */
function stations(n = 3): Station[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    order: i + 1,
    term: `dir ${i}`,
    phrase: `a ${i} kind of thing`,
    expanded: true,
    embedding: Array.from({ length: n }, (_, d) => (d === i ? 1 : 0)),
  }));
}

function child(text: string, axis = 0): { text: string; embedding: number[] } {
  return { text, embedding: [axis === 0 ? 0.5 : 0, axis === 1 ? 0.5 : 0.5, 0] };
}

/** Every key name at any depth. Structural on purpose: the substring form of
 *  the wire guard (`JSON.stringify(view)).not.toContain("embedding")`) fires on
 *  a card whose *text* contains the word, which is ordinary copy on a board of
 *  LLM-generated fragments. */
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

/** Every string VALUE at any depth. The ephemerality guard is the mirror image
 *  of the wire guard: there we hunt a key and must ignore text, here we hunt
 *  text and must ignore keys. */
function stringsDeep(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsDeep(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) stringsDeep(inner, found);
  }
  return found;
}

/** Substring rather than equality, so a card text that survives embedded in
 *  some larger string ("archived: urban gardening") still counts as surviving. */
function mentions(value: unknown, text: string): boolean {
  return stringsDeep(value).some((s) => s.includes(text));
}

// ── guard 1: never blocks ───────────────────────────────────────────────────
//
// "The field must never visibly wait for generation" is a correctness
// requirement in CLAUDE.md, not an optimization. On the board it means a state
// read returns without awaiting any AI call, and a lineage whose next hop is
// still outstanding keeps serving its current head.

describe("never-blocks guard", () => {
  it("serves a seed the moment it is typed, before any generation has happened", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);

    const view = belt.view();
    expect(view.lineages).toHaveLength(1);
    expect(view.lineages[0]!.cards.map((c) => c.text)).toEqual(["urban gardening"]);
    // ...and the hop that would fill this row is still outstanding, so the row
    // above was served while generation was pending rather than after it.
    expect(belt.hungry(1_000_000, 0).map((h) => h.lineageId)).toEqual([view.lineages[0]!.id]);
  });

  it("keeps serving the head of a lineage whose next hop is still outstanding", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("rooftop bee lease")], 1001);
    const live = belt.lineages()[0]!;

    expect(belt.hungry(1_000_000, 0).map((h) => h.lineageId)).toContain(live.id);
    const row = belt.view().lineages.find((l) => l.id === live.id)!;
    expect(row.cards.at(-1)!.text).toBe("rooftop bee lease");
    expect(row.atEdge).toBe(false);
  });

  it("serves a board whose stations are not embedded yet, and shows them as not ready", () => {
    // The spec's failure-mode row: an unembedded station HOLDS its lineages
    // rather than guessing. Holding must not mean going blank — hungry() still
    // reports the work, the DO is what declines to act, and the view stays
    // serviceable either way.
    const pending = stations();
    for (const s of pending) s.embedding = null;
    const belt = new BeltCore({ stations: pending });
    belt.addSeed("urban gardening", 1000);

    const view = belt.view();
    expect(view.stations.map((s) => s.ready)).toEqual([false, false, false]);
    expect(view.lineages[0]!.cards[0]!.text).toBe("urban gardening");
    expect(belt.hungry(1_000_000, 0)).toHaveLength(1);
    // Nor does an unembedded CARD hide a row: a seed card is born with
    // `embedding: null` and is the only thing the user has to look at.
    expect(belt.lineages()[0]!.cards[0]!.embedding).toBeNull();
  });

  it("does not evict a lineage for being slow", () => {
    // If a slow AI could park a lineage at the edge, an outage would evaporate
    // the seeds the user typed. Six minutes of dwell periods with no hop landing
    // must leave the row exactly where it was.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    for (let t = 1; t <= 60; t++) belt.tick(1000 + t * EDGE_DWELL_MS);

    expect(belt.lineages()).toHaveLength(1);
    expect(belt.evaporated()).toHaveLength(0);
    expect(belt.view().lineages[0]!.cards[0]!.text).toBe("urban gardening");
    expect(belt.hungry(1_000_000, 0)).toHaveLength(1);
  });

  it("returns a state read as a value, not as something still being awaited", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const read: unknown = belt.view();

    expect(read).not.toBeInstanceOf(Promise);
    expect((read as { then?: unknown }).then).toBeUndefined();
    expect((read as { lineages: unknown[] }).lineages).toHaveLength(1);
  });

  // The two below are LEXICAL, for want of a DO harness (issue #31). They read
  // the method bodies off the prototype and assert which symbols appear. That
  // is enough to catch the specific regression that matters — an await of
  // generation inside a state read — and is honest about being nothing more.

  /** Every symbol in board-do.ts that reaches, or drives, an AI call. */
  const GENERATES = /aiRunner|embedTexts|generateRewrites|expandPole|pumpOnce|prepareStations/;

  it("keeps generation out of BoardDO's read, seed and setControls paths", () => {
    const readPath = BoardDO.prototype.getView.toString();
    const seedPath = BoardDO.prototype.seed.toString();
    // setControls is a third user-facing state RPC on the same must-not-await
    // -generation footing as getView and seed: a client sets speed or paused
    // and gets the new view back, not a wait on the pump.
    const controlsPath = BoardDO.prototype.setControls.toString();

    // Non-vacuity: these really are the method bodies, not stubs or [native
    // code]. Without this the three `not.toMatch`es below pass on an empty string.
    expect(readPath).toMatch(/schedulePump/);
    expect(seedPath).toMatch(/addSeed/);
    expect(controlsPath).toMatch(/schedulePump/);

    expect(readPath).not.toMatch(GENERATES);
    expect(seedPath).not.toMatch(GENERATES);
    expect(controlsPath).not.toMatch(GENERATES);
  });

  it("uses a scan that finds generation where it legitimately lives", () => {
    // Companion to the test above: if this scan cannot see the pump in the
    // alarm, it could not see one smuggled into getView either.
    const proto = BoardDO.prototype as unknown as Record<string, () => string>;
    expect(proto.alarm!.toString()).toMatch(GENERATES);
    expect(proto.pumpOnce!.toString()).toMatch(/generateRewrites/);
    expect(proto.pumpOnce!.toString()).toMatch(/embedTexts/);
  });

  it("hands station preparation to waitUntil rather than awaiting it", () => {
    // init() is the one read path that legitimately NAMES generation. It must
    // still not wait for it: a board whose first paint waited on three pole
    // expansions would show an empty field for as long as the model takes.
    const init = BoardDO.prototype.init.toString();
    expect(init).toMatch(/waitUntil\(\s*this\.prepareStations\(\)\s*\)/);
    expect(init).not.toMatch(/await\s+this\.prepareStations/);
  });
});

// ── guard 2: wire format ────────────────────────────────────────────────────
//
// No `embedding` key at any depth in any /api/board/* response. BeltCore.view()
// is embedding-free by construction, but lineages(), stations(), hungry() and
// serialize() all carry embeddings, so one serialize() where a view() belonged
// ships a few thousand floats per card. Route-level, because the per-module
// suites only ever check view() — and a route that forgot boardJson() would
// leak with every one of those still green.

interface BoardStub {
  init?: () => Promise<unknown>;
  getView?: () => Promise<unknown>;
  seed?: (text: string) => Promise<unknown>;
  setControls?: (patch: unknown) => Promise<unknown>;
}

/** Drive the real exported fetch handler against a stub BOARD_DO. */
function callRoute(stub: BoardStub, request: Request): Promise<Response> {
  const env = { BOARD_DO: { getByName: () => stub } };
  const handler = worker as unknown as { fetch(request: Request, env: unknown): Promise<Response> };
  return handler.fetch(request, env);
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://dewpt.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const BOARD_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A board with real state behind it: embedded stations, embedded cards, and a
 *  card whose TEXT contains the word "embedding" — the input that a substring
 *  wire guard fails on with nothing leaked.
 *
 *  One lineage is already finished and evicted, so the evaporated ring is
 *  populated too. Every branch of the wire has to be occupied for a walk over
 *  it to mean anything: with an empty ring, an embedding smuggled into a ghost
 *  entry would sail through this whole sweep. */
function loadedBelt(): BeltCore {
  const belt = new BeltCore({ stations: stations() });
  belt.addSeed("urban gardening", 1000);
  belt.applySeedFan(
    belt.lineages()[0]!.id,
    [child("rooftop bee lease"), child("word embedding tricks", 1)],
    1001,
  );
  belt.markArrived(belt.lineages()[0]!.id, 1002);
  belt.tick(2000);
  belt.tick(2000 + EDGE_DWELL_MS);
  return belt;
}

/** A board at MAX_LINEAGES, so `addSeed` really refuses rather than being told
 *  to. `accepted` comes from the belt, not from the fixture. */
function fullBelt(): BeltCore {
  const belt = new BeltCore({ stations: stations() });
  for (let i = 0; i < MAX_LINEAGES; i++) belt.addSeed(`seed ${i}`, 1000 + i);
  return belt;
}

/** Every board response, keyed by name, produced from one belt through the real
 *  route table. `project` picks what the DO hands back — `view()` for the
 *  honest case, `serialize()` for the leak. */
async function allBoardResponses(project: (belt: BeltCore) => unknown): Promise<Record<string, Response>> {
  const clean = loadedBelt();
  const full = fullBelt();
  return {
    create: await callRoute({ init: async () => project(clean) }, post("/api/board")),
    read: await callRoute(
      { getView: async () => project(clean) },
      new Request(`https://dewpt.test/api/board/${BOARD_ID}`),
    ),
    seed: await callRoute(
      { seed: async () => ({ view: project(clean), accepted: true }) },
      post(`/api/board/${BOARD_ID}/seed`, { text: "another seed" }),
    ),
    refused: await callRoute(
      { seed: async (text: string) => ({ view: project(full), accepted: full.addSeed(text, 2000) }) },
      post(`/api/board/${BOARD_ID}/seed`, { text: "one too many" }),
    ),
    controls: await callRoute(
      { setControls: async () => project(clean) },
      post(`/api/board/${BOARD_ID}/controls`, { paused: true }),
    ),
  };
}

describe("wire-format guard", () => {
  it("puts no embedding key at any depth in any board response", async () => {
    const responses = await allBoardResponses((belt) => belt.view());
    const expected: Record<string, number> = { create: 201, read: 200, seed: 200, refused: 409, controls: 200 };

    for (const [name, response] of Object.entries(responses)) {
      // The status matters as much as the walk: a leak that assertNoEmbeddings
      // catches becomes a 500 whose body is `{ error: "internal error" }`, which
      // would satisfy the key walk while the route was broken.
      expect(response.status, name).toBe(expected[name]);
      const body = await response.json();
      expect(keysDeep(body), name).not.toContain("embedding");
      // ...and on every response built from a board that holds that card, the
      // text survived — which is exactly what the substring form of this guard
      // forbids. ("refused" comes from the full board, which has no such card.)
      if (name !== "refused") expect(mentions(body, "word embedding tricks"), name).toBe(true);
    }
  });

  it("uses a key walk that would actually catch a leak", () => {
    // serialize() legitimately carries embeddings, and it is the state sitting
    // behind the stub in the test above. If the walk cannot find one here, that
    // test passes vacuously.
    const wire = JSON.parse(JSON.stringify(loadedBelt().serialize()));
    expect(keysDeep(wire)).toContain("embedding");
    expect(keysDeep(fullBelt().serialize())).toContain("embedding");
    // ...and the fixture really does exercise every branch of the wire, so the
    // sweep is walking a populated view rather than three empty arrays.
    const view = loadedBelt().view();
    expect(view.stations.length).toBeGreaterThan(0);
    expect(view.lineages.length).toBeGreaterThan(0);
    expect(view.evaporated.length).toBeGreaterThan(0);
  });

  it("refuses to serve stored state on every board route rather than leaking it", async () => {
    // One serialize() where a view() belonged, on each route in turn. Answering
    // 500 is the point: a silent strip would hide the bug that produced it.
    const responses = await allBoardResponses((belt) => belt.serialize());
    for (const [name, response] of Object.entries(responses)) {
      expect(response.status, name).toBe(500);
      const body = await response.json();
      expect(keysDeep(body), name).not.toContain("embedding");
      expect(JSON.stringify(body), name).not.toContain("0.5"); // no vector components either
    }
  });
});

// ── guard 3: ephemerality ───────────────────────────────────────────────────
//
// An unpinned card's text does not survive eviction anywhere in stored state,
// beyond the evaporated ring. This encodes the premise (SPEC.md): features that
// quietly make words permanent break the product, so permanence has to be a
// test failure rather than a code review note.

const LINE = [
  "urban gardening", // the seed
  "rooftop bee lease",
  "pigeon-assisted pollination",
  "brood comb audit",
  "queen excluder rental",
  "apiary noise ordinance", // the head
];

/** A five-station lineage carrying all six texts above, its head finished. Six
 *  cards against GHOST_DEPTH 3 means the two oldest are trimmed from the wire
 *  while still sitting in storage — which is the distinction this guard is
 *  about. */
function deepLineage(): BeltCore {
  const belt = new BeltCore({ stations: stations(5) });
  belt.addSeed(LINE[0]!, 1000);
  belt.applySeedFan(belt.lineages()[0]!.id, [child(LINE[1]!)], 1001);
  const id = belt.lineages()[0]!.id;
  for (let i = 2; i < LINE.length; i++) belt.applyHop(id, child(LINE[i]!), 1000 + i);
  return belt;
}

describe("ephemerality guard", () => {
  it("holds in storage what it has already trimmed from the wire", () => {
    // The premise the eviction test below rests on. Without it, "the text is
    // gone from storage after eviction" could be true because it was never
    // there.
    const belt = deepLineage();
    const stored = belt.serialize();
    const wire = belt.view();

    expect(wire.lineages[0]!.cards).toHaveLength(GHOST_DEPTH + 1);
    for (const text of LINE) expect(mentions(stored, text), text).toBe(true);
    expect(mentions(wire, LINE[0]!)).toBe(false); // trimmed from the wire...
    expect(mentions(stored, LINE[0]!)).toBe(true); // ...but still stored
  });

  it("leaves nothing of an evicted lineage in stored state but its head, in the ring", () => {
    const belt = deepLineage();
    belt.tick(2000); // head has passed the last station: park at the edge
    belt.tick(2000 + EDGE_DWELL_MS); // dwell elapsed: evict

    const stored = belt.serialize();
    expect(stored.lineages).toHaveLength(0);
    for (const text of LINE.slice(0, -1)) expect(mentions(stored, text), text).toBe(false);
    // The one sanctioned mercy, and only it.
    expect(belt.evaporated().map((e) => e.text)).toEqual([LINE.at(-1)]);
  });

  it("leaves nothing of an evicted lineage on the wire either, beyond the ring", () => {
    const belt = deepLineage();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);

    const wire = belt.view();
    expect(wire.lineages).toHaveLength(0);
    for (const text of LINE.slice(0, -1)) expect(mentions(wire, text), text).toBe(false);
    expect(wire.evaporated.map((e) => e.text)).toEqual([LINE.at(-1)]);
  });

  it("carries a text and a timestamp into the ring and nothing else", () => {
    // The ghost trail is a mercy, not a back door. An embedding riding along
    // would make a ghost re-scoreable — and would put one on the wire, since
    // view() passes the ring straight through.
    const belt = deepLineage();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);

    expect(keysDeep(belt.evaporated())).toEqual(["text", "evaporatedAt"]);
    expect(keysDeep(belt.view().evaporated)).not.toContain("embedding");
  });
});

// ── guard 4: capacity ───────────────────────────────────────────────────────
//
// The board holds at MAX_LINEAGES however many seeds arrive, and a seed refused
// at capacity is REPORTED rather than swallowed. A full board answering 200
// with an unchanged view makes the typed word vanish with no error and nothing
// for `if (!res.ok)` to catch.

describe("capacity guard", () => {
  it("holds at MAX_LINEAGES however many seeds arrive, refusing rather than rotating", () => {
    const belt = new BeltCore({ stations: stations() });
    const accepted: string[] = [];
    for (let i = 0; i < MAX_LINEAGES * 3; i++) {
      if (belt.addSeed(`seed ${i}`, 1000 + i)) accepted.push(`seed ${i}`);
    }

    expect(belt.lineages()).toHaveLength(MAX_LINEAGES);
    expect(accepted).toEqual(Array.from({ length: MAX_LINEAGES }, (_, i) => `seed ${i}`));
    // Refusal, not rotation: the seeds already on the board are the ones that
    // stayed. Making room by evicting an earlier row would delete work the user
    // can see, which is a different product.
    expect(belt.lineages().map((l) => l.seedText)).toEqual(accepted);
    expect(belt.evaporated()).toHaveLength(0);
  });

  it("holds at the cap across interleaved seeds and fans", () => {
    // A fan multiplies rows, so capacity has to survive the interaction rather
    // than just the addSeed path. Counts are exact so an overflow is loud.
    const belt = new BeltCore({ stations: stations() });
    const fanFrom = (lineageId: string, label: string) =>
      belt.applySeedFan(
        lineageId,
        Array.from({ length: SEED_FANOUT }, (_, i) => child(`${label}-${i}`)),
        1100,
      );
    const count = () => belt.lineages().length;

    belt.addSeed("a", 1000);
    expect(count()).toBe(1);
    fanFrom(belt.lineages()[0]!.id, "a"); // room for all three
    expect(count()).toBe(3);
    belt.addSeed("b", 1001);
    belt.addSeed("c", 1002);
    expect(count()).toBe(5);
    fanFrom(belt.lineages().at(-1)!.id, "c"); // room for two of three
    expect(count()).toBe(MAX_LINEAGES);
    expect(belt.addSeed("d", 1003)).toBe(false);
    expect(count()).toBe(MAX_LINEAGES);
    fanFrom(belt.lineages().find((l) => l.seedText === "b")!.id, "b"); // room for one
    expect(count()).toBe(MAX_LINEAGES);
  });

  it("trims a fan to the room available, keeping the best-ranked children", () => {
    // selectFan hands its children over best-first, so the trim must take from
    // the tail. slice(-room) would silently ship the worst ones.
    const trimAt = (fillers: number): string[] => {
      const belt = new BeltCore({ stations: stations() });
      for (let i = 0; i < fillers; i++) belt.addSeed(`filler ${i}`, 1000 + i);
      belt.applySeedFan(
        belt.lineages().at(-1)!.id,
        [child("best"), child("second"), child("third")],
        1100,
      );
      expect(belt.lineages()).toHaveLength(MAX_LINEAGES);
      return belt.lineages().map((l) => l.cards.at(-1)!.text);
    };

    // Room for two of three: the fanned lineage's own slot is reusable, so a
    // board of five has two spare rows.
    const two = trimAt(MAX_LINEAGES - 1);
    expect(two).toContain("best");
    expect(two).toContain("second");
    expect(two).not.toContain("third");

    // Room for one: the tightest case, a fan on a board already at the cap.
    const one = trimAt(MAX_LINEAGES);
    expect(one).toContain("best");
    expect(one).not.toContain("second");
    expect(one).not.toContain("third");
  });

  it("reports a seed refused at capacity as 409, with the view attached", async () => {
    // Driven by a real BeltCore at capacity, so `accepted` is the belt's own
    // answer rather than a fixture's. 200-with-an-unchanged-view is the failure
    // this exists to prevent.
    const belt = fullBelt();
    const response = await callRoute(
      { seed: async (text: string) => ({ view: belt.view(), accepted: belt.addSeed(text, 2000) }) },
      post(`/api/board/${BOARD_ID}/seed`, { text: "one too many" }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; lineages: unknown[] };
    expect(body.error).toMatch(/full/i);
    expect(body.lineages).toHaveLength(MAX_LINEAGES);
    // The refused word did not quietly land anywhere.
    expect(mentions(body, "one too many")).toBe(false);
    expect(belt.lineages()).toHaveLength(MAX_LINEAGES);
  });

  it("still answers 200 for a seed the same board accepts, so 409 means something", async () => {
    // Companion: without this, a route that answered 409 unconditionally would
    // satisfy the test above.
    const belt = new BeltCore({ stations: stations() });
    const response = await callRoute(
      { seed: async (text: string) => ({ view: belt.view(), accepted: belt.addSeed(text, 2000) }) },
      post(`/api/board/${BOARD_ID}/seed`, { text: "room for one more" }),
    );

    expect(response.status).toBe(200);
    expect(belt.lineages().map((l) => l.seedText)).toEqual(["room for one more"]);
  });
});

// ── guard 5: read-path cost ─────────────────────────────────────────────────
//
// Not one of the design doc's four; this one comes from a defect. A state read
// is polled about once a second for as long as a board is open, so anything it
// does unconditionally it does forever — and getView() ticked and then wrote,
// which is one metered storage write per poll per board on a board where
// nothing changed at all.
//
// The fix skips the WRITE and never the tick. The tick is what parks finished
// heads and evicts elapsed ones, and an idle board lets its alarm lapse, so a
// polling client is the only thing left driving time forward on it.
//
// Split the way the DO's own seam is: the belt half is a real property test of
// the fingerprint the write-skip keys off, and the DO half is LEXICAL, for want
// of a harness (issue #31). Neither executes getView, so that the two are wired
// together is still unproven here.

describe("read-path cost guard", () => {
  it("leaves stored state byte-identical across ticks that change nothing", () => {
    // Twenty polls' worth of ticks on a board with nothing due: no head has
    // reached the last station, so there is nothing to park and nothing to
    // evict, and every one of those writes would have written the same bytes.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const idle = beltFingerprint(belt.serialize());

    for (let t = 1; t <= 20; t++) belt.tick(1000 + t * 1000);

    expect(beltFingerprint(belt.serialize())).toBe(idle);
  });

  it("stays identical across the polls between parking and eviction", () => {
    // The case a board actually spends time in: a head sitting out its dwell at
    // the edge, polled once a second the whole way. Every tick before the last
    // is a no-op, and the last one is not.
    const belt = deepLineage();
    belt.tick(2000); // head past the last station: park at the edge
    const parked = beltFingerprint(belt.serialize());

    for (let t = 1000; t < EDGE_DWELL_MS; t += 1000) belt.tick(2000 + t);
    expect(beltFingerprint(belt.serialize())).toBe(parked);

    belt.tick(2000 + EDGE_DWELL_MS); // dwell elapsed: evict
    expect(beltFingerprint(belt.serialize())).not.toBe(parked);
  });

  it("uses a fingerprint that can see the changes it is meant to skip on", () => {
    // Companion to both of the above: a fingerprint blind to everything would
    // satisfy them. Parking and evicting must each move it, or "unchanged"
    // means "unlooked at" and the read path would drop a durable write.
    const belt = deepLineage();
    const running = beltFingerprint(belt.serialize());

    belt.tick(2000);
    const parked = beltFingerprint(belt.serialize());
    expect(parked).not.toBe(running);

    belt.tick(2000 + EDGE_DWELL_MS);
    const evicted = beltFingerprint(belt.serialize());
    expect(evicted).not.toBe(parked);
    // ...and it saw the eviction specifically, not just any difference.
    expect(evicted).toContain(LINE.at(-1)); // the head, now in the ring
    expect(evicted).not.toContain(LINE[0]); // the seed card, gone with the lineage
  });

  it("keeps the unconditional write off BoardDO's read path, and the tick on it", () => {
    // Lexical, like the never-blocks pair above, and no more than that: it
    // catches a read path reverting to `this.save()`, which is the regression.
    const readPath = BoardDO.prototype.getView.toString();

    // Non-vacuity, and the constraint that comes with the fix: the tick still
    // runs on every read. Skipping it would break eviction on an idle board.
    expect(readPath).toMatch(/\.tick\(/);
    expect(readPath).toMatch(/saveIfChanged/);
    expect(readPath).not.toMatch(/this\.save\(\)/);
  });

  it("uses a scan that finds the unconditional write where it legitimately lives", () => {
    // Companion: if this scan cannot see `this.save()` on the paths that do
    // write unconditionally, it could not see one restored to getView (or the
    // alarm) either. alarm() itself is NOT one of these any more — see the
    // next test — so the companion points at prepareStations, which still
    // writes unconditionally on every station it prepares.
    const proto = BoardDO.prototype as unknown as Record<string, () => string>;
    expect(proto.seed!.toString()).toMatch(/this\.save\(\)/);
    expect(proto.prepareStations!.toString()).toMatch(/this\.save\(\)/);
    // ...and it distinguishes the two writers, rather than matching on "save".
    expect(proto.seed!.toString()).not.toMatch(/saveIfChanged/);
  });

  it("uses saveIfChanged for the alarm's post-pump write, not an unconditional save", () => {
    // The dwell gate creates a wake the alarm did not have before:
    // pumpOnce() returns "idle" while hasPendingWork() is still true, because
    // a dwelling head is pending work that is not yet due. getView's
    // schedulePump(PUMP_MS) pulls the alarm forward on every client poll, so
    // that alarm fires repeatedly mid-dwell, finds nothing to do, and rearm()
    // puts it right back mid-dwell — roughly once per poll for the whole
    // dwell. An unconditional `this.save()` there would write the full belt
    // record, 1024-dim embeddings included, for no change, on every one of
    // those wakes — the exact per-poll write 14b8974 removed from the read
    // path, reintroduced on the alarm path instead.
    const alarm = BoardDO.prototype.alarm.toString();
    expect(alarm).toMatch(/pumpOnce/); // non-vacuity
    expect(alarm).toMatch(/saveIfChanged/);
    expect(alarm).not.toMatch(/this\.save\(\)/);
  });
});

// ── guard 6: pause stops the work, and loses nothing ────────────────────────
//
// Pause has to stop metered generation, not merely stop the picture, and it
// must not cost the user the cards they paused to read. The first half is only
// reachable lexically (issue #31 again — no DO harness), the second half is a
// real property of BeltCore and is executed.

describe("pause guard", () => {
  it("evaporates nothing while belt time is frozen, however long the pause", () => {
    // THE reason pause is a frozen clock rather than a flag. Under a flag,
    // wall-clock time keeps running against edgeAt, and the first tick after a
    // long pause evicts every parked lineage at once.
    const belt = new BeltCore({ stations: stations(1) });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    const [lineage] = belt.lineages();
    belt.markArrived(lineage!.id, 1000);

    const frozen = beltNow(pauseClock(startedClock(1000), 2000), 2000);
    for (let i = 0; i < 200; i++) belt.tick(frozen); // ~ minutes of real time
    expect(belt.lineages()).toHaveLength(1);
    expect(belt.evaporated()).toHaveLength(0);

    // Non-vacuity: the same lineage does evaporate once belt time moves past
    // the dwell, so the assertion above is about the freeze, not about a
    // lineage that was never going to evaporate.
    belt.tick(frozen + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
    expect(belt.evaporated()).toHaveLength(1);
  });

  it("arms no alarm while the board is paused, whoever asks", () => {
    // One choke point. init, getView, seed, prepareStations and rearm all route
    // through schedulePump, so the check living here is what makes "paused
    // spends nothing" true for all of them at once rather than five times over.
    const proto = BoardDO.prototype as unknown as Record<string, () => string>;
    const schedulePump = proto.schedulePump!.toString();
    expect(schedulePump).toMatch(/setAlarm/); // non-vacuity: this is the real body
    expect(schedulePump).toMatch(/paused\(\)/);
  });

  it("returns from the alarm before pumping when paused", () => {
    const alarm = BoardDO.prototype.alarm.toString();
    expect(alarm).toMatch(/pumpOnce/); // non-vacuity
    const guard = alarm.indexOf("paused()");
    const pump = alarm.indexOf("pumpOnce");
    expect(guard, "alarm never checks paused()").toBeGreaterThan(-1);
    expect(guard, "alarm checks paused() only after pumping").toBeLessThan(pump);
  });

  it("does not count a pause as a stall, so a resumed board is not in backoff", () => {
    // A paused board that scored "stalled" would saturate MAX_CONSECUTIVE_STALLS
    // and wake into a 30s ladder — or a given-up state — the moment it resumed.
    // Pause is not a fault.
    const alarm = BoardDO.prototype.alarm.toString();
    const guard = alarm.indexOf("paused()");
    const pump = alarm.indexOf("pumpOnce");
    expect(guard).toBeGreaterThan(-1);
    expect(alarm.slice(guard, pump), "the paused branch never sets idle").toMatch(/idle/);
  });
});

// ── regression: rearm survives a throwing load() ────────────────────────────
//
// Found in review: `rearm()`'s delay computation dereferenced `this.belt`
// unconditionally, so a DO whose `load()` itself throws (a `storage.get`
// failure) crashed `rearm()` with a TypeError instead of rescheduling with the
// plain backoff — the alarm loop `rearm()` exists to keep alive. Confirmed
// regression, reproduced by driving the real methods below: before the fix,
// zero alarms armed and `rearm failed` logged; after, one alarm armed.
//
// A lexical guard cannot catch this — the bug is in what a real call does,
// not in which symbols a method body names — so this is the one place in this
// file that constructs and drives a real `BoardDO` (see the file header).

interface StorageStub {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (time: number) => Promise<void>;
}

/** A storage stub whose `get` always throws — modelling a DO whose read path
 *  is down but whose write path (`put`, `setAlarm`) still works, which is
 *  exactly the shape a `rearm()` crash would strand: stall counter written,
 *  no alarm left to retry it. */
function throwingReadStorage(): StorageStub & { armedAt: () => number | null } {
  let armedAt: number | null = null;
  return {
    get: async () => {
      throw new Error("storage read failed");
    },
    put: async () => {},
    getAlarm: async () => armedAt,
    setAlarm: async (time) => {
      armedAt = time;
    },
    armedAt: () => armedAt,
  };
}

/** A storage stub over a plain map of records, for tests that need `load()`
 *  to succeed against specific stored state. */
function seededStorage(records: Record<string, unknown>): StorageStub {
  const map = new Map<string, unknown>(Object.entries(records));
  let armedAt: number | null = null;
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, value);
    },
    getAlarm: async () => armedAt,
    setAlarm: async (time) => {
      armedAt = time;
    },
  };
}

interface TestableBoard {
  ctx: { storage: StorageStub; waitUntil: (p: Promise<unknown>) => void };
  env: Record<string, unknown>;
  alarm(): Promise<void>;
  getView(): Promise<{ controls: { speed: string; paused: boolean } } | null>;
  setControls(patch: {
    speed?: string;
    paused?: boolean;
  }): Promise<{ controls: { speed: string; paused: boolean } } | null>;
}

/** `new BoardDO()` with no constructor args — the mocked `DurableObject` base
 *  class at the top of this file is `class {}`, which does not set `ctx`/`env`
 *  the way the real `cloudflare:workers` base class's constructor does, so
 *  they are assigned directly afterward. Same cast idiom the lexical guards
 *  elsewhere in this file already use (`BoardDO.prototype as unknown as
 *  ...`), applied to an instance instead of the prototype. */
function testableBoard(storage: StorageStub): TestableBoard {
  const board = new (BoardDO as unknown as new () => TestableBoard)();
  board.ctx = { storage, waitUntil: (p) => void p };
  board.env = {};
  return board;
}

describe("rearm after a throwing load()", () => {
  it("still arms an alarm, rather than crashing on the belt it never loaded", async () => {
    const storage = throwingReadStorage();
    const board = testableBoard(storage);

    // load() throws inside; must not leave rearm() unable to reschedule.
    await board.alarm();

    expect(storage.armedAt()).not.toBeNull();
    expect(storage.armedAt()!).toBeGreaterThan(Date.now());
  });
});

// ── regression: an invalid belt speed never reaches hopDwellMs ─────────────
//
// hopDwellMs(speed) is BELT_SPEEDS[speed].hopDwellMs. A speed that is not one
// of BELT_SPEEDS' keys makes that undefined, so every dwell comparison in
// BeltCore.hungry is `now < bornAt + undefined`, i.e. always false — every
// lineage looks hungry forever, which is unbounded metered generation against
// a live account. Both entry points a speed can reach `this.speed` through —
// a stored controls record and a `setControls` patch — validate with
// `isBeltSpeed` before trusting the value.

describe("belt speed validation", () => {
  it("falls back to the default speed when the stored controls record is corrupted", async () => {
    const belt = new BeltCore({ stations: stations() });
    const storage = seededStorage({
      belt: belt.serialize(),
      controls: { speed: "warpspeed", clock: startedClock(1000) },
    });
    const board = testableBoard(storage);

    const response = await board.getView();

    expect(response).not.toBeNull();
    expect(response!.controls.speed).toBe(DEFAULT_BELT_SPEED);
  });

  it("ignores an invalid speed patch to setControls, rather than corrupting the dwell", async () => {
    const belt = new BeltCore({ stations: stations() });
    const storage = seededStorage({ belt: belt.serialize() });
    const board = testableBoard(storage);

    const response = await board.setControls({ speed: "warpspeed" });

    expect(response).not.toBeNull();
    expect(response!.controls.speed).toBe(DEFAULT_BELT_SPEED);
  });
});
