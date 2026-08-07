import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/press.css", import.meta.url), "utf8");

const REQUIRED_TOKENS = [
  "--press-ground", "--press-paper", "--press-ink", "--press-hair", "--press-accent",
  "--press-face-display", "--press-face-text", "--press-face-mono",
  "--press-ease", "--press-dur-fast", "--press-dur-base", "--press-dur-slow",
  "--press-stagger",
  "--press-blur-near", "--press-blur-mid", "--press-blur-far",
  "--press-radius",
  "--press-v1", "--press-v2", "--press-h1", "--press-h2",
];

const REQUIRED_CLASSES = [".press-rule", ".press-cross", ".press-label", ".press-go"];

describe("press.css", () => {
  it("defines every documented token", () => {
    for (const token of REQUIRED_TOKENS) {
      expect(css, `missing ${token}`).toContain(`${token}:`);
    }
  });

  it("defines every documented utility class", () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(css, `missing ${cls}`).toContain(cls);
    }
  });

  it("uses the one Press easing curve and no other cubic-bezier", () => {
    const curves = new Set(css.match(/cubic-bezier\([^)]*\)/g) ?? []);
    expect([...curves]).toEqual(["cubic-bezier(0.22, 1, 0.36, 1)"]);
  });

  it("squares corners by default", () => {
    expect(css).toMatch(/--press-radius:\s*0/);
  });

  it("honours prefers-reduced-motion", () => {
    expect(css).toContain("prefers-reduced-motion");
  });
});
