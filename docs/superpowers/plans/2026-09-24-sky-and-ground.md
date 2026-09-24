# Sky and ground — build DAG

**Spec:** [docs/superpowers/specs/2026-09-24-sky-and-ground-design.md](../specs/2026-09-24-sky-and-ground-design.md)
**Measurement:** [docs/measurements/2026-09-24-sky-and-ground-spike.md](../../measurements/2026-09-24-sky-and-ground-spike.md)
**Integration branch:** `ideation-ground`
**Base commit:** `36626dd`

Ten nodes. N1–N8 are the thin slice at `/ground/` and are **built** on this branch. N9 is the spike's real run and is **blocked on Cory** (Workers AI unreachable from the sandbox that built this). N10 gates any merge.

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
| **N9** ⛔ | Real spike run → measurement doc verdict | **M** `docs/measurements/2026-09-24-sky-and-ground-spike.md` | `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run ground-spike` → `VERDICT: PASS` | N2 | **blocked on Cory** |
| **N10** | Fresh-context review against screenshots; fix blockers | whatever the review names | `npm run typecheck && npm test` + re-shoot | N8 | done: see spec Appendix A |

**C** = creates · **M** = modifies

---

## File-overlap matrix: who must be serialized

| File | Nodes | Forced order |
| --- | --- | --- |
| `src/ground-core.ts` | N1, N4 | N1 → N4 |
| `test/ground-core.test.ts` | N1, N4 | N1 → N4 |
| `src/pool-core.ts` | N3 | — |
| `src/session-do.ts` | N5 | — |
| `src/index.ts` | N6 | — |
| `package.json` | N2 | — |
| `docs/measurements/…spike.md` | N9 | — |

**Code dependencies that are not file overlaps:**
- N2 imports N1's ranking functions.
- N5 imports N3 (`drawRanked`) and N4 (plans).
- N7 mirrors N1's `GROUND_W`/`GROUND_H`, and `test/ground-model.test.ts` asserts that they match.

## Waves

| Wave | Nodes | Width |
| --- | --- | --- |
| 1 | N1, N3 | 2 |
| 2 | N2, N4, N7 | **3** |
| 3 | N5 | 1 |
| 4 | N6 | 1 |
| 5 | N8 | 1 |
| 6 | N9 ⛔, N10 | 2 |

N9 can start the moment N2 lands. It does not wait for the UI, and the UI does not wait for it. **Merging does wait for it.** If N9 fails, the slice is not merged, and the spec returns to its §2.

---

## Verifying in a browser

`wrangler dev` needs a Cloudflare token even with `DEV_FAKE_AI=1`, because `"ai": {"remote": true}` starts the remote-binding proxy. On a machine with `wrangler login`, `npm run dev` works as the README says. Without one, as in a CI box or a cloud sandbox, use a copy of the config with the `ai` block removed:

```sh
echo 'DEV_FAKE_AI=1' > .dev.vars
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("wrangler.jsonc","utf8").replace(/^\s*\/\/.*$/mg,""));delete c.ai;fs.writeFileSync("wrangler.offline.jsonc",JSON.stringify(c,null,1))'
npx wrangler dev -c wrangler.offline.jsonc --port 8787
```

Then go to `/ground/`, seed, and follow the screen list in the spec's asset folder.

## Next, after N9

These are ordered by what they unblock, and each needs its own spec → plan cycle:

1. **If N9 passes:** run a near-cluster variant, with two groups on adjacent sub-themes, to bound the hard case. Then link `/ground/` from the night walk as the door.
2. **M4 push.** WebSocket hibernation on `SessionDO`, broadcasting each applied ground op and pointer positions. `applyGroundOp` is already pure, so the shell broadcasts what it applied.
3. **Marginalia pool-reuse spike** (spec §2.E). Does a pool built for paragraph *n* serve paragraph *n+1* by re-ranking?
4. **Pan and zoom (M3)**, with zoom bound to altitude.
