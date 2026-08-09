// Thin stateful shell for one board session. All belt logic lives in BeltCore
// and all scoring in rewrite.ts; this file does storage, the alarm loop, and
// the AI calls — mirroring how SessionDO wraps PoolCore.
//
// Two invariants this file, and only this file, is responsible for:
//
//  - A state read never waits on generation. getView() ticks, persists only if
//    that tick changed something, and returns; the alarm pump refills behind
//    it. A lineage with a hop in flight still serves its current head.
//  - No embeddings on the wire. BeltCore.view() is embedding-free by
//    construction, but lineages(), stations(), hungry() and serialize() all
//    carry them, so "only view() reaches the wire" is a discipline this file
//    keeps rather than a property the type system enforces. src/index.ts
//    re-checks it structurally at the route boundary.

import { DurableObject } from "cloudflare:workers";
import { fakeAiRunner } from "../dev-fake-ai";
import { embedTexts, expandPole, type AiRunner } from "../generation";
import { BeltCore, type BeltCoreState, type BoardView } from "./belt-core";
import { generateRewrites, hasArrived, selectChild, type Candidate } from "./rewrite";
import { CANDIDATES_PER_HOP, DEFAULT_BELT_SPEED, DEFAULT_STATION_TERMS, hopDwellMs, type Station } from "./types";

const PUMP_MS = 500;
/** Ceiling on the backoff below. A board can be legitimately stuck forever —
 *  a station whose pole expansion failed never becomes ready — and at a flat
 *  500ms that is an unbounded wake loop against a live account. */
const PUMP_RETRY_MAX_MS = 30_000;
const PUMP_BACKOFF_MAX_SHIFT = 8;

/** Consecutive stalled ticks after which the board stops re-arming its own
 *  alarm. Past this point the backoff has saturated, so every further wake is
 *  one storage write and one alarm for a board that provably did no work and
 *  spent no AI quota — measured at 20 wakes / 20 writes / 0 AI calls, i.e.
 *  ~2,880 alarms a day per board, forever.
 *
 *  A board really can be stuck for good: `prepareStations` is one-shot (only
 *  `init()` runs it, and only on an empty board), `embedTexts` throws on a
 *  transient AI fault, and `pumpOnce` returns "stalled" before reaching
 *  `noteHopFailure`, so nothing ever releases the lineage.
 *
 *  Stopping is not terminal — `init`, `getView` and `seed` all call
 *  `schedulePump`, so the board resumes the moment anyone touches it. The
 *  alternative (count stalls toward `noteHopFailure` so the lineage releases)
 *  was rejected: this stall is a STATION fault, not a lineage fault, so it
 *  would release every lineage on the board in turn and evaporate the user's
 *  typed seeds over an outage that may last seconds. Losing typed input to a
 *  retryable fault is worse than an alarm that has to be re-armed by a poll. */
const MAX_CONSECUTIVE_STALLS = PUMP_BACKOFF_MAX_SHIFT;

/** Storage key for the consecutive-stall counter above, which is DURABLE
 *  rather than just a field. The counter is ticked by wakes up to 30 seconds
 *  apart and nothing keeps the object in memory between them, so an evicted
 *  isolate would reload with the counter at zero, restart the backoff ladder,
 *  and go on waking forever — the give-up would read as implemented and do
 *  nothing. Whether eviction actually occurs at this cadence is a property of
 *  the platform that is NOT measured here; persisting costs one write per
 *  change, only while the count is moving, and makes the give-up hold either
 *  way. The probe covers both: a hot isolate and a fresh one per wake stop at
 *  the same point. */
const STALLS_KEY = "stalls";

