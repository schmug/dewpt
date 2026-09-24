// The ground page: weather above, ground below.
//
// Sky   — ambient weather from the session pool (pool-client.js, unchanged).
//         Click a word to pin it; it falls to the ground.
// Ground — only pinned words (the server enforces it: src/ground-core.ts
//         pruneToAnchors). Drag to arrange. Click open ground beside your
//         words: dew condenses from what is nearby. Thread two words; the mark
//         on the thread asks what connects them.
// Dew and sky words are ephemeral and share the field's CAP = 14.
//
// All model output reaches the DOM through textContent. Never innerHTML.

import { createPoolClient } from '/pool-client.js';
import { blurBand, wordOpacity } from '/depth.js';
import {
  GROUND_H, GROUND_W, bucketOrder, dewSpots, edgePoint, groundScale, landingSpot, makeRoom, normKey, room,
  threadMid, toGround, toScreen, ttl, wordWidth,
} from '/ground/ground-model.js';

const $ = (id) => document.getElementById(id);
const els = {
  sky: $('sky'), ground: $('ground'), groundWrap: $('groundWrap'), threads: $('threads'),
  empty: $('groundEmpty'), seedForm: $('seedForm'), seedInput: $('seedInput'), seedLabel: $('seedLabel'),
  seedText: $('seedText'), dewline: $('dewline'), hint: $('hint'), evaporated: $('evaporated'),
  exportLink: $('exportLink'), fieldDoor: $('fieldDoor'), menu: $('menu'), more: $('groundMore'),
};

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const DEWPOINT = 0.35; // DEFAULT_PARAMS in src/types.ts — the ground has no sliders yet
const ALTITUDE = 0.25;
const DRIZZLE_MS = 850; // UNMEASURED: one spawn attempt per 0.85 s, close to the field at mid drizzle

const state = {
  id: null,
  scene: { words: [], threads: [] },
  scale: 1,
  sky: new Map(),  // key -> { el, text, tier, born }
  dew: new Map(),  // key -> { el, text, tier, x, y }
  evaporated: [],
  selected: null,  // key of the selected ground word
  landing: new Map(), // key -> box of a word still falling, so the next pin lands clear of it
  drag: null,      // { key, x, y } while a word is under the pointer — survives any re-render
  threadFrom: null,
  pool: null,
  busy: false,
  gesture: false,  // a prospect or bridge request is in flight — one at a time
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
  return { ok: res.ok, status: res.status, data };
}

function trouble(r, what) {
  if (r.status === 429) hint(['Too many requests just now — give it a moment, then ', what, ' again.']);
  else if (r.status === 404) hint(['This session is gone. Seed a new one.']);
  else hint(['Could not ', what, ' — the connection faltered. Try again.']);
}

// Scene-changing requests can overlap (a pin's landing still in flight while
// the user drags another word). Apply a response only if no later scene
// request has been issued since, so a slow early answer cannot roll the
// ground back under the user's hand.
let sceneSeq = 0;
let sceneInflight = 0;
let refreshWanted = false;
async function sceneRequest(path, method, body) {
  const seq = ++sceneSeq;
  sceneInflight++;
  try {
    const r = await api(path, method, body);
    const scene = r.data?.scene;
    return { ...r, fresh: seq === sceneSeq && !!scene, scene };
  } finally {
    sceneInflight--;
    // A refresh asked for while other scene requests were in flight waits for
    // them: issued earlier, it could overtake a drag's move at the DO and
    // snap the word back.
    if (sceneInflight === 0 && refreshWanted) { refreshWanted = false; refreshScene(); }
  }
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
  const n = state.scene.words.length;
  if (!state.id) return hint(['Name something you are turning over. The sky will start to condense around it.']);
  if (n === 0) return hint(['Click a word in the sky to ', 'pin', ' it. It falls to the ground, and the ground keeps it.']);
  if (n === 1) return hint(['Drag it where it belongs. Then click ', 'open ground beside it', ' — dew condenses from what is nearby.']);
  if (state.scene.threads.length === 0) return hint(['Select a word to ', 'thread', ' it to another. Words you set close together condense together.']);
  return hint(['The ', 'mark on a thread', ' asks what connects its two ends. Unpinned words still evaporate.']);
}

// ── session ─────────────────────────────────────────────────────────────────

