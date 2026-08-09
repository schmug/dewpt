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
   *  asks for SEED_FANOUT children; every later hop asks for one.
   *
   *  `hopDwellMs` is the speed preset's minimum station dwell: a head has to
   *  have sat that long, in belt time, before its next hop is requested. Both
   *  parameters are required rather than defaulted — a call site that forgets
   *  the dwell should fail to compile, not silently run that lineage at brisk.
   *
   *  The seed fan is EXEMPT — its dwell is zero. Gating a lineage's first hop
   *  leaves a brand new board doing nothing for the whole dwell, which is the
   *  "will look like waiting" failure the fan was introduced to prevent. The
   *  dwell paces the interval between things there are to read; before the fan
   *  there is nothing to read.
   *
   *  Both this and `nextHopAt` compute the same `due` instant and differ only in
   *  what they do with it. That is deliberate: written as two separate rules —
   *  "skip if still dwelling" here, "return bornAt + dwell" there — they
   *  disagree for a head whose bornAt is ahead of `now`, and the alarm either
   *  spins or sleeps through work it was told existed. */
  hungry(now: number, hopDwellMs: number): HungryHop[] {
    const out: HungryHop[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      const count = lineage.cards.length === 1 ? SEED_FANOUT : 1;
      // Keyed on `cards.length === 1` — the spec's actual exemption condition
      // — not on `count === 1`. The two agree only because SEED_FANOUT > 1;
      // setting SEED_FANOUT = 1 would silently delete the seed-fan exemption
      // if this were keyed on `count` instead, leaving a fresh board blank
      // for up to a full dwell.
      if (now < head.bornAt + (lineage.cards.length === 1 ? 0 : hopDwellMs)) continue;
      out.push({
        lineageId: lineage.id,
        parentText: head.text,
        parentEmbedding: head.embedding,
        stationIndex: head.stationIndex + 1,
        count,
      });
    }
    return out;
  }

  /** Belt-time at which the next hop becomes eligible, or null when no lineage
   *  will ever be hungry from this state. A value at or before `now` means work
   *  is already due.
   *
   *  This exists so the alarm can sleep until the dwell expires instead of
   *  either spinning at PUMP_MS or — worse — lapsing. Without it, a board where
   *  every lineage is dwelling reports no pending work, the alarm is not
   *  re-armed, and the belt advances only as a side effect of somebody polling.
   *
   *  Deliberately takes no `now`: the answer does not depend on one, and a
   *  version that took one could disagree with `hungry` about the present.
   *
   *  The `due` expression below must stay character-for-character the one in
   *  `hungry`. `hungry` includes a lineage exactly when `now >= due`, so this
   *  returning `min(due)` is what makes "nextHopAt is non-null and at or before
   *  now" mean the same thing as "hungry is non-empty". */
  nextHopAt(hopDwellMs: number): number | null {
    let soonest: number | null = null;
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      // Must stay character-for-character the expression in `hungry` above —
      // see that method's comment on `count` vs `cards.length`, and the class
      // comment above `nextHopAt` on why the two due expressions have to
      // match.
      const due = head.bornAt + (lineage.cards.length === 1 ? 0 : hopDwellMs);
      if (soonest === null || due < soonest) soonest = due;
    }
    return soonest;
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

  /** Advance time: park finished heads at the edge, then evict the ones whose
   *  dwell has elapsed. An evicted head's text goes to the evaporated ring —
   *  the only thing that outlives a lineage. Everything else is gone, which is
   *  the ephemerality premise (SPEC.md) holding for this surface.
   *
   *  The two passes are split for readability — "park, then evict" is the rule,
   *  and each loop states one half of it. The split is NOT what keeps a head
   *  from being evicted in the tick it parked; the dwell arithmetic is. A head
   *  parked at `now` sees `now - edgeAt === 0`, and `0 >= EDGE_DWELL_MS` is
   *  false for any positive dwell, so the head survives its own parking tick and
   *  stays readable — and, from M3, pinnable — for the whole dwell. Fusing the
   *  two loops was checked against a randomized differential (4000 trials,
   *  6 ticks each, varying station count and pre-set arrivedAt/edgeAt, including
   *  backward clock jumps) and diverged nowhere, so treat the split as style
   *  rather than as the thing enforcing the dwell.
   *  `now` is a parameter rather than a Date.now() call so the belt stays pure
   *  and testable without a Workers runtime. */
  tick(now: number): void {
    for (const lineage of this.lineageList) {
      if (lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      const finished = head.stationIndex >= this.stationList.length || lineage.arrivedAt !== null;
      if (finished) lineage.edgeAt = now;
    }

    const survivors: Lineage[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.edgeAt !== null && now - lineage.edgeAt >= EDGE_DWELL_MS) {
        this.evaporatedList.unshift({ text: lineage.cards.at(-1)!.text, evaporatedAt: now });
        continue;
      }
      survivors.push(lineage);
    }
    this.lineageList = survivors;
    if (this.evaporatedList.length > EVAPORATED_CAP) this.evaporatedList.length = EVAPORATED_CAP;
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