/** Candidates to request from one generation call for a hop that needs
 *  `childCount` children.
 *
 *  This ADDS rather than taking a maximum, and the difference is the whole
 *  point. `CANDIDATES_PER_HOP` is calibrated PER CHILD: M0 measured 4 as the
 *  smallest width that still left at least 3 candidates above the tether floor
 *  for a hop needing ONE child, and the measured minimum was exactly 3 — no
 *  slack. A fan of k spends that slack twice, because every pick is added to
 *  the sibling exclude set as well as being consumed, so a single near-
 *  duplicate pair inside the batch costs an entire child. `Math.max(4, 3)`
 *  asked for 4 candidates to fill 3 slots and, on the M0 minimum plus one
 *  sibling collision, delivered 2 — silently, since `applySeedFan` splices in
 *  however many arrived and the spawned lineages then have `count === 1`
 *  forever. There is no second chance at a fan.
 *
 *  So the width has to FOLLOW the fan: k children need k-1 more candidates
 *  than one child does. Raising SEED_FANOUT widens the request automatically,
 *  because the calibrated number it is added to is a per-child quantity and
 *  nothing else scales it.
 *
 *  This MOVES the cliff, it does not remove it. Measured law:
 *  `delivered = min(k, dedupe-clusters among tether survivors)`. At the shipped
 *  k=3 and width 6, a fan under-fills once the survivors span fewer than 3
 *  clusters — 5 survivors tolerate 2 collisions, 4 tolerate 1, 3 tolerate none.
 *  Width 4 broke on the FIRST collision, so the reported defect is closed, but
 *  the margin is one collision rather than a guarantee.
 *
 *  The widening also does not preserve that margin as k grows. Reading M0's
 *  rejection proportionally rather than absolutely, tolerance is 1 collision at
 *  k=3-6 and ZERO at k=8-9. Width 6 was itself never measured — M0 only ever
 *  measured width 4 — so anyone raising SEED_FANOUT past ~6 should re-run
 *  `npm run board-calibrate` rather than trust this formula to keep up. */
export function candidateWidth(childCount: number): number {
  return childCount > 1 ? CANDIDATES_PER_HOP + childCount - 1 : CANDIDATES_PER_HOP;
}

/** Pick up to `count` distinct children out of one candidate batch, excluding
 *  the lineage's own history and each sibling already chosen.
 *
 *  Exported and pure so the loop `candidateWidth` feeds can be exercised
 *  directly — there is no DO test harness in this repo (issue #31), and this
 *  loop under-filling is exactly the defect that survived because of it.
 *
 *  An under-fill is REPORTED rather than swallowed. A board that promises
 *  SEED_FANOUT rows and quietly ships two is the failure the width fix exists
 *  to prevent; if it still happens it has to be diagnosable from a log rather
 *  than from someone counting rows. Deliberately no retry: the batch is what it
 *  is on this tick, and a second generation call per fan is real quota spent on
 *  a case the width is now sized to avoid. */
export function selectFan(
  parentEmb: number[],
  stationEmb: number[],
  candidates: Candidate[],
  count: number,
  history: number[][],
  lineageId: string,
): Candidate[] {
  const chosen: Candidate[] = [];
  const exclude = [...history];
  const remaining = [...candidates];
  for (let i = 0; i < count; i++) {
    const pick = selectChild(parentEmb, stationEmb, remaining, { exclude });
    if (!pick) break;
    chosen.push({ text: pick.text, embedding: pick.embedding });
    exclude.push(pick.embedding);
    // Guarded: a bare splice(-1, 1) on a miss would drop the LAST candidate
    // instead. The pick always comes from `remaining`, so the miss is
    // unreachable — but the failure mode is silent, so it is cheaper to
    // exclude it than to reason about it again later.
    const taken = remaining.findIndex((c) => c.text === pick.text);
    if (taken !== -1) remaining.splice(taken, 1);
  }
  if (chosen.length < count) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "seed fan under-filled",
        lineage: lineageId,
        requested: count,
        delivered: chosen.length,
        candidates: candidates.length,
      }),
    );
  }
  return chosen;
}

