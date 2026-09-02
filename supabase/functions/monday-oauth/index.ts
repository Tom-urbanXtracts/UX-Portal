import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  mondayAccessToken,
  mondayTokenExpiry,
} from "../_shared/monday-connection.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_SIGNING_SECRET = Deno.env.get("MONDAY_SIGNING_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const PORTAL_URL = Deno.env.get("MONDAY_PORTAL_RETURN_URL") ??
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site/";
const REDIRECT_URI = Deno.env.get("MONDAY_REDIRECT_URI") ??
  `${SUPABASE_URL}/functions/v1/monday-oauth/callback`;
const APP_VERSION_ID = Deno.env.get("MONDAY_APP_VERSION_ID") ?? "17484271";
const ORDER_BOARD_ID = Deno.env.get("MONDAY_ORDER_BOARD_ID") ?? "18428025898";
const ORDER_STATUS_COLUMN_ID = Deno.env.get("MONDAY_ORDER_STATUS_COLUMN_ID") ??
  "color_mm6jxv8f";
const WEBHOOK_URL = Deno.env.get("MONDAY_ORDER_WEBHOOK_URL") ??
  `${SUPABASE_URL}/functions/v1/monday-webhook`;
const REQUESTED_SCOPES = [
  "me:read",
  "boards:read",
  "boards:write",
  "webhooks:read",
  "webhooks:write",
] as const;
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { id: string; name: string; org: string };

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
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

