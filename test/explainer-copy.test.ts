import { describe, expect, it } from "vitest";

// The explainer surfaces (issues #11/#12) are static markup in
// public/app/index.html; this suite pins the copy the acceptance criteria name so
// a rewording that drops a required line fails CI.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/app/index.html", import.meta.url), "utf8");

/** The #about aside's markup, from its opening tag to its closing </aside>. */
function aboutSection(): string {
  const from = html.indexOf('id="about"');
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, html.indexOf("</aside>", from));
}

describe("pre-seed manifesto (issue #11)", () => {
  it("carries both manifesto lines from docs/explainer-research.md", () => {
    expect(html).toContain(
      "words condense out of latent space — they linger, then evaporate.",
    );
    expect(html).toContain("pin the ones that catch you; the rest is weather.");
  });

  it("mirrors the manifesto for assistive tech outside role=application", () => {
    expect(html).toContain('id="manifestoSr"');
    const sr = html.slice(html.indexOf('id="manifestoSr"'));
    expect(sr).toContain("words condense out of latent space");
  });

  it("leaves the bottom hint line and its copy alone (belongs to #7/#9)", () => {
    expect(html).toContain("enter a seed to begin condensation");
    expect(html).toContain('id="fieldHint"');
  });
});

describe('"? what is this?" about panel (issue #12)', () => {
  it("has a keyboard-operable header toggle with disclosure semantics", () => {
    const from = html.indexOf('id="aboutBtn"');
    expect(from).toBeGreaterThan(-1);
    const btn = html.slice(from, html.indexOf(">", from));
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-controls="about"');
    expect(html.slice(from)).toContain("what is this?");
  });

  it("carries the concept paragraph, ephemerality framing, and the name origin", () => {
    const about = aboutSection();
    expect(about).toContain("an ambient ideation canvas");
    expect(about).toContain("ephemerality is the point");
    expect(about).toContain("play, not productivity");
    expect(about).toContain("meteorological abbreviation for dew point");
  });

  it("glosses the full weather vocabulary without renaming it", () => {
    const about = aboutSection();
    // Matched with an open attribute list: this suite pins the *copy* and the
    // element it sits in, not the styling. The terms carry class="press-label"
    // since issue #36; test/press-adoption.test.ts is what gates that.
    for (const term of ["dewpoint", "altitude", "drizzle", "condensate", "evaporated"]) {
      expect(about).toMatch(new RegExp(`<dt[^>]*>${term}</dt>`));
    }
    expect(about).toMatch(/<dt[^>]*>condense \/ evaporate<\/dt>/);
    expect(about).toContain("how strange the words get");
  });

  it("links the kevin kelly credit", () => {
    const about = aboutSection();
    expect(about).toContain(
      'href="https://kevinkelly.substack.com/p/latent-space-as-a-new-medium"',
    );
    expect(about).toContain("latent space as a new medium");
  });
});
