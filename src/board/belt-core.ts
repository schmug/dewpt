// Pure belt logic for one board session: lineages, the seed fan, hops, ghost
// trimming, capacity, edge eviction. No bindings, no storage, no I/O — BoardDO
// hydrates and persists this, exactly as SessionDO does for PoolCore.

import {
  EDGE_DWELL_MS,
  EVAPORATED_CAP,
  GHOST_DEPTH,
  MAX_HOP_FAILURES,
  MAX_LINEAGES,
  SEED_FANOUT,
  type Card,
  type EvaporatedCard,
  type Lineage,
  type Station,
} from "./types";

export interface BeltCoreState {
  stations: Station[];
  lineages: Lineage[];
  evaporated: EvaporatedCard[];
}

/** One hop the DO should generate for. `count` is SEED_FANOUT on a lineage's
 *  first hop so a single seed produces motion from one call. */
export interface HungryHop {
  lineageId: string;
  parentText: string;
  parentEmbedding: number[] | null;
  stationIndex: number;
  count: number;
}

export interface CardView {
  id: string;
  text: string;
  stationIndex: number;
}

export interface LineageView {
  id: string;
  cards: CardView[];
  arrived: boolean;
  atEdge: boolean;
}

export interface StationView {
  id: string;
  order: number;
  term: string;
  phrase: string;
  degraded: boolean;
  ready: boolean;
}

export interface BoardView {
  stations: StationView[];
  lineages: LineageView[];
  evaporated: EvaporatedCard[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export class BeltCore {
  private stationList: Station[];
  private lineageList: Lineage[];
  private evaporatedList: EvaporatedCard[];

  constructor(state?: Partial<BeltCoreState>) {
    this.stationList = [...(state?.stations ?? [])].sort((a, b) => a.order - b.order);
    this.lineageList = [...(state?.lineages ?? [])];
    this.evaporatedList = [...(state?.evaporated ?? [])];
  }

  stations(): Station[] {
    return this.stationList.map((s) => ({ ...s }));
  }

  lineages(): Lineage[] {
    return this.lineageList.map((l) => ({ ...l, cards: l.cards.map((c) => ({ ...c })) }));
  }

  evaporated(): EvaporatedCard[] {
    return this.evaporatedList.map((e) => ({ ...e }));
  }

  setStationEmbedding(id: string, embedding: number[]): void {
    const station = this.stationList.find((s) => s.id === id);
    if (station) station.embedding = embedding;
  }

  /** Admit a seed, unless the board is at its legibility cap. */
  addSeed(text: string, now: number): boolean {
    if (this.lineageList.length >= MAX_LINEAGES) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.lineageList.push({
      id: nextId("l"),
      seedText: trimmed,
      cards: [{ id: nextId("c"), text: trimmed, stationIndex: 0, bornAt: now, embedding: null }],
      failures: 0,
      arrivedAt: null,
      edgeAt: null,
    });
    return true;
  }

  /** Lineages that need their next card. A lineage still sitting on its seed
   *  asks for SEED_FANOUT children; every later hop asks for one. */
  hungry(): HungryHop[] {
    const out: HungryHop[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      out.push({
        lineageId: lineage.id,
        parentText: head.text,
        parentEmbedding: head.embedding,
        stationIndex: head.stationIndex + 1,
        count: lineage.cards.length === 1 ? SEED_FANOUT : 1,
      });
    }
    return out;
  }

  /** Split a seed lineage into one lineage per child, each keeping a copy of
   *  the seed card so every row still reads from its origin. */
  applySeedFan(lineageId: string, children: { text: string; embedding: number[] }[], now: number): void {
    const index = this.lineageList.findIndex((l) => l.id === lineageId);
    if (index === -1 || children.length === 0) return;
    const original = this.lineageList[index]!;
    const seedCard = original.cards[0]!;
    const room = MAX_LINEAGES - this.lineageList.length + 1; // the original's slot is reusable
    const admitted = children.slice(0, Math.max(1, room));
    const spawned: Lineage[] = admitted.map((child) => ({
      id: nextId("l"),
      seedText: original.seedText,
      cards: [
        { ...seedCard, id: nextId("c") },
        { id: nextId("c"), text: child.text, stationIndex: 1, bornAt: now, embedding: child.embedding },
      ],
      failures: 0,
      arrivedAt: null,
      edgeAt: null,
    }));
    this.lineageList.splice(index, 1, ...spawned);
  }

  /** Append a child as the new head. The old head becomes a ghost simply by
   *  no longer being last — nothing about the fade is stored. */
  applyHop(lineageId: string, child: { text: string; embedding: number[] }, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (!lineage) return;
    const head = lineage.cards.at(-1)!;
    lineage.cards.push({
      id: nextId("c"),
      text: child.text,
      stationIndex: head.stationIndex + 1,
      bornAt: now,
      embedding: child.embedding,
    });
    lineage.failures = 0;
  }

  noteHopFailure(lineageId: string, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (!lineage) return;
    lineage.failures += 1;
    if (lineage.failures >= MAX_HOP_FAILURES) lineage.edgeAt = now;
  }

  markArrived(lineageId: string, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (lineage) lineage.arrivedAt = now;
  }

  /** Client projection. Embeddings are absent by construction — this is the
   *  only path to the wire, so there is nowhere for one to leak through. */
  view(): BoardView {
    return {
      stations: this.stationList.map((s) => ({
        id: s.id,
        order: s.order,
        term: s.term,
        phrase: s.phrase,
        degraded: !s.expanded,
        ready: s.embedding !== null,
      })),
      lineages: this.lineageList.map((l) => ({
        id: l.id,
        cards: l.cards.slice(-(GHOST_DEPTH + 1)).map((c) => ({ id: c.id, text: c.text, stationIndex: c.stationIndex })),
        arrived: l.arrivedAt !== null,
        atEdge: l.edgeAt !== null,
      })),
      evaporated: this.evaporated(),
    };
  }

  serialize(): BeltCoreState {
    return { stations: this.stations(), lineages: this.lineages(), evaporated: this.evaporated() };
  }
}
