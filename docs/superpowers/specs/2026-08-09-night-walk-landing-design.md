# Night-walk as landing page — design

2026-08-09 · branch `claude/landing-page-night-walk-fb184c`

## Problem

`night-walk.html` (PR #64) is a five-chapter cinematic showcase that landed at
the repo root — it is not served at all. Meanwhile `/` serves the field app
directly, which drops first-time visitors into an unexplained canvas. The walk
is the natural front door: it teaches the vocabulary (vapor → condensation →
prospecting → instruments → condensate) before asking anyone to play.

## Decision

Make the night walk the landing page at `/`, move the field app to `/app/`,
keep the board at `/board/`, and cross-link all three. Pure static
reorganization inside `public/` — no worker routing changes.

### Moves

| Before                  | After                   | Served at |
| ----------------------- | ----------------------- | --------- |
| `night-walk.html` (root, unserved) | `public/index.html`     | `/`       |
| `public/index.html`     | `public/app/index.html` | `/app/`   |
| `public/board/…`        | unchanged               | `/board/` |

The field app references every asset absolutely (`/app.js`, `/styles.css`,
`/manifest.webmanifest`, icons), so it moves without touching any JS/CSS. The
board is already self-contained under `public/board/`. The night walk is a
single self-contained file.

### Navigation

- **Night walk → app/board.** Header gains a small nav (mono, uppercase,
  matching the chapter rail) with `the field` → `/app/` and `board` →
  `/board/`. The epilogue gains the primary CTA — a prominent
  “step into the field” link to `/app/` with a secondary `board` link — because
  the end of the walk is the moment of maximum intent. The header is
  `pointer-events:none`; the nav re-enables `pointer-events:auto` on itself.
  The walk's global click handler already ignores `a`/`nav`/`header`, and the
  custom cursor already has an `is-link` state, so links need no JS changes.
- **App → night walk.** A `night walk` link in the app header beside
  “what is this?”, `press-label` styled — subtle, the field stays minimal.
- **Board → night walk / app.** The masthead gains `night walk` (`/`) and
  `the field` (`/app/`) links.

### PWA manifest

`start_url` changes `/` → `/app/`: an installed dewpt should open the field,
not the marketing walk. `id` and `scope` stay `/` so existing installs keep
their identity and the walk stays in scope.

## Alternatives rejected

- **Worker-side rewrite of `/` → night-walk asset.** Requires
  `run_worker_first` beyond `/api/*` and hand-routing static files; more code,
  against the asset-first posture in `wrangler.jsonc`.
- **Copy instead of move.** Two divergent night-walks; no.
- **Night walk at `/walk`, app stays at `/`.** Doesn't make the walk the
  landing page, which is the request.

## Compatibility

- No app JS reads `location.search`, so there are no seed-bookmark URLs to
  break. `/api/*` paths are absolute and unchanged.
- Workers assets' default `html_handling` (auto-trailing-slash) serves
  `public/app/index.html` at `/app/` and redirects `/app` → `/app/`.
- `test/explainer-copy.test.ts` and `test/press-adoption.test.ts` read
  `public/index.html`; their import paths move to `public/app/index.html`.

## Testing

New `test/landing-nav.test.ts` pins the topology so a future shuffle fails CI:

1. `public/index.html` is the night walk (chapter rail present) and links to
   `/app/` and `/board/`.
2. `public/app/index.html` is the field (loads `/app.js`, has `#seedForm`) and
   links back to `/`.
3. `public/board/index.html` links back to `/`.
4. `manifest.webmanifest` has `start_url: "/app/"`, `scope` and `id` still `/`.
