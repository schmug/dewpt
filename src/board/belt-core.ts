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

export interface BeltCoreOptions {
  /** Mints the unique half of every lineage and card id. Injected rather than
   *  reached for, so this module stays pure and deterministic under test.
   *
   *  It must NOT be a module-scope counter. BoardDO hibernates and wakes on a
   *  fresh isolate: module scope is rebuilt from zero while the hydrated state
   *  still holds every id minted before, so a counter does not merely reset —
   *  it replays its sequence and re-mints ids the state already holds. The
   *  mutators resolve by `find`/`findIndex`, which take the first match, so
   *  duplicates route hops into the wrong lineage, strand the real one in
   *  `hungry()` forever (unbounded metered generation), and ship duplicate DOM
   *  keys. Tests may inject a deterministic factory; production must not. */
  newId?: () => string;
}

export class BeltCore {
  private stationList: Station[];
  private lineageList: Lineage[];
  private evaporatedList: EvaporatedCard[];
  private readonly newId: () => string;

  constructor(state?: Partial<BeltCoreState>, options?: BeltCoreOptions) {
    this.stationList = [...(state?.stations ?? [])].sort((a, b) => a.order - b.order);
    this.lineageList = [...(state?.lineages ?? [])];
    this.evaporatedList = [...(state?.evaporated ?? [])];
    this.newId = options?.newId ?? (() => crypto.randomUUID());
  }

  /** The `l`/`c` prefix is a debugging affordance only — it says which kind of
   *  thing you are looking at in a log or a DOM key. Uniqueness comes entirely
   *  from `newId`, never from the prefix. */
  private mintId(prefix: "l" | "c"): string {
    return `${prefix}${this.newId()}`;
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
      id: this.mintId("l"),
      seedText: trimmed,
      cards: [{ id: this.mintId("c"), text: trimmed, stationIndex: 0, bornAt: now, embedding: null }],
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
      id: this.mintId("l"),
      seedText: original.seedText,
      cards: [
        { ...seedCard, id: this.mintId("c") },
        { id: this.mintId("c"), text: child.text, stationIndex: 1, bornAt: now, embedding: child.embedding },
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
      id: this.mintId("c"),
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
