import { describe, expect, it } from "vitest";
import {
  bandTemperature,
  buildGenerationMessages,
  buildPoleExpansionMessages,
  embedTexts,
  expandPole,
  generateCandidates,
  parseCandidateList,
  parsePolePhrase,
  type AiRunner,
  type GenerationInputs,
} from "../src/generation";

function inputs(overrides: Partial<GenerationInputs> = {}): GenerationInputs {
  return {
    seed: "security awareness people actually enjoy",
    strangeness: 0.5,
    altitude: 0.3,
    anchors: [],
    exclude: [],
    count: 24,
    ...overrides,
  };
}

function allText(messages: { role: string; content: string }[]): string {
  return messages.map((m) => m.content).join("\n");
}

class MockRunner implements AiRunner {
  calls: { model: string; inputs: Record<string, unknown> }[] = [];
  constructor(private responses: unknown[]) {}
  async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs });
    if (this.responses.length === 0) throw new Error("MockRunner exhausted");
    return this.responses.length > 1 ? this.responses.shift() : this.responses[0];
  }
}

describe("buildGenerationMessages", () => {
  it("speaks 'strangeness' to the model, never the weather vocabulary", () => {
    const messages = buildGenerationMessages(inputs());
    const text = allText(messages).toLowerCase();
    expect(text).toContain("strangeness");
    expect(text).not.toContain("dewpoint");
    expect(text).not.toContain("drizzle");
  });

  it("includes the seed, count, anchors and exclusions in the final user message", () => {
    const messages = buildGenerationMessages(
      inputs({ seed: "midnight radio", anchors: ["static hymn"], exclude: ["dial tone"], count: 17 }),
    );
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("midnight radio");
    expect(last.content).toContain("static hymn");
    expect(last.content).toContain("dial tone");
    expect(last.content).toContain("17");
  });

  it("selects far-band few-shot examples at high strangeness", () => {
    const text = allText(buildGenerationMessages(inputs({ strangeness: 0.85 })));
    expect(text).toContain("threat-model tarot deck");
    expect(text).not.toContain("phishing drill");
  });

  it("selects near-band few-shot examples at low strangeness", () => {
    const text = allText(buildGenerationMessages(inputs({ strangeness: 0.15 })));
    expect(text).toContain("phishing drill");
    expect(text).not.toContain("threat-model tarot deck");
  });

  it("includes few-shot examples from more than one seed domain", () => {
    const text = allText(buildGenerationMessages(inputs({ strangeness: 0.5 })));
    expect(text).toContain("security awareness people actually enjoy");
    expect(text).toContain("urban gardening");
  });

  it("shows both concrete and abstract examples for the band", () => {
    const messages = buildGenerationMessages(inputs({ strangeness: 0.15 }));
    const text = allText(messages);
    expect(text).toContain("phishing drill"); // concrete (a0)
    expect(text).toContain("muscle memory"); // abstract (a1)
  });

  it("instructs the model to keep the strangeness bands contrastive", () => {
    const [system] = buildGenerationMessages(inputs());
    expect(system!.role).toBe("system");
    expect(system!.content).toContain("out of place");
  });

  it("steers high strangeness toward objects and metaphors, not event formats", () => {
    const text = allText(buildGenerationMessages(inputs({ strangeness: 0.85 })));
    // the far-band register reference: objects/mechanisms/rituals, not bookable events
    expect(text).toContain("threat-model tarot deck");
    expect(text).toContain("gossip-powered honeypot");
    expect(text).not.toContain("breach museum field trip");
    expect(text).not.toContain("phish sommelier tasting");
  });
});

describe("parseCandidateList", () => {
  it("parses a plain JSON array", () => {
    expect(parseCandidateList('["mist", "haze"]', 10)).toEqual(["mist", "haze"]);
  });

  it("parses an array inside a fenced code block", () => {
    expect(parseCandidateList('```json\n["mist", "haze"]\n```', 10)).toEqual(["mist", "haze"]);
  });

  it("parses an array embedded in prose", () => {
    expect(parseCandidateList('Here you go:\n["mist", "haze"] — enjoy!', 10)).toEqual(["mist", "haze"]);
  });

  it("accepts an object with an array value", () => {
    expect(parseCandidateList('{"words": ["mist", "haze"]}', 10)).toEqual(["mist", "haze"]);
  });

  it("returns [] on junk instead of throwing", () => {
    expect(parseCandidateList("no list here", 10)).toEqual([]);
    expect(parseCandidateList("", 10)).toEqual([]);
    expect(parseCandidateList(null, 10)).toEqual([]);
  });

  it("drops non-strings, empties, and over-long phrases", () => {
    const raw = JSON.stringify(["ok phrase", "", 42, "  ", "one two three four five six seven", "x".repeat(80)]);
    expect(parseCandidateList(raw, 10)).toEqual(["ok phrase"]);
  });

  it("dedupes case-insensitively and clamps to count", () => {
    const raw = JSON.stringify(["Mist", "mist", "haze", "fog", "dew"]);
    expect(parseCandidateList(raw, 3)).toEqual(["Mist", "haze", "fog"]);
  });
});

