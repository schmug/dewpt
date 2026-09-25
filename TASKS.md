# TASKS — dewpt as an ideation space

Branch: `ideation-ground` · base `36626dd` · 2026-09-24

Baseline before any change: `npm run typecheck` clean, `npm test` **770 passing / 0 failing (35 files)**.

## 0. Environment facts (checked, not assumed)
- [x] `wrangler dev` dies at startup in a sandbox without a token. `"ai": {"remote": true}` starts the remote-binding proxy even when `DEV_FAKE_AI=1`. The workaround is an untracked `wrangler.offline.jsonc` without the `ai` block (recipe in the plan).
- [x] `api.cloudflare.com` is blocked by this sandbox's egress proxy (CONNECT 403), and there are no `CLOUDFLARE_*` credentials. Workers AI cannot be reached from here.
- [x] `huggingface.co`'s API answers, but its file CDN (`us.aws.cdn.hf.co`) returns 403, so the bge-m3 weights cannot be fetched. There is no local stand-in.
- [x] `api.github.com` and `git push` are refused for this repo (not in the session's authorized sources). Issues #104–#110 were read via `critic-reports/cycle-03.md`, not GitHub. Work reaches Cory as a patch.
- [x] Google Fonts is blocked here. Screenshots route Fraunces and Space Grotesk to local `@fontsource` files, so they render the real faces.

## 1. Audit (one subagent per surface)
- [x] landing `/`
- [x] field `/app/`
- [x] board `/board/`
- [x] drift `/drift/`
- [x] Spot-check each report's evidence against code and screenshots before accepting it. Each item below was checked against the file or screenshot it cites:
  - **landing:** `public/index.html` loads no `<script src>` and no stylesheet link, and is self-contained. The `pickText` fallback can return a word already on screen (`:588`). The burst pile-up shows in `05d`.
  - **field:** `SessionDO.prospect(_buckets)` ignores its argument (`session-do.ts:143`). `pickWord` has no empty-bucket fallback (`field.js:48-51`). `hydratePinned` rebuilds only the tray (`field.js:203`). The pinned word and chip show in `04`.
  - **board:** the belt is empty and the seed evaporated (`03`). The fake-AI comment on tether (`dev-fake-ai.ts:150`) is the one the audit showed to be false.
  - **drift:** `onFlush` nulls `range` (`drift.js:76-81`), and `position.js:109` dereferences `range.lo`. The card is painted over the condensate panel (`13`).

## 2. Diverge
- [x] Five reimaginings (spec §2):
  - A. Excalidraw ground
  - B. native ground (**chosen**)
  - C. rooms with windows
  - D. flight: cloud and grove
  - E. marginalia (the radical one)
- [x] Excalidraw facts verified: version, size, peer deps, font enum, dark filter, bundle, round-trip. Spec §3; probe in `scripts/excalidraw-probe/`.

## 3. Converge
- [x] Pick one and defend it (spec §2, "Why B").
- [x] Spike `scripts/ground-spike.ts`, which prints a number. Plumbing verified offline. Pass bars pre-registered, then revised before any real run after review.
- [x] Real run 2026-09-24 via `--binding` (Access + OAuth, WARP paused), 63 requests. **VERDICT: INVALID**: the bridge judge picked position 2 in 10/18 trials.
- [x] Measurement doc written. Its verdict is PENDING.

## 4. Build (new route; existing surfaces untouched: `git diff 36626dd` shows 0 deletions in pre-existing files)
- [x] Pure core `src/ground-core.ts`, plus `PoolCore.drawRanked`, with vitest.
- [x] Thin DO shell (additive methods, scene in `meta`), so no migration and no `wrangler.jsonc` change.
- [x] Client at `/ground/`.
- [x] Gates: typecheck clean, tests green (counts in the final summary).

## 5. Review
- [x] A fresh-context reviewer checked the slice against screenshots and the live server. It failed it: 6/3/5/5/6.
- [x] Every merge-blocking finding fixed and re-verified in the browser. Findings and actions are in spec Appendix A.
- [ ] Still open: route-level and DO-level tests. The repo's vitest has no Workers runtime, and adding one is its own decision.

## 6. Docs
- [x] spec `docs/superpowers/specs/2026-09-24-sky-and-ground-design.md`
- [x] plan `docs/superpowers/plans/2026-09-24-sky-and-ground.md`
- [x] measurement `docs/measurements/2026-09-24-sky-and-ground-spike.md` (verdict pending N9)

## Before merge (Cory)
- [x] Run the spike. Paste its output into the measurement doc. The result was INVALID, so under the rule above (PASS → merge; FAIL or INVALID → back to spec §2) the next step is Cory's call.
- [ ] Decide whether `/ground/` becomes the night walk's door (spec §7).
