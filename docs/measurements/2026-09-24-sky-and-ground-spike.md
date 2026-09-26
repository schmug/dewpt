# Sky and ground — the re-ranking spike

**Date:** 2026-09-24 · **Tree:** `ideation-ground` · **Cost so far:** 63 Workers AI requests (real run) + 1 connectivity probe
**Script:** `npm run ground-spike` ([scripts/ground-spike.ts](../../scripts/ground-spike.ts)). Its pure parts, including the pre-registered `PASS`, are in [scripts/ground-judge.ts](../../scripts/ground-judge.ts), tested by `test/ground-judge.test.ts`.
**Design:** [2026-09-24-sky-and-ground-design.md](../superpowers/specs/2026-09-24-sky-and-ground-design.md)
**Next:** after this INVALID run, the design narrowed to prospect only, which is re-measured on fresh data in [2026-09-25-ground-prospect-spike.md](2026-09-25-ground-prospect-spike.md) (spec Appendix B).

## Verdict: **INVALID** — the bridge judge answered by position

Real run 2026-09-24. The pre-registered validity gate fired: the bridge judge picked display position 2 in 10 of 18 trials, and the gate is ≥ 10. Under the rules below, INVALID is neither PASS nor FAIL.

Readings, recorded as information only. None of them overrides the verdict:
- **Attribution:** 13/18 against a bar of ≥ 11, P(X ≥ 13 | chance) = 0.0009. The attribution judge's positions were 7/6/5, so this judge did not trip the gate.
- **Bridge:** 3/18, with the hub chosen 5 times. This is below the ≥ 9 bar and not above the hub.
- **Hubness:** mean top-10 Jaccard 0.149, within the ≤ 0.25 bar.
- **Echo:** 0/90.

This run was made from Cory's Mac without the REST API token. It used `npm run ground-spike -- --binding`: wrangler's remote AI binding, authenticated by the wrangler OAuth login plus the exported Access service token, with WARP paused. Same models, same code path.

## The assumption under test

The ground design serves its two gestures by **re-ranking the pool the SessionDO already holds**. There is no inference on the gesture path. That only works if both of these hold:

1. **Attribution:** different clusters of pinned words pull *recognisably different* words out of a seed-conditioned pool. The pool must not be so homogeneous that every cluster retrieves the same central candidates (hubness).
2. **Bridge:** the shipped bridge score, `min(cos(c,A), cos(c,B))`, surfaces a word that a reader recognises as connecting A and B. It must do better than a generic central word, and better than words that are simply close to one end.

If either fails, the ground is decoration, and the design returns to the reimaginings (spec §2).

## Method

- **Pool.** For each seed, run `generateCandidates` over the six production bands (`TIER_STRANGENESS` × `ALT_ABSTRACTION`) × 24, embed with `@cf/baai/bge-m3`, and dedupe at `DEDUPE_COSINE`. This is production parity, done the same way `axis-power` does it. Candidates get their real `seedDist` and bucket and are loaded into a real `PoolCore`.
  - **No anchors are used in generation.** In the app, pins also condition generation, which can only help, so this is the harder case.
- **Ground.** Three seeds (`public transit`, `home cooking`, `friendship`), each with three hand-written groups of three notes on distinct sub-themes. The groups are laid out as clusters on a ground scene 400 units apart, with notes within about 70 units of their cluster centre (`NEIGHBOR_RADIUS` is 240). The groups are committed in the script.
  - **Known bias:** real clusters may be subtler than these.
- **The shipped path, end to end.**
  - Prospects go through `planProspect` (neighbourhood with Gaussian weights) and then `PoolCore.drawRanked`. The draw consumes candidates, so the "second burst" is exactly what a second prospect at the same spot would get.
  - Bridges go through `planBridge` and `planScore`, over whatever the prospects left in the pool.
  - If a prospect does not plan `near` on its own cluster alone, the run is marked INVALID, because the layout would be testing the wrong thing.
