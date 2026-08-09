import { describe, expect, it } from "vitest";

// public/board/belt-model.js is plain JS served raw from public/ (no build
// step), so it sits outside tsconfig's include — same arrangement as
// public/depth.js and public/pool-client.js; the cast below pins the surface
// under test. The DOM half lives in public/board/belt-render.js and is
// deliberately not imported here: vitest.config.ts sets no `environment`, so
// these run in bare node with no `document`.
// @ts-expect-error — public/board/belt-model.js ships untyped
import * as beltModelUntyped from "../public/board/belt-model.js";

interface CardView {
  id: string;
  text: string;
  stationIndex: number;
}

interface LineageView {
  id: string;
  cards: CardView[];
  arrived: boolean;
  atEdge: boolean;
}

interface StationView {
  id: string;
  order: number;
  term: string;
  phrase: string;
  degraded: boolean;
  ready: boolean;
}

interface BoardView {
  stations: StationView[];
  lineages: LineageView[];
  evaporated: { text: string; evaporatedAt: number }[];
}

/** One card's placement on the grid. `column` and `row` are 1-based because
 *  they are written straight into CSS grid, which is 1-based. */
interface Placement {
  id: string;
  lineageId: string;
  text: string;
  column: number;
  row: number;
  opacity: number;
  isHead: boolean;
  isGhost: boolean;
  arrived: boolean;
  atEdge: boolean;
}

const { columnCount, ghostOpacity, placeCards, controlsState, BELT_SPEED_NAMES, DEFAULT_SPEED } =
  beltModelUntyped as unknown as {
    ghostOpacity: (behind: number) => number;
    placeCards: (view: BoardView) => Placement[];
    columnCount: (view: BoardView) => number;
    controlsState(view: unknown): { speed: string; paused: boolean };
    BELT_SPEED_NAMES: string[];
    DEFAULT_SPEED: string;
  };

function stations(n: number): StationView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    order: i + 1,
    term: `dir ${i}`,
    phrase: `a ${i} kind of thing`,
    degraded: false,
    ready: true,
  }));
}

/** A lineage whose cards sit at consecutive stations starting at `from`, which
 *  is what ghost trimming produces once a head is more than GHOST_DEPTH out. */
function lineage(
  id: string,
  texts: string[],
  opts: { from?: number; arrived?: boolean; atEdge?: boolean } = {},
): LineageView {
  const from = opts.from ?? 0;
  return {
    id,
    cards: texts.map((text, i) => ({ id: `${id}-c${i}`, text, stationIndex: from + i })),
    arrived: opts.arrived ?? false,
    atEdge: opts.atEdge ?? false,
  };
}

function view(lineages: LineageView[], stationCount = 3): BoardView {
  return { stations: stations(stationCount), lineages, evaporated: [] };
}

