// A Durable Object test harness that runs inside the ordinary `npm test`: bare
// node, no Workers runtime, no wrangler, no network, no credentials (issue #31).
//
// Why not @cloudflare/vitest-pool-workers: it runs tests inside workerd, which
// means a second vitest pool next to the bare-node one every other test uses,
// and this project's `ai` binding is `remote: true`, which the pool resolves
// through the same remote-binding proxy that dies without Cloudflare Access
// credentials (CLAUDE.md). The parts of the runtime SessionDO actually leans on
// are small, so this fakes exactly those:
//
// - `ctx.storage.sql` — backed by a REAL SQLite (node:sqlite, in memory), so
//   the DO's own CREATE/INSERT/SELECT statements run as written. Two runtime
//   behaviours are reproduced on purpose: multi-statement `exec` (migrate()
//   relies on it) and BLOB columns reading back as ArrayBuffer, not node's
//   Uint8Array — `new Float32Array(uint8)` would silently convert element by
//   element and corrupt every embedding.
// - `ctx.storage.getAlarm/setAlarm/deleteAlarm` — a single recorded time. Tests
//   fire it explicitly with `fireAlarm()`; nothing runs on a timer.
// - `ctx.blockConcurrencyWhile` — runs the callback and keeps its promise, so
//   `ready()` can await it.
// - Restart — `restart()` builds a fresh instance over the same database, which
//   is what isolate eviction looks like to a DO: memory gone, storage kept.
//
// AI goes through the production seam (`selectBudgetedAiRunner`) with the
// Workers AI branch pointed at `fakeAiRunner` from src/dev-fake-ai.ts, wrapped
// so a test can count calls and make specific ones fail or wait.
//
// Test files must stub the runtime module themselves, because vi.mock is
// hoisted per file:
//
//   vi.mock("cloudflare:workers", () => import("./helpers/cloudflare-workers-stub"));

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fakeAiRunner } from "../../src/dev-fake-ai";

type Row = Record<string, unknown>;

/** The subset of the runtime's SqlStorageCursor that SessionDO uses. */
class FakeCursor<T extends Row> {
  constructor(private readonly rows: T[]) {}
  toArray(): T[] {
    return this.rows;
  }
  one(): T {
    if (this.rows.length !== 1) throw new Error(`Expected exactly one result from SQL query, got ${this.rows.length}`);
    return this.rows[0]!;
  }
  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

function toBinding(value: unknown): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

/** The runtime hands BLOBs back as ArrayBuffer; node:sqlite hands back
 *  Uint8Array. Normalise so the code under test sees what production sees. */
function fromColumn(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

export class FakeSqlStorage {
  constructor(readonly db: DatabaseSync) {}

  exec<T extends Row = Row>(query: string, ...bindings: unknown[]): FakeCursor<T> {
    // The runtime accepts several statements in one exec when nothing is
    // bound; prepare() would compile only the first and silently drop the rest.
    if (bindings.length === 0 && /;\s*\S/.test(query.trim().replace(/;\s*$/, ""))) {
      this.db.exec(query);
      return new FakeCursor<T>([]);
    }
    const stmt = this.db.prepare(query);
    const params = bindings.map(toBinding);
    if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query) && !/\bRETURNING\b/i.test(query)) {
      stmt.run(...params);
      return new FakeCursor<T>([]);
    }
    const rows = stmt.all(...params).map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) out[k] = fromColumn(v);
      return out as T;
    });
    return new FakeCursor<T>(rows);
  }
}

export class FakeStorage {
  readonly sql: FakeSqlStorage;
  alarmAt: number | null = null;

