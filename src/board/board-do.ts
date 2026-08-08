// Thin stateful shell for one board session. All belt logic lives in BeltCore
// and all scoring in rewrite.ts; this file does storage, the alarm loop, and
// the AI calls — mirroring how SessionDO wraps PoolCore.
//
// Two invariants this file, and only this file, is responsible for:
//
//  - A state read never waits on generation. getView() ticks, saves and
//    returns; the alarm pump refills behind it. A lineage with a hop in flight
//    still serves its current head.
//  - No embeddings on the wire. BeltCore.view() is embedding-free by
//    construction, but lineages(), stations(), hungry() and serialize() all
//    carry them, so "only view() reaches the wire" is a discipline this file
//    keeps rather than a property the type system enforces. src/index.ts
//    re-checks it structurally at the route boundary.

import { DurableObject } from "cloudflare:workers";
import { fakeAiRunner } from "../dev-fake-ai";
import { embedTexts, expandPole, type AiRunner } from "../generation";
import { BeltCore, type BeltCoreState, type BoardView } from "./belt-core";
import { generateRewrites, hasArrived, selectChild } from "./rewrite";
import { CANDIDATES_PER_HOP, DEFAULT_STATION_TERMS, type Station } from "./types";

const PUMP_MS = 500;
/** Ceiling on the backoff below. A board can be legitimately stuck forever —
 *  a station whose pole expansion failed never becomes ready — and at a flat
 *  500ms that is an unbounded wake loop against a live account. */
const PUMP_RETRY_MAX_MS = 30_000;
const PUMP_BACKOFF_MAX_SHIFT = 8;

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
    // No id factory: BeltCore defaults to crypto.randomUUID(). It must NOT be
    // given a counter here — this object hibernates and wakes on a fresh
    // isolate, so a module-scope counter replays its sequence against hydrated
    // state that already holds those ids, routing hops into the wrong lineage.
    this.belt = new BeltCore(state ?? {});
    this.ready = true;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("belt", this.belt.serialize());
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
   *  edge-parked lineages for a client that is polling. */
  async getView(): Promise<BoardView | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    this.belt.tick(Date.now());
    await this.save();
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
      console.error(JSON.stringify({ level: "error", message: "board pump failed", error: String(error) }));
    } finally {
      this.pumping = false;
      this.pumpFailures = result === "stalled" ? this.pumpFailures + 1 : 0;
      await this.rearm();
    }
  }

  /** Reschedule, unless the board has nothing left to do. An idle board lets its
   *  alarm lapse and is re-armed by the next init/getView/seed, so a board
   *  nobody is watching does not wake twice a second forever. */
  private async rearm(): Promise<void> {
    try {
      if (this.ready && !this.hasPendingWork()) return;
      const shift = Math.min(this.pumpFailures, PUMP_BACKOFF_MAX_SHIFT);
      await this.ctx.storage.setAlarm(Date.now() + Math.min(PUMP_RETRY_MAX_MS, PUMP_MS * 2 ** shift));
    } catch (error) {
      // Storage itself is failing; there is no way left to reschedule.
      console.error(JSON.stringify({ level: "error", message: "board rearm failed", error: String(error) }));
    }
  }

  private hasPendingWork(): boolean {
    if (this.belt.hungry().length > 0) return true;
    // An edge-parked lineage still needs the tick that evicts it.
    return this.belt.lineages().some((l) => l.edgeAt !== null);
  }

  /** One hop for one hungry lineage per tick. Every failure mode here is
   *  contained: an embedding or generation fault abandons the hop and counts
   *  against MAX_HOP_FAILURES rather than propagating. */
  private async pumpOnce(): Promise<PumpResult> {
    const hop = this.belt.hungry()[0];
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
        // Never ask for fewer candidates than the fan needs children, so
        // raising SEED_FANOUT above CANDIDATES_PER_HOP cannot quietly starve
        // the first hop. At the calibrated values (4 and 3) this is just 4.
        count: Math.max(CANDIDATES_PER_HOP, hop.count),
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
        const chosen: { text: string; embedding: number[] }[] = [];
        const exclude = [...history];
        const remaining = [...candidates];
        for (let i = 0; i < hop.count; i++) {
          const pick = selectChild(parentEmb, station.embedding, remaining, { exclude });
          if (!pick) break;
          chosen.push({ text: pick.text, embedding: pick.embedding });
          exclude.push(pick.embedding);
          // Guarded: a bare splice(-1, 1) on a miss would drop the LAST
          // candidate instead. The pick always comes from `remaining`, so the
          // miss is unreachable — but the failure mode is silent, so it is
          // cheaper to exclude it than to reason about it again later.
          const taken = remaining.findIndex((c) => c.text === pick.text);
          if (taken !== -1) remaining.splice(taken, 1);
        }
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
