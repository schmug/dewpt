import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/press.css", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

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

describe("styles.css press-go entrance gate (task 6)", () => {
  it("prefers-reduced-motion restores header/#controls/#tray to the finished, static state", () => {
    // The entrance-gate override sits in the first
    // `@media (prefers-reduced-motion: reduce)` block in public/styles.css
    // (right after the header/#controls/#tray transition rule it degrades).
    // extractBlockBody grabs the first match by design, same as the
    // press.css test above — if this rule ever moves to a later block in the
    // file, this test fails loudly (selector not found) rather than quietly
    // passing against the wrong block.
    const reducedMotionBody = extractBlockBody(stylesCss, "@media (prefers-reduced-motion: reduce)");
    const rules = parseFlatRules(reducedMotionBody);

    // header/#controls/#tray are declared together as one comma-joined
    // selector list (not one rule per selector), so bodyForExactSelector's
    // single-selector match doesn't apply — find the rule that covers all
    // three instead.
    const rule = rules.find(
      (r) => r.selectors.includes("header") && r.selectors.includes("#controls") && r.selectors.includes("#tray"),
    );
    expect(rule, "no combined header/#controls/#tray rule inside the reduced-motion block").toBeDefined();
    expect(rule!.body).toMatch(/opacity:\s*1\b/);
    expect(rule!.body).toMatch(/transform:\s*none/);
    expect(rule!.body).toMatch(/transition:\s*none/);
  });
});

describe("styles.css field/frame stacking (issue #37)", () => {
  const rules = parseFlatRules(stylesCss);

  it("#field establishes its own stacking context, so no word can interleave with the frame", () => {
    // Without this, #field is position:relative/z-index:auto — not a stacking
    // context — so every .word inside it competes directly with the frame's
    // z-index:2 rules and z-index:3 corner marks in the root context.
    // `.word.pinned{z-index:3}` ties with `.press-cross` and wins on DOM order,
    // while an ordinary word loses: two answers for one spatial relationship.
    // Isolating the field collapses that to one — the frame is always chrome.
    expect(bodyForExactSelector(rules, "#field")).toMatch(/isolation:\s*isolate/);
  });

  it("pins crystallize above the drift, ordered only against sibling words", () => {
    // Inside the isolated field, .word.pinned is the one layer that declares a
    // z-index; every other in-field layer (.word, .pulse, .hint, #manifesto) is
    // auto. Any positive value works — what matters is that it is positive, and
    // that it is read as local to the field rather than as a rung on the
    // frame's ladder.
    const pinnedZ = /z-index:\s*(\d+)/.exec(bodyForExactSelector(rules, ".word.pinned"));
    expect(pinnedZ, ".word.pinned declares no z-index").not.toBeNull();
    expect(Number(pinnedZ![1])).toBeGreaterThan(0);
    expect(bodyForExactSelector(rules, ".word")).not.toMatch(/z-index/);
  });

  it("keeps the frame click-through, so prospecting clicks reach #field", () => {
    // The field's own click handler is how a user prospects. The frame overlays
    // its edges and corners, so it must never take a hit.
    expect(bodyForExactSelector(rules, "#fieldFrame .press-rule")).toMatch(/pointer-events:\s*none/);
    expect(bodyForExactSelector(rules, "#fieldFrame .press-cross")).toMatch(/pointer-events:\s*none/);
  });

  it("holds #field's desktop box, which spawnPick measures on every spawn", () => {
    // field.js reads getBoundingClientRect() per spawn and places words against
    // rect.width/rect.height, so a change to this box silently misplaces the
    // whole field — the failure the isolation fix had to avoid causing. These
    // are the values measured in the browser: 960x480 at desktop.
    const fieldBody = bodyForExactSelector(rules, "#field");
    expect(fieldBody).toMatch(/(?<!max-)width:\s*100%/);
    expect(fieldBody).toMatch(/max-width:\s*960px/);
    expect(fieldBody).toMatch(/(?<!max-|min-)height:\s*480px/);
    expect(fieldBody).toMatch(/overflow:\s*hidden/);
  });

  it("holds #field's narrow-viewport height", () => {
    // Below 760px the field fills the phone instead of letterboxing; measured
    // at 335x560 in a 375px-wide viewport.
    const narrowRules = parseFlatRules(extractBlockBody(stylesCss, "@media (max-width: 760px)"));
    expect(bodyForExactSelector(narrowRules, "#field")).toMatch(/height:\s*min\(70svh,\s*560px\)/);
  });
});
