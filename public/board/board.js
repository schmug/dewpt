// Board session bootstrap, seeding and polling. Layout lives in
// belt-model.js and DOM writing in belt-render.js; this file owns the network
// and nothing else.

import { paintBoard } from "./belt-render.js";

const POLL_MS = 900;

/** The session URL is the session, as in SPEC.md — the id rides in the hash so
 *  a reload resumes rather than starting a fresh board. */
const ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/;

const nodes = {
  stations: document.getElementById("board-stations"),
  belt: document.getElementById("board-belt"),
  evaporated: document.getElementById("board-evaporated"),
};
const form = document.getElementById("board-seed-form");
const input = document.getElementById("board-seed-input");
const status = document.getElementById("board-status");

let boardId = null;

function say(message) {
  status.textContent = message;
}

function paint(view) {
  paintBoard(nodes, view);
}

function boardUrl(id, suffix = "") {
  return `/api/board/${encodeURIComponent(id)}${suffix}`;
}

/** Resume the board named in the hash. Returns false — not an error — when
 *  there is nothing to resume, so the caller can create one instead. */
async function resume() {
  const id = location.hash.slice(1);
  if (!ID_PATTERN.test(id)) return false;
  try {
    const res = await fetch(boardUrl(id));
    if (!res.ok) return false;
    boardId = id;
    paint(await res.json());
    return true;
  } catch (err) {
    console.error("board resume failed", err);
    return false;
  }
}

async function create() {
  const res = await fetch("/api/board", { method: "POST" });
  if (!res.ok) throw new Error(`board create failed: HTTP ${res.status}`);
  const view = await res.json();
  boardId = view.id;
  history.replaceState(null, "", `#${boardId}`);
  paint(view);
}

/** One tick. A dropped poll is not an error state — the loop always rearms, so
 *  the next tick repaints. */
async function poll() {
  if (boardId) {
    try {
      const res = await fetch(boardUrl(boardId));
      if (res.ok) paint(await res.json());
    } catch {
      // Offline, a flaky hop, a DO still waking up. Try again next tick.
    }
  }
  setTimeout(poll, POLL_MS);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !boardId) return;
  input.value = "";
  say("condensing…");
  try {
    const res = await fetch(boardUrl(boardId, "/seed"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      say("the board is full — wait for a row to blow off the edge");
      return;
    }
    say("");
    paint(await res.json());
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
