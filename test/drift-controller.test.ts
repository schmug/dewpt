// @vitest-environment jsdom
//
// CONTROLLER-LEVEL BEHAVIOUR, with a real DOM and an injected network.
//
// Cycle 1 and cycle 2 both landed the same criticism: the release guards
// validate DECLARATIONS rather than behaviour. The never-blocks guard greps for
// `await` in onSwipe's source, and the crossfade guard read computed CSS — both
// passed while the fade never actually ran. A regex cannot tell the difference
// between a transition that is declared and one that fires.
//
// This drives drift.js against jsdom with fetch stubbed, so the assertions are
// about what the surface DOES.

import { beforeEach, describe, expect, it, vi } from "vitest";

const MARKUP = `
  <section id="drift-setup">
    <form id="drift-seed-form"><input id="drift-seed-input" /><button type="submit">go</button></form>
    <form id="drift-axis-form" hidden>
      <input id="drift-axis-a-neg" /><input id="drift-axis-a-pos" />
      <input id="drift-axis-b-neg" /><input id="drift-axis-b-pos" />
      <button type="submit">set</button>
      <p id="drift-axis-status"></p>
    </form>
  </section>
  <main id="drift-stage" hidden>
    <div id="drift-gauges"></div>
    <button id="drift-condensate" aria-expanded="false"><span id="drift-condensate-count">0</span></button>
    <div id="drift-condensate-panel" hidden></div>
    <div id="drift-card" tabindex="0" role="button"></div>
    <p id="drift-edge" hidden></p>
    <p id="drift-hint"></p>
  </main>`;

function served(text: string, coords: number[], seedDist = 0.4) {
  return { text, tier: 1, alt: 0, seedDist, coords };
}

/** Answers the endpoints drift.js touches. Every response is synchronous-ish so
 *  a test can assert what happens BEFORE any of them resolve. */
function stubFetch(pool: unknown[]) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u === "/api/session") return json({ id: "11111111-1111-4111-8111-111111111111" });
    if (u.includes("/axes")) {
      return json({
        axes: [
          { id: "a", neg: { term: "solemn", phrase: "a solemn thing here" }, pos: { term: "playful", phrase: "a playful thing here" }, ready: true, degraded: false },
          { id: "b", neg: { term: "concrete", phrase: "a concrete thing here" }, pos: { term: "abstract", phrase: "an abstract thing here" }, ready: true, degraded: false },
        ],
      });
    }
    if (u.includes("/pool")) return json({ condensed: pool, axisIds: ["a", "b"] });
    if (u.includes("/pin")) return json({ anchors: [] });
    return json({});
  });
}
const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

async function boot(pool: unknown[]) {
  document.body.innerHTML = MARKUP;
  document.body.className = "drift-surface";
  const fetchMock = stubFetch(pool);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  location.hash = "";
  // resetModules gives a fresh evaluation; vite cannot do a variable dynamic
  // import, so the specifier has to be static.
  vi.resetModules();
  const mod = await import("../public/drift/drift.js");
  return { mod, fetchMock };
}

/** Runs the full setup flow so the stage is open with a card showing. */
async function toCardStage(pool: unknown[]) {
  const { mod, fetchMock } = await boot(pool);
  (document.getElementById("drift-seed-input") as HTMLInputElement).value = "a seed";
  document.getElementById("drift-seed-form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("drift-axis-form")!.hidden).toBe(false));
  for (const [id, v] of [["drift-axis-a-neg", "solemn"], ["drift-axis-a-pos", "playful"],
                         ["drift-axis-b-neg", "concrete"], ["drift-axis-b-pos", "abstract"]] as const) {
    (document.getElementById(id) as HTMLInputElement).value = v;
  }
  document.getElementById("drift-axis-form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("drift-stage")!.hidden).toBe(false), { timeout: 5000 });
  await vi.waitFor(() => expect(document.getElementById("drift-card")!.textContent).not.toBe(""));
  return { mod, fetchMock };
}

const POOL = Array.from({ length: 40 }, (_, i) =>
  served(`word ${i}`, [(i % 8) / 8 - 0.4, Math.floor(i / 8) / 8 - 0.4], 0.35));

beforeEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the setup flow reaches a card", () => {
  it("seed then two axes opens the stage with a real card", async () => {
    await toCardStage(POOL);
    expect(document.getElementById("drift-setup")!.hidden).toBe(true);
    expect(document.getElementById("drift-card")!.textContent).toMatch(/^word \d+$/);
    expect(document.querySelectorAll(".drift-gauge").length).toBe(2);
  });
});

