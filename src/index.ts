// dewpt Worker: /api routes in front of the per-session Durable Object.
// Static client is served from ./public via the assets binding; only /api/*
// reaches this code (run_worker_first).

import { parsePoleTerms } from "./axis-core";
import { BUCKET_KEYS, MAX_AXES, MAX_POLE_TERM_CHARS, type BucketKey, type DewptParams, type Tier } from "./types";

export { SessionDO } from "./session-do";

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

function parseTier(body: Record<string, unknown>): Tier | null {
  const tier = body.tier;
  return tier === 0 || tier === 1 || tier === 2 ? tier : null;
}

function isBucketKey(value: unknown): value is BucketKey {
  return typeof value === "string" && (BUCKET_KEYS as readonly string[]).includes(value);
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  // Health probe for the AI binding — handy for checking that the local
  // runtime can reach Workers AI (e.g. after pausing WARP).
  if (path === "/api/debug/ai" && method === "GET") {
    const t0 = Date.now();
    try {
      const result = (await env.AI.run(env.EMBED_MODEL as never, { text: ["probe"] } as never)) as { data?: number[][] };
      return json({ ok: true, ms: Date.now() - t0, dims: result?.data?.[0]?.length ?? null });
    } catch (error) {
      return json({ ok: false, ms: Date.now() - t0, error: String(error) }, 500);
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
    const id = crypto.randomUUID();
    const info = await env.SESSION_DO.getByName(id).init(id, seed, patch);
    return json(info, 201);
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
    // 201 only when an axis was actually added. At cap the request was dropped,
    // and answering 201 would report a silent failure as a success.
    return result.created
      ? json({ axes: result.axes }, 201)
      : json({ error: `at most ${MAX_AXES} axes`, axes: result.axes }, 409);
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
