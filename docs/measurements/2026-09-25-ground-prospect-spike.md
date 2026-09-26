# Ground, prospect only — the re-ranking spike, round 2

**Date:** 2026-09-25 · **Branch:** `ground-prospect-only` · **Cost so far:** 0 Workers AI requests
**Script:** `npm run ground-prospect-spike` ([scripts/ground-prospect-spike.ts](../../scripts/ground-prospect-spike.ts)). Its pure parts, including the pre-registered `PROSPECT_PASS`, are in [scripts/ground-prospect-judge.ts](../../scripts/ground-prospect-judge.ts), tested by `test/ground-prospect-judge.test.ts`. Shared plumbing is in [scripts/ground-harness.ts](../../scripts/ground-harness.ts), and shared judge helpers in [scripts/ground-judge.ts](../../scripts/ground-judge.ts).
**Design:** [2026-09-24-sky-and-ground-design.md](../superpowers/specs/2026-09-24-sky-and-ground-design.md), Appendix B · **Previous run:** [2026-09-24-sky-and-ground-spike.md](2026-09-24-sky-and-ground-spike.md) (INVALID)

## Verdict: **PENDING — not yet run against Workers AI**

Nothing in this repo should cite the prospect gesture as validated until the "Real run" section below is filled in.

## Why this spike exists

The first ground spike came back **INVALID**: its bridge judge answered by position. The design went back to spec §2, and the run narrowed it:
- the bridge is dropped;
- threads are arrangement only;
- prospect is the remaining candidate.

The first run's attribution reading (13/18) is **not** this spike's evidence. That run's verdict came from a combined gate, and reusing its data to validate a split chosen afterwards would be post-hoc. So this spike uses fresh data under bars registered before any real run.

## The assumption under test

Prospecting beside a cluster of pinned words **re-ranks the pool the SessionDO already holds**, with no inference on the gesture path. That only works if a reader can tell which cluster the condensed words appeared beside. It has to hold even when a neighbouring cluster sits on an adjacent sub-theme, and without every cluster pulling the same central words (hubness).

## Method

- **Pool.** For each seed, `generateCandidates` runs over the six production bands × 24. Candidates are embedded with `@cf/baai/bge-m3` and deduped at `DEDUPE_COSINE`, then loaded into a real `PoolCore` with their real `seedDist` and bucket. No anchors are used in generation, the harder case. This is the same construction as the first spike, now shared through `scripts/ground-harness.ts`.
- **Ground.** Three **fresh** seeds: `gardening`, `running`, `learning a language`. None of them was in the first run. Each has three hand-written groups of three notes, committed in the script.
  - **The hard case.** In every seed, groups 1 and 3 sit on **neighbouring sub-themes** that a reader could plausibly confuse, and group 2 is the odd one out:

    | seed | group 1 | group 3 |
    | --- | --- | --- |
    | gardening | compost and soil | feeding the plants |
    | running | training | racing |
    | learning a language | vocabulary | grammar |

  - The neighbours are laid out as the two **outer** clusters, 800 units apart, and the odd group sits in the middle, 400 from each. `NEIGHBOR_RADIUS` is 240, so each prospect reaches only its own cluster. A prospect that does not plan `near` on its own cluster alone makes the run INVALID.
