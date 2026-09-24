# Sky and ground — the re-ranking spike

**Date:** 2026-09-24 · **Tree:** `ideation-ground` (spike commit `cc3b7f6`) · **Cost so far:** 0 Workers AI requests
**Script:** `npm run ground-spike` ([scripts/ground-spike.ts](../../scripts/ground-spike.ts), pure parts in [scripts/ground-judge.ts](../../scripts/ground-judge.ts), tested by `test/ground-judge.test.ts`)
**Design:** [2026-09-24-sky-and-ground-design.md](../superpowers/specs/2026-09-24-sky-and-ground-design.md)

## Verdict: **PENDING — not yet run against Workers AI**

This measurement has not been taken, and nothing in this repo should cite the ground mechanic as validated until the section below is filled in.

**Why it has not run.** It was written in a cloud sandbox whose egress proxy refuses `api.cloudflare.com` (CONNECT 403) and which held no `CLOUDFLARE_*` credentials; the Hugging Face CDN was blocked too, so a local bge-m3 stand-in was not possible either. The script is committed ready to run; Cory is running it from Claude Code on his machine.

## The assumption under test

The ground design serves its two gestures by **re-ranking the pool the SessionDO already holds** — no inference on the gesture path. That only works if:

1. **Attribution** — different clusters of pinned words pull *recognisably different* words out of a seed-conditioned pool (the pool is not so homogeneous that every cluster retrieves the same "central" candidates — hubness), and
2. **Bridge** — ranking by `min(cos(c,A), cos(c,B))` surfaces a word a reader recognises as connecting A and B, rather than collapsing onto whichever end is more common in the pool.

If either fails, the ground is decoration and the design returns to the reimaginings (spec §2).

## Method

