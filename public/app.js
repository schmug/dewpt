// Session wiring: seed entry, session create/resume (the URL hash is the
// session), sliders → PATCH params, pin/evaporate/prospect persistence, the
// evaporated sidebar, copy-list, the progressive hint line (issue #9), the
// ? interaction legend (issue #10), the pre-seed empty state (issue #11) and
// the "? what is this?" about panel (issue #12). All network calls are
// fire-and-forget or background — the field itself never waits on anything here.

import { createField } from '/field.js';
import { createPoolClient } from '/pool-client.js';
import { nextHintState, HINT_COPY, HINT_TIMEOUTS } from '/hint-machine.js';
import { createPreseed } from '/preseed.js';

const fieldEl = document.getElementById('field');
const fieldHint = document.getElementById('fieldHint');
const hintLive = document.getElementById('hintLive');
const legendBtn = document.getElementById('legendBtn');
const legend = document.getElementById('legend');
const aboutBtn = document.getElementById('aboutBtn');
const about = document.getElementById('about');
const aboutClose = document.getElementById('aboutClose');
const chipsEl = document.getElementById('chips');
const ghostsEl = document.getElementById('ghosts');
const seedForm = document.getElementById('seedForm');
const seedInput = document.getElementById('seedInput');
const seedDisplay = document.getElementById('seedDisplay');
const seedText = document.getElementById('seedText');
const copyBtn = document.getElementById('copyBtn');
const addForm = document.getElementById('addForm');
const addInput = document.getElementById('addInput');

const sliders = { strange: document.getElementById('strange'), alt: document.getElementById('alt'), flux: document.getElementById('flux') };
const readouts = { strange: document.getElementById('sVal'), alt: document.getElementById('aVal'), flux: document.getElementById('fVal') };
for (const k in sliders) sliders[k].addEventListener('input', () => {
  readouts[k].textContent = sliders[k].value;
  hintDispatch('slider'); // retires H3; a no-op in every other hint state
});

let session = null; // { id }
let field = null;
let evaporatedWords = []; // [{ text, tier }] most recent first
const EVAPORATED_CAP = 20;

function api(path, options) {
  return fetch(`/api/session/${session.id}${path}`, options && {
    method: options.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
  });
}

function quietly(promise) {
  promise.catch(err => console.error('dewpt api call failed', err));
}

// ---- progressive hint line (issue #9) ---------------------------------------
// The transitions live in the pure machine (public/hint-machine.js, mirrored
// from src/hint-machine.ts); this block owns the side effects: timers, the
// cross-session taught flag, the crossfade, and the live-region mirror.

const TAUGHT_KEY = 'dewpt.hintTaught';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let hintState = 'preSeed';
let hintTimer = null; // the active state's self-retire timer
let hintRenderTimer = null; // pending crossfade text swap

function isTaught() {
  try { return localStorage.getItem(TAUGHT_KEY) === '1'; } catch { return false; }
}
function markTaught() {
  try { localStorage.setItem(TAUGHT_KEY, '1'); } catch { /* private mode: hints replay next session */ }
}

function renderHint(text) {
  hintLive.textContent = text; // SR mirror outside #field; announces politely
  clearTimeout(hintRenderTimer);
  if (reducedMotion.matches) {
    fieldHint.textContent = text; // instant swap, no motion
    fieldHint.style.opacity = '1'; // in case a pre-toggle fade left it at 0
    return;
  }
  fieldHint.style.opacity = '0'; // fade out (CSS transition), swap, fade back
  hintRenderTimer = setTimeout(() => {
    fieldHint.textContent = text;
    fieldHint.style.opacity = '1';
  }, 450);
}

function hintDispatch(event) {
  const next = nextHintState(hintState, event);
  if (next === hintState) return;
  hintState = next;
  clearTimeout(hintTimer);
  if (hintState === 'slidersPointed' && evaporatedWords.length) {
    // ghosts already rest in the sidebar (resume fast-forward, or evaporations
    // that predate H3's retirement) — H4 needn't wait for the next one
    hintDispatch('evaporate');
    return;
  }
  renderHint(HINT_COPY[hintState]);
  const ms = HINT_TIMEOUTS[hintState];
  if (ms) hintTimer = setTimeout(() => hintDispatch('timeout'), ms);
  if (hintState === 'quiet') markTaught();
}

