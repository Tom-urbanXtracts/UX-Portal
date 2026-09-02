const DISCOVERY_URL =
  "https://developer.api.intuit.com/.well-known/openid_configuration";
const EGRESS_PROXY_URL = (Deno.env.get("QBO_EGRESS_PROXY_URL") ?? "").trim();
const EGRESS_PROXY_SECRET = (Deno.env.get("QBO_EGRESS_PROXY_SECRET") ?? "")
  .trim();

export type QuickBooksEnvironment = "sandbox" | "production";

export function configuredQuickBooksEnvironment():
  | QuickBooksEnvironment
  | null {
  const value = (Deno.env.get("QBO_ENVIRONMENT") ?? "").trim().toLowerCase();
  return value === "sandbox" || value === "production" ? value : null;
}

export function requireQuickBooksEnvironment(): QuickBooksEnvironment {
  const value = configuredQuickBooksEnvironment();
  if (!value) {
    throw new Error(
      "QBO_ENVIRONMENT must be explicitly set to sandbox or production.",
    );
  }
  return value;
}

export function quickBooksAccountingBase(
  environment = requireQuickBooksEnvironment(),
): string {
  return environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

export type IntuitOAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

let endpointRequest: Promise<IntuitOAuthEndpoints> | null = null;

function proxyTarget(upstream: URL): URL {
  if (upstream.protocol !== "https:") {
    throw new Error("QuickBooks upstream URL must use HTTPS.");
  }
  const base = new URL(EGRESS_PROXY_URL);
  if (
    base.protocol !== "https:" || base.username || base.password ||
    (base.pathname !== "/" && base.pathname !== "") || base.search ||
    base.hash
  ) {
    throw new Error("QuickBooks egress proxy URL is invalid.");
  }
  if (upstream.toString() === DISCOVERY_URL) {
    return new URL("/v1/discovery", base);
  }
  if (
    upstream.hostname === "oauth.platform.intuit.com" &&
    upstream.pathname === "/oauth2/v1/tokens/bearer" && !upstream.search
  ) {
    return new URL("/v1/token", base);
  }
  const accounting = upstream.pathname.match(
    /^\/v3\/company\/([A-Za-z0-9_-]{1,64})\/query$/,
  );
  const environment = upstream.hostname === "quickbooks.api.intuit.com"
    ? "production"
    : upstream.hostname === "sandbox-quickbooks.api.intuit.com"
    ? "sandbox"
    : null;
  if (environment && accounting) {
    const target = new URL(
      `/v1/accounting/${environment}/${accounting[1]}/query`,
      base,
    );
    target.search = upstream.search;
    return target;
  }
  throw new Error("QuickBooks request is outside the egress proxy allowlist.");
}

export async function intuitFetch(
  upstreamUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  if (Boolean(EGRESS_PROXY_URL) !== Boolean(EGRESS_PROXY_SECRET)) {
    throw new Error("QuickBooks egress proxy configuration is incomplete.");
  }
  if (!EGRESS_PROXY_URL) return await fetch(upstreamUrl, init);
  if (EGRESS_PROXY_SECRET.length < 32) {
    throw new Error("QuickBooks egress proxy credential is invalid.");
  }
  const headers = new Headers(init.headers);
  headers.set("x-ux-egress-secret", EGRESS_PROXY_SECRET);
  return await fetch(proxyTarget(new URL(upstreamUrl)), {
    ...init,
    headers,
  });
}

function validatedEndpoint(
  value: unknown,
  expectedHost: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Intuit discovery returned an invalid ${label}.`);
  }
  if (url.protocol !== "https:" || url.hostname !== expectedHost) {
    throw new Error(`Intuit discovery returned an untrusted ${label}.`);
  }
  return url.toString();
}

async function discover(): Promise<IntuitOAuthEndpoints> {
  const response = await intuitFetch(DISCOVERY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `Intuit OAuth discovery returned ${response.status}.`,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  if (body.issuer !== "https://oauth.platform.intuit.com/op/v1") {
    throw new Error("Intuit discovery returned an unexpected issuer.");
  }
  return {
    authorizationEndpoint: validatedEndpoint(
      body.authorization_endpoint,
      "appcenter.intuit.com",
      "authorization endpoint",
    ),
    tokenEndpoint: validatedEndpoint(
      body.token_endpoint,
      "oauth.platform.intuit.com",
      "token endpoint",
    ),
  };
}

export async function intuitOAuthEndpoints(): Promise<IntuitOAuthEndpoints> {
  if (!endpointRequest) {
    endpointRequest = discover().catch((error) => {
      endpointRequest = null;
      throw error;
    });
  }
  return await endpointRequest;
}
