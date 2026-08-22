// Workstream A's probe lint, adapted to dewpt's ONE-pair axes.
//
// The axis-measurement doc's lint assumes 16 curated pairs, where
// d_bow = mean(bow(pos_i) - bow(neg_i)) can expose a token that dominates the
// mean. With one pair there is no averaging, so only part of it ports. What
// runs here is stage 1: three pure string checks over the EXPANDED phrases,
// reported in terms of the term the user actually typed.
//
// SCOPE, stated because it is easy to over-trust: this catches lexical and
// register fakes. It does NOT catch a weak axis. `solemn` / `playful` expands
// to 4 tokens against 4, both everyday register, no shared token — it passes
// everything here and still produced "community engagement . park and ride" at
// its playful pole. Workstream B went looking for a cheap check that would
// catch that and found none (docs/measurements/2026-08-22-workstream-b-null-result.md).
//
// The lint can tell you an axis is FAKE. It can never tell you an axis is
// MEANINGFUL, so nothing here may present as a verdict — warn and allow.

/** Ports unchanged from the axis-measurement doc: a 2-token gap between poles
 *  that both target 4-8 words is a real length confound. */
export const LEN_DELTA_MAX = 2;

/** UNMEASURED. A register proxy, not idf — there is no corpus to compute idf
 *  against on the client, so this scores the share of tokens drawn from a
 *  compact everyday-word list. Deliberately loose: short descriptive phrases
 *  are mostly function words, which compresses the range and makes a tight
 *  threshold cry wolf. Measure before tightening. */
export const REGISTER_DELTA_MAX = 0.5;

/** Below this, commonShare carries no register signal and must not be trusted.
 *  A one-token phrase scores 0 or 1; a two-token phrase scores 0, 0.5 or 1. The
 *  `X` / `more X` surface control is exactly that shape — "playful" scores 0/1
 *  and "more playful" scores 1/2 — so a single function word manufactures a
 *  0.5 delta out of nothing. That is quantization, not register, and without
 *  this floor the register check fires on every contained pole and stops being
 *  independent of the containment check. */
const MIN_REGISTER_TOKENS = 3;

/** The ~150 most frequent English words. Enough to separate "everyday" from
 *  "technical" in a 4-8 word phrase, and small enough to ship in a client
 *  module. Not a frequency table and not a substitute for one. */
const COMMON = new Set([
  'a','about','after','all','also','an','and','any','are','as','at','back','be','because','been','before',
  'being','between','both','but','by','can','come','could','day','do','does','down','each','even','first',
  'for','from','get','give','go','good','great','has','have','he','her','here','him','his','how','i','if',
  'in','into','is','it','its','just','know','last','life','like','little','long','look','made','make','man',
  'many','may','me','more','most','much','must','my','never','new','no','not','now','of','off','old','on',
  'one','only','or','other','our','out','over','own','part','people','place','put','right','said','same',
  'see','she','should','since','so','some','still','such','take','than','that','the','their','them','then',
  'there','these','they','thing','things','think','this','those','through','time','to','too','two','under',
  'up','us','use','used','very','want','was','way','we','well','were','what','when','where','which','while',
  'who','why','will','with','work','world','would','year','you','your',
]);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Fraction of tokens drawn from COMMON. 1.0 = entirely everyday. */
export function commonShare(text) {
  const t = tokenize(text);
  if (t.length === 0) return 0;
  return t.filter((w) => COMMON.has(w)).length / t.length;
}

/** True when one pole's token set is a subset of the other's — the `X` /
 *  `more X` shape. MEASURED: workstream B scored that surface control at
 *  judgeAUC 0.530 on both seeds, exactly the lexical ceiling and exactly the
 *  score of the known-mush axis. An axis of this shape orders nothing. */
function isContained(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return true;
  const subset = (x, y) => [...x].every((w) => y.has(w));
  return subset(sa, sb) || subset(sb, sa);
}

/** Stage 1. Runs on the EXPANDED phrases, because that is what gets embedded;
 *  reports in terms of the TYPED terms, because that is what the user can
 *  change. */
