// Re-shoots /ground/ for the spec's asset folder and prints the numbers the
// screenshots are evidence for. Run against a FAKE-AI server so it spends no
// Workers AI requests:
//
//   node scripts/dev-offline.mjs 8790          (or preview "dewpt-offline")
//   node scripts/ground-shots.mjs http://localhost:8790
//
// Screens: seed, sky, pinned + arranged, word menu, condense beside, thread (no
// mark), mobile 390 px, mobile pre-seed, reduced motion, and CAP under 10 rapid
// prospects. Checks, printed as numbers:
//   - the peak count of ephemeral words during 10 rapid prospects, counted the
//     way the client budgets them (ground.js condenseDew/drizzle): sky + dew,
//     normal fades included, words retired to make room (.fast, a 0.25 s fade)
//     excluded. CAP = 14 (public/field.js) must hold. The raw DOM peak, fast
//     fades included, is printed as a diagnostic;
//   - no pinned word is lost in the burst (they never decay);
//   - no bridge mark exists on a thread;
//   - no horizontal page scroll at 390 px;
//   - reduced motion: sky words carry no drift transform.
// Exits 1 if any check fails.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) { console.error("usage: node scripts/ground-shots.mjs <base-url>"); process.exit(1); }
const OUT = "docs/superpowers/specs/assets/2026-09-24-sky-and-ground";
mkdirSync(OUT, { recursive: true });
const CAP = 14;
const DESKTOP = { width: 1280, height: 860 };

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"}  ${name}  ${detail}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSky(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll("#sky .vapor:not(.leaving)").length >= k, n, { timeout: 30_000 });
}

async function gwordBox(page, i) {
  return page.locator(".gword").nth(i).boundingBox();
}

async function drag(page, i, to) {
  const b = await gwordBox(page, i);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  const steps = 12;
  for (let s = 1; s <= steps; s++) {
    await page.mouse.move(b.x + b.width / 2 + ((to.x - b.x - b.width / 2) * s) / steps, b.y + b.height / 2 + ((to.y - b.y - b.height / 2) * s) / steps);
  }
  await page.mouse.up();
  await wait(500);
}

async function clickWord(page, i) {
  const b = await gwordBox(page, i);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await wait(250);
}