- **Pool**: per seed, `generateCandidates` over the six production bands (`TIER_STRANGENESS` × `ALT_ABSTRACTION`) × 24, embedded with `@cf/baai/bge-m3`, deduped at `DEDUPE_COSINE` — production parity, as `axis-power` does it. **No anchors** in generation: the app also conditions generation on pins, which can only help, so this is the harder case.
- **Ground**: three seeds (`public transit`, `home cooking`, `friendship`), each with three hand-written groups of three notes on distinct sub-themes. Committed in the script. Known bias: real clusters may be subtler.
- **Ranking**: the shipped functions — `queryVector`, `nearScore`, `bridgeScore`, `topK` from `src/ground-core.ts` — so the harness measures the code that ships (critic cycle 2's parity lesson).
- **Judge**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, temperature 0.1, forced choice, blind to method, option order shuffled with a fixed seed, malformed answers retried once then **counted as misses** (never dropped from n).
  - *attribution* (18 trials = 3 seeds × 3 groups × 2 windows): the judge sees the three groups and the 5 words ranked 1–5 (then 6–10) for one group, and names the group they appeared beside. Chance 1/3.
  - *control* (9 trials): 5 random pool words, a random "true" group. Expect ≈ 3/9. A control far above chance means the judge is keying on something other than the steering.
  - *bridge* (18 trials = 3 seeds × 3 threads × 2 ranks): the judge sees X, Y and three phrases — the bridge-ranked one, the best by closeness to X alone, the best by closeness to Y alone (distinct items) — and picks the one that connects both. Chance 1/3.
- **Diagnostics, not verdicts**: mean top-10 Jaccard between groups' retrievals (hubness), and the echo rate (steered words that are near-duplicates of a note). Workstream B showed cheap embedding statistics lack the power to grade a direction; these are printed to explain a result, not to decide it.

## Pre-registered pass bars

Fixed in `scripts/ground-judge.ts` (`PASS`) and committed **before any real run**. Changing them after seeing data requires a commit that says so.

| | bar | p under chance |
| --- | --- | --- |
| attribution | ≥ 11 / 18 | P(X ≥ 11 \| n=18, p=1/3) ≈ 0.012 |
| bridge | ≥ 10 / 18 | P(X ≥ 10 \| n=18, p=1/3) ≈ 0.033 |
| hubness | mean top-10 Jaccard ≤ 0.25 | — |

Expected cost: 18 generation + 9 embedding + 45 judge = **72 requests**, up to 117 with every judge call retried; hard stop at `--max-requests=120`. Budget for all spikes: 150.

## Real run (Workers AI)

_Pending. Paste the unedited output of_ `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run ground-spike` _here, then write the verdict above it._

## Offline plumbing run (`--fake`)

Proves the harness end to end — pool build, dedupe, ranking through the shipped functions, trial construction, request accounting, verdict — with `src/dev-fake-ai.ts` (hash embeddings, canned words that ignore the seed) and a **coin-flip judge**. The numbers are meaningless by construction, and it correctly FAILs. Request count covers generation and embedding only; the fake judge makes no calls.

```
ground spike  model FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)
bands 6x24  prospect k=5  windows 1-5, 6-10  rng 0x6d0d
expected requests: 18 generation + ~9 embedding + 45 judge (up to 90 with retries); hard cap 120

══════════════════════════════════════════════════════════════════════════════
seed "public transit"
  pool: 144 raw -> 144 kept at cosine > 0.92
  near group 1 [1-5]  judge=group 3 ✗  trust · myth-making 2 · two-minute mystery emails · haunted inbox exhibit 2 · street smarts
  near group 1 [6-10]  judge=group 2 ✗  lunch-and-learn 2 · near-miss stories · fake-invoice bake-off · shared vocabulary 2 · bragging rights 2
  near group 2 [1-5]  judge=group 3 ✗  security mascot 2 · staff CTF night · habit · report button 2 · vigilance 2
  near group 2 [6-10]  judge=group 3 ✗  cafeteria con-artist theater · lock-picking petting zoo · security mascot 3 · shared vocabulary · folklore 2
  near group 3 [1-5]  judge=group 2 ✗  haunted inbox exhibit · social-engineering improv night 2 · poster contest · hallway escape room 3 · phishing bingo
  near group 3 [6-10]  judge=group 3 ✓  phishing bingo 2 · fake-invoice bake-off · communal grooming · herd instinct 3 · friendly rivalry 3
  top-10 overlap between groups (mean jaccard): 0.018
  control 1  truth=group 3  judge=group 2  door-lock checks 2 · reminders 3 · tribal memory 2 · apprenticeship of doubt · antibodies 2
  control 2  truth=group 2  judge=group 2  staff CTF night 2 · habit · repetition 2 · repetition 3 · play 2
  control 3  truth=group 1  judge=group 2  tribal memory · antibodies 3 · phishing drill · near-miss stories 2 · street smarts 2
  thread "last train home" — "fare capping" rank 1: judge=bridge  [bridge: shared vocabulary 2 | nearX: lock-picking petting zoo | nearY: habit]
  thread "last train home" — "fare capping" rank 2: judge=near X  [bridge: habit | nearX: recognition | nearY: security mascot 2]
  thread "last train home" — "subway map typography" rank 1: judge=near X  [bridge: communal grooming | nearX: lock-picking petting zoo | nearY: security mascot]
  thread "last train home" — "subway map typography" rank 2: judge=near X  [bridge: compliance 2 | nearX: recognition | nearY: poster contest]
  thread "fare capping" — "subway map typography" rank 1: judge=bridge  [bridge: social-engineering improv night | nearX: habit | nearY: security mascot]
  thread "fare capping" — "subway map typography" rank 2: judge=near Y  [bridge: vigilance 2 | nearX: security mascot 2 | nearY: compliance 2]

══════════════════════════════════════════════════════════════════════════════
seed "home cooking"
  pool: 144 raw -> 144 kept at cosine > 0.92
  near group 1 [1-5]  judge=group 2 ✗  phishing bingo 4 · report button 4 · rituals 4 · phishing drill 5 · muscle memory 4
  near group 1 [6-10]  judge=group 1 ✓  lock-picking petting zoo 3 · monthly newsletter 4 · shared vocabulary 3 · myth-making 5 · monthly newsletter 3
  near group 2 [1-5]  judge=group 3 ✗  monthly newsletter 5 · myth-making 3 · gossip-powered honeypot 4 · trust 5 · communal grooming 5
  near group 2 [6-10]  judge=group 3 ✗  lanyard trading cards 3 · tribal memory 4 · malware aquarium 5 · threat-model tarot deck 4 · gossip-powered honeypot 5
  near group 3 [1-5]  judge=group 2 ✗  staff CTF night 5 · staff CTF night 4 · malware aquarium 5 · repetition 4 · phishing bingo 4
  near group 3 [6-10]  judge=group 3 ✓  fake-invoice bake-off 4 · play 4 · door-lock checks 3 · threat-model tarot deck 4 · repetition 5
  top-10 overlap between groups (mean jaccard): 0.055
  control 1  truth=group 1  judge=group 2  poster contest 5 · vigilance 3 · routine 4 · herd instinct 5 · social-engineering improv night 4
  control 2  truth=group 2  judge=group 3  poster contest 4 · spot-the-fake wall 4 · lock-picking petting zoo 3 · folk immunity 4 · dread as teacher 3
  control 3  truth=group 3  judge=group 3  friendly rivalry 4 · hallway escape room 4 · lanyard trading cards 4 · welcome-back training 4 · cafeteria con-artist theater 4
  thread "grandmother's recipe cards" — "meal prep containers" rank 1: judge=near Y  [bridge: trust 5 | nearX: phishing bingo 4 | nearY: tribal memory 4]
  thread "grandmother's recipe cards" — "meal prep containers" rank 2: judge=near X  [bridge: poster contest 4 | nearX: myth-making 5 | nearY: folklore 4]
  thread "grandmother's recipe cards" — "knife skills" rank 1: judge=near Y  [bridge: breach museum field trip 4 | nearX: phishing bingo 4 | nearY: badge stickers 3]
  thread "grandmother's recipe cards" — "knife skills" rank 2: judge=near Y  [bridge: phishing bingo 4 | nearX: myth-making 5 | nearY: staff CTF night 4]
  thread "meal prep containers" — "knife skills" rank 1: judge=near X  [bridge: badge stickers 3 | nearX: tribal memory 4 | nearY: staff CTF night 4]
  thread "meal prep containers" — "knife skills" rank 2: judge=near X  [bridge: myth-making 3 | nearX: folklore 4 | nearY: staff CTF night 4]

══════════════════════════════════════════════════════════════════════════════
seed "friendship"
  pool: 144 raw -> 144 kept at cosine > 0.92
  near group 1 [1-5]  judge=group 3 ✗  vigilance 7 · friendly rivalry 7 · lunch-and-learn 7 · immune system 7 · recognition 7
  near group 1 [6-10]  judge=group 3 ✗  shared vocabulary 7 · apprenticeship of doubt 6 · muscle memory 6 · compliance 6 · shared vocabulary 6
  near group 2 [1-5]  judge=group 1 ✗  phishing drill 6 · shared vocabulary 7 · staff CTF night 6 · recognition 5 · security mascot 6
  near group 2 [6-10]  judge=group 2 ✓  badge stickers 7 · apprenticeship of doubt 5 · immune system 7 · folklore 7 · poster contest 6
  near group 3 [1-5]  judge=group 3 ✓  myth-making 6 · incident tabletop game 7 · routine 7 · near-miss stories 7 · password day 6
  near group 3 [6-10]  judge=group 2 ✗  social-engineering improv night 5 · baseline 7 · welcome-back training 6 · herd instinct 6 · lock-picking petting zoo 6
  top-10 overlap between groups (mean jaccard): 0.037
  control 1  truth=group 1  judge=group 2  herd instinct 6 · antibodies 6 · social-engineering improv night 6 · two-minute mystery emails 7 · bragging rights 6
  control 2  truth=group 1  judge=group 1  storytelling 6 · habit 8 · phishing drill 7 · security mascot 8 · rituals 7
  control 3  truth=group 1  judge=group 3  baseline 6 · superstition 6 · myth-making 7 · vigilance 6 · breach museum field trip 7
  thread "long-distance calls" — "standing weekly dinner" rank 1: judge=near X  [bridge: shared vocabulary 7 | nearX: security mascot 7 | nearY: folklore 7]
  thread "long-distance calls" — "standing weekly dinner" rank 2: judge=near Y  [bridge: phish sommelier tasting 8 | nearX: curiosity 7 | nearY: dread as teacher 7]
  thread "long-distance calls" — "apologizing first" rank 1: judge=near X  [bridge: routine 7 | nearX: security mascot 7 | nearY: phishing bingo 7]
  thread "long-distance calls" — "apologizing first" rank 2: judge=near Y  [bridge: dread as teacher 6 | nearX: curiosity 7 | nearY: myth-making 6]
  thread "standing weekly dinner" — "apologizing first" rank 1: judge=near Y  [bridge: immune system 8 | nearX: folklore 7 | nearY: phishing bingo 7]
  thread "standing weekly dinner" — "apologizing first" rank 2: judge=bridge  [bridge: phishing bingo 7 | nearX: dread as teacher 7 | nearY: myth-making 6]

══════════════════════════════════════════════════════════════════════════════
RESULT
  attribution   5/18 correct  (judged 18)  chance 1/3  P(X>=k)=0.7689   pass >= 11
    ranks 1-5: 1/9
    ranks 6-10: 4/9
  control       3/9 "correct" on random words (judged 9)  — expect ~3.0
  bridge        3/18 chose the bridge  (judged 18)  chance 1/3  P(X>=k)=0.9674   pass >= 10
    judge chose: bridge 3 · near X 8 · near Y 7 · unjudged 0   by position 6/5/7
  hubness       mean top-10 jaccard 0.036 (per seed 0.018, 0.055, 0.037)   pass <= 0.25
  echo          0/45 steered words are near-duplicates (cos > 0.92) of a note

VERDICT: FAIL  — attribution 5/18 < 11 (0 unjudged); bridge 3/18 < 10 (0 unjudged)
requests spent: 27
```
