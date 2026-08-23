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

  it("uses textContent somewhere, so cards are actually rendered the safe way", () => {
    expect(scripts.some((s) => /\btextContent\b/.test(s.source))).toBe(true);
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
  it("degrades to a CROSSFADE, not to no motion at all", () => {
    // SPEC.md asks for fade-only, which means the fade survives. The earlier
    // guard asserted `transition: none`, so it happily passed an implementation
    // that removed the fade and made cards snap. Critic cycle 1.
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx, "no reduced-motion block").toBeGreaterThan(-1);
    const block = css.slice(idx);
    expect(block, "animation is not disabled").toMatch(/animation:\s*none/);
    expect(block, "the opacity fade was removed instead of kept").toMatch(/transition:\s*opacity/);
    expect(block, "transform motion is not suppressed").toMatch(/transform:\s*none/);
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

  it("gives the card itself a hit box", () => {
    // The card is a div[role=button] and was excluded from every audit — source
    // and browser alike — while being the surface's primary control.
    // A px literal is the wrong assertion: the card is sized in dvh, and
    // demanding px here is what led to a second min-height being added to the
    // same rule, where it silently won and collapsed the card to a 44px band.
    // The REAL check is the browser audit in scripts/ui-smoke.mjs, which
    // measures rendered targets at >= 44px including [role=button]. This only
    // pins that a floor is declared at all.
    const cardRule = css.slice(css.indexOf(".drift-surface .drift-card {"));
    const decl = cardRule.slice(0, cardRule.indexOf("}"));
    expect(decl, "the card declares no minimum size").toMatch(/min-height:\s*\S+/);

    // NO PROPERTY MAY BE DECLARED TWICE IN THIS RULE. Two separate bugs came
    // from exactly this: a stale `min-height: 44px` collapsed the card to a
    // band, and a stale `background: none` left over from when the card was
    // bare text made its fill fully transparent — in both cases the later
    // declaration silently beat the intended one, and the surface looked
    // plausible enough that only a screenshot caught it. Checking the general
    // shape rather than the two properties that happened to break.
    const props = [...decl.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]!);
    const dupes = props.filter((x, i) => props.indexOf(x) !== i);
    expect([...new Set(dupes)], "duplicated declarations in .drift-card").toEqual([]);
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

describe("drift styles keep [hidden] working", () => {
  it("declares a [hidden] override that beats its own display rules", () => {
    // .drift-setup / .drift-axes / .drift-stage / the condensate panel all set
    // an explicit display, which overrides the UA's [hidden] { display: none }.
    // Without an override, el.hidden = true changes nothing on screen.
    expect(css, "no [hidden] override — hidden elements will still render")
      .toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
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
        if (!t) continue;
        expect(t, `unscoped selector: ${t}`).toMatch(/\.drift-surface/);
      }
    }
  });

  it("defines no design tokens on a global :root", () => {
    // The previous version of this suite SKIPPED :root, which is precisely how
    // a global token block shipped under a "fully scoped" claim. A :root here
    // would leak this palette to any page that loads the sheet. Critic cycle 1.
    expect(css.match(/(^|\})\s*:root\b/), "tokens defined on a global :root").toBeNull();
    expect(css, "tokens are not on .drift-surface").toMatch(/\.drift-surface\s*\{[^}]*--t0:/);
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

describe("the compass recommends measured pairs, and the gesture plane is real", () => {
  const drift = scripts.find((s) => s.name === "drift.js")!;

  it("suggests only pairs that cleared the lexical ceiling", () => {
    // npm run axis-power ranked nine pairs by judge AUC across three seeds
    // against an X / more X control at 0.713. These four cleared it or carry a
    // stronger prior; the rest must not be offered.
    for (const pair of ["natural", "calm", "practical", "concrete"]) {
      expect(drift.source, `${pair} is not suggested`).toMatch(new RegExp(`neg: '${pair}'`));
    }
  });

  it("does not suggest solemn/playful, which ranked last", () => {
    // 0.597 against a 0.713 ceiling, consistent across every run. It was this
    // surface's placeholder example everywhere, which is exactly why it needs
    // a guard rather than a memory.
    expect(drift.source).not.toMatch(/neg: 'solemn'/);
    expect(html, "solemn is still a placeholder in the markup").not.toMatch(/placeholder="solemn"/);
  });

  it("claims the gesture plane so vertical swipes are not eaten by the browser", () => {
    // Up and down did nothing on a phone: both touch listeners were passive, so
    // preventDefault was impossible and the browser took every vertical gesture
    // as scroll or pull-to-refresh. All three parts are load-bearing.
    expect(css, "no touch-action on the deck").toMatch(/\.drift-deck[^}]*touch-action:\s*none/s);
    expect(css, "no overscroll-behavior guard").toMatch(/overscroll-behavior:\s*none/);
    // Scoped to the touchmove registration itself rather than a character
    // window, which would silently pass or fail on how long the comment is.
    const start = drift.source.indexOf("addEventListener('touchmove'");
    expect(start, "no touchmove listener at all").toBeGreaterThan(-1);
    const block = drift.source.slice(start, drift.source.indexOf("});", start) + 3);
    expect(block, "touchmove is passive, so it cannot preventDefault")
      .toMatch(/passive:\s*false/);
    expect(block, "touchmove never prevents the default").toMatch(/preventDefault/);
  });

  it("draws a stack, and the stack drifts", () => {
    expect(html, "no ghost cards behind the top card").toMatch(/drift-ghost/);
    expect(css, "nothing in this surface actually drifts").toMatch(/@keyframes drift-wander/);
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(css.slice(idx), "the ghosts keep animating under reduced motion")
      .toMatch(/drift-ghost-1\s*\{[^}]*animation:\s*none/s);
  });
});

describe("the card is thrown, and the card below says where", () => {
  const drift = scripts.find((s) => s.name === "drift.js")!;

  it("the card carries its own surface, so it is the thing that moves", () => {
    // It had none: only the ghosts had a background and border, so what looked
    // like the top card was ghost-1 and a swipe appeared to move only the text.
    const block = css.slice(css.indexOf(".drift-surface .drift-card {"));
    const decl = block.slice(0, block.indexOf("}"));
    // Assert the INTENT, not a token name. The first version pinned
    // var(--field) and broke the moment the palette was retuned, which would
    // train someone to edit the guard rather than think about it.
    expect(decl, "the card has no fill of its own").toMatch(/background:\s*var\(--[\w-]+\)/);
    // The edge is the measured boundary — test/contrast.test.ts holds it to the
    // 3:1 WCAG 1.4.11 bar — so the card must actually use it.
    expect(decl, "the card does not use the measured boundary colour")
      .toMatch(/border:\s*1px solid var\(--card-edge\)/);
    expect(decl, "the card has no lift off the stack").toMatch(/box-shadow:/);
  });

  it("the ghosts do not use the card's boundary colour", () => {
    // If they did, all three layers would read as equals and the top of the
    // stack would stop being obviously the thing you touch.
    const g = css.slice(css.indexOf(".drift-surface .drift-ghost {"));
    expect(g.slice(0, g.indexOf("}")), "a ghost is drawn with the card's edge")
      .not.toMatch(/var\(--card-edge\)/);
  });

  it("the drag transforms the card element itself", () => {
    const start = drift.source.indexOf("addEventListener('touchmove'");
    const block = drift.source.slice(start, drift.source.indexOf("});", start));
    expect(block, "the drag does not move the card").toMatch(/els\.card\.style\.transform/);
  });

  it("a drag names the pole it is heading for", () => {
    expect(drift.source, "no bearing is shown during a drag").toMatch(/showBearing/);
    expect(html, "no bearing element on the card below").toMatch(/id="drift-bearing"/);
    // The bearing must use the SAME dominant-axis rule as touchend, or it
    // promises one direction and the release delivers another.
    const fn = drift.source.slice(drift.source.indexOf("function showBearing"));
    expect(fn.slice(0, fn.indexOf("\n}")), "bearing does not pick the axis the same way")
      .toMatch(/Math\.abs\(dx\)\s*>=\s*Math\.abs\(dy\)/);
  });

  it("clears the bearing when the thumb leaves", () => {
    for (const ev of ["touchend", "touchcancel"]) {
      const start = drift.source.indexOf(`addEventListener('${ev}'`);
      const block = drift.source.slice(start, drift.source.indexOf("});", start));
      expect(block, `${ev} leaves the bearing showing`).toMatch(/clearBearing/);
    }
  });

  it("reduced motion keeps direct manipulation but drops the decoration", () => {
    // A drag is the card under the thumb. Removing it would break the gesture
    // rather than calm it, so only the idle wander and the tilt go.
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(css.slice(idx), "the reduced-motion rule would fight an active drag")
      .toMatch(/drift-card:not\(\[style\*='translate'\]\)/);
  });
});

describe("the stylesheet does not shadow itself", () => {
  it("declares no selector's base state twice", () => {
    // A stale .drift-ghost-1 rule survived an edit that was meant to replace it,
    // so the ghosts kept their old offsets while the reduced-motion override
    // and the keyframes moved to new ones. Nothing failed; the surface just
    // quietly rendered the wrong thing. Base-state rules only — attribute and
    // media variants are legitimately repeated.
    const base = [...css.matchAll(/^(\.drift-surface\s+\.[\w-]+)\s*\{/gm)].map((m) => m[1]!);
    const dupes = base.filter((x, i) => base.indexOf(x) !== i);
    expect([...new Set(dupes)], "selector declared twice at base state").toEqual([]);
  });
});
