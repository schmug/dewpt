import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Press adoption gate (issue #36). #35 converted five label sites and squared
// their corners; the about/legend/evaporated surfaces were deferred. This
// suite is what stops the interface drifting back into two label recipes and
// two corner treatments — it asserts the sweep is complete *and* that no
// ID-selectored rule re-declares a property .press-label already supplies.
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const pressCss = readFileSync(new URL("../public/press.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/app/index.html", import.meta.url), "utf8");

/**
 * Every `selector { body }` rule in a stylesheet, comments stripped.
 *
 * The inner-rule regex cannot span a brace, so rules nested inside an @media
 * block are returned under their own selector and the @media wrapper is
 * dropped. That is what we want here: a `border-radius` or a `font-size`
 * overrides its base rule wherever it is declared, so the checks below have
 * to see the media-query copies too.
 */
function rules(source: string): { selectors: string[]; body: string }[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string[]; body: string }[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(withoutComments))) {
    out.push({
      selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean),
      body: match[2],
    });
  }
  return out;
}

/** Declared values of `property` across every rule matching `selector`. */
function declarations(source: string, selector: string, property: string): string[] {
  const found: string[] = [];
  for (const rule of rules(source)) {
    if (!rule.selectors.includes(selector)) continue;
    const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(rule.body))) found.push(m[1].trim());
  }
  return found;
}

/** The markup of the element carrying `idAttr`, from its `<tag` to `closer`. */
function element(idAttr: string, closer: string): string {
  const from = html.lastIndexOf("<", html.indexOf(idAttr));
  expect(from, `no element carrying ${idAttr}`).toBeGreaterThan(-1);
  const to = html.indexOf(closer, from);
  expect(to, `unterminated element carrying ${idAttr}`).toBeGreaterThan(-1);
  return html.slice(from, to);
}

// Legitimate non-rectangles: pills and circles keep the radius that makes them
// the shape they are. Everything else in the sheet is a rectangle and must
// take the Press token. Adding an entry here is a design decision, not a
// mechanical fix — that is the point of listing them by exact selector.
const NON_RECTANGLES: Record<string, string> = {
  ".chip": "999px", // pill
  ".pulse": "50%", // the prospect ring
  "#legendBtn": "50%", // circular ? glyph
  "#aboutBtn .q": "50%", // circular ? glyph
  "input[type=range]": "2px", // 2px-tall track, so a pill
  "input[type=range]::-webkit-slider-thumb": "50%",
  "input[type=range]::-moz-range-thumb": "50%",
};

// The five sites this issue converts. Each must (a) carry .press-label in the
// markup and (b) declare none of the recipe's properties itself.
const CONVERTED_SITES = ["#legend dt", "#about dt", "#about h2", "#about h3", "#aboutBtn"];

// Properties .press-label supplies. An ID-selectored rule that re-declares any
// of them wins on specificity ((1,0,x) beats (0,1,0)) no matter what order the
// two stylesheets load in — the exact bug that shipped in #35. The fix is
// always to delete the competing declaration, never to add a louder one.
const RECIPE_PROPS = ["font-family", "font-size", "letter-spacing", "text-transform"];

describe("Press label recipe (issue #36)", () => {
  it(".press-label supplies the whole recipe, so consumers need declare none of it", () => {
    const label = rules(pressCss).find((r) => r.selectors.length === 1 && r.selectors[0] === ".press-label");
    expect(label, "no standalone .press-label rule in press.css").toBeDefined();
    for (const prop of RECIPE_PROPS) {
      expect(label!.body, `.press-label does not set ${prop}`).toMatch(new RegExp(`${prop}\\s*:`));
    }
  });

  it.each(CONVERTED_SITES)("%s declares nothing that would out-specify .press-label", (selector) => {
    for (const prop of RECIPE_PROPS) {
      expect(
        declarations(css, selector, prop),
        `${selector} re-declares ${prop}; delete it and let .press-label supply it`,
      ).toEqual([]);
    }
  });

  it("applies press-label to the about toggle and both of its headings", () => {
    expect(element('id="aboutBtn"', ">")).toContain("press-label");
    expect(element('id="aboutTitle"', ">")).toContain("press-label");
    const about = element('id="about"', "</aside>");
    expect(about).toMatch(/<h3 class="press-label">/);
  });

  it.each([
    ["#about", 'id="about"', "</aside>"],
    ["#legend", 'id="legend"', "</div>"],
  ])("applies press-label to every <dt> in %s", (_name, idAttr, closer) => {
    const markup = element(idAttr, closer);
    const terms = markup.match(/<dt[^>]*>/g) ?? [];
    expect(terms.length).toBeGreaterThan(0);
    for (const dt of terms) expect(dt).toContain("press-label");
  });

  it("leaves the definitions themselves as body copy, not labels", () => {
    // Only the term is furniture. If <dd> ever picks up the class the glosses
    // become tracked uppercase mono and the panel is unreadable.
    for (const [idAttr, closer] of [['id="about"', "</aside>"], ['id="legend"', "</div>"]] as const) {
      for (const dd of element(idAttr, closer).match(/<dd[^>]*>/g) ?? []) {
        expect(dd).not.toContain("press-label");
      }
    }
  });

  it("resets tracking inside the circular ? glyph so it stays centred", () => {
    // .q inherits .press-label's 0.2em from #aboutBtn, which would add a
    // trailing 2px inside an 18px box and push the glyph off centre. Same
    // reset, same reason, as `.ctl label span`.
    expect(declarations(css, "#aboutBtn .q", "letter-spacing")).toEqual(["0"]);
  });
});

describe("Press squares its corners (issue #36)", () => {
  it("gives every rectangle var(--press-radius) and every non-rectangle its own shape", () => {
    const seen = new Set<string>();
    for (const rule of rules(css)) {
      const radius = rule.body.match(/(?:^|;)\s*border-radius\s*:\s*([^;]+)/);
      if (!radius) continue;
      const value = radius[1].trim();
      for (const selector of rule.selectors) {
        seen.add(selector);
        const exempt = NON_RECTANGLES[selector];
        expect(
          value,
          exempt
            ? `${selector} is an exempt non-rectangle and should stay ${exempt}`
            : `${selector} is a rectangle and must take var(--press-radius), not ${value}`,
        ).toBe(exempt ?? "var(--press-radius)");
      }
    }
    // A stale exemption is as much a drift as a missed conversion: if a
    // selector leaves the sheet, its entry must leave this list with it.
    for (const selector of Object.keys(NON_RECTANGLES)) {
      expect(seen, `${selector} is exempted here but declares no border-radius`).toContain(selector);
    }
  });

  it.each(["#evaporated", "#legend", "#about", "#aboutBtn"])(
    "%s — the surfaces #35 deferred — is squared",
    (selector) => {
      expect(declarations(css, selector, "border-radius")).toEqual(["var(--press-radius)"]);
    },
  );
});