- **Judge.** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` at temperature 0.1, forced choice, blind to method.
  - Option order is shuffled per trial with a fixed seed.
  - A malformed answer is retried once, then **counted as a miss**. Misses are never dropped from n.
- **Trials.**
  - **Attribution (18 trials** = 3 seeds × 3 clusters × 2 bursts). The judge sees the three groups plus the 5 words a prospect at one cluster condensed, and names the group they appeared beside. Chance is 1/3.
  - **Bridge (18 trials** = 3 seeds × 3 threads × 2 ranks). The judge sees X, Y and **four** phrases, and picks the one that connects both. Chance is 1/4. The four arms:
    - the top phrase by the shipped bridge score;
    - the **hub**: the pool's most *central* word by mean cosine to all the others. `min(cos)` favours central words, so a pass must beat a generic hub;
    - the phrase closest to X alone;
    - the phrase closest to Y alone.
- **Validity gate.** Because option order is shuffled, chance is analytic. A judge that answers by *position* is not reading the content, though, and its result means nothing either way. If one displayed position takes too many answers, the run is **INVALID**, not PASS or FAIL.
  - For a content-driven judge, the false-INVALID rate is about 1% (attribution) plus about 2% (bridge).
- **Diagnostics, not verdicts.** These are printed to *explain* a result, not to decide it. Workstream B showed that cheap embedding statistics lack the power to grade a direction.
  - Mean top-10 Jaccard between clusters' retrievals (hubness).
  - The echo rate: steered words that are near-duplicates of a note.

## Pre-registered bars

The bars are fixed in `scripts/ground-judge.ts` (`PASS`) and were committed **before any real run**. Their history:
- first registered in `cc3b7f6`;
- revised on the same day in `ideation-ground`, still before any real data existed, after a fresh-context review found two problems:
  1. the original "random words" control could not fail by construction, because its truth label was independent of everything the judge saw;
  2. the bridge trial had no hub arm.

Changing the bars after seeing data requires a commit that says so.

| | bar | tail under chance (exact, `binomTail`) |
| --- | --- | --- |
| attribution | ≥ 11 / 18 | P(X ≥ 11 \| n=18, p=1/3) = 0.0144 |
| bridge | ≥ 9 / 18 **and** chosen more often than the hub | P(X ≥ 9 \| n=18, p=1/4) = 0.0193 |
| hubness | mean top-10 Jaccard ≤ 0.25 | — |
| validity | no position ≥ 12/18 (attribution) or ≥ 10/18 (bridge) | ≈ 0.012 and ≈ 0.02 false-INVALID |

`test/ground-judge.test.ts` asserts the two tail values to four decimal places, so this table cannot silently drift from the code.

**Expected cost:** 18 generation + 9 embedding + 36 judge = **63 requests**, or up to 99 if every judge call retries. The run hard-stops at `--max-requests=120`. The budget across all spikes is 150.

## Real run (Workers AI)

Command: `export CLOUDFLARE_ACCESS_CLIENT_ID CLOUDFLARE_ACCESS_CLIENT_SECRET; npm run ground-spike -- --binding` (WARP paused).

The spike's output is below, unedited. Wrangler's stderr was stripped from it: the internal-Durable-Object binding warnings, and 36 `Error: internal error; reference = …` lines from the remote-proxy session. Those error lines came in 12 bursts of 3 that do not line up with the spike's calls. All 63 calls returned. The pools were near full (141/143/142 of 144 raw), and 36/36 judge calls parsed on the first attempt. The source of those error lines is unexplained.

```
ground spike  model @cf/meta/llama-3.3-70b-instruct-fp8-fast + @cf/baai/bge-m3 via remote AI binding
bands 6x24  prospect k=5  windows 1-5, 6-10  rng 0x6d0d
expected requests: 18 generation + ~9 embedding + 36 judge (up to 72 with retries); hard cap 120

