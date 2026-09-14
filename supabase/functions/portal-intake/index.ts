import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { labFailed, labPassed } from "../_shared/security-contract.ts";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAKE_WEBHOOK_URL = Deno.env.get("MAKE_WEBHOOK_URL") ?? "";
const MAKE_INTAKE_SECRET = Deno.env.get("MAKE_INTAKE_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_ORDER_BOARD_ID = Deno.env.get("MONDAY_ORDER_BOARD_ID") ??
  "18428025898";
const MONDAY_ACCOUNT_BOARD_ID = Deno.env.get("MONDAY_ACCOUNT_BOARD_ID") ??
  "6217203913";
const MONDAY_ACCOUNT_LICENSE_COLUMN_ID =
  Deno.env.get("MONDAY_ACCOUNT_LICENSE_COLUMN_ID") ?? "text_mm607sg6";
const MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID =
  Deno.env.get("MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID") ?? "text_mm6shj0q";
const MONDAY_ONBOARDING_BOARD_ID = Deno.env.get("MONDAY_ONBOARDING_BOARD_ID") ??
  "18428027063";
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const TURNSTILE_REQUIRED = Deno.env.get("TURNSTILE_REQUIRED") === "true";
const TURNSTILE_ALLOWED_HOSTS = new Set(
  String(Deno.env.get("TURNSTILE_ALLOWED_HOSTS") ?? "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
);
const PUBLIC_INTAKE_RATE_SECRET = Deno.env.get(
  "PUBLIC_INTAKE_RATE_SECRET",
) ?? "";
const PUBLIC_ONBOARDING_DAILY_LIMIT = Math.min(
  20,
  Math.max(
    1,
    Number(Deno.env.get("PUBLIC_ONBOARDING_DAILY_LIMIT") ?? "3") || 3,
  ),
);
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const KINDS = new Set(["order", "onboarding", "license", "recall"]);

type Row = Record<string, unknown>;

class IntakeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function mondayText(value: unknown, max = 2000): string {
  return String(value ?? "").trim().slice(0, max);
}

function mondayColumnId(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error("A configured Monday column identifier is invalid.");
  }
  return value;
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
    throw new Error("Monday did not accept the direct order request.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

async function mondayWriteToken(): Promise<string | null> {
  if (
    MONDAY_TOKEN_ENCRYPTION_KEY.length < 32 ||
    !/^\d+$/.test(MONDAY_ORDER_BOARD_ID)
  ) return null;
  return await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:write"]);
}

function mondayFileBytes(file: Row): Uint8Array {
  const encoded = mondayText(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("The onboarding document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (!declared || bytes.byteLength !== declared || bytes.byteLength > 10 * 1024 * 1024) {
    throw new Error("The onboarding document size did not pass validation.");
  }
  const contentType = mondayText(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (
    !((contentType === "application/pdf" && pdf) ||
      (contentType === "image/png" && png) ||
      (contentType === "image/jpeg" && jpeg))
  ) throw new Error("The onboarding document contents do not match its declared file type.");
  return bytes;
}

async function mondayBoardColumns(accessToken: string, boardId: string): Promise<Row[]> {
  const data = await mondayGraphql(
    accessToken,
    `query PortalBoardColumns($boardIds: [ID!]!) {
      boards(ids: $boardIds) { id columns { id title type } }
    }`,
    { boardIds: [boardId] },
  );
  const boards = Array.isArray(data.boards) ? data.boards as Row[] : [];
  return boards[0] && Array.isArray(boards[0].columns) ? boards[0].columns as Row[] : [];
}

async function ensureMondayColumn(
  accessToken: string,
  boardId: string,
  title: string,
  columnType: "text" | "file",
): Promise<string> {
  const columns = await mondayBoardColumns(accessToken, boardId);
  const existing = columns.find((column) =>
    mondayText(column.title, 200).toLowerCase() === title.toLowerCase()
  );
  if (existing?.id) return mondayColumnId(String(existing.id));
  const data = await mondayGraphql(
    accessToken,
    `mutation CreatePortalColumn($boardId: ID!, $title: String!) {
      create_column(board_id: $boardId, title: $title, column_type: ${columnType}) { id }
    }`,
    { boardId, title },
  );
  const created = data.create_column as Row | undefined;
  if (!created?.id) throw new Error(`Monday did not create the ${title} column.`);
  return mondayColumnId(String(created.id));
}

async function uploadMondayFile(
  accessToken: string,
  itemId: string,
  columnId: string,
  file: Row,
): Promise<void> {
  const bytes = mondayFileBytes(file);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const fileName = mondayText(file.name, 240);
  const contentType = mondayText(file.contentType, 120).toLowerCase();
  const form = new FormData();
  form.set(
    "query",
    `mutation ($file: File!) { add_file_to_column(file: $file, item_id: ${itemId}, column_id: "${columnId}") { id } }`,
  );
  form.set(
    "variables[file]",
    new File([buffer], fileName, { type: contentType }),
  );
  const response = await fetch("https://api.monday.com/v2/file", {
    method: "POST",
    headers: { authorization: accessToken },
    body: form,
  });
  const body = await response.json().catch(() => ({})) as Row;
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    throw new Error("Monday created the onboarding item but did not accept its document.");
  }
}

async function archiveOnboardingDocument(
  requestId: string,
  file: Row,
  caller: { user: Row; profile: Row } | null,
): Promise<Row> {
  const bytes = mondayFileBytes(file);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer),
  );
  const digest = Array.from(digestBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const contentType = mondayText(file.contentType, 120).toLowerCase();
  const extension = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
  const objectPath = `${requestId}/${digest}.${extension}`;
  const { data: existing, error: existingError } = await service.from("portal_onboarding_document")
    .select("*").eq("onboarding_request_id", requestId).eq("sha256", digest).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing as Row;
  const { error: uploadError } = await service.storage.from("portal-onboarding-documents").upload(
    objectPath,
    bytes,
    { contentType, cacheControl: "0", upsert: false },
  );
  if (uploadError && !String(uploadError.message || "").toLowerCase().includes("already exists")) {
    throw uploadError;
  }
  const { data, error } = await service.from("portal_onboarding_document").insert({
    onboarding_request_id: requestId,
    object_path: objectPath,
    original_name: mondayText(file.name, 240),
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: digest,
    scan_state: "pending_provider",
    transfer_state: "pending",
    uploaded_by: caller?.profile.id ?? null,
  }).select("*").single();
  if (error) throw error;
  return data as Row;
}

async function directMondayOnboarding(payload: Row): Promise<Row | null> {
  const accessToken = await mondayWriteToken();
  if (!accessToken || !/^\d+$/.test(MONDAY_ONBOARDING_BOARD_ID)) return null;
  const requestId = mondayText(payload.clientRequestId, 80);
  const legalEntity = mondayText(payload.legalEntity, 300);
  if (!requestId || !legalEntity) throw new Error("The direct Monday onboarding identifiers are incomplete.");
  const requestColumnId = await ensureMondayColumn(
    accessToken,
    MONDAY_ONBOARDING_BOARD_ID,
    "Portal Request ID",
    "text",
  );
  const file = payload.file && typeof payload.file === "object" && !Array.isArray(payload.file)
    ? payload.file as Row
    : null;
  const fileColumnId = file
    ? await ensureMondayColumn(accessToken, MONDAY_ONBOARDING_BOARD_ID, "Onboarding Documents", "file")
    : null;
  const existingData = await mondayGraphql(
    accessToken,
    `query ExistingPortalOnboarding($boardId: ID!, $requestId: String!) {
      items_page_by_column_values(
        board_id: $boardId, limit: 1,
        columns: [{ column_id: "${requestColumnId}", column_values: [$requestId] }]
      ) { items { id name } }
    }`,
    { boardId: MONDAY_ONBOARDING_BOARD_ID, requestId },
  );
  const existing = firstMondayItem(existingData);
  if (existing?.id) {
    if (file && fileColumnId) {
      await uploadMondayFile(accessToken, String(existing.id), fileColumnId, file);
    }
    return {
      mondayItemId: String(existing.id),
      mondayBoardId: MONDAY_ONBOARDING_BOARD_ID,
      status: "accepted",
      idempotent: true,
      transport: "monday-direct",
      documentDelivered: Boolean(file),
    };
  }
  const owner = payload.owner && typeof payload.owner === "object" ? payload.owner as Row : {};
  const buyer = payload.buyer && typeof payload.buyer === "object" ? payload.buyer as Row : {};
  const locations = Array.isArray(payload.locations) ? payload.locations as Row[] : [];
  const locationsText = locations.map((location) => [
    mondayText(location.name, 200),
    mondayText(location.license, 120),
    mondayText(location.address, 500),
    mondayText(location.licenseExpiresOn, 40),
  ].filter(Boolean).join(" · ")).join("\n");
  const submissionType = mondayText(payload.submissionType, 120) || "New store";
  const columnValues: Row = {
    color_mm6jkc5s: { label: submissionType },
    color_mm6ja098: { label: "01 Intake" },
    long_text_mm6js18: locationsText,
    text_mm6jywpe: [mondayText(owner.name, 200), mondayText(owner.email, 320)].filter(Boolean).join(" · "),
    text_mm6jtxq3: [mondayText(buyer.name, 200), mondayText(buyer.email, 320)].filter(Boolean).join(" · "),
    numeric_mm6j7wyc: String(Number(payload.budtenderCount) || 0),
    text_mm6jrv8k: mondayText(payload.submittedBy, 300),
    [requestColumnId]: requestId,
  };
  const createdData = await mondayGraphql(
    accessToken,
    `mutation CreatePortalOnboarding($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: true) { id }
    }`,
    {
      boardId: MONDAY_ONBOARDING_BOARD_ID,
      itemName: `${submissionType} · ${legalEntity}`.slice(0, 500),
      columnValues: JSON.stringify(columnValues),
    },
  );
  const created = createdData.create_item as Row | undefined;
  if (!created?.id) throw new Error("Monday did not return the created onboarding item.");
  if (file && fileColumnId) {
    await uploadMondayFile(accessToken, String(created.id), fileColumnId, file);
  }
  return {
    mondayItemId: String(created.id),
    mondayBoardId: MONDAY_ONBOARDING_BOARD_ID,
    status: "accepted",
    transport: "monday-direct",
    documentDelivered: Boolean(file),
  };
}

function firstMondayItem(data: Row): Row | null {
  const page = data.items_page_by_column_values;
  const items = page && typeof page === "object" &&
      Array.isArray((page as Row).items)
    ? (page as Row).items as Row[]
    : [];
  return items[0] ?? null;
}

async function directMondayOrder(payload: Row): Promise<Row | null> {
  const accessToken = await mondayWriteToken();
  if (!accessToken) return null;
  const clientRequestId = mondayText(payload.clientRequestId, 80);
  const portalOrderId = mondayText(payload.portalOrderId, 80);
  const orderNumber = mondayText(
    payload.orderNumber || payload.portalReference,
    160,
  );
  if (!clientRequestId || !portalOrderId || !orderNumber) {
    throw new Error("The direct Monday order identifiers are incomplete.");
  }
  const requestColumnId = mondayColumnId(
    MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID,
  );

  const existingData = await mondayGraphql(
    accessToken,
    `query ExistingPortalOrder($boardId: ID!, $requestId: String!) {
      items_page_by_column_values(
        board_id: $boardId,
        limit: 1,
        columns: [{
          column_id: "${requestColumnId}",
          column_values: [$requestId]
        }]
      ) { items { id name } }
    }`,
    { boardId: MONDAY_ORDER_BOARD_ID, requestId: clientRequestId },
  );
  const existing = firstMondayItem(existingData);
  if (existing?.id) {
    return {
      orderNumber,
      mondayItemId: String(existing.id),
      mondayBoardId: MONDAY_ORDER_BOARD_ID,
      status: "accepted",
      idempotent: true,
      transport: "monday-direct",
    };
  }

  let accountItemId = "";
  const license = mondayText(payload.licenceNumber, 120);
  if (
    license && /^\d+$/.test(MONDAY_ACCOUNT_BOARD_ID) &&
    MONDAY_ACCOUNT_LICENSE_COLUMN_ID
  ) {
    const accountLicenseColumnId = mondayColumnId(
      MONDAY_ACCOUNT_LICENSE_COLUMN_ID,
    );
    const accountData = await mondayGraphql(
      accessToken,
      `query PortalAccount($boardId: ID!, $license: String!) {
        items_page_by_column_values(
          board_id: $boardId,
          limit: 1,
          columns: [{
            column_id: "${accountLicenseColumnId}",
            column_values: [$license]
          }]
        ) { items { id name } }
      }`,
      { boardId: MONDAY_ACCOUNT_BOARD_ID, license },
    );
    accountItemId = mondayText(firstMondayItem(accountData)?.id, 80);
  }

  const submittedBy = mondayText(payload.submittedBy, 300);
  const columnValues: Row = {
    text_mm6jgek: orderNumber,
    text_mm6j3476: mondayText(payload.location, 300),
    text_mm6jpgsm: submittedBy,
    text_mm6jnqbk: submittedBy,
    date_mm6j8kmp: { date: new Date().toISOString().slice(0, 10) },
    numeric_mm6jmfwg: String(Number(payload.orderValue) || 0),
    numeric_mm6j94q3: String(Number(payload.lineCount) || 0),
    long_text_mm6j2xp2: mondayText(payload.orderDetailText, 10_000),
    long_text_mm6j47ww: mondayText(payload.deliveryText, 10_000),
    color_mm6jxv8f: { label: "Ordered" },
    color_mm6jqkwx: {
      label: mondayText(payload.approvalState, 120) || "Ordered",
    },
    color_mm6jzvmf: {
      label: mondayText(payload.submittedVia, 120) || "UX Store Portal",
    },
    text_mm6jq08r: mondayText(payload.approvalHeldBy, 300),
    long_text_mm6jw2wy: mondayText(payload.gatesAtSubmission, 10_000),
    [requestColumnId]: clientRequestId,
    text_mm6sphg5: portalOrderId,
  };
  if (/^\d+$/.test(accountItemId)) {
    columnValues.board_relation_mm6jmjd4 = {
      item_ids: [Number(accountItemId)],
    };
  }
  const account = mondayText(payload.account, 300);
  const location = mondayText(payload.location, 300);
  const createdData = await mondayGraphql(
    accessToken,
    `mutation CreatePortalOrder(
      $boardId: ID!, $itemName: String!, $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: MONDAY_ORDER_BOARD_ID,
      itemName: `${orderNumber} · ${account} (${location})`.slice(0, 500),
      columnValues: JSON.stringify(columnValues),
    },
  );
  const created = createdData.create_item as Row | undefined;
  if (!created?.id) {
    throw new Error("Monday did not return the created order item.");
  }
  return {
    orderNumber,
    mondayItemId: String(created.id),
    mondayBoardId: MONDAY_ORDER_BOARD_ID,
    status: "accepted",
    transport: "monday-direct",
  };
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
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
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
    },
  });
}

async function identity(
  request: Request,
): Promise<{ user: Row; profile: Row } | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  if (!verifiedTokenHasAal2(authorization)) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active,locations",
  ).eq("id", user.id).maybeSingle();
  return profile && profile.active !== false
    ? { user, profile: profile as Row }
    : null;
}

async function hasPermission(
  profile: Row,
  permission: string,
): Promise<boolean> {
  if (profile.role !== "internal") return false;
  const { data } = await service.from("portal_role_permission").select(
    "permission",
  )
    .eq("staff_role", profile.staff_role).eq("permission", permission)
    .maybeSingle();
  return !!data;
}

async function canSubmit(kind: string, profile: Row): Promise<boolean> {
  if (kind === "order") {
    return ["owner", "buyer"].includes(String(profile.role)) ||
      (profile.role === "internal" &&
        await hasPermission(profile, "orders.manage"));
  }
  if (kind === "license") {
    return ["owner", "buyer", "internal"].includes(String(profile.role));
  }
  if (kind === "recall") {
    return profile.role === "internal" &&
      await hasPermission(profile, "quality.manage");
  }
  if (kind === "onboarding" && profile.role === "internal") {
    return await hasPermission(profile, "accounts.manage");
  }
  return true;
}

async function verifyPublicOnboardingHuman(payload: Row): Promise<void> {
  if (!TURNSTILE_REQUIRED) return;
  if (!TURNSTILE_SECRET_KEY || !PUBLIC_INTAKE_RATE_SECRET) {
    throw new IntakeError(
      503,
      "Public onboarding protection is not configured.",
    );
  }
  const token = String(payload.antiAbuseToken || "").trim();
  if (!token || token.length > 2048) {
    throw new IntakeError(400, "Complete the verification challenge.");
  }
  const form = new FormData();
  form.set("secret", TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("idempotency_key", crypto.randomUUID());
  // Deliberately omit remoteip: the portal does not retain or forward a
  // visitor IP address merely to submit an onboarding request.
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form },
  );
  if (!response.ok) {
    throw new IntakeError(503, "Verification is temporarily unavailable.");
  }
  const result = await response.json() as Row;
  const hostname = String(result.hostname || "").toLowerCase();
  if (
    result.success !== true ||
    result.action !== "retailer_onboarding" ||
    (TURNSTILE_ALLOWED_HOSTS.size > 0 &&
      !TURNSTILE_ALLOWED_HOSTS.has(hostname))
  ) {
    throw new IntakeError(400, "The verification challenge was not accepted.");
  }
}

async function protectedScope(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PUBLIC_INTAKE_RATE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return Array.from(signature).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function claimPublicOnboardingRate(payload: Row): Promise<void> {
  if (!TURNSTILE_REQUIRED) return;
  const owner = payload.owner && typeof payload.owner === "object" &&
      !Array.isArray(payload.owner)
    ? payload.owner as Row
    : {};
  const email = String(owner.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new IntakeError(400, "A valid owner email address is required.");
  }
  const scopeKey = await protectedScope(`onboarding:${email}`);
  const { data, error } = await service.rpc("portal_claim_public_intake_rate", {
    p_scope_key: scopeKey,
    p_limit: PUBLIC_ONBOARDING_DAILY_LIMIT,
  });
  if (error) throw error;
  if (data !== true) {
    throw new IntakeError(
      429,
      "This onboarding contact has reached today's submission limit.",
    );
  }
}

async function verifyOrder(
  payload: Row,
  caller: { user: Row; profile: Row },
): Promise<Row> {
  const license = String(payload.licenceNumber || "").trim();
  if (!license) throw new IntakeError(400, "A licensed store is required.");
  const { data: store, error: storeError } = await service.from("portal_store")
    .select(
      "license_number,organization,display_name,active,approval_threshold_cents,enforce_case_quantity,retailer_account_id,quickbooks_customer_id,license_status,license_expires_on,qualified_at,ordering_status",
    )
    .eq("license_number", license).maybeSingle();
  if (storeError) throw storeError;
  if (!store || store.active === false) {
    throw new IntakeError(403, "That store is not active for portal ordering.");
  }
  if (store.license_status !== "active") {
    throw new IntakeError(
      403,
      "That store license has not been qualified for portal ordering.",
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  if (store.license_expires_on && String(store.license_expires_on) <= today) {
    throw new IntakeError(403, "That store license is expired.");
  }
  if (!store.license_expires_on) {
    throw new IntakeError(
      403,
      "That store needs a current license expiration before ordering.",
    );
  }
  if (!store.quickbooks_customer_id) {
    throw new IntakeError(
      403,
      "That store needs an explicit QuickBooks customer before ordering.",
    );
  }
  if (store.ordering_status !== "ready") {
    throw new IntakeError(403, "Ordering is not enabled for that store.");
  }
  if (!store.retailer_account_id) {
    throw new IntakeError(
      403,
      "That store is not linked to a qualified retailer account.",
    );
  }
  const { data: retailerAccount, error: retailerError } = await service.from(
    "portal_retailer_account",
  )
    .select("portal_status,quickbooks_customer_id").eq(
      "id",
      store.retailer_account_id,
    ).maybeSingle();
  if (retailerError) throw retailerError;
  if (retailerAccount?.portal_status !== "ready_to_order") {
    throw new IntakeError(
      403,
      "That retailer account is not ready for portal ordering.",
    );
  }
  if (retailerAccount.quickbooks_customer_id) {
    const { data: quickbooksCustomer, error: quickbooksError } = await service
      .from("quickbooks_customer_cache")
      .select("active").eq(
        "quickbooks_customer_id",
        retailerAccount.quickbooks_customer_id,
      ).maybeSingle();
    if (quickbooksError) throw quickbooksError;
    if (!quickbooksCustomer || quickbooksCustomer.active === false) {
      throw new IntakeError(
        403,
        "That QuickBooks customer is inactive, so portal ordering is paused.",
      );
    }
  }
  if (
    caller.profile.role !== "internal" &&
    store.organization !== caller.profile.org
  ) {
    throw new IntakeError(403, "That store is outside your organization.");
  }
  if (caller.profile.role === "buyer") {
    const { data: assignment } = await service.from("portal_profile_store")
      .select("license_number")
      .eq("profile_id", caller.profile.id).eq("license_number", license)
      .maybeSingle();
    if (!assignment) {
      throw new IntakeError(403, "That store is outside your assigned access.");
    }
  }

  const rawLines = Array.isArray(payload.lines) ? payload.lines as Row[] : [];
  if (!rawLines.length || rawLines.length > 250) {
    throw new IntakeError(
      400,
      "An order must contain between one and 250 lines.",
    );
  }
  const productIds = Array.from(
    new Set(
      rawLines.map((line) => String(line.productId || "").trim()).filter(
        Boolean,
      ),
    ),
  );
  if (
    productIds.length !== rawLines.length &&
    rawLines.some((line) => !String(line.productId || "").trim())
  ) {
    throw new IntakeError(
      400,
      "Every order line must include its catalog product identifier.",
    );
  }
  const [storePriceResult, defaultPriceResult] = await Promise.all([
    service.from("portal_store_price")
      .select("product_id,product_name,sku,price_cents,published_at")
      .eq("location_license", license).in("product_id", productIds),
    service.from("portal_default_price")
      .select("product_id,product_name,sku,unit_price_cents,published_at")
      .eq("active", true).in("product_id", productIds),
  ]);
  if (storePriceResult.error) throw storePriceResult.error;
  if (defaultPriceResult.error) throw defaultPriceResult.error;
  const priceByProduct = new Map<string, Row>(
    (defaultPriceResult.data ?? []).map((row) => [String(row.product_id), {
      ...row,
      price_cents: row.unit_price_cents,
      price_source: "default_wholesale",
    }]),
  );
  for (const row of storePriceResult.data ?? []) {
    priceByProduct.set(String(row.product_id), {
      ...row,
      price_source: "approved_store_override",
    });
  }
  const missingPrice = productIds.find((productId) =>
    !priceByProduct.has(productId)
  );
  if (missingPrice) {
    throw new IntakeError(
      409,
      "A product in this draft no longer has an approved price for this store. Refresh the catalog and review the draft.",
    );
  }

  const requestedByProduct = new Map(productIds.map((productId) => [
    productId,
    rawLines.filter((line) => String(line.productId || "").trim() === productId)
      .reduce((sum, line) => sum + (Number(line.quantity) || 0), 0),
  ]));
  const canixProductIds = productIds.filter((id) =>
    id.startsWith("canix:item:")
  );
  const numericItemIds = canixProductIds.map((id) =>
    id.slice("canix:item:".length)
  ).filter((id) => /^\d+$/.test(id));
  const releasedUnitsByProduct = new Map<string, number>();
  if (canixProductIds.length) {
    const { data: sync } = await service.from("canix_sync_state").select(
      "last_successful_run_id",
    ).eq("id", 1).maybeSingle();
    if (!sync?.last_successful_run_id) {
      throw new IntakeError(
        503,
        "Canix release data is temporarily unavailable. The draft was preserved.",
      );
    }
    if (numericItemIds.length) {
      const { data: packages, error: packageError } = await service.from(
        "canix_package_current",
      )
        .select(
          "item_id,status_category,quantity_type,weight,c_reserved_weight,reservation_state,orderable_units,case_quantity,case_quantity_unit,lab_test_status,test_result_status,has_coa",
        )
        .eq("sync_run_id", sync.last_successful_run_id).eq(
          "status_category",
          "available",
        )
        .eq("quantity_type", "CountBased").in("item_id", numericItemIds);
      if (packageError) throw packageError;
      for (const itemId of numericItemIds) {
        const matching = (packages ?? []).filter((row) => {
          const explicitOrderable =
            row.orderable_units === null || row.orderable_units === undefined
              ? Number(row.weight)
              : Number(row.orderable_units);
          return String(row.item_id) === itemId &&
            Number.isFinite(explicitOrderable) && explicitOrderable > 0 &&
            !labFailed(row as unknown as Row);
        });
        if (!matching.length) {
          throw new IntakeError(
            409,
            "A Canix product in this draft is no longer available. Refresh the catalog and review the draft.",
          );
        }
        const releasedUnits = matching.filter((row) =>
          labPassed(row as unknown as Row)
        )
          .reduce((sum, row) => {
            const value =
              row.orderable_units === null || row.orderable_units === undefined
                ? row.weight
                : row.orderable_units;
            return sum + Math.max(0, Number(value) || 0);
          }, 0);
        releasedUnitsByProduct.set(`canix:item:${itemId}`, releasedUnits);
        const requested = requestedByProduct.get(`canix:item:${itemId}`) ?? 0;
        const available = matching.reduce((sum, row) => {
          const value =
            row.orderable_units === null || row.orderable_units === undefined
              ? row.weight
              : row.orderable_units;
          return sum + Math.max(0, Number(value) || 0);
        }, 0);
        if (requested > available) {
          throw new IntakeError(
            409,
            "A requested product exceeds current orderable Canix inventory. The draft was preserved; reduce the quantity or contact Sales.",
          );
        }
        if (store.enforce_case_quantity === true) {
          const caseQuantities = Array.from(
            new Set(
              matching.map((row) => Number(row.case_quantity))
                .filter((value) => Number.isSafeInteger(value) && value > 0),
            ),
          );
          if (caseQuantities.length !== 1) {
            throw new IntakeError(
              409,
              "Case enforcement is enabled for this store, but Canix does not provide one unambiguous case quantity for a product in this draft. Contact Sales.",
            );
          }
          if (requested % caseQuantities[0] !== 0) {
            throw new IntakeError(
              409,
              `This store orders ${
                caseQuantities[0]
              } units per case for a product in this draft. Adjust the quantity to a whole-case multiple.`,
            );
          }
        }
      }
    }
    for (const productId of canixProductIds) {
      if (!releasedUnitsByProduct.has(productId)) {
        releasedUnitsByProduct.set(productId, 0);
      }
    }
  }

  let orderValueCents = 0;
  const verifiedLines = rawLines.map((line) => {
    const productId = String(line.productId || "").trim();
    const price = priceByProduct.get(productId)!;
    const quantity = Number(line.quantity);
    const submittedPrice = Number(line.unitPriceCents);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) {
      throw new IntakeError(
        400,
        "Every order quantity must be a positive whole number below 10,000.",
      );
    }
    if (
      !Number.isInteger(submittedPrice) ||
      submittedPrice !== Number(price.price_cents)
    ) {
      throw new IntakeError(
        409,
        "A published store price changed after this draft was built. Refresh the draft before submitting.",
      );
    }
    orderValueCents += Number(price.price_cents) * quantity;
    const preorder = productId.startsWith("canix:item:") &&
      (requestedByProduct.get(productId) ?? quantity) >
        (releasedUnitsByProduct.get(productId) ?? 0);
    return {
      productId,
      product: price.product_name,
      sku: price.sku,
      // Retailers inspect lot records but never allocate a specific lot. The
      // fulfillment workflow writes the compliance tag after urbanXtracts
      // allocates the package in Canix/Monday.
      tag: "",
      quantity,
      unit: "each",
      unitPriceCents: Number(price.price_cents),
      lineTotalCents: Number(price.price_cents) * quantity,
      orderMode: preorder ? "preorder" : "standard",
      releaseState: preorder ? "awaiting_release" : "released",
    };
  });
  const preorderProductIds = verifiedLines.filter((line) =>
    line.orderMode === "preorder"
  ).map((line) => line.productId);
  const threshold = store.approval_threshold_cents === null ||
      store.approval_threshold_cents === undefined
    ? null
    : Number(store.approval_threshold_cents);
  const ownerApprovalRequired = caller.profile.role === "buyer" &&
    threshold !== null &&
    (threshold === 0 || orderValueCents > threshold);
  return {
    ...payload,
    account: store.organization,
    licenceNumber: store.license_number,
    location: store.display_name,
    lines: verifiedLines,
    lineCount: verifiedLines.length,
    orderValue: orderValueCents / 100,
    orderValueCents,
    approvalThresholdCents: threshold,
    ownerApprovalRequired,
    approvalState: ownerApprovalRequired
      ? "Awaiting store owner approval"
      : "Ordered",
    containsPreorder: preorderProductIds.length > 0,
    preorderProductIds,
    releaseHold: preorderProductIds.length > 0,
    caseQuantityEnforced: store.enforce_case_quantity === true,
    gatesAtSubmission:
      "Retailer readiness, store license, ordering status, store scope, published price, Canix availability after explicit reservations, optional case policy, release state, and owner-approval threshold verified server-side.",
  };
}

async function createDurableOrder(
  payload: Row,
  caller: { user: Row; profile: Row },
): Promise<Row> {
  const clientRequestId = String(payload.clientRequestId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(clientRequestId)
  ) {
    throw new IntakeError(
      400,
      "The order is missing a valid idempotency identifier. Refresh the draft and try again.",
    );
  }
  const portalReference = String(
    payload.orderNumber || payload.portalReference || "",
  ).trim().slice(0, 160);
  if (!portalReference) {
    throw new IntakeError(400, "The order is missing its portal reference.");
  }
  const { data, error } = await service.rpc("portal_create_order", {
    p_client_request_id: clientRequestId,
    p_portal_reference: portalReference,
    p_organization: payload.account,
    p_location_license: payload.licenceNumber,
    p_location_name: payload.location,
    p_submitted_by: caller.profile.id,
    p_submitted_by_email: caller.user.email ?? null,
    p_submitted_by_role: caller.profile.role,
    p_state: payload.ownerApprovalRequired
      ? "awaiting_owner_approval"
      : "ordered",
    p_owner_approval_required: payload.ownerApprovalRequired === true,
    p_approval_threshold_cents: payload.approvalThresholdCents ?? null,
    p_order_value_cents: payload.orderValueCents,
    p_contains_preorder: payload.containsPreorder === true,
    p_release_hold: payload.releaseHold === true,
    p_delivery_window: payload.deliveryWindow ?? null,
    p_receiving_contact: payload.receivingContact ?? null,
    p_receiving_instructions: payload.receivingInstructions ?? null,
    p_lines: payload.lines,
    p_metadata: {
      summary: payload.summary,
      submittedVia: payload.submittedVia,
      approvalHeldBy: payload.approvalHeldBy,
      gatesAtSubmission: payload.gatesAtSubmission,
      caseQuantityEnforced: payload.caseQuantityEnforced === true,
    },
  });
  if (error) {
    const message = String(error.message || "");
    if (
      message.includes(
        "exceeds Canix availability after active portal commitments",
      )
    ) {
      throw new IntakeError(
        409,
        "A requested product is no longer available in the submitted quantity. The draft was preserved; reduce the quantity or contact Sales.",
      );
    }
    if (message.includes("No successful Canix snapshot")) {
      throw new IntakeError(
        503,
        "Canix availability is temporarily unavailable. The draft was preserved.",
      );
    }
    if (message.includes("require count-based Canix catalog items")) {
      throw new IntakeError(
        409,
        "Every live order line must use a current count-based Canix catalog item.",
      );
    }
    throw error;
  }
  return data as unknown as Row;
}

async function markDurableOrder(
  orderId: string,
  workflowState: string,
  options: Row = {},
): Promise<Row> {
  const { data, error } = await service.rpc("portal_mark_order_workflow", {
    p_order_id: orderId,
    p_workflow_state: workflowState,
    p_order_number: options.orderNumber ?? null,
    p_monday_item_id: options.mondayItemId ?? null,
    p_monday_board_id: options.mondayBoardId ?? null,
    p_error: options.error ?? null,
    p_metadata: options.metadata ?? {},
  });
  if (error) throw error;
  return data as unknown as Row;
}

async function existingDurableOrder(orderId: string): Promise<Row | null> {
  const { data, error } = await service.from("portal_order")
    .select(
      "id,portal_reference,order_number,state,workflow_state,owner_approval_required,approval_threshold_cents,contains_preorder,release_hold,order_value_cents",
    )
    .eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

function onboardingSubmissionType(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "new store" || normalized === "new_store") {
    return "new_store";
  }
  if (
    normalized === "existing store, people change" ||
    normalized === "people_change"
  ) return "people_change";
  if (
    normalized === "existing store, new location" ||
    normalized === "new_location"
  ) return "new_location";
  throw new IntakeError(400, "Choose a supported onboarding request type.");
}

async function createDurableOnboarding(
  payload: Row,
  caller: { user: Row; profile: Row } | null,
): Promise<Row> {
  const clientRequestId = String(payload.clientRequestId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(clientRequestId)
  ) {
    throw new IntakeError(
      400,
      "The onboarding request is missing a valid idempotency identifier. Refresh and try again.",
    );
  }
  const owner = payload.owner && typeof payload.owner === "object" &&
      !Array.isArray(payload.owner)
    ? payload.owner as Row
    : {};
  const stores = Array.isArray(payload.locations)
    ? payload.locations as Row[]
    : [];
  const normalizedStores = stores.map((store) => ({
    name: String(store.name || "").trim().slice(0, 200),
    license: String(store.license || "").trim().toUpperCase().slice(0, 120),
    address: String(store.address || "").trim().slice(0, 500),
    licenseType: String(store.licenseType || "").trim().slice(0, 160) || null,
    licenseIssuedOn: String(store.licenseIssuedOn || "").trim().slice(0, 10) || null,
    licenseExpiresOn: String(store.licenseExpiresOn || "").trim().slice(0, 10) || null,
  }));
  const internalStorePanel = payload.internalStorePanel === true &&
    caller?.profile.role === "internal" &&
    await hasPermission(caller.profile, "accounts.manage");
  let retailerAccountId: string | null = null;
  let quickbooksCustomerId: string | null = null;
  if (internalStorePanel) {
    retailerAccountId = String(payload.retailerAccountId || "").trim() || null;
    quickbooksCustomerId = String(payload.quickbooksCustomerId || "").trim()
      .slice(0, 160) || null;
    if (!quickbooksCustomerId) {
      throw new IntakeError(
        400,
        "Choose a verified QuickBooks retailer before adding a store.",
      );
    }
    const { data: qboCustomer, error: qboError } = await service.from(
      "quickbooks_customer_cache",
    ).select("quickbooks_customer_id,parent_customer_id,active").eq(
      "quickbooks_customer_id",
      quickbooksCustomerId,
    ).maybeSingle();
    if (qboError) throw qboError;
    if (!qboCustomer || qboCustomer.active === false || qboCustomer.parent_customer_id) {
      throw new IntakeError(
        409,
        "The selected QuickBooks retailer must be an active top-level customer.",
      );
    }
    if (retailerAccountId) {
      const { data: account, error: accountError } = await service.from(
        "portal_retailer_account",
      ).select("id,quickbooks_customer_id").eq("id", retailerAccountId)
        .maybeSingle();
      if (accountError) throw accountError;
      if (!account || account.quickbooks_customer_id !== quickbooksCustomerId) {
        throw new IntakeError(
          409,
          "The portal retailer and QuickBooks customer do not match.",
        );
      }
    }
    const file = payload.file && typeof payload.file === "object" &&
        !Array.isArray(payload.file)
      ? payload.file as Row
      : {};
    const fileName = String(file.name || "").trim().slice(0, 240);
    const fileType = String(file.contentType || "").trim().toLowerCase();
    const fileSize = Number(file.sizeBytes || 0);
    const fileBody = String(file.base64 || "");
    if (
      !fileName || !/\.(pdf|png|jpe?g)$/i.test(fileName) ||
      !new Set(["application/pdf", "image/png", "image/jpeg"]).has(fileType) ||
      !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 10 * 1024 * 1024 ||
      fileBody.length < 4 || fileBody.length > 14_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(fileBody)
    ) {
      throw new IntakeError(
        400,
        "Attach a PDF, PNG, or JPEG license document no larger than 10 MB.",
      );
    }
  }
  const storeLicense = (location: unknown): string | null => {
    const target = String(location || "").trim().toLowerCase();
    if (!target) return null;
    const match = normalizedStores.find((store) =>
      store.license.toLowerCase() === target ||
      store.name.toLowerCase() === target
    );
    return match?.license ?? null;
  };
  const people: Row[] = [];
  if (String(owner.name || "").trim() || String(owner.email || "").trim()) {
    people.push({
      role: "owner",
      name: String(owner.name || "").trim().slice(0, 200),
      email: String(owner.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(owner.phone || "").trim().slice(0, 80),
      storeLicense: null,
    });
  }
  const buyer = payload.buyer && typeof payload.buyer === "object" &&
      !Array.isArray(payload.buyer)
    ? payload.buyer as Row
    : null;
  if (
    buyer &&
    (String(buyer.name || "").trim() || String(buyer.email || "").trim())
  ) {
    people.push({
      role: "buyer",
      name: String(buyer.name || "").trim().slice(0, 200),
      email: String(buyer.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(buyer.phone || "").trim().slice(0, 80),
      storeLicense: storeLicense(buyer.location),
    });
  }
  const budtenders = Array.isArray(payload.budtenders)
    ? payload.budtenders as Row[]
    : [];
  for (const budtender of budtenders) {
    if (
      !String(budtender.name || "").trim() &&
      !String(budtender.email || "").trim()
    ) continue;
    people.push({
      role: "budtender",
      name: String(budtender.name || "").trim().slice(0, 200),
      email: String(budtender.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(budtender.phone || "").trim().slice(0, 80),
      storeLicense: storeLicense(budtender.location),
    });
  }
  const { data, error } = await service.rpc(
    "portal_create_onboarding_request",
    {
      p_client_request_id: clientRequestId,
      // Public intake never chooses authoritative account links. The protected
      // internal Store Onboarding panel may pin a verified QuickBooks identity.
      p_retailer_account_id: retailerAccountId,
      p_quickbooks_customer_id: quickbooksCustomerId,
      p_submission_type: onboardingSubmissionType(payload.submissionType),
      p_legal_entity: String(payload.legalEntity || "").trim().slice(0, 300),
      p_dba: String(payload.dba || "").trim().slice(0, 300),
      p_submitted_by: caller?.profile.id ?? null,
      p_submitted_by_email: caller?.user.email ?? owner.email ?? null,
      p_owner: owner,
      p_stores: normalizedStores,
      p_people: people,
      p_metadata: {
        summary: String(payload.summary || "").slice(0, 500),
        submittedVia: "UX Store Portal",
        submittedByLabel: String(payload.submittedBy || "").slice(0, 300),
        internalStorePanel,
        storeEvidence: normalizedStores.map((store) => ({
          license: store.license,
          licenseType: store.licenseType,
          licenseIssuedOn: store.licenseIssuedOn,
          licenseExpiresOn: store.licenseExpiresOn,
        })),
        reviewNote: String(payload.reviewNote || "").trim().slice(0, 2000) || null,
        document: internalStorePanel && payload.file && typeof payload.file === "object"
          ? {
            name: String((payload.file as Row).name || "").trim().slice(0, 240),
            sizeBytes: Number((payload.file as Row).sizeBytes || 0),
            contentType: String((payload.file as Row).contentType || "").trim().slice(0, 120),
          }
          : null,
      },
    },
  );
  if (error) {
    const message = String(error.message || "");
    const safe = [
      "supported onboarding submission type",
      "between one and ten stores",
      "Legal entity is required",
      "Owner contact is required",
      "Every store requires",
      "cannot repeat a store license",
      "Every onboarding person requires",
      "idempotency identifier belongs to a different onboarding request",
    ].find((candidate) => message.includes(candidate));
    if (safe) throw new IntakeError(409, safe);
    throw error;
  }
  const durable = data as unknown as Row;
  if (internalStorePanel && durable.created !== false && durable.id) {
    for (const store of normalizedStores) {
      const expires = store.licenseExpiresOn && /^\d{4}-\d{2}-\d{2}$/.test(store.licenseExpiresOn)
        ? store.licenseExpiresOn
        : null;
      const { error: storeError } = await service.from("portal_onboarding_store")
        .update({ license_expires_on: expires }).eq("onboarding_request_id", durable.id)
        .eq("license_number", store.license);
      if (storeError) throw storeError;
    }
  }
  return durable;
}

async function markDurableOnboarding(
  requestId: string,
  workflowState: string,
  options: Row = {},
): Promise<Row> {
  const { data, error } = await service.rpc("portal_mark_onboarding_workflow", {
    p_request_id: requestId,
    p_workflow_state: workflowState,
    p_monday_item_id: options.mondayItemId ?? null,
    p_monday_board_id: options.mondayBoardId ?? null,
    p_error: options.error ?? null,
  });
  if (error) throw error;
  return data as unknown as Row;
}

async function existingDurableOnboarding(
  requestId: string,
): Promise<Row | null> {
  const { data, error } = await service.from("portal_onboarding_request")
    .select("id,stage,workflow_state,monday_item_id,monday_board_id")
    .eq("id", requestId).maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 15_000_000) {
    return json(request, { error: "Submission is too large." }, 413);
  }
  let durableOrderId: string | null = null;
  let durableOnboardingId: string | null = null;
  let durableOnboardingDocumentId: string | null = null;
  try {
    const body = await request.json() as Row;
    const kind = String(body.kind || "").trim();
    const payload = body.payload && typeof body.payload === "object" &&
        !Array.isArray(body.payload)
      ? body.payload as Row
      : null;
    if (!KINDS.has(kind) || !payload) {
      return json(
        request,
        { error: "Unsupported or incomplete submission." },
        400,
      );
    }
    const caller = await identity(request);
    if (!caller && kind !== "onboarding") {
      return json(request, { error: "Sign in is required." }, 401);
    }
    if (caller && !(await canSubmit(kind, caller.profile))) {
      return json(
        request,
        { error: "This role cannot submit that request." },
        403,
      );
    }
    let directMondayConfigured = false;
    if ((kind === "order" && caller) || kind === "onboarding") {
      try {
        directMondayConfigured = !!(await mondayWriteToken());
      } catch {
        // The existing Make path remains available if connection-state
        // inspection is temporarily unavailable.
      }
    }
    if (
      (!MAKE_WEBHOOK_URL || !MAKE_INTAKE_SECRET) &&
      !directMondayConfigured
    ) {
      return json(
        request,
        { error: "The portal intake is not configured." },
        503,
      );
    }

    const verifiedPayload = kind === "order" && caller
      ? await verifyOrder(payload, caller)
      : { ...payload };
    if (kind === "onboarding") {
      if (!caller) {
        await verifyPublicOnboardingHuman(verifiedPayload);
        await claimPublicOnboardingRate(verifiedPayload);
      }
      delete verifiedPayload.antiAbuseToken;
    }
    if (caller) {
      verifiedPayload.submittedBy = `${
        caller.profile.full_name || caller.user.email || caller.user.id
      } (${caller.profile.role})`;
      verifiedPayload.submittedById = caller.user.id;
      verifiedPayload.submittedByOrg = caller.profile.org;
    }
    if (kind === "order" && caller) {
      const durable = await createDurableOrder(verifiedPayload, caller);
      durableOrderId = String(durable.id || "");
      if (!durableOrderId) {
        throw new Error("The durable order record was not created.");
      }
      verifiedPayload.portalOrderId = durableOrderId;
      verifiedPayload.clientRequestId = String(
        verifiedPayload.clientRequestId || "",
      );
      if (durable.created === false) {
        const existing = await existingDurableOrder(durableOrderId);
        if (existing?.workflow_state === "accepted") {
          return json(request, {
            ok: true,
            idempotent: true,
            portalOrderId: existing.id,
            orderNumber: existing.order_number,
            state: existing.state,
            ownerApprovalRequired: existing.owner_approval_required,
            approvalThresholdCents: existing.approval_threshold_cents,
            containsPreorder: existing.contains_preorder,
            releaseHold: existing.release_hold,
            verifiedOrderValueCents: existing.order_value_cents,
          });
        }
        throw new IntakeError(
          409,
          "This order request already exists and needs reconciliation. It was not sent to Monday again.",
        );
      }
    }
    if (kind === "onboarding") {
      const durable = await createDurableOnboarding(verifiedPayload, caller);
      durableOnboardingId = String(durable.id || "");
      if (!durableOnboardingId) {
        throw new Error("The durable onboarding record was not created.");
      }
      verifiedPayload.portalOnboardingRequestId = durableOnboardingId;
      verifiedPayload.clientRequestId = String(
        verifiedPayload.clientRequestId || "",
      );
      if (durable.created === false) {
        const existing = await existingDurableOnboarding(durableOnboardingId);
        if (existing?.workflow_state === "accepted") {
          return json(request, {
            ok: true,
            idempotent: true,
            portalOnboardingRequestId: existing.id,
            stage: existing.stage,
            mondayItemId: existing.monday_item_id,
            mondayBoardId: existing.monday_board_id,
          });
        }
        throw new IntakeError(
          409,
          "This onboarding request already exists and needs reconciliation. It was not sent to Monday again.",
        );
      }
      if (
        verifiedPayload.file && typeof verifiedPayload.file === "object" &&
        !Array.isArray(verifiedPayload.file)
      ) {
        const document = await archiveOnboardingDocument(
          durableOnboardingId,
          verifiedPayload.file as Row,
          caller,
        );
        durableOnboardingDocumentId = String(document.id || "") || null;
      }
    }
    let response: Response | null = null;
    let result: Row = {};
    if (kind === "order" && durableOrderId) {
      try {
        result = (await directMondayOrder(verifiedPayload)) ?? {};
      } catch {
        // A direct API failure still gets the existing Make compatibility
        // path. Both paths use the same client request identifier.
        result = {};
      }
    }
    if (kind === "onboarding" && durableOnboardingId && directMondayConfigured) {
      // Unlike the legacy compatibility path, direct onboarding is idempotent
      // on Portal Request ID and can deliver the document to the same item.
      // A partial failure must be reconciled there, never fanned out to a
      // second workflow that could create a duplicate board item.
      result = (await directMondayOnboarding(verifiedPayload)) ?? {};
    }
    if (!result.orderNumber && !result.id && !result.mondayItemId) {
      if (!MAKE_WEBHOOK_URL || !MAKE_INTAKE_SECRET) {
        throw new IntakeError(
          503,
          "Monday order delivery is temporarily unavailable.",
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 28_000);
      try {
        response = await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            kind,
            secret: MAKE_INTAKE_SECRET,
            sentAt: new Date().toISOString(),
            source: "UX Store Portal",
            unauthenticated: !caller,
            payload: verifiedPayload,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const text = await response.text();
      try {
        result = text ? JSON.parse(text) as Row : {};
      } catch {
        result = {};
      }
    }
    if (!response) {
      response = new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!response.ok) {
      const message = String(
        result.error || `The workflow returned ${response.status}.`,
      );
      if (durableOrderId) {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      }
      if (durableOnboardingId) {
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
      }
      return json(request, {
        error: message,
        reconciliationRequired: !!(durableOrderId || durableOnboardingId),
        portalOrderId: durableOrderId || null,
        portalOnboardingRequestId: durableOnboardingId || null,
      }, 502);
    }
    if (kind === "order" && !result.orderNumber && !result.id) {
      const message =
        "The order workflow accepted the request but did not return an order number.";
      if (durableOrderId) {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      }
      return json(request, {
        error: message,
        reconciliationRequired: !!durableOrderId,
        portalOrderId: durableOrderId || null,
      }, 502);
    }
    if (kind === "order" && durableOrderId) {
      await markDurableOrder(durableOrderId, "accepted", {
        orderNumber: result.orderNumber || result.id,
        mondayItemId: result.mondayItemId || result.itemId || result.id,
        mondayBoardId: result.mondayBoardId || result.boardId || null,
        metadata: {
          mondayAcceptedAt: new Date().toISOString(),
          mondayStatus: result.status || "accepted",
        },
      });
    }
    if (kind === "onboarding" && durableOnboardingId) {
      const mondayItemId = result.mondayItemId || result.itemId || result.id;
      if (!mondayItemId) {
        const message =
          "The onboarding workflow accepted the request but did not return a Monday item identifier.";
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
        return json(request, {
          error: message,
          reconciliationRequired: true,
          portalOnboardingRequestId: durableOnboardingId,
        }, 502);
      }
      await markDurableOnboarding(durableOnboardingId, "accepted", {
        mondayItemId,
        mondayBoardId: result.mondayBoardId || result.boardId || null,
      });
      if (durableOnboardingDocumentId) {
        await service.from("portal_onboarding_document").update({
          transfer_state: "delivered",
          monday_item_id: String(mondayItemId),
          updated_at: new Date().toISOString(),
        }).eq("id", durableOnboardingDocumentId);
      }
    }
    return json(request, {
      ok: true,
      ...result,
      portalOrderId: durableOrderId,
      portalOnboardingRequestId: durableOnboardingId,
      orderNumber: result.orderNumber || result.id || null,
      ownerApprovalRequired: kind === "order"
        ? verifiedPayload.ownerApprovalRequired
        : undefined,
      approvalThresholdCents: kind === "order"
        ? verifiedPayload.approvalThresholdCents
        : undefined,
      containsPreorder: kind === "order"
        ? verifiedPayload.containsPreorder
        : undefined,
      preorderProductIds: kind === "order"
        ? verifiedPayload.preorderProductIds
        : undefined,
      releaseHold: kind === "order" ? verifiedPayload.releaseHold : undefined,
      verifiedOrderValueCents: kind === "order"
        ? verifiedPayload.orderValueCents
        : undefined,
    });
  } catch (error) {
    const expected = error instanceof IntakeError;
    const timedOut = error instanceof Error && error.name === "AbortError";
    if (!expected && !timedOut) console.error("portal-intake", error);
    const message = timedOut
      ? "The portal workflow timed out."
      : expected
      ? error.message
      : "The portal intake is temporarily unavailable.";
    if (durableOrderId) {
      try {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      } catch { /* Keep the original error response. */ }
    }
    if (durableOnboardingId) {
      try {
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
      } catch { /* Keep the original error response. */ }
    }
    if (durableOnboardingDocumentId) {
      try {
        await service.from("portal_onboarding_document").update({
          transfer_state: "failed",
          updated_at: new Date().toISOString(),
        }).eq("id", durableOnboardingDocumentId);
      } catch { /* Keep the original error response. */ }
    }
    return json(request, {
      error: message,
      reconciliationRequired: !!(durableOrderId || durableOnboardingId),
      portalOrderId: durableOrderId || null,
      portalOnboardingRequestId: durableOnboardingId || null,
    }, error instanceof IntakeError ? error.status : 502);
  }
});
