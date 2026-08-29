# Critic reports

Independent-critic verdicts for the `drift` surface. Each cycle is a clean clone
of committed `main` plus a live-capture bundle from production, handed to
`codex` in a read-only sandbox with no memory of the build. Run one with
`npm run critic -- <n>`; the harness is `scripts/critic.mjs` and the rubric is
`scripts/critic-prompt.md`.

## Status: STOPPED at cycle 3 of a 12-cycle cap, 2026-08-23

The bar was every category ≥ 8 on two consecutive cycles. It was never met.

| | c1 | c2 | c3 |
| --- | --- | --- | --- |
| mechanic | 7 | 7 | 7 |
| evidence | 5 | 5 | 5 |
| mobileUx | 5 | 7 | 6 |
| robustness | 6 | 5 | 6 |
| codeQuality | 6 | 7 | 7 |
| findings | 10 | 9 | 14 |

**Stopped because it was not converging.** Three cycles, no category reached 8,
`mechanic` and `evidence` never moved at all, and the finding count rose. Each
fix round introduced a regression the next cycle caught — cycle 2's crossfade
created cycle 3's pin-atomicity bug, which is now
[#105](https://github.com/schmug/dewpt/issues/105).

Two structural reasons another round would not have helped:

- The `mechanic` blocker asks for a **non-circular relevance instrument** to
  prove seed survival. Workstream B measured three times that no cheap
  statistic has that power
  ([2026-08-22-workstream-b-null-result.md](../docs/measurements/2026-08-22-workstream-b-null-result.md)).
  The blocker requires the thing already measured as unavailable.
- `evidence` scored 5 three times running. That is not a code problem. It needs
  a committed unrelated-pair corpus, a reproducible fixture, and prose
  reconciled across four documents that currently disagree.

## What the loop was worth

It found things no unit test or source guard did, because it read the live
capture rather than the source's claims about itself:

- The **edge never happened** — ranking picked the nearest unseen candidate
  globally, so the surface teleported while reporting local exhaustion.
- **`SEED_TETHER_MIN = 0.414` has no provenance in this repository**, and this
  repo's own committed evidence contains counterexamples above it
  ([#104](https://github.com/schmug/dewpt/issues/104)). That one is worth the
  whole exercise: it is a claim I made repeatedly, in code comments and commit
  messages, while enforcing the opposite standard on everything else.
- The **crossfade never faded** — the CSS was declared, the JS never toggled it,
  and both the source guard and the browser check read computed declarations.
- The **harness bundled stale screenshots**, so a failed run presented the
  previous run's evidence as current.

## Open findings

Filed as [#104](https://github.com/schmug/dewpt/issues/104)–[#110](https://github.com/schmug/dewpt/issues/110).

## Restarting

`npm run critic -- 4` picks up where this left off. Fix
[#104](https://github.com/schmug/dewpt/issues/104) first: `evidence` is the
category that never moved, and it is the one gating a pass.
