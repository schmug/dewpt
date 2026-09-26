// The margin page: write, and the margin listens.
//
// Page   — your writing, a contenteditable of paragraphs. It lives in this
//          browser's localStorage. The server stores only the session seed:
//          paragraph 1's first ≤ 200 chars, exactly like any field seed.
//          Focused paragraphs are embedded and dropped (src/margin-core.ts).
// Margin — words condensed from the session's pool, RE-RANKED toward the
//          paragraph under your caret (POST /margin/focus embeds it; /margin/draw
//          re-ranks, no inference). They live 5–10 s and evaporate unless you
//          click one; a kept word becomes a gold note beside its paragraph.
// The margin never waits: it drips from a local buffer, and a new focus only
// changes what the NEXT draw ranks toward (lazy, like the field's sliders).
//
// All model output reaches the DOM through textContent. Never innerHTML.
// Plan: .claude/plans/marginalia-slice.md.

import {
  DRIP_MS, FOCUS_SETTLE_MS, decodeDraft, drawRetryDelay, encodeDraft, focusChanged, normKey, restMs, room, seedFrom,
  slotNear, ttl,
} from '/margin/margin-model.js';

const $ = (id) => document.getElementById(id);
const els = {
  page: $('page'), margin: $('margin'), hint: $('hint'), evaporated: $('evaporated'),
  seedLabel: $('seedLabel'), seedText: $('seedText'), fieldDoor: $('fieldDoor'), newPage: $('newPage'),
};

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DRAFT_KEY = 'dewpt.margin.draft';
const LINE_H = 26;
const MIN_SEED_CHARS = 12; // UNMEASURED: below this a pause is not yet a paragraph worth seeding

const state = {
  id: null,
  notes: [],          // [{ text, tier, para }] kept words, gold, beside their paragraph
  focus: null,        // { index, text } the paragraph the margin last listened to
  focusSeq: 0,        // only the latest focus response may change state.focus
  buffer: [],         // words drawn but not yet shown
  drawing: false,
  emptyRetries: 0,    // fast retries used while the seed embeds (drawRetryDelay)
  restUntil: 0,       // after a 429, no draws until this time
  creating: false,
  live: new Map(),    // key -> { el, text, tier, y, timer, leaving, pinning }
  evaporated: [],
  settleTimer: 0,
};