const browser = await chromium.launch();
try {
  // ── desktop: seed → sky → pin → arrange → menu → condense beside → thread ──
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ground/`);
  await page.waitForSelector("#seedInput");
  await wait(400);
  await shot(page, "01-preseed");

  await page.fill("#seedInput", "public transit");
  await page.click("#seedForm button[type=submit]");
  await waitSky(page, 5);
  await wait(1200);
  await shot(page, "02-sky");
  const id = new URL(page.url()).hash.slice(1);

  // Pin five sky words, one at a time; each falls to the ground.
  for (let n = 1; n <= 5; n++) {
    await waitSky(page, 1);
    await page.evaluate(() => document.querySelector("#sky .vapor:not(.leaving):not(.falling)")?.click());
    await page.waitForFunction((k) => document.querySelectorAll(".gword").length >= k, n, { timeout: 15_000 });
    await wait(900);
  }
  const g = await page.locator("#ground").boundingBox();
  const at = (fx, fy) => ({ x: g.x + g.width * fx, y: g.y + g.height * fy });
  // Two clusters: three words left, two words right.
  const spots = [at(0.14, 0.3), at(0.2, 0.46), at(0.12, 0.6), at(0.66, 0.36), at(0.74, 0.54)];
  for (let i = 0; i < spots.length; i++) await drag(page, i, spots[i]);
  await wait(600);
  await shot(page, "03-arranged");

  await clickWord(page, 0);
  await page.waitForSelector("#menu:not([hidden])");
  await shot(page, "04-select");

  await page.click('#menu button[data-act="prospect"]');
  await page.waitForFunction(() => document.querySelectorAll(".vapor.dew").length > 0, null, { timeout: 15_000 });
  await wait(900);
  const basis = await page.locator(".basis").last().textContent().catch(() => "");
  check("condense beside answers with dew beside the cluster", (await page.locator(".vapor.dew").count()) > 0, `basis label: "${basis}"`);
  await shot(page, "05-condense-beside");

  await clickWord(page, 0);
  await page.waitForSelector("#menu:not([hidden])");
  await page.click('#menu button[data-act="thread"]');
  await clickWord(page, 3);
  await page.waitForFunction(() => document.querySelectorAll("#threads line").length > 0, null, { timeout: 10_000 });
  await wait(500);
  const lines = await page.locator("#threads line").count();
  const bridges = await page.locator(".bridge").count();
  const groundButtons = await page.locator("#ground button:not(.gword)").count();
  check("thread drawn with no mark on it", lines === 1 && bridges === 0 && groundButtons === 0, `lines ${lines}, .bridge ${bridges}, non-word buttons on the ground ${groundButtons}`);
  await shot(page, "06-thread");

  // ── CAP under 10 rapid prospects ──
  const pinnedBefore = await page.locator(".gword").allTextContents();
  await page.evaluate(() => {
    window.__peak = 0;
    window.__raw = 0;
    const tick = () => {
      window.__peak = Math.max(window.__peak, document.querySelectorAll(".vapor:not(.fast)").length);
      window.__raw = Math.max(window.__raw, document.querySelectorAll(".vapor").length);
      if (!window.__stop) requestAnimationFrame(tick);
    };
    tick();
  });
  const beside = [at(0.2, 0.8), at(0.3, 0.2), at(0.7, 0.8), at(0.82, 0.3), at(0.25, 0.85), at(0.6, 0.2), at(0.35, 0.5), at(0.8, 0.7), at(0.1, 0.85), at(0.55, 0.6)];
  for (const p of beside) { await page.mouse.click(p.x, p.y); await wait(150); }
  await wait(600);
  await shot(page, "10-cap-under-rapid-prospects");
  await wait(6000);
  const { peak, raw } = await page.evaluate(() => { window.__stop = true; return { peak: window.__peak, raw: window.__raw }; });
  const pinnedAfter = await page.locator(".gword").allTextContents();
  const lost = pinnedBefore.filter((t) => !pinnedAfter.includes(t));
  check(`CAP = ${CAP} holds under 10 rapid prospects`, peak <= CAP, `peak ${peak} budgeted words (raw DOM peak incl. 0.25 s retire fades: ${raw})`);
  // A click can land on dew and pin it, so the ground may gain words; it must lose none.
  check("pinned words survive the burst", lost.length === 0, `${pinnedBefore.length} before, ${pinnedAfter.length} after, ${lost.length} lost`);
  await ctx.close();

  // ── mobile 390 px ──
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mob.newPage();
  await m.goto(`${BASE}/ground/#${id}`);
  await waitSky(m, 3);
  await wait(1500);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px", overflow <= 0, `overflow ${overflow}px`);
  await shot(m, "07-mobile");
  const m2 = await mob.newPage();
  await m2.goto(`${BASE}/ground/`);
  await m2.waitForSelector("#seedInput");
  await wait(400);
  await shot(m2, "08-mobile-preseed");
  await mob.close();

  // ── reduced motion ──
  const rm = await browser.newContext({ viewport: DESKTOP, reducedMotion: "reduce" });
  const r = await rm.newPage();
  await r.goto(`${BASE}/ground/#${id}`);
  await waitSky(r, 4);
  await wait(1500);
  const drifting = await r.evaluate(() => [...document.querySelectorAll("#sky .vapor")].filter((el) => el.style.transform).length);
  check("reduced motion: no sky word drifts", drifting === 0, `${drifting} sky words with a drift transform`);
  await shot(r, "09-reduced-motion");
  await rm.close();
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed; screenshots in ${OUT}/`);
process.exit(failed ? 1 : 0);
