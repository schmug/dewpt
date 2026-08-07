import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error — public/depth.js ships untyped
import { DEPTH_OPACITY } from "../public/depth.js";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token ${name} not found in styles.css`);
  return match[1];
}

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite a foreground over a background, as the browser would. */
function over(fg: string, bg: string, alpha: number): [number, number, number] {
  const f = channels(fg);
  const b = channels(bg);
  return [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as [number, number, number];
}

describe("dewpt palette contrast", () => {
  const ground = () => channels(token("--ink"));

  it("keeps opaque label text at AA body contrast", () => {
    expect(contrast(channels(token("--label")), ground())).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the accent at AA body contrast", () => {
    expect(contrast(channels(token("--pin")), ground())).toBeGreaterThanOrEqual(4.5);
  });

  // Field words are deliberately faint at depth — that is the depth cue. They
  // are held to the large-text bar at their dimmest, not the body bar.
  it.each([
    ["--t0", 3.43],
    ["--t1", 2.68],
    ["--t2", 2.77],
  ])("keeps %s legible at the fine-pointer opacity floor", (name, baseline) => {
    const composited = over(token(name), token("--ink"), DEPTH_OPACITY.fine.floor);
    const ratio = contrast(composited, ground());
    expect(ratio).toBeGreaterThanOrEqual(3.0);
    // ...and never worse than the pre-Press design measured at the same floor.
    expect(ratio).toBeGreaterThanOrEqual(baseline);
  });

  it("gives touch users more contrast than fine pointers", () => {
    for (const name of ["--t0", "--t1", "--t2"]) {
      const fine = contrast(over(token(name), token("--ink"), DEPTH_OPACITY.fine.floor), ground());
      const coarse = contrast(over(token(name), token("--ink"), DEPTH_OPACITY.coarse.floor), ground());
      expect(coarse).toBeGreaterThan(fine);
    }
  });
});
