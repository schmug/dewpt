// Shared abuse controls for public object creation and every Workers AI call.
// ClientRateLimitDO is sharded by the Cloudflare-authenticated client IP;
// AccountBudgetDO is deliberately one account-wide coordination atom because
// its limits and concurrency lease must be exact across sessions and boards.

import { DurableObject } from "cloudflare:workers";
import { ABUSE_LIMITS, type AiPermit } from "./ai-budget";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export type AdmissionKind = "request" | "creation";

export interface AdmissionResult {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: string;
}

interface CounterRow extends Record<string, SqlStorageValue> {
  window_start: number;
  units: number;
}

interface BudgetWindow {
  scope: string;
  windowMs: number;
  limit: number;
  amount: number;
}

function retryAfterSeconds(windowStart: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((windowStart + windowMs - now) / SECOND_MS));
}

/** Per-client fixed windows. One instance is addressed by client IP, so no raw
 * client identifier is stored and unrelated clients do not share a hot object. */
export class ClientRateLimitDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS windows (
          kind TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          units INTEGER NOT NULL
        )
      `);
    });
  }

  async admit(kind: AdmissionKind): Promise<AdmissionResult> {
    const now = Date.now();
    const limit =
      kind === "creation" ? ABUSE_LIMITS.creationsPerClientMinute : ABUSE_LIMITS.requestsPerClientMinute;
    const row = this.window(kind, MINUTE_MS, now);
    if (row.units >= limit) {
      const retry = retryAfterSeconds(row.window_start, MINUTE_MS, now);
      console.warn(JSON.stringify({ level: "warn", message: "client admission denied", kind, retry }));
      return { allowed: false, retryAfterSeconds: retry, reason: `client ${kind} limit` };
    }
    this.writeWindow(kind, row.window_start, row.units + 1);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private window(scope: string, windowMs: number, now: number): CounterRow {
    const start = Math.floor(now / windowMs) * windowMs;
    const row = this.ctx.storage.sql.exec<CounterRow>(
      "SELECT window_start, units FROM windows WHERE kind = ?",
      scope,
    ).toArray()[0];
    return row && row.window_start === start ? row : { window_start: start, units: 0 };
  }

  private writeWindow(scope: string, start: number, units: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO windows (kind, window_start, units) VALUES (?, ?, ?)",
      scope,
      start,
      units,
    );
  }
}

/** Exact account-wide creation, AI-unit, and AI-concurrency enforcement. The
 * single object is intentional: sharding would let simultaneous attackers
 * overshoot the hard account ceiling the class exists to enforce. */
export class AccountBudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          scope TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          units INTEGER NOT NULL,
          PRIMARY KEY (scope, window_start)
        );
        CREATE TABLE IF NOT EXISTS ai_leases (
          permit_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  async admitCreation(): Promise<AdmissionResult> {
    const now = Date.now();
    const windows: BudgetWindow[] = [
      { scope: "creation:minute", windowMs: MINUTE_MS, limit: ABUSE_LIMITS.creationsPerAccountMinute, amount: 1 },
      { scope: "creation:day", windowMs: DAY_MS, limit: ABUSE_LIMITS.creationsPerAccountDay, amount: 1 },
    ];
    const denied = this.deniedWindow(windows, now);
    if (denied) {
      console.warn(JSON.stringify({ level: "warn", message: "account creation admission denied", retry: denied.retryAfterSeconds }));
      return { ...denied, reason: "account creation limit" };
    }
    this.charge(windows, now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async acquireAi(capability: string, units: number): Promise<AiPermit> {
    const now = Date.now();
    if (!Number.isFinite(units) || units <= 0 || units > ABUSE_LIMITS.aiUnitsPerCapabilityHour) {
      console.warn(JSON.stringify({ level: "warn", message: "AI request exceeds capability budget", units }));
      return { granted: false, retryAfterSeconds: Math.ceil(HOUR_MS / SECOND_MS), reason: "AI request too large" };
    }
    const charge = Math.ceil(units);
    const safeCapability = capability.slice(0, 160);
    const windows: BudgetWindow[] = [
      { scope: `ai:capability:${safeCapability}`, windowMs: HOUR_MS, limit: ABUSE_LIMITS.aiUnitsPerCapabilityHour, amount: charge },
      { scope: "ai:account:minute", windowMs: MINUTE_MS, limit: ABUSE_LIMITS.aiUnitsPerAccountMinute, amount: charge },
      { scope: "ai:account:day", windowMs: DAY_MS, limit: ABUSE_LIMITS.aiUnitsPerAccountDay, amount: charge },
    ];

    this.ctx.storage.sql.exec("DELETE FROM ai_leases WHERE expires_at <= ?", now);
    const active = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM ai_leases").one().count;
    if (active >= ABUSE_LIMITS.aiConcurrency) {
      const first = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
        "SELECT MIN(expires_at) AS expires_at FROM ai_leases",
      ).one().expires_at;
      const retry = first === null ? 1 : Math.max(1, Math.ceil((first - now) / SECOND_MS));
      console.warn(JSON.stringify({ level: "warn", message: "AI concurrency denied", active, retry }));
      return { granted: false, retryAfterSeconds: retry, reason: "account AI concurrency limit" };
    }

    const denied = this.deniedWindow(windows, now);
    if (denied) {
      console.warn(JSON.stringify({ level: "warn", message: "AI budget denied", scope: denied.scope, retry: denied.retryAfterSeconds }));
      return { granted: false, retryAfterSeconds: denied.retryAfterSeconds, reason: denied.scope };
    }

    const permitId = crypto.randomUUID();
    this.charge(windows, now);
    this.ctx.storage.sql.exec(
      "INSERT INTO ai_leases (permit_id, expires_at) VALUES (?, ?)",
      permitId,
      now + ABUSE_LIMITS.aiLeaseMs,
    );
    return { granted: true, permitId };
  }

  async releaseAi(permitId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM ai_leases WHERE permit_id = ?", permitId);
  }

  private deniedWindow(
    windows: BudgetWindow[],
    now: number,
  ): { allowed: false; retryAfterSeconds: number; scope: string } | null {
    for (const window of windows) {
      const row = this.window(window.scope, window.windowMs, now);
      if (row.units + window.amount > window.limit) {
        return {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(row.window_start, window.windowMs, now),
          scope: window.scope,
        };
      }
    }
    return null;
  }

  private charge(windows: BudgetWindow[], now: number): void {
    for (const window of windows) {
      const row = this.window(window.scope, window.windowMs, now);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO counters (scope, window_start, units) VALUES (?, ?, ?)",
        window.scope,
        row.window_start,
        row.units + window.amount,
      );
    }
    // Capability rows are bounded by the global day budget, then expired so a
    // stream of one-use UUID capabilities cannot grow this object forever.
    this.ctx.storage.sql.exec("DELETE FROM counters WHERE window_start < ?", now - 2 * DAY_MS);
  }

  private window(scope: string, windowMs: number, now: number): CounterRow {
    const start = Math.floor(now / windowMs) * windowMs;
    const row = this.ctx.storage.sql.exec<CounterRow>(
      "SELECT window_start, units FROM counters WHERE scope = ? AND window_start = ?",
      scope,
      start,
    ).toArray()[0];
    return row ?? { window_start: start, units: 0 };
  }
}
