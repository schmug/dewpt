import { describe, expect, it } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import {
  BELT_SPEEDS,
  DEFAULT_BELT_SPEED,
  GHOST_DEPTH,
  hopDwellMs,
  isBeltSpeed,
  MAX_HOP_FAILURES,
  MAX_LINEAGES,
  SEED_FANOUT,
  type Station,
} from "../src/board/types";

function stations(n = 3): Station[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    order: i + 1,
    term: `dir ${i}`,
    phrase: `a ${i} kind of thing`,
    expanded: true,
    embedding: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0],
  }));
}

function child(text: string) {
  return { text, embedding: [0.5, 0.5, 0] };
}

/** Drive one lineage forward `hops` times, so tests can position a head. */
function advance(belt: BeltCore, lineageId: string, hops: number, from = 1): void {
  for (let i = 0; i < hops; i++) belt.applyHop(lineageId, child(`hop ${from + i}`), 1000 + i);
}

/** Every id the belt currently holds, lineage and card alike. Ids share one
 *  namespace on the wire — a card colliding with a lineage is still a dup key. */
function allIds(belt: BeltCore): string[] {
  return belt.lineages().flatMap((l) => [l.id, ...l.cards.map((c) => c.id)]);
}

/** Every KEY name at any depth. The wire guard has to be structural: a
 *  substring match on the serialized JSON fires on a card whose *text* happens
 *  to contain "embedding", which is ordinary copy on an idea board. */
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

describe("addSeed", () => {
  it("creates one lineage holding just the seed card", () => {
    const belt = new BeltCore({ stations: stations() });
    expect(belt.addSeed("urban gardening", 1000)).toBe(true);
    const [lineage] = belt.lineages();
    expect(lineage!.cards).toHaveLength(1);
    expect(lineage!.cards[0]!.text).toBe("urban gardening");
    expect(lineage!.cards[0]!.stationIndex).toBe(0);
  });

  it("refuses a seed when the board is at capacity", () => {
    const belt = new BeltCore({ stations: stations() });
    for (let i = 0; i < MAX_LINEAGES; i++) expect(belt.addSeed(`seed ${i}`, 1000)).toBe(true);
    expect(belt.addSeed("one too many", 1000)).toBe(false);
  });
});

describe("hungry", () => {
  it("reports a fresh seed as needing a fan-width first hop", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [hop] = belt.hungry(1_000_000, 0);
    expect(hop!.stationIndex).toBe(1);
    expect(hop!.count).toBe(SEED_FANOUT);
    expect(hop!.parentText).toBe("urban gardening");
  });

  it("reports a moved lineage as needing a single child", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("rooftop bee lease")], 1001);
    const [hop] = belt.hungry(1_000_000, 0);
    expect(hop!.stationIndex).toBe(2);
    expect(hop!.count).toBe(1);
  });

  it("stops reporting a lineage whose head has passed the last station", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    // The fan retires the seed lineage and spawns fresh ids, so the head has to
    // be driven by the post-fan id — as the applyHop and ghost-trim tests do.
    advance(belt, belt.lineages()[0]!.id, 2, 2);
    expect(belt.hungry(1_000_000, 0)).toHaveLength(0);
  });
});

describe("applySeedFan", () => {
  it("splits one seed into a lineage per child, sharing the seed card", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a"), child("b"), child("c")], 1001);
    const all = belt.lineages();
    expect(all).toHaveLength(3);
    for (const lineage of all) {
      expect(lineage.cards[0]!.text).toBe("urban gardening");
      expect(lineage.cards).toHaveLength(2);
    }
    expect(all.map((l) => l.cards[1]!.text).sort()).toEqual(["a", "b", "c"]);
  });

  it("takes only as many children as capacity allows", () => {
    const belt = new BeltCore({ stations: stations() });
    for (let i = 0; i < MAX_LINEAGES - 1; i++) belt.addSeed(`filler ${i}`, 1000);
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages().at(-1)!.id;
    belt.applySeedFan(id, [child("a"), child("b"), child("c")], 1001);
    expect(belt.lineages()).toHaveLength(MAX_LINEAGES);
  });
});

