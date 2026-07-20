import { describe, expect, it } from "vitest";
import { parsePoleTerms } from "../src/axis-core";
import { MAX_POLE_TERM_CHARS } from "../src/types";

describe("parsePoleTerms", () => {
  it("accepts two non-empty terms and trims them", () => {
    expect(parsePoleTerms({ negTerm: "  concrete ", posTerm: "abstract" }))
      .toEqual({ negTerm: "concrete", posTerm: "abstract" });
  });

  it("rejects a missing or empty pole", () => {
    expect(parsePoleTerms({ negTerm: "concrete" })).toBeNull();
    expect(parsePoleTerms({ negTerm: "concrete", posTerm: "   " })).toBeNull();
  });

  it("rejects non-string poles", () => {
    expect(parsePoleTerms({ negTerm: 1, posTerm: "abstract" })).toBeNull();
  });

  it("rejects a term longer than MAX_POLE_TERM_CHARS", () => {
    expect(parsePoleTerms({ negTerm: "x".repeat(MAX_POLE_TERM_CHARS + 1), posTerm: "abstract" })).toBeNull();
  });

  it("rejects two identical poles, which would give a zero-length axis", () => {
    expect(parsePoleTerms({ negTerm: "concrete", posTerm: " Concrete " })).toBeNull();
  });
});