describe("ghostOpacity", () => {
  it("renders the head — zero cards behind — fully opaque", () => {
    expect(ghostOpacity(0)).toBe(1);
  });

  it("decreases with every step behind the head", () => {
    // Strictly decreasing across the defined ramp: a ghost one hop back must be
    // visibly fainter than the head, and two hops back fainter again. A flat
    // ramp would still "fade" in the code and read as no trail at all.
    let previous = ghostOpacity(0);
    for (let behind = 1; behind <= 3; behind++) {
      const opacity = ghostOpacity(behind);
      expect(opacity).toBeLessThan(previous);
      previous = opacity;
    }
  });

  it("clamps beyond the ramp instead of running negative or off the end", () => {
    const last = ghostOpacity(3);
    for (const behind of [4, 9, 40, 1000]) {
      expect(ghostOpacity(behind)).toBe(last);
    }
  });

  it("stays inside 0..1 for every distance, including nonsense ones", () => {
    for (const behind of [-5, -1, 0, 1, 2, 3, 4, 12, 999]) {
      const opacity = ghostOpacity(behind);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("placeCards", () => {
  it("puts a card in the column its stationIndex names, 1-based for CSS grid", () => {
    // Starts at station 2, not station 0. A lineage whose first visible card is
    // the seed cannot tell `stationIndex + 1` apart from `cardIndex + 1` — both
    // produce [1, 2, 3] — and the two are the same only by coincidence.
    const placements = placeCards(view([lineage("l1", ["seed", "child", "grandchild"], { from: 2 })], 4));
    expect(placements.map((p) => p.column)).toEqual([3, 4, 5]);
  });

  it("keeps the column tied to stationIndex when ghosts have been trimmed away", () => {
    // The wire drops ghosts beyond GHOST_DEPTH, so a lineage's first visible
    // card is not necessarily at station 0. Column must follow stationIndex,
    // never the card's position in the array.
    const placements = placeCards(view([lineage("l1", ["a", "b"], { from: 4 })], 6));
    expect(placements.map((p) => p.column)).toEqual([5, 6]);
  });

  it("gives every card in a lineage the same row, and each lineage its own", () => {
    const placements = placeCards(
      view([lineage("l1", ["a", "b", "c"]), lineage("l2", ["d", "e"]), lineage("l3", ["f"])]),
    );
    const rowsByLineage = new Map<string, Set<number>>();
    for (const p of placements) {
      const rows = rowsByLineage.get(p.lineageId) ?? new Set<number>();
      rows.add(p.row);
      rowsByLineage.set(p.lineageId, rows);
    }
    expect([...rowsByLineage.keys()]).toEqual(["l1", "l2", "l3"]);
    for (const rows of rowsByLineage.values()) expect(rows.size).toBe(1);
    expect([...rowsByLineage.values()].map((rows) => [...rows][0])).toEqual([1, 2, 3]);
  });

  it("marks exactly one head per lineage, and it is the last card", () => {
    const placements = placeCards(view([lineage("l1", ["a", "b", "c"]), lineage("l2", ["d", "e"])]));
    for (const id of ["l1", "l2"]) {
      const heads = placements.filter((p) => p.lineageId === id && p.isHead);
      expect(heads).toHaveLength(1);
    }
    expect(placements.filter((p) => p.isHead).map((p) => p.text)).toEqual(["c", "e"]);
  });

  it("treats every non-head card as a ghost and the head as not one", () => {
    const placements = placeCards(view([lineage("l1", ["a", "b", "c"])]));
    expect(placements.map((p) => p.isGhost)).toEqual([true, true, false]);
  });

  it("fades each card by its distance behind the head", () => {
    const placements = placeCards(view([lineage("l1", ["a", "b", "c", "d"])], 4));
    expect(placements.map((p) => p.opacity)).toEqual([
      ghostOpacity(3),
      ghostOpacity(2),
      ghostOpacity(1),
      ghostOpacity(0),
    ]);
  });

  it("never reports arrived or atEdge on a ghost — only the live head has state", () => {
    const placements = placeCards(
      view([lineage("l1", ["a", "b", "c"], { arrived: true, atEdge: true })]),
    );
    for (const p of placements) {
      if (p.isHead) continue;
      expect(p.arrived).toBe(false);
      expect(p.atEdge).toBe(false);
    }
    const head = placements.find((p) => p.isHead)!;
    expect(head.arrived).toBe(true);
    expect(head.atEdge).toBe(true);
  });

  it("carries the card id and text through untouched", () => {
    const [placement] = placeCards(view([lineage("l1", ["rooftop bee lease"])]));
    expect(placement!.id).toBe("l1-c0");
    expect(placement!.text).toBe("rooftop bee lease");
    expect(placement!.lineageId).toBe("l1");
  });

  it("returns an empty array for an empty board rather than throwing", () => {
    expect(placeCards(view([]))).toEqual([]);
    expect(placeCards({ stations: [], lineages: [], evaporated: [] })).toEqual([]);
  });

  it("skips a lineage with no cards instead of throwing on a missing head", () => {
    const empty: LineageView = { id: "l0", cards: [], arrived: false, atEdge: false };
    const placements = placeCards(view([empty, lineage("l1", ["a"])]));
    expect(placements.map((p) => p.lineageId)).toEqual(["l1"]);
  });
});

describe("columnCount", () => {
  it("adds the seed column and the edge column to the station count", () => {
    expect(columnCount(view([], 3))).toBe(5);
    expect(columnCount(view([], 2))).toBe(4);
    expect(columnCount(view([], 5))).toBe(7);
  });

  it("still returns the two fixed columns before any station exists", () => {
    expect(columnCount({ stations: [], lineages: [], evaporated: [] })).toBe(2);
  });

  it("leaves room for every column placeCards actually uses, edge column included", () => {
    // The head sits one past the last station — stationIndex 4 with 3 stations,
    // so column 5, the edge column belt-model.js reserves for a head that has
    // finished the belt. A lineage that stops at the last station instead
    // (widest = stations.length + 1) fits a grid one column too narrow, so it
    // cannot tell a correct count from one that has dropped the edge column.
    const board = view([lineage("l1", ["a", "b", "c", "d"], { from: 1 })], 3);
    const widest = Math.max(...placeCards(board).map((p) => p.column));
    expect(widest).toBe(5);
    expect(widest).toBeLessThanOrEqual(columnCount(board));
  });
});

describe("controlsState", () => {
  it("reads the speed and paused state a view carries", () => {
    expect(controlsState({ controls: { speed: "slow", paused: true } })).toEqual({
      speed: "slow",
      paused: true,
    });
  });

  it("falls back to a coherent row when the view carries no controls", () => {
    // A dropped poll body, a 404 payload, or a response from a server that
    // predates this feature must still paint a control row. An undefined speed
    // would check none of the three radios and leave the group unreadable.
    for (const view of [null, undefined, {}, { controls: null }, { controls: "slow" }]) {
      expect(controlsState(view)).toEqual({ speed: DEFAULT_SPEED, paused: false });
    }
  });

  it("refuses a speed it does not know rather than passing it through", () => {
    expect(controlsState({ controls: { speed: "ludicrous", paused: false } }).speed).toBe(DEFAULT_SPEED);
  });

  it("treats anything but a literal true as running", () => {
    for (const paused of ["true", 1, null, undefined]) {
      expect(controlsState({ controls: { speed: "steady", paused } }).paused).toBe(false);
    }
  });

  it("names exactly the presets the server accepts", () => {
    // These strings go straight into the request body. Drifting from the
    // server's isBeltSpeed means every click 400s.
    expect(BELT_SPEED_NAMES).toEqual(["brisk", "steady", "slow"]);
    expect(BELT_SPEED_NAMES).toContain(DEFAULT_SPEED);
  });
});
