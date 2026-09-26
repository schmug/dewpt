# Marginalia pool-reuse spike

**Date:** 2026-09-26 · **Branch:** `marginalia-pool-reuse` · **Cost so far:** 0 Workers AI requests
**Script:** `npm run marginalia-spike` ([scripts/marginalia-spike.ts](../../scripts/marginalia-spike.ts)). Its pure parts, including the pre-registered `MARGINALIA_PASS`, are in [scripts/marginalia-judge.ts](../../scripts/marginalia-judge.ts), tested by `test/marginalia-judge.test.ts`. Plumbing is in [scripts/ground-harness.ts](../../scripts/ground-harness.ts).
**Plan:** [.claude/plans/marginalia-pool-reuse.md](../../.claude/plans/marginalia-pool-reuse.md) · **Design:** [spec §2.E](../superpowers/specs/2026-09-24-sky-and-ground-design.md) · **Why now:** the prospect-only ground spike came back FAIL ([measurement](2026-09-25-ground-prospect-spike.md)), and under its pre-registered rule Marginalia became the candidate.

## Verdict: **PENDING — not yet run against Workers AI**

Nothing in this repo should cite pool reuse for Marginalia as working until the "Real run" section below is filled in.

## The assumption under test

In Marginalia, the paragraph under the cursor seeds the margin. For the margin never to wait, which is the pool-depth rule, the words for the *next* paragraph must come from the pool already built, re-ranked, with no new generation. If they don't, every paragraph invalidates the pool and the margin waits on generation at every pause. So the question is: when the writer moves on, does a reader place the re-ranked words beside the paragraph the writer is now in, or do they stay stuck on the paragraph the pool was built for?

## Method

- **Essays.** Five hand-written essays of five paragraphs each, committed in the script:
  - restoring an old bicycle;
  - keeping bees;
  - moving to a new city;
  - working the night shift;
  - learning to swim as an adult.

  Adjacent paragraphs drift the way a draft does: same essay, new sub-theme. None of these topics appeared in the ground spikes. **Known bias:** they were written knowing the test.
- **Pool.** One per essay. The seed is `seedFrom(paragraph 1)`: the paragraph cut at the last sentence boundary within 200 characters, which is production's `MAX_SEED_CHARS`. The pool is built by the shipped generation at band and dedupe parity (six bands × 24, dedupe at cosine 0.92), then loaded into a real `PoolCore`.
- **Moves.** The writer moves to paragraph 2, then 3, then 4. Each move draws 5 words with `PoolCore.drawRanked`, ranked by `nearScore` toward that paragraph's bge-m3 embedding. The draw consumes, so paragraph 3 gets what paragraph 2 left. Nothing is regenerated. That makes 15 trials: 5 essays × 3 moves.
- **Judge.** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` at temperature 0.1, blind forced choice. It sees three paragraphs, k−1, k and k+1, unlabelled, plus the 5 words, and names the paragraph the words appeared beside.
  - **Rotation, not shuffling.** The same judge leaned toward display position 2 in both ground spikes. So every trial is asked in all **3 cyclic rotations** (a Latin square: each paragraph sits in each position once). A trial is **correct if paragraph k wins a majority (≥ 2 of 3)**.
  - Under a uniform judge a trial comes out correct with probability p₀ = **7/27**. A judge that answers by position picks each paragraph once, so it scores **0**.
  - A malformed answer is retried once. If it still fails, that rotation votes for nothing, which counts toward a miss. Trials are never dropped from n.
- **Diagnostics, not verdicts.**
  - How misses split: stuck on the previous paragraph, placed on the next, or no majority.
  - The top-10 Jaccard across one essay's three targets.
  - The cosine gap: cos(target) − cos(previous) for the served words.
  - How much pool is left after paragraph 4.

## Pre-registered bars

Fixed in `scripts/marginalia-judge.ts` (`MARGINALIA_PASS`) and committed **before any real run**. Changing them after data exists requires a commit that says so, and Cory's sign-off.

| | bar | tail under chance (exact) |
| --- | --- | --- |
| follows the writer | ≥ 8 / 15 trials correct (majority of 3 rotations) | P(X ≥ 8 \| n=15, p₀=7/27) = 0.0215 |
| validity | no display position ≥ 24 / 45 judge calls | 0.0134 false-INVALID |

`test/marginalia-judge.test.ts` asserts 7/27 and both tails to four decimal places, and that a position-only judge scores 0.

## Cost and how to run

**Expected cost:** 30 generation + ~15 embedding + 45 judge = **~90 requests**, or up to 135 if every judge call retries, plus any transient-error retries (`retryTransient`, counted). The budget is 300; 133 are spent, which leaves **167**. The default cap is `--max-requests=140`.

```sh
source ~/.zshenv; export CLOUDFLARE_ACCESS_CLIENT_ID CLOUDFLARE_ACCESS_CLIENT_SECRET   # pause WARP first
npm run marginalia-spike -- --binding
```

## Real run (Workers AI)

_Pending. Paste the unedited output of the command above here, then write the verdict at the top._

## Offline plumbing run (`--fake`)

This run proves the harness works end to end: seed cut, pool build, dedupe, the consuming ranked draw across three moves, rotation, majority scoring, request accounting and the verdict. It uses `src/dev-fake-ai.ts` (hash embeddings, canned words that ignore the seed) and a **coin-flip judge**, so the numbers are meaningless by construction. The request count covers generation and embedding only, because the fake judge makes no calls.

```
marginalia pool-reuse spike  model FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)
bands 6x24  k=5 per move  5 essays x 3 moves = 15 trials x 3 rotations = 45 judge calls
expected requests: 30 generation + ~15 embedding + 45 judge (up to 90 with retries); hard cap 140

