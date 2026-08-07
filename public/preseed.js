// The pre-seed empty state (issue #11): before a session exists, the field
// carries the concept — the centered manifesto plus meta-words about dewpt
// condensing and evaporating. The spawn cadence, depth math (size/blur/
// opacity), drift, TTL and reduced-motion path mirror public/field.js
// (spawnPick/loop) line for line, and the words wear the same .word t0/t1/t2
// classes, so the empty state is a truthful preview of the seeded field — not
// a separate animation system. Static pool only: no network, no AI.

import { drawMetaWord } from '/preseed-pool.js';
import { blurBand, wordOpacity } from './depth.js';

export function createPreseed({ fieldEl, sliders, onWordClick }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // mirror field.js's coarse-pointer legibility floor so the pre-seed preview
  // reads the same on touch as the seeded field it previews (#17)
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const manifesto = document.getElementById('manifesto');
  const manifestoSr = document.getElementById('manifestoSr');

  const visible = new Set();
  const timers = new Set(); // every pending timer, so teardown is total
  const CAP = 14; // field.js's visible cap, kept for a truthful preview
  let running = false;
  let torn = false;

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  }

  function spawn() {
    if (!running || visible.size >= CAP) return;
    const pick = drawMetaWord(sliders.strange.value / 100, visible);
    if (!pick) return; // whole pool on the field: skip the tick, never stall
    const rect = fieldEl.getBoundingClientRect();
    const depth = Math.random();
    const el = document.createElement('span');
    el.className = 'word t' + pick.tier;
    // demonstration only — aria-hidden keeps the transient words from
    // spamming assistive tech; #manifestoSr carries the message instead
    el.setAttribute('aria-hidden', 'true');
    el.textContent = pick.text;
    el.style.fontSize = ((coarse ? 18 : 14) + depth * (coarse ? 11 : 15)) + 'px';
    el.style.filter = 'blur(' + blurBand(depth, coarse).toFixed(2) + 'px)';
    // width-relative band, mirroring field.js (gap #10); desktop unchanged
    const reserve = Math.min(160, rect.width * 0.42);
    const startPad = Math.min(30, rect.width * 0.08);
    const x = startPad + Math.random() * Math.max(40, rect.width - reserve - 30 - startPad);
    const y = 30 + Math.random() * (rect.height - 70);
    el.style.left = Math.max(12, Math.min(rect.width - reserve, x)) + 'px';
    el.style.top = Math.max(12, Math.min(rect.height - 40, y)) + 'px';
    // no session yet, so a click can't pin — the caller decides (app.js
    // funnels it to the seed input); nothing ever reaches the condensate
    // tray or the evaporated sidebar from here
    el.addEventListener('click', e => { e.stopPropagation(); onWordClick(); });
    fieldEl.appendChild(el);
    visible.add(pick.text);
    requestAnimationFrame(() => {
      if (torn) return; // teardown raced the fade-in: stay at opacity 0
      el.style.opacity = wordOpacity(depth, coarse).toFixed(2);
      if (!reduced) el.style.transform = 'translate(' + ((Math.random() - 0.5) * 30).toFixed(0) + 'px,' + ((Math.random() - 0.5) * 24).toFixed(0) + 'px)';
    });
    const ttl = 5000 + Math.random() * 5000; // field.js's decay window
    later(() => {
      el.style.opacity = 0;
      later(() => { visible.delete(pick.text); el.remove(); }, 1500);
    }, ttl);
  }

  function loop() {
    if (!running) return;
    spawn();
    const interval = 2400 - sliders.flux.value * 19; // drizzle works pre-seed too
    later(loop, interval + Math.random() * 400);
  }

  return {
    /** Bring the empty state up: manifesto visible, meta-words condensing. */
    start() {
      if (running || torn) return; // a session beat us to it (resume race)
      running = true;
      manifesto.hidden = false;
      manifestoSr.hidden = false;
      for (let i = 0; i < 6; i++) later(spawn, i * 350); // field.js's opening burst
      loop();
    },
    /** The moment a session starts: stop spawning, evaporate everything.
     *  Idempotent; safe to call before start() (URL-hash resume). */
    teardown() {
      if (torn) return;
      torn = true;
      running = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      manifestoSr.hidden = true;
      manifesto.style.opacity = '0'; // CSS fades it; reduced-motion is instant
      setTimeout(() => { manifesto.hidden = true; }, 500);
      // meta-words exit through the same opacity fade they always use
      // (0.5s under reduced motion); pointer-events off so nothing lands on
      // a word that is mid-evaporation
      for (const el of fieldEl.querySelectorAll('.word')) {
        el.style.pointerEvents = 'none';
        el.style.opacity = 0;
        setTimeout(() => el.remove(), 1600);
      }
      visible.clear();
    },
  };
}
