# TASKS — dewpt as an ideation space

Branch: `ideation-ground` · base `36626dd` · started 2026-09-24

Baseline gates before any change: `npm run typecheck` clean · `npm test` **770 passing / 0 failing (35 files)**.

## 0. Environment facts (checked, not assumed)
- [x] `wrangler dev` dies at startup in this sandbox: `"ai": {"remote": true}` needs `CLOUDFLARE_API_TOKEN` for the remote-binding proxy, even with `DEV_FAKE_AI=1`. Workaround: an untracked `wrangler.offline.jsonc` with the `ai` block removed + `.dev.vars` `DEV_FAKE_AI=1`. `/api/debug/ai` → `{"ok":true,"mode":"fake"}`.
- [x] `api.cloudflare.com` is **blocked by this sandbox's egress proxy** (CONNECT 403). No `CLOUDFLARE_*` creds in env either. Workers AI REST spikes cannot run from here.
- [x] `api.github.com` is blocked for this repo (403, no `gh`). Issues #104–#110 could not be read directly; reconstructed from `critic-reports/cycle-03.md`.
- [x] huggingface.co is reachable → `BAAI/bge-m3` (the same weights as `@cf/baai/bge-m3`) can run locally for embedding-only measurement at 0 Workers AI requests.

## 1. Audit (one subagent per surface)
- [ ] landing `/`
- [ ] field `/app/`
- [ ] board `/board/`
- [ ] drift `/drift/`
- [ ] spot-check each report's evidence

## 2. Diverge
- [ ] 3–5 reimaginings (≥1 Excalidraw, ≥1 without, ≥1 radical)
- [ ] verify Excalidraw facts (version, size, peer deps, collab model)

## 3. Converge
- [ ] pick one, defend it
- [ ] spike script in `scripts/` that prints a number; Workers AI budget 150 total
- [ ] measurement doc

## 4. Build (new route, existing surfaces untouched)
- [ ] pure core in `src/*-core.ts` + vitest
- [ ] thin DO shell + routes (new migration tag only)
- [ ] client at new route
- [ ] gates: typecheck + test counts

## 5. Review
- [ ] fresh-context reviewer against screenshots
- [ ] fix merge blockers, record each finding + action

## 6. Docs
- [ ] spec `docs/superpowers/specs/2026-09-24-<name>-design.md`
- [ ] plan `docs/superpowers/plans/2026-09-24-<name>.md`
- [ ] measurement `docs/measurements/2026-09-24-<name>.md`
