// Does a model actually keep the strangeness bands apart?
//
// The generation prompt asks for bands that are contrastive — "an item
// generated at one strangeness should feel out of place at the others"
// (src/generation.ts). That is a claim about geometry, so it is measurable:
// embed each band's output, score every word by its distance from the seed,
// and ask how reliably a word from the stranger band outranks a word from the
// nearer one. That probability is the AUC.
//
// The failure this exists to catch is band collapse — a model that emits
// pleasant words at every setting but ignores the strangeness parameter, so
// all three tiers land on top of each other and the dewpoint slider does
// nothing. Collapse reads as AUC ~0.5 while the words still look fine, which
// is exactly why eyeballing the output is not enough.

import { auc, cohensD } from "./metrics";
import { cosineSim } from "./pool-core";
import { DEDUPE_COSINE } from "./types";

export interface BandSample {
  label: string;
  strangeness: number;
  /** How many candidates were asked for, so parse failures stay visible. */
  requested: number;
  texts: string[];
  embeddings: number[][];
}

export interface BandStats {
  label: string;
  strangeness: number;
  requested: number;
  parsed: number;
  /** parsed / requested — a model that cannot emit a JSON array fails here first. */
  yield: number;
  meanSeedDist: number;
  sdSeedDist: number;
  /** Share of within-band pairs closer than the pool's dedupe threshold. High
   *  values mean the pool would reject most of this batch as near-duplicates. */
  nearDuplicateRate: number;
  /** Share of the band repeated verbatim from the few-shot examples. Small
   *  models parrot the exemplars, which reads as on-brief output but is really
   *  the prompt coming back — and it is invisible to the AUC, because the
   *  exemplars sit at the right strangeness by construction. */
  echoRate: number;
}

export interface BandPair {
  from: string;
  to: string;
  /** True for consecutive bands. Collapse shows up between neighbours first —
   *  a model can separate low from high while smearing mid across both. */
  adjacent: boolean;
  auc: number;
  cohensD: number;
}

export interface BandReport {
  /** Sorted by strangeness ascending, whatever order the samples arrived in. */
  bands: BandStats[];
  pairs: BandPair[];
  /** Does mean seed distance rise with every step up in strangeness? */
  monotonic: boolean;
  /** The headline: mean AUC over adjacent band pairs. NaN if any band is empty. */
  adjacentAuc: number;
}

/** Same definition as PoolCore's stored `seedDist` (src/pool-core.ts), so the
 *  spike measures the quantity the product actually scores on. */
function seedDistances(seedEmbedding: number[], embeddings: number[][]): number[] {
  return embeddings.map((e) => 1 - cosineSim(seedEmbedding, e));
}

function meanOf(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const mu = meanOf(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
}

function nearDuplicateRate(embeddings: number[][]): number {
  if (embeddings.length < 2) return 0;
  let pairs = 0;
  let dupes = 0;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      pairs++;
      if (cosineSim(embeddings[i]!, embeddings[j]!) > DEDUPE_COSINE) dupes++;
    }
  }
  return dupes / pairs;
}

export interface BandReportOptions {
  /** Phrases the prompt already showed the model; matched case-insensitively. */
  exemplars?: Iterable<string>;
}

export function bandReport(
  seedEmbedding: number[],
  samples: BandSample[],
  options: BandReportOptions = {},
): BandReport {
  if (samples.length === 0) throw new Error("bandReport: no bands to report on");

  const exemplars = new Set([...(options.exemplars ?? [])].map((t) => t.trim().toLowerCase()));
  const echoRate = (texts: string[]) =>
    texts.length === 0 || exemplars.size === 0
      ? 0
      : texts.filter((t) => exemplars.has(t.trim().toLowerCase())).length / texts.length;

  const ordered = [...samples].sort((a, b) => a.strangeness - b.strangeness);
  const distances = ordered.map((s) => seedDistances(seedEmbedding, s.embeddings));

  const bands: BandStats[] = ordered.map((sample, i) => ({
    label: sample.label,
    strangeness: sample.strangeness,
    requested: sample.requested,
    parsed: sample.texts.length,
    yield: sample.requested === 0 ? NaN : sample.texts.length / sample.requested,
    meanSeedDist: meanOf(distances[i]!),
    sdSeedDist: stdDev(distances[i]!),
    nearDuplicateRate: nearDuplicateRate(sample.embeddings),
    echoRate: echoRate(sample.texts),
  }));

  const pairs: BandPair[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.push({
        from: ordered[i]!.label,
        to: ordered[j]!.label,
        adjacent: j === i + 1,
        // the stranger band is the positive class: it should sit farther out
        auc: auc(distances[j]!, distances[i]!),
        cohensD: cohensD(distances[j]!, distances[i]!),
      });
    }
  }

  const monotonic = bands.every(
    (b, i) => i === 0 || (Number.isFinite(b.meanSeedDist) && b.meanSeedDist > bands[i - 1]!.meanSeedDist),
  );

  const adjacent = pairs.filter((p) => p.adjacent);
  const adjacentAuc = adjacent.length === 0 ? NaN : meanOf(adjacent.map((p) => p.auc));

  return { bands, pairs, monotonic, adjacentAuc };
}