// ── api ─────────────────────────────────────────────────────────────────────

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(`/api/session/${state.id}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, data: null };
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

function hint(parts) {
  // parts: array of strings; odd indexes render emphasised. textContent only.
  els.hint.replaceChildren(...parts.map((p, i) => {
    if (i % 2 === 0) return document.createTextNode(p);
    const b = document.createElement('b');
    b.textContent = p;
    return b;
  }));
}

function teach() {
  if (!state.id) return hint(['Write. When you pause, the margin starts listening to ', 'the paragraph you are in', '.']);
  if (state.notes.length === 0) return hint(['Click a word in the margin to ', 'keep', ' it beside this paragraph. The rest evaporate.']);
  return hint(['Move to another paragraph and pause — the margin follows. Unkept words still evaporate.']);
}

// ── the page ────────────────────────────────────────────────────────────────

function paragraphEls() {
  return [...els.page.children].filter((el) => el.tagName === 'P' || el.tagName === 'DIV');
}

function paragraphTexts() {
  return paragraphEls().map((el) => el.innerText.replace(/\n+$/, ''));
}

/** Wrap stray text nodes (an emptied contenteditable types into itself) in <p>. */
function normalizePage() {
  for (const node of [...els.page.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const p = document.createElement('p');
      els.page.replaceChild(p, node);
      p.appendChild(node);
      const sel = getSelection();
      if (sel && sel.anchorNode === node) sel.collapse(node, node.textContent.length);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      node.remove();
    }
  }
  els.page.classList.toggle('blank', paragraphTexts().join('').trim() === '');
}

function renderPage(paragraphs) {
  const list = paragraphs.length ? paragraphs : [''];
  els.page.replaceChildren(...list.map((t) => {
    const p = document.createElement('p');
    if (t) p.textContent = t; else p.appendChild(document.createElement('br'));
    return p;
  }));
  els.page.classList.toggle('blank', list.join('').trim() === '');
}

function caretParagraph() {
  const sel = getSelection();
  if (!sel || !sel.anchorNode || !els.page.contains(sel.anchorNode)) return null;
  let el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
  while (el && el.parentElement !== els.page) el = el.parentElement;
  const paras = paragraphEls();
  const index = el ? paras.indexOf(el) : -1;
  if (index < 0) return null;
  return { index, text: paragraphTexts()[index] ?? '' };
}

/** Top of paragraph `i`, in the margin's coordinate space. */
function paragraphTop(i) {
  const p = paragraphEls()[Math.max(0, Math.min(i, paragraphEls().length - 1))];
  if (!p) return 0;
  return p.getBoundingClientRect().top - els.margin.getBoundingClientRect().top;
}

let saveTimer = 0;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, encodeDraft({ sessionId: state.id, paragraphs: paragraphTexts(), notes: state.notes }));
    } catch { /* private mode or full: the page still works, it just will not survive a reload */ }
  }, 300);
}

// ── session and focus ───────────────────────────────────────────────────────

function scheduleSettle() {
  clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(settle, FOCUS_SETTLE_MS);
}

async function settle() {
  const cur = caretParagraph();
  if (!state.id) {
    const first = (paragraphTexts()[0] ?? '').trim();
    if (first.length >= MIN_SEED_CHARS) await createSession(first);
    if (!state.id) return;
  }
  if (!cur || !focusChanged(state.focus, cur)) return;
  const seq = ++state.focusSeq;
  const r = await api('/margin/focus', 'POST', { text: cur.text });
  if (seq !== state.focusSeq) return; // a later settle owns the focus now
  if (r.ok) {
    state.focus = cur;
    state.buffer = []; // the next draw ranks toward the new paragraph; words already showing stay
    drawMore();
  } else if (r.status === 429) {
    hint(['The margin is resting — too many requests just now. It keeps listening to ', 'the last paragraph', '.']);
  } else if (r.status === 404) {
    lostSession();
  }
}

async function createSession(firstParagraph) {
  if (state.creating) return;
  state.creating = true;
  try {
    const res = await fetch('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed: seedFrom(firstParagraph) }),
    });
    const info = await res.json().catch(() => null);
    if (!res.ok || !info?.id) {
      hint([res.status === 429 ? 'Too many sessions from here just now — try again in a minute.' : 'The margin would not start. Pause again to retry.']);
      return;
    }
    enter(info);
    saveDraft();
    drawMore();
  } catch {
    hint(['The margin would not start — the connection faltered. Pause again to retry.']);
  } finally {
    state.creating = false;
  }
}

function enter(info) {
  state.id = info.id;
  els.seedLabel.hidden = false;
  els.seedText.textContent = info.seed;
  els.fieldDoor.href = `/app/#${info.id}`;
  state.evaporated = info.evaporated ?? [];
  renderEvaporated();
  teach();
}

function lostSession() {
  // Words already in the margin belong to the lost session: their evaporate and
  // keep timers would only post to a session that is gone (review, finding 5).
  for (const v of state.live.values()) { clearTimeout(v.timer); v.el.remove(); }
  state.live.clear();
  state.id = null;
  state.focus = null;
  state.buffer = [];
  els.seedLabel.hidden = true;
  saveDraft();
  hint(['This page lost its weather. Pause in your first paragraph to start it again.']);
}

// ── the margin ──────────────────────────────────────────────────────────────

