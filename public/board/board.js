// Board session bootstrap, seeding and polling. Layout lives in
// belt-model.js and DOM writing in belt-render.js; this file owns the network
// and nothing else.

import { paintBoard, renderControls } from "./belt-render.js";
import { controlsState, shouldApply } from "./belt-model.js";

const POLL_MS = 900;

/** Poll cadence while paused. Nothing can change server-side except another
 *  viewer of the same board URL resuming it, so polling at the running rate is
 *  the same waste the read path's write-skip was added to remove. */
const POLL_PAUSED_MS = 3000;

/** The session URL is the session, as in SPEC.md — the id rides in the hash so
 *  a reload resumes rather than starting a fresh board. */
const ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/;

const nodes = {
  stations: document.getElementById("board-stations"),
  belt: document.getElementById("board-belt"),
  evaporated: document.getElementById("board-evaporated"),
  pause: document.getElementById("board-pause"),
  speeds: [...document.querySelectorAll(".board-speed-option")],
};
const form = document.getElementById("board-seed-form");
const input = document.getElementById("board-seed-input");
const status = document.getElementById("board-status");

let boardId = null;

/** The last view painted, so a failed control request can put the row back. */
let lastView = null;

/** Every fetch that may end in `paint()` — the poll loop, a control click, a
 *  seed submit, the initial resume/create — stamps itself with this counter
 *  before it goes out. `paint()` then only applies a response tagged with the
 *  sequence that was still the latest SENT one when the response arrives (see
 *  shouldApply in belt-model.js). Without this, a slow poll GET landing after
 *  a fast control POST silently reverts the control the user just set: the
 *  response, not the request, would decide the order. */
let sendSeq = 0;

function nextSeq() {
  return ++sendSeq;
}

function say(message) {
  status.textContent = message;
}

function paint(view, seq) {
  if (!shouldApply(seq, sendSeq)) return;
  lastView = view;
  paintBoard(nodes, view);
}

/** Send a control patch, painting the row optimistically so the click lands
 *  immediately rather than at the next poll.
 *
 *  Only the ROW's CARD-FREE parts are guessed at: the client has no basis to
 *  predict what the belt does next, and guessing at card content would
 *  flicker cards in and out. The one deliberate exception is the
 *  `board-grid--paused` class renderControls toggles on the belt element —
 *  that is a pure function of `paused`, not a prediction, so painting it here
 *  costs nothing. The response carries the authoritative view for
 *  everything else. */
async function sendControls(patch) {
  if (!boardId) return;
  renderControls(nodes, { controls: { ...controlsState(lastView), ...patch } });
  const seq = nextSeq();
  try {
    const res = await fetch(boardUrl(boardId, "/controls"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      say("the board would not take that — try again");
      renderControls(nodes, lastView);
      return;
    }
    say("");
    paint(await res.json(), seq);
  } catch (err) {
    console.error("controls failed", err);
    say("the board would not take that — try again");
    renderControls(nodes, lastView);
  }
}

nodes.pause?.addEventListener("click", () => {
  sendControls({ paused: !controlsState(lastView).paused });
});

for (const button of nodes.speeds) {
  button.addEventListener("click", () => sendControls({ speed: button.dataset.speed }));
}

/** Roving tabindex for the speed radiogroup: the checked option is the one
 *  tab stop, and Left/Up and Right/Down (wrapping) move it, matching what a
 *  screen reader user is told to expect by role="radio" + role="radiogroup".
 *  `event.target` is trusted for the current position because it is only
 *  ever the button that has focus — the group's only tabbable member — and
 *  keydown only reaches this listener by bubbling from there. */
const speedGroup = document.querySelector(".board-speed");
const ARROW_STEP = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

speedGroup?.addEventListener("keydown", (event) => {
  const step = ARROW_STEP[event.key];
  if (!step) return;
  const from = nodes.speeds.indexOf(event.target);
  if (from === -1) return;
  event.preventDefault();
  const next = nodes.speeds[(from + step + nodes.speeds.length) % nodes.speeds.length];
  next.focus();
  sendControls({ speed: next.dataset.speed });
});

function boardUrl(id, suffix = "") {
  return `/api/board/${encodeURIComponent(id)}${suffix}`;
}

/** Resume the board named in the hash. Returns false — not an error — when
 *  there is nothing to resume, so the caller can create one instead. */
async function resume() {
  const id = location.hash.slice(1);
  if (!ID_PATTERN.test(id)) return false;
  const seq = nextSeq();
  try {
    const res = await fetch(boardUrl(id));
    if (!res.ok) return false;
    boardId = id;
    paint(await res.json(), seq);
    return true;
  } catch (err) {
    console.error("board resume failed", err);
    return false;
  }
}

async function create() {
  const seq = nextSeq();
  const res = await fetch("/api/board", { method: "POST" });
  if (!res.ok) throw new Error(`board create failed: HTTP ${res.status}`);
  const view = await res.json();
  boardId = view.id;
  history.replaceState(null, "", `#${boardId}`);
  paint(view, seq);
}

/** One tick. A dropped poll is not an error state — the loop always rearms, so
 *  the next tick repaints. */
async function poll() {
  if (boardId) {
    const seq = nextSeq();
    try {
      const res = await fetch(boardUrl(boardId));
      if (res.ok) paint(await res.json(), seq);
    } catch {
      // Offline, a flaky hop, a DO still waking up. Try again next tick.
    }
  }
  setTimeout(poll, controlsState(lastView).paused ? POLL_PAUSED_MS : POLL_MS);
}

/** The board's words for a refused seed.
 *
 *  Only the server actually signalling capacity — 409, or an error body naming
 *  it — earns the capacity line. Telling someone to wait for a row to blow off
 *  the edge is advice they can act on when the board is full and a lie when it
 *  is a 400 or a 500; on a 404 it is worse than a lie, because the board they
 *  are waiting on no longer exists. */
async function seedFailure(res) {
  let reason = "";
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") reason = body.error;
  } catch {
    // No body, or not JSON. Decide on the status alone.
  }
  if (res.status === 409 || /\bfull\b|capacity/i.test(reason)) {
    return "the board is full — wait for a row to blow off the edge";
  }
  if (res.status === 404) return "that board is gone — reload to start a new one";
  return "the board would not take that one — try again";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !boardId) return;
  input.value = "";
  say("condensing…");
  const seq = nextSeq();
  try {
    const res = await fetch(boardUrl(boardId, "/seed"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      say(await seedFailure(res));
      return;
    }
    say("");
    paint(await res.json(), seq);
  } catch (err) {
    console.error("seed failed", err);
    say("that did not take — try again");
  }
});

async function start() {
  try {
    if (!(await resume())) await create();
    input.disabled = false;
    input.focus();
    say("");
  } catch (err) {
    console.error("board start failed", err);
    say("could not open a board — reload to try again");
  }
  // Start the loop either way. It is the only thing that repaints, and its own
  // `if (boardId)` guard makes it a no-op until a board exists — so a failed
  // open costs an idle timer rather than a surface that can never recover.
  poll();
}

start();
