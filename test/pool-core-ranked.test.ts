import { describe, expect, it } from "vitest";
import { PoolCore } from "../src/pool-core";
import type { BucketKey } from "../src/types";

function core(): PoolCore {
  const c = (text: string, bucket: BucketKey, embedding: number[], seedDist = 0.5) => ({ text, bucket, embedding, seedDist, generatedAt: 1 });
  return new PoolCore({
    candidates: [
      c("alpha", "w0a0", [1, 0]),
      c("beta", "w1a1", [0.9, 0.1]),
      c("gamma", "w2a0", [0, 1]),
      c("delta", "w2a1", [0.95, 0.05]),
    ],
  });
}

describe("PoolCore.drawRanked (the ground's draw)", () => {
  it("ranks across every bucket and reports each word's own tier", () => {
    const p = core();
    const served = p.drawRanked((c) => c.embedding[0]!, 2, 10);
    expect(served.map((s) => s.text)).toEqual(["alpha", "delta"]);
    expect(served.map((s) => s.tier)).toEqual([0, 2]);
  });

  it("consumes what it serves, like draw()", () => {
    const p = core();
    p.drawRanked((c) => c.embedding[0]!, 2, 10);
    const again = p.drawRanked((c) => c.embedding[0]!, 4, 11);
    expect(again.map((s) => s.text)).toEqual(["beta", "gamma"]);
    expect(p.drawRanked(() => 1, 4, 12)).toEqual([]);
  });

  it("skips visible words by normalised text and never throws on an empty pool", () => {
    const p = core();
    const served = p.drawRanked((c) => c.embedding[0]!, 1, 10, new Set(["alpha"]));
    expect(served[0]!.text).toBe("delta");
    expect(new PoolCore().drawRanked(() => 1, 5, 0)).toEqual([]);
  });

  it("leaves draw() behaviour for other buckets untouched", () => {
    const p = core();
    p.drawRanked((c) => (c.text === "gamma" ? 1 : 0), 1, 10);
    expect(p.draw("w0a0", 5, 11).map((s) => s.text)).toEqual(["alpha"]);
    expect(p.draw("w2a0", 5, 11)).toEqual([]);
  });

  it("drops non-finite scores rather than ranking them", () => {
    const p = core();
    const served = p.drawRanked((c) => (c.text === "alpha" ? NaN : 1), 4, 10);
    expect(served.map((s) => s.text)).not.toContain("alpha");
  });
});