══════════════════════════════════════════════════════════════════════════════
seed "public transit"
  pool: 141 raw -> 138 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 3 ✗  bus schedule · train station · forgotten train car hotels · real time arrival · train station performances
  prospect at group 1 [second burst]  judge=group 1 ✓  dusk lantern streetcars · commuter rail · abandoned ticket mazes · time-traveling streetcars · routes of nostalgia
  prospect at group 2 [first burst]  judge=group 2 ✓  transportation freedom · fare card · shared mobility · transit app rewards · transit app
  prospect at group 2 [second burst]  judge=group 2 ✓  accessibility · convenience · transport democracy · elevator access · citizen mobility
  prospect at group 3 [first burst]  judge=group 3 ✓  subway map · road signs · neon hieroglyphics signage · bike lane murals · traffic circle art
  prospect at group 3 [second burst]  judge=group 3 ✓  traffic light · rails as rivers of steel · traffic circle · stairway to the subway · public space
  top-10 overlap between groups (mean jaccard): 0.176
  thread "last train home" — "fare capping" rank 1: judge=near Y  [bridge: route planner | hub: city bike tours | nearX: vehicles as voyaging homes | nearY: trip chaining]
  thread "last train home" — "fare capping" rank 2: judge=near Y  [bridge: trip chaining | hub: city bike tours | nearX: train car gardens | nearY: ticket vending]
  thread "last train home" — "subway map typography" rank 1: judge=hub  [bridge: commuter psyche | hub: route planner | nearX: vehicles as voyaging homes | nearY: subway musicians program]
  thread "last train home" — "subway map typography" rank 2: judge=near Y  [bridge: streetcar historical tours | hub: city bike tours | nearX: train car gardens | nearY: route planner]
  thread "fare capping" — "subway map typography" rank 1: judge=bridge  [bridge: route planner | hub: city bike tours | nearX: trip chaining | nearY: subway musicians program]
  thread "fare capping" — "subway map typography" rank 2: judge=near Y  [bridge: transportation hub cafes | hub: city bike tours | nearX: ticket vending | nearY: route planner]

══════════════════════════════════════════════════════════════════════════════
seed "home cooking"
  pool: 143 raw -> 142 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 1 ✓  recipe cards · cooking class calendar · mixing bowls · recipe card library · dinner plate hieroglyphs
  prospect at group 1 [second burst]  judge=group 1 ✓  ancestral cooking techniques · taste nostalgia · heirloom recipes as legacy · family recipe archive · food as love
  prospect at group 2 [first burst]  judge=group 2 ✓  meal prep co-op · meal planning app · food processor · slow cooker · the kitchen as womb space
  prospect at group 2 [second burst]  judge=group 1 ✗  kitchen utensil swap · cutting boards · home brew kit · meal rhythms · feeling through food
  prospect at group 3 [first burst]  judge=group 3 ✓  kitchen knife sharpening · cast iron skillet · cast iron restoration · knife sharpener · wooden spoons
  prospect at group 3 [second burst]  judge=group 1 ✗  savoring time · kitchen witchcraft · meat thermometer espionage · warmth · seasonal harmony
  top-10 overlap between groups (mean jaccard): 0.160
  thread "grandmother's recipe cards" — "meal prep containers" rank 1: judge=hub  [bridge: kitchen scale | hub: taste | nearX: recipes as inherited trauma | nearY: measuring cups]
  thread "grandmother's recipe cards" — "meal prep containers" rank 2: judge=hub  [bridge: dinner party toolkit | hub: flavor | nearX: recipe book cryptograms | nearY: meal kit subscription]
  thread "grandmother's recipe cards" — "knife skills" rank 1: judge=near Y  [bridge: kitchen scale | hub: taste | nearX: recipes as inherited trauma | nearY: canning workshop]
  thread "grandmother's recipe cards" — "knife skills" rank 2: judge=bridge  [bridge: dinner party toolkit | hub: flavor | nearX: recipe book cryptograms | nearY: creativity]
  thread "meal prep containers" — "knife skills" rank 1: judge=near Y  [bridge: canning workshop | hub: taste | nearX: measuring cups | nearY: creativity]
  thread "meal prep containers" — "knife skills" rank 2: judge=near X  [bridge: silicone utensils | hub: flavor | nearX: meal kit subscription | nearY: creativity]

