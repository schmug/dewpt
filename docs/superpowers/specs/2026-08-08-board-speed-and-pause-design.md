# Board speed and pause controls

**Date:** 2026-08-08
**Status:** implemented
**Scope:** A speed preset and a pause toggle for the `/board` surface. Amends
one decision in
[the conveyor board design](2026-08-08-conveyor-board-design.md); everything
else in that document stands.

## Problem

The board hops as fast as generation returns — roughly one station every one to
two seconds. Three station hops plus a six-second edge dwell means a lineage is
born, cooked, and gone in about eleven seconds. It is not readable, and there is
no way to hold it still and look at it.

There is also no way to stop it. The belt is driven by a Durable Object alarm
pump, so an open board keeps spending metered generation for as long as the tab
is open, whether or not anyone is reading it.

## What this amends

The conveyor design says, as a principle:

> A card advances the instant its child lands. **There is no fixed belt
> speed**, which dissolves the stall problem rather than solving it
> ([2026-08-08-conveyor-board-design.md:186](2026-08-08-conveyor-board-design.md))

That line is why the board never blocks on generation, and that part still
holds. What changes is the claim that there is no pace at all: a card may now be
required to *dwell* at a station before its next hop is requested.

The distinction is load-bearing. The original argument is that the board must
never be **waiting on a specific card** — that is what makes a slow generation
harmless. A dwell gate does not reintroduce that: the belt waits on a clock,
which always expires, rather than on an AI call, which may not. Every lineage
still advances the instant its child lands, once it is eligible to ask for one.

`EDGE_DWELL_MS` is untouched, and does **not** scale with the speed preset. The
design doc calls it a legibility floor rather than a tuning knob, and that
reading survives this change intact.

## Design

### The belt clock

Pause cannot be a flag that merely stops the pump. `EDGE_DWELL_MS` is measured
against wall-clock time, so a board paused for thirty seconds would evaporate
every edge-parked lineage the moment it resumed — pause would destroy the cards
it was invoked to let you read.

So the DO gets a **belt clock**: monotonic time that advances 1:1 with real time
while running and freezes while paused. New pure module `src/board/clock.ts`.

```ts
interface ClockState {
  /** Belt-time reading at the last start/stop boundary. */
  base: number;
  /** Real-time anchor while running; null while paused. */
  since: number | null;
}

beltNow(clock, realNow) = clock.base
  + (clock.since === null ? 0 : Math.max(0, realNow - clock.since));
```

The DO passes `beltNow()` everywhere it currently passes `Date.now()` into the
belt. **`BeltCore` learns nothing about pause.** A frozen clock makes `tick()`
idempotent by construction, so no tick-path special case exists to get wrong.

Two properties that are easy to lose and are therefore tests:

- **`Math.max(0, …)` is not defensive dressing.** A backward host-clock jump
  that rewound belt time would push `now - edgeAt` negative and make an
  edge-parked lineage immortal.
- **`since` is an absolute real-time anchor**, so the clock survives DO
  hibernation and isolate eviction without a per-tick write. Nothing about the
  clock is written on a tick; only pause, resume and speed changes write.

**Migration is free.** A board with no clock record initializes to
`{ base: Date.now(), since: Date.now() }`. Belt time is therefore
epoch-continuous, and the `bornAt` / `edgeAt` / `arrivedAt` values already
persisted on existing boards stay meaningful without a rewrite. Belt time simply
drifts behind real time by the board's accumulated paused duration.

### Speed: a minimum station dwell

```ts
export const BELT_SPEEDS = {
  brisk:  { hopDwellMs: 0 },      // today's behaviour: generation-bound
  steady: { hopDwellMs: 3000 },
  slow:   { hopDwellMs: 8000 },
};
export const DEFAULT_BELT_SPEED = "steady";
```

`BeltCore.hungry(now, hopDwellMs)` skips a lineage whose head has not yet sat
`hopDwellMs`. Because belt time runs 1:1 with real time, there is no rate
conversion anywhere in the system — speed is *entirely* the dwell gate, and the
clock only ever stops or runs.

**The seed fan is exempt from the dwell.** Gating a lineage's first hop would
leave a fresh board doing nothing for up to eight seconds, which is exactly the
"will look like waiting" failure the seed fan was introduced to prevent. The
dwell paces the interval between things there are to read; before the fan there
is nothing to read. Implemented as: the exemption applies when
`cards.length === 1`, the same condition that already selects `SEED_FANOUT`.

**`rearm()` has to learn the dwell.** Without it, every lineage dwelling at once
makes `pumpOnce` return `"idle"`, `hasPendingWork()` report nothing to do, and
the alarm lapse — leaving the board advancing only as a side effect of a client
polling `getView`. A board nobody is watching would stop, and a board someone is
watching would advance on the poll interval rather than the dwell. So
`BeltCore` grows:

```ts
/** Belt-time at which the next hop becomes eligible, or null when no lineage
 *  is hungry at any future time. At or before `now` means work is due. */
nextHopAt(hopDwellMs: number): number | null
```

It takes no `now`, and must compute its eligibility instant with the *same*
expression `hungry` compares against. Written as two independent rules — "skip
if still dwelling" in one, "`bornAt + dwell`" in the other — they disagree for a
head whose `bornAt` is ahead of the queried time, and the alarm then either
spins or sleeps through work it was just told existed. The two are one rule with
two readings, and a property test asserts they agree at every instant.