describe("applyHop", () => {
  it("appends the child as the new head and demotes the old head to a ghost", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("rooftop bee lease")], 1001);
    belt.applyHop(belt.lineages()[0]!.id, child("pigeon-assisted pollination"), 1002);
    const cards = belt.lineages()[0]!.cards;
    expect(cards.map((c) => c.text)).toEqual(["urban gardening", "rooftop bee lease", "pigeon-assisted pollination"]);
    expect(cards.at(-1)!.stationIndex).toBe(2);
  });

  it("resets the failure counter on a successful hop", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("x", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    const live = belt.lineages()[0]!.id;
    belt.noteHopFailure(live, 1002);
    // Assert the raise before the reset: without this the test passes even if
    // noteHopFailure is a no-op, proving nothing about applyHop.
    expect(belt.lineages()[0]!.failures).toBe(1);
    belt.applyHop(live, child("b"), 1003);
    expect(belt.lineages()[0]!.failures).toBe(0);
  });
});

describe("markArrived", () => {
  it("stamps the lineage and reports it as arrived on the wire", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    expect(belt.lineages()[0]!.arrivedAt).toBeNull();
    belt.markArrived(id, 1234);
    expect(belt.lineages()[0]!.arrivedAt).toBe(1234);
    expect(belt.view().lineages[0]!.arrived).toBe(true);
  });

  it("ignores an unknown lineage rather than stamping the wrong one", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    belt.markArrived("no-such-lineage", 1234);
    expect(belt.lineages()[0]!.arrivedAt).toBeNull();
  });
});

describe("hungry release", () => {
  it("stops asking for hops once a lineage has arrived", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    expect(belt.hungry(1_000_000, 0)).toHaveLength(1);
    belt.markArrived(id, 1001);
    expect(belt.hungry(1_000_000, 0)).toHaveLength(0);
  });

  it("stops asking for hops once a lineage is released to the edge", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    for (let i = 0; i < MAX_HOP_FAILURES; i++) belt.noteHopFailure(id, 1000 + i);
    expect(belt.lineages()[0]!.edgeAt).not.toBeNull();
    expect(belt.hungry(1_000_000, 0)).toHaveLength(0);
  });
});

