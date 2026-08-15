// dewpt Worker: /api routes in front of the per-session Durable Object.
// Static client is served from ./public via the assets binding; only /api/*
// reaches this code (run_worker_first).

import { aiMode, selectBudgetedAiRunner } from "./ai-runner";
import { type AdmissionKind, type AdmissionResult } from "./abuse-control";
import { AiBudgetExceededError } from "./ai-budget";
import { parsePoleTerms } from "./axis-core";
import { BUCKET_KEYS, MAX_AXES, MAX_POLE_TERM_CHARS, type BucketKey, type DewptParams, type Tier } from "./types";
import { isBeltSpeed, type BeltSpeed } from "./board/types";

export { BoardDO } from "./board/board-do";
export { SessionDO } from "./session-do";
export { AccountBudgetDO, ClientRateLimitDO } from "./abuse-control";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEED_CHARS = 200;
const MAX_TEXT_CHARS = 64;
const MAX_DRAW_COUNT = 30;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function rateLimited(result: AdmissionResult): Response {
  return new Response(JSON.stringify({ error: "request limit exceeded" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(result.retryAfterSeconds) },
  });
}

function clientGate(request: Request, env: Env) {
  // Cloudflare overwrites this header on public ingress. Missing values share
  // one fail-closed bucket, which keeps local/nonstandard ingress bounded too.
  const client = request.headers.get("cf-connecting-ip")?.trim() || "missing-client-ip";
  return env.CLIENT_RATE_LIMIT.getByName(client);
}

async function admitClient(request: Request, env: Env, kind: AdmissionKind): Promise<AdmissionResult> {
  return clientGate(request, env).admit(kind);
}

async function admitObjectCreation(request: Request, env: Env): Promise<Response | null> {
  const client = await admitClient(request, env, "creation");
  if (!client.allowed) return rateLimited(client);
  const account = await env.ACCOUNT_BUDGET.getByName("account").admitCreation();
  return account.allowed ? null : rateLimited(account);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseParamsPatch(body: Record<string, unknown>): Partial<DewptParams> | null {
  const patch: Partial<DewptParams> = {};
  for (const key of ["dewpoint", "altitude", "drizzle"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    patch[key] = value;
  }
  return patch;
}

function parseText(body: Record<string, unknown>): string | null {
  const text = body.text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TEXT_CHARS) return null;
  return trimmed;
}

/** Strict on purpose. An unknown speed is a 400, never a silent fall back to
 *  the default — a client typo would otherwise ship a board running at a speed
 *  nobody chose, with a 200 and a control row that looks correct. A patch that
 *  asks for nothing is refused for the same reason: a no-op answering 200 is
 *  indistinguishable from a control that works. */
export function parseControlsPatch(
  body: Record<string, unknown>,
): { speed?: BeltSpeed; paused?: boolean } | null {
  const patch: { speed?: BeltSpeed; paused?: boolean } = {};
  if (body.speed !== undefined) {
    if (!isBeltSpeed(body.speed)) return null;
    patch.speed = body.speed;
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") return null;
    patch.paused = body.paused;
  }
  return patch.speed === undefined && patch.paused === undefined ? null : patch;
}

function parseTier(body: Record<string, unknown>): Tier | null {
  const tier = body.tier;
  return tier === 0 || tier === 1 || tier === 2 ? tier : null;
}

function isBucketKey(value: unknown): value is BucketKey {
  return typeof value === "string" && (BUCKET_KEYS as readonly string[]).includes(value);
}

/** Throw if an `embedding` key appears anywhere in a board payload, at any
 *  depth.
 *
 *  BeltCore.view() is embedding-free by construction and its comment calls
 *  itself the only path to the wire — but lineages(), stations(), hungry() and
 *  serialize() all expose embeddings, so that guarantee is BoardDO discipline
 *  rather than anything the type system enforces. One `serialize()` where a
 *  `view()` belonged ships a few thousand floats per card. This is the check
 *  that does not depend on discipline.
 *
 *  Structural, NOT a substring match on the serialized JSON: a card whose text
 *  contains the word "embedding" is entirely plausible on a board of
 *  LLM-generated fragments, and would fail a substring guard with nothing
 *  leaked.
 *
 *  It throws rather than stripping, so the outer handler answers 500. A silent
 *  strip would hide the bug that produced it; a 500 is visible. */
export function assertNoEmbeddings(value: unknown, path = "board response"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoEmbeddings(item, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "embedding") throw new Error(`${path}.${key}: embeddings must never reach the wire`);
    assertNoEmbeddings(inner, `${path}.${key}`);
  }
}

/** Every board response goes out through here, so the guard cannot be skipped
 *  by adding a route and forgetting it. */
