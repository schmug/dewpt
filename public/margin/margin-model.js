// Pure client logic for the margin (/margin/). No DOM; tested by
// test/margin-model.test.ts. Plan: .claude/plans/marginalia-slice.md.

/** Ephemeral words the margin shows at once, fading ones included. UNMEASURED:
 *  a judgement for a narrow column, well under the field's legibility CAP = 14
 *  (public/field.js). Pinned notes do not count; they are kept, not weather. */
export const MARGIN_CAP = 7;

/** How long the caret must rest before its paragraph becomes the focus.
 *  UNMEASURED. Bounds the embed calls: one per settle, at most. */
export const FOCUS_SETTLE_MS = 900;

/** One margin word condenses per tick while there is room. UNMEASURED. */
export const DRIP_MS = 1400;

export function normKey(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function room(onScreen) {
  return Math.max(0, MARGIN_CAP - onScreen);
}

/** Lifetime of a margin word, ms: the field's 5–10 s (SPEC.md core loop). */
export function ttl(r) {
  return 5000 + r * 5000;
}

/** Mirror of scripts/marginalia-judge.ts seedFrom (the spike's seed), kept in
 *  step by test/margin-model.test.ts. /api/session caps a seed at 200 chars:
 *  cut at the last sentence end within `max`, else the last word boundary. */
export function seedFrom(paragraph, max = 200) {
  const text = paragraph.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) if (m.index + 1 <= max) cut = m.index + 1;
  if (cut > 0) return text.slice(0, cut);
  const space = text.lastIndexOf(' ', max);
  return (space > 0 ? text.slice(0, space) : text.slice(0, max)).trim();
}

/** Whether a settled caret should re-focus the margin: a first focus, a
 *  different paragraph, or the same one edited. Never an empty paragraph. */
export function focusChanged(prev, next) {
  const text = next.text.trim();
  if (!text) return false;
  if (!prev) return true;
  return prev.index !== next.index || prev.text.trim() !== text;
}

/** The first free line for a margin word: at or below the paragraph's top,
 *  then above it. `occupied` are the {y, h} boxes already in the column. */
export function slotNear(y, occupied, lineH, minY, maxY) {
  const free = (t) => t >= minY && t + lineH <= maxY && !occupied.some((o) => t < o.y + o.h && o.y < t + lineH);
  for (let t = y; t + lineH <= maxY; t += lineH) if (free(t)) return t;
  for (let t = y - lineH; t >= minY; t -= lineH) if (free(t)) return t;
  return null;
}

// ── the draft, in this browser only ────────────────────────────────────────
// The server never stores the draft. localStorage holds it so a reload keeps
// your writing; "new page" clears it. Read defensively: it is local, but it is
// still input.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PARAS = 400;
const MAX_PARA_CHARS = 4000; // src/margin-core.ts MAX_PARAGRAPH_CHARS
const MAX_NOTES = 200;

export function encodeDraft(d) {
  return JSON.stringify({ sessionId: d.sessionId, paragraphs: d.paragraphs, notes: d.notes });
}

export function decodeDraft(raw) {
  const empty = { sessionId: null, paragraphs: [], notes: [] };
  if (typeof raw !== 'string') return empty;
  let v;
  try { v = JSON.parse(raw); } catch { return empty; }
  if (!v || typeof v !== 'object') return empty;
  const paragraphs = Array.isArray(v.paragraphs)
    ? v.paragraphs.filter((p) => typeof p === 'string').map((p) => p.slice(0, MAX_PARA_CHARS)).slice(0, MAX_PARAS)
    : [];
  const notes = Array.isArray(v.notes)
    ? v.notes.filter((n) => n && typeof n.text === 'string' && n.text.length > 0 && n.text.length <= 64
        && [0, 1, 2].includes(n.tier) && Number.isInteger(n.para) && n.para >= 0)
      .map((n) => ({ text: n.text, tier: n.tier, para: n.para })).slice(0, MAX_NOTES)
    : [];
  return { sessionId: typeof v.sessionId === 'string' && UUID_RE.test(v.sessionId) ? v.sessionId : null, paragraphs, notes };
}