/** Exact bytes of a belt state, for deciding whether a write is worth making.
 *
 *  Exported and pure because the property the read path's write-skip rests on —
 *  a tick that changes nothing leaves this string identical, a tick that evicts
 *  changes it — is testable here and nowhere else: there is no Durable Object
 *  test harness in this repo (issue #31), so `saveIfChanged` itself is only
 *  reachable lexically.
 *
 *  The comparison can only err toward writing. Two states that differ in any
 *  value differ in this string; the one thing that can make equal states differ
 *  is object key ORDER, which produces a redundant write rather than a skipped
 *  one. That asymmetry is the whole safety argument, so preserve it if this is
 *  ever replaced with something cheaper — a narrower fingerprint (say, just the
 *  fields `tick` is known to touch) is faster and fails in the other direction,
 *  silently dropping a durable write when the belt grows a mutation the
 *  fingerprint does not cover.
 *
 *  Cost: this stringifies embeddings, which dominate the state. It is only ever
 *  computed on a path that was already serializing the same state to hand to
 *  `storage.put`, so it replaces a write with a stringify rather than adding
 *  work to a path that had none. */
export function beltFingerprint(state: BeltCoreState): string {
  return JSON.stringify(state);
}

/** What one pump tick accomplished, which is what the backoff keys off.
 *  "idle" and "stalled" are deliberately distinct: idle means there was no work
 *  (don't back off, just stop rescheduling), stalled means there WAS work and it
 *  could not proceed (back off — retrying at full rate changes nothing). */
type PumpResult = "progressed" | "idle" | "stalled";

export class BoardDO extends DurableObject<Env> {
  private belt!: BeltCore;
  private ready = false;
  private pumping = false;
  private pumpFailures = 0;
  /** Last value of `pumpFailures` written to storage, so a healthy board adds
   *  no write per tick. */
  private persistedFailures = 0;
  /** `beltFingerprint` of the belt state storage currently holds, or null when
   *  that is unknown — nothing loaded, nothing saved. Set only after a `put`
   *  resolves, so a write that throws leaves the previous value standing and the
   *  next save retries rather than assuming it landed. */
  private persistedBelt: string | null = null;
  private devFakeAi: AiRunner | null = null;

  private aiRunner(): AiRunner {
    // dev-only escape hatch for local runtimes with no egress; see dev-fake-ai.ts
    if ((this.env as Env & { DEV_FAKE_AI?: string }).DEV_FAKE_AI === "1") {
      this.devFakeAi ??= fakeAiRunner();
      return this.devFakeAi;
    }
    const ai = this.env.AI;
    return {
      run: (model, inputs) => ai.run(model as Parameters<typeof ai.run>[0], inputs as Parameters<typeof ai.run>[1]),
    };
  }

  private async load(): Promise<void> {
    if (this.ready) return;
    const state = await this.ctx.storage.get<BeltCoreState>("belt");
    // Rehydrated, not reset: see STALLS_KEY. A board that has already given up
    // must still be given up after the eviction that its own backoff invites.
    this.pumpFailures = (await this.ctx.storage.get<number>(STALLS_KEY)) ?? 0;
    this.persistedFailures = this.pumpFailures;
    // No id factory: BeltCore defaults to crypto.randomUUID(). It must NOT be
    // given a counter here — this object hibernates and wakes on a fresh
    // isolate, so a module-scope counter replays its sequence against hydrated
    // state that already holds those ids, routing hops into the wrong lineage.
    this.belt = new BeltCore(state ?? {});
    // Baseline for saveIfChanged, taken from the HYDRATED belt rather than the
    // raw record: the constructor canonicalizes (stations sorted, absent arrays
    // defaulted), and it is the canonical form every later save would write. A
    // stored record that differs from it only in that canonicalization is
    // therefore treated as already-persisted, which is correct — every load
    // canonicalizes, so nothing downstream can observe the stored order.
    this.persistedBelt = state === undefined ? null : beltFingerprint(this.belt.serialize());
    this.ready = true;
  }

  /** Unconditional write, for the paths that just changed something. */
  private async save(): Promise<void> {
    const state = this.belt.serialize();
    await this.ctx.storage.put("belt", state);
    this.persistedBelt = beltFingerprint(state);
  }

