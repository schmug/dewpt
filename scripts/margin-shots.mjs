// Checks /margin/ against .claude/plans/marginalia-slice.md's acceptance
// criteria and re-shoots its screens. Run it against a FAKE-AI server so it
// spends no Workers AI requests:
//
//   node scripts/dev-offline.mjs 8790          (or preview "dewpt-offline")
//   node scripts/margin-shots.mjs http://localhost:8790
//
// Prints one line per check and exits 1 if any fails. Words are the fake AI's
// canned vocabulary, which ignores the seed; the screens show the mechanics, not
// the quality of the words.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) { console.error("usage: node scripts/margin-shots.mjs <base-url>"); process.exit(1); }
const OUT = "docs/superpowers/specs/assets/2026-09-26-marginalia-slice";
mkdirSync(OUT, { recursive: true });
const MARGIN_CAP = 7;
const DESKTOP = { width: 1280, height: 860 };

const P1 = "The bicycle was in my grandfather's shed, under a tarp that had turned to dust. A steel frame, rust blooming through green paint, both tyres flat and cracked. I decided that afternoon to bring it back, mostly because nobody else would.";
const P2 = "Taking it apart took a month. Every bolt had seized. I soaked them in penetrating oil overnight and sorted the small parts into a muffin tin.";
const P3 = "The wheels defeated me, so I took them to the community bike workshop, where a retired mechanic showed me how to true a rim.";

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}  ${detail}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function sampler(page) {
  await page.evaluate(() => {
    window.__min = Infinity; window.__max = 0; window.__stop = false;
    const tick = () => {
      const n = document.querySelectorAll(".mword").length;
      window.__max = Math.max(window.__max, n);
      if (window.__filled) window.__min = Math.min(window.__min, n);
      if (n > 0) window.__filled = true;
      if (!window.__stop) requestAnimationFrame(tick);
    };
    tick();
  });
}
const readSampler = (page) => page.evaluate(() => { window.__stop = true; return { min: window.__min, max: window.__max }; });

async function writeParagraphs(page, paras) {
  await page.click("#page");
  for (let i = 0; i < paras.length; i++) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(paras[i], { delay: 2 });
  }
}

