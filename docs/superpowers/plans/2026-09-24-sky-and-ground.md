# Sky and ground — build DAG

**Spec:** [docs/superpowers/specs/2026-09-24-sky-and-ground-design.md](../specs/2026-09-24-sky-and-ground-design.md)
**Measurement:** [docs/measurements/2026-09-24-sky-and-ground-spike.md](../../measurements/2026-09-24-sky-and-ground-spike.md) (INVALID) → [docs/measurements/2026-09-25-ground-prospect-spike.md](../../measurements/2026-09-25-ground-prospect-spike.md) (PENDING)
**Integration branch:** `ideation-ground`; round 2 on `ground-prospect-only` (from `5bceb03`)
**Base commit:** `36626dd`

Fourteen nodes.
- N1–N8 are the thin slice at `/ground/`, **built**.
- N9, the first spike's real run, came back **INVALID** (2026-09-24).
- N10 was the fresh-context review, done.
- Round 2 (N11–N14) follows spec Appendix B:
  - N11: a prospect-only spike;
  - N12: its real run, **blocked on Cory**;
  - N13: the bridge de-scope;
  - N14: the re-shoot.
- N12 gated any merge. It came back **FAIL** (2026-09-26), so the slice is not merged.

Peak parallelism is **3-wide**, reached in wave 2.

---

## Deltas from how this was first sketched

Three changes, each forced by a fact found in the repo rather than assumed:

1. **No new Durable Object class and no migration.** The first sketch had a `GroundDO` with a `v4` migration tag. But ranking needs the pool's embeddings, which live in `SessionDO`, and a word pinned in `/app/` has to show up on the ground. Both mean the ground belongs to the session. The scene is stored as one JSON value in `SessionDO`'s existing `meta` table, so there is no schema change and `wrangler.jsonc` is untouched.
2. **`drawPool` is not refactored.** The ground needs a ranked draw across all buckets. `PoolCore.drawRanked` is added next to `draw()`, and its storage half (`consumeServed`) copies `drawPool`'s three SQL statements rather than extracting them. The duplication is deliberate: the field's serving path cannot change on this branch.
3. **The spike imports the shipped ranking functions.** It uses `queryVector`, `nearScore`, `bridgeScore` and `topK` from `src/ground-core.ts`. That is why N2 depends on N1: a node may only run in a wave if every symbol it imports exists at that wave's base (see plan.md, "the rule that was missing").

---

## Node table

| Node | Scope | Files touched | Verification command (exact) | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| **N1** | Ground core: scene model, `pruneToAnchors` (the ephemerality guard), ops, neighbourhood, query vector, near/bridge scores, `topK`, Excalidraw export | **C** `src/ground-core.ts`, `test/ground-core.test.ts` | `npx vitest run test/ground-core.test.ts && npm run typecheck` | — | built |
| **N2** | Spike harness + pure judge helpers, pre-registered `PASS` | **C** `scripts/ground-spike.ts`, `scripts/ground-judge.ts`, `test/ground-judge.test.ts` · **M** `package.json` | `npx vitest run test/ground-judge.test.ts && npm run ground-spike -- --fake` | N1 | built |
| **N3** | `PoolCore.drawRanked` | **M** `src/pool-core.ts` · **C** `test/pool-core-ranked.test.ts` | `npx vitest run test/pool-core-ranked.test.ts test/pool-core.test.ts` | — | built |
| **N4** | Draw plans (`planProspect`, `planBridge`, `planScore`) + body parsers | **M** `src/ground-core.ts`, `test/ground-core.test.ts` | `npx vitest run test/ground-core.test.ts` | N1 | built |
| **N5** | SessionDO ground methods (thin shell) | **M** `src/session-do.ts` | `npm run typecheck` | N3, N4 | built |
| **N6** | `/api/session/:id/ground*` routes, `assertNoEmbeddings` on every response | **M** `src/index.ts` | `npm run typecheck && npm test` | N5 | built |
| **N7** | Client pure model: CAP sharing, bucket fallback, coordinates, landing, dew placement | **C** `public/ground/ground-model.js`, `test/ground-model.test.ts` | `npx vitest run test/ground-model.test.ts && npm run typecheck` | N1 (constants only) | built |
| **N8** | Client shell: `index.html`, `ground.css`, `ground.js` | **C** `public/ground/*` | browser: `npm run dev`, then `/ground/` (see "Verifying in a browser") | N6, N7 | built |
| **N9** | Real spike run → measurement doc verdict | **M** `docs/measurements/2026-09-24-sky-and-ground-spike.md` | `npm run ground-spike -- --binding` → `VERDICT: PASS` | N2 | done: **INVALID** (bridge judge answered by position) |
| **N10** | Fresh-context review against screenshots; fix blockers | whatever the review names | `npm run typecheck && npm test` + re-shoot | N8 | done: see spec Appendix A |
| **N11** | Prospect-only spike: fresh seeds, neighbouring groups, pre-registered `PROSPECT_PASS`, shared harness | **C** `scripts/ground-prospect-spike.ts`, `scripts/ground-prospect-judge.ts`, `scripts/ground-harness.ts`, `test/ground-prospect-judge.test.ts` · **M** `package.json` | `npx vitest run test/ground-prospect-judge.test.ts && npm run ground-prospect-spike -- --fake` | N2 (judge helpers), N3, N4 | built |
| **N12** ⛔ | Real prospect-only run → new measurement doc verdict | **M** `docs/measurements/2026-09-25-ground-prospect-spike.md` | `npm run ground-prospect-spike -- --binding --max-requests=62` (WARP paused) → `VERDICT: PASS` | N11 | done: **FAIL**, attribution 10/18 against a bar of 11. The first attempt aborted at request 24 on a transient binding error and is not a result |
| **N13** | De-scope the bridge end to end; frozen bridge copy in the old spike | **M** `src/ground-core.ts`, `test/ground-core.test.ts`, `src/session-do.ts`, `src/index.ts`, `public/ground/ground.js`, `public/ground/ground.css`, `public/ground/ground-model.js`, `scripts/ground-spike.ts` | `npm run typecheck && npm test && npm run ground-spike -- --fake` (output identical to the recorded run) | N4–N8 | built |
| **N14** | Re-shoot `/ground/` with no bridge; CAP under 10 rapid prospects | **C** `scripts/ground-shots.mjs`, `scripts/dev-offline.mjs` · **M** `.claude/launch.json`, spec asset folder | `node scripts/ground-shots.mjs http://localhost:8790` → 6/6 checks | N13 | built |

