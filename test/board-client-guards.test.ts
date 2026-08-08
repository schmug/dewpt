import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The board client ships as raw files out of public/board/ — no build step, no
// module graph a unit test can reach. Everything it promises about *itself*
// (textContent over innerHTML, reduced motion, touch targets, dvh) is therefore
// only ever a comment unless something reads the files off disk and checks.
// That is what this suite is, in the same shape as test/press-tokens.test.ts
// and test/press-adoption.test.ts. test/board-render.test.ts covers the layout
// maths; this covers the claims.

const BOARD_DIR = new URL("../public/board/", import.meta.url);

const scriptNames = readdirSync(BOARD_DIR)
  .filter((name) => name.endsWith(".js"))
  .sort();

const scripts = scriptNames.map((name) => ({
  name,
  source: readFileSync(new URL(name, BOARD_DIR), "utf8"),
}));

const css = readFileSync(new URL("styles.css", BOARD_DIR), "utf8");

// ── JS source scanning ──────────────────────────────────────────────────────

/**
 * Index-aligned mask of `source`: true wherever the character sits inside a
 * `//` line comment or a block comment. String and template literals are
 * tracked so a `//` inside a URL is not mistaken for a comment.
 *
 * Regex literals are deliberately not modelled. A `/` only opens a comment
 * when the very next character is `/` or `*`, and no regex begins that way in
 * practice. The failure mode of getting it wrong is marking live code as
 * commented — a false negative on a real sink — so if a regex literal ever
 * does start with `//` or `/*`, teach this helper about regex literals rather
 * than shrugging.
 */
function commentMask(source: string): boolean[] {
  const mask = new Array<boolean>(source.length).fill(false);
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") mask[i++] = true;
      continue;
    }
    if (char === "/" && next === "*") {
      const closer = source.indexOf("*/", i + 2);
      const stop = closer === -1 ? source.length : closer + 2;
      while (i < stop) mask[i++] = true;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return mask;
}

/** `pattern` matches that land in live code, reported as file:line + the line. */
function liveMatches(name: string, source: string, pattern: RegExp): string[] {
  const mask = commentMask(source);
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    if (mask[match.index]) continue;
    const line = source.slice(0, match.index).split("\n").length;
    const text = source.split("\n")[line - 1] ?? "";
    hits.push(`${name}:${line}  ${text.trim()}`);
  }
  return hits;
}

