// drift's controller. Owns pixels and lifecycle; position.js owns the maths and
// working-set.js owns the network.
//
// Client-only by design: no Durable Object, no src/ change. Coordinates already
// ship on the wire as Served.coords, so this surface is a new renderer over
// machinery that has been sitting unrendered since workstream C.

import { createAxisClient } from '/axes.js';
import { lintAgainstPool, lintPoles } from './axis-lint.js';
import { createSession, createWorkingSet, pinWord } from './working-set.js';
import {
  SUPPLY_FLOOR, SUPPLY_RADIUS,
  freezeRange, initialPosition, localSupply, nextCard, stepPosition, toNormalized, widenRange,
} from './position.js';

const els = {
  setup: document.getElementById('drift-setup'),
  seedForm: document.getElementById('drift-seed-form'),
  seedInput: document.getElementById('drift-seed-input'),
  axisForm: document.getElementById('drift-axis-form'),
  aNeg: document.getElementById('drift-axis-a-neg'),
  aPos: document.getElementById('drift-axis-a-pos'),
  bNeg: document.getElementById('drift-axis-b-neg'),
  bPos: document.getElementById('drift-axis-b-pos'),
  status: document.getElementById('drift-axis-status'),
  stage: document.getElementById('drift-stage'),
  card: document.getElementById('drift-card'),
  gauges: document.getElementById('drift-gauges'),
  condensate: document.getElementById('drift-condensate'),
  condensateCount: document.getElementById('drift-condensate-count'),
  condensatePanel: document.getElementById('drift-condensate-panel'),
  edge: document.getElementById('drift-edge'),
};

export const state = {
  sessionId: null,
  axisClient: null,
  set: null,
  range: null,
  position: null,
  seen: new Set(),
  axes: [],
  pinned: [],
  current: null,
};

function say(message, tone) {
  els.status.textContent = message;
  if (tone) els.status.dataset.tone = tone;
  else delete els.status.dataset.tone;
}

// ── seed ────────────────────────────────────────────────────────────────────

els.seedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const seed = els.seedInput.value.trim();
  if (!seed) return;
  const button = els.seedForm.querySelector('button');
  button.disabled = true;
  try {
    const session = await createSession(seed, { dewpoint: 0.35, altitude: 0.25, drizzle: 0.5 });
    state.sessionId = session.id;
    state.axisClient = createAxisClient(session.id);
    state.set = createWorkingSet(session.id);
    // A flush means every held coord was scored against a different axis set.
    // The frozen range and the seen set are shaped for those coords too, so
    // they go with it.
    // A flush means every held coord was scored against a different axis set —
 // so the CARD ON SCREEN is stale too. Clearing range and seen while leaving it
 // painted left the user looking at a position that no longer exists.
    state.set.onFlush(() => {
      state.range = null;
      state.seen = new Set();
      state.current = null;
      if (els.card) els.card.textContent = '';
    });
    location.hash = session.id;
    els.seedForm.hidden = true;
    els.axisForm.hidden = false;
    els.aNeg.focus();
  } catch (err) {
    console.error(err);
    say('could not start a session. try again.', 'warn');
    button.disabled = false;
  }
});

// ── axes ────────────────────────────────────────────────────────────────────

/** Axis creation is slow by design — the server expands both poles with an LLM
 *  call before embedding them — so this shows progress and never runs on the
 *  swipe path. */
async function createAxis(negTerm, posTerm) {
  // createAxisClient.create() resolves to the axes ARRAY itself, not to a
  // { axes } envelope — verified against the running server, not assumed. The
  // newly created axis is the last element.
  const axes = await state.axisClient.create(negTerm, posTerm);
  return axes[axes.length - 1];
}

/** An axis is { id, neg: {term, phrase}, pos: {term, phrase}, ready, degraded }.
 *  The poles are NESTED; there are no flat negTerm/posPhrase fields. Read off
 *  the live API rather than assumed — the flat shape cost a full browser debug
 *  cycle, and the failure was silent in a nasty way: the server had already
 *  created the axis before the client threw on the shape, so the UI reported
 *  "could not create that axis" about an axis that existed. */
const negTermOf = (a) => a.neg.term;
const posTermOf = (a) => a.pos.term;

/** Warnings raised during setup, kept so a later axis cannot silently overwrite
 *  an earlier one's problem and so a degraded pole survives setup being hidden.
 *  Critic cycle 1. */
const axisNotes = [];