// ---- ? legend (issue #10) ---------------------------------------------------
// Non-modal: no backdrop, no focus trap, the field keeps condensing behind it.

function setLegendOpen(open) {
  if (open) setAboutOpen(false); // one ? surface at a time (see issue #12 below)
  legend.hidden = !open;
  legendBtn.setAttribute('aria-expanded', String(open));
}
legendBtn.addEventListener('click', () => setLegendOpen(legend.hidden));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!legend.hidden) {
    setLegendOpen(false);
    legendBtn.focus();
  }
  if (!about.hidden) {
    setAboutOpen(false);
    aboutBtn.focus();
  }
});
document.addEventListener('click', e => {
  if (!legend.hidden && !e.target.closest('#legendWrap')) setLegendOpen(false);
});

// ---- "? what is this?" about panel (issue #12) ------------------------------
// The concept layer: sibling of the legend (mechanics layer), same non-modal
// discipline — no backdrop, no focus trap, no pause; the field keeps
// condensing while it's open. Mutually exclusive with the legend so the two
// ? surfaces never stack. Deliberately not closed on outside clicks: it is a
// docked reading panel, and playing with the field mid-read must not dismiss
// it — it closes via the toggle, its close button, or Esc.

function setAboutOpen(open) {
  if (open && !legend.hidden) setLegendOpen(false);
  about.hidden = !open;
  aboutBtn.setAttribute('aria-expanded', String(open));
}
aboutBtn.addEventListener('click', () => setAboutOpen(about.hidden));
aboutClose.addEventListener('click', () => {
  setAboutOpen(false);
  aboutBtn.focus();
});

// ---- evaporated sidebar -----------------------------------------------------

function renderGhosts() {
  ghostsEl.innerHTML = '';
  if (!evaporatedWords.length) {
    ghostsEl.innerHTML = '<span class="empty">nothing has evaporated yet</span>';
    return;
  }
  for (const word of evaporatedWords) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.type = 'button';
    b.textContent = word.text;
    b.setAttribute('aria-label', 'Condense ' + word.text + ' again');
    b.addEventListener('click', () => restoreWord(word));
    ghostsEl.appendChild(b);
  }
}

function noteEvaporated(text, tier) {
  evaporatedWords = evaporatedWords.filter(w => w.text !== text);
  evaporatedWords.unshift({ text, tier });
  evaporatedWords.length = Math.min(evaporatedWords.length, EVAPORATED_CAP);
  renderGhosts();
}

function restoreWord(word) {
  evaporatedWords = evaporatedWords.filter(w => w.text !== word.text);
  renderGhosts();
  field.spawnText(word.text, word.tier); // condense it again immediately
  hintDispatch('restore');
  quietly(api('/evaporated/restore', { method: 'POST', body: { text: word.text } }));
}

// ---- session ----------------------------------------------------------------

function currentParams() {
  return { dewpoint: sliders.strange.value / 100, altitude: sliders.alt.value / 100, drizzle: sliders.flux.value / 100 };
}

let paramsTimer = null;
function schedulePatchParams() {
  if (!session) return;
  clearTimeout(paramsTimer);
  paramsTimer = setTimeout(() => {
    quietly(api('/params', { method: 'PATCH', body: currentParams() }));
  }, 400);
}
sliders.strange.addEventListener('input', schedulePatchParams);
sliders.alt.addEventListener('input', schedulePatchParams);
sliders.flux.addEventListener('input', schedulePatchParams);

