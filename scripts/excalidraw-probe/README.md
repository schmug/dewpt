# Excalidraw fit probe

This is the evidence behind §3 of `docs/superpowers/specs/2026-09-24-sky-and-ground-design.md`.

It runs in a **scratch directory with its own `npm install`**. `@excalidraw/excalidraw`, React and esbuild are deliberately *not* dependencies of dewpt, because the conclusion was not to adopt them.

```sh
mkdir /tmp/exc && cp scripts/excalidraw-probe/* /tmp/exc && cd /tmp/exc
npm init -y && npm i @excalidraw/excalidraw@0.18.1 react@19 react-dom@19 esbuild playwright

# 1. bundle size: minified, code-split, production
npx esbuild entry.jsx --bundle --minify --format=esm --splitting --outdir=out \
  --define:process.env.NODE_ENV='"production"'
echo files=$(ls out | wc -l) js_raw=$(cat out/*.js | wc -c) js_gz=$(cat out/*.js | gzip -c | wc -c) \
  entry_gz=$(gzip -c out/entry.js | wc -c)

# 2. theming: dark theme vs light-on-night, programmatic text
mkdir -p site/fonts
npx esbuild probe.jsx probe2.jsx --bundle --minify --format=esm --splitting --outdir=site \
  --define:process.env.NODE_ENV='"production"'
cp probe.html site/index.html
cp roundtrip.html site/p2.html
cp node_modules/@excalidraw/excalidraw/dist/prod/index.css site/exc.css
cp -r node_modules/@excalidraw/excalidraw/dist/prod/fonts/{Excalifont,Nunito,Virgil,Assistant} site/fonts/
(cd site && python3 -m http.server 8799 &)
node shot-themes.cjs      # writes exc-theme-*.png and prints requests/bytes per load

# 3. round-trip a dewpt ground export through Excalidraw's own restore()
curl -o site/ground.excalidraw http://localhost:8787/api/session/<id>/ground.excalidraw
node shot-roundtrip.cjs   # prints element count, types, arrow bindings, background, serializeAsJSON count
```

## Output recorded 2026-09-24 (0.18.1, esbuild 0.25, Chromium 1194)

```
files=179 js_raw=8417887 js_gz=2589488 entry_gz=251243
css_raw=144689 css_gz=22903
theme=light requests 18 bytes 1615649     # first load, fonts included, uncompressed local server
{"n":6,"types":["text","text","text","text","text","arrow"],"bound":[["w-dtuz1h","w-owel3g"]],"bg":"#0d0c14","roundtrip":6} errors []
```

The screenshots are in `docs/superpowers/specs/assets/2026-09-24-sky-and-ground/`:
- `excalidraw-dark-theme.png`
- `excalidraw-light-on-night.png`
- `export-in-excalidraw.png`

In `excalidraw-light-on-night.png`, the clipped text ("night buse", "turnstile desig") is Excalidraw measuring programmatic text before its font loads. That is a real behaviour of the library. It is not a probe bug.
