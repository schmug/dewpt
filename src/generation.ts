// LLM generation for the candidate pool. Vocabulary note (SPEC.md): the model
// is prompted with the plain word "strangeness" — the weather terms (dewpoint,
// drizzle) exist only in the UI and API layers, never in prompts.

import { MAX_POLE_PHRASE_CHARS } from "./types";

/** Structural subset of the Workers AI binding — mockable in tests, and
 *  implementable over the REST API for scripts/calibrate.ts. */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface GenerationInputs {
  seed: string;
  strangeness: number; // 0 = obvious/adjacent, 1 = far-field/surreal
  altitude: number; // 0 = concrete/actionable, 1 = abstract concepts
  anchors: string[];
  exclude: string[];
  count: number;
}

const SYSTEM_PROMPT = `You generate single evocative words and short phrases (1-5 words) related to a seed topic, at a specified strangeness and altitude.

strangeness: 0 = obvious, adjacent, expected; 1 = far-field and surreal, yet still meaningfully connected to the seed. At high strangeness, reach for remote concepts and bridge them back to the seed — never random noise.
altitude: 0 = concrete, specific, actionable things; 1 = abstract concepts, principles, and underlying forces.

Rules:
- Respond with a JSON array of strings only. No prose, no code fences, no keys.
- Each item is 1-5 words. No sentences, no explanations.
- Keep the strangeness levels contrastive: an item generated at one strangeness should feel out of place at the others. At high strangeness, avoid safe formats that would fit at low strangeness (workshops, newsletters, game nights) — prefer unexpected objects, mechanisms, and rituals when the altitude is concrete, and far-reaching metaphors when it is abstract.
- Never repeat anything in the exclusion list, and avoid trivial variants of it.
- If anchor words are given, let them tilt the flavor of the results without repeating them.
- No duplicates within your answer.`;

type Band = "low" | "mid" | "high";

const BAND_STRANGENESS: Record<Band, number> = { low: 0.2, mid: 0.5, high: 0.85 };

interface FewshotSeed {
  seed: string;
  bands: Record<Band, { concrete: string[]; abstract: string[] }>;
}

// The demo's pre-baked pools are the taste reference for the security seed;
// the gardening seed keeps the model from overfitting to one domain.
const FEWSHOT_SEEDS: FewshotSeed[] = [
  {
    seed: "security awareness people actually enjoy",
    bands: {
      low: {
        concrete: ["phishing drill", "password day", "poster contest", "lunch-and-learn", "quiz with prizes", "report button"],
        abstract: ["habit", "muscle memory", "routine", "vigilance", "recognition", "baseline"],
      },
      mid: {
        concrete: ["hallway escape room", "phishing bingo", "staff CTF night", "spot-the-fake wall", "security fortune cookies", "lanyard trading cards"],
        abstract: ["play", "curiosity", "friendly rivalry", "storytelling", "folklore", "near-miss stories"],
      },
      high: {
        // register reference for the far band: objects, mechanisms, rituals —
        // not bookable events (that's what made calibration bleed into mid)
        concrete: ["threat-model tarot deck", "gossip-powered honeypot", "malware aquarium", "ransomware campfire stories", "firewall gargoyles", "insider-threat ouija board"],
        abstract: ["immune system", "superstition", "myth-making", "tribal memory", "dread as teacher", "folk immunity"],
      },
    },
  },
  {
    seed: "urban gardening",
    bands: {
      low: {
        concrete: ["balcony planter boxes", "seed swap meetup", "community compost bin", "rain barrel", "window herb box", "tomato cages"],
        abstract: ["patience", "tending", "seasons", "neighborliness", "growth", "soil"],
      },
      mid: {
        concrete: ["sidewalk seed bombs", "alley orchard map", "rooftop bee lease", "pop-up plant clinic", "stoop harvest stand", "compost bicycle brigade"],
        abstract: ["stewardship", "urban rewilding", "food sovereignty", "the commons", "root systems", "slow rebellion"],
      },
      high: {
        concrete: ["guerrilla topsoil heist", "pigeon-assisted pollination", "parking-meter greenhouses", "fire-escape vineyard", "sewer-grate mushroom farm", "billboard vine trellis"],
        abstract: ["concrete remembering meadows", "photosynthesis as protest", "the city as seedbank", "chlorophyll folklore", "asphalt's slow forgiveness", "seeds as time capsules"],
      },
    },
  },
];

function bandFor(strangeness: number): Band {
  if (strangeness < 0.33) return "low";
  if (strangeness <= 0.66) return "mid";
  return "high";
}

function requestPayload(inputs: GenerationInputs): string {
  const payload = JSON.stringify({
    seed: inputs.seed,
    strangeness: inputs.strangeness,
    altitude: inputs.altitude,
    anchors: inputs.anchors,
    exclude: inputs.exclude,
    count: inputs.count,
  });
  return `${payload}\nReturn a JSON array of exactly ${inputs.count} strings. No other text.`;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildGenerationMessages(inputs: GenerationInputs): ChatMessage[] {
  const band = bandFor(inputs.strangeness);
  const strangeness = BAND_STRANGENESS[band];
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const example of FEWSHOT_SEEDS) {
    const pools = example.bands[band];
    for (const [altitude, items] of [
      [0.2, pools.concrete],
      [0.8, pools.abstract],
    ] as const) {
      messages.push({
        role: "user",
        content: requestPayload({ seed: example.seed, strangeness, altitude, anchors: [], exclude: [], count: items.length }),
      });
      messages.push({ role: "assistant", content: JSON.stringify(items) });
    }
  }
  messages.push({ role: "user", content: requestPayload(inputs) });
  return messages;
}

