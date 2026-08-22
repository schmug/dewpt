Verdict: fail. The captured production assets hash-match revision `ea2233a`, and the happy-path swipe is genuinely projection over pooled candidates—not translation or rewriting. However, several explicit ship gates are missed despite 724 passing tests.

| Category | Score | Assessment |
|---|---:|---|
| Mechanic | 7 | Real projection and real touch input work, but local exhaustion can surface a semantically distant card instead of the promised edge. |
| Evidence | 5 | Strong measurement practice overall, undermined by an unvalidated stage-2 lint and several unlabeled thresholds. |
| Mobile UX | 5 | Attractive, legible card and clear gauges, but the axis form overflows 390px, the card target is under 44px, and reduced motion snaps rather than fades. |
| Robustness | 6 | Most failures are considered, but degraded axes disappear from view, partial prime is not retried as specified, and axis changes can leave a stale card. |
| Code quality | 6 | Pure ranking/lint modules and safe DOM handling are good; advertised boundaries and multiple guard tests do not enforce what they claim. |

Key evidence:

- [`nextCard`](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/position.js:118>) has no locality cutoff. A candidate at `[.95,.95]` is selected from position `[.1,.1]` even while `localSupply` reports zero.
- Workstream B says stage 2 must ship empty ([null-result doc](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/docs/measurements/2026-08-22-workstream-b-null-result.md:8>)), yet [`lintAgainstPool`](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/axis-lint.js:117>) ships an unmeasured `0.375` warning tested only with constructed fixtures.
- [02-axes.png](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/live-capture/ui/02-axes.png>) is 884px wide at 2× scale: 442 CSS pixels in a 390px viewport. The browser smoke checks overflow only after hiding setup and excludes the card from its tap-target selector.
- The card has no minimum target height ([styles.css](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/styles.css:162>)); at 390px its single-line box is approximately 38px.
- Reduced-motion CSS removes every transition ([styles.css](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/styles.css:233>)), producing a snap rather than the required fade.
- Degradation is reported only in setup status ([drift.js](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/drift.js:109>)), which is hidden when the stage opens. Axis-error `payload.axes` is never adopted.
- `working-set.js` claims network ownership, but [`drift.js`](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-01-1787423827953/public/drift/drift.js:55>) directly performs session and pin requests. CSS also exempts global `:root` from its claimed full scoping.

```json
{
  "scores": {
    "mechanic": 7,
    "evidence": 5,
    "mobileUx": 5,
    "robustness": 6,
    "codeQuality": 6
  },
  "verdict": "fail — every category is below the required score of 8",
  "summary": "The deployed core is real projection over real pooled candidates, and the captured happy path works. It is not professionally shippable because local exhaustion lies about position, evidence governance was bypassed, explicit mobile floors fail, and several recovery states are incomplete. The passing gates contain meaningful tests, but also shape checks that miss the observed failures.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "mechanic",
      "title": "Make the edge local and truthful",
      "detail": "public/drift/position.js nextCard selects the nearest unseen candidate globally, even when every unseen candidate is far outside the current neighbourhood; localSupply can therefore report zero while a distant card is rendered. Add a justified maximum reach to ranking, return null when nothing unseen is locally reachable, keep top-up asynchronous, and test that a far unseen candidate produces the informational edge rather than a misleading card."
    },
    {
      "severity": "blocker",
      "category": "evidence",
      "title": "Remove the unsupported stage-2 lint",
      "detail": "docs/measurements/2026-08-22-workstream-b-null-result.md says stage 2 should ship empty, while public/drift/axis-lint.js ships BoW overlap at 0.375 without evaluating that statistic in axis-power or another committed real-pool harness. Remove the warning until a dated measurement establishes its power and false-positive rate; then reconcile the contradictory spec, measurement document, source comments, and tests."
    },
    {
      "severity": "major",
      "category": "mobileUx",
      "title": "Eliminate setup overflow at 390px",
      "detail": "live-capture/ui/02-axes.png proves the axis step is 442 CSS pixels wide in a 390px viewport. Make the two-pole rows fit or responsively stack, and run horizontal-overflow assertions at the seed, axis, card, panel, and error states—not only after setup has been hidden."
    },
    {
      "severity": "major",
      "category": "mobileUx",
      "title": "Meet the complete touch and motion floor",
      "detail": "The div[role=button] card has no 44px minimum target and is omitted from both source and browser target audits. Reduced-motion mode disables opacity transitions rather than crossfading. Give the card a real >=44px hit box, include role-based controls in the audit, and exercise an actual reduced-motion card change that retains opacity fade while eliminating transform motion."
    },
    {
      "severity": "major",
      "category": "robustness",
      "title": "Keep axis degradation and refusals actionable",
      "detail": "drift.js displays degraded-pole warnings only inside setup, then hides the entire setup when navigation starts; a later warning can also overwrite an earlier degradation. The 409/422 path reads payload.error but ignores payload.axes. Persist a degraded marker on the relevant gauge, retain all relevant warnings, adopt and render the server-returned current axes, and add UI tests for degraded, 409, and 422 responses."
    },
    {
      "severity": "major",
      "category": "robustness",
      "title": "Complete prime, flush, and resume recovery",
      "detail": "enterStage stops after any candidate arrives and does not retry failed or still-empty buckets with the specified background backoff. An axisIds flush resets range and seen but leaves state.current and the old painted card intact, while an empty replacement set leaves the stale card indefinitely. Continue partial prime in the background, clear stale current/card state on flush, repaint only from replacement coordinates, and either restore an existing location.hash session on reload or remove the session-survival claim."
    },
    {
      "severity": "major",
      "category": "evidence",
      "title": "Audit every drift constant and production parity",
      "detail": "MIN_REGISTER_TOKENS, TOP_K, SWIPE_MIN_PX, and related behavioral values are neither measured with a repository citation nor explicitly labelled UNMEASURED. The projection harness also uses representative 0.2/0.25/0.75 bands and exact-text dedupe, while production uses 0.15/0.2/0.8 bands and embedding-cosine PoolCore dedupe. Label every judgment call at its definition and make the mechanic harness construct the same candidate population and ranking loop production uses."
    },
    {
      "severity": "major",
      "category": "codeQuality",
      "title": "Make boundaries and guards truthful",
      "detail": "working-set.js does not own all network: drift.js performs session and pin fetches and axes.js performs axis requests. The CSS also places tokens on global :root despite the full-scoping claim. Move network operations behind injected data clients, scope tokens to .drift-surface, and replace regex guarantees with behavioral tests proving onSwipe updates synchronously while topUp remains unresolved."
    },
    {
      "severity": "major",
      "category": "codeQuality",
      "title": "Strengthen the browser gate around actual regressions",
      "detail": "scripts/ui-smoke.mjs labels transition removal as a fade, checks overflow only in the final stage, and audits button/a/input while excluding the card's div[role=button]. Exercise every setup and failure state, include all interactive roles, assert swipe does not pin, assert edge locality, and capture the reduced-motion card stage rather than the untouched seed screen."
    },
    {
      "severity": "minor",
      "category": "mobileUx",
      "title": "Make condensate visually discoverable",
      "detail": "The collapsed chip appears as an unexplained circled number, especially opaque at zero; its name exists only for assistive technology. Add a restrained visible condensate cue such as the specified dot/drop plus count, while preserving the 44px target and non-swipe dismissal behavior."
    }
  ]
}
```
