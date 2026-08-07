import { describe, expect, it } from "vitest";

// public/depth.js is plain JS served raw from public/ (no build step), so it
// sits outside tsconfig's include — same arrangement as pool-client.
// @ts-expect-error — public/depth.js ships untyped
import { blurBand, wordOpacity, BLUR_BANDS, DEPTH_OPACITY } from "../public/depth.js";

describe("blurBand", () => {
  it("returns the far band below 0.33", () => {
    expect(blurBand(0, false)).toBe(4);
    expect(blurBand(0.32, false)).toBe(4);
  });

  it("returns the mid band from 0.33 up to 0.66", () => {
    expect(blurBand(0.33, false)).toBe(1.5);
    expect(blurBand(0.65, false)).toBe(1.5);
  });

  it("returns no blur at 0.66 and above", () => {
    expect(blurBand(0.66, false)).toBe(0);
    expect(blurBand(1, false)).toBe(0);
  });

  it("reduces every band for coarse pointers", () => {
    expect(blurBand(0, true)).toBe(1.7);
    expect(blurBand(0.5, true)).toBe(0.65);
    expect(blurBand(1, true)).toBe(0);
  });

  it("never increases blur as depth increases", () => {
    for (const coarse of [false, true]) {
      let previous = Infinity;
      for (let d = 0; d <= 1; d += 0.01) {
        const blur = blurBand(d, coarse);
        expect(blur).toBeLessThanOrEqual(previous);
        previous = blur;
      }
    }
  });

  it("keeps coarse blur below fine blur at equal depth", () => {
    for (const d of [0, 0.4, 0.9]) {
      expect(blurBand(d, true)).toBeLessThanOrEqual(blurBand(d, false));
    }
  });
});

describe("wordOpacity", () => {
  it("bottoms out at the documented floor", () => {
    expect(wordOpacity(0, false)).toBeCloseTo(DEPTH_OPACITY.fine.floor, 5);
    expect(wordOpacity(0, true)).toBeCloseTo(DEPTH_OPACITY.coarse.floor, 5);
  });

  it("tops out at 1", () => {
    expect(wordOpacity(1, false)).toBeCloseTo(1, 5);
    expect(wordOpacity(1, true)).toBeCloseTo(1, 5);
  });

  it("gives touch a higher floor than fine pointers", () => {
    expect(DEPTH_OPACITY.coarse.floor).toBeGreaterThan(DEPTH_OPACITY.fine.floor);
  });
});

describe("BLUR_BANDS", () => {
  it("orders each set far to near", () => {
    for (const set of [BLUR_BANDS.fine, BLUR_BANDS.coarse]) {
      expect(set[0]).toBeGreaterThan(set[1]);
      expect(set[1]).toBeGreaterThan(set[2]);
      expect(set[2]).toBe(0);
    }
  });
});
