// Pure layout model for the conveyor board. No `document`, no `window`, no
// `fetch` — belt-render.js is the DOM half and this is the part the vitest
// suite can actually exercise (vitest.config.ts sets no environment, so tests
// run in bare node). Same split as public/depth.js against public/field.js.
//
// Rows are lineages, columns are stations. A card's column is its
// stationIndex; ghost fade is derived here from distance behind the head,
// because the server never ships an opacity — see
// docs/superpowers/specs/2026-08-08-conveyor-board-design.md.

/** Fade ramp, indexed by how many stations a card sits behind its lineage's
 *  head. Index 0 is the live head. Strictly decreasing so the trail reads as a
 *  trail; the tail value is the floor, not the last step of a ramp that keeps
 *  going, so a long lineage's oldest visible ghost stays legible. */
export const GHOST_OPACITY = [1, 0.5, 0.34, 0.2];

/** Opacity for a card `behind` stations back from the head. Clamped at both
 *  ends: a negative distance cannot happen from a well-formed view, and a
 *  distance past the ramp holds at the floor rather than fading to nothing. */
export function ghostOpacity(behind) {
  if (!Number.isFinite(behind) || behind <= 0) return GHOST_OPACITY[0];
  return GHOST_OPACITY[Math.min(Math.floor(behind), GHOST_OPACITY.length - 1)];
}

/** Grid width: one seed column, one column per station, one edge column. The
 *  edge column is where a head that has passed the last station dwells before
 *  it evaporates, so it must be part of the grid rather than overflow. */
export function columnCount(view) {
  const stations = view && Array.isArray(view.stations) ? view.stations : [];
  return stations.length + 2;
}

/** Flatten the server view into one placement descriptor per card.
 *
 *  `row` is the lineage's index, so belt-render.js can write an explicit
 *  gridRow. That is load-bearing rather than tidy: ghost trimming means a
 *  lineage's first visible card is often not in column 1, and CSS grid
 *  auto-placement would then interleave rows from different lineages into each
 *  other's gaps — the rows-are-lineages reading the whole board depends on.
 *
 *  `arrived` and `atEdge` are lineage state and belong to the live head only.
 *  Painting them on a ghost would claim a card that has already been rewritten
 *  is the one sitting at the edge. */
export function placeCards(view) {
  const lineages = view && Array.isArray(view.lineages) ? view.lineages : [];
  const placements = [];
  lineages.forEach((lineage, lineageIndex) => {
    const cards = lineage && Array.isArray(lineage.cards) ? lineage.cards : [];
    if (cards.length === 0) return;
    const headIndex = cards.length - 1;
    const head = cards[headIndex];
    cards.forEach((card, cardIndex) => {
      const isHead = cardIndex === headIndex;
      placements.push({
        id: card.id,
        lineageId: lineage.id,
        text: card.text,
        column: card.stationIndex + 1,
        row: lineageIndex + 1,
        opacity: ghostOpacity(head.stationIndex - card.stationIndex),
        isHead,
        isGhost: !isHead,
        arrived: isHead && lineage.arrived === true,
        atEdge: isHead && lineage.atEdge === true,
      });
    });
  });
  return placements;
}

/** The speed presets, in belt order. These strings are the wire values — they
 *  must match src/board/types.ts's BELT_SPEEDS exactly, because they go
 *  straight into the request body and anything else is a 400. */
export const BELT_SPEED_NAMES = ["brisk", "steady", "slow"];

export const DEFAULT_SPEED = "steady";

/** Normalize a view's control state.
 *
 *  Total by design. A dropped poll body, a 404 payload, or a response from a
 *  server that predates this feature must still paint a coherent control row:
 *  an undefined speed checks none of the three radios and leaves the group
 *  unreadable and unoperable. */
export function controlsState(view) {
  const controls = view && typeof view.controls === "object" && view.controls !== null ? view.controls : {};
  return {
    speed: BELT_SPEED_NAMES.includes(controls.speed) ? controls.speed : DEFAULT_SPEED,
    paused: controls.paused === true,
  };
}
