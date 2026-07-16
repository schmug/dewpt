// The demo's field machinery (dewpt-demo.html), extracted as a module. The
// spawn/decay timing, depth math, tier weights, pulse-on-prospect and
// pin-to-condense behavior are carried over verbatim — the only change is the
// word source: instead of static pools, pickWord draws from an injected
// drawWord(bucket) (the pool client), and hooks report pins, evaporations and
// prospects so the session can persist them.

export function createField({ fieldEl, chipsEl, sliders, onPin, onUnpin, onEvaporate, onProspect, drawWord }) {
  const field = fieldEl;
  const chips = chipsEl;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const visible = new Set();
  const pinned = new Map();
  const CAP = 14;

  function tierWeights(bump = 0) {
    let s = Math.min(1, sliders.strange.value / 100 + bump);
    let w2 = Math.pow(s, 1.4), w0 = Math.pow(1 - s, 1.4);
    let w1 = Math.max(0.15, 1 - w2 - w0);
    if (pinned.size > 0) {
      const counts = [0, 0, 0];
      pinned.forEach(t => counts[t]++);
      const n = pinned.size;
      w0 = 0.7 * w0 + 0.3 * (counts[0] / n);
      w1 = 0.7 * w1 + 0.3 * (counts[1] / n);
      w2 = 0.7 * w2 + 0.3 * (counts[2] / n);
    }
    const sum = w0 + w1 + w2;
    return [w0 / sum, w1 / sum, w2 / sum];
  }

  function pickWord(bump = 0) {
    const [w0, w1] = tierWeights(bump);
    const r = Math.random();
    const tier = r < w0 ? 0 : r < w0 + w1 ? 1 : 2;
    const abs = Math.random() < sliders.alt.value / 100 ? 1 : 0;
    // demo: filter the pool against visible/pinned, null when nothing fresh —
    // here the pool client draws from its local buffer with the same contract
    let pick = null;
    while ((pick = drawWord('w' + tier + 'a' + abs))) {
      if (!visible.has(pick.text) && !pinned.has(pick.text)) break;
    }
    if (!pick) return null;
    return { text: pick.text, tier };
  }

  function spawn(px, py, bump = 0) {
    if (visible.size >= CAP + 4) return;
    const pick = pickWord(bump);
    if (!pick) return;
    spawnPick(pick, px, py);
  }

  function spawnPick(pick, px, py) {
    const rect = field.getBoundingClientRect();
    const depth = Math.random();
    const el = document.createElement('span');
    el.className = 'word t' + pick.tier;
    el.textContent = pick.text;
    el.style.fontSize = (14 + depth * 15) + 'px';
    el.style.filter = 'blur(' + ((1 - depth) * 1.4).toFixed(1) + 'px)';
    const x = px !== undefined ? px + (Math.random() - 0.5) * 140 : 30 + Math.random() * (rect.width - 220);
    const y = py !== undefined ? py + (Math.random() - 0.5) * 110 : 30 + Math.random() * (rect.height - 70);
    el.style.left = Math.max(12, Math.min(rect.width - 160, x)) + 'px';
    el.style.top = Math.max(12, Math.min(rect.height - 40, y)) + 'px';
    field.appendChild(el);
    visible.add(pick.text);
    requestAnimationFrame(() => {
      el.style.opacity = (0.45 + depth * 0.55).toFixed(2);
      if (!reduced) el.style.transform = 'translate(' + ((Math.random() - 0.5) * 30).toFixed(0) + 'px,' + ((Math.random() - 0.5) * 24).toFixed(0) + 'px)';
    });
    const ttl = 5000 + Math.random() * 5000;
    el._decay = setTimeout(() => {
      if (el.classList.contains('pinned')) return;
      el.style.opacity = 0;
      setTimeout(() => {
        // re-check: a word pinned during its 1.5s fade-out has crystallized —
        // it must not be removed or reported evaporated (the demo's inner
        // callback lacked this guard; pinned words must never decay)
        if (el.classList.contains('pinned')) return;
        visible.delete(pick.text);
        el.remove();
        onEvaporate(pick.text, pick.tier);
      }, 1500);
    }, ttl);
    el.addEventListener('click', e => { e.stopPropagation(); togglePin(el, pick); });
  }

  function togglePin(el, pick) {
    if (pinned.has(pick.text)) {
      pinned.delete(pick.text);
      el.classList.remove('pinned');
      el.style.opacity = 0;
      setTimeout(() => { visible.delete(pick.text); el.remove(); }, 1500);
      onUnpin(pick.text);
    } else {
      pinned.set(pick.text, pick.tier);
      clearTimeout(el._decay);
      el.classList.add('pinned');
      el.style.transform = 'none';
      onPin(pick.text, pick.tier);
    }
    renderTray();
  }

  function renderTray() {
    chips.innerHTML = '';
    if (!pinned.size) {
      chips.innerHTML = '<span class="empty">nothing has condensed yet — click words that catch you</span>';
      return;
    }
    pinned.forEach((tier, text) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = text + ' ';
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + text);
      x.addEventListener('click', () => {
        pinned.delete(text);
        field.querySelectorAll('.word.pinned').forEach(w => { if (w.textContent === text) { w.remove(); visible.delete(text); } });
        onUnpin(text);
        renderTray();
      });
      c.appendChild(x);
      chips.appendChild(c);
    });
  }

  field.addEventListener('click', e => {
    if (e.target.closest('.word')) return;
    const rect = field.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const p = document.createElement('div');
    p.className = 'pulse';
    p.style.left = x + 'px'; p.style.top = y + 'px';
    field.appendChild(p);
    setTimeout(() => p.remove(), 1000);
    for (let i = 0; i < 4; i++) setTimeout(() => spawn(x, y, 0.25), i * 180);
    onProspect();
  });

  let running = false;
  function loop() {
    if (!running) return;
    if (visible.size < CAP) spawn();
    const interval = 2400 - sliders.flux.value * 19;
    setTimeout(loop, interval + Math.random() * 400);
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (let i = 0; i < 6; i++) setTimeout(() => spawn(), i * 350);
      loop();
    },
    /** Condense a specific word (evaporated-sidebar restore). Fresh TTL, standard depth. */
    spawnText(text, tier) {
      if (visible.has(text) || pinned.has(text)) return;
      spawnPick({ text, tier });
    },
    /** Rebuild the pinned map from session anchors on resume. */
    hydratePinned(anchors) {
      for (const a of anchors) pinned.set(a.text, a.tier);
      renderTray();
    },
    getPinned() {
      return [...pinned.keys()];
    },
  };
}
