# Conveyor board — parallel build DAG

**Source plan:** `docs/superpowers/plans/2026-08-08-conveyor-board-m0-m1.md`
**Spec:** `docs/superpowers/specs/2026-08-08-conveyor-board-design.md`
**Integration branch:** `claude/dewpt-companion-ui-90ff41`
**Base commit:** `1a4385c`

Nine nodes. Peak parallelism is **4-wide**, reached exactly once, in wave 2.

> **Corrected 2026-08-08.** The first version of this document said peak
> parallelism was 3 and that N2 was blocked on credentials the orchestrator did
> not hold. Both claims were wrong. The credentials are exported in the shell
> environment, inherited from the user's profile — so N2 was never blocked, and
> separating "build the spike" from "run the spike" makes it schedulable in
> wave 2 alongside N3, N5 and N8. The original claim is left visible here rather
> than quietly edited out, because a build plan that overstates its own
> parallelism is exactly the kind of thing this document exists to prevent.

---

## Deltas from the source plan

Two changes, both forced by facts checked against the repo rather than assumed:

1. **`vitest` runs in bare node with no DOM environment** (`vitest.config.ts`
   has no `environment`, and neither `jsdom` nor `happy-dom` is installed).
   The source plan's `belt-render.js` calls `document.createElement`, so it is
   not unit-testable here, and adding a DOM environment would be a new
   dependency. **N8 is therefore split** into a pure `belt-model.js` (tested,
   matching how `public/depth.js` and `public/axes.js` are tested) and a thin
   `belt-render.js` DOM writer that is verified in the browser at integration
   rather than by a node test.
2. **N2's verification requires live Cloudflare credentials.** It is marked
   BLOCKED rather than silently skipped or faked.

---

## Node table

| Node | Scope | Files touched | Verification command (exact) | Depends on |
| --- | --- | --- | --- | --- |
| **N1** | Board types + scoring math (`scoreCandidates`, `selectChild`, `hasArrived`) | **C** `src/board/types.ts`, `src/board/rewrite.ts`, `test/board-rewrite.test.ts` | `npx vitest run test/board-rewrite.test.ts && npm run typecheck` | — |
| **N2** ⛔ | M0 calibration spike; replaces the three pre-calibration constants | **C** `scripts/board-calibrate.ts` · **M** `package.json`, `src/board/types.ts` | `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run board-calibrate` → separation AUC ≥ 0.80 | N1 |
| **N3** | Rewrite prompt + `generateRewrites` | **M** `src/board/rewrite.ts`, `test/board-rewrite.test.ts` | `npx vitest run test/board-rewrite.test.ts && npm run typecheck` | N1 |
| **N4** | Fake-AI dispatch-on-shape (pole expansion + board rewrites); fixes #46 | **M** `src/dev-fake-ai.ts`, `test/board-rewrite.test.ts` | `npx vitest run test/board-rewrite.test.ts test/generation.test.ts test/pool-core.test.ts && npm test` | N3 |
| **N5** | Belt core: seeds, fan, hops, ghost trimming, `view()` | **C** `src/board/belt-core.ts`, `test/board-belt-core.test.ts` | `npx vitest run test/board-belt-core.test.ts && npm run typecheck` | N1 |
| **N6** | Belt core: edge eviction, evaporated ring, failure release, `tick()` | **M** `src/board/belt-core.ts`, `test/board-belt-core.test.ts` | `npx vitest run test/board-belt-core.test.ts && npm run typecheck` | N5 |
| **N7** | `BoardDO`, `/api/board` routes, DO binding + `v2` migration | **C** `src/board/board-do.ts`, `test/board-api.test.ts` · **M** `src/index.ts`, `wrangler.jsonc` | `npm run typecheck && npx vitest run test/board-api.test.ts` | N3, N4, N6 |
| **N8** | Client: pure placement model + DOM shell + styles | **C** `public/board/belt-model.js`, `belt-render.js`, `board.js`, `index.html`, `styles.css`, `test/board-render.test.ts` | `npx vitest run test/board-render.test.ts && npm run typecheck` | N5 (contract only) |
| **N9** | Cross-cutting guards: never-blocks, hold-on-unready, capacity | **M** `test/board-api.test.ts` | `npm run typecheck && npm test` | N7 |

**C** = creates · **M** = modifies

---

## File overlap is necessary but NOT sufficient

The matrix below answers "can these two agents write at the same time without
conflicting?" It does **not** answer "can these two agents work at the same
time?" Those are different questions, and conflating them cost a wave.

N2 and N3 were scheduled in parallel because their file sets are disjoint —
correct for N2 as originally specced, a self-contained measurement script. Then
review found that the script measured a prompt that never ships, and the fix was
to call N3's `generateRewrites`. That created a **code** dependency where there
had been no **file** dependency, on a branch that had forked before N3 existed.
The fix agent's branch could not compile, and it correctly refused to work around
it by copying N3's prompt locally — which would have reintroduced the very drift
the fix existed to prevent.

**The rule that was missing:** a node may only be scheduled in a wave if every
symbol it imports already exists at the wave's base commit. Re-derive that after
any brief changes, not once when the DAG is drawn. A remediation brief can
introduce a dependency the original node never had.

## File-overlap matrix — who must be serialized

These pairs touch a common file and **must not run concurrently**:

| File | Nodes | Forced order |
| --- | --- | --- |
| `src/board/types.ts` | N1, N2 | N1 → N2 |
| `src/board/rewrite.ts` | N1, N3 | N1 → N3 |
| `test/board-rewrite.test.ts` | N1, N3, N4 | N1 → N3 → N4 |
| `src/board/belt-core.ts` | N5, N6 | N5 → N6 |
| `test/board-belt-core.test.ts` | N5, N6 | N5 → N6 |
| `test/board-api.test.ts` | N7, N9 | N7 → N9 |