describe("id minting", () => {
  it("mints from an injected factory, so the core stays deterministic under test", () => {
    const build = () => {
      let n = 0;
      const belt = new BeltCore({ stations: stations() }, { newId: () => `-${++n}` });
      belt.addSeed("urban gardening", 1000);
      belt.applySeedFan(belt.lineages()[0]!.id, [child("a")], 1001);
      return belt.lineages();
    };
    // Same inputs, same ids — no ambient entropy, no shared module state.
    expect(build()).toEqual(build());
    expect(build()[0]!.id).toBe("l-3");
  });

  it("keeps lineage and card ids unique within one instance", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("a"), child("b")], 1001);
    advance(belt, belt.lineages()[0]!.id, 2, 2);
    const ids = allIds(belt);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** Serialize on one module evaluation, hydrate on another. The distinct
   *  import queries are what make this a real test: two instances built in ONE
   *  module evaluation share module scope, so they pass trivially. */
  async function rehydrateOnFreshModule() {
    // The `?isolate=` suffix is a Vite resolution, not a TypeScript one, so tsc
    // cannot follow it. The suffix is exactly what forces a genuine module
    // re-evaluation, so the type is pinned to the real module by hand.
    type BeltCoreModule = typeof import("../src/board/belt-core");
    // @ts-expect-error -- Vite-only module specifier; typed by the annotation
    const beforeMod: BeltCoreModule = await import("../src/board/belt-core.ts?isolate=before-hibernation");
    // @ts-expect-error -- Vite-only module specifier; typed by the annotation
    const afterMod: BeltCoreModule = await import("../src/board/belt-core.ts?isolate=after-hibernation");
    // Guard the guard — if these ever collapse to one module, fail loudly rather
    // than quietly proving nothing.
    expect(afterMod.BeltCore).not.toBe(beforeMod.BeltCore);

    const before = new beforeMod.BeltCore({ stations: stations() });
    before.addSeed("urban gardening", 1000);
    // Round-trip through JSON exactly as Durable Object storage does.
    const persisted = JSON.parse(JSON.stringify(before.serialize()));
    return { before, after: new afterMod.BeltCore(persisted), hydratedIds: new Set(allIds(before)) };
  }

  // A Durable Object hibernates and wakes on a FRESH isolate: module scope is
  // rebuilt from zero while the hydrated state still holds every id minted
  // before. A module-scope counter therefore does not merely reset — it replays
  // the same sequence and re-mints ids the state already holds, so find/
  // findIndex resolve to the wrong lineage and the wire ships duplicate keys.
  // Two instances in ONE module evaluation cannot catch this; the module has to
  // genuinely be re-evaluated, which the distinct import queries below force.
  it("never re-mints an id the rehydrated state already holds", async () => {
    const { before, after, hydratedIds } = await rehydrateOnFreshModule();

    expect(after.addSeed("mycelium logistics", 2000)).toBe(true);

    // Assert on the ids the fresh instance actually minted. Set-differencing
    // against the hydrated ids would be defeated by the very collision under
    // test — a re-minted id subtracts itself out and looks like nothing new.
    const fresh = after.lineages().at(-1)!;
    for (const id of [fresh.id, ...fresh.cards.map((c) => c.id)]) {
      expect(hydratedIds.has(id)).toBe(false);
    }
    const ids = allIds(after);
    expect(new Set(ids).size).toBe(ids.length);
    expect(before.lineages()[0]!.id).not.toBe(fresh.id);
  });

  it("resolves a mutation to the lineage that owns the id, after rehydration", async () => {
    const { after } = await rehydrateOnFreshModule();
    after.addSeed("mycelium logistics", 2000);
    const fresh = after.lineages().at(-1)!;

    // find()/findIndex() take the FIRST match, so a re-minted id silently routes
    // this hop into the hydrated lineage and leaves the new one starving —
    // hungry() then reports it forever, burning metered Workers AI calls.
    after.applyHop(fresh.id, child("spore freight corridors"), 2001);

    const target = after.lineages().find((l) => l.seedText === "mycelium logistics")!;
    expect(target.cards.map((c) => c.text)).toEqual(["mycelium logistics", "spore freight corridors"]);
    const hydrated = after.lineages().find((l) => l.seedText === "urban gardening")!;
    expect(hydrated.cards.map((c) => c.text)).toEqual(["urban gardening"]);
  });
});