  /** Write only if the belt differs from what storage holds — the same
   *  write-through-on-change-only discipline `persistStalls` already uses,
   *  applied to the read path.
   *
   *  The read path is where this matters and the other callers are not, because
   *  it is the only one whose sole mutation is a `tick` that is usually a no-op,
   *  and the only one a client repeats about once a second for as long as the
   *  board is open. Unconditional, that is one storage write per poll per board
   *  forever, on a board where nothing is happening at all. */
  private async saveIfChanged(): Promise<void> {
    const state = this.belt.serialize();
    const fingerprint = beltFingerprint(state);
    if (fingerprint === this.persistedBelt) return;
    await this.ctx.storage.put("belt", state);
    this.persistedBelt = fingerprint;
  }

  // ---- RPC ------------------------------------------------------------------

  /** Create the session with the three default stations. Pole expansion runs in
   *  the background: a station without an embedding reports not-ready and holds
   *  its lineages rather than falling through to unscored selection, which
   *  would be indistinguishable from working. */
  async init(): Promise<BoardView> {
    await this.load();
    if (this.belt.stations().length === 0) {
      const stations: Station[] = DEFAULT_STATION_TERMS.map((term, i) => ({
        id: `s${i + 1}`,
        order: i + 1,
        term,
        phrase: term,
        expanded: false,
        embedding: null,
      }));
      this.belt = new BeltCore({ ...this.belt.serialize(), stations });
      await this.save();
      this.ctx.waitUntil(this.prepareStations());
    }
    await this.schedulePump(PUMP_MS);
    return this.belt.view();
  }

