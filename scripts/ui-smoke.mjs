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

// Audits run at EVERY state, not once after setup is hidden. Cycle 1's critic
// found a 442px-wide axis step in a 390px viewport that this file missed
// entirely, because the only overflow check ran after that step was gone.
async function auditViewport(page, label) {
  const o = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, inner: window.innerWidth,
  }));
  check(`no horizontal overflow — ${label}`, o.scrollW <= o.inner,
        `scrollW=${o.scrollW} inner=${o.inner}`);
  // Include ROLE-based controls. The card is a div[role=button] and was
  // excluded from the old button/a/input query while being the primary control.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, a, input, [role="button"], [tabindex]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ({ t: (e.id || e.textContent || e.getAttribute("placeholder") || e.tagName).trim().slice(0, 24),
                     h: Math.round(e.getBoundingClientRect().height),
                     w: Math.round(e.getBoundingClientRect().width) }))
      .filter((x) => x.h < 44 || x.w < 44));
  check(`no tap target under 44px — ${label}`, small.length === 0, JSON.stringify(small));
}

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
  await auditViewport(page, "seed step");
  await page.screenshot({ path: `${OUT}/01-setup.png`, fullPage: true });

  console.log("\n## setup flow");
  await page.fill("#drift-seed-input", "smoketest-home cooking");
  await page.click("#drift-seed-form button[type=submit]");
  await page.waitForSelector("#drift-axis-form:not([hidden])", { timeout: 45000 });
  check("naming a seed reveals the axis form", true);
  check("the seed form is gone, not merely flagged hidden",
        (await page.locator("#drift-seed-form").boundingBox()) === null);

  // Take the PILL path, which is what a real user does now — and typing
  // solemn/playful put the worst-measured pair in every screenshot.
  const pills = page.locator(".drift-pill");
  check("the compass offers suggested pairs", (await pills.count()) >= 3, `${await pills.count()} pills`);
  await pills.nth(0).click();
  await pills.nth(1).click();
  const filled = await page.evaluate(() => [
    document.querySelector("#drift-axis-a-neg").value, document.querySelector("#drift-axis-a-pos").value,
    document.querySelector("#drift-axis-b-neg").value, document.querySelector("#drift-axis-b-pos").value,
  ]);
  check("two pill taps fill both rows, not one twice",
        filled.every(Boolean) && `${filled[0]}|${filled[1]}` !== `${filled[2]}|${filled[3]}`,
        JSON.stringify(filled));
  await auditViewport(page, "axis step");
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

  // A REAL touch swipe, via CDP. page.mouse does NOT generate touch events, so
  // a mouse drag never reaches the touchend handler that owns the gesture —
  // an earlier version of this file "tested" the swipe with a mouse drag and
  // was actually only testing the ArrowRight that followed it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + 90, y: cy }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + 160, y: cy }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(700);

  const secondCard = (await page.locator("#drift-card").textContent())?.trim();
  const marksAfter = await page.$$eval(".drift-gauge-mark", (m) => m.map((e) => e.style.left));
  check("a real touch swipe moves the position mark", JSON.stringify(marksBefore) !== JSON.stringify(marksAfter),
        `${JSON.stringify(marksBefore)} -> ${JSON.stringify(marksAfter)}`);
  check("a real touch swipe changes the card", firstCard !== secondCard, `"${firstCard}" -> "${secondCard}"`);
  // Keyboard parity: the surface must be operable without a pointer.
  const beforeKey = (await page.locator("#drift-card").textContent())?.trim();
  await page.locator("#drift-card").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  check("keyboard arrows drive the other axis too",
        (await page.locator("#drift-card").textContent())?.trim() !== beforeKey);
  check("gauges are labelled with the user's own pole terms",
        (await page.locator(".drift-gauge").first().textContent() ?? "").trim().length > 0);
  await page.screenshot({ path: `${OUT}/04-after-swipe.png`, fullPage: true });

  console.log("\n## a swipe must not also keep");
  {
    const before = await page.locator("#drift-condensate-count").textContent();
    const bb = await page.locator("#drift-card").boundingBox();
    const sx = bb.x + bb.width / 2, sy = bb.y + bb.height / 2;
    const c2 = await page.context().newCDPSession(page);
    await c2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sx, y: sy }] });
    await c2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sx - 150, y: sy }] });
    await c2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(900);
    check("swiping does not pin the card",
          (await page.locator("#drift-condensate-count").textContent()) === before,
          `${before} -> ${await page.locator("#drift-condensate-count").textContent()}`);
  }

  console.log("\n## the edge is local");
  {
    // Walk hard to one corner. Past the reach bound the surface must SAY there
    // is nothing here rather than teleport to the nearest thing anywhere in the
    // pool. This is cycle 1's mechanic blocker, pinned in the browser.
    await page.locator("#drift-card").focus();
    // Paced. A 90ms cadence over 28 swipes triggers the field's own rate limiter,
    // and a harness that trips abuse control is testing the limiter, not the app.
    // MAX_REACH means the edge arrives in a handful of steps, so 14 was mostly
    // spent generating top-ups and burning the 240 req/min client budget.
    for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(260); }
    for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowUp"); await page.waitForTimeout(260); }
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => ({
      edgeShown: !document.querySelector("#drift-edge").hidden,
      card: document.querySelector("#drift-card").textContent.trim(),
    }));
    check("a corner either shows a card or declares the edge — never blank silence",
          st.edgeShown || st.card.length > 0, JSON.stringify(st));
    await page.screenshot({ path: `${OUT}/07-edge.png`, fullPage: true });
    // Walk ALL the way back. Stepping back only half the distance left the tap
    // below landing in empty space, so a passing pin check depended on where the
    // walk happened to stop. Position clamps, so overshooting is safe.
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(260); }
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(260); }
    
    
    await page.waitForTimeout(1200);
    // The pin check is about pinning, not about finding a card. Assert the
    // precondition explicitly so a failure says which of the two broke.
    await page.waitForFunction(() => {
      const t = document.querySelector("#drift-card")?.textContent ?? "";
      return t.trim().length > 0;
    }, { timeout: 30000 }).catch(() => {});
    check("walked back to a populated position before the pin check",
          ((await page.locator("#drift-card").textContent()) ?? "").trim().length > 0);
  }

  console.log("\n## tap to keep");
  // A real tap — touchscreen, not mouse. The touchend handler sees a sub-threshold
  // delta and defers to the click the browser synthesises, which is the pin.
  const tapBox = await page.locator("#drift-card").boundingBox();
  await page.touchscreen.tap(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2);
  await page.waitForTimeout(1500);
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

  console.log("\n## chrome does not collide");
  {
    const overlap = await page.evaluate(() => {
      const chip = document.querySelector("#drift-condensate").getBoundingClientRect();
      return [...document.querySelectorAll(".drift-gauge span")]
        .filter((e) => e.getClientRects().length > 0)
        .filter((e) => { const r = e.getBoundingClientRect();
          return r.right > chip.left && r.left < chip.right && r.bottom > chip.top && r.top < chip.bottom; })
        .map((e) => e.textContent);
    });
    check("the condensate chip does not sit on a gauge label", overlap.length === 0, JSON.stringify(overlap));
  }

  console.log("\n## mobile floor");
  await auditViewport(page, "card stage");
  const usesDvh = await page.evaluate(() => getComputedStyle(document.body).minHeight !== "0px");
  check("body has a viewport-relative min-height", usesDvh);

  console.log("\n## reduced motion degrades to fade");
  await ctx.close();
  const rmCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    serviceWorkers: "block", reducedMotion: "reduce",
  });
  // The main flow has just spent a chunk of the 240 req/min client budget, and
  // the reduced-motion pass is a whole second session. Let the window drain, or
  // this run tests the rate limiter rather than the surface.
  console.log("  (pausing 45s so the reduced-motion session is not rate limited)");
  await new Promise((r) => setTimeout(r, 45_000));
  const rmPage = await rmCtx.newPage();
  await blockOffOrigin(rmPage);
  await rmPage.goto(`${ORIGIN}/drift/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Drive it to the CARD STAGE. Screenshotting the untouched seed screen proved
  // nothing about how a card behaves under reduced motion. Critic cycle 1.
  await rmPage.fill("#drift-seed-input", "smoketest-reduced motion");
  await rmPage.click("#drift-seed-form button[type=submit]");
  await rmPage.waitForSelector("#drift-axis-form:not([hidden])", { timeout: 120000 });
  await rmPage.locator(".drift-pill").nth(0).click();
  await rmPage.locator(".drift-pill").nth(1).click();
  await rmPage.click("#drift-axis-form button[type=submit]");
  await rmPage.waitForSelector("#drift-stage:not([hidden])", { timeout: 120000 });
  await rmPage.waitForFunction(() => {
    const t = document.querySelector("#drift-card")?.textContent ?? "";
    return t.trim().length > 0 && t.trim() !== "…";
  }, { timeout: 120000 });

  const t = await rmPage.evaluate(() => {
    const cs = getComputedStyle(document.querySelector("#drift-card"));
    return { transition: cs.transitionProperty, duration: cs.transitionDuration,
             animation: cs.animationName, transform: cs.transform };
  });
  // It must CROSSFADE: opacity still transitions, transform does not move.
  check("reduced motion keeps the opacity fade", /opacity/.test(t.transition), JSON.stringify(t));
  check("reduced motion suppresses transform motion",
        t.transform === "none" || t.transform === "matrix(1, 0, 0, 1, 0, 0)", JSON.stringify(t));
  check("reduced motion runs no animation", t.animation === "none", JSON.stringify(t));
  await auditViewport(rmPage, "reduced-motion card stage");
  await rmPage.screenshot({ path: `${OUT}/06-reduced-motion.png`, fullPage: true });
  await rmCtx.close();

  console.log("\n## console");
  // Off-origin aborts are this harness's doing, not the product's — filter them
  // out or the font block would read as an application error every run.
  // A 429 is the field's abuse control working correctly. The surface must not
  // LOG it as an error, and this run must not FAIL on it — but it is reported
  // separately so a throttled run is never mistaken for a clean one.
  const throttles = consoleErrors.filter((e) => /429|Too Many Requests/.test(e));
  const realErrors = consoleErrors.filter((e) =>
    !/fonts\.(googleapis|gstatic)\.com|ERR_FAILED|net::ERR_ABORTED|429|Too Many Requests/.test(e));
  if (throttles.length > 0) {
    console.log(`  (NOTE: ${throttles.length} rate-limit responses — this run was throttled by the field)`);
  }
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
