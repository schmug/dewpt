// Dev-only stand-in for the Workers AI binding, enabled ONLY when
// DEV_FAKE_AI=1 is set in .dev.vars (never in wrangler.jsonc). Exists because
// some local environments (e.g. Cloudflare WARP intercepting workerd's
// sockets) block all outbound connections from the dev runtime, which makes
// the real remote AI binding unreachable. Production generation is Workers AI
// only — this fixture just lets the field/pool machinery be exercised locally.

import type { AiRunner } from "./generation";
import { MAX_POLE_PHRASE_CHARS } from "./types";

// The demo's pre-baked pools, reused as canned generation output per bucket.
const POOLS: Record<string, string[]> = {
  w0a0: ["phishing drill", "password day", "poster contest", "lunch-and-learn", "badge stickers", "monthly newsletter", "quiz with prizes", "report button", "welcome-back training", "door-lock checks"],
  w0a1: ["habit", "repetition", "trust", "reminders", "routine", "vigilance", "compliance", "muscle memory", "recognition", "baseline"],
  w1a0: ["hallway escape room", "security mascot", "phishing bingo", "staff CTF night", "spot-the-fake wall", "incident tabletop game", "security fortune cookies", "fake-invoice bake-off", "lanyard trading cards", "two-minute mystery emails"],
  w1a1: ["play", "curiosity", "friendly rivalry", "storytelling", "folklore", "street smarts", "rituals", "bragging rights", "shared vocabulary", "near-miss stories"],
  w2a0: ["haunted inbox exhibit", "phish sommelier tasting", "threat-model tarot deck", "cafeteria con-artist theater", "lock-picking petting zoo", "malware aquarium", "ransomware campfire stories", "gossip-powered honeypot", "social-engineering improv night", "breach museum field trip"],
  w2a1: ["immune system", "superstition", "herd instinct", "antibodies", "myth-making", "communal grooming", "tribal memory", "dread as teacher", "apprenticeship of doubt", "folk immunity"],
};

/** Deterministic pseudo-embedding: same text → same unit vector, different
 *  texts → effectively unrelated vectors, so dedupe behaves realistically. */