**C** = creates · **M** = modifies

---

## File-overlap matrix: who must be serialized

| File | Nodes | Forced order |
| --- | --- | --- |
| `src/ground-core.ts` | N1, N4, N13 | N1 → N4 → N13 |
| `test/ground-core.test.ts` | N1, N4, N13 | N1 → N4 → N13 |
| `src/pool-core.ts` | N3 | — |
| `src/session-do.ts` | N5, N13 | N5 → N13 |
| `src/index.ts` | N6, N13 | N6 → N13 |
| `public/ground/*` | N7, N8, N13 | N7, N8 → N13 |
| `scripts/ground-spike.ts` | N2, N13 | N2 → N13 |
| `package.json` | N2, N11 | N2 → N11 |
| `docs/measurements/2026-09-24-…spike.md` | N9 | — |
| `docs/measurements/2026-09-25-…spike.md` | N12 | — |
| spec asset folder | N10, N14 | N10 → N14 |

**Code dependencies that are not file overlaps:**
- N2 imports N1's ranking functions.
- N5 imports N3 (`drawRanked`) and N4 (plans).
- N7 mirrors N1's `GROUND_W`/`GROUND_H`, and `test/ground-model.test.ts` asserts that they match.
- N11 imports N2's judge helpers and the prospect path (`planProspect`, `planScore`, `drawRanked`). It does not touch N13's files, and N13 leaves that path unchanged, so they run side by side.
- N13 removes symbols that N2's spike imported. The frozen copy in `scripts/ground-spike.ts` keeps N9's instrument runnable.

## Waves

| Wave | Nodes | Width |
| --- | --- | --- |
| 1 | N1, N3 | 2 |
| 2 | N2, N4, N7 | **3** |
| 3 | N5 | 1 |
| 4 | N6 | 1 |
| 5 | N8 | 1 |
| 6 | N9, N10 | 2 |
| 7 | N11, N13 | 2 |
| 8 | N12 ⛔, N14 | 2 |

N9 could start the moment N2 landed. It did not wait for the UI, and the UI did not wait for it. **Merging does wait for the spike.** N9 came back INVALID, so the spec returned to its §2, and the run narrowed the design to prospect only (spec Appendix B). Merging now waits on N12.

---

## Verifying in a browser

`wrangler dev` needs a Cloudflare token even with `DEV_FAKE_AI=1`, because `"ai": {"remote": true}` starts the remote-binding proxy. It also spends Workers AI requests unless AI is faked. For screens and UI checks, use:

```sh
node scripts/dev-offline.mjs 8790          # .claude/launch.json: "dewpt-offline"
node scripts/ground-shots.mjs http://localhost:8790
```

`dev-offline.mjs` runs wrangler with `DEV_FAKE_AI=1` and no `ai` block, from a config under `.wrangler/`. It replaces an earlier recipe that ran `echo 'DEV_FAKE_AI=1' > .dev.vars`, which overwrites real secrets on a machine that has them. `ground-shots.mjs` is the screen list: it writes the asset folder and prints its checks.

## Next, after N12

These are ordered by what they unblock, and each needs its own spec → plan cycle. The near-cluster variant that used to be item 1 is now part of N12.

1. **If N12 passes:** link `/ground/` from the night walk as the door.
2. **If N12 fails or is INVALID:** Marginalia (spec §2.E) is the fallback. Its pool-reuse spike (item 4) comes first.
3. **M4 push.** WebSocket hibernation on `SessionDO`, broadcasting each applied ground op and pointer positions. `applyGroundOp` is already pure, so the shell broadcasts what it applied.
4. **Marginalia pool-reuse spike** (spec §2.E). Does a pool built for paragraph *n* serve paragraph *n+1* by re-ranking?
5. **Pan and zoom (M3)**, with zoom bound to altitude.