async function boot() {
  const id = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    state.id = id;
    const r = await api('/ground');
    if (r.ok) return enter(r.data);
    state.id = null;
  }
  layoutGround();
  teach();
  els.seedInput.focus({ preventScroll: true });
}

els.seedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const seed = els.seedInput.value.trim();
  if (!seed || state.busy) return;
  state.busy = true;
  try {
    const res = await fetch('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed }),
    });
    const info = await res.json().catch(() => null);
    if (!res.ok || !info?.id) {
      hint([res.status === 429 ? 'Too many sessions from here just now — try again in a minute.' : 'The weather would not start. Try again.']);
      return;
    }
    state.id = info.id;
    history.replaceState(null, '', `#${info.id}`);
    const r = await api('/ground');
    if (r.ok) enter(r.data);
  } finally {
    state.busy = false;
  }
});

function enter(view) {
  els.seedForm.hidden = true;
  els.dewline.hidden = false;
  document.getElementById('horizon').classList.add('seeded');
  els.seedLabel.hidden = false;
  els.seedText.textContent = view.seed;
  els.exportLink.hidden = false;
  els.exportLink.href = `/api/session/${state.id}/ground.excalidraw`;
  els.fieldDoor.href = `/app/#${state.id}`;
  state.evaporated = view.evaporated ?? [];
  renderEvaporated();
  applyScene(view.scene);
  state.pool = createPoolClient(state.id);
  state.pool.prime();
  setInterval(drizzle, DRIZZLE_MS);
  teach();
}

// ── ground geometry ─────────────────────────────────────────────────────────

function layoutGround() {
  const w = els.groundWrap.clientWidth;
  const h = els.groundWrap.clientHeight;
  // Narrow screens scale by height and let the ground scroll sideways: a
  // phone-width ground would shrink words' SPACING to nothing while their
  // type stays legible, and every cluster would collide.
  state.scale = w < 720 ? h / GROUND_H : groundScale(w, h);
  els.ground.style.width = `${GROUND_W * state.scale}px`;
  els.ground.style.height = `${GROUND_H * state.scale}px`;
  els.ground.style.margin = w >= GROUND_W * state.scale ? '0 auto' : '0';
  updateMore();
}

/** "more ground →" while part of the ground is off to the right. */
function updateMore() {
  const wrap = els.groundWrap;
  els.more.hidden = !(wrap.scrollWidth > wrap.clientWidth + 4 && wrap.scrollLeft < wrap.scrollWidth - wrap.clientWidth - 4);
}
els.groundWrap.addEventListener('scroll', updateMore, { passive: true });

function groundPoint(evt) {
  const r = els.ground.getBoundingClientRect();
  return toGround({ x: evt.clientX - r.left, y: evt.clientY - r.top }, state.scale);
}

// ── rendering the ground ────────────────────────────────────────────────────

const wordEls = new Map(); // key -> element

function applyScene(scene) {
  // A word in the user's hand stays in the user's hand: a scene arriving
  // mid-drag (a pin landing elsewhere) must not snap it back.
  if (state.drag) {
    scene = {
      ...scene,
      words: scene.words.map((w) => (normKey(w.text) === state.drag.key ? { ...w, x: state.drag.x, y: state.drag.y } : w)),
    };
  }
  state.scene = scene;
  layoutGround();
  const live = new Set(scene.words.map((w) => normKey(w.text)));
  for (const [key, el] of wordEls) if (!live.has(key)) { el.remove(); wordEls.delete(key); }
  for (const w of scene.words) {
    const key = normKey(w.text);
    let el = wordEls.get(key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'gword';
      el.textContent = w.text;
      el.dataset.key = key;
      bindWord(el);
      els.ground.appendChild(el);
      wordEls.set(key, el);
    }
    const p = toScreen(w, state.scale);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.classList.toggle('selected', state.selected === key);
    el.classList.toggle('thread-source', state.threadFrom === key);
    el.setAttribute('aria-label', `${w.text} — pinned. Enter for options; arrow keys move it.`);
  }
  els.empty.hidden = scene.words.length > 0;
  drawThreads();
  teach();
}

function centerOf(key) {
  const el = wordEls.get(key);
  const w = state.scene.words.find((x) => normKey(x.text) === key);
  if (!el || !w) return null;
  const p = toScreen(w, state.scale);
  return { x: p.x + el.offsetWidth / 2, y: p.y + el.offsetHeight / 2 };
}

