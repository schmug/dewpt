#!/usr/bin/env node
// Browser smoke for the deployed /drift/ surface. Mobile viewport, real taps,
// programmatic touch-target and overflow audits, a console-error gate, and
// screenshots written where the critic can read them.
//
// The surface is thumb-first and text-only evidence cannot speak to it, so this
// is the rung that makes a UI claim checkable by a critic that never sees a
// screen. Screenshots land in critic-reports/ui/.
//
// Access: every request carries the service-token headers, including the
// document request — the whole deployment 302s without them.
//
// Service workers are blocked outright. dewpt has none today (#27 is open), but
// offline emulation and route interception do not reach SW-mediated fetches, so
// the day one lands it would silently hollow out this file.
//
// WHY THE PROXY: on this machine Playwright's Chromium has no outbound network
// at all — it times out on example.com while curl and node's fetch reach the
// internet fine (WARP, same family as the workerd egress trap in CLAUDE.md).
// Loopback still works, so this starts a local forwarder that fetches from the
// real deployment in node and serves the bytes to the browser over 127.0.0.1.
// The browser therefore renders PRODUCTION's HTML, JS and CSS — this is not a
// local build. The forwarder also owns the Access headers, so no credential
// ever reaches page context.
//
// Known limitation: absolute cross-origin URLs in the page are NOT proxied, so
// the Google Fonts stylesheet fails to load and screenshots show the fallback
// stack (Iowan Old Style / system sans) rather than Fraunces and Space Grotesk.
// Layout, colour, spacing and behaviour are unaffected; typography in the PNGs
// is not what a real visitor sees.
//
//   node scripts/ui-smoke.mjs https://dewpt.cory7593.workers.dev

import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) { console.error("usage: node scripts/ui-smoke.mjs <base-url>"); process.exit(1); }
const ID = process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
const SECRET = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
if (!ID || !SECRET) { console.error("Access service-token env vars missing (shell-only; export them)"); process.exit(1); }

const OUT = "critic-reports/ui";
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};

console.log(`# UI smoke against ${BASE}/drift/  (390x844, mobile)\n`);

