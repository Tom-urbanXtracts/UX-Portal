import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { intuitOAuthEndpoints } from "../_shared/quickbooks-oauth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") ?? "";
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") ?? "";
const QBO_TOKEN_ENCRYPTION_KEY = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
const PORTAL_URL = Deno.env.get("QBO_PORTAL_RETURN_URL") ??
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site/";
const REDIRECT_URI = Deno.env.get("QBO_REDIRECT_URI") ??
  `${SUPABASE_URL}/functions/v1/quickbooks-oauth/callback`;
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { id: string; name: string; org: string };

function intuitTraceId(response: Response): string | null {
  const value = (response.headers.get("intuit_tid") ?? "")
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 160);
  return value || null;
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "https://portal.urbanxtracts.com",
      "https://tom-urbanxtracts.github.io",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(candidate)
    ? candidate
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function safeHtml(message: string, success: boolean): Response {
  const title = success
    ? "QuickBooks connected"
    : "QuickBooks connection failed";
  const color = success ? "#257653" : "#b9361e";
  const returnUrl = JSON.stringify(PORTAL_URL);
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="margin:0;background:#f5f1ec;color:#170e0b;font:16px/1.55 system-ui,sans-serif"><main style="max-width:680px;margin:12vh auto;padding:32px;border:1px solid #cfc4ba;background:#fff"><div style="font:700 12px ui-monospace,monospace;letter-spacing:.08em;color:${color};margin-bottom:12px">${
      success ? "CONNECTED" : "ACTION REQUIRED"
    }</div><h1 style="margin:0 0 12px;font-size:30px">${title}</h1><p>${message}</p><button id="return" style="margin-top:12px;background:#170e0b;color:#fff;border:0;padding:11px 15px;font-weight:700;cursor:pointer">Return to UX OS</button></main><script>document.getElementById('return').addEventListener('click',function(){location.assign(${returnUrl})});${
      success
        ? `setTimeout(function(){location.assign(${returnUrl})},1800);`
        : ""
    }</script></body></html>`;
  return new Response(body, {
    status: success ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes)).map((item) =>
    item.toString(16).padStart(2, "0")
  ).join("");
}

function configured(): boolean {
  return Boolean(
    SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY && QBO_CLIENT_ID &&
      QBO_CLIENT_SECRET && QBO_TOKEN_ENCRYPTION_KEY.length >= 32,
  );
}

function effectiveConnectionStatus(data: Row | null): string {
  const status = String(data?.connection_status ?? "disconnected");
  if (status !== "authorizing") return status;
  const expiresAt = Date.parse(String(data?.oauth_state_expires_at ?? ""));
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? "authorizing"
    : "disconnected";
}

async function administratorFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (
    !profile || profile.active === false || profile.role !== "internal" ||
    profile.staff_role !== "administrator"
  ) return null;
  const { data: grant } = await service.from("portal_role_permission").select(
    "permission",
  ).eq("staff_role", "administrator").eq("permission", "accounts.manage")
    .maybeSingle();
  if (!grant) return null;
  return {
    id: String(user.id),
    name: String(profile.full_name || "Administrator"),
    org: String(profile.org || "urbanXtracts"),
  };
}

async function startAuthorization(
  request: Request,
  caller: Caller,
): Promise<Response> {
  if (!configured()) {
    return json(request, {
      error: "QuickBooks OAuth credentials are not configured.",
    }, 503);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64Url(bytes);
  const stateHash = await sha256(state);
  const { error } = await service.rpc("portal_begin_quickbooks_oauth", {
    p_state_hash: stateHash,
    p_actor: caller.id,
  });
  if (error) throw error;
  await service.from("portal_admin_audit").insert({
    actor_id: caller.id,
    actor_org: caller.org,
    action: "quickbooks.oauth_started",
    detail: {
      scope: "com.intuit.quickbooks.accounting",
      mode: "read_only_portal",
    },
  });
  const endpoints = await intuitOAuthEndpoints();
  const authorize = new URL(endpoints.authorizationEndpoint);
  authorize.search = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: REDIRECT_URI,
    state,
  }).toString();
  return json(request, {
    authorizationUrl: authorize.toString(),
    callbackUrl: REDIRECT_URI,
    expiresInSeconds: 600,
  });
}

async function callback(request: Request): Promise<Response> {
  if (!configured()) {
    return safeHtml(
      "The server connection is not fully configured. No accounting data was changed.",
      false,
    );
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const realmId = url.searchParams.get("realmId") ?? "";
  const providerError = url.searchParams.get("error") ?? "";
  if (providerError) {
    return safeHtml(
      "Intuit did not authorize the portal. You can return and try again.",
      false,
    );
  }
  if (!state || !code || !realmId) {
    return safeHtml(
      "The authorization response was incomplete. No connection was saved.",
      false,
    );
  }
  const { data: claims, error: claimError } = await service.rpc(
    "portal_consume_quickbooks_oauth_state",
    { p_state_hash: await sha256(state) },
  );
  const actorId = Array.isArray(claims) && claims.length
    ? String(claims[0].actor_id || "")
    : "";
  if (claimError || !actorId) {
    return safeHtml(
      "This authorization link expired or was already used. Start a new connection from Release readiness.",
      false,
    );
  }

  const endpoints = await intuitOAuthEndpoints();
  const tokenResponse = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokenBody = await tokenResponse.json() as Row;
  const refreshToken = String(tokenBody.refresh_token || "");
  if (!tokenResponse.ok || !refreshToken) {
    await service.from("quickbooks_sync_state").update({
      connection_status: "error",
      last_error: "QuickBooks authorization-code exchange failed.",
      last_intuit_tid: intuitTraceId(tokenResponse),
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    return safeHtml(
      "Intuit accepted the sign-in but the secure token exchange failed. Start a new connection from Release readiness.",
      false,
    );
  }
  const refreshSeconds = Number(tokenBody.x_refresh_token_expires_in || 0);
  const refreshExpiresAt = Number.isFinite(refreshSeconds) && refreshSeconds > 0
    ? new Date(Date.now() + refreshSeconds * 1000).toISOString()
    : null;
  const { error: storeError } = await service.rpc(
    "portal_store_quickbooks_connection",
    {
      p_realm_id: realmId,
      p_refresh_token: refreshToken,
      p_encryption_key: QBO_TOKEN_ENCRYPTION_KEY,
      p_refresh_token_expires_at: refreshExpiresAt,
      p_actor: actorId,
    },
  );
  if (storeError) throw storeError;
  const { error: clearTraceError } = await service.from(
    "quickbooks_sync_state",
  ).update({ last_intuit_tid: null }).eq("id", 1);
  if (clearTraceError) throw clearTraceError;
  await service.from("portal_admin_audit").insert({
    actor_id: actorId,
    actor_org: "urbanXtracts",
    action: "quickbooks.connected",
    detail: {
      scope: "com.intuit.quickbooks.accounting",
      mode: "read_only_portal",
    },
  });
  return safeHtml(
    "URBANXTRACTS INC is authorized for the portal's server-side read-only customer, invoice, and payment sync.",
    true,
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  const url = new URL(request.url);
  if (url.pathname.endsWith("/callback")) {
    if (request.method !== "GET") return safeHtml("Method not allowed.", false);
    try {
      return await callback(request);
    } catch (error) {
      console.error(
        "quickbooks-oauth callback",
        error instanceof Error ? error.message : "Unexpected error",
      );
      return safeHtml(
        "The secure connection could not be completed. No accounting data was changed.",
        false,
      );
    }
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await administratorFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (request.method === "POST") {
      return await startAuthorization(request, caller);
    }
    const { data, error } = await service.from("quickbooks_sync_state").select(
      "connection_status,connected_at,refresh_token_expires_at,oauth_state_expires_at,last_successful_at,status,last_error",
    ).eq("id", 1).maybeSingle();
    if (error) throw error;
    return json(request, {
      configured: configured(),
      connectionStatus: effectiveConnectionStatus(data),
      connectedAt: data?.connected_at ?? null,
      refreshTokenExpiresAt: data?.refresh_token_expires_at ?? null,
      lastSuccessfulAt: data?.last_successful_at ?? null,
      syncStatus: data?.status ?? "never",
      hasError: Boolean(data?.last_error),
      callbackUrl: REDIRECT_URI,
    });
  } catch (error) {
    console.error(
      "quickbooks-oauth",
      error instanceof Error ? error.message : "Unexpected error",
    );
    return json(request, {
      error: "QuickBooks connection service is temporarily unavailable.",
    }, 500);
  }
});