const bridgeMarks = new Map(); // thread key -> button, kept across renders so focus survives

function threadKey(t) {
  return [normKey(t.a), normKey(t.b)].sort().join('|');
}

function drawThreads() {
  const svg = els.threads;
  svg.replaceChildren();
  const live = new Set();
  for (const t of state.scene.threads) {
    const ka = normKey(t.a), kb = normKey(t.b);
    const a = centerOf(ka);
    const b = centerOf(kb);
    if (!a || !b) continue;
    const ea = wordEls.get(ka), eb = wordEls.get(kb);
    // Meet each word at its edge, never strike through it.
    const p0 = edgePoint(a, b, ea.offsetWidth / 2 + 4, ea.offsetHeight / 2 + 2);
    const p1 = edgePoint(b, a, eb.offsetWidth / 2 + 4, eb.offsetHeight / 2 + 2);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p0.x); line.setAttribute('y1', p0.y);
    line.setAttribute('x2', p1.x); line.setAttribute('y2', p1.y);
    svg.appendChild(line);
    const key = threadKey(t);
    live.add(key);
    const mid = threadMid(a, b);
    let mark = bridgeMarks.get(key);
    if (!mark) {
      mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'bridge';
      mark.title = 'what connects these?';
      els.ground.appendChild(mark);
      bridgeMarks.set(key, mark);
    }
    mark.style.left = `${mid.x}px`;
    mark.style.top = `${mid.y}px`;
    mark.setAttribute('aria-label', `what connects ${t.a} and ${t.b}?`);
    mark.onclick = (e) => { e.stopPropagation(); bridge(t.a, t.b, toGround(mid, state.scale)); };
  }
  for (const [key, mark] of bridgeMarks) if (!live.has(key)) { mark.remove(); bridgeMarks.delete(key); }
}

// ── ground words: drag, select, thread, release ─────────────────────────────

function bindWord(el) {
  let start = null;
  let moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top };
    moved = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!moved && Math.hypot(e.clientX - start.px, e.clientY - start.py) < 6) return;
    moved = true;
    el.classList.add('dragging');
    hideMenu();
    const g = els.ground.getBoundingClientRect();
    const p = toGround({ x: e.clientX - g.left - start.dx, y: e.clientY - g.top - start.dy }, state.scale);
    state.drag = { key: el.dataset.key, x: p.x, y: p.y };
    const w = state.scene.words.find((x) => normKey(x.text) === el.dataset.key);
    if (w) { w.x = p.x; w.y = p.y; }
    const s = toScreen(p, state.scale);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    drawThreads();
  });
  el.addEventListener('pointerup', async (e) => {
    if (!start) return;
    e.stopPropagation();
    start = null;
    el.classList.remove('dragging');
    const key = el.dataset.key;
    const w = state.scene.words.find((x) => normKey(x.text) === key);
    const drop = state.drag;
    state.drag = null;
    if (moved && w && drop) {
      const r = await sceneRequest('/ground/op', 'POST', { op: 'move', text: w.text, x: drop.x, y: drop.y });
      if (r.fresh) applyScene(r.scene);
      return;
    }
    clickWord(key);
  });
  el.addEventListener('pointercancel', () => {
    start = null;
    state.drag = null;
    el.classList.remove('dragging');
    refreshScene();
  });
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('keydown', async (e) => {
    const key = el.dataset.key;
    const w = state.scene.words.find((x) => normKey(x.text) === key);
    if (!w) return;
    const step = e.shiftKey ? 60 : 20;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      const r = await sceneRequest('/ground/op', 'POST', { op: 'move', text: w.text, x: w.x + d[0], y: w.y + d[1] });
      if (r.fresh) { applyScene(r.scene); el.focus(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clickWord(key);
    } else if (e.key === 'Escape') {
      cancelThread();
    }
  });
}

async function clickWord(key) {
  if (state.threadFrom && state.threadFrom !== key) {
    const a = state.scene.words.find((x) => normKey(x.text) === state.threadFrom);
    const b = state.scene.words.find((x) => normKey(x.text) === key);
    state.threadFrom = null;
    if (a && b) {
      const r = await sceneRequest('/ground/op', 'POST', { op: 'thread', a: a.text, b: b.text });
      if (r.fresh) applyScene(r.scene);
      if (r.status === 409 && r.data?.error === 'thread-cap') hint(['That is as many threads as the ground can hold legibly.']);
      else if (r.status === 409) hint(['One of those words has left the ground. Nothing was threaded.']);
      else if (!r.ok) trouble(r, 'thread them');
    }
    return;
  }
  state.selected = state.selected === key ? null : key;
  applyScene(state.scene);
  if (state.selected) showMenu(key); else hideMenu();
}