**Fully file-disjoint from every other node:** N8 (`public/board/**` plus its own
test file). It is the only node with zero overlap, which is why it can run
alongside anything once the `view()` contract is fixed.

**Disjoint pairs safe to run concurrently:**

- N3 ∥ N5 — `rewrite.ts` vs `belt-core.ts`, separate test files
- N3 ∥ N8, N5 ∥ N8
- N4 ∥ N6 — `dev-fake-ai.ts` vs `belt-core.ts`, separate test files
- N2 ∥ N3 — `types.ts`+`scripts/` vs `rewrite.ts` (moot while N2 is blocked)

---

## Wave schedule

```
wave 1   N1                          1 agent
wave 2   N2 ∥ N3 ∥ N5 ∥ N8           4 agents   ← peak
wave 3   N4 ∥ N6                     2 agents
wave 4   N7                          1 agent
wave 5   N9                          1 agent
```

Each wave: fan out from the integration branch's current head → adversarial
review per node → merge accepted nodes → run `npm test` in full → cut the next
wave from the updated head. Dependent nodes never share a worktree, so a
predecessor's code reaches its successor only through an integration merge.

**Peak concurrency 3.** The requested cap of 4 is never reached because the DAG
does not contain 4 mutually independent ready nodes at any point.

---

## N2 — build and run are separate steps

`npm run board-calibrate` requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` (scope: *Workers AI — Read*) and spends real metered
quota: roughly **12 generation and 22 embedding calls per run**.

The node therefore splits in two:

- **Build** (wave 2) — write and commit `scripts/board-calibrate.ts` plus the
  npm script. `src/board/types.ts` is NOT modified. The only permitted
  execution is with the credentials *unset*, to prove the guard fires before
  any network call.
- **Run** (after review) — executed by the orchestrator, with the expected call
  count stated before each run and a hard stop at 3 runs without checking back.
  Measured constants then land in `src/board/types.ts` as a reviewable commit.

**Two safety rules learned the hard way while building this node**, recorded so
they are not rediscovered:

1. **The credentials are already exported in the shell.** Any command that
   invokes the spike without `env -u CLOUDFLARE_ACCOUNT_ID -u
   CLOUDFLARE_API_TOKEN` WILL hit the live API. The first draft of this node's
   verification command did exactly that and was caught by the implementer, not
   by the orchestrator who wrote it.
2. **`! cmd | grep -q X; echo $?` is not a guard.** `!` inverts the pipeline
   status, so `1` is the passing value and `0` means the expected message was
   missing — the inverse of how it reads. A trailing `; echo` also forces the
   overall exit status to 0 unconditionally, making any "must exit 0" assertion
   vacuous.

**Known methodology flaw, under review before any run.** `pct(values, 0.05)`
computes `Math.floor(0.05 * (n - 1))`, which is index `0` for the sample sizes
this script produces — so the "5th percentile" is the **minimum**. The proposed
`TETHER_FLOOR` would admit 100% of genuine rewrites rather than ~95%, and
`pct(arrivals, 0.95)` may effectively be the maximum, which would put
`ARRIVAL_COSINE` above anything reachable and make arrival undetectable. Fix
before running; a bad constant here is worse than no constant.

---

## Verification standard, applied to every node

A node is **done** only when all four hold:

1. Its own verification command exits 0.
2. `npm test` passes in full, with counts reported — never "tests pass".
3. `npm run typecheck` is clean. It must be run via the npm script, never raw
   `tsc`: the script runs `wrangler types` first, and a fresh worktree is born
   without the gitignored `worker-configuration.d.ts` that `Env`,
   `ExportedHandler` and `DurableObject` resolve through.
4. An adversarial reviewer that did not write the code returns **PASS** after
   running the commands itself.

## Reviewer mandate (Phase 3)

Every node gets a reviewer with no authorship stake, hunting five specific
defect classes and **verifying empirically — running commands, not reading**:

- **(a) CSS specificity / inheritance collisions.** Live for N8, which
  introduces `public/board/styles.css` alongside the existing
  `public/styles.css` and `public/press.css`.
- **(b) Key-normalization and dedup bugs.** Live for N1 (`selectChild`'s
  `exclude` matching), N4 (per-fragment counters), N5/N6 (lineage identity,
  evaporated-ring dedup). The field's own `norm()` lowercases and collapses
  whitespace; the board must not silently disagree.
- **(c) Misused CLI/API flags failing only at runtime.** Live for N2
  (`wrangler` and REST shapes) and N7 (`wrangler.jsonc` migration tag and DO
  binding — a wrong tag is invisible until deploy).
- **(d) Stale tests, fixtures or seed scripts left behind.** Live for N4, which
  changes `dev-fake-ai.ts` behaviour that existing suites depend on.
- **(e) PR-body claims not enforced by any check.** Applied at Phase 5 against
  every claim in the PR description.

## Worktree notes for implementers

- Worktrees live under `/Users/cory/dewpt/.claude/worktrees/` and resolve
  `node_modules` upward to `/Users/cory/dewpt/node_modules`. **Do not run
  `npm install` in a worktree** — it is not a fix, it is a new problem.
- `worker-configuration.d.ts` is generated and gitignored. `npm run typecheck`
  regenerates it. Regeneration needs no network and no credentials.
- Never start a dev server from a raw shell; use the preview tooling.
- `wrangler.jsonc`'s existing `v1` migration tag must never be edited.
