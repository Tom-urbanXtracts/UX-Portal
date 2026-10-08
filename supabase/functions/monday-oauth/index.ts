import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  mondayAccessToken,
  mondayTokenExpiry,
} from "../_shared/monday-connection.ts";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

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
const BRAND_BOARD_ID = Deno.env.get("MONDAY_BRAND_MILESTONE_BOARD_ID") ??
  "18433592669";
const BRAND_BOARD_NAME = "UX OS Brand Production Milestones";
const BRAND_WEBHOOK_URL = Deno.env.get("MONDAY_BRAND_MILESTONE_WEBHOOK_URL") ??
  `${SUPABASE_URL}/functions/v1/monday-brand-webhook`;
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

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

const BRAND_COLUMN_SPECS = [
  { key: "status", title: "Milestone", type: "status", accepted: ["status", "color"] },
  { key: "organizationId", title: "Brand Organization ID", type: "text", accepted: ["text"] },
  { key: "reference", title: "Reference", type: "text", accepted: ["text"] },
  { key: "productName", title: "Product Name", type: "text", accepted: ["text"] },
  { key: "purchaseOrderId", title: "Purchase Order ID", type: "text", accepted: ["text"] },
  { key: "plannedOn", title: "Planned Date", type: "date", accepted: ["date"] },
  { key: "startedOn", title: "Started Date", type: "date", accepted: ["date"] },
  { key: "completedOn", title: "Completed Date", type: "date", accepted: ["date"] },
  { key: "exceptionOwner", title: "Exception Owner", type: "people", accepted: ["people", "multiple-person"] },
  { key: "exceptionNote", title: "Exception Note", type: "long_text", accepted: ["long_text", "long-text"] },
] as const;

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

function oauthResult(message: string, success: boolean): Response {
  if (success) {
    const target = new URL(PORTAL_URL);
    target.searchParams.set("monday", "connected");
    const portalOrigin = JSON.stringify(target.origin);
    const targetUrl = JSON.stringify(target.toString());
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Monday connected</title></head><body style="margin:0;background:#f5f1ec;color:#170e0b;font:16px/1.55 system-ui,sans-serif"><main style="max-width:680px;margin:12vh auto;padding:32px;border:1px solid #cfc4ba;background:#fff"><div style="font:700 12px ui-monospace,monospace;letter-spacing:.08em;color:#257653;margin-bottom:12px">CONNECTED</div><h1 style="margin:0 0 12px;font-size:30px">Monday connected</h1><p>The workflow connection is ready. This window will close automatically.</p><button id="return" style="margin-top:12px;background:#170e0b;color:#fff;border:0;padding:11px 15px;font-weight:700;cursor:pointer">Close window</button></main><script>(function(){var target=${targetUrl};var origin=${portalOrigin};function finish(){if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'ux-portal.oauth',provider:'monday',status:'connected'},origin);window.close();return;}location.assign(target);}document.getElementById('return').addEventListener('click',finish);setTimeout(finish,700);}());</script></body></html>`;
    return new Response(body, {
      status: 200,
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
      ORDER_STATUS_COLUMN_ID && /^\d+$/.test(BRAND_BOARD_ID),
  );
}

async function administratorFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  if (!verifiedTokenIsAuthenticated(authorization)) return null;
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

async function listAppWebhooks(
  accessToken: string,
  boardId = ORDER_BOARD_ID,
): Promise<Row[]> {
  const existingData = await mondayGraphql(
    accessToken,
    `query PortalWebhooks($boardId: ID!) {
      webhooks(board_id: $boardId, app_webhooks_only: true) {
        id event board_id config
      }
    }`,
    { boardId },
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

function matchingBrandWebhooks(existing: Row[], statusColumnId: string): Row[] {
  return existing.filter((row) =>
    String(row.event) === "change_status_column_value" &&
    String(row.board_id) === BRAND_BOARD_ID &&
    webhookColumn(row.config) === statusColumnId
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

async function deleteWebhook(
  accessToken: string,
  webhookId: string,
  boardId = ORDER_BOARD_ID,
) {
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
    String(deleted?.board_id ?? "") !== boardId
  ) {
    throw new Error("Monday did not confirm the stale webhook deletion.");
  }
}

async function brandBoardColumns(accessToken: string): Promise<Row[]> {
  const data = await mondayGraphql(
    accessToken,
    `query BrandMilestoneBoard($boardId: [ID!]!) {
      boards(ids: $boardId) { id name columns { id title type } }
    }`,
    { boardId: [BRAND_BOARD_ID] },
  );
  const board = Array.isArray(data.boards) ? data.boards[0] as Row | undefined : undefined;
  if (!board || String(board.id ?? "") !== BRAND_BOARD_ID) {
    throw new Error("The approved Brand milestone board is not available to the UX OS app.");
  }
  if (String(board.name ?? "") !== BRAND_BOARD_NAME) {
    throw new Error("The approved Brand milestone board name does not match the configured board ID.");
  }
  return Array.isArray(board.columns) ? board.columns as Row[] : [];
}

async function createBrandColumn(
  accessToken: string,
  title: string,
  columnType: string,
): Promise<Row> {
  const data = await mondayGraphql(
    accessToken,
    `mutation CreateBrandMilestoneColumn(
      $boardId: ID!, $title: String!, $columnType: ColumnType!
    ) {
      create_column(board_id: $boardId, title: $title, column_type: $columnType) {
        id title type
      }
    }`,
    { boardId: BRAND_BOARD_ID, title, columnType },
  );
  const column = data.create_column as Row | undefined;
  if (!column?.id || String(column.title ?? "") !== title) {
    throw new Error(`Monday did not create the required ${title} column.`);
  }
  return column;
}

async function ensureBrandColumnMapping(
  accessToken: string,
): Promise<Record<string, string>> {
  const columns = await brandBoardColumns(accessToken);
  const mapping: Record<string, string> = {};
  for (const spec of BRAND_COLUMN_SPECS) {
    let column = columns.find((candidate) =>
      String(candidate.title ?? "").trim().toLowerCase() === spec.title.toLowerCase()
    );
    if (column) {
      const observedType = String(column.type ?? "");
      if (!spec.accepted.some((type) => type === observedType)) {
        throw new Error(`${spec.title} exists on the Brand milestone board with the wrong column type.`);
      }
    }
    if (!column) {
      column = await createBrandColumn(accessToken, spec.title, spec.type);
      columns.push(column);
    }
    mapping[spec.key] = String(column.id ?? "");
  }
  if (Object.values(mapping).some((value) => !value)) {
    throw new Error("Monday returned an incomplete Brand milestone column mapping.");
  }
  return mapping;
}

async function createOrReuseBrandWebhook(
  accessToken: string,
  statusColumnId: string,
  forceCreate = false,
): Promise<string> {
  const existing = matchingBrandWebhooks(
    await listAppWebhooks(accessToken, BRAND_BOARD_ID),
    statusColumnId,
  );
  if (!forceCreate && existing[0]?.id) return String(existing[0].id);
  const data = await mondayGraphql(
    accessToken,
    `mutation CreateBrandMilestoneWebhook(
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
      boardId: BRAND_BOARD_ID,
      url: BRAND_WEBHOOK_URL,
      config: JSON.stringify({
        columnId: statusColumnId,
        columnValue: { "$any$": true },
      }),
    },
  );
  const webhook = data.create_webhook as Row | undefined;
  if (!webhook?.id || String(webhook.board_id ?? "") !== BRAND_BOARD_ID) {
    throw new Error("Monday did not return the expected Brand milestone webhook.");
  }
  return String(webhook.id);
}