function pseudoEmbedding(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const vec: number[] = [];
  let state = h >>> 0;
  for (let i = 0; i < 64; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vec.push(state / 0xffffffff - 0.5);
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

/** Pull the request object out of the last chat turn.
 *
 *  Every caller puts its payload on the FIRST LINE of the final user turn, with
 *  any instruction prose on the lines after it — except pole expansion, which
 *  sends bare JSON with no newline at all. The original `slice(0, indexOf("\n"))`
 *  read that -1 as an index and chopped the closing brace, so every pole
 *  expansion under DEV_FAKE_AI=1 threw, `expandPole` swallowed it, and every
 *  user-named axis ran on a bare embedded term at AUC 0.640 instead of 0.980,
 *  looking entirely normal. Hence the explicit -1 branch.
 *
 *  Anything that is not a JSON object on that line THROWS. See the dispatch in
 *  `fakeAiRunner` for why this fixture must never guess. */
function parseRequest(messages: unknown): Record<string, unknown> {
  const turns = messages as { content?: unknown }[] | undefined;
  const last = Array.isArray(turns) ? turns[turns.length - 1] : undefined;
  const content = last?.content;
  if (typeof content !== "string") {
    throw new Error("dev-fake-ai: unrecognised request — no embedding input and no chat messages");
  }
  const newline = content.indexOf("\n");
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new Error(`dev-fake-ai: unrecognised request — first line is not JSON: ${firstLine.slice(0, 80)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dev-fake-ai: unrecognised request — first line is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** The fake's pole phrase is embedded and used as an axis direction exactly as
 *  the real model's is, so it has to honour POLE_SYSTEM_PROMPT's contract
 *  (generation.ts) rather than merely survive `parsePolePhrase`: an article,
 *  4-8 words, never the bare term. It keeps the term inside the phrase so
 *  different poles stay distinguishable under `pseudoEmbedding`, and drops
 *  trailing term words when a long term would otherwise blow the word or
 *  character ceiling. */
function fakePolePhrase(term: string): string {
  const words = term.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  for (let take = Math.min(words.length, 4); take > 0; take--) {
    const phrase = `a ${words.slice(0, take).join(" ")} kind of thing`;
    if (phrase.length <= MAX_POLE_PHRASE_CHARS) return phrase;
  }
  return "a thing of no particular kind";
}

/** generation.ts's `cleanList` — which `generateRewrites` runs this output
 *  through — drops anything over five words, and the board's own prompt admits
 *  1-5 word fragments. A five-word parent plus a space-separated marker would
 *  therefore be discarded in full and the lineage would starve rather than hop.
 *  Hyphenate in that case: the marker still varies per call, and the parent text
 *  is still a substring, which is what keeps the tether high and gives lineage
 *  dedupe something real to reject. */
const MAX_FAKE_REWRITE_WORDS = 5;

function fakeRewrite(fragment: string, n: number): string {
  const spaced = `${fragment} ${n}`;
  return spaced.split(" ").length <= MAX_FAKE_REWRITE_WORDS ? spaced : `${fragment}-${n}`;
}

export function fakeAiRunner(): AiRunner {
  const counters = new Map<string, number>();
  return {
    async run(_model, inputs) {
      await new Promise((r) => setTimeout(r, 250)); // a little pretend latency
      if (Array.isArray(inputs.text)) {
        return { data: (inputs.text as string[]).map(pseudoEmbedding) };
      }
      const req = parseRequest(inputs.messages);

      // Pole expansion (generation.ts `expandPole`) — a bare {term} payload.
      if (typeof req.term === "string") {
        return { response: JSON.stringify({ phrase: fakePolePhrase(req.term) }) };
      }

      // Board rewrite (board/rewrite.ts `generateRewrites`) — {fragment,
      // target, exclude, count}. Children embed the parent text so the tether
      // stays high, and the per-fragment cursor makes successive hops distinct.
      if (typeof req.fragment === "string") {
        const count = typeof req.count === "number" ? req.count : 0;
        const key = `rw:${req.fragment}`;
        let cursor = counters.get(key) ?? 0;
        const out: string[] = [];
        while (out.length < count) {
          out.push(fakeRewrite(req.fragment, cursor + 1));
          cursor++;
        }
        counters.set(key, cursor);
        return { response: JSON.stringify(out) };
      }

      // Field generation — the original bucketed behaviour, unchanged. The
      // demo's pre-baked pools are the taste reference for the field, so this
      // output is a fixture other work reads: keep it byte-identical.
      if (typeof req.strangeness === "number" && typeof req.altitude === "number") {
        const count = typeof req.count === "number" ? req.count : 0;
        const tier = req.strangeness < 0.33 ? 0 : req.strangeness <= 0.66 ? 1 : 2;
        const alt = req.altitude >= 0.5 ? 1 : 0;
        const bucket = `w${tier}a${alt}`;
        const base = POOLS[bucket]!;
        const out: string[] = [];
        let cursor = counters.get(bucket) ?? 0;
        while (out.length < count) {
          const generation = Math.floor(cursor / base.length);
          const word = base[cursor % base.length]!;
          out.push(generation === 0 ? word : `${word} ${generation + 1}`);
          cursor++;
        }
        counters.set(bucket, cursor);
        return { response: JSON.stringify(out) };
      }

      // No fall-through. The whole defect this dispatch fixes was an
      // unrecognised shape being answered with field words instead of an error:
      // the request parsed, found no `strangeness`, and served bucket w2a0.
      // Nothing threw, so a board or an axis could be developed entirely
      // locally against security-awareness vocabulary and look fine. A throw is
      // what the callers can actually detect — `expandPole` catches it and
      // reports `expanded: false`, the pump counts a hop failure and logs — so a
      // new request shape arriving here fails loudly instead of quietly.
      throw new Error(
        `dev-fake-ai: unrecognised request shape {${Object.keys(req).join(", ")}} — ` +
          `expected a field generation, pole expansion or board rewrite payload`,
      );
    },
  };
}
