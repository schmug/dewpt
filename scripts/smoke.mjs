#!/usr/bin/env node
// HTTP smoke for the deployed dewpt. Happy path plus adversarial probes,
// against the real Worker rather than a local dev server.
//
// Every request carries Cloudflare Access service-token headers: the whole
// deployment 302s without them, and a critic reading a bundle full of login
// redirects would correctly conclude the product is broken.
//
// Test data uses a reserved seed prefix so anything left behind is identifiable.
// Sessions are per-DO and ephemeral — there is nothing to enumerate and nothing
// to clean up — but the prefix costs nothing and makes residue obvious if the
// storage model ever changes.
//
//   node scripts/smoke.mjs https://dewpt.cory7593.workers.dev

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) { console.error("usage: node scripts/smoke.mjs <base-url>"); process.exit(1); }

const ID = process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
const SECRET = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
if (!ID || !SECRET) {
  console.error("set CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET");
  console.error("they are shell variables on this machine and are NOT exported by default");
  process.exit(1);
}
const H = { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET };
const SEED_PREFIX = "smoketest-";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
async function req(path, init = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json, ms: Date.now() - t0 };
}

console.log(`# HTTP smoke against ${BASE}\n`);

// ── surfaces ───────────────────────────────────────────────────────────────
console.log("## surfaces served");
for (const [path, needle] of [
  ["/", "night walk"], ["/app/", "seedForm"], ["/board/", "board-seed-input"],
  ["/drift/", 'id="drift-card"'],
]) {
  const r = await req(path);
  check(`GET ${path} -> 200 and looks like itself`, r.status === 200 && r.text.includes(needle),
        `status=${r.status}`);
}
for (const path of ["/drift/position.js", "/drift/working-set.js", "/drift/axis-lint.js", "/drift/drift.js", "/drift/styles.css"]) {
  const r = await req(path);
  check(`GET ${path} -> 200`, r.status === 200, `status=${r.status}`);
}

// ── access posture ─────────────────────────────────────────────────────────
console.log("\n## access posture");
{
  const res = await fetch(BASE + "/drift/", { redirect: "manual" });
  check("unauthenticated request does NOT serve the app", res.status !== 200, `status=${res.status}`);
}

// ── happy path ─────────────────────────────────────────────────────────────
console.log("\n## happy path: session -> axes -> pool -> pin");
const seed = `${SEED_PREFIX}public transit`;
const s = await req("/api/session", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ seed, dewpoint: 0.35, altitude: 0.25, drizzle: 0.5 }),
});
check("POST /api/session -> 201 with an id", s.status === 201 && !!s.json?.id, `status=${s.status}`);
const id = s.json?.id;

if (id) {
  const ax = await req(`/api/session/${id}/axes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ negTerm: "solemn", posTerm: "playful" }),
  });
  const axes = Array.isArray(ax.json?.axes) ? ax.json.axes : [];
  check("POST /axes -> 201", ax.status === 201, `status=${ax.status}`);
  check("axis has NESTED poles {term, phrase}", !!axes[0]?.neg?.phrase && !!axes[0]?.pos?.phrase);
  check("pole expansion produced a descriptive PHRASE, not the bare term",
        (axes[0]?.pos?.phrase ?? "").split(/\s+/).length > 1,
        `got "${axes[0]?.pos?.phrase}"`);

  await req(`/api/session/${id}/axes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ negTerm: "concrete", posTerm: "abstract" }),
  });

  // Generation is alarm-driven and asynchronous — the pool is EMPTY for the
  // first few seconds of a session. Drawing immediately and calling the empty
  // result a failure tests the harness's patience, not the product. This is the
  // same condition drift's enterStage handles with "nothing condensed yet".
  let pool = null;
  let served = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    pool = await req(`/api/session/${id}/pool?bucket=w0a0&count=30`);
    served = pool.json?.condensed ?? [];
    if (served.length > 0) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`  (pool filled after polling; n=${served.length})`);
  check("GET /pool -> 200 with candidates", pool.status === 200 && served.length > 0,
        `status=${pool.status} n=${served.length}`);
  check("served rows carry coords for both axes",
        served.length > 0 && served.every((c) => Array.isArray(c.coords) && c.coords.length === 2),
        `first coords=${JSON.stringify(served[0]?.coords)}`);
  check("NO embeddings on the wire (the 245 KB guard)",
        !("embedding" in (served[0] ?? {})) && !pool.text.includes('"embedding"'));
  check("axisIds travel with the words", Array.isArray(pool.json?.axisIds) && pool.json.axisIds.length === 2);

  if (served[0]) {
    const pin = await req(`/api/session/${id}/pin`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: served[0].text, tier: served[0].tier }),
    });
    check("POST /pin -> 200 and the anchor comes back",
          pin.status === 200 && Array.isArray(pin.json?.anchors) && pin.json.anchors.length > 0,
          `status=${pin.status}`);
  }

  console.log("\n## draws are destructive (server-side no-repeat guarantee)");
  const a = await req(`/api/session/${id}/pool?bucket=w0a1&count=10`);
  const b = await req(`/api/session/${id}/pool?bucket=w0a1&count=10`);
  const at = new Set((a.json?.condensed ?? []).map((c) => c.text));
  const overlap = (b.json?.condensed ?? []).filter((c) => at.has(c.text));
  check("a second draw never repeats the first", overlap.length === 0, `overlap=${overlap.length}`);
}

// ── adversarial ────────────────────────────────────────────────────────────
console.log("\n## adversarial");
{
  const r = await req("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ seed: "x".repeat(500) }),
  });
  check("oversized seed is rejected, not stored", r.status >= 400, `status=${r.status}`);
}
{
  const r = await req("/api/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: "not json at all",
  });
  check("malformed JSON body is rejected", r.status >= 400, `status=${r.status}`);
}
if (id) {
  const r = await req(`/api/session/${id}/pool?bucket=../../etc/passwd&count=5`);
  check("bogus bucket is rejected", r.status >= 400, `status=${r.status}`);
  const r2 = await req(`/api/session/${id}/pool?bucket=w0a0&count=99999`);
  const n = (r2.json?.condensed ?? []).length;
  check("draw count is capped, not honoured verbatim", r2.status !== 200 || n <= 30, `n=${n}`);
  const r3 = await req(`/api/session/${id}/axes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ negTerm: "same", posTerm: "same" }),
  });
  check("identical poles are refused (degenerate axis)", r3.status >= 400, `status=${r3.status}`);
}
{
  // A MALFORMED id is a bad request; only a WELL-FORMED id that happens not to
  // exist reaches the DO and can produce a 404. Probing both, because they are
  // different code paths and conflating them tested neither.
  const bad = await req("/api/session/not-a-uuid/pool?bucket=w0a0&count=5");
  check("malformed session id -> 4xx", bad.status >= 400 && bad.status < 500, `status=${bad.status}`);
  const gone = await req("/api/session/00000000-0000-4000-8000-000000000000/pool?bucket=w0a0&count=5");
  check("well-formed but unknown session -> 4xx, never a 500",
        gone.status >= 400 && gone.status < 500, `status=${gone.status}`);
}
{
  const r = await req("/../../wrangler.jsonc");
  check("path traversal does not serve repo files", r.status !== 200 || !r.text.includes("compatibility_date"),
        `status=${r.status}`);
}

console.log(`\n# ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