async function ensureBrandVerificationItem(
  accessToken: string,
  columnMapping: Record<string, string>,
): Promise<string> {
  const { data: state } = await service.from("monday_brand_milestone_state")
    .select("verification_item_id").eq("id", 1).maybeSingle();
  const existingId = clean(state?.verification_item_id, 160);
  if (existingId) return existingId;
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id").eq("kind", "brand")
    .eq("legal_name", "urbanXtracts").eq("status", "active").maybeSingle();
  if (organizationError || !organization?.id) {
    throw new Error("The urbanXtracts Brand workspace is unavailable for callback verification.");
  }
  const reference = `EXEC-DEMO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  const created = await mondayGraphql(
    accessToken,
    `mutation CreateBrandVerificationItem(
      $boardId: ID!, $name: String!, $values: JSON!
    ) {
      create_item(
        board_id: $boardId,
        item_name: $name,
        column_values: $values
      ) { id }
    }`,
    {
      boardId: BRAND_BOARD_ID,
      name: "TEST · urbanXtracts · Executive milestone flow",
      values: JSON.stringify({
        [columnMapping.organizationId]: String(organization.id),
        [columnMapping.reference]: reference,
        [columnMapping.productName]: "urbanXtracts Brand Portal verification",
        [columnMapping.plannedOn]: { date: new Date().toISOString().slice(0, 10) },
      }),
    },
  );
  const itemId = clean((created.create_item as Row | undefined)?.id, 160);
  if (!itemId) throw new Error("Monday did not return the Brand callback verification item.");
  const { error: stateError } = await service.from("monday_brand_milestone_state")
    .update({ verification_item_id: itemId, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (stateError) throw stateError;
  const updated = await mondayGraphql(
    accessToken,
    `mutation ApproveBrandVerificationItem(
      $boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!
    ) {
      change_simple_column_value(
        board_id: $boardId,
        item_id: $itemId,
        column_id: $columnId,
        value: $value,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: BRAND_BOARD_ID,
      itemId,
      columnId: columnMapping.status,
      value: "Approved",
    },
  );
  if (clean((updated.change_simple_column_value as Row | undefined)?.id, 160) !== itemId) {
    throw new Error("Monday did not confirm the Brand verification milestone update.");
  }
  return itemId;
}