function showMenu(key) {
  const el = wordEls.get(key);
  if (!el) return;
  const r = el.getBoundingClientRect();
  els.menu.hidden = false;
  // Beside the word, on its baseline — below it is where its neighbours are.
  // Flip to the left side when the right edge is too close.
  const menuW = els.menu.offsetWidth || 280;
  const right = r.right + 10 + menuW < document.documentElement.clientWidth;
  els.menu.style.left = `${(right ? r.right + 10 : Math.max(8, r.left - 10 - menuW)) + window.scrollX}px`;
  els.menu.style.top = `${r.top + window.scrollY - 8}px`;
  els.menu.classList.toggle('flipped', !right);
  els.menu.dataset.key = key;
  els.menu.querySelector('button')?.focus({ preventScroll: true });
}

function hideMenu(refocus = false) {
  if (els.menu.hidden) return;
  const key = els.menu.dataset.key;
  els.menu.hidden = true;
  if (refocus) wordEls.get(key)?.focus({ preventScroll: true });
}

els.menu.addEventListener('keydown', (e) => {
  const items = [...els.menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.selected = null; hideMenu(true); applyScene(state.scene); }
  else if (e.key === 'Tab') { state.selected = null; hideMenu(true); applyScene(state.scene); }
});

function cancelThread() {
  state.threadFrom = null;
  state.selected = null;
  hideMenu();
  applyScene(state.scene);
}

els.menu.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  const key = els.menu.dataset.key;
  const w = state.scene.words.find((x) => normKey(x.text) === key);
  hideMenu();
  if (!w) return;
  if (act === 'prospect') {
    // Condense beside this word — the keyboard's way to prospect at a cluster.
    state.selected = null;
    applyScene(state.scene);
    const el = wordEls.get(key);
    const wpx = (el?.offsetWidth ?? 120) / state.scale;
    prospect({ x: Math.min(GROUND_W, w.x + wpx / 2), y: Math.min(GROUND_H, w.y + 70) });
    el?.focus({ preventScroll: true });
  } else if (act === 'thread') {
    state.threadFrom = key;
    state.selected = null;
    applyScene(state.scene);
    hint(['Choose a word to thread to ', w.text, '. Esc cancels.']);
  } else if (act === 'release') {
    // Release = let it go back to the weather: unpin, then it joins the
    // evaporated trail like any other word, where it is still recoverable.
    state.selected = null;
    const un = await api('/pin', 'DELETE', { text: w.text });
    if (!un.ok) { trouble(un, 'release it'); applyScene(state.scene); return; }
    const ev = await api('/evaporated', 'POST', { text: w.text, tier: w.tier });
    if (ev.data?.evaporated) { state.evaporated = ev.data.evaporated; renderEvaporated(); }
    const r = await sceneRequest('/ground', 'GET');
    if (r.fresh) applyScene(r.scene);
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelThread(); });
document.addEventListener('pointerdown', (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target) && !e.target.closest('.gword')) {
    state.selected = null;
    hideMenu();
    applyScene(state.scene);
  }
});

// ── prospecting on the ground ───────────────────────────────────────────────

els.ground.addEventListener('click', (e) => {
  if (!state.id || e.target.closest('.gword, .bridge, .vapor')) return;
  if (state.threadFrom) return cancelThread();
  prospect(groundPoint(e));
});

els.ground.addEventListener('keydown', (e) => {
  // Keyboard prospect: Enter on the ground itself (not on a word) prospects at
  // the centre of the visible ground.
  if (e.target !== els.ground || e.key !== 'Enter' || !state.id) return;
  e.preventDefault();
  prospect({ x: GROUND_W / 2, y: GROUND_H / 2 });
});

function visibleTexts() {
  return [...state.sky.values(), ...state.dew.values()].map((v) => v.text);
}

function pulseAt(p) {
  const s = toScreen(p, state.scale);
  const ring = document.createElement('span');
  ring.className = 'pulse';
  ring.style.left = `${s.x}px`;
  ring.style.top = `${s.y}px`;
  els.ground.appendChild(ring);
  setTimeout(() => ring.remove(), 1200);
}

