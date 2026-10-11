// SessionDO driven for real: its own SQL against a real (in-memory) SQLite,
// its own alarm pump, restarts that re-run hydrate(). The harness and why it
// is shaped this way are in test/helpers/do-harness.ts (issue #31).

import { describe, expect, it, vi } from "vitest";
import { SessionDO } from "../src/session-do";
import type { Axis, SerializedAxis } from "../src/types";
import { createDoHarness, type DoHarness } from "./helpers/do-harness";

vi.mock("cloudflare:workers", () => import("./helpers/cloudflare-workers-stub"));

/** The in-memory axes, which carry `expanded` per pole. SerializedAxis folds
 *  it into `degraded`, so the round trip is asserted on the real field. */
function coreAxes(session: SessionDO): Axis[] {
  return (session as unknown as { core: { axes(): Axis[] } }).core.axes();
}

/** A session past init with its pump drained: the pool is full and no alarm
 *  is pending, so any alarm set afterwards was set by the code under test.
 *  That is the scenario the failed-embed kick exists for — against a full
 *  pool, nothing else would ever wake the pump. */
async function settledSession(): Promise<DoHarness<SessionDO>> {
  const h = await createDoHarness(SessionDO);
  await h.instance.init("s1", "security awareness");
  await h.drainAlarms();
  expect(h.storage.alarmAt).toBeNull();
  return h;
}

function axisNamed(axes: SerializedAxis[] | null, negTerm: string): SerializedAxis {
  const axis = axes?.find((a) => a.neg.term === negTerm);
  if (!axis) throw new Error(`no axis with neg term ${negTerm}`);
  return axis;
}

describe("SessionDO harness", () => {
  it("constructs, persists to SQLite, and hydrates the same session after a restart", async () => {
    const h = await createDoHarness(SessionDO);
    expect(await h.instance.getInfo()).toBeNull();

    await h.instance.init("s1", "  security awareness  ");
    const meta = h.rows<{ value: string }>("SELECT value FROM meta WHERE key = 'meta'");
    expect(JSON.parse(meta[0]!.value)).toMatchObject({ id: "s1", seed: "security awareness" });
    expect(h.storage.alarmAt).not.toBeNull(); // init kicks the first pass

    await h.drainAlarms();
    expect(h.rows("SELECT text FROM pool").length).toBeGreaterThan(0);

    const before = await h.instance.getInfo();
    const after = await (await h.restart()).getInfo();
    expect(after).toEqual(before);
  });
});

describe("SessionDO axes", () => {
  it("an axis survives create → persist → restart → hydrate with expanded: false intact", async () => {
    const h = await settledSession();
    // Fail only the "frozen" expansion, so this axis carries one unexpanded
    // pole and one expanded one — both values of the boolean in one row.
    h.ai.intercept = (call) => {
      if (call.kind === "chat" && JSON.stringify(call.inputs).includes("frozen")) throw new Error("model down");
    };

    const result = await h.instance.createAxis("frozen", "molten");
    expect(result).toMatchObject({ created: true });
    const [created] = coreAxes(h.instance);
    expect(created!.neg).toMatchObject({ term: "frozen", phrase: "frozen", expanded: false });
    expect(created!.pos.expanded).toBe(true);

    const [row] = h.rows<{ neg_expanded: number; pos_expanded: number }>("SELECT neg_expanded, pos_expanded FROM axes");
    expect(row).toEqual({ neg_expanded: 0, pos_expanded: 1 });

    const restarted = await h.restart();
    const [hydrated] = coreAxes(restarted);
    expect(hydrated!.neg.expanded).toBe(false);
    expect(hydrated!.pos.expanded).toBe(true);
    // The embeddings came back through the BLOB column intact (at the float32
    // precision the column stores), so the axis is still serving coordinates —
    // and still honestly reports its bare pole.
    expect(hydrated!.neg.embedding).toEqual(Array.from(new Float32Array(created!.neg.embedding!)));
    expect(axisNamed(await restarted.listAxes(), "frozen")).toMatchObject({ ready: true, degraded: true });
  });

  it("a failed pole embed kicks the pump, and a later pass fills the embedding", async () => {
    const h = await settledSession();
    let failed = false;
    h.ai.intercept = (call) => {
      if (call.kind === "embed" && !failed && JSON.stringify(call.inputs).includes("calm")) {
        failed = true;
        throw new Error("embed down");
      }
    };

    const result = await h.instance.createAxis("calm", "storm");
    expect(result).toMatchObject({ created: true });
    expect(failed).toBe(true);
    expect(axisNamed(await h.instance.listAxes(), "calm").ready).toBe(false);
    // Persisted unembedded, not dropped.
    expect(h.rows("SELECT id FROM axes WHERE neg_embedding IS NULL AND pos_embedding IS NULL")).toHaveLength(1);
    // The pool was full, so this alarm exists only because createAxis set it.
    expect(h.storage.alarmAt).not.toBeNull();

    await h.drainAlarms();
    expect(axisNamed(await h.instance.listAxes(), "calm").ready).toBe(true);
    expect(h.rows("SELECT id FROM axes WHERE neg_embedding IS NULL OR pos_embedding IS NULL")).toHaveLength(0);
    expect(axisNamed(await (await h.restart()).listAxes(), "calm").ready).toBe(true);
  });

  it("axisCreationsInFlight stops a second concurrent create at the cap from spending AI calls", async () => {
    const h = await settledSession();
    await h.instance.createAxis("cold", "hot");
    await h.instance.createAxis("quiet", "loud");
    expect(await h.instance.listAxes()).toHaveLength(2);

    // Hold the first create's pole expansions in flight, so the second
    // arrives while the axis count still reads 2 of 3.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.ai.intercept = (call) => (call.kind === "chat" ? gate : undefined);
    const callsBefore = h.ai.calls.length;

    const first = h.instance.createAxis("small", "large");
    const second = h.instance.createAxis("dull", "sharp");
    await new Promise((r) => setTimeout(r, 0)); // let both reach their awaits
    // Only the first create's two expansions — the second paid for nothing.
    expect(h.ai.calls.slice(callsBefore).filter((c) => c.kind === "chat")).toHaveLength(2);

    release();
    expect(await second).toMatchObject({ created: false, reason: "cap" });
    expect(await first).toMatchObject({ created: true });
    expect(await h.instance.listAxes()).toHaveLength(3);
  });
});
