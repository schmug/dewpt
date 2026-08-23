Verdict: fail. The core happy path is genuine projection over real pooled candidates: deployed assets match the checkout, a live touch swipe moved both the gauge and card, and the implementation does not rewrite candidates. The surrounding evidence and failure handling are not yet professional-release quality.

| Category | Score | Assessment |
|---|---:|---|
| Mechanic | 7 | Projection, position movement, pooled-card ranking, and an informational edge exist. Seed retention is neither enforced nor adequately measured across the shipped 2D loop. |
| Evidence | 5 | The null result is recorded honestly and unsupported checks stay disabled. However, the committed measurements no longer reproduce from the current harnesses, Workstream B uses non-production pool parameters, and the capture contains a stale screenshot. |
| Mobile UX | 7 | Attractive, legible, thumb-sized, overflow-free, safe-area-aware, and clear without a legend. The promised crossfade is dead CSS: card text changes directly without toggling opacity or transform. |
| Robustness | 5 | Many specified failures are handled, but fresh production sessions demonstrably fail to populate, partial prime lacks the promised retry strategy, and pending axes can break dimensionality. |
| Code quality | 7 | The module boundaries, pure tests, CSS scoping, safe DOM construction, and embedding exclusion are strong. Controller behavior is protected mainly by regex/shape assertions that passed despite broken live gates and an inactive motion implementation. |

The decisive production evidence is red: [smoke-output.txt](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-02-1787443785065/live-capture/smoke-output.txt:17>) received zero candidates, while [ui-smoke-output.txt](</var/folders/5d/wrtvmttj6x9448syv5l7hdc00000gn/T/critic-02-1787443785065/live-capture/ui-smoke-output.txt:41>) could not open a second fresh session’s card stage within 120 seconds. The 730 unit tests passed at the reviewed revision, but they do not override these failed release-level observations.

```json
{
  "scores": {
    "mechanic": 7,
    "evidence": 5,
    "mobileUx": 7,
    "robustness": 5,
    "codeQuality": 7
  },
  "verdict": "fail — every category is below 8",
  "summary": "The implemented happy path is real projection over real pooled candidates, and the successful mobile capture demonstrates that a swipe can move position and change the card. It is not shippable because fresh production sessions do not reliably reach that loop, seed retention is not an enforced invariant, and the measurement record has drifted from the current harnesses. The visual design and module boundaries are strong, but several passing guards validate declarations rather than behavior.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "robustness",
      "title": "Make fresh sessions reliably populate",
      "detail": "The production HTTP smoke obtained zero candidates after polling, and the reduced-motion UI session never opened the stage within 120 seconds. drift.js waits 75 seconds and then returns to setup with a generic reload message, without exposing whether generation, capacity, or budget failed. Diagnose the production generation failure, expose an actionable generation state, and require repeated fresh-session smoke runs to reach a real card within a measured service-level bound."
    },
    {
      "severity": "blocker",
      "category": "mechanic",
      "title": "Guarantee seed retention",
      "detail": "public/drift/position.js ranks only by axis distance and never uses Served.seedDist, so a pooled but weakly related candidate can win at an extreme. The projection harness evaluates retention at only the first, middle, and last stops of separate 1D sweeps, despite the documentation claiming every position. Establish a measured retention criterion over the actual 2D, unseen-first, reach-bounded loop and enforce it at ranking or pool intake so every surfaced card remains tethered to the seed."
    },
    {
      "severity": "major",
      "category": "evidence",
      "title": "Rerun production-parity measurements",
      "detail": "docs/measurements/2026-08-22-drift-mechanic-spikes.md records an ab4c519 run made before axis-projection-spike.ts was changed to production bands and embedding-cosine dedupe, so its raw output is not reproducible by the current committed harness. axis-power-spike.ts still hard-codes 0.2/0.25/0.75 bands rather than the shipped 0.15/0.2/0.8 values and omits PoolCore's embedding dedupe while calling its input a real pool. Make both harnesses construct the shipped pool and ranking loop, rerun them, and commit reconciled raw results before citing turnover, step size, retention, independence, or the Workstream B null."
    },
    {
      "severity": "major",
      "category": "mobileUx",
      "title": "Implement the promised crossfade",
      "detail": "styles.css declares opacity and transform transitions, but drift.js advance() replaces textContent immediately and never toggles data-leaving, opacity, or transform. Reduced motion therefore does not actually fade; its guard and browser test inspect computed declarations only. Drive a real opacity transition during card replacement, suppress transform movement under prefers-reduced-motion, and behaviorally sample the transition during an actual swipe."
    },
    {
      "severity": "major",
      "category": "robustness",
      "title": "Complete prime and pending-axis recovery",
      "detail": "enterStage treats 200 responses with empty buckets as a successful prime, retries only buckets represented as request failures, performs one immediate top-up rather than the specified backoff, and does not start refill after the first sparse stage render. It also retains an axis returned with ready:false, while pool rows then contain fewer coordinates and rank as unreachable instead of degrading to one axis. Track empty and failed buckets, retry them with bounded background backoff, filter to ready axes, and keep the surviving dimension usable."
    },
    {
      "severity": "major",
      "category": "robustness",
      "title": "Restore complete session state",
      "detail": "resumeFromHash restores axes but never calls GET /api/session/:id, even though that response contains anchors. Consequently the comment claiming pins survive reload is false and the condensate resets to zero. Restore anchors during resume, repaint the condensate, and refresh axis definitions when an axisIds flush reports a set different from the labels held by drift.js."
    },
    {
      "severity": "major",
      "category": "codeQuality",
      "title": "Turn release guards into behavioral gates",
      "detail": "The lexical onSwipe guard and reduced-motion CSS assertions passed while the production smoke suites exited non-zero and the fade was never activated. In addition, scripts/critic.mjs copies critic-reports/ui without clearing it; because this run timed out before writing 06-reduced-motion.png, the bundled file is stale evidence. Add controller-level tests with injected DOM/network state, require smoke outputs to pass, and clear or uniquely version screenshot output before every capture."
    },
    {
      "severity": "major",
      "category": "evidence",
      "title": "Finish the constant audit",
      "detail": "Most drift thresholds are responsibly cited or labelled, but MIN_REGISTER_TOKENS and PRIME_RETRY_MS remain behavioral thresholds without a measurement citation or explicit UNMEASURED label; the COMMON vocabulary also asserts separating power without a committed harness. Label every remaining judgment call at its definition and either measure the register proxy on representative expanded poles or narrow its claims."
    },
    {
      "severity": "minor",
      "category": "mobileUx",
      "title": "Polish the edge and gesture surface",
      "detail": "The screenshots show a clear, legible card and discoverable 'kept' chip, but the edge leaves an empty focused card outline while still saying 'tap to keep', and swipes must begin on the word-sized card element rather than the broader central stage. Remove inactive affordances at the edge and provide a larger dedicated gesture region without creating a condensate-panel dismissal conflict."
    }
  ]
}
```