- **The shipped path, end to end.** `planProspect` (neighbourhood with Gaussian weights) → `planScore` → `PoolCore.drawRanked`, consuming. There are two bursts per cluster (ranks 1–5, then 6–10), so the second burst is what a second prospect at the same spot would get.
- **Judge.** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` at temperature 0.1, blind forced choice, using the same prompt (`attributeMessages`) and parser (`parsePick`) as the first spike.
  - Option order is shuffled per trial with a fixed seed.
  - A malformed answer is retried once, then **counted as a miss**. Misses are never dropped from n.
- **Trials.** 18 attribution trials: 3 seeds × 3 clusters × 2 bursts. The judge sees the three groups plus the 5 condensed words, and names the group they appeared beside. Chance is 1/3. Twelve of the 18 trials are at a neighbouring group.
- **Validity gate.** Because option order is shuffled, a content-driven judge's answers are uniform over positions. If one displayed position takes ≥ 12 of the 18 answers, the run is **INVALID**, not PASS or FAIL. The false-INVALID rate for a content-driven judge is exactly **0.0118**: two positions cannot both reach 12 of 18, so it equals 3 × P(Binomial(18, 1/3) ≥ 12).
- **Diagnostics, not verdicts.**
  - Attribution on the 12 neighbouring-group trials, and how many of their misses went to the sibling group.
  - Top-10 Jaccard for the neighbouring pair.
  - The echo rate: steered words that are near-duplicates of a note.

## Pre-registered bars

Fixed in `scripts/ground-prospect-judge.ts` (`PROSPECT_PASS`) and committed in `27a978a` **before any real run**. Changing them after data exists requires a commit that says so, and Cory's sign-off.

| | bar | tail under chance (exact) |
| --- | --- | --- |
| attribution | ≥ 11 / 18 | P(X ≥ 11 \| n=18, p=1/3) = 0.0144 |
| hubness | mean top-10 Jaccard over the **non-neighbour** pairs ≤ 0.25 | — |
| validity | no position ≥ 12 / 18 | 0.0118 false-INVALID |

`test/ground-prospect-judge.test.ts` asserts both tail values to four decimal places.

**One deliberate change from the first spike's bars.** The Jaccard bar averages only the two **non-neighbour** group pairs per seed. The neighbouring pair shares a sub-theme by design, so its overlap is expected and is not hubness; it is printed as a diagnostic. Attribution keeps all 18 trials, the hard case included. The 13/18 from well-separated groups in the first run therefore does not predict this result.

## Cost and how to run

**Expected cost:** 18 generation + ~9 embedding + 18 judge = **~45 requests**, or up to 63 if every judge call retries. The run hard-stops at `--max-requests=70`. Of the 150-request budget across all spikes, 64 are already spent (63 in the first run and 1 probe), which leaves 86.

```sh
source ~/.zshenv; export CLOUDFLARE_ACCESS_CLIENT_ID CLOUDFLARE_ACCESS_CLIENT_SECRET   # pause WARP first
npm run ground-prospect-spike -- --binding
```

`--binding` uses wrangler's remote AI binding: the OAuth login plus the Access service token, and no API token. The REST path (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, exported) also works.

## Real run (Workers AI)

_Pending. Paste the unedited output of the command above here, then write the verdict at the top._

## Offline plumbing run (`--fake`)

This run proves the harness works end to end: pool build, dedupe, the shipped prospect path, consumption, the neighbour layout (all 9 prospects planned `near` on their own cluster), trial construction, request accounting and the verdict. It uses `src/dev-fake-ai.ts` (hash embeddings, canned words that ignore the seed) and a **coin-flip judge**, so the numbers are meaningless by construction. The request count covers generation and embedding only, because the fake judge makes no calls. The output is deterministic: identical before and after the bridge de-scope.

```
ground prospect spike  model FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)
bands 6x24  prospect k=5  windows 1-5, 6-10  neighbours = groups 1 & 3  rng 0x9e05
expected requests: 18 generation + ~9 embedding + 18 judge (up to 36 with retries); hard cap 70

══════════════════════════════════════════════════════════════════════════════
seed "gardening"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 (neighbour) [first burst]  judge=group 2 ✗  cafeteria con-artist theater 2 · muscle memory · security fortune cookies 2 · shared vocabulary · gossip-powered honeypot 2
  prospect at group 1 (neighbour) [second burst]  judge=group 1 ✓  quiz with prizes · phishing drill 3 · compliance · play · threat-model tarot deck 2
  prospect at group 2 [first burst]  judge=group 2 ✓  poster contest 2 · curiosity 2 · password day · malware aquarium 2 · superstition 2
  prospect at group 2 [second burst]  judge=group 3 ✗  curiosity 3 · friendly rivalry 3 · monthly newsletter · two-minute mystery emails 2 · lanyard trading cards 2
  prospect at group 3 (neighbour) [first burst]  judge=group 2 ✗  baseline · street smarts 2 · social-engineering improv night 2 · poster contest · antibodies 3
  prospect at group 3 (neighbour) [second burst]  judge=group 2 ✗  hallway escape room 3 · myth-making · folk immunity 2 · reminders 3 · malware aquarium
  top-10 overlap (jaccard): non-neighbour pairs 0.026   neighbour pair 0.053