function reportAxis(axis) {
  // A degraded pole means expandPole fell back to the bare term. The spike puts
  // a bare term at AUC 0.640 against 0.980 for a descriptive phrase, so this is
  // a quality cliff the user has to be able to see.
  if (axis.degraded) {
    const note = `"${negTermOf(axis)}" or "${posTermOf(axis)}" could not be expanded, so this axis will sort weakly.`;
    axisNotes.push({ axisId: axis.id, degraded: true, message: note });
    say(axisNotes.map((n) => n.message).join('  '), 'degraded');
    return;
  }
  const report = lintPoles(negTermOf(axis), posTermOf(axis), axis.neg.phrase, axis.pos.phrase);
  if (report.warnings.length > 0) {
    // Warn and allow, never block. The lint can tell you an axis is fake; it
    // can never tell you an axis is meaningful, so it must not read as a
    // verdict — and workstream B found nothing cheap that catches a merely
    // WEAK axis at all.
    //
    // ALL warnings accumulate. Showing only the newest let a second axis erase
    // the first's problem before the user had read it.
    for (const w of report.warnings) axisNotes.push({ axisId: axis.id, degraded: false, message: w.message });
    say(axisNotes.map((n) => n.message).join('  '), 'warn');
  }
}

els.axisForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pairs = [
    [els.aNeg.value.trim(), els.aPos.value.trim()],
    [els.bNeg.value.trim(), els.bPos.value.trim()],
  ].filter(([n, p]) => n && p);
  if (pairs.length === 0) {
    say('name at least one direction — two gives you all four swipes.', 'warn');
    return;
  }
  const button = els.axisForm.querySelector('button');
  button.disabled = true;

  // A retry after a failed prime must NOT create the axes again — the server
  // would stack duplicates and walk the session into the MAX_AXES cap. If we
  // already have axes, this submit means "try the prime again".
  if (state.axes.length > 0) {
    await enterStage();
    return;
  }

  say('expanding the poles…');
  const created = [];
  for (const [negTerm, posTerm] of pairs) {
    try {
      const axis = await createAxis(negTerm, posTerm);
      created.push(axis);
      reportAxis(axis);
    } catch (err) {
      // 409 (cap) and 422 (degenerate poles) both carry `error` PLUS the
      // current `axes`, specifically so this can explain and repaint without a
      // follow-up GET. Adopt them: the refusal does not mean the session has no
      // axes, and dropping the payload threw away the only copy we were given.
      const detail = err?.payload?.error ?? 'could not create that axis';
      const serverAxes = err?.payload?.axes;
      if (Array.isArray(serverAxes) && serverAxes.length > 0) {
        state.axes = serverAxes.filter((a) => a.ready !== false).slice(0, 2);
      }
      axisNotes.push({ axisId: null, degraded: false, message: `"${negTerm}" ↔ "${posTerm}": ${detail}` });
      say(axisNotes.map((n) => n.message).join('  '), 'warn');
    }
  }
  if (created.length === 0) {
    button.disabled = false;
    return;
  }
  // A ready:false axis produces no coordinate, so pool rows come back with fewer
  // coords than axes and every candidate ranks as unreachable — the surface goes
  // silently empty rather than degrading to one axis. Cycle 2.
  const usable = created.filter((a) => a.ready !== false);
  if (usable.length < created.length) {
    axisNotes.push({ axisId: null, degraded: false, message: 'one axis is not ready yet and has been left out.' });
    say(axisNotes.map((n) => n.message).join('  '), 'warn');
  }
  if (usable.length === 0) {
    say('no axis is ready — try different words.', 'warn');
    button.disabled = false;
    return;
  }
  state.axes = usable;
  await enterStage();
});

// ── prime and hand off ──────────────────────────────────────────────────────

/** How long to keep waiting for the DO's first generation pass before giving
 *  up. Generation is alarm-driven and asynchronous, so a BRAND NEW session's
 *  pool is always empty for the first several seconds — priming once and
 *  reporting "nothing condensed yet" makes every first run a dead end. Measured
 *  against production: an empty pool was still empty at 60s on one session, so
 *  this waits generously and then says something the user can act on.
 *  UNMEASURED as a threshold; it is a patience budget, not a tuned constant. */
const PRIME_TIMEOUT_MS = 75_000;
/** Gap between prime attempts. UNMEASURED — chosen to be slower than a render
 *  frame and faster than a user gives up, which is a judgement, not a finding. */
const PRIME_RETRY_MS = 2_500;