export function lintPoles(negTerm, posTerm, negPhrase, posPhrase) {
  const negTokens = tokenize(negPhrase);
  const posTokens = tokenize(posPhrase);
  const lenDelta = Math.abs(negTokens.length - posTokens.length);
  // Scored either way so the caller can see it, but only ACTED on when both
  // sides are long enough for the share to mean anything.
  const registerDelta = Math.abs(commonShare(negPhrase) - commonShare(posPhrase));
  const registerMeasurable =
    negTokens.length >= MIN_REGISTER_TOKENS && posTokens.length >= MIN_REGISTER_TOKENS;
  const contained = isContained(negPhrase, posPhrase);

  const warnings = [];
  if (contained) {
    warnings.push({
      check: 'containment',
      message: `"${negTerm}" and "${posTerm}" describe the same thing with an extra word, so the axis has no direction to give. Try two opposites.`,
    });
  }
  if (lenDelta >= LEN_DELTA_MAX) {
    warnings.push({
      check: 'lenDelta',
      message: `"${negTerm}" and "${posTerm}" expanded to very different lengths, which can make the axis sort by wordiness. Try re-expanding.`,
    });
  }
  if (registerMeasurable && registerDelta >= REGISTER_DELTA_MAX) {
    warnings.push({
      check: 'registerDelta',
      message: `"${negTerm}" and "${posTerm}" expanded into different registers — one everyday, one technical — which can make the axis sort by vocabulary. Try re-expanding.`,
    });
  }
  return { warnings, lenDelta, registerDelta, contained };
}

// ── stage 2: BoW versus embedding, once a pool exists ───────────────────────
//
// The doc's check, finally possible: with one pair there was no averaging to
// expose a dominant token at stage 1, but with a POOL to rank there is. Score
// every candidate by lexical overlap with the pos-minus-neg terms, take the
// top-k, and compare against the embedding's top-k. High agreement means the
// axis sorts by a word and the embedder is doing no work.
//
// This necessarily warns mid-session — the evidence did not exist earlier.
//
// This is ALL of stage 2. Workstream B went looking for a cheap statistic that
// would also flag a merely WEAK axis and found none: poleCoherence and
// interPoleMargin both reversed sign across two runs of the same matrix
// (docs/measurements/2026-08-22-workstream-b-null-result.md). Shipping either
// would be shipping a check that reports noise.

/** Ports from the axis-measurement doc unchanged. */
export const BOW_OVERLAP_MAX = 0.375;

const TOP_K = 8;

function topKBy(items, score, k) {
  return items
    .map((item, i) => ({ i, s: score(item) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.i);
}

/** Overlap of the lexical top-k with the embedding top-k, as a fraction of k. */
export function lintAgainstPool(negPhrase, posPhrase, candidates, coordsAxis) {
  // k adapts to the pool. A fixed k of 8 with a hard `length < 16` guard makes
  // the check silently inert on anything smaller, which is the worst failure
  // mode a lint can have: it reports nothing and looks like a pass.
  const k = Math.min(TOP_K, Math.floor(candidates.length / 2));
  if (k < 2) return { overlap: 0, warning: null };

  const posTokens = new Set(tokenize(posPhrase));
  const negTokens = new Set(tokenize(negPhrase));
  // The bag-of-words direction: tokens the positive pole has and the negative
  // one does not, minus the reverse. No semantics at all — that is the point.
  const bow = (text) => {
    const t = tokenize(text);
    let s = 0;
    for (const w of t) {
      if (posTokens.has(w) && !negTokens.has(w)) s += 1;
      else if (negTokens.has(w) && !posTokens.has(w)) s -= 1;
    }
    return t.length === 0 ? 0 : s / t.length;
  };

  // NO LEXICAL SIGNAL, NO FINDING. When every candidate scores the same — the
  // normal case, since most pool words contain neither pole's vocabulary — the
  // sort is a no-op and "lexical top-k" is just the first k in input order.
  // Comparing that against the embedding top-k manufactures agreement out of
  // array order and fires on a perfectly good axis. A bag of words that
  // distinguishes nothing has not retrieved anything, so the question is void.
  const scores = candidates.map((c) => bow(c.text));
  if (new Set(scores).size <= 1) return { overlap: 0, warning: null };

  const lexical = new Set(topKBy(candidates, (c) => bow(c.text), k));
  const embedded = topKBy(candidates, (c) => c.coords?.[coordsAxis] ?? -Infinity, k);
  const shared = embedded.filter((i) => lexical.has(i)).length;
  const overlap = shared / k;

  if (overlap < BOW_OVERLAP_MAX) return { overlap, warning: null };
  return {
    overlap,
    warning: {
      check: 'bowOverlap',
      message: 'this direction is sorting by a word rather than a meaning. Try re-expanding the poles, or pick different words.',
    },
  };
}
