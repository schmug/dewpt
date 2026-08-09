import { describe, expect, it } from "vitest";

// Route topology (spec: docs/superpowers/specs/2026-08-09-night-walk-landing-design.md):
// the night walk is the landing page at /, the field app lives at /app/, the
// board at /board/, and each surface links to the others. Assets are served
// straight from public/, so the topology IS the file layout — this suite pins
// it so a future shuffle fails CI instead of silently orphaning a page.
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");

describe("landing page (/) is the night walk", () => {
  const html = read("index.html");

  it("carries the night-walk chrome, not the field app", () => {
    expect(html).toContain('id="rail"'); // chapter rail
    expect(html).toContain("night walk");
    expect(html).not.toContain('src="/app.js"');
  });

  it("links forward to the field and the board", () => {
    expect(html).toContain('href="/app/"');
    expect(html).toContain('href="/board/"');
  });
});

describe("field app lives at /app/", () => {
  const html = read("app/index.html");

  it("is the field app", () => {
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('id="seedForm"');
  });

  it("links back to the night walk", () => {
    expect(html).toContain('href="/"');
  });
});

describe("board links back", () => {
  const html = read("board/index.html");

  it("links to the night walk landing", () => {
    expect(html).toContain('href="/"');
  });
});

describe("PWA manifest", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));

  it("opens installed apps at the field, not the walk", () => {
    expect(manifest.start_url).toBe("/app/");
  });

  it("keeps install identity and scope at the root", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.scope).toBe("/");
  });
});
