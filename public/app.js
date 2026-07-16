// Session wiring: seed entry, session create/resume (the URL hash is the
// session), sliders → PATCH params, pin/evaporate/prospect persistence, the
// evaporated sidebar, and copy-list. All network calls are fire-and-forget or
// background — the field itself never waits on anything here.

import { createField } from '/field.js';
import { createPoolClient } from '/pool-client.js';

const fieldEl = document.getElementById('field');
const fieldHint = document.getElementById('fieldHint');
const chipsEl = document.getElementById('chips');
const ghostsEl = document.getElementById('ghosts');
const seedForm = document.getElementById('seedForm');
const seedInput = document.getElementById('seedInput');
const seedDisplay = document.getElementById('seedDisplay');
const seedText = document.getElementById('seedText');
const copyBtn = document.getElementById('copyBtn');

const sliders = { strange: document.getElementById('strange'), alt: document.getElementById('alt'), flux: document.getElementById('flux') };
const readouts = { strange: document.getElementById('sVal'), alt: document.getElementById('aVal'), flux: document.getElementById('fVal') };
for (const k in sliders) sliders[k].addEventListener('input', () => readouts[k].textContent = sliders[k].value);

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
  session = { id: info.id };
  location.hash = info.id;
  seedText.textContent = info.seed;
  seedDisplay.hidden = false;
  seedForm.hidden = true;
  fieldHint.textContent = 'click blank space to prospect · click a word to pin it';

  sliders.strange.value = Math.round(info.params.dewpoint * 100);
  sliders.alt.value = Math.round(info.params.altitude * 100);
  sliders.flux.value = Math.round(info.params.drizzle * 100);
  for (const k in sliders) readouts[k].textContent = sliders[k].value;

  evaporatedWords = info.evaporated.map(w => ({ text: w.text, tier: w.tier }));
  renderGhosts();

  const pool = createPoolClient(session.id);
  field = createField({
    fieldEl,
    chipsEl,
    sliders,
    drawWord: bucket => pool.draw(bucket),
    onPin: (text, tier) => quietly(api('/pin', { method: 'POST', body: { text, tier } })),
    onUnpin: text => quietly(api('/pin', { method: 'DELETE', body: { text } })),
    onEvaporate: (text, tier) => {
      noteEvaporated(text, tier);
      quietly(api('/evaporated', { method: 'POST', body: { text, tier } }));
    },
    onProspect: () => quietly(api('/prospect', { method: 'POST', body: { buckets: [] } })),
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

copyBtn.addEventListener('click', () => {
  const list = field ? field.getPinned().join('\n') : '';
  if (list) navigator.clipboard.writeText(list).then(() => {
    copyBtn.textContent = 'Copied';
    setTimeout(() => copyBtn.textContent = 'Copy list', 1400);
  });
});

// resume: the session URL is the session
async function resume() {
  const id = location.hash.slice(1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  try {
    const res = await fetch(`/api/session/${id}`);
    if (!res.ok) return;
    start(await res.json());
  } catch (err) {
    console.error('resume failed', err);
  }
}
resume();
