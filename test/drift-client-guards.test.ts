import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The drift client ships as raw files out of public/drift/ — no build step, no
// module graph a unit test can reach. Everything it promises about ITSELF
// (textContent over innerHTML, reduced motion, touch targets, dvh, never
// blocking) is only a comment unless something reads the files off disk and
// checks. Same shape as test/board-client-guards.test.ts.

const DIR = new URL("../public/drift/", import.meta.url);
const scripts = readdirSync(DIR)
  .filter((n) => n.endsWith(".js"))
  .sort()
  .map((name) => ({ name, source: readFileSync(new URL(name, DIR), "utf8") }));
const css = readFileSync(new URL("styles.css", DIR), "utf8");
const html = readFileSync(new URL("index.html", DIR), "utf8");

/** Lines that are not comments — so a rule can be DISCUSSED in a docstring
 *  without the sweep reading the discussion as a violation. */
function liveLines(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

describe("drift scripts build DOM safely", () => {
  it("never assigns innerHTML — model output is untrusted input", () => {
    for (const { name, source } of scripts) {
      expect(liveLines(source).filter((l) => /\binnerHTML\b/.test(l)), `${name} uses innerHTML`).toEqual([]);
    }
  });

  it("never reads an embedding off the wire", () => {
    for (const { name, source } of scripts) {
      expect(liveLines(source).filter((l) => /\bembedding\b/.test(l)), `${name} touches embeddings`).toEqual([]);
    }
  });
});

describe("the swipe path never blocks", () => {
  it("keeps await out of the gesture handler", () => {
    // A swipe must resolve from the resident set. Pool depth is a correctness
    // requirement, not an optimization (CLAUDE.md).
    const drift = scripts.find((s) => s.name === "drift.js");
    expect(drift, "drift.js is missing").toBeTruthy();
    const body = drift!.source.match(/function onSwipe\([\s\S]*?\n}/);
    expect(body, "onSwipe not found — rename the handler or update this guard").toBeTruthy();
    expect(liveLines(body![0]).filter((l) => /\bawait\b/.test(l))).toEqual([]);
  });
});

describe("drift styles honour prefers-reduced-motion", () => {
  it("declares a reduced-motion block that removes animation and transition", () => {
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx, "no reduced-motion block").toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}\n}", idx) + 3);
    expect(block, "reduced motion does not remove animation").toMatch(/animation:\s*none/);
    expect(block, "reduced motion does not remove transition").toMatch(/transition:\s*none/);
  });
});

describe("drift meets the mobile floor", () => {
  it("uses dvh rather than bare vh", () => {
    // \b does NOT sit between "0" and "d", so /\bdvh\b/ never matches 100dvh.
    // Anchor on the digits instead. The bare-vh probe is fine as written:
    // \d+vh cannot match 100dvh because of the intervening "d".
    expect(css.match(/\b\d+vh\b/), "bare vh found; use dvh").toBeNull();
    expect(css, "no dvh unit found").toMatch(/\d+dvh\b/);
  });

  it("declares viewport-fit=cover and uses safe-area insets", () => {
    expect(html).toMatch(/viewport-fit=cover/);
    expect(css).toMatch(/safe-area-inset/);
  });

  it("declares no tap target under 44px", () => {
    const sizes = [...css.matchAll(/min-(?:width|height):\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length, "no min-width/min-height declared at all").toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(44);
  });

  it("never allows horizontal scroll", () => {
    expect(css).toMatch(/overflow-x:\s*hidden/);
  });
});

describe("drift styles cannot collide with the other surfaces", () => {
  it("scopes every rule to .drift-surface", () => {
    // The field's styles.css, press.css and the board's sheet are different
    // surfaces. An unscoped selector here would leak across all of them.
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((chunk) => chunk.split("{")[0]!.trim())
      .filter((s) => s && !s.startsWith("@") && !/^\d+%$/.test(s) && s !== "from" && s !== "to");
    for (const sel of selectors) {
      for (const part of sel.split(",")) {
        const t = part.trim();
        if (!t || t.startsWith(":root")) continue;
        expect(t, `unscoped selector: ${t}`).toMatch(/\.drift-surface/);
      }
    }
  });

  it("does not load the field's or the board's stylesheet", () => {
    // Match an actual <link>, not a mention. The file's own header comment
    // explains WHY it does not inherit press.css, and a bare substring probe
    // reads that explanation as the violation it is warning against.
    const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]!);
    expect(links.filter((h) => /press\.css$/.test(h)), "loads press.css").toEqual([]);
    expect(links.filter((h) => /^\/styles\.css$/.test(h)), "loads the field's styles.css").toEqual([]);
  });
});
