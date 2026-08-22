#!/usr/bin/env node
/**
 * Independent-critic runner (template — scaffold as scripts/critic.mjs and
 * edit the CONFIG block; see the critic-gated-build skill).
 *
 * Per cycle: clean clone of committed HEAD → live-capture evidence bundle
 * (endpoint captures, gate evidence, smoke/E2E outputs, screenshots) →
 * critic CLI in a read-only sandbox with a fresh context → verdict JSON +
 * full transcript in critic-reports/.
 *
 * Usage: node scripts/critic.mjs <cycleNumber>
 * Exits 2 when no JSON verdict could be extracted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── CONFIG ──────────────────────────────────────────────────────────────
const BASE = "https://dewpt.cory7593.workers.dev";
const CAPTURE_PATHS = [
  ["/drift/", "drift-index.html.txt"],
  ["/drift/position.js", "drift-position.js.txt"],
  ["/drift/working-set.js", "drift-working-set.js.txt"],
  ["/drift/axis-lint.js", "drift-axis-lint.js.txt"],
  ["/drift/drift.js", "drift-drift.js.txt"],
  ["/drift/styles.css", "drift-styles.css.txt"],
  ["/", "landing.html.txt"],
];
const EVIDENCE = [
  { cmd: "node", args: ["scripts/smoke.mjs", BASE], file: "smoke-output.txt" },
  { cmd: "node", args: ["scripts/ui-smoke.mjs", BASE], file: "ui-smoke-output.txt" },
];
const COPY_DIRS = ["critic-reports/ui"];
const CLEANUP = null;  // sessions are per-DO and ephemeral; nothing to enumerate or delete
const CRITIC = { cmd: "codex", args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"] };

// The whole deployment sits behind Cloudflare Access — every path 302s without
// these. A bundle full of login redirects would read to the critic as a broken
// product, so this refuses to run rather than capture garbage. They are shell
// variables on this machine and are NOT exported by default.
const ACCESS = {
  "CF-Access-Client-Id": process.env.CLOUDFLARE_ACCESS_CLIENT_ID ?? "",
  "CF-Access-Client-Secret": process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET ?? "",
};
if (!ACCESS["CF-Access-Client-Id"] || !ACCESS["CF-Access-Client-Secret"]) {
  console.error("[critic] CLOUDFLARE_ACCESS_CLIENT_ID / _SECRET are required — every capture would be a 302 login page.");
  console.error("[critic] They are shell variables here; prefix the run with: export CLOUDFLARE_ACCESS_CLIENT_ID CLOUDFLARE_ACCESS_CLIENT_SECRET");
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────

const cycle = String(process.argv[2] ?? "0").padStart(2, "0");
const repoRoot = process.cwd();
const work = join(tmpdir(), `critic-${cycle}-${Date.now()}`);

execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${repoRoot}`, work]);

function tryRun(cmd, args, timeout = 300_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}\nEXITED NON-ZERO`;
  }
}

const cap = join(work, "live-capture");
mkdirSync(cap, { recursive: true });

// Gate evidence: the critic's sandbox has no network/node_modules — prove the
// gates ran on the exact revision under review.
const sha = tryRun("git", ["rev-parse", "HEAD"]).trim();
writeFileSync(
  join(cap, "gates.txt"),
  [
    `revision under review: ${sha}`,
    `\n$ npm run typecheck\n${tryRun("npm", ["run", "typecheck"])}`,
    `\n$ npm test\n${tryRun("npm", ["test"])}`,
    `\n$ gh run list (GitHub Actions CI)\n${tryRun("gh", ["run", "list", "--limit", "8"])}`,
    `\n$ git log --oneline -12\n${tryRun("git", ["log", "--oneline", "-12"])}`,
    // The sandbox has no network, so state the environment's own limits rather
    // than letting the critic infer them from absences.
    [
      "\n## environment notes for the critic",
      "- Your sandbox has no network and no node_modules. Everything you can verify",
      "  is in this checkout and in live-capture/.",
      "- The deployment sits behind Cloudflare Access; every capture in live-capture/",
      "  was fetched with service-token headers. A 302 anywhere would be a harness bug.",
      "- UI screenshots render in a FALLBACK FONT STACK. The smoke harness blocks",
      "  off-origin requests because Chromium has no egress on the build machine, so",
      "  the Google Fonts stylesheet never loads. Judge layout, colour and spacing;",
      "  do not judge typography.",
      "- Workstream B (docs/measurements/2026-08-22-workstream-b-null-result.md)",
      "  returned a NULL result on purpose. No cheap axis-legibility statistic has",
      "  power. Its absence from the shipped lint is a finding, not an omission.",
    ].join("\n"),
  ].join("\n"),
);

const timings = [];
for (const [path, name] of CAPTURE_PATHS) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { headers: ACCESS });
  const ms = Date.now() - t0;
  const body = await res.text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(
    join(cap, name),
    `# GET ${path}\n# status: ${res.status}  time: ${ms}ms\n\n## headers\n${headers}\n\n## body\n${body.slice(0, 60_000)}`,
  );
  timings.push({ path, status: res.status, ms, bytes: body.length });
}
writeFileSync(join(cap, "timings.json"), JSON.stringify(timings, null, 2));

for (const step of EVIDENCE) {
  writeFileSync(join(cap, step.file), tryRun(step.cmd, step.args, 600_000));
}
for (const dir of COPY_DIRS) {
  try {
    cpSync(dir, join(cap, dir.split("/").pop()), { recursive: true });
  } catch { /* optional */ }
}
if (CLEANUP) tryRun(CLEANUP.cmd, CLEANUP.args);

const prompt = readFileSync("scripts/critic-prompt.md", "utf8");
console.error(`[critic] cycle ${cycle}: running ${CRITIC.cmd} in ${work}`);
let out = "";
try {
  out = execFileSync(CRITIC.cmd, [...CRITIC.args, "--cd", work, "-"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    stdio: ["pipe", "pipe", "ignore"],
  });
} catch (err) {
  out = err.stdout ?? "";
  if (!out) throw err;
}

const blocks = [...out.matchAll(/```json\s*([\s\S]*?)```/g)];
let verdict = null;
for (let i = blocks.length - 1; i >= 0 && !verdict; i--) {
  try {
    verdict = JSON.parse(blocks[i][1]);
  } catch { /* try earlier block */ }
}

mkdirSync("critic-reports", { recursive: true });
writeFileSync(`critic-reports/cycle-${cycle}.md`, out);
if (verdict) {
  verdict.cycle = Number(cycle);
  verdict.capturedAt = new Date().toISOString();
  writeFileSync(`critic-reports/cycle-${cycle}.json`, JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
} else {
  console.error(`[critic] FAILED to extract JSON verdict — see critic-reports/cycle-${cycle}.md`);
  process.exit(2);
}