function start(info) {
  preseed.teardown(); // the pre-seed weather evaporates the moment a session exists
  session = { id: info.id };
  location.hash = info.id;
  seedText.textContent = info.seed;
  seedDisplay.hidden = false;
  seedForm.hidden = true;
  addInput.disabled = false; // the condensate add-your-own input only works with a live session

  sliders.strange.value = Math.round(info.params.dewpoint * 100);
  sliders.alt.value = Math.round(info.params.altitude * 100);
  sliders.flux.value = Math.round(info.params.drizzle * 100);
  for (const k in sliders) readouts[k].textContent = sliders[k].value;

  evaporatedWords = info.evaporated.map(w => ({ text: w.text, tier: w.tier }));
  renderGhosts();

  // hint machine: taught users get the one-line reminder; a resumed session
  // with anchors has already demonstrated pinning, so replay it (skip to H3)
  hintDispatch(isTaught() ? 'seedTaught' : 'seed');
  if (info.anchors.length) hintDispatch('pin');

  const pool = createPoolClient(session.id);
  field = createField({
    fieldEl,
    chipsEl,
    sliders,
    drawWord: bucket => pool.draw(bucket),
    onPin: (text, tier) => {
      hintDispatch('pin');
      quietly(api('/pin', { method: 'POST', body: { text, tier } }));
    },
    onUnpin: text => quietly(api('/pin', { method: 'DELETE', body: { text } })),
    onEvaporate: (text, tier) => {
      noteEvaporated(text, tier);
      hintDispatch('evaporate');
      quietly(api('/evaporated', { method: 'POST', body: { text, tier } }));
    },
    onProspect: () => {
      hintDispatch('prospect');
      quietly(api('/prospect', { method: 'POST', body: { buckets: [] } }));
    },
  });
  field.hydratePinned(info.anchors);
  pool.prime();
  field.start();
}

seedForm.addEventListener('submit', async e => {
  e.preventDefault();
  const seed = seedInput.value.trim();
  if (!seed) return;
  seedForm.querySelector('button').disabled = true;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, ...currentParams() }),
    });
    if (!res.ok) throw new Error(`session create failed: ${res.status}`);
    start(await res.json());
  } catch (err) {
    console.error(err);
    seedForm.querySelector('button').disabled = false;
  }
});

// ---- add your own word (issue #20) ------------------------------------------
// A user mid-session drops their own word/phrase into the condensate to steer
// generation toward something the AI hasn't offered. It rides the pin/anchor
// path: condense it optimistically (before any round-trip), then persist it as
// an anchor via /add. tier 1 — a typed word has no band of origin, so it takes
// the neutral middle. An added word is a pin, so it advances the hint machine
// like any pin.
addForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!session || !field) return;
  const text = addInput.value.trim();
  if (!text) return;
  addInput.value = '';
  const added = field.addOwnWord(text, 1); // condenses immediately, no network wait
  if (!added) return; // already in the condensate — nothing to persist
  hintDispatch('pin');
  quietly(api('/add', { method: 'POST', body: { text, tier: 1 } }));
});

// Export the condensate. On touch, offer the native share sheet where the
// browser supports it (mobile-idiomatic, SPEC M5); everywhere else — and as the
// fallback if share is unavailable or fails — copy to the clipboard, which is
// byte-for-byte the previous desktop behavior. Share is gated behind a coarse
// pointer so the desktop copy button is unchanged.
const touchShare = 'share' in navigator && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

function copyCondensate(list) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(list).then(() => {
    copyBtn.textContent = 'Copied';
    setTimeout(() => copyBtn.textContent = 'Copy list', 1400);
  }).catch(err => console.error('dewpt copy failed', err));
}

copyBtn.addEventListener('click', async () => {
  const list = field ? field.getPinned().join('\n') : '';
  if (!list) return;
  if (touchShare) {
    try {
      await navigator.share({ title: 'dewpt condensate', text: list });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user dismissed the sheet
      // any other failure falls through to the clipboard path below
    }
  }
  copyCondensate(list);
});

// ---- pre-seed empty state (issue #11) ---------------------------------------
// Before any session, the field demonstrates the concept: centered manifesto
// plus meta-words condensing and evaporating through the real field motion.
// Static client-side pool — zero network before session create.

const preseed = createPreseed({
  fieldEl,
  sliders,
  // no session to pin into, so a meta-word click funnels to the one action
  // that matters pre-seed: seeding the field
  onWordClick: () => seedInput.focus(),
});

// resume: the session URL is the session
async function resume() {
  const id = location.hash.slice(1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  try {
    const res = await fetch(`/api/session/${id}`);
    if (!res.ok) return false;
    start(await res.json());
    return true;
  } catch (err) {
    console.error('resume failed', err);
    return false;
  }
}
resume().then(resumed => {
  // hash arrivals go straight to the live session (no manifesto flash);
  // everyone else — including a failed resume — gets the pre-seed weather.
  // The !session guard covers a seed submitted while the resume fetch flew.
  if (!resumed && !session) preseed.start();
});