function oauthResult(message: string, success: boolean): Response {
  if (success) {
    const target = new URL(PORTAL_URL);
    target.searchParams.set("monday", "connected");
    return new Response(null, {
      status: 303,
      headers: {
        location: target.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return new Response(
    `Monday connection failed\n\n${message}\n\nReturn to UX OS: ${PORTAL_URL}\n`,
    {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
}

async function sha256(value: string): Promise<string> {
  return Array.from(await sha256Bytes(value)).map((item) =>
    item.toString(16).padStart(2, "0")
  ).join("");
}

function configured(): boolean {
  return Boolean(
    SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY && MONDAY_CLIENT_ID &&
      MONDAY_CLIENT_SECRET && MONDAY_SIGNING_SECRET &&
      TOKEN_ENCRYPTION_KEY.length >= 32 && /^\d+$/.test(ORDER_BOARD_ID) &&
      ORDER_STATUS_COLUMN_ID,
  );
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

async function mondayGraphql(
  accessToken: string,
  query: string,
  variables: Row = {},
): Promise<Row> {
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({})) as Row;
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    throw new Error("Monday API did not accept the app configuration request.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

function webhookColumn(config: unknown): string {
  if (config && typeof config === "object") {
    return String((config as Row).columnId ?? "");
  }
  const raw = String(config ?? "");
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object"
      ? String((value as Row).columnId ?? "")
      : "";
  } catch {
    const rubyHashColumn = raw.match(
      /["']?columnId["']?\s*(?:=>|:)\s*["']([^"']+)["']/,
    );
    return rubyHashColumn?.[1] ?? "";
  }
}

async function listAppWebhooks(accessToken: string): Promise<Row[]> {
  const existingData = await mondayGraphql(
    accessToken,
    `query PortalWebhooks($boardId: ID!) {
      webhooks(board_id: $boardId, app_webhooks_only: true) {
        id event board_id config
      }
    }`,
    { boardId: ORDER_BOARD_ID },
  );
  const existing = Array.isArray(existingData.webhooks)
    ? existingData.webhooks as Row[]
    : [];
  return existing;
}

function matchingOrderWebhooks(existing: Row[]): Row[] {
  return existing.filter((row) =>
    String(row.event) === "change_status_column_value" &&
    String(row.board_id) === ORDER_BOARD_ID &&
    webhookColumn(row.config) === ORDER_STATUS_COLUMN_ID
  );
}

function webhookAuditSummary(existing: Row[]): Row[] {
  return existing.map((row) => ({
    id: String(row.id ?? ""),
    event: String(row.event ?? ""),
    boardId: String(row.board_id ?? ""),
    columnId: webhookColumn(row.config),
    config: row.config ?? null,
  }));
}

async function deleteWebhook(accessToken: string, webhookId: string) {
  const deletedData = await mondayGraphql(
    accessToken,
    `mutation DeletePortalOrderWebhook($webhookId: ID!) {
      delete_webhook(id: $webhookId) { id board_id }
    }`,
    { webhookId },
  );
  const deleted = deletedData.delete_webhook as Row | undefined;
  if (
    String(deleted?.id ?? "") !== webhookId ||
    String(deleted?.board_id ?? "") !== ORDER_BOARD_ID
  ) {
    throw new Error("Monday did not confirm the stale webhook deletion.");
  }
}

async function createOrReuseWebhook(
  accessToken: string,
  forceCreate = false,
): Promise<string> {
  const existing = matchingOrderWebhooks(await listAppWebhooks(accessToken));
  if (!forceCreate) {
    const matched = existing[0];
    if (matched?.id) return String(matched.id);
  }

  const createdData = await mondayGraphql(
    accessToken,
    `mutation CreatePortalOrderWebhook(
      $boardId: ID!, $url: String!, $config: JSON!
    ) {
      create_webhook(
        board_id: $boardId,
        url: $url,
        event: change_status_column_value,
        config: $config
      ) { id board_id }
    }`,
    {
      boardId: ORDER_BOARD_ID,
      url: WEBHOOK_URL,
      config: JSON.stringify({
        columnId: ORDER_STATUS_COLUMN_ID,
        columnValue: { "$any$": true },
      }),
    },
  );
  const webhook = createdData.create_webhook as Row | undefined;
  if (!webhook?.id || String(webhook.board_id) !== ORDER_BOARD_ID) {
    throw new Error("Monday did not return the expected order webhook.");
  }
  return String(webhook.id);
}

async function refreshWebhook(
  request: Request,
  caller: Caller,
): Promise<Response> {
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["webhooks:read", "webhooks:write"]);
  if (!accessToken) {
    return json(request, {
      error:
        "Monday must be connected before its signed webhook can be refreshed.",
    }, 409);
  }
  const observedBefore = await listAppWebhooks(accessToken);
  const previousWebhooks = matchingOrderWebhooks(observedBefore);
  const webhookId = await createOrReuseWebhook(accessToken, true);
  const { error: storeError } = await service.rpc(
    "portal_store_monday_webhook",
    {
      p_webhook_id: webhookId,
      p_board_id: ORDER_BOARD_ID,
      p_column_id: ORDER_STATUS_COLUMN_ID,
      p_webhook_url: WEBHOOK_URL,
    },
  );
  if (storeError) throw storeError;

  const removedWebhookIds: string[] = [];
  const failedWebhookIds: string[] = [];
  for (const previous of previousWebhooks) {
    const previousId = String(previous.id ?? "");
    if (!previousId || previousId === webhookId) continue;
    try {
      await deleteWebhook(accessToken, previousId);
      removedWebhookIds.push(previousId);
    } catch {
      failedWebhookIds.push(previousId);
    }
  }
  const observedAfter = await listAppWebhooks(accessToken);
  const remainingWebhookIds = matchingOrderWebhooks(observedAfter)
    .map((row) => String(row.id ?? ""))
    .filter(Boolean);

  await service.from("portal_admin_audit").insert({
    actor_id: caller.id,
    actor_org: caller.org,
    action: "monday.webhook_refreshed",
    detail: {
      boardId: ORDER_BOARD_ID,
      columnId: ORDER_STATUS_COLUMN_ID,
      webhookId,
      signedWebhook: true,
      removedWebhookIds,
      failedWebhookIds,
      remainingWebhookIds,
      observedBefore: webhookAuditSummary(observedBefore),
      observedAfter: webhookAuditSummary(observedAfter),
    },
  });
  if (
    failedWebhookIds.length > 0 ||
    remainingWebhookIds.length !== 1 ||
    remainingWebhookIds[0] !== webhookId
  ) {
    return json(request, {
      error:
        "The new signed webhook is active, but obsolete webhook cleanup was incomplete.",
      webhookId,
      removedWebhookIds,
      failedWebhookIds,
      remainingWebhookIds,
    }, 502);
  }
  return json(request, {
    ok: true,
    webhookId,
    boardId: ORDER_BOARD_ID,
    columnId: ORDER_STATUS_COLUMN_ID,
    removedWebhookIds,
    remainingWebhookIds,
  });
}

async function startAuthorization(
  request: Request,
  caller: Caller,
): Promise<Response> {
  if (!configured()) {
    return json(
      request,
      { error: "Monday OAuth is not fully configured." },
      503,
    );
  }
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(await sha256Bytes(verifier));
  const { error } = await service.rpc("portal_begin_monday_oauth", {
    p_state_hash: await sha256(state),
    p_pkce_verifier: verifier,
    p_encryption_key: TOKEN_ENCRYPTION_KEY,
    p_actor: caller.id,
  });
  if (error) throw error;
  await service.from("portal_admin_audit").insert({
    actor_id: caller.id,
    actor_org: caller.org,
    action: "monday.oauth_started",
    detail: {
      scopes: REQUESTED_SCOPES,
      boardId: ORDER_BOARD_ID,
      columnId: ORDER_STATUS_COLUMN_ID,
    },
  });
  const authorize = new URL("https://auth.monday.com/oauth2/authorize");
  const params: Record<string, string> = {
    client_id: MONDAY_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: REQUESTED_SCOPES.join(" "),
  };
  if (/^\d+$/.test(APP_VERSION_ID)) {
    // A version-specific URL lets app collaborators authorize an active draft.
    // The account-install redirect loops for a draft because there is no live
    // installation to resume; reserve that helper for the live-app path.
    params.app_version_id = APP_VERSION_ID;
  } else {
    params.force_install_if_needed = "true";
  }
  authorize.search = new URLSearchParams(params).toString();
  return json(request, {
    authorizationUrl: authorize.toString(),
    callbackUrl: REDIRECT_URI,
    expiresInSeconds: 600,
  });
}

async function callback(request: Request): Promise<Response> {
  if (!configured()) {
    return oauthResult(
      "The server connection is incomplete. No Monday access was saved.",
      false,
    );
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const providerError = url.searchParams.get("error") ??
    (url.searchParams.get("status") === "success"
      ? ""
      : url.searchParams.get("status") ?? "");
  if (!state || !code || providerError) {
    return oauthResult(
      "Monday did not complete the authorization. Return to Release readiness and try again.",
      false,
    );
  }
  const { data: claims, error: claimError } = await service.rpc(
    "portal_consume_monday_oauth_state",
    {
      p_state_hash: await sha256(state),
      p_encryption_key: TOKEN_ENCRYPTION_KEY,
    },
  );
  const claimed = Array.isArray(claims) && claims.length ? claims[0] : null;
  const actorId = String(claimed?.actor_id ?? "");
  const verifier = String(claimed?.pkce_verifier ?? "");
  if (claimError || !actorId || !verifier) {
    return oauthResult(
      "This authorization link expired or was already used. Start a new connection from Release readiness.",
      false,
    );
  }

  const tokenResponse = await fetch(
    "https://auth.monday.com/oauth_ms/oauth/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: MONDAY_CLIENT_ID,
        client_secret: MONDAY_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    },
  );
  const tokenBody = await tokenResponse.json().catch(() => ({})) as Row;
  const accessToken = String(tokenBody.access_token ?? "");
  const refreshToken = String(tokenBody.refresh_token ?? "");
  if (!tokenResponse.ok || !accessToken || !refreshToken) {
    await service.rpc("portal_mark_monday_connection_error", {
      p_error: "Monday authorization-code exchange failed.",
      p_webhook_error: false,
    });
    return oauthResult(
      "Monday accepted the sign-in but the secure token exchange failed. Start a new connection from Release readiness.",
      false,
    );
  }

  const identityData = await mondayGraphql(
    accessToken,
    "query PortalInstaller { me { id name account { id name } } }",
  );
  const identity = identityData.me as Row | undefined;
  const account = identity?.account as Row | undefined;
  const accountId = String(account?.id ?? "");
  if (!identity?.id || !accountId) {
    throw new Error("Monday installer identity was incomplete.");
  }
  const scopes = String(tokenBody.scope ?? "").split(/[\s,]+/).filter(Boolean);
  const { error: storeError } = await service.rpc(
    "portal_store_monday_connection",
    {
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_encryption_key: TOKEN_ENCRYPTION_KEY,
      p_access_token_expires_at: mondayTokenExpiry(
        accessToken,
        tokenBody.expires_in,
      ),
      p_granted_scopes: scopes,
      p_account_id: accountId,
      p_account_name: String(account?.name ?? ""),
      p_user_id: String(identity.id),
      p_user_name: String(identity.name ?? ""),
      p_actor: actorId,
    },
  );
  if (storeError) throw storeError;

  let webhookId: string;
  try {
    webhookId = await createOrReuseWebhook(accessToken);
    const { error: webhookStoreError } = await service.rpc(
      "portal_store_monday_webhook",
      {
        p_webhook_id: webhookId,
        p_board_id: ORDER_BOARD_ID,
        p_column_id: ORDER_STATUS_COLUMN_ID,
        p_webhook_url: WEBHOOK_URL,
      },
    );
    if (webhookStoreError) throw webhookStoreError;
  } catch (error) {
    await service.rpc("portal_mark_monday_connection_error", {
      p_error: error instanceof Error
        ? error.message
        : "Monday webhook setup failed.",
      p_webhook_error: true,
    });
    return oauthResult(
      "The secure account connection succeeded, but Monday did not create the order-status webhook. Return to Release readiness and reconnect.",
      false,
    );
  }

  await service.from("portal_admin_audit").insert({
    actor_id: actorId,
    actor_org: "urbanXtracts",
    action: "monday.connected",
    detail: {
      accountId,
      boardId: ORDER_BOARD_ID,
      columnId: ORDER_STATUS_COLUMN_ID,
      webhookId,
      signedWebhook: true,
    },
  });
  return oauthResult(
    "The UX OS app is installed with least-privilege access, and the order-status board now has a signed callback to the portal.",
    true,
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  const url = new URL(request.url);
  if (url.pathname.endsWith("/callback")) {
    if (request.method !== "GET") {
      return oauthResult("Method not allowed.", false);
    }
    try {
      return await callback(request);
    } catch (error) {
      console.error(
        "monday-oauth callback",
        error instanceof Error ? error.message : "Unexpected error",
      );
      return oauthResult(
        "The secure connection could not be completed. No portal order was changed.",
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
      const body = await request.json().catch(() => ({})) as Row;
      if (String(body.action ?? "").toLowerCase() === "refresh-webhook") {
        return await refreshWebhook(request, caller);
      }
      return await startAuthorization(request, caller);
    }
    const { data, error } = await service.from("monday_connection_state")
      .select(
        "connection_status,connected_at,account_id,account_name,user_name,access_token_expires_at,granted_scopes,webhook_id,webhook_board_id,webhook_column_id,webhook_status,webhook_created_at,last_error",
      ).eq("id", 1).maybeSingle();
    if (error) throw error;
    return json(request, {
      configured: configured(),
      connectionStatus: data?.connection_status ?? "disconnected",
      connectedAt: data?.connected_at ?? null,
      accountId: data?.account_id ?? null,
      accountName: data?.account_name ?? null,
      installedBy: data?.user_name ?? null,
      accessTokenExpiresAt: data?.access_token_expires_at ?? null,
      scopes: data?.granted_scopes ?? [],
      webhookId: data?.webhook_id ?? null,
      webhookBoardId: data?.webhook_board_id ?? ORDER_BOARD_ID,
      webhookColumnId: data?.webhook_column_id ?? ORDER_STATUS_COLUMN_ID,
      webhookStatus: data?.webhook_status ?? "not_configured",
      webhookCreatedAt: data?.webhook_created_at ?? null,
      hasError: Boolean(data?.last_error),
      callbackUrl: REDIRECT_URI,
    });
  } catch (error) {
    console.error(
      "monday-oauth",
      error instanceof Error ? error.message : "Unexpected error",
    );
    return json(request, {
      error: "Monday connection service is temporarily unavailable.",
    }, 500);
  }
});
