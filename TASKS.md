# TASKS — dewpt as an ideation space

Branch: `ideation-ground` · base `36626dd` · 2026-09-24. Round 2 (§7) on `ground-prospect-only` · 2026-09-25

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
- [x] Measurement doc written. Verdict: INVALID.

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
- [x] measurement `docs/measurements/2026-09-24-sky-and-ground-spike.md` (INVALID)

## 7. Round 2: prospect only (spec Appendix B)
Decision (Cory, 2026-09-25): back to §2, narrowed by the run. Prospect is the candidate on fresh data; the bridge is dropped and not retried; Marginalia is the fallback and is not built.
- [x] Prospect-only spike `scripts/ground-prospect-spike.ts` (`npm run ground-prospect-spike`). It has three fresh seeds, and in each the neighbouring groups 1 and 3 are laid out 800 units apart. It supports `--binding`, `--fake` and `--max-requests` (default 70).
- [x] Bars pre-registered in `scripts/ground-prospect-judge.ts` before any real run (`27a978a`):
  - attribution ≥ 11/18;
  - Jaccard ≤ 0.25 over the non-neighbour pairs;
  - INVALID if any position gets ≥ 12/18.

  Exact tails (0.0144, 0.0118) are asserted by tests.
- [x] `--fake` works: 27 fake requests, all 9 prospects `near` on their own cluster. The output is recorded in the new measurement doc.
- [x] First real attempt (2026-09-26) aborted at request 24 on a transient binding `internal error`. It is recorded in the measurement doc and not used. `retryTransient` was added and tested before the rerun.
- [ ] ⛔ **Rerun: blocked on Cory.** 88 of 150 spent and 62 remain, so run with `--max-requests=62`. Expected ~45. Pause WARP and export the Access variables.
- [x] De-scope `/ground/`. The bridge is removed end to end, and threads are arrangement only. The old spike keeps a frozen bridge copy, and its `--fake` output is byte-identical to the recorded run.
- [x] Gates: `npm run typecheck` clean; `npm test` 866 passing / 0 failing (41 files).
- [x] Re-shoot: `node scripts/ground-shots.mjs` against `scripts/dev-offline.mjs` (fake AI) passes 6/6. CAP budgeted peak 14; raw element peak 24 during 0.25 s retire fades.
- [x] Docs:
  - spec Appendix B plus corrected bridge claims (TL;DR, §4, §6, §7, §8; pointer under §2.B);
  - plan N11–N14;
  - new measurement doc `docs/measurements/2026-09-25-ground-prospect-spike.md` (PENDING).

## Before merge (Cory)
- [x] Run the first spike. The result was INVALID, so under the rule (PASS → merge; FAIL or INVALID → back to spec §2) the design went back to §2 (section 7 above).
- [ ] Run the prospect-only spike and paste its output into its measurement doc. PASS → merge; FAIL or INVALID → Marginalia (spec §2.E) becomes the candidate, starting with its pool-reuse spike.
- [ ] Decide whether `/ground/` becomes the night walk's door (spec §7).
- [ ] Revisit the `/board/` recommendation (spec §7): lineage no longer lives on as the bridge.
