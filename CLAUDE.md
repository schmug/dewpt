# CLAUDE.md — dewpt

Ambient ideation canvas: words condense out of "latent space" into a field, then
evaporate. Play, not productivity software. [SPEC.md](SPEC.md) is the product
spec; [docs/](docs/) holds research and design docs. This file covers what bites
you while working in the code.

## Setup

`worker-configuration.d.ts` is generated, gitignored, and **required for
`tsc` to resolve `Env`, `ExportedHandler`, and `DurableObject`**. A fresh
checkout or worktree is born without it, and the symptom is a dozen confusing
type errors in `src/session-do.ts` and `src/index.ts` that you did not cause.

`npm run typecheck` regenerates it first, so the gate self-heals — but if you
run `tsc` directly, run `npm run types` first. Regeneration needs no network and
no credentials; it is derived from `wrangler.jsonc` alone. Rerun it after any
`wrangler.jsonc` change.

Worktrees have no `node_modules` and resolve upward to the parent checkout's.
That works; don't "fix" it with a per-worktree install.

## Gates

`npm run typecheck` and `npm test`. Report counts, not vibes ("120 passing, 0
failing"). Tests are `vitest` over pure core logic — no network, no Workers
runtime. AI is faked by [src/dev-fake-ai.ts](src/dev-fake-ai.ts), whose
deterministic pseudo-embeddings make embedding-dependent logic testable.

Keep logic testable by keeping it out of the Durable Object: [src/pool-core.ts](src/pool-core.ts)
is pure and heavily tested, [src/session-do.ts](src/session-do.ts) is the thin
stateful shell around it. New pool/scoring/projection logic belongs in the
former.

## Reaching Workers AI locally

Two independent traps, and they stack. Probe before debugging app code —
`GET /api/debug/ai` reports whether the binding can reach the model.

- **WARP** has fully blocked workerd egress on this machine (every outbound path
  from `wrangler dev`, including IP-literal fetches). Intermittent. Plain
  `curl`/node from the shell keeps working throughout, which makes it look like
  an app bug. Pausing WARP is the deterministic fix.
- **Cloudflare Access** gates the deployed `workers.dev` domain, and `wrangler
  dev`'s remote-binding proxy authenticates against it. Without
  `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET` the dev
  server dies instantly at startup, which reads as a crash.
  [.claude/launch.json](.claude/launch.json) already sources them.

**Scripts in `scripts/` sidestep both** by calling the Workers AI REST API from
node rather than through a binding. Prefer that shape for any offline
calibration or measurement work.

All inference goes through one seam — `AiRunner` in
[src/generation.ts](src/generation.ts), selected by `selectAiRunner` in
[src/ai-runner.ts](src/ai-runner.ts). Setting `LOCAL_AI_BASE_URL` in `.dev.vars`
points it at any OpenAI-compatible server (Ollama et al.), which removes the
Access dependency but *not* the WARP one — WARP blocks workerd's egress to
localhost too. `DEV_FAKE_AI=1` still wins over it. Never put these in
`wrangler.jsonc`: production is Workers AI, and a localhost URL in deployed
config would break generation silently. Local-model gotchas (thinking models,
embedding dimensions) are in the README.

## Scripts

All take `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (needs *Workers AI -
Read*):

- `npm run calibrate -- "seed"` — eyeball generation quality per strangeness band
- `npm run axis-spike` — axis construction: single vs. pair vs. mean-centered
- `npm run axis-phrasing-spike` — pole phrasing; the polysemy test
- `npm run axis-layout -- "seed"` — renders a layout to self-contained HTML

Measurement scripts should print a **number** (AUC, distribution stats), not
just samples to squint at. That is what makes a result arguable.

## Design constraints that are correctness, not preference

Violating these looks like working code and is not.

- **Pool depth.** The field must never visibly wait for generation. The DO keeps
  a scored candidate pool per bucket and the client drips from a local buffer;
  slider moves and pins invalidate *lazily* while the old pool keeps serving.
  Never block the field on an AI call.
- **Ephemerality.** Unpinned words evaporate. The evaporated sidebar is the only
  mercy. Features that quietly make words permanent break the premise — see the
  fog-of-war reconciliation in [docs/latent-space-navigation-design.md](docs/latent-space-navigation-design.md).
- **`CAP = 14`** in [public/field.js](public/field.js) is a legibility limit, not
  a performance guard. Raising it makes the field unreadable well before it
  drops frames.
- **`prefers-reduced-motion`** must degrade to fade-only, no drift.
- **Pinned words never decay.** There is a re-check after the fade-out timer for
  exactly this; a word pinned mid-fade must not be removed or reported
  evaporated.

## Vocabulary

User-facing copy, API params, and schema keys use the weather term. Code
comments and LLM prompts use the concept, because "strangeness" is clearer to a
model than "dewpoint". Full table in [SPEC.md](SPEC.md).

dewpoint = strangeness · altitude = abstraction · drizzle = spawn rate ·
condensate = pinned harvest · evaporated = ghost trail · condense/evaporate =
spawn/decay

## Generated HTML

Scripts that emit HTML inline model-generated words. `JSON.stringify` does not
escape `<`, so a candidate containing `</script>` breaks out of the script
block. Escape before inlining, and build DOM with `textContent` rather than
`innerHTML`. Model output is untrusted input.