// Every way a string can become markup rather than text. Card text, station
// phrases and evaporated ghosts are all model output, which CLAUDE.md treats
// as untrusted input; belt-render.js builds DOM with textContent for exactly
// this reason and nothing but a check keeps it that way.
const HTML_SINKS: { label: string; pattern: RegExp }[] = [
  { label: "innerHTML", pattern: /\binnerHTML\b/ },
  { label: "outerHTML", pattern: /\bouterHTML\b/ },
  { label: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { label: "document.write", pattern: /\bdocument\s*\.\s*write\b/ },
  { label: "srcdoc", pattern: /\bsrcdoc\b/ },
  { label: "eval(", pattern: /\beval\s*\(/ },
  { label: "new Function", pattern: /\bnew\s+Function\b/ },
  { label: "createContextualFragment", pattern: /\bcreateContextualFragment\b/ },
];

describe("board client builds DOM as text, never as markup", () => {
  it("reads every script in public/board/", () => {
    // A rename or a move must not quietly empty the sweep below.
    expect(scriptNames).toEqual(expect.arrayContaining(["belt-model.js", "belt-render.js", "board.js"]));
  });

  it.each(HTML_SINKS)("uses no $label anywhere in the client", ({ pattern }) => {
    for (const { name, source } of scripts) {
      expect(liveMatches(name, source, pattern), `${name} reaches an HTML sink`).toEqual([]);
    }
  });

  it("writes card text through textContent", () => {
    const render = scripts.find((s) => s.name === "belt-render.js")!;
    expect(liveMatches(render.name, render.source, /\btextContent\b/).length).toBeGreaterThan(0);
  });

  it("ignores the comment that documents the rule, and only the comment", () => {
    // Positive control for commentMask. belt-render.js says "textContent,
    // never innerHTML" in a docstring; the sweep above must skip that line and
    // would be vacuous if it were skipping the whole file. This test fails if
    // the mask stops working (nothing to skip) *or* if someone deletes the
    // comment to appease the sweep — the comment is the documentation, and a
    // test that forces its removal is a worse test.
    const render = scripts.find((s) => s.name === "belt-render.js")!;
    expect(render.source, "the innerHTML docstring is gone").toMatch(/never innerHTML/);
    expect(liveMatches(render.name, render.source, /\binnerHTML\b/)).toEqual([]);
  });
});

// ── CSS source scanning ─────────────────────────────────────────────────────

/** Span of the brace-balanced block introduced by `startText`. */
function blockRange(source: string, startText: string): { start: number; open: number; close: number } {
  const start = source.indexOf(startText);
  if (start === -1) throw new Error(`missing block starting with ${JSON.stringify(startText)}`);
  const open = source.indexOf("{", start);
  if (open === -1) throw new Error(`no opening brace after ${JSON.stringify(startText)}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return { start, open, close: i };
    }
  }
  throw new Error(`unterminated block starting with ${JSON.stringify(startText)}`);
}

/** Bodies of every block introduced by `startText`, and the source without them. */
function partition(source: string, startText: string): { bodies: string[]; rest: string } {
  const bodies: string[] = [];
  let rest = source;
  while (rest.includes(startText)) {
    const { start, open, close } = blockRange(rest, startText);
    bodies.push(rest.slice(open + 1, close));
    rest = rest.slice(0, start) + rest.slice(close + 1);
  }
  return { bodies, rest };
}

/** `selector { body }` rules, comments stripped. Rules nested in an at-rule are
 *  returned under their own selector — the at-rule wrapper is dropped, same as
 *  test/press-adoption.test.ts, so callers strip the wrappers they care about. */
function parseRules(source: string): { selectors: string[]; body: string }[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string[]; body: string }[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(withoutComments))) {
    out.push({
      selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean),
      body: match[2]!,
    });
  }
  return out;
}

function bodyForExactSelector(source: string, selector: string): string {
  const rule = parseRules(source).find((r) => r.selectors.length === 1 && r.selectors[0] === selector);
  if (!rule) throw new Error(`no standalone rule found for selector ${JSON.stringify(selector)}`);
  return rule.body;
}

/** Declarations of a rule body, in source order. Order is the whole point for
 *  the fallback-pair check below. */
function declarations(body: string): { prop: string; value: string }[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const colon = chunk.indexOf(":");
      if (colon === -1) return [];
      return [{ prop: chunk.slice(0, colon).trim(), value: chunk.slice(colon + 1).trim() }];
    });
}

/** Leading px length of `prop`, or null when it is absent / not a px length. */
function pxLength(body: string, prop: string): number | null {
  const decl = declarations(body).find((d) => d.prop === prop);
  const px = decl && /^([0-9.]+)px$/.exec(decl.value);
  return px ? Number(px[1]) : null;
}

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
const MOVES = /(?:^|;)\s*(?:animation|transition)(?:-[a-z-]+)?\s*:/;

describe("board styles honour prefers-reduced-motion", () => {
  const { bodies: reducedBodies, rest: withoutReduced } = partition(css, REDUCED_MOTION);
  // Keyframe steps declare `transform`, not `animation`/`transition`, but drop
  // them anyway so the sweep below is about rules and only rules.
  const outsideBlock = partition(withoutReduced, "@keyframes").rest;

  it("declares a reduced-motion block that removes animation and transition", () => {
    expect(reducedBodies.length).toBeGreaterThan(0);
    const combined = reducedBodies.join("\n");
    expect(combined, "reduced motion does not remove animation").toMatch(/animation:\s*none/);
    expect(combined, "reduced motion does not remove transition").toMatch(/transition:\s*none/);
  });

  it("covers every animated selector, so a new one cannot slip past the block", () => {
    const animated = parseRules(outsideBlock)
      .filter((rule) => MOVES.test(rule.body))
      .flatMap((rule) => rule.selectors);
    // The board's drift IS the belt, so this is not decoration: an uncovered
    // animated selector is motion a reduced-motion user cannot turn off.
    expect(animated.length, "no animated selector found — this sweep would be vacuous").toBeGreaterThan(0);

    const covered = reducedBodies.flatMap((body) => parseRules(body));
    for (const selector of animated) {
      const rule = covered.find((r) => r.selectors.includes(selector));
      expect(rule, `${selector} animates but ${REDUCED_MOTION} never mentions it`).toBeDefined();
      expect(rule!.body, `${selector} keeps its animation under reduced motion`).toMatch(/animation:\s*none/);
      expect(rule!.body, `${selector} keeps its transition under reduced motion`).toMatch(/transition:\s*none/);
    }
  });
});

describe("board touch targets clear 44px", () => {
  it("gives the seed input a 44px minimum height", () => {
    // No min-width: the input is `flex: 1 1 auto` up to 320px, so its inline
    // size is set by the row, never by this rule. Height is the dimension a
    // stylesheet can shrink below the floor by accident.
    const body = bodyForExactSelector(css, ".board-surface .board-seed-input");
    expect(pxLength(body, "min-height"), "seed input declares no px min-height").not.toBeNull();
    expect(pxLength(body, "min-height")).toBeGreaterThanOrEqual(44);
  });

  it("gives the seed button 44px in both dimensions", () => {
    const body = bodyForExactSelector(css, ".board-surface .board-seed-button");
    for (const prop of ["min-height", "min-width"]) {
      expect(pxLength(body, prop), `seed button declares no px ${prop}`).not.toBeNull();
      expect(pxLength(body, prop), `seed button ${prop} is under the 44px floor`).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("board sizes itself in dvh", () => {
  it("measures the surface in 100dvh with 100vh only as the line above it", () => {
    // 100vh alone puts the seed row under the iOS URL bar. The vh line has to
    // stay as the pre-dvh fallback, and it only works as a fallback if the dvh
    // line for the same property follows it.
    expect(declarations(bodyForExactSelector(css, ".board-surface")).filter((d) => d.prop === "min-height"))
      .toEqual([
        { prop: "min-height", value: "100vh" },
        { prop: "min-height", value: "100dvh" },
      ]);
  });

  it("never leaves a bare 100vh as the last word on a property", () => {
    expect(css, "the sheet sizes nothing in dvh").toContain("100dvh");
    for (const rule of parseRules(css)) {
      const decls = declarations(rule.body);
      decls.forEach((decl, i) => {
        if (!decl.value.includes("100vh")) return;
        const where = `${rule.selectors.join(", ")} { ${decl.prop}: ${decl.value} }`;
        const next = decls[i + 1];
        expect(next, `${where} is a bare 100vh with nothing overriding it`).toBeDefined();
        expect(next!.prop, `${where} is followed by ${next!.prop}, not a dvh override`).toBe(decl.prop);
        expect(next!.value, `${where} is not followed by a 100dvh override`).toContain("100dvh");
      });
    }
  });
});
