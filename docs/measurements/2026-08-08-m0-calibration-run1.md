# M0 calibration — run 1

**Date:** 2026-08-08 · **Tree:** da251ee · **Cost:** 54 Workers AI requests

Produced by `npm run board-calibrate`. Raw output, unedited.

```

cost estimate: up to 54 Workers AI requests (3 embeddings to reach the gate, then up to 51 more: 18 for the fan-out sweep, up to 33 for the chains).

urban gardening  ->  a physical object you can touch
  movement AUC (genuine vs non-sequitur): 0.040
  mean tether  genuine 0.515  non-seq 0.392

tool libraries  ->  a surreal, dreamlike version
  movement AUC (genuine vs non-sequitur): 0.840
  mean tether  genuine 0.456  non-seq 0.440

security awareness training  ->  a mystical or magical practice
  movement AUC (genuine vs non-sequitur): 0.480
  mean tether  genuine 0.438  non-seq 0.375

=== TETHER_FLOOR ===
  separation AUC        0.853   (gate: >= 0.80)
  genuine tethers (n=15)  p05 interpolated 0.400   observed minimum 0.394   p50 0.463
  non-seq tethers (n=15)  p50 0.400   p95 0.478
  proposed TETHER_FLOOR 0.400  = the linear-interpolated 5th percentile of the
                        GENUINE tethers. Not their minimum: a floor at the minimum
                        retains 100% by construction and moves with one bad probe.
    genuine retention at that floor:  93% (14/15) of genuine rewrites survive
    non-sequitur admission:           53% (8/15) of non-sequiturs survive
  caveat: 15 hand-written genuine samples. p05 interpolates between the 1st and
          2nd order statistics at this size, so it is still sensitive to a single bad
          probe. Widen PROBES before treating this number as precise.

=== ARRIVAL_COSINE ===
  genuine-rewrite cosine to phrase: p50 0.432  p95 0.578  max 0.579
  proposed ARRIVAL_COSINE 0.628  (above the interpolated p95, so a normal hop
                          never false-reports arrival)

=== GATE ===
  separation AUC 0.853 >= 0.80  ->  PASS
  spent so far: 3 requests. Continuing will spend up to 51 more
  (18 for the fan-out sweep, up to 33 for the chains).

=== CANDIDATES_PER_HOP ===
  criterion: recommend the SMALLEST n where EVERY probe leaves at least
             3 candidates above the tether floor. 3 rather than 1 because
             production's selectChild then drops near-duplicates of the lineage's
             own history (DEDUPE_COSINE = 0.92), so a hop needs spares — and
             because "at least one survived" saturates immediately and cannot
             discriminate between widths at all.
  candidates are parsed by production's parseCandidateList, which dedupes
  case-insensitively and enforces the 5-word / 64-char caps, so "parsed" is
  usually below n. That is the real width a hop gets.
  n= 4  parsed 4/4/4   survivors 3/4/4 (mean 3.7, min 3)   probes with >=1: 3/3   argmax lift over mean +0.079
  n= 8  parsed 8/8/8   survivors 7/8/7 (mean 7.3, min 7)   probes with >=1: 3/3   argmax lift over mean +0.102
  n=12  parsed 12/12/12   survivors 11/12/11 (mean 11.3, min 11)   probes with >=1: 3/3   argmax lift over mean +0.091
  RECOMMENDATION: CANDIDATES_PER_HOP = 4
    smallest tested n where every probe kept >= 3 candidates above the floor.
    going to n=8 adds 3.7 survivors per hop on average — still scaling, so a wider sweep may be worth measuring.

=== CHAIN PROGRESSION ===
  5 sequential hops per probe, 8 candidates each, same station phrase every hop.
  The child is chosen by production's selectChild: argmax score among candidates
  with tether >= 0.400 that do not exceed DEDUPE_COSINE 0.92 against anything
  already in the lineage. The prompt also receives the lineage's texts as its
  exclusion list, exactly as the BoardDO hop does.
  "moved" is 1 - cosine(child, its own parent): the hop's actual size.
  CAVEAT: moved is structurally capped at 1 - TETHER_FLOOR = 0.600. Hop size and
  the floor are NOT independent variables — raising the floor mechanically shrinks
  the largest hop this test can ever observe, and shrinks this threshold with it.

  urban gardening  ->  a physical object you can touch
    hop 0  cos-to-phrase 0.466                        "urban gardening"  (seed)
    hop 1  cos-to-phrase 0.562 (+0.097)  moved 0.402  "watering can"
    hop 2  cos-to-phrase 0.535 (-0.027)  moved 0.468  "rake handle"
    hop 3  cos-to-phrase 0.517 (-0.018)  moved 0.448  "gardening glove"
    hop 4  cos-to-phrase 0.459 (-0.058)  moved 0.519  "hose nozzle"
    hop 5  cos-to-phrase 0.476 (+0.017)  moved 0.542  "garden fork"
    trajectory  0.562  0.535  0.517  0.459  0.476
    mean per-hop increase +0.002   mean moved 0.476   monotonic: no

  tool libraries  ->  a surreal, dreamlike version
    hop 0  cos-to-phrase 0.401                        "tool libraries"  (seed)
    hop 1  cos-to-phrase 0.658 (+0.257)  moved 0.353  "surreal toolbox"
    hop 2  cos-to-phrase 0.541 (-0.117)  moved 0.489  "phantasmagoric pliers"
    hop 3  cos-to-phrase 0.546 (+0.005)  moved 0.532  "dream wrench"
    hop 4  cos-to-phrase 0.534 (-0.012)  moved 0.571  "fantastical torque driver"
    hop 5  cos-to-phrase 0.532 (-0.002)  moved 0.540  "phantasmal pliers"
    trajectory  0.658  0.541  0.546  0.534  0.532
    mean per-hop increase +0.026   mean moved 0.497   monotonic: no

  security awareness training  ->  a mystical or magical practice
    hop 0  cos-to-phrase 0.415                        "security awareness training"  (seed)
    hop 1  cos-to-phrase 0.608 (+0.193)  moved 0.589  "digital divination"
    hop 2  cos-to-phrase 0.575 (-0.033)  moved 0.373  "virtual voodoo"
    hop 3  cos-to-phrase 0.625 (+0.050)  moved 0.421  "machine magic"
    hop 4  cos-to-phrase 0.607 (-0.018)  moved 0.474  "cyber mysticism"
    hop 5  cos-to-phrase 0.551 (-0.056)  moved 0.445  "code sorcery"
    trajectory  0.608  0.575  0.625  0.607  0.551
    mean per-hop increase +0.027   mean moved 0.460   monotonic: no

  --- chain progression summary ---
  chains completing all 5 hops:  3/3
  chains that broke:              0/3
  mean per-hop increase in cos-to-phrase:  +0.018  (over 15 hops of complete chains)
  per-hop movement:  mean 0.478   median 0.474   (structural cap 0.600)
  monotonically increasing trajectories:   0/3

  verdict rule — all three terms required:
    1. mean per-hop increase in cos-to-phrase > 0
    2. mean per-hop movement >= 0.150
       = 25% of the structural headroom (1 - TETHER_FLOOR = 0.600).
       WHY 25%: the floor caps a hop at 0.600; a hop using under a quarter of
       that is a nudge, and 5 of them leave a card still reading as its seed.
       Without this term a chain advancing +0.001 per hop counts as PROGRESS —
       which is exactly the crawl this section exists to detect. The 25% is a
       judgement call, not a measurement: disagree with it by changing
       MIN_HOP_MOVE_FRACTION, and note it moves when TETHER_FLOOR moves.
    3. at least 2 of 3 trajectories monotonic
  terms: [pass] delta +0.018   [pass] movement 0.478 vs 0.150   [FAIL] monotonic 0/3 vs 2
  VERDICT: chains DO NOT PROGRESS on this measurement.
  The failing term(s) are marked above. This test measures the trajectory that
  selection produced; it does not isolate a cause, so do not record one. Whether
  the fix is a magnitude term in the score, a per-hop minimum move, a different
  fan-out, or a different prompt is a separate question and a separate experiment.
```