function printBasis(p, text) {
  const s = toScreen(p, state.scale);
  const tag = document.createElement('span');
  tag.className = 'basis';
  tag.textContent = text;
  tag.style.left = `${Math.max(4, s.x - 60)}px`;
  tag.style.top = `${s.y + 22}px`;
  els.ground.appendChild(tag);
  setTimeout(() => { tag.style.opacity = '0'; }, 3200);
  setTimeout(() => tag.remove(), 4600);
}

// One gesture at a time: overlapping answers would stack dew past CAP and
// print two "what it listened to" labels over each other.
async function gesture(p, path, body, label) {
  if (state.gesture) return;
  state.gesture = true;
  pulseAt(p);
  try {
    const r = await api(path, 'POST', { ...body, visible: visibleTexts() });
    if (!r.ok || !r.data) return trouble(r, 'condense there');
    printBasis(p, label(r.data));
    condenseDew(r.data.condensed, p);
  } finally {
    state.gesture = false;
  }
}

function prospect(p) {
  return gesture(p, '/ground/prospect', { x: p.x, y: p.y }, (d) =>
    d.mode === 'near' ? `beside ${d.basis.slice(0, 3).join(' · ')}` : 'open ground — the far field');
}

function bridge(a, b, mid) {
  return gesture(mid, '/ground/bridge', { a, b }, (d) =>
    d.mode === 'bridge' ? `between ${a} · ${b}` : 'not settled yet — the far field');
}

function condenseDew(words, at) {
  if (!words?.length) {
    hint(['The pool is thin right now — the sky is still condensing. Try again in a moment.']);
    return;
  }
  // Dew answers a gesture, so it has priority under CAP: retire the oldest sky
  // words first, then the oldest dew. Words already fading still count.
  // Words retired to make room leave FAST (0.25 s) and stop counting at once;
  // otherwise a quick run of gestures piles up fading words past CAP.
  const live = (m) => [...m].filter(([, v]) => !v.leaving && !v.pinning).sort((x, y) => x[1].born - y[1].born);
  const skyLive = live(state.sky);
  const dewLive = live(state.dew);
  const onScreen = (m) => [...m.values()].filter((v) => !v.retiring).length;
  const fading = onScreen(state.sky) + onScreen(state.dew) - skyLive.length - dewLive.length;
  const plan = makeRoom({ skyLive: skyLive.length, dewLive: dewLive.length, fading }, words.length);
  skyLive.slice(0, plan.retireSky).forEach(([key]) => evaporate(key, 'sky', true));
  dewLive.slice(0, plan.retireDew).forEach(([key]) => evaporate(key, 'dew', true));
  words = words.slice(0, plan.accept);
  if (!words.length) return;
  const lineH = 30 / state.scale;
  const occupied = state.scene.words.map((w) => ({ x: w.x - 6, y: w.y - 4, w: wordWidth(w.text, 19, state.scale), h: lineH }));
  for (const v of state.dew.values()) occupied.push({ x: v.x, y: v.y, w: wordWidth(v.text, 17, state.scale), h: lineH });
  // the printed basis label sits just under the gesture; keep dew off it
  occupied.push({ x: at.x - 60 / state.scale, y: at.y + 18 / state.scale, w: 260 / state.scale, h: 18 / state.scale });
  const spots = dewSpots(at.x, at.y, words.map((w) => wordWidth(w.text, 17, state.scale)), occupied, Math.random, lineH);
  words.forEach((w, i) => spawnDew(w, spots[i]));
}

