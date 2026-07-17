# dewpt

An ambient ideation canvas where words condense out of latent space. See
[SPEC.md](SPEC.md) for the concept and vocabulary; [dewpt-demo.html](dewpt-demo.html)
is the static reference implementation whose look and interaction behavior this
build preserves.

This is **M1 (live field)**: seed input, Worker + per-session Durable Object,
pool generation via Workers AI, drip client, evaporated sidebar.

## Run

```sh
npm install
npm run dev        # wrangler dev on http://localhost:8787
```

The AI binding runs remotely (`"remote": true`), so `wrangler login` must have
happened once on this machine. Probe it with:

```sh
curl http://localhost:8787/api/debug/ai   # {"ok":true,...} means generation will work
```

> **WARP users:** workerd (the `wrangler dev` runtime) cannot open outbound
> connections while Cloudflare WARP intercepts its sockets — the AI binding
> fails with `InferenceUpstreamError: Network connection lost` and the probe
> above hangs. Pause WARP (or exclude workerd in split-tunnel settings) while
> developing. As a last resort, `echo 'DEV_FAKE_AI=1' > .dev.vars` swaps in a
> canned offline generator (`src/dev-fake-ai.ts`) so the field machinery can be
> exercised without egress. Production generation is Workers AI only.

## Tests & checks

```sh
npm test           # vitest: pool logic + generation prompt/parsing (AI mocked)
npm run typecheck  # tsc over src/test and scripts
```

## Prompt calibration

Iterate on generation quality without touching the app — edit the prompt and
few-shots in [generation.ts](src/generation.ts), then eyeball three labeled
batches (strangeness 0.2 / 0.5 / 0.85, altitude 0.3):

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  npm run calibrate -- "security awareness people actually enjoy"
# options: --model=@cf/… --count=24
```

The token needs the *Workers AI — Read* permission. Calibrate goes through the
Cloudflare REST API, so it works even where workerd egress doesn't (WARP).

## Architecture

- **Worker** ([src/index.ts](src/index.ts)) — `/api` routes; static client
  served from [public/](public/) via Workers assets (`run_worker_first`).
- **SessionDO** ([src/session-do.ts](src/session-do.ts)) — one per session
  (the URL hash is the session). SQLite persistence, alarm-driven generation
  pump. Serving never waits on generation.
- **PoolCore** ([src/pool-core.ts](src/pool-core.ts)) — pure pool logic:
  6 buckets (3 dewpoint tiers × 2 altitudes, mirroring the demo's pools),
  fresh-first draws, lazy invalidation on pins/param changes, embedding
  cosine dedupe (> 0.92), exclude LRU (~300), evaporated ring buffer (20).
- **Generation** ([src/generation.ts](src/generation.ts)) — prompt building
  (the model hears "strangeness", never the weather vocabulary), few-shot
  examples per strangeness band seeded from the demo pools, robust JSON
  parsing, embeddings via `@cf/baai/bge-m3`.
- **Client** ([public/field.js](public/field.js)) — the demo's field machinery
  verbatim (spawn/decay timing, depth, tier colors, pulse-on-prospect,
  pin-to-condense, reduced-motion), fed by per-bucket local buffers
  ([public/pool-client.js](public/pool-client.js)) that refill in the
  background. An empty buffer skips a spawn tick; it never blocks.
- **Teaching surface** ([docs/ui-teaching-research.md](docs/ui-teaching-research.md))
  — slider endpoint labels + screen-reader glosses, a progressive hint line
  that advances as the user acts (pure state machine in
  [src/hint-machine.ts](src/hint-machine.ts), mirrored for the browser in
  [public/hint-machine.js](public/hint-machine.js); a `localStorage` taught
  flag quiets it for returning users), and a non-modal `?` legend for recall.