══════════════════════════════════════════════════════════════════════════════
seed "friendship"
  pool: 142 raw -> 142 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 1 ✓  friendship time capsule · time capsule correspondences · group chat · stranger intimacy · language exchange partners
  prospect at group 1 [second burst]  judge=group 2 ✗  outing plans · shared journaling · roommate · camaraderie · dead letter postcards
  prospect at group 2 [first burst]  judge=group 2 ✓  inside joke calendar · shared laughter · potluck dinner · neighborhood potluck · rituals
  prospect at group 2 [second burst]  judge=group 2 ✓  game nights · monthly dinner club · intimacy · mystery meat potlucks · movie nights
  prospect at group 3 [first burst]  judge=group 2 ✗  empathy · understanding · memories · secret handshake · familiarity
  prospect at group 3 [second burst]  judge=group 3 ✓  caring · reciprocal haunting · companionship · beautiful misunderstandings · mirrored silences
  top-10 overlap between groups (mean jaccard): 0.111
  thread "long-distance calls" — "standing weekly dinner" rank 1: judge=near X  [bridge: suspended moments | hub: reciprocal support | nearX: connection | nearY: annual camping trip]
  thread "long-distance calls" — "standing weekly dinner" rank 2: judge=near Y  [bridge: walks together | hub: mutual aid | nearX: cosmic proximity | nearY: suspended moments]
  thread "long-distance calls" — "apologizing first" rank 1: judge=near X  [bridge: support system | hub: reciprocal support | nearX: connection | nearY: acceptance]
  thread "long-distance calls" — "apologizing first" rank 2: judge=bridge  [bridge: reciprocal support | hub: mutual aid | nearX: cosmic proximity | nearY: acceptance]
  thread "standing weekly dinner" — "apologizing first" rank 1: judge=hub  [bridge: walks together | hub: reciprocal support | nearX: annual camping trip | nearY: acceptance]
  thread "standing weekly dinner" — "apologizing first" rank 2: judge=hub  [bridge: support system | hub: mutual aid | nearX: suspended moments | nearY: acceptance]

══════════════════════════════════════════════════════════════════════════════
RESULT
  attribution   13/18 correct  (judged 18)  chance 1/3  P(X>=k)=0.0009   pass >= 11
    first burst: 7/9
    second burst: 6/9
    judge answers by position: 7/6/5   (INVALID at >= 12)
  bridge        3/18 chose the bridge  (judged 18)  chance 1/4  P(X>=k)=0.8647   pass >= 9 and > hub
    judge chose: bridge 3 · hub 5 · near X 3 · near Y 7 · unjudged 0
    judge answers by position: 3/10/3/2   (INVALID at >= 10)
  hubness       mean top-10 jaccard 0.149 (per seed 0.176, 0.160, 0.111)   pass <= 0.25
  echo          0/90 steered words are near-duplicates (cos > 0.92) of a note  [diagnostic]

VERDICT: INVALID  — judge answered one bridge position 10/18 times — position-driven, not content-driven
requests spent: 63
```

## Offline plumbing run (`--fake`)

This run proves the harness works end to end: pool build, dedupe, the shipped prospect and bridge path, consumption, trial construction, request accounting and the verdict. It uses `src/dev-fake-ai.ts` (hash embeddings, canned words that ignore the seed) and a **coin-flip judge**, so the numbers are meaningless by construction.

This particular run came back **INVALID**: the coin landed on one bridge position 10 times out of 18. That is a roughly 2% event under a uniform chooser, and it shows the validity gate can fire. The request count covers generation and embedding only, because the fake judge makes no calls.

```
ground spike  model FAKE (dev-fake-ai + coin-flip judge — numbers are meaningless)
bands 6x24  prospect k=5  windows 1-5, 6-10  rng 0x6d0d
expected requests: 18 generation + ~9 embedding + 36 judge (up to 72 with retries); hard cap 120