`rearm()` schedules `max(PUMP_MS, nextHopAt - beltNow)`. A dwelling lineage
counts as pending work. The edge-parked case is unchanged and still counts
independently: `hasPendingWork` already returns true for any lineage with
`edgeAt !== null`, and that clause must survive, or a board whose last lineage
is dwelling at the edge would never get the tick that evicts it.

`hopDwellMs` is a **required** parameter on both methods, not a defaulted one. A
call site that forgets it should fail to compile rather than silently revert
that lineage to `brisk`.

**The default is `steady`, not `brisk`.** This changes shipped behaviour: the
board runs at `brisk` today, and its unreadability at that pace is the reason
this feature exists. Recorded here as a deliberate change rather than left to be
discovered as a regression.

### Controls state, and what pause stops

Controls persist under a **storage key separate from the belt**, so
`beltFingerprint` — which the read path's write-skip depends on
([board-do.ts:170](../../../src/board/board-do.ts)) — is untouched and its
error-toward-writing asymmetry is preserved.

- `BoardView` gains `controls: { speed, paused }`. A reload resumes into the
  right state, and a second viewer of the same board URL sees it too. Controls
  are board state, not client state, because a client-side value cannot throttle
  a server-driven pump.
- New route `POST /api/board/:id/controls`, body `{ speed?, paused? }`. Strict
  validation; an unknown preset is a 400, never a silent fallback to the
  default. Responds with the view, matching `/seed`.
- **Paused:** `alarm()` returns without pumping and without re-arming, so pause
  genuinely stops metered generation rather than only stopping motion.
  `getView()` still ticks, against a frozen clock, so it is a no-op and
  `saveIfChanged` writes nothing.
- **Resume** calls `schedulePump(0)`, so anything that queued during the pause
  releases at once. This also recovers a board whose stall backoff had
  saturated, by the same route `getView` and `seed` already use.
- **A hop in flight when pause lands completes and is applied.** That generation
  is already paid for; discarding it would waste quota and lose a card for
  nothing. Stated rather than hidden — pause means "request no more work", not
  "abandon work in progress".

### Seeding while paused

A seed typed while paused is **accepted** and waits in the seed column,
unfanned, until resume.

Pause means stop the belt, not stop taking input. Refusing the seed would throw
away typed input for no reason, and the board already treats a silent no-op on a
user's direct action as a defect worth a 409
([board-do.ts:295](../../../src/board/board-do.ts)). Auto-resuming on seed was
rejected for the opposite reason: it makes an explicit pause silently reversible
by an unrelated action.

### Client

`public/board/index.html` gains a control row: a pause toggle carrying
`aria-pressed`, and a three-button speed radiogroup, styled to the board's
existing button idiom. `public/board/board.js` updates *only the control row*
optimistically on click — never the belt, which it has no basis to predict —
then repaints everything from the response, and reverts the control row with a
status line on failure.

Polling backs off from 900ms to ~3s while paused — nothing can change
server-side except another viewer resuming, and polling at full rate for a board
that is deliberately doing nothing is the same waste the read-path write-skip
was added to remove.

A `board-grid--paused` class on the belt grid marks the state visibly but
**subtly**. Dimming a paused board defeats the reason for pausing it.

`prefers-reduced-motion` is unaffected: this adds no motion.

## Testing

All pure, `vitest`, no Workers runtime — there is no DO test harness in this
repo ([#31](https://github.com/schmug/dewpt/issues/31)), so anything worth
asserting lives in a pure exported function.

- **`test/board-clock.test.ts`** — running advances 1:1; paused does not; resume
  does not jump; a backward real-clock jump does not rewind belt time; a board
  with no stored clock initializes epoch-continuous.
- **`test/board-belt-core.test.ts`** additions — `hungry` respects
  `hopDwellMs`; the seed fan is exempt; `nextHopAt` returns the instant the next
  hop comes due and `null` when nothing is hungry; and the load-bearing one:
  **repeated `tick()` at a frozen belt time never evaporates an edge-parked
  lineage**, which is the property that makes pause non-destructive.
- **`test/board-api.test.ts`** addition — controls payload validation; unknown
  preset rejected; `paused` must be a boolean.

Gates: `npm run typecheck` and `npm test`, counts reported.

## Files

| File | Change |
| --- | --- |
| `src/board/clock.ts` | new — pure belt clock |
| `src/board/types.ts` | `BELT_SPEEDS`, `DEFAULT_BELT_SPEED`, `BeltSpeed`, `BoardControls` |
| `src/board/belt-core.ts` | `hungry(now, hopDwellMs)`, `nextHopAt(now, hopDwellMs)` |
| `src/board/board-do.ts` | clock + controls state, `setControls`, paused guards, belt time throughout |
| `src/index.ts` | `POST /api/board/:id/controls` and its validation |
| `public/board/index.html` | control row markup |
| `public/board/board.js` | control wiring, poll backoff while paused |
| `public/board/styles.css` | control styles, `--paused` affordance |

## Out of scope

- Per-station speed. One knob for the whole belt.
- A "step one hop" button while paused. Plausible and deliberately deferred.
- Scaling `EDGE_DWELL_MS` with the preset — see the amendment note above.
- Any change to the field surface's `drizzle` slider, which is a different
  surface with a different meaning.
