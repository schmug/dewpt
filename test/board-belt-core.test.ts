import { describe, expect, it } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { GHOST_DEPTH, MAX_LINEAGES, SEED_FANOUT, type Station } from "../src/board/types";

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
    const [hop] = belt.hungry();
    expect(hop!.stationIndex).toBe(1);
    expect(hop!.count).toBe(SEED_FANOUT);
    expect(hop!.parentText).toBe("urban gardening");
  });

  it("reports a moved lineage as needing a single child", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("rooftop bee lease")], 1001);
    const [hop] = belt.hungry();
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
    expect(belt.hungry()).toHaveLength(0);
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
    belt.applyHop(live, child("b"), 1003);
    expect(belt.lineages()[0]!.failures).toBe(0);
  });
});

describe("view", () => {
  it("never puts an embedding on the wire", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    expect(JSON.stringify(belt.view())).not.toContain("embedding");
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