/** Temperature scales with strangeness: obvious bands sample tight, far bands loose. */
export function bandTemperature(strangeness: number): number {
  return 0.6 + 0.6 * Math.min(1, Math.max(0, strangeness));
}

const MAX_PHRASE_WORDS = 5;
const MAX_PHRASE_CHARS = 64;

function cleanList(items: unknown[], count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.trim().replace(/\s+/g, " ");
    if (!text || text.length > MAX_PHRASE_CHARS) continue;
    if (text.split(" ").length > MAX_PHRASE_WORDS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= count) break;
  }
  return out;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Robustly extract a list of phrases from whatever the model returned:
 *  a JSON array, a fenced block, an array buried in prose, or an object
 *  wrapping an array. Junk yields [] — generation failures must never throw
 *  into the serving path. */
export function parseCandidateList(raw: unknown, count: number): string[] {
  if (Array.isArray(raw)) return cleanList(raw, count);
  if (typeof raw !== "string") return [];
  let text = raw.trim();
  if (!text) return [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  let parsed = tryParse(text);
  if (parsed === undefined) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1));
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = Object.values(parsed).find(Array.isArray);
  }
  if (!Array.isArray(parsed)) return [];
  return cleanList(parsed, count);
}

/** Pull the text (or array) payload out of the various Workers AI response envelopes. */
function extractResponse(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result === "string" || Array.isArray(result)) return result;
  if (typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  if (obj.response !== undefined) return obj.response;
  const choices = obj.choices as { message?: { content?: unknown } }[] | undefined;
  if (Array.isArray(choices) && choices[0]?.message?.content !== undefined) return choices[0].message.content;
  if (obj.output_text !== undefined) return obj.output_text;
  if (obj.result !== undefined) return extractResponse(obj.result);
  return null;
}

export async function generateCandidates(
  ai: AiRunner,
  model: string,
  inputs: GenerationInputs,
  temperature: number = bandTemperature(inputs.strangeness),
): Promise<string[]> {
  const messages = buildGenerationMessages(inputs);
  const result = await ai.run(model, { messages, temperature, max_tokens: 1024 });
  return parseCandidateList(extractResponse(result), inputs.count);
}

const EMBED_CHUNK = 96;

export async function embedTexts(ai: AiRunner, model: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const chunk = texts.slice(i, i + EMBED_CHUNK);
    const result = (await ai.run(model, { text: chunk })) as { data?: unknown; result?: { data?: unknown } } | null;
    const data = result?.data ?? result?.result?.data;
    if (!Array.isArray(data) || data.length !== chunk.length) {
      throw new Error(`embedding model returned ${Array.isArray(data) ? data.length : "no"} vectors for ${chunk.length} texts`);
    }
    out.push(...(data as number[][]));
  }
  return out;
}

// ── pole expansion ─────────────────────────────────────────────────────────
// A user types "concrete"; embedding that bare word drags the axis toward
// cement, costing ~0.34 AUC. Expanding to "a physical object you can touch"
// recovers it. This step is mandatory — see the spike table in
// docs/latent-space-navigation-design.md.

const POLE_SYSTEM_PROMPT = `You expand a single term into an unambiguous descriptive phrase naming one end of a semantic axis.

The phrase gets embedded and used as a direction in vector space, so ambiguity is fatal: "concrete" on its own pulls toward cement rather than toward the opposite of abstract.

Rules:
- Respond with a JSON object of the form {"phrase": "..."} and nothing else. No prose, no code fences.
- 4-8 words. A noun phrase naming the KIND of thing found at this pole.
- Begin with an article: "a", "an", or "something".
- Resolve the term's intended sense. Never return the bare term on its own.
- Never define this pole by negating the other one — "not abstract" carries no direction.`;

const POLE_FEWSHOT: [string, string][] = [
  ["concrete", "a physical object you can touch"],
  ["abstract", "an abstract idea or principle"],
  ["practical", "a routine practical task"],
  ["mystical", "a mystical or magical practice"],
];

export function buildPoleExpansionMessages(term: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: POLE_SYSTEM_PROMPT }];
  for (const [example, phrase] of POLE_FEWSHOT) {
    messages.push({ role: "user", content: JSON.stringify({ term: example }) });
    messages.push({ role: "assistant", content: JSON.stringify({ phrase }) });
  }
  messages.push({ role: "user", content: JSON.stringify({ term }) });
  return messages;
}

/** Extract the phrase from whatever the model returned. Junk yields null so the
 *  caller can fall back — axis creation must not throw into the UI. */
export function parsePolePhrase(raw: unknown): string | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    let text = value.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) text = fence[1].trim();
    const parsed = tryParse(text);
    if (parsed === undefined) return null;
    value = parsed;
  }
  if (value !== null && typeof value === "object") {
    value = (value as Record<string, unknown>).phrase;
  }
  if (typeof value !== "string") return null;
  const phrase = value.trim().replace(/\s+/g, " ");
  if (!phrase || phrase.length > MAX_POLE_PHRASE_CHARS) return null;
  return phrase;
}

/** Expand a pole term, falling back to the bare term if the model or the
 *  network fails. A degraded axis beats a failed one. */
export async function expandPole(ai: AiRunner, model: string, term: string): Promise<string> {
  try {
    const result = await ai.run(model, {
      messages: buildPoleExpansionMessages(term),
      temperature: 0.2, // disambiguation is not a creative task
      max_tokens: 64,
    });
    return parsePolePhrase(extractResponse(result)) ?? term;
  } catch {
    return term;
  }
}