async function enterStage() {
  say('condensing…');
  // Axes before prime: a draw taken before the axes are ready comes back with
  // coords: [] and is unrankable. working-set.js drops those rows, so an early
  // prime would silently yield an empty set rather than a wrong one.
  //
  // Retry rather than give up. The pool filling is a matter of when, not
  // whether — the DO's pump is already running by the time the first draw
  // returns empty.
  const deadline = Date.now() + PRIME_TIMEOUT_MS;
  let wait = PRIME_RETRY_MS;
  let attempts = 0;
  while (true) {
    await state.set.prime();
    attempts++;
    const failed = state.set.failedBuckets();
    const empty = state.set.emptyBuckets();
    if (state.set.size() > 0) {
      // A partial pool is not a finished one. Keep filling both the buckets
      // that errored and the ones that answered empty, in the background.
      if (failed.length > 0 || empty.length > 0) backgroundFill();
      break;
    }
    if (Date.now() >= deadline) {
      // SAY WHICH FAILURE THIS IS. A generic "reload to try again" left the
      // user unable to tell a busy generator from a broken one, and left me
      // unable to tell either from a smoke log. Cycle 2.
      const diagnosis = failed.length > 0
        ? `${failed.length} of 6 requests failed — the field may be unreachable.`
        : 'the field is still generating and has produced nothing yet.';
      say(`nothing condensed after ${Math.round(PRIME_TIMEOUT_MS / 1000)}s. ${diagnosis} reload to try again.`, 'warn');
      console.error('drift prime gave up', { attempts, failed, empty, elapsedMs: PRIME_TIMEOUT_MS });
      els.axisForm.querySelector('button').disabled = false;
      return;
    }
    // Bounded exponential backoff rather than a fixed interval: a busy DO is
    // not helped by being asked six more times a second.
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 1.5, 10_000);
  }
  state.range = freezeRange(state.set.all(), state.axes.length);
  state.position = initialPosition(state.range);
  // Stage 2 needs a pool to rank, so it can only run now. Warn and allow, same
  // as stage 1 — the surface stays usable either way.
  state.axes.forEach((axis, i) => {
    const { warning } = lintAgainstPool(axis.neg.phrase, axis.pos.phrase, state.set.all(), i);
    if (warning) {
      console.warn(`drift axis "${negTermOf(axis)}" ↔ "${posTermOf(axis)}": ${warning.message}`);
    }
  });
  els.setup.hidden = true;
  els.stage.hidden = false;
  renderGauges();
  paintCondensate();
  advance();
}

// renderGauges, advance, onSwipe and the condensate handlers are Task 6 and 7.
export { enterStage };

/** Keeps refilling buckets that errored or came back empty, with backoff, until
 *  they are all contributing or the attempts run out. A single immediate top-up
 *  left the session running on whatever the first pass happened to get. */
let fillTimer = null;
function backgroundFill(attempt = 0) {
  clearTimeout(fillTimer);
  if (attempt >= 6) return;
  fillTimer = setTimeout(() => {
    state.set.topUp()
      .then(() => {
        if (state.range) state.range = widenRange(state.range, state.set.all());
        paintGauges();
        if (state.current === null) advance();
        const outstanding = state.set.failedBuckets().length + state.set.emptyBuckets().length;
        if (outstanding > 0) backgroundFill(attempt + 1);
      })
      .catch((err) => {
        console.error('drift background refill failed', err);
        backgroundFill(attempt + 1);
      });
  }, Math.min(2_000 * 2 ** attempt, 20_000));
}

// ── resume ──────────────────────────────────────────────────────────────────

/** The URL hash IS the session, so a reload must resume rather than dump you on
 *  an empty seed form. The working SET does not survive — drawPool is
 *  destructive, so those candidates are gone — but the session, its axes and
 *  its pins all live server-side, and the pool refills. Critic cycle 1: the
 *  spec claimed the session survives a reload while the client silently started
 *  over. Either the claim goes or the behaviour does; the behaviour was cheaper
 *  and better. */
