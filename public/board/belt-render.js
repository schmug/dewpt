// DOM writer for the conveyor board. Every layout decision — column, row,
// ghost fade, which card owns the lineage's state — is made by belt-model.js;
// this module only turns those descriptors into elements. That split is what
// makes the layout unit-testable, since the test suite runs in bare node with
// no `document`.

import { columnCount, controlsState, placeCards } from "./belt-model.js";

/** textContent, never innerHTML: card text and station phrases are model
 *  output, which CLAUDE.md treats as untrusted input. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setColumns(node, count) {
  node.style.setProperty("--board-columns", String(count));
}

export function renderStations(headerRow, view) {
  const stations = view && Array.isArray(view.stations) ? view.stations : [];
  setColumns(headerRow, columnCount(view));
  const heads = [el("div", "board-lane board-lane--seed", "seed · yours")];
  for (const station of stations) {
    const head = el("div", "board-lane");
    head.appendChild(el("span", "board-lane-term", station.term));
    const phrase = el("span", "board-lane-phrase", station.phrase);
    // A degraded station emits bad rewrites that look entirely normal, so it
    // has to look degraded. See the failure-mode table in the design doc.
    if (station.degraded) {
      phrase.classList.add("board-lane-phrase--degraded");
      phrase.title = "pole expansion failed — this direction is running on the bare term";
    }
    head.appendChild(phrase);
    if (!station.ready) head.classList.add("board-lane--pending");
    heads.push(head);
  }
  heads.push(el("div", "board-lane board-lane--edge", "edge"));
  headerRow.replaceChildren(...heads);
}

export function renderLineages(belt, view) {
  setColumns(belt, columnCount(view));
  const nodes = [];
  for (const placement of placeCards(view)) {
    const node = el("div", "board-card", placement.text);
    node.style.gridColumn = String(placement.column);
    node.style.gridRow = String(placement.row);
    node.style.opacity = String(placement.opacity);
    if (placement.isGhost) node.classList.add("board-card--ghost");
    if (placement.arrived) node.classList.add("board-card--arrived");
    if (placement.atEdge) node.classList.add("board-card--dying");
    nodes.push(node);
  }
  belt.replaceChildren(...nodes);
}

export function renderEvaporated(list, evaporated) {
  const ghosts = Array.isArray(evaporated) ? evaporated : [];
  list.replaceChildren(...ghosts.map((ghost) => el("li", "board-ghost", ghost.text)));
}

/** Paint the control row from the view's control state.
 *
 *  Attribute-driven rather than class-driven: `aria-pressed` and `aria-checked`
 *  ARE the state, and the stylesheet selects on them, so there is exactly one
 *  source of truth and the row cannot look set while reading as unset. */
export function renderControls(nodes, view) {
  const { speed, paused } = controlsState(view);
  if (nodes.pause) {
    nodes.pause.setAttribute("aria-pressed", String(paused));
    nodes.pause.textContent = paused ? "resume" : "pause";
  }
  for (const button of nodes.speeds ?? []) {
    button.setAttribute("aria-checked", String(button.dataset.speed === speed));
  }
  // Marked, not dimmed. Someone paused the board in order to read it.
  if (nodes.belt) nodes.belt.classList.toggle("board-grid--paused", paused);
}

/** One entry point so board.js never has to remember the paint order. Guards
 *  `view` the same way renderStations and renderLineages do: a malformed or
 *  empty body must paint an empty board, not throw halfway through and leave
 *  the surface holding the previous tick's cards. */
export function paintBoard(nodes, view) {
  renderStations(nodes.stations, view);
  renderLineages(nodes.belt, view);
  renderEvaporated(nodes.evaporated, view && view.evaporated);
  renderControls(nodes, view);
}
