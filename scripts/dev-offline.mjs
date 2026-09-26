// `wrangler dev` with fake AI and no remote bindings, for screenshots and UI
// checks that must not spend Workers AI requests. Writes a copy of
// wrangler.jsonc without the `ai` block to .wrangler/wrangler.offline.jsonc
// (gitignored) and runs wrangler against it with DEV_FAKE_AI=1.
//
// Why not the plan's `echo DEV_FAKE_AI=1 > .dev.vars` recipe: on a machine with
// real secrets in .dev.vars that overwrites them. Wrangler reads .dev.vars from
// the config's directory, so a config under .wrangler/ never sees the real one.
// No `ai` block also means no remote-proxy session, so neither Cloudflare Access
// nor WARP is involved.
//
//   node scripts/dev-offline.mjs [port]      (.claude/launch.json: "dewpt-offline")

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const port = process.argv[2] ?? "8790";
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
delete config.ai;
delete config.$schema;
config.main = `../${config.main}`;
if (config.assets?.directory) config.assets.directory = `../${config.assets.directory.replace(/^\.\//, "")}`;
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/wrangler.offline.jsonc", JSON.stringify(config, null, 2));

const child = spawn("npx", ["wrangler", "dev", "-c", ".wrangler/wrangler.offline.jsonc", "--var", "DEV_FAKE_AI:1", "--port", port], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