async function resumeFromHash() {
  const id = location.hash.slice(1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  try {
    state.sessionId = id;
    state.axisClient = createAxisClient(id);
    const axes = await state.axisClient.list();
    const ready = (Array.isArray(axes) ? axes : axes?.axes ?? []).filter((a) => a.ready !== false);
    if (ready.length === 0) return false;
    state.axes = ready.slice(0, 2);
    // Anchors live server-side and come back on GET /api/session/:id. Resuming
    // without them reset the condensate to zero while a comment claimed pins
    // survive a reload — the claim was false. Cycle 2.
    try {
      const info = await fetch(`/api/session/${id}`).then((r) => (r.ok ? r.json() : null));
      if (info && Array.isArray(info.anchors)) state.pinned = info.anchors.map((a) => a.text);
    } catch (err) {
      console.error('drift could not restore pins', err);
    }
    state.set = createWorkingSet(id);
    state.set.onFlush(() => {
      state.range = null;
      state.seen = new Set();
      state.current = null;
      if (els.card) els.card.textContent = '';
    });
    els.seedForm.hidden = true;
    els.axisForm.hidden = true;
    await enterStage();
    return true;
  } catch (err) {
    console.error('drift resume failed', err);
    return false;
  }
}

resumeFromHash();

// ── the card loop ───────────────────────────────────────────────────────────

const AXIS_KEYS = [
  { axis: 0, dir: -1, key: 'ArrowLeft' },
  { axis: 0, dir: 1, key: 'ArrowRight' },
  { axis: 1, dir: -1, key: 'ArrowUp' },
  { axis: 1, dir: 1, key: 'ArrowDown' },
];

function renderGauges() {
  els.gauges.textContent = '';
  // With one axis named — or one of two failing to create — up/down have
  // nowhere to go. The spec's degradation rule is that they go inert and are
  // LABELLED inert, so the surface opens rather than refusing and the user is
  // not left swiping at a direction that silently does nothing.
  document.getElementById('drift-hint').textContent =
    state.axes.length >= 2 ? 'swipe to move · tap to keep' : 'swipe left and right to move · tap to keep';
  state.axes.forEach((axis, i) => {
    const row = document.createElement('div');
    row.className = 'drift-gauge';
    // A degraded pole is a permanent property of the axis, not a setup-time
    // toast. It rides the gauge so it survives setup being hidden.
    if (axis.degraded) {
      row.dataset.degraded = 'true';
      row.title = 'this axis could not be expanded and sorts weakly';
    }
    const lo = document.createElement('span');
    // textContent, never innerHTML: these are user-typed terms, and the card
    // below is model output. Both are untrusted.
    lo.textContent = negTermOf(axis);
    const track = document.createElement('div');
    track.className = 'drift-gauge-track';
    const mark = document.createElement('i');
    mark.className = 'drift-gauge-mark';
    mark.dataset.axis = String(i);
    track.appendChild(mark);
    const hi = document.createElement('span');
    hi.textContent = posTermOf(axis);
    row.append(lo, track, hi);
    els.gauges.appendChild(row);
  });
  paintGauges();
}

function paintGauges() {
  for (const mark of els.gauges.querySelectorAll('.drift-gauge-mark')) {
    const a = Number(mark.dataset.axis);
    mark.style.left = `${toNormalized(state.position[a], state.range, a) * 100}%`;
  }
}

/** Show the nearest unseen candidate, or the edge. Synchronous by contract —
 *  never awaits, because a swipe must resolve from the resident set. */
/** Must match the opacity transition in styles.css. Declared here rather than
 *  read from computed style so the swap cannot silently outrun the fade. */
const FADE_MS = 300;
let fadeTimer = null;

/** The actual crossfade. styles.css has always DECLARED an opacity transition,
 *  but the old advance() replaced textContent outright and never toggled
 *  anything, so nothing ever animated — and both the source guard and the
 *  browser check inspected computed declarations, so both passed on a
 *  transition that never ran. Cycle 2. */
function paintCard(card) {
  const write = () => {
    if (card === null) {
      els.card.textContent = '';
      els.card.removeAttribute('data-tier');
      els.edge.hidden = false;
      // Say WHICH way is empty, not just that something is.
      els.edge.textContent = 'nothing tethered out this far — swipe back';
    } else {
      els.edge.hidden = true;
      els.card.textContent = card.text;
      els.card.dataset.tier = String(card.tier);
      els.card.dataset.pinned = String(state.pinned.includes(card.text));
    }
    delete els.card.dataset.leaving;
  };

  // Nothing on screen yet, or no motion wanted: swap straight away.
  if (!els.card.textContent || prefersReducedMotionInstant()) { write(); return; }

  els.card.dataset.leaving = 'true';
  clearTimeout(fadeTimer);
  // Scheduled, never awaited — onSwipe stays synchronous and the card never
  // waits on anything.
  fadeTimer = setTimeout(write, FADE_MS);
}

/** Reduced motion still CROSSFADES — opacity keeps transitioning, transform
 *  does not move. This returns true only if the user has asked for no motion
 *  AND the browser reports no transition at all, which is the belt-and-braces
 *  case where waiting for a fade would hang the swap forever. */
function prefersReducedMotionInstant() {
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const dur = getComputedStyle(els.card).transitionDuration;
  return !dur || /^0s(,\s*0s)*$/.test(dur);
}

function advance() {
  const card = nextCard(state.set.all(), state.position, state.range, state.seen);
  state.current = card;
  if (card !== null) state.seen.add(card.text);
  paintCard(card);
}

/** A swipe. NO await anywhere in here — pool depth is a correctness
 *  requirement, not an optimization (CLAUDE.md), and the top-up below is
 *  deliberately un-awaited so the card never waits on the network. */
function onSwipe(axis, dir) {
  if (state.range === null || axis >= state.axes.length) return null;
  state.position = stepPosition(state.position, state.range, axis, dir);
  paintGauges();
  advance();
  maybeTopUp();
  return state.current;
}

/** Fire-and-forget. The trigger is LOCAL supply near the current position: a
 *  set of 180 can be plentiful overall and empty exactly where you stand. */
function maybeTopUp() {
  const supply = localSupply(state.set.all(), state.position, state.range, state.seen, SUPPLY_RADIUS);
  if (supply >= SUPPLY_FLOOR) return;
  state.set.topUp()
    .then(() => {
      if (state.range === null) {
        // The set flushed under us — the axis set changed. Re-freeze from
        // whatever arrived rather than reusing a range shaped for old coords.
        if (state.set.size() === 0) return;
        state.range = freezeRange(state.set.all(), state.axes.length);
        state.position = initialPosition(state.range);
      } else {
        state.range = widenRange(state.range, state.set.all());
      }
      paintGauges();
      if (state.current === null) advance();
    })
    .catch((err) => console.error('drift top-up failed', err));
}

// ── input ───────────────────────────────────────────────────────────────────

let touchStart = null;
/** Minimum travel before a touch counts as a swipe rather than a tap.
 *  UNMEASURED — 40px is roughly a thumb's incidental drift on a 390px screen,
 *  chosen so a deliberate swipe and a resting tap separate cleanly. Should be
 *  checked against real thumbs; it is a judgement call, not a tuned value. */
const SWIPE_MIN_PX = 40;

els.card.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

els.card.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) return; // a tap; the click handler owns it
  if (Math.abs(dx) >= Math.abs(dy)) onSwipe(0, dx > 0 ? 1 : -1);
  else onSwipe(1, dy > 0 ? 1 : -1);
}, { passive: true });