const browser = await chromium.launch();
try {
  // ── 1. session from a pause; first words within 3 s ──
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    const apiBodies = [];
    page.on("response", async (res) => {
      if (res.url().includes("/api/")) apiBodies.push(await res.text().catch(() => ""));
    });
    await page.goto(`${BASE}/margin/`);
    await wait(400);
    await shot(page, "01-empty");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/session") && r.request().method() === "POST");
    await writeParagraphs(page, [P1]);
    const res = await created;
    const t0 = Date.now();
    const info = await res.json();
    await page.waitForSelector(".mword", { timeout: 10_000 });
    const firstMs = Date.now() - t0;
    check("pause creates a session with a seed of at most 200 chars", info.seed.length <= 200 && P1.startsWith(info.seed), `seed ${info.seed.length} chars`);
    check("first margin words within 3 s of the session", firstMs <= 3000, `${firstMs} ms`);
    await wait(2500);
    await shot(page, "02-first-words");

    // ── one focus request per settle ──
    await page.keyboard.press("Enter");
    await page.keyboard.type(P2, { delay: 2 });
    await wait(1600);
    await page.keyboard.press("Enter");
    await page.keyboard.type(P3, { delay: 2 });
    await wait(1600);
    const focusReqs = [];
    page.on("request", (r) => { if (r.url().endsWith("/margin/focus")) focusReqs.push(Date.now()); });
    for (const i of [0, 1, 2]) { await page.locator("#page p").nth(i).click(); await wait(1600); }
    check("each caret settle in a new paragraph sends exactly one focus request", focusReqs.length === 3, `${focusReqs.length} requests for 3 settles`);
    const before = focusReqs.length;
    await page.locator("#page p").nth(2).click();
    await page.keyboard.press("ControlOrMeta+End");
    for (const ch of " A quarter turn at a time.") { await page.keyboard.type(ch, { delay: 0 }); await wait(120); } // typing without pausing
    await wait(1600);
    check("typing without pausing sends no focus until it settles", focusReqs.length - before === 1, `${focusReqs.length - before} request(s) for one settle after 26 keystrokes`);
    await shot(page, "03-following-the-writer");

    // ── the draft never comes back from the server ──
    const leaked = apiBodies.filter((b) => b.includes(P2.slice(0, 40)) || b.includes(P3.slice(0, 40))).length;
    check("no API response carries a focused paragraph's text", leaked === 0, `${leaked} of ${apiBodies.length} responses`);
    const withEmb = apiBodies.filter((b) => b.includes('"embedding"')).length;
    check("no API response carries an embedding", withEmb === 0, `${withEmb} of ${apiBodies.length} responses`);

    // ── margin cap under 10 rapid focus changes ──
    await sampler(page);
    for (let k = 0; k < 10; k++) { await page.locator("#page p").nth(k % 3).click(); await wait(1000); }
    await wait(3000);
    const { max } = await readSampler(page);
    check(`margin cap ${MARGIN_CAP} holds under 10 rapid focus changes`, max <= MARGIN_CAP, `peak ${max} margin words, fading included`);

    // ── a kept word outlives its evaporation timer ──
    const kept = await page.evaluate(() => { const w = document.querySelector(".mword:not(.leaving)"); const t = w?.textContent; w?.click(); return t; });
    await wait(12_500);
    const stillKept = await page.evaluate((t) => [...document.querySelectorAll(".note")].some((n) => n.textContent === t), kept);
    check("a kept word outlives its evaporation timer", !!kept && stillKept, `"${kept}" still gold after 12.5 s`);
    await shot(page, "04-kept-note");

    // ── the draft survives a reload, in this browser ──
    await page.reload();
    await wait(800);
    const paras = await page.locator("#page p").allTextContents();
    check("the draft and its notes survive a reload (localStorage)", paras.length === 3 && paras[1].startsWith(P2.slice(0, 20)) && (await page.locator(".note").count()) === 1, `${paras.length} paragraphs, ${await page.locator(".note").count()} note`);
    await ctx.close();
  }

  // ── 2. the margin never empties while a focus is in flight ──
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.route("**/margin/focus", async (route) => { await wait(3000); await route.continue(); });
    await page.goto(`${BASE}/margin/`);
    await writeParagraphs(page, [P1]);
    await page.waitForSelector(".mword", { timeout: 10_000 });
    await sampler(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type(P2, { delay: 2 });
    await wait(1200);
    await page.locator("#page p").nth(0).click();
    await wait(1200);
    await page.locator("#page p").nth(1).click();
    await wait(9000);
    const { min } = await readSampler(page);
    check("with focus delayed 3 s, the margin never empties after its first fill", min >= 1, `fewest margin words seen: ${min}`);
    await ctx.close();
  }

  // ── 3. 390 px, and reduced motion ──
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/margin/`);
    await writeParagraphs(page, [P1]);
    await page.waitForSelector(".mword", { timeout: 10_000 });
    await wait(2500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("no horizontal page scroll at 390 px", overflow <= 0, `overflow ${overflow}px`);
    await shot(page, "05-mobile");
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: DESKTOP, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/margin/`);
    await writeParagraphs(page, [P1]);
    await page.waitForSelector(".mword", { timeout: 10_000 });
    await wait(3000);
    const moving = await page.evaluate(() => [...document.querySelectorAll(".mword")].filter((el) => el.style.transform || getComputedStyle(el).transform !== "none").length);
    check("reduced motion: margin words fade only, no drift", moving === 0, `${moving} margin words with a transform`);
    await shot(page, "06-reduced-motion");
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed; screenshots in ${OUT}/`);
process.exit(failed ? 1 : 0);