  constructor(db: DatabaseSync) {
    this.sql = new FakeSqlStorage(db);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(time: number | Date): Promise<void> {
    this.alarmAt = typeof time === "number" ? time : time.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

export interface FakeCtx {
  id: { toString(): string; name?: string };
  storage: FakeStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(p: Promise<unknown>): void;
  /** Resolves once every blockConcurrencyWhile callback has settled. */
  ready(): Promise<void>;
}

function fakeCtx(id: string, storage: FakeStorage): FakeCtx {
  const blocking: Promise<unknown>[] = [];
  return {
    id: { toString: () => id },
    storage,
    blockConcurrencyWhile(fn) {
      const p = fn();
      blocking.push(p);
      return p;
    },
    waitUntil: () => {},
    async ready() {
      await Promise.all(blocking);
    },
  };
}

/** One AI call as the fake binding saw it. `kind` is decided from the payload
 *  shape the same way dev-fake-ai dispatches: embeddings carry `text`. */
export interface AiCall {
  model: string;
  kind: "embed" | "chat";
  inputs: Record<string, unknown>;
}

/** Runs before the fake answers. Throw to fail the call; return a promise to
 *  hold it in flight. */
export type AiInterceptor = (call: AiCall) => void | Promise<void>;

export interface FakeAi {
  calls: AiCall[];
  intercept: AiInterceptor | null;
  binding: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
}

function fakeAi(): FakeAi {
  const fake = fakeAiRunner({ latencyMs: 0 });
  const ai: FakeAi = {
    calls: [],
    intercept: null,
    binding: {
      async run(model, inputs) {
        const call: AiCall = { model, kind: inputs.text !== undefined ? "embed" : "chat", inputs };
        ai.calls.push(call);
        if (ai.intercept) await ai.intercept(call);
        return fake.run(model, inputs);
      },
    },
  };
  return ai;
}

/** The Env a DO sees. AI resolves through the real `selectBudgetedAiRunner`:
 *  DEV_FAKE_AI is left unset so the Workers AI branch is taken and lands on
 *  the instrumented binding above, and the account budget always grants. */
function fakeEnv(ai: FakeAi): Record<string, unknown> {
  let permits = 0;
  return {
    AI: ai.binding,
    GEN_MODEL: "@cf/test/gen",
    EMBED_MODEL: "@cf/test/embed",
    ACCOUNT_BUDGET: {
      getByName: () => ({
        acquireAi: async () => ({ granted: true, permitId: `permit-${++permits}` }),
        releaseAi: async () => {},
      }),
    },
  };
}

type DoClass<T> = new (ctx: never, env: never) => T;

export interface DoHarness<T> {
  /** The live instance. Replaced by `restart()`. */
  instance: T;
  ctx: FakeCtx;
  storage: FakeStorage;
  db: DatabaseSync;
  ai: FakeAi;
  /** Evict and re-construct over the same storage: in-memory state is lost,
   *  SQLite and the alarm survive, and the constructor's hydrate runs again. */
  restart(): Promise<T>;
  /** Fire the pending alarm the way the runtime does: cleared first, then
   *  `alarm()` invoked. Returns false when no alarm was set. */
  fireAlarm(): Promise<boolean>;
  /** Fire alarms until none is pending — a pump that has filled its pool.
   *  Throws past `max` so a pump that never settles fails loudly. */
  drainAlarms(max?: number): Promise<number>;
  /** Raw rows, for asserting on what was actually written. */
  rows<R extends Row = Row>(query: string, ...bindings: unknown[]): R[];
}

export async function createDoHarness<T extends { alarm(): Promise<void> }>(
  Class: DoClass<T>,
  { id = "test-do" }: { id?: string } = {},
): Promise<DoHarness<T>> {
  const db = new DatabaseSync(":memory:");
  const storage = new FakeStorage(db);
  const ai = fakeAi();
  const env = fakeEnv(ai);

  const construct = async () => {
    const ctx = fakeCtx(id, storage);
    const instance = new Class(ctx as never, env as never);
    await ctx.ready();
    return { ctx, instance };
  };

  const first = await construct();
  const harness: DoHarness<T> = {
    instance: first.instance,
    ctx: first.ctx,
    storage,
    db,
    ai,
    async restart() {
      const next = await construct();
      harness.instance = next.instance;
      harness.ctx = next.ctx;
      return next.instance;
    },
    async fireAlarm() {
      if (storage.alarmAt === null) return false;
      storage.alarmAt = null;
      await harness.instance.alarm();
      return true;
    },
    async drainAlarms(max = 200) {
      let fired = 0;
      while (await harness.fireAlarm()) {
        if (++fired > max) throw new Error(`alarm still pending after ${max} fires — the pump never settled`);
      }
      return fired;
    },
    rows(query, ...bindings) {
      return storage.sql.exec(query, ...bindings).toArray() as never;
    },
  };
  return harness;
}