// Keyboard parity, so the surface is operable without a pointer (#26's concern,
// solved here rather than inherited).
els.card.addEventListener('keydown', (e) => {
  const match = AXIS_KEYS.find((k) => k.key === e.key);
  if (match) {
    e.preventDefault();
    onSwipe(match.axis, match.dir);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pinCurrent();
  }
});

export { advance, onSwipe, renderGauges };

// ── condensate ──────────────────────────────────────────────────────────────

/** Tap keeps. Pins are shared session state, so a pin made here is a pin in the
 *  field. This is a FOREGROUND user action: unlike a background top-up, its
 *  failure must surface rather than be swallowed. */
async function pinCurrent() {
  const card = state.current;
  if (!card || state.pinned.includes(card.text)) return;
  els.card.dataset.pinned = 'true';
  state.pinned.push(card.text);
  paintCondensate();
  try {
    await pinWord(state.sessionId, card.text, card.tier);
  } catch (err) {
    console.error(err);
    // Roll the optimistic paint back rather than showing a pin the server does
    // not have.
    state.pinned = state.pinned.filter((t) => t !== card.text);
    els.card.dataset.pinned = 'false';
    paintCondensate();
    els.edge.hidden = false;
    els.edge.textContent = 'could not keep that one';
  }
}

function paintCondensate() {
  els.condensateCount.textContent = String(state.pinned.length);
  els.condensatePanel.textContent = '';
  for (const text of state.pinned) {
    const row = document.createElement('div');
    row.className = 'drift-condensate-item';
    row.textContent = text;
    els.condensatePanel.appendChild(row);
  }
}

els.card.addEventListener('click', (e) => {
  e.preventDefault();
  pinCurrent();
});

els.condensate.addEventListener('click', () => {
  const open = els.condensatePanel.hidden;
  els.condensatePanel.hidden = !open;
  els.condensate.setAttribute('aria-expanded', String(open));
});

// The panel dismisses on its own click and on Escape — deliberately NOT on a
// swipe. A swipe-to-dismiss over a swipe surface is the one real hazard in
// choosing an expandable chip, and the two gestures must not overlap.
els.condensatePanel.addEventListener('click', () => {
  els.condensatePanel.hidden = true;
  els.condensate.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.condensatePanel.hidden) {
    els.condensatePanel.hidden = true;
    els.condensate.setAttribute('aria-expanded', 'false');
    els.condensate.focus();
  }
});

export { pinCurrent };