describe("a swipe never blocks on the network", () => {
  it("repaints the gauge synchronously, before any fetch settles", async () => {
    // This is the assertion the lexical `await` guard was standing in for.
    // Here the network is a promise that NEVER resolves, so if the swipe waited
    // on anything the mark could not have moved.
    const { mod } = await toCardStage(POOL);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const markBefore = (document.querySelector(".drift-gauge-mark") as HTMLElement).style.left;
    (mod as { onSwipe(a: number, d: number): unknown }).onSwipe(0, 1);
    const markAfter = (document.querySelector(".drift-gauge-mark") as HTMLElement).style.left;
    expect(markAfter).not.toBe(markBefore);
  });

  it("returns a card from the resident set without awaiting", async () => {
    const { mod } = await toCardStage(POOL);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const result = (mod as { onSwipe(a: number, d: number): unknown }).onSwipe(0, 1);
    expect(result).not.toBeNull();
  });
});

describe("the card actually crossfades", () => {
  it("marks the card leaving before swapping its text", async () => {
    // The CSS transition has always been DECLARED. Cycle 2 found that
    // advance() replaced textContent outright, so nothing ever animated and
    // both the source guard and the browser check passed anyway.
    const { mod } = await toCardStage(POOL);
    const card = document.getElementById("drift-card")!;
    const before = card.textContent;
    (mod as { onSwipe(a: number, d: number): unknown }).onSwipe(0, 1);
    expect(card.dataset.leaving, "the card did not enter a leaving state").toBe("true");
    expect(card.textContent, "the text swapped before the fade ran").toBe(before);
    await vi.waitFor(() => expect(card.textContent).not.toBe(before), { timeout: 2000 });
    expect(card.dataset.leaving).toBeUndefined();
  });
});

describe("the edge is announced, not left blank", () => {
  it("declares the edge when nothing tethered is in reach", async () => {
    // A dense tethered cluster in the middle, plus two UNTETHERED outliers that
    // stretch the range to the corners without ever being showable. So the
    // centre has cards, the corners genuinely have none, and walking out must
    // announce the edge rather than teleport back to the cluster.
    const cluster = Array.from({ length: 12 }, (_, i) =>
      served(`middle ${i}`, [(i % 4) * 0.01, Math.floor(i / 4) * 0.01], 0.35));
    const outliers = [served("far lo", [-1, -1], 0.9), served("far hi", [1, 1], 0.9)];
    const { mod } = await toCardStage([...cluster, ...outliers]);
    const swipe = (mod as { onSwipe(a: number, d: number): unknown }).onSwipe;
    for (let i = 0; i < 12; i++) swipe(0, -1);
    for (let i = 0; i < 12; i++) swipe(1, -1);
    await vi.waitFor(() => {
      const edge = document.getElementById("drift-edge")!;
      expect(edge.hidden).toBe(false);
      expect(edge.textContent).toMatch(/nothing tethered/i);
    }, { timeout: 3000 });
  });
});

describe("an untethered pool cannot surface a card", () => {
  it("shows the edge rather than a candidate below the anisotropy floor", async () => {
    // seedDist 0.8 -> cosine 0.2, well under the 0.414 unrelated-phrase
    // baseline. These are not about the seed and must never be shown.
    const untethered = Array.from({ length: 20 }, (_, i) => served(`noise ${i}`, [0, 0], 0.8));
    const { mod } = await boot(untethered);
    (document.getElementById("drift-seed-input") as HTMLInputElement).value = "a seed";
    document.getElementById("drift-seed-form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById("drift-axis-form")!.hidden).toBe(false));
    for (const [id, v] of [["drift-axis-a-neg", "solemn"], ["drift-axis-a-pos", "playful"],
                           ["drift-axis-b-neg", "concrete"], ["drift-axis-b-pos", "abstract"]] as const) {
      (document.getElementById(id) as HTMLInputElement).value = v;
    }
    document.getElementById("drift-axis-form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById("drift-stage")!.hidden).toBe(false), { timeout: 5000 });
    expect(document.getElementById("drift-card")!.textContent).toBe("");
    expect(document.getElementById("drift-edge")!.hidden).toBe(false);
    void mod;
  });
});
