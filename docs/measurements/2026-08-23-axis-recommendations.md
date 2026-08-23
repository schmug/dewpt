# Which pole pairs earn a pill

**Date:** 2026-08-23 · **Tree:** bcd3ca6 · **Cost:** 68 Workers AI requests

Produced by `npm run axis-power`. Nine pairs, three seeds (`public transit`,
`home cooking`, `friendship`), scored by LLM-judge AUC over real pooled
candidates at production band and dedupe parity. The `X` / `more X` surface
control sets the lexical ceiling — the score a pure token difference achieves —
and nothing at or below it is an axis.

## Ranking

```
axis                              mean   spread  n   verdict
natural -> synthetic              0.880  0.220   3   RECOMMEND
calm -> frantic                   0.867  0.320   3   RECOMMEND
practical -> mystical             0.813  0.150   3   RECOMMEND
concrete -> abstract              0.783  0.220   3   marginal
intimate -> industrial            0.783  0.120   3   marginal
ancient -> futuristic             0.713  0.040   3   REJECT - at the ceiling
SURFACE playful -> more playful   0.713  0.110   3   - the ceiling itself
simple -> intricate               0.663  0.160   3   REJECT
solemn -> playful                 0.597  0.130   3   REJECT
```

## What ships

The three that clear the ceiling by a clear margin, plus `concrete <-> abstract`.

**That fourth one is a judgement, and it is recorded as one.** It is marginal in
*this* run, but it carries the strongest prior of any pair here: AUC 0.980 on
hand-labelled words in the original axis spike, and top of the two-seed run at
0.810. Kept on accumulated evidence rather than on this run alone. If it is
marginal again next time it should come off.

**`solemn <-> playful` is not offered.** It ranks last at 0.597, below the
ceiling, consistently across all four runs to date. It had been this surface's
placeholder example in the markup, in the code comments and in every test
fixture — the pair the UI actively suggested was the worst-measured one in the
repo. Placeholders now use `calm <-> frantic` and `natural <-> synthetic`, and
`test/drift-client-guards.test.ts` fails if `solemn` reappears as a suggestion.

## Caveats, and they are not small

- **The ceiling moved.** The surface control scored 0.530 in the two-seed run
  and 0.713 here. The judge is noisy at 10v10, so "clears the ceiling" is a
  comparison between two noisy numbers, and both the ranking and the cutoff
  should be re-measured before they are trusted very far.
- **Spread is large.** `calm -> frantic` ranges 0.320 across three seeds. A
  high mean can hide an axis that works on one topic and not another, which is
  the exact seed-dependence flagged in
  [2026-08-22-workstream-b-null-result.md](2026-08-22-workstream-b-null-result.md).
- **Three seeds is thin** for a recommendation shown to every user against
  whatever they type.
- This ranks axes by whether they ORDER a pool, which is not the same as whether
  they are interesting to steer by. Nothing here measures that.
