// Platform-neutral AI budget seam. Kept free of cloudflare:workers imports so
// the repository's Node-side calibration/eval scripts can still use backend
// selection without loading Worker runtime types.

import type { AiRunner } from "./generation";

const ACCOUNT_OBJECT = "account";

export const ABUSE_LIMITS = {
  requestsPerClientMinute: 240,
  creationsPerClientMinute: 10,
  creationsPerAccountMinute: 120,
  creationsPerAccountDay: 5_000,
  aiUnitsPerCapabilityHour: 250_000,
  aiUnitsPerAccountMinute: 1_500_000,
  aiUnitsPerAccountDay: 25_000_000,
  aiConcurrency: 8,
  aiLeaseMs: 120_000,
} as const;

export type AiPermit =
  | { granted: true; permitId: string }
  | { granted: false; retryAfterSeconds: number; reason: string };

/** Estimate a fixed, pre-call AI budget charge from the complete request.
 * Generation reserves its declared output ceiling as well as prompt input;
 * embeddings charge their complete text payload. Charges are intentionally
 * not refunded: a provider may have spent work even when the call fails. */
export function estimateAiUnits(inputs: Record<string, unknown>): number {
  let serialized = "";
  try {
    serialized = JSON.stringify(inputs) ?? "";
  } catch {
    // Internal callers should only pass JSON-like Workers AI inputs. Charging
    // the hourly capability ceiling makes a malformed/cyclic input fail closed.
    return ABUSE_LIMITS.aiUnitsPerCapabilityHour;
  }
  const inputUnits = Math.ceil(serialized.length / 4);
  const declaredOutput =
    typeof inputs.max_tokens === "number" && Number.isFinite(inputs.max_tokens)
      ? Math.max(0, Math.ceil(inputs.max_tokens))
      : 0;
  return Math.max(1, inputUnits + declaredOutput);
}

interface AccountBudgetStub {
  acquireAi(capability: string, units: number): Promise<AiPermit>;
  releaseAi(permitId: string): Promise<void>;
}

export interface AccountBudgetEnv {
  ACCOUNT_BUDGET: { getByName(name: string): AccountBudgetStub };
}

export class AiBudgetExceededError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly reason: string,
  ) {
    super(`AI budget unavailable: ${reason}`);
    this.name = "AiBudgetExceededError";
  }
}

/** Wrap the selected backend at its one run() seam. Every generation,
 * embedding, alarm, and diagnostic call therefore spends from the same exact
 * budget and concurrency pool before the provider is touched. */
export function budgetedAiRunner(env: AccountBudgetEnv, capability: string, runner: AiRunner): AiRunner {
  const budget = env.ACCOUNT_BUDGET.getByName(ACCOUNT_OBJECT);
  return {
    async run(model, inputs) {
      const permit = await budget.acquireAi(capability, estimateAiUnits(inputs));
      if (!permit.granted) throw new AiBudgetExceededError(permit.retryAfterSeconds, permit.reason);
      try {
        return await runner.run(model, inputs);
      } finally {
        try {
          await budget.releaseAi(permit.permitId);
        } catch (error) {
          // Fail closed on acquisition, but do not replace a completed provider
          // response when release fails; the short lease still bounds leakage.
          console.error(JSON.stringify({ level: "error", message: "AI permit release failed", error: String(error) }));
        }
      }
    },
  };
}
