# Marginalia thin slice (`/margin/`)

Spec confirmed by Cory on 2026-09-26. **Spec only; not yet approved to build.**
It follows the pool-reuse spike PASS
(`docs/measurements/2026-09-26-marginalia-pool-reuse-spike.md`, 11/15 against a
bar of 8). Design origin: spec §2.E in
`docs/superpowers/specs/2026-09-24-sky-and-ground-design.md`.

## Problem
Pool reuse passed offline, but nobody can write beside a margin yet. Unknown:
does Marginalia feel like a place to think, and do lag, pacing and legibility
hold up in real use?

## Scope
In:
- **Page.** A new page at `/margin/` (`public/margin/`): a plain writing page
  with a margin column.
- **Session.** The first pause after paragraph 1 creates a session seeded with
  `seedFrom(paragraph 1)`: at most 200 chars, cut at a sentence end.
  `seedFrom` moves from `scripts/marginalia-judge.ts` into `src/margin-core.ts`,
  so the app and the spike share one copy.
- **Focus.** When the caret settles in a paragraph (debounced), the page calls
  `POST /api/session/:id/margin/focus {text}`. The Durable Object embeds the
  paragraph and holds only the embedding, in memory. The paragraph text is
  never written to storage or logs. The call is user-initiated and sits
  outside the serving path (the `createAxis` pattern, `src/session-do.ts:255`).
  A failed embed keeps the previous focus.
- **Draw.** `POST /api/session/:id/margin/draw {visible}` runs
  `PoolCore.drawRanked` by `nearScore` toward the current focus embedding, or
  toward the seed before any focus exists. No model call. The client drips
  from a local buffer, and the old ranking serves until a new focus lands
  (lazy invalidation, SPEC.md l.49).
- **Pin.** Pinning a margin word uses the existing `pin`, so it becomes an
  anchor, shared with `/app/` and `/drift/`. It shows in gold beside the
  paragraph where it was pinned. That position is client-side only.
- **Evaporate.** Unpinned words evaporate into the existing evaporated trail.
- **Draft.** It lives in this browser's localStorage only, with a "clear page"
  control. "New page" starts a new session.
- **Code.** Pure logic goes in `src/margin-core.ts` with vitest: caret to
  paragraph, `seedFrom`, the focus plan, body parsers, and margin-cap
  accounting. Thin Durable Object methods. Routes go through
  `assertNoEmbeddings`.
- **Tooling.** `scripts/dev-offline.mjs` comes over from `ground-prospect-only`
  (`e62c2e3`), plus a new `scripts/margin-shots.mjs` checker, both run with
  fake AI.

Out:
- New pools as a draft grows; one pool per draft.
- Seeds over 200 chars, or prompt changes.
- Server-side draft storage, accounts, export.
- Any change to `/`, `/app/`, `/board/`, `/drift/` or `wrangler.jsonc`.
- DO migrations (SessionDO is reused).
- Deploys, and Workers AI spend while verifying.

## Decisions (Cory, 2026-09-26)
- Draft: browser localStorage only, with "clear page".
- Pool: one per draft, plus "new page".
- Margin cap: 7 visible words, beside the focused paragraph. UNMEASURED,
  labelled at its definition; well under the field's CAP = 14.
- Pins: gold, beside their paragraph.
- Route: `/margin/`. When the budget or rate limit is hit, show a hint line and
  keep serving the old ranking.

## Constraints
- **Pool depth.** Draw never runs inference. The focus embed is off the
  serving path, and on failure the previous ranking keeps serving.
- **Ephemerality.** The product must not remember words the user did not keep
  (the fog-of-war test). Draft text never reaches Durable Object storage or
  logs. Pins are the only thing kept.
- **Guardrails.**
  - Reduced motion is fade only.
  - Pinned words never decay; re-check after the fade timer.
  - Model output goes through `textContent`.
  - `JSON.stringify` is not HTML-safe.
- **Production cost.** One embed per focus settle, under `AccountBudgetDO` and
  `ClientRateLimitDO`. The debounce is what bounds it.
- **Testing.** Logic stays in the pure core, tested under vitest with no
  Workers runtime. The Durable Object stays thin.
- **Deploy trap.** Never deploy from an unmerged branch.

## Acceptance
1. Under `DEV_FAKE_AI`, pausing after paragraph 1 creates a session with a
   seed of at most 200 chars. Margin words appear within 3 s.
2. With the focus route delayed 3 s, the count of visible margin words never
   drops to 0 after the first fill (Playwright). Each caret settle sends
   exactly one focus request.
3. No paragraph text reaches Durable Object storage. A pure test shows the
   focus plan carries only the embedding, and a grep gate checks the DO shell.
   No response carries an embedding.
4. Under 10 rapid focus changes, visible margin words stay ≤ 7. Reduced
   motion means no transform. A pinned margin word outlives its evaporation
   timer. No horizontal scroll at 390 px.
5. `npm run typecheck` and `npm test` are green, with counts. No existing
   surface or pre-existing test changes. Verification spends 0 Workers AI
   requests.
