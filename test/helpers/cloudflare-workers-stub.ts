// Stand-in for the `cloudflare:workers` module, which does not resolve under
// plain vitest. Unlike the bare `class {}` other test files mock it with, this
// base class stores `ctx` and `env` the way the runtime's does, so a DO can be
// constructed normally and its constructor (blockConcurrencyWhile, migrate,
// hydrate) actually runs. Used with test/helpers/do-harness.ts.

export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