function boardJson(data: unknown, status = 200): Response {
  assertNoEmbeddings(data);
  return json(data, status);
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  // Health probe for inference — handy for checking that the local runtime can
  // reach whichever backend is configured (e.g. after pausing WARP). It probes
  // through the same selection the DO uses, and reports the mode, because a
  // probe that answers for Workers AI while the DO generates against a local
  // server would send you debugging the wrong layer.
  if (path === "/api/debug/ai" && method === "GET") {
    const t0 = Date.now();
    const mode = aiMode(env);
    try {
      const result = (await selectBudgetedAiRunner(env, "diagnostic").run(env.EMBED_MODEL, { text: ["probe"] })) as { data?: number[][] };
      return json({ ok: true, mode, model: env.EMBED_MODEL, ms: Date.now() - t0, dims: result?.data?.[0]?.length ?? null });
    } catch (error) {
      if (error instanceof AiBudgetExceededError) {
        return rateLimited({ allowed: false, retryAfterSeconds: error.retryAfterSeconds, reason: error.reason });
      }
      return json({ ok: false, mode, model: env.EMBED_MODEL, ms: Date.now() - t0, error: String(error) }, 500);
    }
  }

  if (path === "/api/session" && method === "POST") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const seed = typeof body.seed === "string" ? body.seed.trim() : "";
    if (!seed || seed.length > MAX_SEED_CHARS) {
      return badRequest(`seed must be a non-empty string of at most ${MAX_SEED_CHARS} characters`);
    }
    const patch = parseParamsPatch(body);
    if (patch === null) return badRequest("dewpoint, altitude and drizzle must be finite numbers");
    const denied = await admitObjectCreation(request, env);
    if (denied) return denied;
    const id = crypto.randomUUID();
    const info = await env.SESSION_DO.getByName(id).init(id, seed, patch);
    return json(info, 201);
  }

  // ── /api/board/* ─────────────────────────────────────────────────────────
  // Ahead of the session matcher, which is anchored on /api/session and would
  // not catch these anyway; the ordering is for readability, not correctness.

  if (path === "/api/board" && method === "POST") {
    const denied = await admitObjectCreation(request, env);
    if (denied) return denied;
    const id = crypto.randomUUID();
    const view = await env.BOARD_DO.getByName(id).init();
    // The spread comes FIRST so the id minted here wins. Ordered the other way
    // round (`{ id, ...view }`), a BoardView that ever grew its own `id` would
    // silently override it and the client would poll a board that isn't this
    // one — a bug with no error to catch it.
    return boardJson({ ...view, id }, 201);
  }

  const boardMatch = path.match(/^\/api\/board\/([^/]+)(\/.*)?$/);
  if (boardMatch) {
    const [, boardId, boardRest = ""] = boardMatch;
    if (!boardId || !UUID_RE.test(boardId)) return badRequest("invalid board id");
    const board = env.BOARD_DO.getByName(boardId);

    if (boardRest === "" && method === "GET") {
      const view = await board.getView();
      return view ? boardJson(view) : json({ error: "no such board" }, 404);
    }

    if (boardRest === "/seed" && method === "POST") {
      const body = await readBody(request);
      if (!body) return badRequest("expected a JSON object body");
      const text = parseText(body);
      if (!text) return badRequest(`text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`);
      const result = await board.seed(text);
      if (!result) return json({ error: "no such board" }, 404);
      // 409, not 200, when the board is at MAX_LINEAGES. If both answered 200
      // with a view the client could not tell "accepted" from "silently
      // dropped", and the seed the user typed would just disappear. The view
      // rides along so the client can repaint without a follow-up GET — the
      // same pattern as the axes route's 409/422 responses below.
      if (!result.accepted) return boardJson({ ...result.view, error: "the board is full" }, 409);
      return boardJson(result.view);
    }

    if (boardRest === "/controls" && method === "POST") {
      const body = await readBody(request);
      if (!body) return badRequest("expected a JSON object body");
      const patch = parseControlsPatch(body);
      if (!patch) {
        return badRequest("speed must be brisk, steady or slow; paused must be a boolean");
      }
      const view = await board.setControls(patch);
      if (!view) return json({ error: "no such board" }, 404);
      return boardJson(view);
    }

    return json({ error: "not found" }, 404);
  }

  const match = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
  if (!match) return json({ error: "not found" }, 404);
  const [, id, rest = ""] = match;
  if (!id || !UUID_RE.test(id)) return badRequest("invalid session id");
  const stub = env.SESSION_DO.getByName(id);

  if (rest === "" && method === "GET") {
    const info = await stub.getInfo();
    return info ? json(info) : json({ error: "no such session" }, 404);
  }

  if (rest === "/pool" && method === "GET") {
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket");
    if (!isBucketKey(bucket)) return badRequest(`bucket must be one of ${BUCKET_KEYS.join(", ")}`);
    const count = Math.min(MAX_DRAW_COUNT, Math.max(1, Number(url.searchParams.get("count")) || 12));
    const result = await stub.drawPool(bucket, count);
    // Forwarded whole: { condensed, depths, axisIds }. axisIds must travel with
    // the words it describes — a client buffering draws over time has no other
    // way to know which axis set a given word's coords were scored against.
    return result ? json(result) : json({ error: "no such session" }, 404);
  }

  if (rest === "/prospect" && method === "POST") {
    const body = await readBody(request);
    const buckets = Array.isArray(body?.buckets) ? body.buckets.filter(isBucketKey) : [];
    await stub.prospect(buckets);
    return json({ ok: true });
  }

  if (rest === "/params" && method === "PATCH") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const patch = parseParamsPatch(body);
    if (patch === null) return badRequest("dewpoint, altitude and drizzle must be finite numbers");
    const params = await stub.updateParams(patch);
    return params ? json(params) : json({ error: "no such session" }, 404);
  }

  if (rest === "/pin" && (method === "POST" || method === "DELETE")) {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const text = parseText(body);
    if (!text) return badRequest(`text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`);
    if (method === "POST") {
      const tier = parseTier(body);
      if (tier === null) return badRequest("tier must be 0, 1 or 2");
      const anchors = await stub.pin(text, tier);
      return anchors ? json({ anchors }) : json({ error: "no such session" }, 404);
    }
    const anchors = await stub.unpin(text);
    return anchors ? json({ anchors }) : json({ error: "no such session" }, 404);
  }

  if (rest === "/add" && method === "POST") {
    // A user injects their own word/phrase mid-session (issue #20). Shares the
    // anchor mechanic with /pin; tier defaults to the neutral middle band since
    // a typed word has no band of origin. Capped at MAX_TEXT_CHARS like any
    // anchor — a user-added word is a short flavor-tilt, not a fresh seed.
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const text = parseText(body);
    if (!text) return badRequest(`text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`);
    let tier: Tier = 1;
    if (body.tier !== undefined) {
      const parsed = parseTier(body);
      if (parsed === null) return badRequest("tier must be 0, 1 or 2");
      tier = parsed;
    }
    const anchors = await stub.addWord(text, tier);
    return anchors ? json({ anchors }) : json({ error: "no such session" }, 404);
  }

  if (rest === "/evaporated" && method === "POST") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const text = parseText(body);
    const tier = parseTier(body);
    if (!text || tier === null) return badRequest("expected text and tier");
    const evaporated = await stub.evaporate(text, tier);
    return evaporated ? json({ evaporated }) : json({ error: "no such session" }, 404);
  }

  if (rest === "/evaporated/restore" && method === "POST") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const text = parseText(body);
    if (!text) return badRequest("expected text");
    const result = await stub.restore(text);
    return result ? json(result) : json({ error: "no such session" }, 404);
  }

  if (rest === "/axes" && method === "GET") {
    const axes = await stub.listAxes();
    return axes ? json({ axes }) : json({ error: "no such session" }, 404);
  }

  if (rest === "/axes" && method === "POST") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const terms = parsePoleTerms(body);
    if (!terms) {
      return badRequest(`negTerm and posTerm must be different non-empty strings of at most ${MAX_POLE_TERM_CHARS} characters`);
    }
    const result = await stub.createAxis(terms.negTerm, terms.posTerm);
    if (!result) return json({ error: "no such session" }, 404);
    // 201 only when an axis was actually added. A refused request was dropped,
    // and answering 201 would report a silent failure as a success.
    //
    // These are the only non-2xx responses in this file that pair `error` with
    // payload data rather than a bare `{ error }`. That's deliberate: it lets
    // the client repaint current axis state without a follow-up GET.
    if (result.created) return json({ axes: result.axes }, 201);
    // 422, not 409: the request was well-formed and nothing conflicted — the two
    // terms just collapsed onto the same phrase once expanded. Naming both
    // phrases is the whole point, since the collision is invisible from the
    // terms the user typed.
    if (result.reason === "degenerate") {
      return json(
        {
          error: `poles expanded to nearly the same phrase: "${result.negPhrase}" / "${result.posPhrase}"`,
          axes: result.axes,
        },
        422,
      );
    }
    return json({ error: `at most ${MAX_AXES} axes`, axes: result.axes }, 409);
  }

  const axisMatch = rest.match(/^\/axes\/([^/]+)$/);
  if (axisMatch && method === "DELETE") {
    const axes = await stub.removeAxis(axisMatch[1]!);
    return axes ? json({ axes }) : json({ error: "no such session" }, 404);
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const admission = await admitClient(request, env, "request");
        if (!admission.allowed) return rateLimited(admission);
        return await handleApi(request, env, url.pathname);
      } catch (error) {
        console.error(
          JSON.stringify({ level: "error", message: "api request failed", path: url.pathname, error: String(error) }),
        );
        return json({ error: "internal error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
