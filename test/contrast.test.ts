import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error — public/depth.js ships untyped
import { DEPTH_OPACITY } from "../public/depth.js";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const driftCss = readFileSync(new URL("../public/drift/styles.css", import.meta.url), "utf8");

// (?<![\w-]) anchors the start of the name so e.g. "--ink" cannot match inside
// a longer custom property like "--press-ink" — CSS custom-property names are
// built from word chars and hyphens throughout, so a plain unanchored search
// could silently resolve to the tail of an unrelated, longer-named token.
function token(name: string): string {
  const direct = css.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (direct) return direct[1];
  // One level of var(--x) indirection: dewpt's own names (--ink, --t0, --pin)
  // reference a Press token rather than retyping its literal (see Fix 3 in
  // the press-design-language review) — follow that single hop to the hex.
  const indirect = css.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*var\\((--[\\w-]+)\\)`));
  if (indirect) return token(indirect[1]);
  throw new Error(`token ${name} not found in styles.css`);
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

// drift binds the same --t0/--t1/--t2/--pin contract to the night-walk palette
// rather than to Press, so it is a DIFFERENT set of colours on a different
// ground and was covered by nothing. Every tier the card can take has to be
// legible on the surface it is drawn on.
describe("the drift surface meets contrast on every tier", () => {
  function driftToken(name: string): string {
    const m = driftCss.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`token ${name} not found in public/drift/styles.css`);
    return m[1];
  }

  const ground = channels(driftToken("--ink"));

  // The card is display-sized (clamp 30-54px), so WCAG large-text 3:1 is the
  // floor that applies. Holding the tiers to 4.5:1 anyway — a word alone on a
  // dark field is the entire interface, and 3:1 is a minimum for text that has
  // context to lean on.
  for (const [name, role] of [["--t0", "tier 0, the nearest words"],
                              ["--t1", "tier 1"],
                              ["--t2", "tier 2, the far-field words"],
                              ["--pin", "a kept word"]] as const) {
    it(`${role} (${name}) clears 4.5:1 on the ground`, () => {
      expect(contrast(channels(driftToken(name)), ground)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The quiet token carries the mono labels — gauge poles, the hint, the edge
  // message. Small text, so 4.5:1 is the real WCAG floor and not a courtesy.
  it("gauge pole labels and the hint (--label) clear 4.5:1 on the ground", () => {
    expect(contrast(channels(driftToken("--label")), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("--faint is never used for text on this surface", () => {
    // It measures 2.69:1 and cannot carry text at any size. It is a decorative
    // token — hairlines and the inert arrow glyph — and the hint line was drawn
    // in it, which made the surface's only instruction its least readable
    // element. Guarding the misuse rather than the value: the token is correct
    // for what it is for.
    expect(contrast(channels(driftToken("--faint")), ground)).toBeLessThan(4.5);
    const textRules = driftCss
      .split("}")
      .filter((block) => /var\(--faint\)/.test(block) && /\bcolor\s*:/.test(block))
      .map((block) => block.split("{")[0]!.trim());
    // The arrow is an aria-hidden glyph, not text a reader must resolve.
    const offenders = textRules.filter((sel) => !/drift-arrow/.test(sel));
    expect(offenders, `--faint used for text in: ${offenders.join(", ")}`).toEqual([]);
  });
});