function spawnDew(word, p) {
  const key = normKey(word.text);
  if (state.dew.has(key) || state.sky.has(key)) return;
  const el = document.createElement('span');
  el.className = `vapor dew t${word.tier}`;
  el.textContent = word.text;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${word.text} — dew. Click to pin it here.`);
  const s = toScreen(p, state.scale);
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  els.ground.appendChild(el);
  const entry = { el, text: word.text, tier: word.tier, x: p.x, y: p.y, born: Date.now() };
  state.dew.set(key, entry);
  requestAnimationFrame(() => { el.style.opacity = '0.82'; });
  const pin = (e) => { e.stopPropagation(); pinDew(key); };
  el.addEventListener('click', pin);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(e); } });
  entry.timer = setTimeout(() => evaporate(key, 'dew'), ttl('dew', Math.random()));
}

async function pinDew(key) {
  const v = state.dew.get(key);
  if (!v || v.pinning) return;
  v.pinning = true;
  clearTimeout(v.timer);
  const r = await api('/pin', 'POST', { text: v.text, tier: v.tier });
  if (!r.ok) return pinFailed(key, 'dew', r);
  state.dew.delete(key);
  v.el.remove();
  // It stays exactly where it condensed — that place is why it condensed.
  const moved = await sceneRequest('/ground/op', 'POST', { op: 'move', text: v.text, x: v.x, y: v.y });
  if (moved.fresh) applyScene(moved.scene);
  wordEls.get(key)?.classList.add('landing');
}

async function refreshScene() {
  const r = await sceneRequest('/ground', 'GET');
  if (r.fresh) applyScene(r.scene);
}

// ── the sky ─────────────────────────────────────────────────────────────────

function drizzle() {
  if (!state.pool || document.hidden) return;
  const count = (m) => [...m.values()].filter((v) => !v.retiring).length;
  if (room(count(state.sky), count(state.dew)) <= 0) return;
  const order = bucketOrder(Math.random(), Math.random(), DEWPOINT, ALTITUDE);
  const taken = new Set([...state.sky.keys(), ...state.dew.keys(), ...wordEls.keys()]);
  for (const bucket of order) {
    let pick;
    while ((pick = state.pool.draw(bucket))) {
      if (!taken.has(normKey(pick.text))) return spawnSky(pick);
    }
  }
}

function spawnSky(pick) {
  const key = normKey(pick.text);
  const rect = els.sky.getBoundingClientRect();
  const depth = Math.random();
  const el = document.createElement('span');
  el.className = `vapor t${pick.tier}`;
  el.textContent = pick.text;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${pick.text} — click to pin it to the ground`);
  el.style.fontSize = `${(coarse ? 17 : 14) + depth * (coarse ? 10 : 15)}px`;
  el.style.filter = `blur(${blurBand(depth, coarse).toFixed(2)}px)`;
  // Measure, then place: try a few spots and keep the first that clears every
  // sky word already showing, clamped so a long phrase is never cut off at the
  // edge (the field clips them on phones — audit, 2026-09-24).
  el.style.visibility = 'hidden';
  els.sky.appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const pad = 16;
  // Inflate every box by the drift (±15 px) so two words cannot drift into
  // each other; if nothing is clear, skip this tick — legibility beats density.
  const DRIFT = 16;
  const others = [...state.sky.values()].map((v) => v.box).filter(Boolean);
  let box = null;
  for (let i = 0; i < 30 && !box; i++) {
    const x = pad + Math.random() * Math.max(1, rect.width - w - pad * 2);
    const y = pad + Math.random() * Math.max(1, rect.height - h - pad * 2);
    const hit = others.some((o) => x - DRIFT < o.x + o.w && o.x < x + w + DRIFT && y - DRIFT < o.y + o.h && o.y < y + h + DRIFT);
    if (!hit) box = { x, y, w, h };
  }
  if (!box) { el.remove(); return; }
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.visibility = '';
  const entry = { el, text: pick.text, tier: pick.tier, born: Date.now(), box };
  state.sky.set(key, entry);
  requestAnimationFrame(() => {
    el.style.opacity = wordOpacity(depth, coarse).toFixed(2);
    if (!reduced) el.style.transform = `translate(${((Math.random() - 0.5) * 30).toFixed(0)}px, ${((Math.random() - 0.5) * 20).toFixed(0)}px)`;
  });
  const pin = (e) => { e.stopPropagation(); pinFromSky(key); };
  el.addEventListener('click', pin);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(e); } });
  entry.timer = setTimeout(() => evaporate(key, 'sky'), ttl('sky', Math.random()));
}

