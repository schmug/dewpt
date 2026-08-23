import { describe, expect, it } from "vitest";

// @ts-expect-error — public/drift/axis-lint.js ships untyped
import * as lintUntyped from "../public/drift/axis-lint.js";

interface Warning { check: string; message: string }
interface Report { warnings: Warning[]; lenDelta: number; registerDelta: number; contained: boolean }

const lint = lintUntyped as {
  LEN_DELTA_MAX: number;
  REGISTER_DELTA_MAX: number;
  tokenize(text: string): string[];
  commonShare(text: string): number;
  lintPoles(negTerm: string, posTerm: string, negPhrase: string, posPhrase: string): Report;
};

const checks = (r: Report) => r.warnings.map((w) => w.check).sort();

describe("tokenize", () => {
  it("lowercases and drops punctuation", () => {
    expect(lint.tokenize("A physical object, you can touch!")).toEqual(
      ["a", "physical", "object", "you", "can", "touch"],
    );
  });
});

describe("the three checks are independent", () => {
  // Each fixture must trip its OWN check and no other. Without this the three
  // could be three names for one signal and nobody would notice.

  it("a length gap trips only lenDelta", () => {
    const r = lint.lintPoles(
      "solemn", "playful",
      "a solemn thing",                         // 3 tokens
      "a playful thing you can do with people", // 8 tokens
    );
    expect(checks(r)).toEqual(["lenDelta"]);
    expect(r.lenDelta).toBeGreaterThanOrEqual(lint.LEN_DELTA_MAX);
  });

  it("a register gap trips only registerDelta", () => {
    const r = lint.lintPoles(
      "plain", "arcane",
      "a thing you use",                             // 4 tokens, all everyday
      "heteroscedastic epistemic praxis nomothetic", // 4 tokens, none everyday
    );
    expect(checks(r)).toEqual(["registerDelta"]);
    expect(r.registerDelta).toBeGreaterThanOrEqual(lint.REGISTER_DELTA_MAX);
  });

  it("a contained pole trips only containment", () => {
    // MEASURED: workstream B scored the `X` / `more X` surface control at
    // judgeAUC 0.530 across both seeds — exactly the lexical ceiling, and the
    // same score as the known-mush axis. See
    // docs/measurements/2026-08-22-workstream-b-null-result.md.
    const r = lint.lintPoles("playful", "more playful", "playful", "more playful");
    expect(checks(r)).toEqual(["containment"]);
    expect(r.contained).toBe(true);
  });

  it("a healthy axis trips nothing", () => {
    const r = lint.lintPoles(
      "concrete", "abstract",
      "a tangible solid material substance",
      "a complex theoretical concept",
    );
    expect(r.warnings).toEqual([]);
  });
});

describe("warnings speak in the user's own words", () => {
  it("names the typed term, not the expanded phrase", () => {
    // The user typed "playful". They never wrote "a lighthearted playful
    // activity" and cannot act on a complaint about it.
    const r = lint.lintPoles("dull", "playful", "a dull thing", "a lighthearted playful activity for groups");
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const w of r.warnings) {
      expect(w.message).toMatch(/dull|playful/);
      expect(w.message).not.toMatch(/lighthearted/);
    }
  });
});

describe("stage 2 — BoW versus embedding", () => {
  interface Cand { text: string; coords: number[] }
  const stage2 = lintUntyped as unknown as {
    BOW_OVERLAP_MAX: number;
    lintAgainstPool(neg: string, pos: string, cands: Cand[], axis: number): { overlap: number; warning: unknown };
  };

  it("fires when the lexical ranking and the embedding ranking agree", () => {
    // If a bag of words retrieves what the embedder retrieves, the axis is
    // lexically drivable and the embedder is doing no work.
    const cands = [
      { text: "playful games", coords: [0.9] },
      { text: "playful toys", coords: [0.8] },
      { text: "playful fun", coords: [0.7] },
      { text: "solemn rites", coords: [-0.9] },
      { text: "quiet ledger", coords: [-0.5] },
      { text: "grey office", coords: [-0.3] },
    ];
    const r = stage2.lintAgainstPool("solemn ceremony", "playful activity", cands, 0);
    expect(r.overlap).toBeGreaterThanOrEqual(stage2.BOW_OVERLAP_MAX);
    // The overlap is COMPUTED but must not warn: BOW_OVERLAP_MAX has never been
    // evaluated against a real dewpt pool, only against the doc's 16-pair
    // harness on another corpus. Reported for a future measurement to falsify;
    // not shipped as a check. Critic cycle 1 blocker.
    expect(r.warning).toBeNull();
  });

  it("stays quiet when the embedding ranking is not lexical", () => {
    const cands = [
      { text: "bus stop insects", coords: [0.9] },
      { text: "mobility as empathy", coords: [0.8] },
      { text: "commuter psyche", coords: [0.7] },
      { text: "subsidy as social contract", coords: [-0.9] },
      { text: "infrastructure as institution", coords: [-0.8] },
      { text: "transportation as trust", coords: [-0.7] },
    ];
    const r = stage2.lintAgainstPool("solemn ceremony", "playful activity", cands, 0);
    expect(r.overlap).toBeLessThan(stage2.BOW_OVERLAP_MAX);
    expect(r.warning).toBeNull();
  });

  it("returns overlap 0 and no warning on a set too small to rank", () => {
    const r = stage2.lintAgainstPool("a", "b", [{ text: "x", coords: [0.1] }], 0);
    expect(r.overlap).toBe(0);
    expect(r.warning).toBeNull();
  });
});