  /** Never awaits generation — see the header. Ticking here is what evicts
   *  edge-parked lineages for a client that is polling.
   *
   *  The tick runs on EVERY read and the write does not. Skipping the tick would
   *  break eviction on a board nobody is otherwise touching — an idle board lets
   *  its alarm lapse, so the poll is the only thing left driving time forward —
   *  but the tick is a no-op on almost all of those reads, and persisting an
   *  unchanged belt is a metered storage write bought for nothing. */
  async getView(): Promise<BoardView | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    this.belt.tick(Date.now());
    await this.saveIfChanged();
    await this.schedulePump(PUMP_MS);
    return this.belt.view();
  }

  /** `addSeed` returns false when the board is at MAX_LINEAGES. That boolean
   *  MUST be honoured and surfaced: discarding it makes a full board answer 200
   *  with an unchanged view — the typed word simply vanishes, with no error, no
   *  status, and nothing for `if (!res.ok)` to catch. A silent no-op on a user's
   *  direct action is worse than an error. The route turns `accepted: false`
   *  into a 409 with the view attached. */
  async seed(text: string): Promise<{ view: BoardView; accepted: boolean } | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    const accepted = this.belt.addSeed(text, Date.now());
    if (accepted) {
      await this.save();
      await this.schedulePump(0);
    }
    return { view: this.belt.view(), accepted };
  }

  // ---- station preparation ----------------------------------------------------

  /** Expand each default term to a descriptive phrase and embed it. A bare term
   *  costs ~0.34 AUC to polysemy, so a station that fails expansion stays
   *  flagged degraded rather than passing as normal.
   *
   *  The serialize -> mutate -> reconstruct below must stay synchronous. An
   *  await between the read and the write would let a pump tick land a hop in
   *  the gap and have this overwrite it. */
  private async prepareStations(): Promise<void> {
    const ai = this.aiRunner();
    for (const station of this.belt.stations()) {
      try {
        const expanded = await expandPole(ai, this.env.GEN_MODEL, station.term);
        const [embedding] = await embedTexts(ai, this.env.EMBED_MODEL, [expanded.phrase]);
        const current = this.belt.serialize();
        const target = current.stations.find((s) => s.id === station.id);
        if (!target) continue;
        target.phrase = expanded.phrase;
        target.expanded = expanded.expanded;
        target.embedding = embedding ?? null;
        this.belt = new BeltCore(current);
        await this.save();
        await this.schedulePump(0);
      } catch (error) {
        console.error(
          JSON.stringify({ level: "error", message: "station prepare failed", station: station.term, error: String(error) }),
        );
      }
    }
  }

  // ---- generation pump ---------------------------------------------------------

  private async schedulePump(delayMs: number): Promise<void> {
    const target = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    // Pull the alarm forward on user activity; never push it out.
    if (existing === null || existing > target) await this.ctx.storage.setAlarm(target);
  }

  /** A throw must never escape this method. `scoreCandidates`, `selectChild`
   *  and `hasArrived` all throw on an embedding-dimension mismatch — deliberate,
   *  so a model swap is diagnosed rather than silently scored on a truncated
   *  prefix — and the alarm is where that would otherwise freeze the board for
   *  good, since a failed alarm stops rescheduling itself. */
  async alarm(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    let result: PumpResult = "stalled";
    try {
      await this.load();
      this.belt.tick(Date.now());
      result = await this.pumpOnce();
      await this.save();
    } catch (error) {
      // Force the failure state. `result` is assigned as soon as pumpOnce
      // returns, so a save() that throws underneath a successful pump would
      // otherwise leave it "progressed", reset the backoff, and put a board
      // whose storage is failing back on a 500ms retry loop (probed: six
      // consecutive failing ticks, backoff 0 throughout).
      result = "stalled";
      console.error(JSON.stringify({ level: "error", message: "board pump failed", error: String(error) }));
    } finally {
      this.pumping = false;
      const stalls = result === "stalled" ? Math.min(this.pumpFailures + 1, MAX_CONSECUTIVE_STALLS) : 0;
      // Announce the give-up once, as it happens: from here the board produces
      // nothing until someone touches it, and that should not be silent.
      if (stalls === MAX_CONSECUTIVE_STALLS && this.pumpFailures < MAX_CONSECUTIVE_STALLS) {
        console.warn(
          JSON.stringify({ level: "warn", message: "board pump gave up after consecutive stalls", stalls }),
        );
      }
      this.pumpFailures = stalls;
      await this.persistStalls();
      await this.rearm();
    }
  }

  /** Write-through, on change only, so a healthy board pays no extra write.
   *  Never throws: this runs inside the alarm's `finally`. */
  private async persistStalls(): Promise<void> {
    if (this.pumpFailures === this.persistedFailures) return;
    try {
      await this.ctx.storage.put(STALLS_KEY, this.pumpFailures);
      this.persistedFailures = this.pumpFailures;
    } catch (error) {
      console.error(
        JSON.stringify({ level: "error", message: "board stall counter write failed", error: String(error) }),
      );
    }
  }

  /** Reschedule, unless the board has nothing left to do or has given up. An
   *  idle board lets its alarm lapse and is re-armed by the next
   *  init/getView/seed, so a board nobody is watching does not wake twice a
   *  second forever; a stalled board stops for the same reason, one saturated
   *  backoff later. */
  private async rearm(): Promise<void> {
    try {
      if (this.ready && !this.hasPendingWork()) return;
      if (this.pumpFailures >= MAX_CONSECUTIVE_STALLS) return;
      const shift = Math.min(this.pumpFailures, PUMP_BACKOFF_MAX_SHIFT);
      // Through schedulePump, NOT a raw setAlarm: this must pull the alarm
      // forward and never push it out. A seed landing mid-pump has already
      // asked for 0ms, and a raw set here moved it to the full 30s backoff.
      await this.schedulePump(Math.min(PUMP_RETRY_MAX_MS, PUMP_MS * 2 ** shift));
    } catch (error) {
      // Storage itself is failing; there is no way left to reschedule.
      console.error(JSON.stringify({ level: "error", message: "board rearm failed", error: String(error) }));
    }
  }

  private hasPendingWork(): boolean {
    if (this.belt.nextHopAt(hopDwellMs(DEFAULT_BELT_SPEED)) !== null) return true;
    // An edge-parked lineage still needs the tick that evicts it.
    return this.belt.lineages().some((l) => l.edgeAt !== null);
  }

  /** One hop for one hungry lineage per tick. Every failure mode here is
   *  contained: an embedding or generation fault abandons the hop and counts
   *  against MAX_HOP_FAILURES rather than propagating. */
  private async pumpOnce(): Promise<PumpResult> {
    const hop = this.belt.hungry(Date.now(), hopDwellMs(DEFAULT_BELT_SPEED))[0];
    if (!hop) return "idle";
    const station = this.belt.stations()[hop.stationIndex - 1];
    // Hold rather than guess. Selecting without a station embedding produces
    // unscored output that is indistinguishable from scored output.
    if (!station || station.embedding === null) return "stalled";

    const ai = this.aiRunner();
    const now = () => Date.now();
    try {
      let parentEmb = hop.parentEmbedding;
      if (parentEmb === null) {
        [parentEmb] = await embedTexts(ai, this.env.EMBED_MODEL, [hop.parentText]);
        if (!parentEmb) return "stalled";
        // Write it back. A seed card is created with `embedding: null`, and
        // without this it is recomputed and then dropped on the floor every
        // single hop of its lineage — so it never joins the exclude set and a
        // child can restate the seed verbatim with nothing hard-blocking it.
        this.persistHeadEmbedding(hop.lineageId, parentEmb);
      }

      if (hasArrived(parentEmb, station.embedding)) {
        this.belt.markArrived(hop.lineageId, now());
        return "progressed";
      }

      const lineage = this.belt.lineages().find((l) => l.id === hop.lineageId);
      const history = (lineage?.cards ?? []).map((c) => c.embedding).filter((e): e is number[] => e !== null);
      const texts = await generateRewrites(ai, this.env.GEN_MODEL, {
        fragment: hop.parentText,
        target: station.phrase,
        count: candidateWidth(hop.count),
        exclude: (lineage?.cards ?? []).map((c) => c.text),
      });
      if (texts.length === 0) {
        this.belt.noteHopFailure(hop.lineageId, now());
        return "progressed";
      }

      const vecs = await embedTexts(ai, this.env.EMBED_MODEL, texts);
      const candidates = texts.flatMap((text, i) => (vecs[i] ? [{ text, embedding: vecs[i]! }] : []));

      // A seed's first hop takes several children at once, so one generation
      // call turns a lone seed into a fanned board.
      if (hop.count > 1) {
        const chosen = selectFan(parentEmb, station.embedding, candidates, hop.count, history, hop.lineageId);
        if (chosen.length === 0) {
          this.belt.noteHopFailure(hop.lineageId, now());
          return "progressed";
        }
        this.belt.applySeedFan(hop.lineageId, chosen, now());
        return "progressed";
      }

      const pick = selectChild(parentEmb, station.embedding, candidates, { exclude: history });
      if (!pick) {
        this.belt.noteHopFailure(hop.lineageId, now());
        return "progressed";
      }
      this.belt.applyHop(hop.lineageId, { text: pick.text, embedding: pick.embedding }, now());
      return "progressed";
    } catch (error) {
      console.error(
        JSON.stringify({ level: "error", message: "hop failed", lineage: hop.lineageId, error: String(error) }),
      );
      this.belt.noteHopFailure(hop.lineageId, now());
      return "progressed";
    }
  }

  /** Persist a freshly computed embedding onto a lineage's head card. BeltCore
   *  exposes no card-level setter, so this goes through the same
   *  serialize -> mutate -> reconstruct path as prepareStations, and like it
   *  must stay synchronous so no concurrent tick is overwritten. */
  private persistHeadEmbedding(lineageId: string, embedding: number[]): void {
    const state = this.belt.serialize();
    const head = state.lineages.find((l) => l.id === lineageId)?.cards.at(-1);
    if (!head || head.embedding !== null) return;
    head.embedding = embedding;
    this.belt = new BeltCore(state);
  }
}
