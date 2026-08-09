# M0 calibration — run 2 (corrected belt walk)

**Date:** 2026-08-08 · **Tree:** 3b16dc9 · **Cost:** 43 Workers AI requests

Supersedes run 1 for the chain section only. Run 1 walked five hops through ONE
station, a move the belt cannot make. Sections 1-3 are unchanged and reproduce.

```

cost estimate: up to 43 Workers AI requests (3 embeddings to reach the gate, then up to 40 more: 18 for the fan-out sweep, up to 22 for the belt walk — 3 station expansions, 1 embedding for the phrases and seeds, and 2 per hop over 3 chains x 3 stations).

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
  spent so far: 3 requests. Continuing will spend up to 40 more
  (18 for the fan-out sweep, up to 22 for the chains).

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
  n= 4  parsed 4/4/4   survivors 3/4/4 (mean 3.7, min 3)   probes with >=1: 3/3   argmax lift over mean +0.089
  n= 8  parsed 8/8/8   survivors 8/8/7 (mean 7.7, min 7)   probes with >=1: 3/3   argmax lift over mean +0.076
  n=12  parsed 12/11/12   survivors 11/11/11 (mean 11.0, min 11)   probes with >=1: 3/3   argmax lift over mean +0.142
  RECOMMENDATION: CANDIDATES_PER_HOP = 4
    smallest tested n where every probe kept >= 3 candidates above the floor.
    going to n=8 adds 4.0 survivors per hop on average.
    Survivor count is still rising with width. That does NOT argue for a larger n:
    the criterion is a SUFFICIENCY threshold, not a maximum, and n=4 already
    clears it — the extra survivors at n=8 are spares nothing asked for. A wider
    sweep is worth measuring only if you raise MIN_SURVIVORS_PER_HOP above 3.
  CAVEAT — sample size: ONE generation draw per (width, probe) pair, i.e. 3 samples
  per width, at production's REWRITE_TEMPERATURE (0.9 — deliberately high, for
  variety). Survivor counts at a given width WILL move run to run. Read the
  recommendation as "this width sufficed on one draw", not as a stable estimate,
  and note that the tether section states its own sample caveat separately — this
  one is not covered by it.

=== CHAIN DEVELOPMENT ===
  3 chains. Each is ONE seed passed through 3 stations in order, a DIFFERENT
  target at every hop, each station used exactly once — the only shape the belt
  can produce. 8 candidates per hop.
  The child is chosen by production's selectChild: argmax score among candidates
  with tether >= 0.400 that do not exceed DEDUPE_COSINE 0.92 against anything
  already in the lineage. The prompt also receives the lineage's texts as its
  exclusion list, exactly as the BoardDO hop does.
  NOTE: an earlier version of this section re-applied ONE station phrase five
  times. That is a move the belt cannot make, and its flat cos-to-phrase
  trajectory was largely the first hop exhausting the only station on offer.

  stations, expanded by production's expandPole:
    "concretize"  ->  "a tangible real world thing"
    "make strange"  ->  "an unusual or unconventional thing"
    "ground it"  ->  "a physical reality check"

  metrics. cos-to-phrase is NOT comparable across hops here, because the phrase
  changes every hop — a rising or falling trajectory of it would mean nothing and
  is not reported. What IS well defined:
    gain     cos(card_k, phrase_k) - cos(card_k-1, phrase_k). Did THIS hop move the
             card toward the station it was passing? Each station gets exactly one
             chance at a card, so this is the per-hop question the board asks.
    moved    1 - cos(card_k, card_k-1): the hop's actual size.
             CAVEAT: structurally capped at 1 - TETHER_FLOOR = 0.600. Hop size and the
             floor are NOT independent variables — raising the floor mechanically
             shrinks the largest hop observable here, and the threshold with it.
    travel   1 - cos(final card, seed): how far the whole belt carried the card
             from where it started. The develop-or-circle number.
  And the chain texts. Whether a card DEVELOPED or merely toured three directions
  is a reading, not a number; the texts below are the evidence for it and they
  outrank every statistic in this section.

  seed: "urban gardening"
    station 1 "concretize"  gain -0.012 (0.514 -> 0.502)  moved 0.592  "rake"
    station 2 "make strange"  gain +0.050 (0.447 -> 0.497)  moved 0.539  "storm whistle"
    station 3 "ground it"  gain +0.222 (0.441 -> 0.663)  moved 0.595  "fence post reality"
    chain: "urban gardening"  ->  "rake"  ->  "storm whistle"  ->  "fence post reality"
    travel from seed 0.606   largest single hop 0.595   accumulates: yes

  seed: "tool libraries"
    station 1 "concretize"  gain -0.066 (0.512 -> 0.447)  moved 0.552  "welding helmets"
    station 2 "make strange"  gain +0.012 (0.419 -> 0.431)  moved 0.527  "taxidermy earrings"
    station 3 "ground it"  gain +0.112 (0.371 -> 0.483)  moved 0.510  "bead and bone calipers"
    chain: "tool libraries"  ->  "welding helmets"  ->  "taxidermy earrings"  ->  "bead and bone calipers"
    travel from seed 0.523   largest single hop 0.552   accumulates: no

  seed: "security awareness training"
    station 1 "concretize"  gain +0.115 (0.418 -> 0.532)  moved 0.442  "incident reports"
    station 2 "make strange"  gain +0.123 (0.540 -> 0.663)  moved 0.434  "bizarre occurrence forms"
    station 3 "ground it"  gain +0.227 (0.464 -> 0.691)  moved 0.516  "reality checklist forms"
    chain: "security awareness training"  ->  "incident reports"  ->  "bizarre occurrence forms"  ->  "reality checklist forms"
    travel from seed 0.609   largest single hop 0.516   accumulates: yes

  --- chain development summary ---
  chains passing all 3 stations:  3/3
  chains that broke:            0/3
  hops that moved the card toward their own station (gain >= 0.020):  67% (6/9)
  mean gain per hop:  +0.087   (over 9 hops of complete chains)
  per-hop movement:  mean 0.523   median 0.527   (structural cap 0.600)
  travel from seed:  0.606  0.523  0.609   mean 0.580
  chains ending further from the seed than their own largest hop:  2/3

  verdict rule — all three terms required, over complete chains only:
    1. STATION SUCCESS: at least 67% of hops (6 of 9) gained >= 0.020
       against THEIR OWN station. A station gets exactly one chance at a card, so
       a station that fails to move it is not a slow station, it is a dud; two
       thirds tolerates one dud leg in three and no more.
       The 0.020 is a MAGNITUDE on purpose. A sign-only term ("gain > 0")
       passes a hop that gained +0.0001 and prints it as a success, which is the
       crawl in a different coordinate. 0.020 sits about an order of magnitude
       below the first-hop gains a working station produced in run 1 (+0.097 to
       +0.257), so it excludes noise-scale change without demanding a strong hop
       every time. Judgement call: disagree by changing MIN_STATION_GAIN.
    2. HOP SIZE: mean per-hop movement >= 0.150
       = 25% of the structural headroom (1 - TETHER_FLOOR = 0.600).
       WHY 25%: the floor caps a hop at 0.600; a hop using under a quarter of
       that is a nudge, and 3 of them leave a card still reading as its seed.
       Judgement call, not a measurement: disagree by changing
       MIN_HOP_MOVE_FRACTION, and note it moves when TETHER_FLOOR moves.
    3. ACCUMULATION: at least 2 of the 3 complete chains ended FURTHER from
       their seed than their own largest single hop. This is the develop-or-circle
       term and it needs no threshold of its own: a chain that doubled back lands
       within one hop's reach of the seed however big its hops were, and fails;
       a chain that kept going cannot. Disagree by changing ACCUMULATING_REQUIRED.
    NOT MEASURED: whether the development is any GOOD. No number here distinguishes
    a card that grew into something from one that was merely dragged somewhere
    else. Read the chain texts above for that and do not let these three terms
    stand in for the reading.
  terms: [pass] stations 6/9 vs 6   [pass] movement 0.523 vs 0.150   [pass] accumulation 2/3 vs 2
  VERDICT: chains DEVELOP on this measurement.
```
