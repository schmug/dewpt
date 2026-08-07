// Depth presentation for the word field, split out of field.js so the contrast
// test can read the same constants the field renders with. Press quantises
// depth into discrete bands rather than a continuous ramp — see
// docs/superpowers/specs/2026-08-07-press-design-language-design.md.

// Ordered far → near. The coarse set is the original 0.6/1.4 reduction ratio
// (~0.43) applied to the fine bands, preserving the touch legibility floor.
export const BLUR_BANDS = {
  fine: [4, 1.5, 0],
  coarse: [1.7, 0.65, 0],
};

// Carried over verbatim from the pre-Press field: opacity = floor + depth * range.
export const DEPTH_OPACITY = {
  fine: { floor: 0.45, range: 0.55 },
  coarse: { floor: 0.7, range: 0.3 },
};

export function blurBand(depth, coarse) {
  const bands = coarse ? BLUR_BANDS.coarse : BLUR_BANDS.fine;
  if (depth >= 0.66) return bands[2];
  if (depth >= 0.33) return bands[1];
  return bands[0];
}

export function wordOpacity(depth, coarse) {
  const ramp = coarse ? DEPTH_OPACITY.coarse : DEPTH_OPACITY.fine;
  return ramp.floor + depth * ramp.range;
}
