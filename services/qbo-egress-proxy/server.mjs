import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const MAX_TOKEN_BODY_BYTES = 32 * 1024;
const MAX_QUERY_CHARS = 24 * 1024;
const MAX_REQUESTS_PER_MINUTE = 120;
const INTUIT_DISCOVERY =
  "https://developer.api.intuit.com/.well-known/openid_configuration";
const INTUIT_TOKEN =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function equalSecret(provided, expected) {
  const left = Buffer.from(String(provided || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length >= 32 &&
    timingSafeEqual(left, right);
}

async function requestBody(request, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function upstreamFor(request) {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/v1/discovery") {
    return { url: INTUIT_DISCOVERY, method: "GET", body: null };
  }
  if (request.method === "POST" && url.pathname === "/v1/token") {
    if (
      !String(request.headers["content-type"] || "").toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    ) throw new Error("unsupported_content_type");
    return { url: INTUIT_TOKEN, method: "POST", body: "token" };
  }
  const accounting = url.pathname.match(
    /^\/v1\/accounting\/([A-Za-z0-9_-]{1,64})\/query$/,
  );
  if (request.method === "GET" && accounting) {
    const query = url.searchParams.get("query") || "";
    const minorVersion = url.searchParams.get("minorversion") || "";
    if (
      !query || query.length > MAX_QUERY_CHARS ||
      !/^\d{1,3}$/.test(minorVersion) ||
      [...url.searchParams.keys()].some((key) =>
        key !== "query" && key !== "minorversion"
      )
    ) throw new Error("invalid_accounting_query");
    const upstream = new URL(
      `/v3/company/${accounting[1]}/query`,
      "https://quickbooks.api.intuit.com",
    );
    upstream.searchParams.set("minorversion", minorVersion);
    upstream.searchParams.set("query", query);
    return { url: upstream.toString(), method: "GET", body: null };
  }
  throw new Error("route_not_allowed");
}

function forwardedHeaders(request, route) {
  const headers = new Headers({ accept: "application/json" });
  if (route.method === "POST") {
    const authorization = String(request.headers.authorization || "");
    if (!authorization.startsWith("Basic ")) {
      throw new Error("missing_basic_authorization");
    }
    headers.set("authorization", authorization);
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (route.url.startsWith("https://quickbooks.api.intuit.com/")) {
    const authorization = String(request.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) {
      throw new Error("missing_bearer_authorization");
    }
    headers.set("authorization", authorization);
  }
  return headers;
}

function copyResponseHeaders(upstream) {
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ||
      "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const name of ["intuit_tid", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value.slice(0, 256));
  }
  return Object.fromEntries(headers.entries());
}

export function createIntuitEgressHandler({
  secret,
  fetchImpl = fetch,
  requireForwardedHttps = true,
  now = Date.now,
} = {}) {
  if (String(secret || "").length < 32) {
    throw new Error(
      "QBO_EGRESS_SHARED_SECRET must contain at least 32 characters.",
    );
  }
  let rateWindow = Math.floor(now() / 60_000);
  let rateCount = 0;

  return async function intuitEgressHandler(request, response) {
    if (request.method === "GET" && request.url === "/healthz") {
      return json(response, 200, { ok: true });
    }
    if (
      requireForwardedHttps &&
      String(request.headers["x-forwarded-proto"] || "").toLowerCase() !==
        "https"
    ) return json(response, 400, { error: "HTTPS is required." });
    if (!equalSecret(request.headers["x-ux-egress-secret"], secret)) {
      return json(response, 403, { error: "Forbidden" });
    }
    const currentWindow = Math.floor(now() / 60_000);
    if (currentWindow !== rateWindow) {
      rateWindow = currentWindow;
      rateCount = 0;
    }
    rateCount += 1;
    if (rateCount > MAX_REQUESTS_PER_MINUTE) {
      response.setHeader("retry-after", "60");
      return json(response, 429, { error: "Rate limit exceeded." });
    }

    try {
      const route = upstreamFor(request);
      const body = route.body === "token"
        ? await requestBody(request, MAX_TOKEN_BODY_BYTES)
        : undefined;
      const upstream = await fetchImpl(route.url, {
        method: route.method,
        headers: forwardedHeaders(request, route),
        body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, copyResponseHeaders(upstream));
      response.end(payload);
    } catch (error) {
      const code = error instanceof Error ? error.message : "proxy_error";
      const clientError = new Set([
        "request_too_large",
        "unsupported_content_type",
        "invalid_accounting_query",
        "route_not_allowed",
        "missing_basic_authorization",
        "missing_bearer_authorization",
      ]).has(code);
      json(response, clientError ? 400 : 502, {
        error: clientError ? "Request rejected." : "Intuit is unavailable.",
      });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const handler = createIntuitEgressHandler({
    secret: process.env.QBO_EGRESS_SHARED_SECRET,
    requireForwardedHttps: process.env.ALLOW_INSECURE_PROXY !== "true",
  });
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number(process.env.PORT || DEFAULT_PORT);
  createServer(handler).listen(port, host, () => {
    console.log(`QuickBooks egress proxy listening on ${host}:${port}`);
  });
}