══════════════════════════════════════════════════════════════════════════════
seed "running"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 (neighbour) [first burst]  judge=group 2 ✗  social-engineering improv night 3 · password day 5 · apprenticeship of doubt 3 · incident tabletop game 5 · reminders 5
  prospect at group 1 (neighbour) [second burst]  judge=group 2 ✗  vigilance 4 · routine 5 · malware aquarium 3 · folk immunity 4 · breach museum field trip 4
  prospect at group 2 [first burst]  judge=group 3 ✗  dread as teacher 4 · myth-making 5 · ransomware campfire stories 3 · myth-making 4 · trust 4
  prospect at group 2 [second burst]  judge=group 2 ✓  recognition 3 · two-minute mystery emails 4 · curiosity 4 · near-miss stories 3 · recognition 4
  prospect at group 3 (neighbour) [first burst]  judge=group 3 ✓  repetition 5 · communal grooming 3 · haunted inbox exhibit 4 · repetition 4 · incident tabletop game 4
  prospect at group 3 (neighbour) [second burst]  judge=group 3 ✓  rituals 4 · play 4 · lanyard trading cards 4 · threat-model tarot deck 5 · vigilance 5
  top-10 overlap (jaccard): non-neighbour pairs 0.000   neighbour pair 0.053

══════════════════════════════════════════════════════════════════════════════
seed "learning a language"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 (neighbour) [first burst]  judge=group 2 ✗  report button 7 · bragging rights 6 · recognition 7 · shared vocabulary 5 · recognition 5
  prospect at group 1 (neighbour) [second burst]  judge=group 2 ✗  muscle memory 7 · vigilance 6 · superstition 8 · cafeteria con-artist theater 7 · curiosity 8
  prospect at group 2 [first burst]  judge=group 3 ✗  badge stickers 6 · cafeteria con-artist theater 6 · password day 8 · door-lock checks 5 · security mascot 8
  prospect at group 2 [second burst]  judge=group 1 ✗  baseline 7 · hallway escape room 7 · spot-the-fake wall 6 · routine 7 · communal grooming 7
  prospect at group 3 (neighbour) [first burst]  judge=group 3 ✓  apprenticeship of doubt 7 · routine 6 · folklore 7 · apprenticeship of doubt 5 · curiosity 6
  prospect at group 3 (neighbour) [second burst]  judge=group 3 ✓  two-minute mystery emails 6 · storytelling 6 · street smarts 6 · incident tabletop game 6 · trust 6
  top-10 overlap (jaccard): non-neighbour pairs 0.053   neighbour pair 0.053

══════════════════════════════════════════════════════════════════════════════
RESULT
  attribution   7/18 correct  (judged 18)  chance 1/3  P(X>=k)=0.3915   pass >= 11
    first burst: 3/9
    second burst: 4/9
    judge answers by position: 3/7/8   (INVALID at >= 12; P=0.0118 under a uniform judge)
  hubness       mean top-10 jaccard, non-neighbour pairs 0.026 (per seed 0.026, 0.000, 0.053)   pass <= 0.25
  neighbours    5/12 correct at the neighbouring groups; 0 of 7 misses went to the sibling   [diagnostic]
                neighbour-pair top-10 jaccard 0.053 (per seed 0.053, 0.053, 0.053)   [diagnostic]
  echo          0/90 steered words are near-duplicates (cos > 0.92) of a note  [diagnostic]

VERDICT: FAIL  — attribution 7/18 < 11 (0 unjudged)
requests spent: 27
```