async function drawMore() {
  if (!state.id || state.drawing || Date.now() < state.restUntil) return;
  state.drawing = true;
  try {
    const visible = [...state.live.values()].map((v) => v.text).concat(state.notes.map((n) => n.text));
    const r = await api('/margin/draw', 'POST', { visible });
    if (r.status === 404) return lostSession();
    if (r.status === 429) {
      state.restUntil = Date.now() + restMs(r.retryAfter);
      hint(['The margin is resting — too many requests just now. It will ', 'pick up again', ' on its own.']);
      return;
    }
    const taken = new Set([...state.live.keys(), ...state.notes.map((n) => normKey(n.text)), ...state.buffer.map((w) => normKey(w.text))]);
    for (const w of r.data?.condensed ?? []) {
      if (!taken.has(normKey(w.text))) { state.buffer.push(w); taken.add(normKey(w.text)); }
    }
    // An empty margin should not wait a whole drip tick. Show the first word
    // now, and while the seed is still embedding (mode "none"), ask again soon,
    // with backoff and a limit (drawRetryDelay).
    if (r.data?.condensed?.length) state.emptyRetries = 0;
    if (state.live.size === 0 && state.buffer.length) spawn(state.buffer.shift());
    if (r.ok && r.data?.mode === 'none' && state.live.size === 0) {
      const delay = drawRetryDelay(state.emptyRetries++);
      if (delay !== null) setTimeout(drawMore, delay);
    }
  } finally {
    state.drawing = false;
  }
}

function drip() {
  if (!state.id || document.hidden) return;
  if (room(state.live.size) > 0 && state.buffer.length) spawn(state.buffer.shift());
  if (state.buffer.length < 3) drawMore();
}

function occupied() {
  const boxes = [...state.live.values()].map((v) => ({ y: v.y, h: LINE_H }));
  for (const el of els.margin.querySelectorAll('.note')) boxes.push({ y: parseFloat(el.style.top) || 0, h: LINE_H });
  return boxes;
}

function spawn(word) {
  const key = normKey(word.text);
  if (state.live.has(key) || state.notes.some((n) => normKey(n.text) === key)) return;
  const anchor = paragraphTop(state.focus?.index ?? 0);
  const maxY = Math.max(els.margin.clientHeight, anchor + LINE_H * 10);
  const y = slotNear(Math.max(0, anchor), occupied(), LINE_H, 0, maxY);
  if (y === null) return; // no free line: skip this tick rather than overprint
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `mword t${word.tier}`;
  el.textContent = word.text;
  el.setAttribute('aria-label', `${word.text} — click to keep it beside this paragraph`);
  el.style.top = `${y}px`;
  els.margin.appendChild(el);
  const entry = { el, text: word.text, tier: word.tier, y, timer: 0, leaving: false, pinning: false, para: state.focus?.index ?? 0 };
  state.live.set(key, entry);
  requestAnimationFrame(() => {
    el.style.opacity = '0.86';
    if (!reduced) el.style.transform = `translateX(${(4 + Math.random() * 6).toFixed(0)}px)`;
  });
  el.addEventListener('click', () => pin(key));
  entry.timer = setTimeout(() => evaporate(key), ttl(Math.random()));
}

function evaporate(key) {
  const v = state.live.get(key);
  if (!v || v.pinning || v.leaving) return;
  v.leaving = true;
  clearTimeout(v.timer);
  v.el.classList.add('leaving');
  v.timer = setTimeout(() => finishEvaporating(key), 1200);
}

async function finishEvaporating(key) {
  const v = state.live.get(key);
  // Re-check after the fade: a word kept mid-fade has crystallised and must
  // never be removed or reported evaporated (CLAUDE.md).
  if (!v || v.pinning) return;
  state.live.delete(key);
  v.el.remove();
  const r = await api('/evaporated', 'POST', { text: v.text, tier: v.tier });
  if (r.data?.evaporated) { state.evaporated = r.data.evaporated; renderEvaporated(); }
}

