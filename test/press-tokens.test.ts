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

// Extracts the body `{ ... }` that follows the first occurrence of `startText`,
// respecting nested braces (so it can safely pull a whole @media block).
function extractBlockBody(source: string, startText: string): string {
  const start = source.indexOf(startText);
  if (start === -1) throw new Error(`missing block starting with ${JSON.stringify(startText)}`);
  const openBrace = source.indexOf("{", start);
  if (openBrace === -1) throw new Error(`no opening brace after ${JSON.stringify(startText)}`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`unterminated block starting with ${JSON.stringify(startText)}`);
}

// Splits a flat (non-nested) block of CSS into { selectors, body } rules, so a
// rule can be looked up by its exact, single selector regardless of property
// order or intervening comments.
function parseFlatRules(block: string): { selectors: string[]; body: string }[] {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { selectors: string[]; body: string }[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(withoutComments))) {
    rules.push({
      selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean),
      body: match[2],
    });
  }
  return rules;
}

function bodyForExactSelector(rules: { selectors: string[]; body: string }[], selector: string): string {
  const rule = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === selector);
  if (!rule) throw new Error(`no standalone rule found for selector ${JSON.stringify(selector)}`);
  return rule.body;
}

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

  it("uses the one Press easing curve exactly once and no other cubic-bezier", () => {
    const curves = css.match(/cubic-bezier\([^)]*\)/g) ?? [];
    // Asserting the raw (non-deduplicated) match list catches both a second,
    // differing curve AND the same curve pasted in literally a second time
    // instead of referenced via var(--press-ease).
    expect(curves).toEqual(["cubic-bezier(0.22, 1, 0.36, 1)"]);
  });

  it("squares corners by default", () => {
    expect(css).toMatch(/--press-radius:\s*0/);
  });

  it("honours prefers-reduced-motion", () => {
    expect(css).toContain("prefers-reduced-motion");
  });

  it("prefers-reduced-motion restores the finished state, never invisible content", () => {
    const reducedMotionBody = extractBlockBody(css, "@media (prefers-reduced-motion: reduce)");
    const rules = parseFlatRules(reducedMotionBody);

    const ruleBody = bodyForExactSelector(rules, ".press-rule");
    expect(ruleBody).toMatch(/transform:\s*scaleX\(1\)/);

    const ruleAxisYBody = bodyForExactSelector(rules, '.press-rule[data-axis="y"]');
    expect(ruleAxisYBody).toMatch(/transform:\s*scaleY\(1\)/);

    const crossBody = bodyForExactSelector(rules, ".press-cross");
    expect(crossBody).toMatch(/opacity:\s*0\.9/);
    expect(crossBody).toMatch(/transform:\s*scale\(1\)/);
  });
});