══════════════════════════════════════════════════════════════════════════════
seed "public transit"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 3 ✗  trust · myth-making 2 · two-minute mystery emails · street smarts · haunted inbox exhibit 2
  prospect at group 1 [second burst]  judge=group 2 ✗  lunch-and-learn 2 · near-miss stories · fake-invoice bake-off · shared vocabulary 2 · bragging rights 2
  prospect at group 2 [first burst]  judge=group 3 ✗  security mascot 2 · staff CTF night · habit · report button 2 · vigilance 2
  prospect at group 2 [second burst]  judge=group 3 ✗  lock-picking petting zoo · cafeteria con-artist theater · shared vocabulary · security mascot 3 · poster contest
  prospect at group 3 [first burst]  judge=group 2 ✗  haunted inbox exhibit · social-engineering improv night 2 · hallway escape room 3 · phishing bingo 2 · phishing bingo
  prospect at group 3 [second burst]  judge=group 3 ✓  communal grooming · friendly rivalry 3 · herd instinct 3 · immune system · door-lock checks
  top-10 overlap between groups (mean jaccard): 0.035
  thread "last train home" — "fare capping" rank 1: judge=bridge  [bridge: phish sommelier tasting 3 | hub: incident tabletop game | nearX: recognition | nearY: monthly newsletter]
  thread "last train home" — "fare capping" rank 2: judge=hub  [bridge: recognition | hub: cafeteria con-artist theater 2 | nearX: spot-the-fake wall 2 | nearY: folklore 2]
  thread "last train home" — "subway map typography" rank 1: judge=near X  [bridge: compliance 2 | hub: incident tabletop game | nearX: recognition | nearY: security mascot]
  thread "last train home" — "subway map typography" rank 2: judge=near X  [bridge: password day 2 | hub: cafeteria con-artist theater 2 | nearX: spot-the-fake wall 2 | nearY: compliance 2]
  thread "fare capping" — "subway map typography" rank 1: judge=hub  [bridge: social-engineering improv night | hub: incident tabletop game | nearX: monthly newsletter | nearY: security mascot]
  thread "fare capping" — "subway map typography" rank 2: judge=near X  [bridge: security fortune cookies | hub: cafeteria con-artist theater 2 | nearX: folklore 2 | nearY: compliance 2]

══════════════════════════════════════════════════════════════════════════════
seed "home cooking"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 2 ✗  phishing bingo 4 · report button 4 · rituals 4 · phishing drill 5 · muscle memory 4
  prospect at group 1 [second burst]  judge=group 3 ✗  lock-picking petting zoo 3 · monthly newsletter 4 · shared vocabulary 3 · monthly newsletter 3 · incident tabletop game 3
  prospect at group 2 [first burst]  judge=group 3 ✗  monthly newsletter 5 · gossip-powered honeypot 4 · myth-making 3 · trust 5 · communal grooming 5
  prospect at group 2 [second burst]  judge=group 2 ✓  lanyard trading cards 3 · gossip-powered honeypot 5 · malware aquarium 5 · threat-model tarot deck 4 · muscle memory 3
  prospect at group 3 [first burst]  judge=group 2 ✗  staff CTF night 5 · staff CTF night 4 · repetition 4 · fake-invoice bake-off 4 · repetition 5
  prospect at group 3 [second burst]  judge=group 1 ✗  door-lock checks 3 · play 4 · ransomware campfire stories 5 · quiz with prizes 4 · phish sommelier tasting 4
  top-10 overlap between groups (mean jaccard): 0.055
  thread "grandmother's recipe cards" — "meal prep containers" rank 1: judge=hub  [bridge: poster contest 4 | hub: routine 5 | nearX: myth-making 5 | nearY: tribal memory 4]
  thread "grandmother's recipe cards" — "meal prep containers" rank 2: judge=hub  [bridge: muscle memory 5 | hub: gossip-powered honeypot 3 | nearX: street smarts 3 | nearY: folklore 4]
  thread "grandmother's recipe cards" — "knife skills" rank 1: judge=near Y  [bridge: breach museum field trip 4 | hub: routine 5 | nearX: myth-making 5 | nearY: badge stickers 3]
  thread "grandmother's recipe cards" — "knife skills" rank 2: judge=near X  [bridge: rituals 3 | hub: gossip-powered honeypot 3 | nearX: street smarts 3 | nearY: malware aquarium 4]
  thread "meal prep containers" — "knife skills" rank 1: judge=near Y  [bridge: badge stickers 3 | hub: routine 5 | nearX: tribal memory 4 | nearY: malware aquarium 4]
  thread "meal prep containers" — "knife skills" rank 2: judge=near Y  [bridge: folklore 4 | hub: gossip-powered honeypot 3 | nearX: baseline 4 | nearY: malware aquarium 4]