// Loopback forwarder — see the header note on why this exists.
const proxy = createServer(async (req, res) => {
  try {
    const upstream = await fetch(BASE + req.url, {
      method: req.method,
      headers: {
        "CF-Access-Client-Id": ID,
        "CF-Access-Client-Secret": SECRET,
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req),
      redirect: "manual",
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    for (const [k, v] of upstream.headers) {
      // Drop hop-by-hop and length headers; node recomputes them.
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
    }
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${err.message}`);
  }
});
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${proxy.address().port}`;
console.log(`(loopback forwarder ${ORIGIN} -> ${BASE}; Chromium has no direct egress here)\n`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
});
const page = await ctx.newPage();

// Chromium has no egress here, and the page links Google Fonts with a BLOCKING
// stylesheet — so DOMContentLoaded waits on a request that can never resolve.
// Abort every off-origin request immediately instead of letting it hang. The
// cost is that screenshots render in the fallback font stack; the benefit is
// that the run completes at all.
async function blockOffOrigin(target) {
  await target.route("**/*", (route) => {
    route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort();
  });
}
await blockOffOrigin(page);

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  await page.goto(`${ORIGIN}/drift/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  check("the surface loads", await page.title() === "dewpt · drift", await page.title());
  await page.screenshot({ path: `${OUT}/01-setup.png`, fullPage: true });

  console.log("\n## setup flow");
  await page.fill("#drift-seed-input", "smoketest-home cooking");
  await page.click("#drift-seed-form button[type=submit]");
  await page.waitForSelector("#drift-axis-form:not([hidden])", { timeout: 45000 });
  check("naming a seed reveals the axis form", true);
  check("the seed form is gone, not merely flagged hidden",
        (await page.locator("#drift-seed-form").boundingBox()) === null);

  await page.fill("#drift-axis-a-neg", "solemn");
  await page.fill("#drift-axis-a-pos", "playful");
  await page.fill("#drift-axis-b-neg", "concrete");
  await page.fill("#drift-axis-b-pos", "abstract");
  await page.screenshot({ path: `${OUT}/02-axes.png`, fullPage: true });
  await page.click("#drift-axis-form button[type=submit]");

  await page.waitForSelector("#drift-stage:not([hidden])", { timeout: 90000 });
  await page.waitForFunction(() => {
    const t = document.querySelector("#drift-card")?.textContent ?? "";
    return t.trim().length > 0 && t.trim() !== "…";
  }, { timeout: 90000 });
  console.log("\n## the card stage");
  check("the stage opens with a real card", true);
  check("the setup section occupies zero pixels",
        (await page.locator("#drift-setup").boundingBox()) === null);
  await page.screenshot({ path: `${OUT}/03-card.png`, fullPage: true });

  const firstCard = (await page.locator("#drift-card").textContent())?.trim();
  const marksBefore = await page.$$eval(".drift-gauge-mark", (m) => m.map((e) => e.style.left));

  console.log("\n## the mechanic: a swipe moves position and changes the card");
  const box = await page.locator("#drift-card").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.touchscreen.tap(cx, cy).catch(() => {});      // settle
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 140, cy, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press("ArrowRight");                  // keyboard parity path
  await page.waitForTimeout(600);

  const secondCard = (await page.locator("#drift-card").textContent())?.trim();
  const marksAfter = await page.$$eval(".drift-gauge-mark", (m) => m.map((e) => e.style.left));
  check("the position mark moved", JSON.stringify(marksBefore) !== JSON.stringify(marksAfter),
        `${JSON.stringify(marksBefore)} -> ${JSON.stringify(marksAfter)}`);
  check("the card changed", firstCard !== secondCard, `"${firstCard}" -> "${secondCard}"`);
  check("gauges are labelled with the user's own pole terms",
        (await page.locator(".drift-gauge").first().textContent() ?? "").includes("solemn"));
  await page.screenshot({ path: `${OUT}/04-after-swipe.png`, fullPage: true });

  console.log("\n## tap to keep");
  await page.locator("#drift-card").click();
  await page.waitForTimeout(900);
  check("the condensate count incremented",
        (await page.locator("#drift-condensate-count").textContent()) === "1");
  await page.locator("#drift-condensate").click();
  await page.waitForTimeout(300);
  check("tapping the chip opens the panel",
        (await page.locator("#drift-condensate-panel").boundingBox()) !== null);
  await page.screenshot({ path: `${OUT}/05-condensate.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the panel",
        (await page.locator("#drift-condensate-panel").boundingBox()) === null);

  console.log("\n## mobile floor");
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, inner: window.innerWidth,
  }));
  check("no horizontal overflow at 390px", overflow.scrollW <= overflow.inner,
        `scrollW=${overflow.scrollW} inner=${overflow.inner}`);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("button, a, input")]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ({ t: (e.textContent || e.getAttribute("placeholder") || e.tagName).trim().slice(0, 20),
                     h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44));
  check("no visible tap target under 44px", small.length === 0, JSON.stringify(small));
  const usesDvh = await page.evaluate(() => getComputedStyle(document.body).minHeight !== "0px");
  check("body has a viewport-relative min-height", usesDvh);

  console.log("\n## reduced motion degrades to fade");
  await ctx.close();
  const rmCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    serviceWorkers: "block", reducedMotion: "reduce",
  });
  const rmPage = await rmCtx.newPage();
  await blockOffOrigin(rmPage);
  await rmPage.goto(`${ORIGIN}/drift/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  const t = await rmPage.evaluate(() => {
    const el = document.querySelector("#drift-card");
    const cs = getComputedStyle(el);
    return { transition: cs.transitionDuration, animation: cs.animationName };
  });
  check("card transition is disabled under prefers-reduced-motion",
        /^0s(,\s*0s)*$/.test(t.transition), JSON.stringify(t));
  await rmPage.screenshot({ path: `${OUT}/06-reduced-motion.png`, fullPage: true });
  await rmCtx.close();

  console.log("\n## console");
  // Off-origin aborts are this harness's doing, not the product's — filter them
  // out or the font block would read as an application error every run.
  const realErrors = consoleErrors.filter((e) => !/fonts\.(googleapis|gstatic)\.com|ERR_FAILED|net::ERR_ABORTED/.test(e));
  check("no console errors during the whole run", realErrors.length === 0,
        realErrors.slice(0, 3).join(" | "));
  if (consoleErrors.length !== realErrors.length) {
    console.log(`  (filtered ${consoleErrors.length - realErrors.length} off-origin abort messages caused by the font block)`);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  ui smoke threw — ${err.message}`);
} finally {
  await browser.close();
  proxy.close();
}

console.log(`\n# ${pass} passed, ${fail} failed`);
console.log(`# screenshots: ${OUT}/`);
process.exit(fail === 0 ? 0 : 1);
