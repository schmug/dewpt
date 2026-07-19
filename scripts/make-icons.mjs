// One-shot PWA icon generator (run manually, not part of the build):
//   node scripts/make-icons.mjs
// Renders the dewpt wordmark on the field's radial gradient into the PNG sizes
// the manifest and <head> reference. Colors are the SPEC tier palette verbatim
// (SPEC.md:89, styles.css :root): field radial --field, wordmark pale-slate --t0
// with lilac --t1 "pt", and a single gold --pin droplet (the pinned tier). Pure
// SVG shapes + text so it renders deterministically from any serif; no network.
// The generated PNGs are committed under public/, so this only needs re-running
// when the wordmark or palette changes. Uses sharp (present transitively via
// wrangler's toolchain — no client/worker dependency is added).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// palette (styles.css :root)
const INK = '#14121f', FIELD = '#1a1830';
const T0 = '#cfd4e8', T1 = '#b8a6e8', PIN = '#f0d98c';

// The field gradient (styles.css #field): radial ellipse at 50% 42%.
function background(size, radius) {
  return `
    <defs>
      <radialGradient id="fld" cx="50%" cy="42%" r="72%">
        <stop offset="0%" stop-color="#201d3d"/>
        <stop offset="62%" stop-color="${FIELD}"/>
        <stop offset="100%" stop-color="#171528"/>
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${INK}"/>
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#fld)"/>`;
}

// wordmark "dewpt" (dew in slate, pt in lilac italic) + a small gold pin
// droplet, scaled by `mark` (1 = full, <1 = shrunk into a maskable safe zone).
// textLength clamps the run to a safe width so no glyph clips the edge.
function wordmark(size, mark) {
  const fs = size * 0.21 * mark;
  const cx = size / 2, cy = size / 2;
  const runW = size * 0.72 * mark;
  const dot = size * 0.026 * mark;
  return `
    <g font-family="Fraunces, 'DejaVu Serif', Georgia, serif" font-weight="400" text-anchor="middle">
      <text x="${cx}" y="${cy}" font-size="${fs}" dominant-baseline="central"
            textLength="${runW}" lengthAdjust="spacingAndGlyphs">
        <tspan fill="${T0}">dew</tspan><tspan fill="${T1}" font-style="italic">pt</tspan>
      </text>
    </g>
    <circle cx="${cx + runW * 0.30}" cy="${cy - fs * 0.92}" r="${dot}" fill="${PIN}"/>`;
}

function svg(size, { maskable = false } = {}) {
  // maskable: full-bleed (no corner radius so the OS mask crops freely) with the
  // mark shrunk into the central safe zone; standard: gently rounded tile.
  const radius = maskable ? 0 : Math.round(size * 0.18);
  const mark = maskable ? 0.7 : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${background(size, radius)}
    ${wordmark(size, mark)}
  </svg>`;
}

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'icon-180.png', size: 180 }, // apple-touch-icon (iOS applies its own mask)
  { file: 'favicon-32.png', size: 32 },
];

for (const t of targets) {
  const buf = Buffer.from(svg(t.size, { maskable: t.maskable }));
  // render the SVG oversampled for crisp glyph edges, then downscale to the
  // exact declared pixel size so the file matches its manifest `sizes` entry.
  await sharp(buf, { density: 384 }).resize(t.size, t.size).png().toFile(join(outDir, t.file));
  console.log('wrote', t.file, `(${t.size}x${t.size}${t.maskable ? ', maskable' : ''})`);
}