══════════════════════════════════════════════════════════════════════════════
seed "friendship"
  pool: 144 raw -> 144 kept at cosine > 0.92
  prospect at group 1 [first burst]  judge=group 2 ✗  friendly rivalry 7 · vigilance 7 · lunch-and-learn 7 · recognition 7 · immune system 7
  prospect at group 1 [second burst]  judge=group 3 ✗  apprenticeship of doubt 6 · shared vocabulary 7 · muscle memory 6 · breach museum field trip 6 · shared vocabulary 6
  prospect at group 2 [first burst]  judge=group 3 ✗  phishing drill 6 · staff CTF night 6 · recognition 5 · security mascot 6 · apprenticeship of doubt 5
  prospect at group 2 [second burst]  judge=group 1 ✗  badge stickers 7 · folklore 7 · poster contest 6 · breach museum field trip 5 · security fortune cookies 6
  prospect at group 3 [first burst]  judge=group 3 ✓  myth-making 6 · incident tabletop game 7 · routine 7 · near-miss stories 7 · password day 6
  prospect at group 3 [second burst]  judge=group 3 ✓  social-engineering improv night 5 · herd instinct 6 · baseline 7 · welcome-back training 6 · lock-picking petting zoo 6
  top-10 overlap between groups (mean jaccard): 0.037
  thread "long-distance calls" — "standing weekly dinner" rank 1: judge=near Y  [bridge: phish sommelier tasting 8 | hub: herd instinct 7 | nearX: security mascot 7 | nearY: dread as teacher 7]
  thread "long-distance calls" — "standing weekly dinner" rank 2: judge=bridge  [bridge: haunted inbox exhibit 8 | hub: rituals 7 | nearX: curiosity 7 | nearY: trust 6]
  thread "long-distance calls" — "apologizing first" rank 1: judge=hub  [bridge: dread as teacher 6 | hub: herd instinct 7 | nearX: security mascot 7 | nearY: phishing bingo 7]
  thread "long-distance calls" — "apologizing first" rank 2: judge=near X  [bridge: hallway escape room 6 | hub: rituals 7 | nearX: curiosity 7 | nearY: play 7]
  thread "standing weekly dinner" — "apologizing first" rank 1: judge=near Y  [bridge: immune system 8 | hub: herd instinct 7 | nearX: dread as teacher 7 | nearY: phishing bingo 7]
  thread "standing weekly dinner" — "apologizing first" rank 2: judge=near Y  [bridge: phishing bingo 7 | hub: rituals 7 | nearX: trust 6 | nearY: play 7]

══════════════════════════════════════════════════════════════════════════════
RESULT
  attribution   4/18 correct  (judged 18)  chance 1/3  P(X>=k)=0.8983   pass >= 11
    first burst: 1/9
    second burst: 3/9
    judge answers by position: 9/7/2   (INVALID at >= 12)
  bridge        2/18 chose the bridge  (judged 18)  chance 1/4  P(X>=k)=0.9605   pass >= 9 and > hub
    judge chose: bridge 2 · hub 5 · near X 5 · near Y 6 · unjudged 0
    judge answers by position: 1/10/5/2   (INVALID at >= 10)
  hubness       mean top-10 jaccard 0.042 (per seed 0.035, 0.055, 0.037)   pass <= 0.25
  echo          0/90 steered words are near-duplicates (cos > 0.92) of a note  [diagnostic]

VERDICT: INVALID  — judge answered one bridge position 10/18 times — position-driven, not content-driven
requests spent: 27
```