async function pinFromSky(key) {
  const v = state.sky.get(key);
  if (!v || v.pinning) return;
  v.pinning = true;
  clearTimeout(v.timer);
  const r = await api('/pin', 'POST', { text: v.text, tier: v.tier });
  if (!r.ok) return pinFailed(key, 'sky', r);
  // Precipitate: fall straight down onto the ground.
  const from = v.el.getBoundingClientRect();
  const g = els.ground.getBoundingClientRect();
  const lineH = 34 / state.scale;
  const width = wordWidth(v.text, 19, state.scale);
  const boxes = [
    ...state.scene.words.map((w) => ({ x: w.x - 6, y: w.y - 4, w: wordWidth(w.text, 19, state.scale), h: lineH })),
    ...state.landing.values(),
  ];
  const centre = toGround({ x: from.left - g.left + from.width / 2, y: 0 }, state.scale).x;
  const land = landingSpot(boxes, centre, width, lineH);
  state.landing.set(key, { x: land.x, y: land.y, w: width, h: lineH });
  const to = toScreen(land, state.scale);
  v.el.classList.add('falling');
  v.el.style.filter = 'none';
  if (reduced) {
    v.el.style.opacity = '0';
  } else {
    v.el.style.transform = `translate(${g.left + to.x - from.left}px, ${g.top + to.y - from.top}px)`;
    v.el.style.color = 'var(--pin)';
  }
  const seq = sceneSeq + 1;
  const moved = await sceneRequest('/ground/op', 'POST', { op: 'move', text: v.text, x: land.x, y: land.y });
  setTimeout(() => {
    state.sky.delete(key);
    state.landing.delete(key);
    v.el.remove();
    // Re-check freshness after the fall: a drag during the animation wins,
    // and the landed word arrives with the next fresh scene instead.
    if (moved.scene && seq === sceneSeq) applyScene(moved.scene);
    else if (sceneInflight > 0) refreshWanted = true;
    else refreshScene();
    wordEls.get(key)?.classList.add('landing');
  }, reduced ? 250 : 850);
}

// ── evaporation, and its one mercy ──────────────────────────────────────────

function evaporate(key, plane, fast = false) {
  const map = plane === 'sky' ? state.sky : state.dew;
  const v = map.get(key);
  if (!v || v.pinning || v.leaving) return;
  v.leaving = true;
  v.retiring = fast;
  clearTimeout(v.timer);
  v.el.classList.add('leaving');
  if (fast) v.el.classList.add('fast');
  v.timer = setTimeout(() => finishEvaporating(key, plane), fast ? 260 : 1200);
}

async function finishEvaporating(key, plane) {
  const map = plane === 'sky' ? state.sky : state.dew;
  const v = map.get(key);
  // Re-check after the fade: a word pinned mid-fade has crystallised and must
  // never be removed or reported evaporated (CLAUDE.md).
  if (!v || v.pinning) return;
  map.delete(key);
  v.el.remove();
  const r = await api('/evaporated', 'POST', { text: v.text, tier: v.tier });
  if (r.data?.evaporated) { state.evaporated = r.data.evaporated; renderEvaporated(); }
}

/** A pin that did not take must not leave the word immortal: its TTL was
 *  cleared when the pin began. Put it back on the clock — or, if it was
 *  already fading when it was clicked, let it finish evaporating now. */
function pinFailed(key, plane, r) {
  const map = plane === 'sky' ? state.sky : state.dew;
  const v = map.get(key);
  trouble(r, 'pin it');
  if (!v) return;
  v.pinning = false;
  if (v.leaving) { finishEvaporating(key, plane); return; }
  v.timer = setTimeout(() => evaporate(key, plane), 2500);
}

function renderEvaporated() {
  els.evaporated.replaceChildren(...state.evaporated.slice(0, 12).map((w) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = w.text;
    b.setAttribute('aria-label', `${w.text} — condense it again`);
    b.addEventListener('click', async () => {
      const r = await api('/evaporated/restore', 'POST', { text: w.text });
      if (r.data?.evaporated) { state.evaporated = r.data.evaporated; renderEvaporated(); }
      if (r.data?.restored) {
        // Restoring is still weather: it takes a CAP slot like any sky word,
        // retiring the oldest sky word if the sky is full.
        if (room(state.sky.size, state.dew.size) <= 0) {
          const oldest = [...state.sky].filter(([, v]) => !v.leaving && !v.pinning).sort((x, y) => x[1].born - y[1].born)[0];
          if (oldest) evaporate(oldest[0], 'sky');
          else return hint(['The sky is full — try again as it clears.']);
        }
        spawnSky({ text: r.data.restored.text, tier: r.data.restored.tier });
      }
    });
    li.appendChild(b);
    return li;
  }));
}

window.addEventListener('resize', () => { if (state.id) applyScene(state.scene); else layoutGround(); });
window.addEventListener('hashchange', () => location.reload());

boot();