describe("view", () => {
  // The 245 KB regression guard. Structural, not a substring match: the seed
  // below is exactly the copy that makes `not.toContain("embedding")` fail with
  // nothing leaked, and card text is LLM-written idea text, so that is not a
  // contrived input.
  it("never puts an embedding key on the wire, at any depth", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("word embedding tricks", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    const wire = JSON.parse(JSON.stringify(belt.view()));
    expect(keysDeep(wire)).not.toContain("embedding");
    // ...and the text itself survived, which the old substring guard forbade.
    expect(JSON.stringify(wire)).toContain("word embedding tricks");
  });

  it("uses a key walk that would actually catch a leak", () => {
    // serialize() legitimately carries embeddings. If keysDeep cannot find one
    // here it cannot find one on the wire either, and the guard above is vacuous.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("a")], 1001);
    expect(keysDeep(JSON.parse(JSON.stringify(belt.serialize())))).toContain("embedding");
  });

  it("trims ghosts beyond GHOST_DEPTH behind the head", () => {
    const belt = new BeltCore({ stations: stations(6) });
    belt.addSeed("seed", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    advance(belt, belt.lineages()[0]!.id, 4, 2);
    const cards = belt.view().lineages[0]!.cards;
    expect(cards).toHaveLength(GHOST_DEPTH + 1);
    expect(cards.at(-1)!.text).toBe("hop 5");
  });

  it("reports a station's degraded flag so a bare pole stays visible", () => {
    const degraded = stations(1);
    degraded[0]!.expanded = false;
    const belt = new BeltCore({ stations: degraded });
    expect(belt.view().stations[0]!.degraded).toBe(true);
  });
});

// A second import from the same module rather than an edit to the one at the
// top: MAX_HOP_FAILURES is already bound up there, so re-importing it would be
// a redeclaration, and the tests above are append-only territory.
import { EDGE_DWELL_MS, EVAPORATED_CAP } from "../src/board/types";

describe("tick", () => {
  function atEnd(): { belt: BeltCore; id: string } {
    const belt = new BeltCore({ stations: stations(1) });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("rooftop bee lease")], 1001);
    return { belt, id: belt.lineages()[0]!.id };
  }

  it("sends a head that has passed the last station to the edge", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    expect(belt.lineages()[0]!.edgeAt).toBe(2000);
  });

  it("keeps the lineage readable for the whole dwell", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS - 1);
    expect(belt.lineages()).toHaveLength(1);
  });

  it("evicts the lineage once the dwell elapses", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
  });

  it("records the evicted head in the evaporated ring", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.evaporated()[0]!.text).toBe("rooftop bee lease");
  });

  it("caps the evaporated ring, dropping the oldest entries", () => {
    const belt = new BeltCore({ stations: stations(1) });
    for (let i = 0; i < EVAPORATED_CAP + 3; i++) {
      belt.addSeed(`seed ${i}`, 1000);
      const id = belt.lineages().at(-1)!.id;
      belt.applySeedFan(id, [child(`child ${i}`)], 1001);
      belt.tick(2000);
      belt.tick(2000 + EDGE_DWELL_MS);
    }
    expect(belt.evaporated()).toHaveLength(EVAPORATED_CAP);
    // WHICH entries survive is the load-bearing half. A length-only assertion
    // holds just as well for a ring frozen on its OLDEST entries, which is what
    // truncating a push-ordered list produces: the cap is reached once and every
    // later evaporation is silently discarded, so the ghost trail stops moving.
    expect(belt.evaporated().map((e) => e.text)).toEqual(
      Array.from({ length: EVAPORATED_CAP }, (_, i) => `child ${EVAPORATED_CAP + 2 - i}`),
    );
  });

  it("releases a lineage that has failed its hop too many times", () => {
    const belt = new BeltCore({ stations: stations(3) });
    belt.addSeed("stuck", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    const live = belt.lineages()[0]!.id;
    for (let i = 0; i < MAX_HOP_FAILURES; i++) belt.noteHopFailure(live, 1002);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
  });

  it("stores no card text anywhere once a lineage is evicted, beyond the ring", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    const dump = JSON.stringify(belt.serialize());
    // The seed's own text is gone with the lineage; only the head survives,
    // in the evaporated ring, which is the one sanctioned mercy.
    expect(dump).not.toContain("urban gardening");
    expect(belt.evaporated().map((e) => e.text)).toEqual(["rooftop bee lease"]);
  });

  // Arrival is the OTHER way a lineage finishes, and the only one that can
  // strand it. A head short of the last station has somewhere left to go, but
  // hungry() skips an arrived lineage, so it can never go there on its own. If
  // tick() parked only on `stationIndex >= stations.length`, nothing would ever
  // park this lineage: it would never reach the edge, never evict, and outlive
  // the board — permanence, which the ephemerality premise (SPEC.md, and
  // CLAUDE.md's "correctness, not preference") forbids.
  it("parks and evicts a lineage that arrived short of the last station", () => {
    const belt = new BeltCore({ stations: stations(3) });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("rooftop bee lease")], 1001);
    const id = belt.lineages()[0]!.id;
    belt.markArrived(id, 1002);

    // The premise, asserted rather than assumed: the head really is short of
    // the last station, and really has no way to advance itself.
    expect(belt.lineages()[0]!.cards.at(-1)!.stationIndex).toBe(1);
    expect(belt.hungry(1_000_000, 0)).toHaveLength(0);

    belt.tick(2000);
    expect(belt.lineages()[0]!.edgeAt).toBe(2000);
    belt.tick(2000 + EDGE_DWELL_MS - 1);
    expect(belt.lineages()).toHaveLength(1);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
    expect(belt.evaporated().map((e) => e.text)).toEqual(["rooftop bee lease"]);
  });

  it("orders the evaporated ring newest first", () => {
    const belt = new BeltCore({ stations: stations(1) });
    // One eviction per iteration, at a distinct time, so the ring's intended
    // order is known rather than inferred. A single eviction cannot tell
    // unshift from push; three can.
    for (let i = 0; i < 3; i++) {
      const at = 2000 + i * 100_000;
      belt.addSeed(`seed ${i}`, at);
      belt.applySeedFan(belt.lineages().at(-1)!.id, [child(`child ${i}`)], at + 1);
      belt.tick(at + 2);
      belt.tick(at + 2 + EDGE_DWELL_MS);
    }
    expect(belt.evaporated().map((e) => e.text)).toEqual(["child 2", "child 1", "child 0"]);
    // Stated twice on purpose: the text order pins insertion, the timestamps
    // pin that "newest first" is what the order MEANS.
    const times = belt.evaporated().map((e) => e.evaporatedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe("belt speed presets", () => {
  it("names exactly the three shipped presets, at the calibrated dwells", () => {
    expect(Object.keys(BELT_SPEEDS).sort()).toEqual(["brisk", "slow", "steady"]);
    expect(hopDwellMs("brisk")).toBe(0);
    expect(hopDwellMs("steady")).toBe(3000);
    expect(hopDwellMs("slow")).toBe(8000);
  });

  it("defaults to steady, not to the generation-bound pace", () => {
    // brisk is what the board shipped as, and its unreadability is the reason
    // this control exists. The default moving is deliberate; see the spec.
    expect(DEFAULT_BELT_SPEED).toBe("steady");
    expect(hopDwellMs(DEFAULT_BELT_SPEED)).toBeGreaterThan(0);
  });

  it("orders the presets strictly, so a slower name is never a faster belt", () => {
    expect(hopDwellMs("brisk")).toBeLessThan(hopDwellMs("steady"));
    expect(hopDwellMs("steady")).toBeLessThan(hopDwellMs("slow"));
  });

  it("recognises the presets and refuses everything else", () => {
    for (const name of ["brisk", "steady", "slow"]) expect(isBeltSpeed(name)).toBe(true);
    for (const junk of ["BRISK", "fast", "", null, undefined, 3000, {}]) {
      expect(isBeltSpeed(junk)).toBe(false);
    }
  });

  it("does not mistake an inherited Object property for a preset", () => {
    // A plain `value in BELT_SPEEDS` or `BELT_SPEEDS[value] !== undefined`
    // passes for "constructor" and "toString", which then index to a function
    // and read `.hopDwellMs` as undefined — a NaN dwell, i.e. a lineage that is
    // never hungry and a board that silently stops.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(isBeltSpeed(inherited)).toBe(false);
    }
  });
});

describe("hungry with a station dwell", () => {
  it("holds a lineage whose head has not sat out the dwell", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    const [lineage] = belt.lineages();
    expect(lineage!.cards).toHaveLength(2); // head born at 1000

    expect(belt.hungry(1500, 3000)).toHaveLength(0);
    expect(belt.hungry(3999, 3000)).toHaveLength(0);
  });

  it("releases it the moment the dwell has elapsed", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);

    expect(belt.hungry(4000, 3000)).toHaveLength(1);
    expect(belt.hungry(9000, 3000)).toHaveLength(1);
  });

  it("is exactly today's behaviour at a zero dwell", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    expect(belt.hungry(1000, 0)).toHaveLength(1);
  });

  it("exempts a seed's first hop, so a fresh board never looks like waiting", () => {
    // Gating the fan would leave a brand new board doing nothing for the whole
    // dwell — up to eight seconds of blank belt — which is precisely the
    // "will look like waiting" failure the seed fan was introduced to prevent.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [hop] = belt.hungry(1000, 8000);
    expect(hop).toBeDefined();
    expect(hop!.count).toBe(SEED_FANOUT);
  });

  it("still skips an arrived lineage under a dwell, with a station left to go", () => {
    // stations(3) is the point: the head's stationIndex (1) sits well short of
    // stationList.length, so — unlike a stations(1) fixture, where hungry()
    // would bail at the `head.stationIndex >= this.stationList.length` guard
    // before ever consulting arrivedAt — the only thing that can explain a
    // skip here is the arrived/edge guard. Delete
    // `if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;`
    // from belt-core.ts and this goes red.
    const belt = new BeltCore({ stations: stations(3) });
    belt.addSeed("a", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("b")], 1000);
    const [lineage] = belt.lineages();
    // The premise: there is a station left to advance to, so nothing but the
    // arrived guard could be holding this lineage back.
    expect(lineage!.cards.at(-1)!.stationIndex).toBeLessThan(3);
    belt.markArrived(lineage!.id, 1000);
    expect(belt.hungry(99_000, 3000)).toHaveLength(0);
  });

  it("still skips an edge-parked lineage under a dwell, with a station left to go", () => {
    // Sibling of the above, covering the other half of the same guard:
    // lineage.edgeAt rather than lineage.arrivedAt. noteHopFailure sets edgeAt
    // directly, without ever touching arrivedAt, so this cannot pass by
    // accident of the arrived check alone.
    const belt = new BeltCore({ stations: stations(3) });
    belt.addSeed("a", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("b")], 1000);
    const [lineage] = belt.lineages();
    expect(lineage!.cards.at(-1)!.stationIndex).toBeLessThan(3);
    for (let i = 0; i < MAX_HOP_FAILURES; i++) belt.noteHopFailure(lineage!.id, 1000 + i);
    expect(belt.lineages()[0]!.arrivedAt).toBeNull();
    expect(belt.lineages()[0]!.edgeAt).not.toBeNull();
    expect(belt.hungry(99_000, 3000)).toHaveLength(0);
  });
});

