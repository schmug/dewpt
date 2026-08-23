import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // dewpt has no vite build — wrangler serves public/ as static assets and
  // vitest is the only thing that ever loads vite. Left at its default, vite
  // treats public/ as publicDir and REFUSES to import from it, which blocks the
  // controller tests from loading the very modules they exist to exercise.
  publicDir: false,
  // public/drift/drift.js imports the shared axis client as "/axes.js", which is
  // how the browser resolves it against the assets root. Under vitest the root
  // is the repo, so that path does not exist. Aliasing it lets the controller
  // tests exercise the REAL client rather than a mock of it — the point of
  // those tests is that declarations and behaviour had diverged.
  resolve: {
    alias: [{ find: "/axes.js", replacement: fileURLToPath(new URL("./public/axes.js", import.meta.url)) }],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