async function pin(key) {
  const v = state.live.get(key);
  if (!v || v.pinning) return;
  v.pinning = true;
  clearTimeout(v.timer);
  const r = await api('/pin', 'POST', { text: v.text, tier: v.tier });
  if (!r.ok) return pinFailed(key, r);
  state.live.delete(key);
  v.el.remove();
  state.notes.push({ text: v.text, tier: v.tier, para: v.para });
  renderNotes();
  saveDraft();
  teach();
}

/** A keep that did not take must not leave the word immortal: its TTL was
 *  cleared when the pin began. Back on the clock, or finish a fade in progress. */
function pinFailed(key, r) {
  const v = state.live.get(key);
  if (r.status === 429) hint(['Too many requests just now — give it a moment, then ', 'keep it', ' again.']);
  else if (r.status === 404) return lostSession();
  else hint(['Could not ', 'keep it', ' — the connection faltered. Try again.']);
  if (!v) return;
  v.pinning = false;
  if (v.leaving) { finishEvaporating(key); return; }
  v.timer = setTimeout(() => evaporate(key), 2500);
}

function renderNotes() {
  for (const el of els.margin.querySelectorAll('.note')) el.remove();
  const placed = [];
  for (const n of state.notes) {
    const y = slotNear(Math.max(0, paragraphTop(n.para)), placed, LINE_H, 0, Math.max(els.margin.clientHeight, 4000)) ?? 0;
    placed.push({ y, h: LINE_H });
    const el = document.createElement('span');
    el.className = 'note';
    el.textContent = n.text;
    el.title = 'kept';
    el.style.top = `${y}px`;
    els.margin.appendChild(el);
  }
}

function renderEvaporated() {
  els.evaporated.replaceChildren(...state.evaporated.slice(0, 12).map((w) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = w.text;
    b.setAttribute('aria-label', `${w.text} — condense it again`);
    b.addEventListener('click', async () => {
      if (room(state.live.size) <= 0) return hint(['The margin is full — try again as it clears.']);
      const r = await api('/evaporated/restore', 'POST', { text: w.text });
      if (r.data?.evaporated) { state.evaporated = r.data.evaporated; renderEvaporated(); }
      if (r.data?.restored) spawn({ text: r.data.restored.text, tier: r.data.restored.tier });
    });
    li.appendChild(b);
    return li;
  }));
}

function newPage() {
  for (const v of state.live.values()) { clearTimeout(v.timer); v.el.remove(); }
  state.live.clear();
  state.id = null;
  state.focus = null;
  state.buffer = [];
  state.notes = [];
  state.evaporated = [];
  renderEvaporated();
  renderNotes();
  els.seedLabel.hidden = true;
  els.fieldDoor.href = '/app/';
  renderPage([]);
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing stored */ }
  teach();
  els.page.focus();
}

// ── wiring ──────────────────────────────────────────────────────────────────

document.execCommand('defaultParagraphSeparator', false, 'p');

els.page.addEventListener('input', () => {
  normalizePage();
  saveDraft();
  renderNotes();
  scheduleSettle();
});
els.page.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  document.execCommand('insertText', false, text);
});
document.addEventListener('selectionchange', () => {
  if (caretParagraph()) scheduleSettle();
});
els.newPage.addEventListener('click', newPage);
window.addEventListener('resize', renderNotes);

async function boot() {
  let draft = { sessionId: null, paragraphs: [], notes: [] };
  try { draft = decodeDraft(localStorage.getItem(DRAFT_KEY)); } catch { /* no storage */ }
  renderPage(draft.paragraphs);
  state.notes = draft.notes;
  if (draft.sessionId) {
    state.id = draft.sessionId;
    const r = await api('');
    if (r.ok && r.data) enter(r.data);
    else { state.id = null; saveDraft(); }
  }
  renderNotes();
  teach();
  setInterval(drip, DRIP_MS);
  els.page.focus();
}

boot();