describe("nextHopAt", () => {
  it("returns null when no lineage is hungry at any future time", () => {
    const belt = new BeltCore({ stations: stations() });
    expect(belt.nextHopAt(3000)).toBeNull();
  });

  it("names the instant a dwelling lineage comes due", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 2000);
    expect(belt.nextHopAt(3000)).toBe(5000); // head bornAt 2000 + 3000
  });

  it("returns the soonest across several lineages, not the first", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("a", 1000);
    const [firstSeed] = belt.lineages();
    belt.applySeedFan(firstSeed!.id, [child("a1")], 5000);
    belt.addSeed("b", 1000);
    const second = belt.lineages().find((l) => l.cards.length === 1);
    belt.applySeedFan(second!.id, [child("b1")], 2000);
    expect(belt.nextHopAt(3000)).toBe(5000); // 2000 + 3000 beats 5000 + 3000
  });

  it("agrees with hungry at every instant, so the alarm cannot sleep through work", () => {
    // This is the invariant the DO's rearm arithmetic rests on: hungry() is
    // non-empty exactly when nextHopAt is non-null and already due. Two
    // separate traversals that could drift apart is precisely how a board ends
    // up either spinning or sleeping forever.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("a", 1000);
    const [firstSeed] = belt.lineages();
    belt.applySeedFan(firstSeed!.id, [child("a1")], 2000);
    belt.addSeed("b", 4000);

    for (let now = 0; now <= 12_000; now += 250) {
      for (const dwell of [0, 3000, 8000]) {
        const due = belt.nextHopAt(dwell);
        const isDue = due !== null && due <= now;
        expect(belt.hungry(now, dwell).length > 0, `now=${now} dwell=${dwell}`).toBe(isDue);
      }
    }
  });
});