async function configureBrandMilestones(
  accessToken: string,
  caller: Caller,
  forceCreate = false,
): Promise<Row> {
  const columnMapping = await ensureBrandColumnMapping(accessToken);
  const observedBefore = await listAppWebhooks(accessToken, BRAND_BOARD_ID);
  const previous = matchingBrandWebhooks(observedBefore, columnMapping.status);
  const webhookId = await createOrReuseBrandWebhook(
    accessToken,
    columnMapping.status,
    forceCreate,
  );
  const removedWebhookIds: string[] = [];
  const failedWebhookIds: string[] = [];
  for (const webhook of previous) {
    const previousId = String(webhook.id ?? "");
    if (!previousId || previousId === webhookId) continue;
    try {
      await deleteWebhook(accessToken, previousId, BRAND_BOARD_ID);
      removedWebhookIds.push(previousId);
    } catch {
      failedWebhookIds.push(previousId);
    }
  }
  const observedAfter = await listAppWebhooks(accessToken, BRAND_BOARD_ID);
  const remainingWebhookIds = matchingBrandWebhooks(observedAfter, columnMapping.status)
    .map((row) => String(row.id ?? ""))
    .filter(Boolean);
  const active = failedWebhookIds.length === 0 && remainingWebhookIds.length === 1 &&
    remainingWebhookIds[0] === webhookId;
  const { error: stateError } = await service.from("monday_brand_milestone_state")
    .upsert({
      id: 1,
      board_id: BRAND_BOARD_ID,
      board_name: BRAND_BOARD_NAME,
      column_mapping: columnMapping,
      webhook_id: webhookId,
      webhook_url: BRAND_WEBHOOK_URL,
      webhook_status: active ? "active" : "error",
      configured_at: new Date().toISOString(),
      configured_by: caller.id,
      last_error: active ? null : "Obsolete Brand milestone webhook cleanup was incomplete.",
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  if (stateError) throw stateError;
  if (active) {
    await service.from("portal_brand_reporting_exception").update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolution_note:
        `Bound to Monday board ${BRAND_BOARD_ID} and signed milestone column ${columnMapping.status}.`,
      updated_at: new Date().toISOString(),
    }).eq("exception_code", "monday_brand_milestone_callback_pending")
      .neq("status", "resolved");
  }
  const verificationItemId = active
    ? await ensureBrandVerificationItem(accessToken, columnMapping)
    : "";
  await service.from("portal_admin_audit").insert({
    actor_id: caller.id,
    actor_org: caller.org,
    action: "monday.brand_milestones_configured",
    detail: {
      boardId: BRAND_BOARD_ID,
      boardName: BRAND_BOARD_NAME,
      columnMapping,
      webhookId,
      signedWebhook: true,
      removedWebhookIds,
      failedWebhookIds,
      remainingWebhookIds,
      verificationItemId,
    },
  });
  if (!active) {
    throw new Error("The Brand milestone webhook was created, but obsolete callback cleanup was incomplete.");
  }
  return {
    boardId: BRAND_BOARD_ID,
    boardName: BRAND_BOARD_NAME,
    columnMapping,
    webhookId,
    removedWebhookIds,
    remainingWebhookIds,
    verificationItemId,
  };
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
  }, ["boards:read", "boards:write", "webhooks:read", "webhooks:write"]);
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
  const brandMilestones = await configureBrandMilestones(
    accessToken,
    caller,
    true,
  );

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
      brandMilestones,
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
    brandMilestones,
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
  let brandMilestones: Row;
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
    brandMilestones = await configureBrandMilestones(
      accessToken,
      { id: actorId, name: String(identity.name ?? ""), org: "urbanXtracts" },
    );
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
      brandMilestones,
    },
  });
  return oauthResult(
    "The UX OS app is installed with least-privilege access, and the order and Brand milestone boards now have signed callbacks to the portal.",
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
    const [{ data, error }, { data: brandMilestones, error: brandError }] =
      await Promise.all([
        service.from("monday_connection_state")
          .select(
            "connection_status,connected_at,account_id,account_name,user_name,access_token_expires_at,granted_scopes,webhook_id,webhook_board_id,webhook_column_id,webhook_status,webhook_created_at,last_error",
          ).eq("id", 1).maybeSingle(),
        service.from("monday_brand_milestone_state")
          .select(
            "board_id,board_name,column_mapping,webhook_id,webhook_status,configured_at,last_verified_at,last_error",
          ).eq("id", 1).maybeSingle(),
      ]);
    if (error || brandError) throw error ?? brandError;
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
      brandMilestones: brandMilestones
        ? {
          boardId: brandMilestones.board_id,
          boardName: brandMilestones.board_name,
          columnMapping: brandMilestones.column_mapping ?? {},
          webhookId: brandMilestones.webhook_id,
          webhookStatus: brandMilestones.webhook_status,
          configuredAt: brandMilestones.configured_at,
          lastVerifiedAt: brandMilestones.last_verified_at,
          hasError: Boolean(brandMilestones.last_error),
        }
        : null,
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