══════════════════════════════════════════════════════════════════════════════
essay "restoring an old bicycle"  seed (158 chars): The bicycle was in my grandfather's shed, under a tarp that had turned to dust. A steel frame, rust blooming through green paint, both tyres flat and cracked.
  pool: 144 raw -> 144 kept at cosine > 0.92
  -> paragraph 2  votes prev/prev/next ✗  near-miss stories 2 · rituals 2 · haunted inbox exhibit 2 · social-engineering improv night · lunch-and-learn
  -> paragraph 3  votes prev/HERE/prev ✗  phishing drill 2 · lock-picking petting zoo 2 · cafeteria con-artist theater · security mascot 2 · curiosity
  -> paragraph 4  votes HERE/HERE/HERE ✓  phish sommelier tasting 3 · staff CTF night · ransomware campfire stories · routine · two-minute mystery emails 2
  top-10 overlap across targets (jaccard) 0.018   pool left after paragraph 4: 129/144

══════════════════════════════════════════════════════════════════════════════
essay "keeping bees"  seed (157 chars): My first hive arrived in a cardboard box that hummed. Five frames of bees, a queen I could not find, and a neighbour watching over the fence with open alarm.
  pool: 144 raw -> 144 kept at cosine > 0.92
  -> paragraph 2  votes prev/next/next ✗  monthly newsletter 4 · tribal memory 3 · communal grooming 4 · spot-the-fake wall 5 · haunted inbox exhibit 5
  -> paragraph 3  votes HERE/HERE/next ✓  security fortune cookies 5 · muscle memory 5 · breach museum field trip 4 · two-minute mystery emails 4 · street smarts 4
  -> paragraph 4  votes next/HERE/prev ✗  habit 4 · curiosity 4 · gossip-powered honeypot 5 · lunch-and-learn 5 · habit 5
  top-10 overlap across targets (jaccard) 0.035   pool left after paragraph 4: 129/144

══════════════════════════════════════════════════════════════════════════════
essay "moving to a new city"  seed (193 chars): I arrived with two suitcases and a key to an apartment that smelled of fresh paint. The walls were bare, the fridge was empty, and I did not know a single person within four hundred kilometres.
  pool: 144 raw -> 144 kept at cosine > 0.92
  -> paragraph 2  votes prev/next/prev ✗  spot-the-fake wall 6 · storytelling 7 · bragging rights 7 · phishing bingo 6 · threat-model tarot deck 7
  -> paragraph 3  votes next/next/next ✗  lunch-and-learn 6 · bragging rights 6 · welcome-back training 5 · poster contest 7 · curiosity 7
  -> paragraph 4  votes next/prev/next ✗  curiosity 6 · report button 7 · repetition 7 · immune system 8 · baseline 7
  top-10 overlap across targets (jaccard) 0.035   pool left after paragraph 4: 129/144

══════════════════════════════════════════════════════════════════════════════
essay "working the night shift"  seed (158 chars): My first night shift on the ward began at nine. By three in the morning the corridors were hushed and the fluorescent lights hummed louder than anything else.
  pool: 144 raw -> 144 kept at cosine > 0.92
  -> paragraph 2  votes next/prev/prev ✗  apprenticeship of doubt 9 · storytelling 10 · play 9 · cafeteria con-artist theater 9 · quiz with prizes 8
  -> paragraph 3  votes next/HERE/HERE ✓  routine 10 · ransomware campfire stories 8 · baseline 9 · herd instinct 8 · near-miss stories 9
  -> paragraph 4  votes next/HERE/prev ✗  phish sommelier tasting 10 · door-lock checks 9 · hallway escape room 10 · security fortune cookies 8 · lock-picking petting zoo 8
  top-10 overlap across targets (jaccard) 0.018   pool left after paragraph 4: 129/144

══════════════════════════════════════════════════════════════════════════════
essay "learning to swim as an adult"  seed (121 chars): I was afraid of water for thirty-four years. A wave had knocked me over as a child and I had kept my distance ever since.
  pool: 144 raw -> 144 kept at cosine > 0.92
  -> paragraph 2  votes HERE/HERE/next ✓  lanyard trading cards 10 · phishing bingo 11 · rituals 12 · folk immunity 12 · staff CTF night 11
  -> paragraph 3  votes next/prev/prev ✗  herd instinct 12 · two-minute mystery emails 12 · bragging rights 10 · rituals 10 · security fortune cookies 11
  -> paragraph 4  votes HERE/next/HERE ✓  immune system 12 · antibodies 12 · security mascot 12 · bragging rights 12 · report button 10
  top-10 overlap across targets (jaccard) 0.035   pool left after paragraph 4: 129/144

══════════════════════════════════════════════════════════════════════════════
RESULT
  follows the writer   5/15 trials correct (majority of 3 rotations)  chance 0.259  P(X>=k)=0.3444   pass >= 8
    into paragraph 2: 1/5
    into paragraph 3: 2/5
    into paragraph 4: 2/5
    misses: 5 stuck on the previous paragraph · 3 placed on the next · 2 no majority   [diagnostic]
    judge answers by position: 17/14/14 of 45 calls, 0 unjudged   (INVALID at >= 24; P=0.0134 under a uniform judge)
  overlap       mean top-10 jaccard across a draft's targets 0.028 (per essay 0.018, 0.035, 0.035, 0.018, 0.035)   [diagnostic]
  cosine gap    served words: mean cos(target) - cos(previous) 0.280   [diagnostic]
  pool depth    left after paragraph 4: 129, 129, 129, 129, 129   [diagnostic]

VERDICT: FAIL  — 5/15 trials correct < 8
requests spent: 45
```
