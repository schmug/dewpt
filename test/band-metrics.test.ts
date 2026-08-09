import { describe, expect, it } from "vitest";

import { auc, cohensD } from "../src/metrics";
import { type BandSample, bandReport } from "../src/band-metrics";

/** A 2-D unit vector at `deg` from the seed direction, so seed distance
 *  (1 − cosine) rises monotonically with the angle and is easy to reason about. */
function vec(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

const SEED = [1, 0];

function band(label: string, strangeness: number, degrees: number[], requested = degrees.length): BandSample {
  return {
    label,
    strangeness,
    requested,
    texts: degrees.map((d) => `w${label}${d}`),
    embeddings: degrees.map(vec),
  };
}

describe("auc", () => {
  it("is 1 when every positive outranks every negative", () => {
    expect(auc([3, 4, 5], [0, 1, 2])).toBe(1);
  });

  it("is 0 when the ordering is fully inverted", () => {
    expect(auc([0, 1, 2], [3, 4, 5])).toBe(0);
  });

  it("ranks interleaved groups between the extremes", () => {
    expect(auc([1, 3], [0, 2])).toBeCloseTo(0.75, 6);
    expect(auc([0, 2], [1, 3])).toBeCloseTo(0.25, 6);
  });

  // Two bands that collapsed onto each other produce exact ties, which is the
  // headline case for this spike. Without mid-rank correction a tie resolves by
  // sort order and a fully-collapsed comparison reads 0.25 instead of chance.
  it("scores exact ties as chance", () => {
    expect(auc([0, 1], [0, 1])).toBeCloseTo(0.5, 6);
    expect(auc([5, 5, 5], [5, 5, 5])).toBeCloseTo(0.5, 6);
    expect(auc([2, 2], [1, 2])).toBeCloseTo(0.75, 6);
  });
});

describe("cohensD", () => {
  it("is 0 for identical groups and positive when the first group is higher", () => {
    expect(cohensD([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 6);
    expect(cohensD([4, 5, 6], [1, 2, 3])).toBeGreaterThan(0);
  });
});

describe("bandReport", () => {
  const near = band("low", 0.2, [5, 8, 10, 12]);
  const mid = band("mid", 0.5, [30, 33, 35, 38]);
  const far = band("high", 0.85, [60, 63, 66, 70]);

  it("scores seed distance as 1 − cosine, matching PoolCore", () => {
    const report = bandReport(SEED, [near]);
    // 1 − cos of 5/8/10/12°, averaged
    const expected = [5, 8, 10, 12].reduce((s, d) => s + (1 - Math.cos((d * Math.PI) / 180)), 0) / 4;
    expect(report.bands[0]!.meanSeedDist).toBeCloseTo(expected, 9);
  });

  it("reports a perfect headline for cleanly separated, monotonic bands", () => {
    const report = bandReport(SEED, [near, mid, far]);
    expect(report.monotonic).toBe(true);
    expect(report.adjacentAuc).toBe(1);
    for (const pair of report.pairs) expect(pair.auc).toBe(1);
  });

  it("falls to chance when the bands collapse into each other", () => {
    const collapsed = [band("low", 0.2, [30, 33, 35, 38]), band("mid", 0.5, [30, 33, 35, 38]), band("high", 0.85, [30, 33, 35, 38])];
    const report = bandReport(SEED, collapsed);
    expect(report.adjacentAuc).toBeCloseTo(0.5, 6);
    expect(report.monotonic).toBe(false);
  });

  it("drops below chance when strangeness runs backwards", () => {
    const report = bandReport(SEED, [band("low", 0.2, [60, 63, 66, 70]), band("high", 0.85, [5, 8, 10, 12])]);
    expect(report.adjacentAuc).toBe(0);
    expect(report.monotonic).toBe(false);
  });

  it("orders bands by strangeness regardless of input order", () => {
    const report = bandReport(SEED, [far, near, mid]);
    expect(report.bands.map((b) => b.label)).toEqual(["low", "mid", "high"]);
    expect(report.adjacentAuc).toBe(1);
  });

  it("marks only consecutive band pairs as adjacent, but reports all of them", () => {
    const report = bandReport(SEED, [near, mid, far]);
    expect(report.pairs).toHaveLength(3);
    expect(report.pairs.filter((p) => p.adjacent).map((p) => `${p.from}->${p.to}`)).toEqual(["low->mid", "mid->high"]);
    expect(report.pairs.find((p) => !p.adjacent)).toMatchObject({ from: "low", to: "high" });
  });

  it("tracks parse yield against what was requested", () => {
    const report = bandReport(SEED, [band("low", 0.2, [5, 8], 24)]);
    expect(report.bands[0]!).toMatchObject({ parsed: 2, requested: 24 });
    expect(report.bands[0]!.yield).toBeCloseTo(2 / 24, 9);
  });

  it("measures within-band near-duplication against the pool's dedupe threshold", () => {
    const identical = bandReport(SEED, [band("low", 0.2, [10, 10, 10])]);
    expect(identical.bands[0]!.nearDuplicateRate).toBe(1);

    const spread = bandReport(SEED, [band("low", 0.2, [0, 45, 90])]);
    expect(spread.bands[0]!.nearDuplicateRate).toBe(0);
  });

  it("measures how much of a band was parroted back from the few-shot examples", () => {
    // Small models copy the exemplars in src/generation.ts verbatim, which
    // looks like on-brief output and is actually the prompt being read back.
    const sample: BandSample = {
      label: "high",
      strangeness: 0.85,
      requested: 4,
      texts: ["fire-escape vineyard", "Sewer-Grate Mushroom Farm", "something original", "another original"],
      embeddings: [vec(10), vec(20), vec(30), vec(40)],
    };
    const report = bandReport(SEED, [sample], {
      exemplars: ["fire-escape vineyard", "sewer-grate mushroom farm", "pigeon-assisted pollination"],
    });
    expect(report.bands[0]!.echoRate).toBeCloseTo(0.5, 9);
  });

  it("reports a zero echo rate when no exemplars are supplied", () => {
    expect(bandReport(SEED, [near]).bands[0]!.echoRate).toBe(0);
  });

  it("survives a band the model returned nothing for", () => {
    const report = bandReport(SEED, [band("low", 0.2, [], 24), mid]);
    expect(report.bands[0]!.parsed).toBe(0);
    expect(report.bands[0]!.meanSeedDist).toBeNaN();
    expect(report.pairs[0]!.auc).toBeNaN();
    expect(report.adjacentAuc).toBeNaN();
  });

  it("rejects an empty run and yields no headline from a single band", () => {
    expect(() => bandReport(SEED, [])).toThrow(/no bands/i);
    expect(bandReport(SEED, [near]).pairs).toEqual([]);
    expect(bandReport(SEED, [near]).adjacentAuc).toBeNaN();
  });
});
