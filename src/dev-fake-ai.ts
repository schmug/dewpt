// Dev-only stand-in for the Workers AI binding, enabled ONLY when
// DEV_FAKE_AI=1 is set in .dev.vars (never in wrangler.jsonc). Exists because
// some local environments (e.g. Cloudflare WARP intercepting workerd's
// sockets) block all outbound connections from the dev runtime, which makes
// the real remote AI binding unreachable. Production generation is Workers AI
// only — this fixture just lets the field/pool machinery be exercised locally.

import type { AiRunner } from "./generation";

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

export function fakeAiRunner(): AiRunner {
  const counters = new Map<string, number>();
  return {
    async run(_model, inputs) {
      await new Promise((r) => setTimeout(r, 250)); // a little pretend latency
      if (Array.isArray(inputs.text)) {
        return { data: (inputs.text as string[]).map(pseudoEmbedding) };
      }
      const messages = inputs.messages as { content: string }[];
      const lastContent = messages[messages.length - 1]!.content;
      const req = JSON.parse(lastContent.slice(0, lastContent.indexOf("\n"))) as {
        strangeness: number;
        altitude: number;
        count: number;
      };
      const tier = req.strangeness < 0.33 ? 0 : req.strangeness <= 0.66 ? 1 : 2;
      const alt = req.altitude >= 0.5 ? 1 : 0;
      const bucket = `w${tier}a${alt}`;
      const base = POOLS[bucket]!;
      const out: string[] = [];
      let cursor = counters.get(bucket) ?? 0;
      while (out.length < req.count) {
        const generation = Math.floor(cursor / base.length);
        const word = base[cursor % base.length]!;
        out.push(generation === 0 ? word : `${word} ${generation + 1}`);
        cursor++;
      }
      counters.set(bucket, cursor);
      return { response: JSON.stringify(out) };
    },
  };
}