describe("generateCandidates", () => {
  it("passes model, messages and a band temperature to the runner and parses the response", async () => {
    const runner = new MockRunner([{ response: '["mist", "haze"]' }]);
    const result = await generateCandidates(runner, "@cf/meta/some-model", inputs({ strangeness: 0.85 }));
    expect(result).toEqual(["mist", "haze"]);
    const call = runner.calls[0]!;
    expect(call.model).toBe("@cf/meta/some-model");
    expect(Array.isArray(call.inputs.messages)).toBe(true);
    expect(call.inputs.temperature).toBe(bandTemperature(0.85));
  });

  it("handles a response that is already an array", async () => {
    const runner = new MockRunner([{ response: ["mist", "haze"] }]);
    expect(await generateCandidates(runner, "m", inputs())).toEqual(["mist", "haze"]);
  });

  it("handles an OpenAI-style chat completion envelope", async () => {
    const runner = new MockRunner([{ choices: [{ message: { content: '["mist"]' } }] }]);
    expect(await generateCandidates(runner, "m", inputs())).toEqual(["mist"]);
  });

  it("returns [] when the model replies with junk", async () => {
    const runner = new MockRunner([{ response: "I cannot help with that." }]);
    expect(await generateCandidates(runner, "m", inputs())).toEqual([]);
  });
});

describe("embedTexts", () => {
  it("sends texts to the embedding model and returns vectors", async () => {
    const runner = new MockRunner([{ data: [[1, 0], [0, 1]] }]);
    const result = await embedTexts(runner, "@cf/baai/bge-m3", ["mist", "haze"]);
    expect(result).toEqual([[1, 0], [0, 1]]);
    expect(runner.calls[0]!.inputs.text).toEqual(["mist", "haze"]);
  });

  it("chunks large batches and concatenates results in order", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `w${i}`);
    const runner = new (class implements AiRunner {
      calls: string[][] = [];
      async run(_model: string, inputs: Record<string, unknown>): Promise<unknown> {
        const batch = inputs.text as string[];
        this.calls.push(batch);
        return { data: batch.map((t) => [Number(t.slice(1)), 1]) };
      }
    })();
    const result = await embedTexts(runner, "m", texts);
    expect(result).toHaveLength(150);
    expect(result[149]![0]).toBe(149);
    expect(runner.calls.length).toBeGreaterThan(1);
  });

  it("returns [] for an empty input without calling the model", async () => {
    const runner = new MockRunner([]);
    expect(await embedTexts(runner, "m", [])).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("bandTemperature", () => {
  it("rises monotonically with strangeness and stays in a sane range", () => {
    const low = bandTemperature(0.15);
    const mid = bandTemperature(0.5);
    const high = bandTemperature(0.85);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(0.5);
    expect(high).toBeLessThanOrEqual(1.3);
  });
});

describe("buildPoleExpansionMessages", () => {
  it("shows the model the disambiguation it must perform", () => {
    const text = allText(buildPoleExpansionMessages("concrete")).toLowerCase();
    expect(text).toContain("a physical object you can touch");
    expect(text).toContain("concrete");
  });

  it("puts the term to expand in the final user message", () => {
    const messages = buildPoleExpansionMessages("liminal");
    expect(messages[messages.length - 1]!.role).toBe("user");
    expect(messages[messages.length - 1]!.content).toContain("liminal");
  });
});

describe("parsePolePhrase", () => {
  it("reads the phrase out of a JSON object", () => {
    expect(parsePolePhrase('{"phrase":"a physical object you can touch"}')).toBe("a physical object you can touch");
  });

  it("survives code fences", () => {
    expect(parsePolePhrase('```json\n{"phrase":"an abstract idea"}\n```')).toBe("an abstract idea");
  });

  it("accepts a bare string", () => {
    expect(parsePolePhrase('"a routine practical task"')).toBe("a routine practical task");
  });

  it("collapses whitespace", () => {
    expect(parsePolePhrase('{"phrase":"a  physical\\n object"}')).toBe("a physical object");
  });

  it("rejects an over-long phrase rather than truncating it", () => {
    expect(parsePolePhrase(`{"phrase":"${"x".repeat(200)}"}`)).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parsePolePhrase("I'm sorry, I can't help with that.")).toBeNull();
    expect(parsePolePhrase(null)).toBeNull();
    expect(parsePolePhrase('{"phrase":""}')).toBeNull();
  });
});

describe("expandPole", () => {
  it("returns the expanded phrase", async () => {
    const ai = new MockRunner(['{"phrase":"a mystical or magical practice"}']);
    expect(await expandPole(ai, "m", "mystical")).toBe("a mystical or magical practice");
  });

  it("falls back to the bare term when the model returns junk", async () => {
    const ai = new MockRunner(["no."]);
    expect(await expandPole(ai, "m", "mystical")).toBe("mystical");
  });

  it("falls back to the bare term when the call throws", async () => {
    const ai: AiRunner = { async run() { throw new Error("upstream down"); } };
    expect(await expandPole(ai, "m", "mystical")).toBe("mystical");
  });
});
