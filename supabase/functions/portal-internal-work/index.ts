import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import {
  accessRequestDecisionAllowed,
  accessRequestRiskTier,
  purchaseApprovalRoute,
} from "../_shared/internal-work-contract.ts";
import {
  ContentScanError,
  scanContent,
  sha256Hex,
} from "../_shared/content-scanner.ts";
import { mondayAccessToken } from "../_shared/monday-connection.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PORTAL_NOTIFICATIONS_ENABLED =
  Deno.env.get("PORTAL_NOTIFICATIONS_ENABLED") === "true";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const PORTAL_URL = "https://portal.urbanxtracts.com";
const SUPPLY_ORDER_AGENT_EMAIL = "amrit@urbanxtracts.com";
const SUPPLY_ORDER_DESTINATION = "urbanXtracts company receiving address";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_SUPPLY_ORDER_BOARD_ID =
  Deno.env.get("MONDAY_SUPPLY_ORDER_BOARD_ID") ?? "18393924684";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = {
  id: string;
  email: string;
  fullName: string;
  staffRole: string;
  administrator: boolean;
};

const STAFF_ROLES = new Set([
  "administrator",
  "operations",
  "sales",
  "quality",
  "viewer",
]);
const DEPARTMENT_ROLES = new Set([
  "member",
  "manager",
  "department_head",
  "backup_owner",
]);

class InternalWorkError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
    : "https://portal.urbanxtracts.com";
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
    },
  });
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function isSupplyOrderSetupTest(request: Row): boolean {
  const lines = Array.isArray(request.portal_purchase_request_line)
    ? request.portal_purchase_request_line as Row[]
    : [];
  const text = [request.reference, request.vendor_name, request.purpose]
    .concat(lines.map((line) => line.item_description)).filter(Boolean).join(" ");
  return /\b(?:do not fulfill|test approval routing|controlled test|supply order test)\b/i.test(text) ||
    /^(?:test|test vendor)$/i.test(clean(request.vendor_name, 200));
}

const SUPPLY_BOARD_PARENT_COLUMNS = [
  "short_text82ua243b", // Vendor
  "single_selectksq7r27", // Department
];
const SUPPLY_BOARD_LINE_COLUMNS = [
  "link_mkx0rd2a", // Purchase link
  "numeric_mkx0zqnw", // Unit cost
  "text_mkx0y7qp", // SKU
  "color_mkx092ce", // Department
  "dropdown_mkztj5p7", // Expense category
];

function mondayColumnMap(item: Row): Map<string, Row> {
  const values = Array.isArray(item.column_values)
    ? item.column_values as Row[]
    : [];
  return new Map(values.map((value) => [String(value.id ?? ""), value]));
}

function mondayColumnText(values: Map<string, Row>, id: string): string {
  return clean(values.get(id)?.text, 500);
}

function mondayLink(values: Map<string, Row>, id: string): string {
  const column = values.get(id);
  try {
    const parsed = JSON.parse(String(column?.value ?? "{}")) as Row;
    return clean(parsed.url, 1200) || clean(column?.text, 1200);
  } catch {
    return clean(column?.text, 1200);
  }
}

function supplyDepartment(value: unknown): { key: string; label: string } {
  const label = clean(value, 120);
  const normalized = label.toLowerCase();
  if (/maint/.test(normalized)) return { key: "maintenance", label: "Maintenance" };
  if (/admin/.test(normalized)) return { key: "administration", label: "Administration" };
  if (/compliance|quality/.test(normalized)) return { key: "compliance", label: "Compliance" };
  if (/distribution/.test(normalized)) return { key: "distribution", label: "Distribution" };
  if (/human|\bhr\b/.test(normalized)) return { key: "human_resources", label: "Human Resources" };
  if (/grow/.test(normalized)) return { key: "grow", label: "Grow" };
  if (/market/.test(normalized)) return { key: "marketing", label: "Marketing" };
  if (/process/.test(normalized)) return { key: "process", label: "Process" };
  if (/develop/.test(normalized)) return { key: "develop", label: "Develop" };
  if (/brand|licensed/.test(normalized)) return { key: "brand", label: label || "Brand" };
  return { key: "administration", label: label || "Administration" };
}

async function mondayGraphql(
  accessToken: string,
  query: string,
  variables: Row,
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
    throw new Error("The Supply Order board catalog could not be read.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

async function supplyOrderBoardCatalog(): Promise<Row[]> {
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read"]);
  if (!accessToken) return [];

  const itemFields = `
    id name
    column_values(ids: $parentColumns) { id text value }
    subitems {
      id name
      column_values(ids: $lineColumns) { id text value }
    }
  `;
  let data = await mondayGraphql(
    accessToken,
    `query SupplyCatalog($boardIds: [ID!], $parentColumns: [String!], $lineColumns: [String!]) {
      boards(ids: $boardIds) {
        items_page(limit: 100) { cursor items { ${itemFields} } }
      }
    }`,
    {
      boardIds: [MONDAY_SUPPLY_ORDER_BOARD_ID],
      parentColumns: SUPPLY_BOARD_PARENT_COLUMNS,
      lineColumns: SUPPLY_BOARD_LINE_COLUMNS,
    },
  );
  let page = ((Array.isArray(data.boards) ? data.boards[0] : null) as Row | null)
    ?.items_page as Row | undefined;
  const parentItems: Row[] = [];
  for (let pageNumber = 0; page && pageNumber < 20; pageNumber += 1) {
    if (Array.isArray(page.items)) parentItems.push(...page.items as Row[]);
    const cursor = clean(page.cursor, 2000);
    if (!cursor) break;
    data = await mondayGraphql(
      accessToken,
      `query SupplyCatalogNext($cursor: String!, $parentColumns: [String!], $lineColumns: [String!]) {
        next_items_page(limit: 100, cursor: $cursor) { cursor items { ${itemFields} } }
      }`,
      {
        cursor,
        parentColumns: SUPPLY_BOARD_PARENT_COLUMNS,
        lineColumns: SUPPLY_BOARD_LINE_COLUMNS,
      },
    );
    page = data.next_items_page as Row | undefined;
  }

  const unique = new Map<string, Row>();
  for (const parent of parentItems) {
    const parentValues = mondayColumnMap(parent);
    const vendorName = mondayColumnText(parentValues, "short_text82ua243b");
    const parentDepartment = mondayColumnText(parentValues, "single_selectksq7r27");
    const subitems = Array.isArray(parent.subitems) ? parent.subitems as Row[] : [];
    for (const subitem of subitems) {
      const itemDescription = clean(subitem.name, 500);
      if (!itemDescription || /^(?:subitem|item)$/i.test(itemDescription)) continue;
      const values = mondayColumnMap(subitem);
      const sku = mondayColumnText(values, "text_mkx0y7qp");
      const department = supplyDepartment(
        mondayColumnText(values, "color_mkx092ce") || parentDepartment,
      );
      const purchaseUrl = mondayLink(values, "link_mkx0rd2a");
      const unitCostText = mondayColumnText(values, "numeric_mkx0zqnw")
        .replace(/[$,]/g, "");
      const unitCost = Number(unitCostText);
      const dedupeKey = [itemDescription, sku, vendorName]
        .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
        .join("|");
      if (!unique.has(dedupeKey)) {
        unique.set(dedupeKey, {
          id: `monday-${clean(subitem.id, 80)}`,
          sourceItemId: clean(subitem.id, 80),
          itemDescription,
          sku,
          vendorName,
          department: department.label,
          departmentKey: department.key,
          purchaseUrl,
          unitCost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : null,
          expenseCategory: mondayColumnText(values, "dropdown_mkztj5p7") || "supplies",
        });
      }
    }
  }
  return Array.from(unique.values()).sort((left, right) =>
    String(left.department).localeCompare(String(right.department)) ||
    String(left.itemDescription).localeCompare(String(right.itemDescription))
  );
}

function interpolate(
  template: string,
  variables: Row,
  allowed: string[],
): string {
  const values: Row = { ...variables, portalUrl: PORTAL_URL };
  return template.replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (_match, key) =>
      key === "portalUrl" || allowed.includes(key)
        ? clean(values[key], 2000)
        : "",
  );
}

function emailHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
    />/g,
    "&gt;",
  )
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.split(/\n\n+/).map((paragraph) =>
    `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#170e0b">${
      paragraph.replace(/\n/g, "<br>")
    }</p>`
  ).join("");
}

async function sendDepartmentNotification(
  templateKey: string,
  recipientEmail: string,
  variables: Row,
  eventKey: string,
  storedVariables: Row = variables,
): Promise<string> {
  // Notifications remain launch-gated until the portal workflow and recipients
  // have completed setup. Enabling delivery requires an explicit environment
  // change; the safe default is to keep every message held.
  if (!PORTAL_NOTIFICATIONS_ENABLED) return "held_launch";
  const { data: template, error: templateError } = await service.from(
    "portal_notification_template",
  )
    .select("*").eq("template_key", templateKey).eq(
      "approval_state",
      "approved",
    ).maybeSingle();
  if (templateError) throw templateError;
  if (!template) return "held_template";
  const { data: existing, error: existingError } = await service.from(
    "portal_notification_outbox",
  )
    .select("state").eq("event_key", eventKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return String(existing.state);
  const { data: outbox, error: outboxError } = await service.from(
    "portal_notification_outbox",
  ).insert({
    event_key: eventKey,
    event_type: templateKey.startsWith("purchase_request_")
      ? "purchase_request"
      : "department_request",
    template_key: templateKey,
    template_version: template.version,
    audience: "internal",
    mandatory: true,
    recipient_email: recipientEmail.toLowerCase(),
    state: "pending",
    channel: "email",
    // Capability URLs are delivery-only values. The durable outbox stores the
    // order context, never a raw passwordless approval token.
    payload: storedVariables,
    updated_at: new Date().toISOString(),
  }).select("*").single();
  if (outboxError) throw outboxError;
  if (!RESEND_API_KEY) {
    await service.from("portal_notification_outbox").update({
      state: "held_provider",
      last_error: "Email provider credentials are not configured.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return "held_provider";
  }
  const { data: claim, error: claimError } = await service.rpc(
    "portal_claim_resend_free_quota",
    {
      p_outbox_id: outbox.id,
    },
  );
  if (claimError) throw claimError;
  if (claim !== "claimed") return String(claim || "held_provider");
  const allowed = Array.isArray(template.allowed_variables)
    ? template.allowed_variables.map(String)
    : [];
  const subject = interpolate(
    String(template.subject_template),
    variables,
    allowed,
  );
  const text = interpolate(String(template.text_template), variables, allowed);
  const html = emailHtml(text) + (variables.approveUrl && variables.rejectUrl
    ? `<div style="font-family:Arial,sans-serif;margin:24px 0"><a href="${clean(variables.approveUrl, 2000)}" style="display:inline-block;background:#1b5c37;color:#fff;text-decoration:none;padding:12px 18px;margin-right:10px;font-weight:700">Approve</a><a href="${clean(variables.rejectUrl, 2000)}" style="display:inline-block;background:#a33116;color:#fff;text-decoration:none;padding:12px 18px;font-weight:700">Reject</a></div>`
    : "");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": String(outbox.id),
    },
    body: JSON.stringify({
      from: PORTAL_EMAIL_FROM,
      to: [recipientEmail],
      subject,
      text,
      html,
      tags: [{ name: "template", value: templateKey }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Row;
  if (!response.ok || !result.id) {
    await service.from("portal_notification_outbox").update({
      state: response.status === 429 ? "held_provider" : "failed",
      last_error: clean(result.message || result.error, 500) ||
        "Email provider rejected the request.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return response.status === 429 ? "held_provider" : "failed";
  }
  await service.from("portal_notification_outbox").update({
    state: "sent",
    provider: "resend",
    provider_message_id: result.id,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
    .eq("id", outbox.id);
  return "sent";
}

async function internalNotificationRecipients(
  departmentKey: string,
  excludeEmail = "",
): Promise<Array<{ email: string; name: string }>> {
  const [configured, administrators, owners] = await Promise.all([
    service.from("portal_department_notification_recipient")
      .select("recipient_email,display_name").eq(
        "department_key",
        departmentKey,
      ).eq("active", true),
    service.from("portal_profile").select("id,full_name").eq("role", "internal")
      .eq("staff_role", "administrator").eq("active", true),
    service.from("portal_profile_department").select("profile_id,member_role")
      .eq("department_key", departmentKey).eq("status", "active")
      .in("member_role", ["department_head", "backup_owner"]),
  ]);
  for (const result of [configured, administrators, owners]) {
    if (result.error) throw result.error;
  }
  const profileIds = new Set<string>();
  for (const row of administrators.data ?? []) profileIds.add(String(row.id));
  for (const row of owners.data ?? []) profileIds.add(String(row.profile_id));
  const profileNames = new Map(
    (administrators.data ?? []).map((
      row,
    ) => [String(row.id), clean(row.full_name, 160)]),
  );
  if (profileIds.size) {
    const { data: profiles, error } = await service.from("portal_profile")
      .select("id,full_name,active")
      .in("id", [...profileIds]);
    if (error) throw error;
    for (const row of profiles ?? []) {
      if (row.active !== false) {
        profileNames.set(String(row.id), clean(row.full_name, 160));
      }
    }
  }
  const recipients = new Map<string, { email: string; name: string }>();
  for (const row of configured.data ?? []) {
    const email = clean(row.recipient_email, 254).toLowerCase();
    if (email && email !== excludeEmail.toLowerCase()) {
      recipients.set(email, {
        email,
        name: clean(row.display_name, 160) || email,
      });
    }
  }
  await Promise.all([...profileIds].map(async (profileId) => {
    const auth = await service.auth.admin.getUserById(profileId);
    const email = clean(auth.data.user?.email, 254).toLowerCase();
    if (email && email !== excludeEmail.toLowerCase()) {
      recipients.set(email, {
        email,
        name: profileNames.get(profileId) || email,
      });
    }
  }));
  return [...recipients.values()];
}

async function notifyTeam(
  departmentKey: string,
  templateKey: string,
  variables: Row,
  eventPrefix: string,
  excludeEmail = "",
): Promise<string[]> {
  const recipients = await internalNotificationRecipients(
    departmentKey,
    excludeEmail,
  );
  return await Promise.all(
    recipients.map((recipient) =>
      sendDepartmentNotification(
        templateKey,
        recipient.email,
        { ...variables, recipientName: recipient.name },
        `${eventPrefix}:${recipient.email}`,
      )
    ),
  );
}

async function notifyPurchaseApprovers(
  approvalTier: string,
  variables: Row,
  eventPrefix: string,
  excludeEmail = "",
): Promise<string[]> {
  if (!PORTAL_NOTIFICATIONS_ENABLED) return ["held_launch"];
  const purchaseRequestId = uuid(variables.purchaseRequestId, "purchase request");
  const { data, error } = await service.from("portal_purchase_approver")
    .select("display_name,approver_email").eq("approval_tier", approvalTier)
    .eq("active", true);
  if (error) throw error;
  const recipients = new Map<string, string>();
  for (const row of data ?? []) {
    const email = clean(row.approver_email, 254).toLowerCase();
    if (email && email !== excludeEmail.toLowerCase()) {
      recipients.set(email, clean(row.display_name, 160) || email);
    }
  }
  await service.from("portal_purchase_approval_link").update({
    revoked_at: new Date().toISOString(),
  }).eq("purchase_request_id", purchaseRequestId).is("consumed_at", null).is(
    "revoked_at",
    null,
  );
  return await Promise.all([...recipients].map(async ([email, name]) => {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...tokenBytes)).replace(/\+/g, "-")
      .replace(/\//g, "_").replace(/=+$/g, "");
    const tokenHash = await sha256Hex(new TextEncoder().encode(token));
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const { error: linkError } = await service.from(
      "portal_purchase_approval_link",
    ).insert({
      purchase_request_id: purchaseRequestId,
      approval_tier: approvalTier,
      approver_name: name,
      approver_email: email,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });
    if (linkError) throw linkError;
    const approveUrl = `${PORTAL_URL}/#purchase-approval=${token}&decision=approved`;
    const rejectUrl = `${PORTAL_URL}/#purchase-approval=${token}&decision=denied`;
    const deliveryVariables = {
      ...variables,
      recipientName: name,
      expiresAt: expiresAt.toLocaleString("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " ET",
      approveUrl,
      rejectUrl,
    };
    const storedVariables = {
      ...variables,
      recipientName: name,
      expiresAt: expiresAt.toISOString(),
      approvalLink: "withheld_from_outbox",
    };
    return await sendDepartmentNotification(
      "purchase_request_approval_required",
      email,
      deliveryVariables,
      `${eventPrefix}:${email}`,
      storedVariables,
    );
  }));
}

async function requesterRecipient(
  profileId: string,
): Promise<{ email: string; name: string } | null> {
  const [{ data: profile }, authResult] = await Promise.all([
    service.from("portal_profile").select("full_name,active").eq(
      "id",
      profileId,
    ).maybeSingle(),
    service.auth.admin.getUserById(profileId),
  ]);
  const email = authResult.data.user?.email;
  return profile?.active !== false && email
    ? { email, name: clean(profile?.full_name, 160) || email }
    : null;
}

function uuid(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(candidate)
  ) {
    throw new InternalWorkError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function isoDate(value: unknown): string | null {
  const candidate = clean(value, 10);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new InternalWorkError(
      400,
      "Enter the expiration date as MM/DD/YYYY.",
    );
  }
  return candidate;
}

async function actorFor(request: Request): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) {
    throw new InternalWorkError(
      403,
      "Sign in with an active workforce account.",
    );
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) {
    throw new InternalWorkError(
      403,
      "Sign in with an active workforce account.",
    );
  }
  const user = await response.json() as Row;
  const { data, error } = await service.from("portal_profile")
    .select("id,full_name,role,staff_role,active").eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (
    !data || data.active === false || data.role !== "internal" ||
    !STAFF_ROLES.has(String(data.staff_role))
  ) {
    throw new InternalWorkError(
      403,
      "This workspace is limited to active workforce accounts.",
    );
  }
  return {
    id: String(data.id),
    email: clean(user.email, 254).toLowerCase(),
    fullName: clean(data.full_name, 160) || clean(user.email, 254),
    staffRole: String(data.staff_role),
    administrator: data.staff_role === "administrator",
  };
}

async function overview(actor: Actor): Promise<Row> {
  const [
    departmentsResult,
    membershipsResult,
    requestsResult,
    departmentRequestsResult,
    purchaseRequestsResult,
    purchaseApproversResult,
    notificationRecipientsResult,
    itemsResult,
    offboardingResult,
    governanceReviewsResult,
    systemsResult,
    emergencyChangesResult,
    supplyItemHistoryResult,
    activeBrandsResult,
  ] = await Promise.all([
    service.from("portal_department").select(
      "department_key,display_name,status,platform_owner,business_owner,backup_owner,sensitive_tier",
    ).order("display_name"),
    service.from("portal_profile_department").select(
      "department_key,member_role,status,assigned_at",
    ).eq("profile_id", actor.id).eq("status", "active"),
    actor.administrator
      ? service.from("portal_access_request").select(
        "*,portal_access_request_decision(id,decision,actor_email,note,created_at)",
      ).order("created_at", { ascending: false }).limit(250)
      : service.from("portal_access_request").select(
        "*,portal_access_request_decision(id,decision,actor_email,note,created_at)",
      ).eq("requester_id", actor.id).order("created_at", { ascending: false })
        .limit(100),
    actor.administrator
      ? service.from("portal_department_request").select("*").order(
        "created_at",
        { ascending: false },
      ).limit(250)
      : service.from("portal_department_request").select("*").eq(
        "requester_id",
        actor.id,
      ).order("created_at", { ascending: false }).limit(100),
    service.from("portal_purchase_request").select(
      "*,brand:portal_organization!brand_organization_id(id,display_name),portal_purchase_request_line(*),portal_purchase_request_decision(*)",
    ).order("created_at", { ascending: false }).limit(250),
    service.from("portal_purchase_approver").select(
      "id,approval_tier,display_name,approver_email,is_backup,active",
    ).eq("active", true).order("approval_tier").order("display_name"),
    actor.administrator
      ? service.from("portal_department_notification_recipient").select("*").eq(
        "active",
        true,
      ).order("department_key").order("recipient_type").order("display_name")
      : Promise.resolve({ data: [], error: null }),
    actor.administrator
      ? service.from("portal_work_item").select(
        "id,reference,workflow_key,target_type,target_id,title,summary,status,priority,assigned_department,assigned_user,due_at,version,metadata,created_at,updated_at,completed_at",
      ).or(`assigned_user.eq.${actor.id},workflow_key.eq.access_requests`).not(
        "status",
        "in",
        "(completed,cancelled)",
      ).order("priority").order("created_at").limit(250)
      : service.from("portal_work_item").select(
        "id,reference,workflow_key,target_type,target_id,title,summary,status,priority,assigned_department,assigned_user,due_at,version,metadata,created_at,updated_at,completed_at",
      ).or(`assigned_user.eq.${actor.id},created_by.eq.${actor.id}`).not(
        "status",
        "in",
        "(completed,cancelled)",
      ).order("priority").order("created_at").limit(100),
    actor.administrator
      ? service.from("portal_offboarding_case")
        .select("*,portal_offboarding_checklist(*)")
        .order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [], error: null }),
    actor.administrator
      ? service.from("portal_governance_review").select("*")
        .order("due_on", { ascending: true }).limit(100)
      : Promise.resolve({ data: [], error: null }),
    actor.administrator
      ? service.from("portal_it_system").select("*")
        .order("display_name", { ascending: true }).limit(100)
      : Promise.resolve({ data: [], error: null }),
    actor.administrator
      ? service.from("portal_emergency_change").select("*")
        .order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [], error: null }),
    service.from("portal_supply_item_history").select("*").eq("active", true)
      .order("last_ordered_at", { ascending: false }).limit(100),
    service.from("portal_organization").select(
      "id,display_name,legal_name,status,portal_brand_profile_detail!inner(activation_state)",
    ).eq("kind", "brand").eq("status", "active")
      .eq("portal_brand_profile_detail.activation_state", "active")
      .order("display_name"),
  ]);
  for (
    const result of [
      departmentsResult,
      membershipsResult,
      requestsResult,
      departmentRequestsResult,
      purchaseRequestsResult,
      purchaseApproversResult,
      notificationRecipientsResult,
      itemsResult,
      offboardingResult,
      governanceReviewsResult,
      systemsResult,
      emergencyChangesResult,
      supplyItemHistoryResult,
      activeBrandsResult,
    ]
  ) {
    if (result.error) throw result.error;
  }

  let profiles: Row[] = [];
  if (actor.administrator) {
    const result = await service.from("portal_profile")
      .select("id,full_name,staff_role,active").eq("role", "internal")
      .eq("active", true).order("full_name").limit(500);
    if (result.error) throw result.error;
    profiles = result.data ?? [];
  }

  let supplyOrderCatalog: Row[] = [];
  let supplyOrderCatalogState = "live";
  try {
    supplyOrderCatalog = await supplyOrderBoardCatalog();
    if (!supplyOrderCatalog.length) supplyOrderCatalogState = "unavailable";
  } catch (error) {
    console.error("supply-order-catalog", error);
    supplyOrderCatalogState = "unavailable";
  }

  const actorPurchaseApprovalTiers = (purchaseApproversResult.data ?? []).filter(
    (approver) => String(approver.approver_email).toLowerCase() === actor.email,
  ).map((approver) => String(approver.approval_tier));
  const purchaseRequests = ((purchaseRequestsResult.data ?? []) as Row[]).filter(
    (request) =>
      actor.administrator || actor.email === SUPPLY_ORDER_AGENT_EMAIL ||
      String(request.requester_id) === actor.id ||
      actorPurchaseApprovalTiers.includes(String(request.approval_tier)),
  ).filter((request) => !isSupplyOrderSetupTest(request));
  let purchaseEvidence: Row[] = [];
  if (purchaseRequests.length) {
    const requestIds = purchaseRequests.map((request) => String(request.id));
    const workItems = await service.from("portal_work_item").select(
      "id,target_id,portal_work_item_evidence(id,evidence_type,original_name,content_type,size_bytes,scan_state,created_by_email,created_at)",
    ).eq("workflow_key", "finance_purchase_requests").eq(
      "target_type",
      "purchase_request",
    ).in("target_id", requestIds);
    if (workItems.error) throw workItems.error;
    purchaseEvidence = (workItems.data ?? []) as Row[];
  }

  return {
    actor: {
      id: actor.id,
      fullName: actor.fullName,
      staffRole: actor.staffRole,
      administrator: actor.administrator,
    },
    departments: departmentsResult.data ?? [],
    memberships: membershipsResult.data ?? [],
    requests: requestsResult.data ?? [],
    departmentRequests: departmentRequestsResult.data ?? [],
    purchaseRequests: purchaseRequests.map((request) => {
      const workItem = purchaseEvidence.find((item) =>
        String(item.target_id) === String(request.id)
      );
      return {
        ...request,
        evidence: workItem?.portal_work_item_evidence ?? [],
      };
    }),
    purchaseApprovers: purchaseApproversResult.data ?? [],
    actorPurchaseApprovalTiers,
    canPlaceSupplyOrders: actor.administrator || actor.email === SUPPLY_ORDER_AGENT_EMAIL,
    supplyItemHistory: supplyItemHistoryResult.data ?? [],
    supplyOrderCatalog,
    supplyOrderCatalogState,
    activeBrands: ((activeBrandsResult.data ?? []) as Row[]).map((brand) => ({
      id: brand.id,
      displayName: brand.display_name,
      legalName: brand.legal_name,
    })),
    supplyOrderReport: {
      totalRequests: purchaseRequests.length,
      awaitingApproval: purchaseRequests.filter((row) =>
        ["submitted", "under_review", "returned"].includes(String(row.status))
      ).length,
      awaitingOrder: purchaseRequests.filter((row) =>
        String(row.status) === "awaiting_order"
      ).length,
      ordered: purchaseRequests.filter((row) =>
        ["ordered", "partially_received", "received", "completed"].includes(String(row.status))
      ).length,
      orderedValue: purchaseRequests.filter((row) =>
        ["ordered", "partially_received", "received", "completed"].includes(String(row.status))
      ).reduce((sum, row) => sum + Number(row.actual_order_total || row.amount || 0), 0),
    },
    notificationRecipients: notificationRecipientsResult.data ?? [],
    items: itemsResult.data ?? [],
    offboardingCases: offboardingResult.data ?? [],
    governanceReviews: governanceReviewsResult.data ?? [],
    systems: systemsResult.data ?? [],
    emergencyChanges: emergencyChangesResult.data ?? [],
    profiles,
    controls: {
      approvalOwner: "Administrator",
      selfApprovalBlocked: true,
      crossSystemDeactivation: "held",
      hrRestrictedWorkflows: "held",
      automaticAccessReviews: "held",
    },
  };
}

async function createDepartmentRequest(actor: Actor, body: Row): Promise<Row> {
  const departmentKey = clean(body.departmentKey, 40);
  const requestType = clean(body.requestType, 50);
  const title = clean(body.title, 200);
  const details = clean(body.details, 4000);
  const priority = clean(body.priority, 2).toUpperCase();
  if (
    !/^[a-z0-9_]{2,40}$/.test(departmentKey) ||
    !/^[a-z0-9_]{2,50}$/.test(requestType) ||
    title.length < 5 || details.length < 12 ||
    !new Set(["P0", "P1", "P2", "P3"]).has(priority)
  ) {
    throw new InternalWorkError(
      400,
      "Complete the department, request type, title, details, and priority.",
    );
  }
  const { data, error } = await service.rpc(
    "portal_submit_department_request",
    {
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_department_key: departmentKey,
      p_request_type: requestType,
      p_title: title,
      p_details: details,
      p_priority: priority,
    },
  );
  if (error) throw error;
  let notificationState = "not_attempted";
  try {
    notificationState = await sendDepartmentNotification(
      "department_request_received",
      actor.email,
      {
        recipientName: actor.fullName,
        requestReference: data.reference,
        requestTitle: data.title,
        departmentName: data.assigned_department,
        priority: data.priority,
      },
      `department-request-received:${data.id}:${data.version}`,
    );
    await notifyTeam(
      departmentKey,
      "department_request_routed",
      {
        requestReference: data.reference,
        requestTitle: data.title,
        departmentName: data.assigned_department,
        priority: data.priority,
      },
      `department-request-routed:${data.id}:${data.version}`,
      actor.email,
    );
  } catch (error) {
    console.error("department-request-notification", error);
    notificationState = "failed";
  }
  return { request: data, notificationState };
}

async function decideDepartmentRequest(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to review department requests.",
    );
  }
  const requestId = uuid(body.requestId, "department request");
  const expectedVersion = Number(body.expectedVersion);
  const decision = clean(body.decision, 30);
  const note = clean(body.note, 4000);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(
      400,
      "Refresh the request before reviewing it.",
    );
  }
  if (
    !new Set(["under_review", "returned", "approved", "denied", "completed"])
      .has(decision)
  ) {
    throw new InternalWorkError(
      400,
      "Choose a valid department request decision.",
    );
  }
  if (
    ["returned", "approved", "denied", "completed"].includes(decision) &&
    note.length < 8
  ) {
    throw new InternalWorkError(
      400,
      "Add decision evidence before saving this decision.",
    );
  }
  const { data, error } = await service.rpc(
    "portal_decide_department_request",
    {
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_request_id: requestId,
      p_expected_version: expectedVersion,
      p_decision: decision,
      p_note: note,
    },
  );
  if (error) {
    if (String(error.message || "").includes("own department request")) {
      throw new InternalWorkError(
        403,
        "A different Administrator must approve your request.",
      );
    }
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This request changed. Refresh before reviewing it.",
      );
    }
    throw error;
  }
  let notificationState = "not_attempted";
  try {
    const recipient = await requesterRecipient(String(data.requester_id));
    notificationState = recipient
      ? await sendDepartmentNotification(
        "department_request_updated",
        recipient.email,
        {
          recipientName: recipient.name,
          requestReference: data.reference,
          requestTitle: data.title,
          requestStatus: String(data.status).replace(/_/g, " "),
          decisionNote: data.decision_note || "No additional note.",
        },
        `department-request-updated:${data.id}:${data.version}:${data.status}`,
      )
      : "held_recipient";
    await notifyTeam(
      String(data.department_key),
      "department_request_team_updated",
      {
        requestReference: data.reference,
        requestTitle: data.title,
        requestStatus: String(data.status).replace(/_/g, " "),
        decisionNote: data.decision_note || "No additional note.",
      },
      `department-request-team-updated:${data.id}:${data.version}:${data.status}`,
      recipient?.email || "",
    );
  } catch (error) {
    console.error("department-request-notification", error);
    notificationState = "failed";
  }
  return { request: data, notificationState };
}

async function createPurchaseRequest(actor: Actor, body: Row): Promise<Row> {
  const departmentKey = clean(body.departmentKey, 40);
  const brandOrganizationId = clean(body.brandOrganizationId, 36);
  const vendorName = clean(body.vendorName, 200);
  const purpose = clean(body.purpose, 4000);
  const priority = clean(body.priority || "normal", 20);
  const neededBy = isoDate(body.neededBy);
  const paymentMethod = clean(body.paymentMethod, 100);
  const recipientName = clean(body.recipientName, 160);
  const deliveryLocation = SUPPLY_ORDER_DESTINATION;
  const estimatedShipping = Number(body.estimatedShipping || 0);
  const estimatedTax = Number(body.estimatedTax || 0);
  const estimatedDiscount = Number(body.estimatedDiscount || 0);
  const recurringPurchase = body.recurringPurchase === true;
  const lines = Array.isArray(body.lines) ? body.lines as Row[] : [];
  const categories = new Set([
    "supplies",
    "services",
    "inventory",
    "equipment",
    "travel",
    "other",
  ]);
  if (
    !/^[a-z0-9_]{2,40}$/.test(departmentKey) || vendorName.length < 2 ||
    purpose.length < 5 || recipientName.length < 2 ||
    !Number.isFinite(estimatedShipping) || estimatedShipping < 0 ||
    !Number.isFinite(estimatedTax) || estimatedTax < 0 ||
    !Number.isFinite(estimatedDiscount) || estimatedDiscount < 0 ||
    !new Set(["low", "normal", "high", "urgent"])
      .has(priority) || lines.length < 1 || lines.length > 50
  ) {
    throw new InternalWorkError(
      400,
      "Complete the department, vendor, business purpose, and at least one item.",
    );
  }
  const supplyDepartments = new Set([
    "maintenance", "administration", "compliance", "distribution",
    "human_resources", "grow", "marketing", "process", "develop", "brand",
  ]);
  if (!supplyDepartments.has(departmentKey)) {
    throw new InternalWorkError(400, "Choose an approved Supply Order department.");
  }
  if (departmentKey === "brand") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(brandOrganizationId)) {
      throw new InternalWorkError(400, "Choose an active Brand for this Supply Order.");
    }
    const brandResult = await service.from("portal_organization").select(
      "id,portal_brand_profile_detail!inner(activation_state)",
    ).eq("id", brandOrganizationId).eq("kind", "brand").eq("status", "active")
      .eq("portal_brand_profile_detail.activation_state", "active").maybeSingle();
    if (brandResult.error) throw brandResult.error;
    if (!brandResult.data) {
      throw new InternalWorkError(400, "The selected Brand is not active.");
    }
  } else if (brandOrganizationId) {
    throw new InternalWorkError(400, "A Brand may only be assigned to the Brand department.");
  }
  const normalizedLines = lines.map((line, index) => {
    const itemDescription = clean(line.itemDescription, 500);
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unitCost);
    const expenseCategory = clean(line.expenseCategory, 30);
    const purchaseUrl = clean(line.purchaseUrl, 1200);
    const imageUrl = clean(line.imageUrl, 1200);
    const substitutionPolicy = clean(line.substitutionPolicy || "contact_requester", 80);
    if (
      itemDescription.length < 2 || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(unitCost) || unitCost < 0 ||
      !categories.has(expenseCategory) ||
      !new Set(["no_substitutions", "comparable_within_approved_total", "contact_requester"]).has(substitutionPolicy) ||
      (purchaseUrl && !/^https:\/\//i.test(purchaseUrl)) ||
      (imageUrl && !/^https:\/\//i.test(imageUrl))
    ) {
      throw new InternalWorkError(
        400,
        `Complete item ${index + 1} with a description, quantity, unit cost, category, and an HTTPS link when supplied.`,
      );
    }
    return {
      itemDescription,
      sku: clean(line.sku, 160),
      purchaseUrl,
      imageUrl,
      selectedOptions: clean(line.selectedOptions, 500),
      substitutionPolicy,
      quantity,
      unitCost,
      expenseCategory,
      expenseSubcategory: null,
      chartOfAccounts: null,
      requiredDeliveryOn: null,
    };
  });
  const merchandiseSubtotal = normalizedLines.reduce(
    (total, line) => total + Math.round(line.quantity * line.unitCost * 100) / 100,
    0,
  );
  const amount = Math.round((merchandiseSubtotal + estimatedShipping + estimatedTax - estimatedDiscount) * 100) / 100;
  let route;
  try {
    route = purchaseApprovalRoute(amount);
  } catch {
    throw new InternalWorkError(
      400,
      "Enter a purchase amount greater than zero.",
    );
  }
  const { data, error } = await service.rpc("portal_submit_purchase_request_v4", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_department_key: departmentKey,
    p_brand_organization_id: departmentKey === "brand" ? brandOrganizationId : null,
    p_vendor_name: vendorName,
    p_purpose: purpose,
    p_priority: priority,
    p_needed_by: neededBy,
    p_delivery_start_on: null,
    p_delivery_end_on: null,
    p_recurring_purchase: recurringPurchase,
    p_payment_method: paymentMethod,
    p_recipient_name: recipientName,
    p_delivery_location: deliveryLocation,
    p_estimated_shipping: estimatedShipping,
    p_estimated_tax: estimatedTax,
    p_estimated_discount: estimatedDiscount,
    p_lines: normalizedLines,
  });
  if (error) throw error;
  const amountLabel = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
  const money = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
  const departmentNames: Record<string, string> = {
    maintenance: "Maintenance",
    administration: "Administration",
    compliance: "Compliance",
    distribution: "Distribution",
    human_resources: "Human Resources",
    grow: "Grow",
    marketing: "Marketing",
    process: "Process",
    develop: "Develop",
    brand: "Brand",
  };
  let brandName = "Not applicable";
  if (brandOrganizationId) {
    const { data: brand } = await service.from("portal_organization")
      .select("display_name").eq("id", brandOrganizationId).maybeSingle();
    brandName = clean(brand?.display_name, 200) || "Brand assignment pending";
  }
  const approvalVariables: Row = {
    purchaseRequestId: data.id,
    requestReference: data.reference,
    requesterName: actor.fullName,
    requesterEmail: actor.email,
    departmentName: departmentNames[departmentKey] || departmentKey,
    brandName,
    vendorName: data.vendor_name,
    purpose: data.purpose,
    priority: String(data.priority || priority).toUpperCase(),
    neededBy: data.needed_by
      ? new Date(`${data.needed_by}T12:00:00Z`).toLocaleDateString("en-US")
      : "No required date",
    lineItems: normalizedLines.map((line, index) =>
      `${index + 1}. ${line.itemDescription} — ${line.quantity} × ${money(line.unitCost)} = ${money(line.quantity * line.unitCost)}`
    ).join("\n"),
    merchandiseSubtotal: money(merchandiseSubtotal),
    shipping: money(estimatedShipping),
    tax: money(estimatedTax),
    discount: money(estimatedDiscount),
    amount: amountLabel,
    deliveryRecipient: recipientName,
    deliveryLocation,
    approvalAuthority: route.authority,
  };
  let notificationState = "not_attempted";
  try {
    notificationState = await sendDepartmentNotification(
      "purchase_request_received",
      actor.email,
      {
        recipientName: actor.fullName,
        requestReference: data.reference,
        vendorName: data.vendor_name,
        amount: amountLabel,
        approvalAuthority: route.authority,
      },
      `purchase-request-received:${data.id}:${data.version}`,
    );
    await notifyPurchaseApprovers(
      route.tier,
      approvalVariables,
      `purchase-request-business-approval:${data.id}:${data.version}`,
      actor.email,
    );
  } catch (error) {
    console.error("purchase-request-notification", error);
    notificationState = "failed";
  }
  return { request: data, notificationState };
}

async function decidePurchaseBusinessApproval(
  actor: Actor,
  body: Row,
): Promise<Row> {
  const requestId = uuid(body.requestId, "purchase request");
  const expectedVersion = Number(body.expectedVersion);
  const decision = clean(body.decision, 30);
  const note = clean(body.note, 4000);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(400, "Refresh the request before reviewing it.");
  }
  if (!new Set(["approved", "returned", "denied"]).has(decision) || note.length < 8) {
    throw new InternalWorkError(400, "Choose a business decision and add evidence.");
  }
  const { data, error } = await service.rpc(
    "portal_record_purchase_business_decision",
    {
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_request_id: requestId,
      p_expected_version: expectedVersion,
      p_decision: decision,
      p_note: note,
    },
  );
  if (error) {
    const message = String(error.message || "");
    if (message.includes("own purchase request")) {
      throw new InternalWorkError(403, "You cannot approve your own purchase request.");
    }
    if (message.includes("not an assigned business approver")) {
      throw new InternalWorkError(403, "You are not assigned to this approval tier.");
    }
    if (message.includes("changed")) {
      throw new InternalWorkError(409, "This request changed. Refresh before reviewing it.");
    }
    throw error;
  }
  const recipient = await requesterRecipient(String(data.requester_id));
  if (recipient) {
    await sendDepartmentNotification(
      "purchase_request_updated",
      recipient.email,
      {
        recipientName: recipient.name,
        requestReference: data.reference,
        vendorName: data.vendor_name,
        requestStatus: `business ${decision}`,
        decisionNote: data.business_approval_note,
      },
      `purchase-request-business-updated:${data.id}:${data.version}:${decision}`,
    );
  }
  if (decision === "approved") {
    await sendDepartmentNotification(
      "purchase_request_ready_to_order",
      SUPPLY_ORDER_AGENT_EMAIL,
      {
        recipientName: "Amrit",
        requestReference: data.reference,
        vendorName: data.vendor_name,
        amount: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
          .format(Number(data.amount || 0)),
      },
      `purchase-request-ready-to-order:${data.id}:${data.version}`,
    );
  }
  return { request: data };
}

async function markSupplyOrderOrdered(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator && actor.email !== SUPPLY_ORDER_AGENT_EMAIL) {
    throw new InternalWorkError(403, "Amrit or an Administrator must record ordering.");
  }
  const requestId = uuid(body.requestId, "supply order");
  const expectedVersion = Number(body.expectedVersion);
  const actualTotal = Number(body.actualTotal);
  const vendorOrderNumber = clean(body.vendorOrderNumber, 200);
  const expectedDeliveryOn = isoDate(body.expectedDeliveryOn);
  const note = clean(body.note, 4000);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 ||
    !Number.isFinite(actualTotal) || actualTotal <= 0 || vendorOrderNumber.length < 2 ||
    !expectedDeliveryOn || note.length < 8) {
    throw new InternalWorkError(
      400,
      "Enter the checkout total, vendor order number, expected delivery date, and ordering evidence.",
    );
  }
  const { data, error } = await service.rpc("portal_mark_supply_order_ordered", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_actual_total: actualTotal,
    p_vendor_order_number: vendorOrderNumber,
    p_expected_delivery_on: expectedDeliveryOn,
    p_note: note,
  });
  if (error) {
    const message = String(error.message || "");
    if (message.includes("changed")) {
      throw new InternalWorkError(409, "This supply order changed. Refresh before recording it.");
    }
    throw error;
  }
  const recipient = await requesterRecipient(String(data.requester_id));
  const money = (value: unknown) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value || 0));
  if (String(data.status) === "ordered" && recipient) {
    await sendDepartmentNotification(
      "purchase_request_ordered",
      recipient.email,
      {
        recipientName: recipient.name,
        requestReference: data.reference,
        vendorName: data.vendor_name,
        vendorOrderNumber: data.vendor_order_number,
        actualTotal: money(data.actual_order_total),
        expectedDelivery: data.expected_delivery_on || "Pending",
      },
      `purchase-request-ordered:${data.id}:${data.version}`,
    );
  } else if (String(data.status) === "returned" && recipient) {
    await sendDepartmentNotification(
      "purchase_request_reapproval_required",
      recipient.email,
      {
        recipientName: recipient.name,
        requestReference: data.reference,
        approvedTotal: money(data.amount),
        actualTotal: money(data.actual_order_total),
      },
      `purchase-request-reapproval:${data.id}:${data.version}`,
    );
  }
  return { request: data };
}

async function decidePurchaseRequest(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to review purchase requests.",
    );
  }
  const requestId = uuid(body.requestId, "purchase request");
  const expectedVersion = Number(body.expectedVersion);
  const decision = clean(body.decision, 30);
  const note = clean(body.note, 4000);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(
      400,
      "Refresh the request before reviewing it.",
    );
  }
  if (
    !new Set(["under_review", "returned", "approved", "denied", "completed"])
      .has(decision)
  ) {
    throw new InternalWorkError(
      400,
      "Choose a valid purchase request decision.",
    );
  }
  if (
    ["returned", "approved", "denied", "completed"].includes(decision) &&
    note.length < 8
  ) {
    throw new InternalWorkError(
      400,
      "Add decision evidence before saving this decision.",
    );
  }
  const { data, error } = await service.rpc("portal_decide_purchase_request", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_note: note,
  });
  if (error) {
    if (String(error.message || "").includes("own purchase request")) {
      throw new InternalWorkError(
        403,
        "A different Administrator must approve your request.",
      );
    }
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This request changed. Refresh before reviewing it.",
      );
    }
    throw error;
  }
  let notificationState = "not_attempted";
  try {
    const recipient = await requesterRecipient(String(data.requester_id));
    notificationState = recipient
      ? await sendDepartmentNotification(
        "purchase_request_updated",
        recipient.email,
        {
          recipientName: recipient.name,
          requestReference: data.reference,
          vendorName: data.vendor_name,
          requestStatus: String(data.status).replace(/_/g, " "),
          decisionNote: data.decision_note || "No additional note.",
        },
        `purchase-request-updated:${data.id}:${data.version}:${data.status}`,
      )
      : "held_recipient";
  } catch (error) {
    console.error("purchase-request-notification", error);
    notificationState = "failed";
  }
  return { request: data, notificationState };
}

function decodePurchaseDocument(file: Row): {
  bytes: Uint8Array;
  name: string;
  contentType: string;
} {
  const contentType = clean(file.contentType, 120).toLowerCase();
  const allowed = ["application/pdf", "image/png", "image/jpeg"];
  const encoded = clean(file.base64, 15_000_000).replace(/\s/g, "");
  if (!allowed.includes(contentType) || !encoded) {
    throw new InternalWorkError(400, "Use a PDF, PNG, or JPEG that is 10 MB or smaller.");
  }
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new InternalWorkError(400, "The supporting document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    !Number(file.sizeBytes) || bytes.byteLength !== Number(file.sizeBytes) ||
    bytes.byteLength > 10 * 1024 * 1024
  ) throw new InternalWorkError(400, "Supporting documents must be 10 MB or smaller.");
  const signatureMatches = contentType === "application/pdf"
    ? bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
    : contentType === "image/png"
    ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!signatureMatches) {
    throw new InternalWorkError(400, "The file contents do not match the declared type.");
  }
  return { bytes, name: clean(file.name, 240) || "supporting-document", contentType };
}

async function purchaseRequestAccess(
  actor: Actor,
  requestId: string,
): Promise<{ request: Row; workItem: Row }> {
  const { data: request, error } = await service.from("portal_purchase_request")
    .select("id,requester_id,approval_tier,reference").eq("id", requestId).maybeSingle();
  if (error) throw error;
  if (!request) throw new InternalWorkError(404, "Purchase request not found.");
  let allowed = actor.administrator || String(request.requester_id) === actor.id;
  if (!allowed) {
    const assignment = await service.from("portal_purchase_approver").select("id")
      .eq("approval_tier", request.approval_tier).eq("approver_email", actor.email)
      .eq("active", true).maybeSingle();
    if (assignment.error) throw assignment.error;
    allowed = !!assignment.data;
  }
  if (!allowed) throw new InternalWorkError(403, "This purchase request is outside your scope.");
  const { data: workItem, error: workError } = await service.from("portal_work_item")
    .select("id").eq("workflow_key", "finance_purchase_requests")
    .eq("target_type", "purchase_request").eq("target_id", requestId).maybeSingle();
  if (workError) throw workError;
  if (!workItem) throw new InternalWorkError(409, "The purchase work item is not ready.");
  return { request, workItem };
}

async function uploadPurchaseDocument(actor: Actor, body: Row): Promise<Row> {
  const requestId = uuid(body.requestId, "purchase request");
  const documentType = clean(body.documentType || "supporting_document", 100);
  if (!new Set(["quote", "receipt", "invoice", "contract", "justification", "supporting_document", "other"]).has(documentType)) {
    throw new InternalWorkError(400, "Choose a valid supporting document type.");
  }
  const file = body.file && typeof body.file === "object" && !Array.isArray(body.file)
    ? body.file as Row
    : {};
  const decoded = decodePurchaseDocument(file);
  const digest = await sha256Hex(decoded.bytes);
  try {
    await scanContent(decoded.bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError) throw new InternalWorkError(422, error.message);
    throw error;
  }
  const { request, workItem } = await purchaseRequestAccess(actor, requestId);
  const extension = decoded.contentType === "application/pdf"
    ? "pdf"
    : decoded.contentType === "image/png"
    ? "png"
    : "jpg";
  const objectPath = `${workItem.id}/${crypto.randomUUID()}-${digest.slice(0, 16)}.${extension}`;
  const { error: uploadError } = await service.storage.from("portal-work-evidence")
    .upload(objectPath, decoded.bytes, { contentType: decoded.contentType, upsert: false });
  if (uploadError) throw uploadError;
  const { data, error } = await service.from("portal_work_item_evidence").insert({
    work_item_id: workItem.id,
    evidence_type: `purchase_${documentType}`,
    object_path: objectPath,
    original_name: decoded.name,
    content_type: decoded.contentType,
    size_bytes: decoded.bytes.byteLength,
    scan_state: "clean",
    created_by: actor.id,
    created_by_email: actor.email,
  }).select("id,evidence_type,original_name,content_type,size_bytes,scan_state,created_by_email,created_at").single();
  if (error) {
    await service.storage.from("portal-work-evidence").remove([objectPath]);
    throw error;
  }
  await service.from("portal_work_item_event").insert({
    work_item_id: workItem.id,
    action: "purchase_document_added",
    actor_id: actor.id,
    actor_email: actor.email,
    detail: { requestId, reference: request.reference, evidenceId: data.id, documentType, sha256: digest },
  });
  return { evidence: data };
}

async function downloadPurchaseDocument(actor: Actor, body: Row): Promise<Row> {
  const requestId = uuid(body.requestId, "purchase request");
  const evidenceId = uuid(body.evidenceId, "supporting document");
  const { workItem } = await purchaseRequestAccess(actor, requestId);
  const { data, error } = await service.from("portal_work_item_evidence")
    .select("id,object_path,original_name,scan_state").eq("id", evidenceId)
    .eq("work_item_id", workItem.id).maybeSingle();
  if (error) throw error;
  if (!data || data.scan_state !== "clean") {
    throw new InternalWorkError(404, "A clean supporting document was not found.");
  }
  const { data: signed, error: signedError } = await service.storage
    .from("portal-work-evidence").createSignedUrl(String(data.object_path), 300, {
      download: String(data.original_name),
    });
  if (signedError || !signed?.signedUrl) throw signedError ?? new Error("Signed URL unavailable");
  return { url: signed.signedUrl, expiresIn: 300 };
}

async function saveNotificationRecipient(
  actor: Actor,
  body: Row,
): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to manage notification routing.",
    );
  }
  const departmentKey = clean(body.departmentKey, 40);
  const recipientType = clean(body.recipientType, 20);
  const displayName = clean(body.displayName, 160);
  const recipientEmail = clean(body.recipientEmail, 254).toLowerCase();
  if (
    !/^[a-z0-9_]{2,40}$/.test(departmentKey) ||
    !new Set(["owner", "inbox"]).has(recipientType) ||
    displayName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)
  ) {
    throw new InternalWorkError(
      400,
      "Choose a department and enter a valid owner or inbox recipient.",
    );
  }
  const { data, error } = await service.from(
    "portal_department_notification_recipient",
  ).upsert({
    department_key: departmentKey,
    recipient_type: recipientType,
    display_name: displayName,
    recipient_email: recipientEmail,
    active: true,
    created_by: actor.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "department_key,recipient_type,recipient_email" }).select(
    "*",
  ).single();
  if (error) throw error;
  await service.from("portal_admin_audit").insert({
    actor_id: actor.id,
    action: "department_notification_recipient_saved",
    target_id: data.id,
    detail: {
      departmentKey,
      recipientType,
      displayName,
      recipientEmail,
      actorEmail: actor.email,
    },
  });
  return { recipient: data };
}

async function deactivateNotificationRecipient(
  actor: Actor,
  body: Row,
): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to manage notification routing.",
    );
  }
  const id = uuid(body.recipientId, "notification recipient");
  const { data, error } = await service.from(
    "portal_department_notification_recipient",
  )
    .update({ active: false, updated_at: new Date().toISOString() }).eq(
      "id",
      id,
    ).select("*").single();
  if (error) throw error;
  await service.from("portal_admin_audit").insert({
    actor_id: actor.id,
    action: "department_notification_recipient_deactivated",
    target_id: data.id,
    detail: {
      departmentKey: data.department_key,
      recipientEmail: data.recipient_email,
      actorEmail: actor.email,
    },
  });
  return { recipient: data };
}

async function createEmergencyChange(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to record emergency changes.",
    );
  }
  const systemKey = clean(body.systemKey, 60);
  const title = clean(body.title, 200);
  const summary = clean(body.summary, 4000);
  const emergencyReason = clean(body.emergencyReason, 2000);
  const riskLevel = clean(body.riskLevel, 20);
  if (
    !/^[a-z0-9_]{2,60}$/.test(systemKey) || title.length < 5 ||
    summary.length < 12 || emergencyReason.length < 12
  ) {
    throw new InternalWorkError(
      400,
      "Complete the system, title, summary, and emergency reason.",
    );
  }
  const { data, error } = await service.rpc("portal_create_emergency_change", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_system_key: systemKey,
    p_title: title,
    p_summary: summary,
    p_emergency_reason: emergencyReason,
    p_risk_level: riskLevel,
  });
  if (error) throw error;
  return { change: data };
}

async function decideEmergencyChange(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to review emergency changes.",
    );
  }
  const changeId = uuid(body.changeId, "emergency change");
  const expectedVersion = Number(body.expectedVersion);
  const decision = clean(body.decision, 20);
  const reviewNote = clean(body.reviewNote, 4000);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(400, "Refresh the change before reviewing it.");
  }
  if (
    !new Set(["approved", "returned"]).has(decision) || reviewNote.length < 8
  ) {
    throw new InternalWorkError(
      400,
      "Choose a decision and add retrospective evidence.",
    );
  }
  const { data, error } = await service.rpc("portal_decide_emergency_change", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_change_id: changeId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_review_note: reviewNote,
  });
  if (error) {
    if (String(error.message || "").includes("own retrospective")) {
      throw new InternalWorkError(
        403,
        "A different Administrator must review this change.",
      );
    }
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This change changed. Refresh before reviewing it.",
      );
    }
    throw error;
  }
  return { change: data };
}

async function updateGovernanceReview(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to update access reviews.",
    );
  }
  const reviewId = uuid(body.reviewId, "governance review");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(400, "Refresh the review before updating it.");
  }
  const status = clean(body.status, 40);
  if (
    !new Set(["scheduled", "in_progress", "completed", "cancelled"]).has(status)
  ) {
    throw new InternalWorkError(400, "Choose a valid review status.");
  }
  const dueOn = isoDate(body.dueOn);
  if (!dueOn) throw new InternalWorkError(400, "Enter a review due date.");
  const evidenceNote = clean(body.evidenceNote, 4000);
  if (status === "completed" && evidenceNote.length < 8) {
    throw new InternalWorkError(
      400,
      "Add review evidence before completing this review.",
    );
  }
  const { data, error } = await service.rpc("portal_update_governance_review", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_review_id: reviewId,
    p_expected_version: expectedVersion,
    p_status: status,
    p_due_on: dueOn,
    p_evidence_note: evidenceNote,
  });
  if (error) {
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This review changed. Refresh before saving.",
      );
    }
    throw error;
  }
  return { review: data };
}

async function updateItSystem(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to verify systems.",
    );
  }
  const systemKey = clean(body.systemKey, 60);
  if (!/^[a-z0-9_]{2,60}$/.test(systemKey)) {
    throw new InternalWorkError(400, "Choose a valid system.");
  }
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(
      400,
      "Refresh the system register before updating it.",
    );
  }
  const connectionState = clean(body.connectionState, 40);
  const healthState = clean(body.healthState, 40);
  const freshness = clean(body.freshness, 40);
  const nextReviewOn = isoDate(body.nextReviewOn);
  const evidenceNote = clean(body.evidenceNote, 4000);
  if (evidenceNote.length < 8) {
    throw new InternalWorkError(
      400,
      "Add verification evidence before saving the system.",
    );
  }
  const { data, error } = await service.rpc("portal_update_it_system", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_system_key: systemKey,
    p_expected_version: expectedVersion,
    p_connection_state: connectionState,
    p_health_state: healthState,
    p_freshness: freshness,
    p_next_review_on: nextReviewOn,
    p_evidence_note: evidenceNote,
  });
  if (error) {
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This system record changed. Refresh before saving.",
      );
    }
    throw error;
  }
  return { system: data };
}

async function startOffboarding(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to start offboarding.",
    );
  }
  const targetProfileId = uuid(body.targetProfileId, "workforce user");
  if (targetProfileId === actor.id) {
    throw new InternalWorkError(409, "You cannot offboard your own account.");
  }
  const reason = clean(body.reason, 4000);
  if (reason.length < 12) {
    throw new InternalWorkError(
      400,
      "Explain the business reason for offboarding.",
    );
  }
  const { data: target, error: targetError } = await service.from(
    "portal_profile",
  )
    .select("id,full_name,role,active").eq("id", targetProfileId)
    .eq("role", "internal").eq("active", true).maybeSingle();
  if (targetError) throw targetError;
  if (!target) {
    throw new InternalWorkError(404, "Active workforce user not found.");
  }

  const { data: authData, error: authLookupError } = await service.auth.admin
    .getUserById(targetProfileId);
  if (authLookupError || !authData.user?.email) {
    throw new InternalWorkError(
      409,
      "The workforce identity could not be confirmed.",
    );
  }
  const targetEmail = clean(authData.user.email, 254).toLowerCase();
  const { data, error } = await service.rpc("portal_start_offboarding", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_target_profile_id: targetProfileId,
    p_target_email: targetEmail,
    p_reason: reason,
  });
  if (error) {
    if (String(error.message || "").includes("duplicate key")) {
      throw new InternalWorkError(
        409,
        "An active offboarding case already exists for this user.",
      );
    }
    throw error;
  }

  const { error: authError } = await service.auth.admin.updateUserById(
    targetProfileId,
    { ban_duration: "876000h" },
  );
  const authState = authError ? "failed" : "revoked";
  const authNote = authError
    ? "Portal profile is inactive, but Auth session revocation needs Administrator follow-up."
    : "Supabase Auth identity was banned after Portal deactivation.";
  const { error: stateError } = await service.rpc(
    "portal_record_offboarding_auth_state",
    {
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_offboarding_case_id: data.id,
      p_auth_state: authState,
      p_auth_note: authNote,
    },
  );
  if (stateError) throw stateError;

  return {
    case: {
      ...data,
      auth_revocation_state: authState,
      auth_revocation_note: authNote,
    },
    warning: authError ? authNote : null,
  };
}

async function updateOffboardingChecklist(
  actor: Actor,
  body: Row,
): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to update offboarding.",
    );
  }
  const checklistId = uuid(body.checklistId, "checklist item");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(
      400,
      "Refresh the checklist before updating it.",
    );
  }
  const status = clean(body.status, 40);
  if (
    !new Set(["not_started", "in_progress", "completed", "not_applicable"]).has(
      status,
    )
  ) {
    throw new InternalWorkError(400, "Choose a valid checklist status.");
  }
  const evidenceNote = clean(body.evidenceNote, 4000);
  if (
    ["completed", "not_applicable"].includes(status) && evidenceNote.length < 8
  ) {
    throw new InternalWorkError(
      400,
      "Add evidence or explain why this item is not applicable.",
    );
  }
  const { data, error } = await service.rpc(
    "portal_update_offboarding_checklist",
    {
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_checklist_id: checklistId,
      p_expected_version: expectedVersion,
      p_status: status,
      p_evidence_note: evidenceNote,
    },
  );
  if (error) {
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This checklist item changed. Refresh before saving.",
      );
    }
    throw error;
  }
  return { checklistItem: data };
}

async function createAccessRequest(actor: Actor, body: Row): Promise<Row> {
  const targetProfileId = body.targetProfileId
    ? uuid(body.targetProfileId, "workforce user")
    : actor.id;
  if (!actor.administrator && targetProfileId !== actor.id) {
    throw new InternalWorkError(
      403,
      "You may request access only for your own account.",
    );
  }
  const requestedStaffRole = clean(body.requestedStaffRole, 40);
  if (!STAFF_ROLES.has(requestedStaffRole)) {
    throw new InternalWorkError(400, "Choose a valid workforce role.");
  }
  const departmentKey = clean(body.departmentKey, 40) || null;
  const departmentRole = clean(body.departmentRole, 40) || "member";
  if (!DEPARTMENT_ROLES.has(departmentRole)) {
    throw new InternalWorkError(400, "Choose a valid department role.");
  }
  const justification = clean(body.justification, 4000);
  if (justification.length < 12) {
    throw new InternalWorkError(
      400,
      "Explain the business reason for this access.",
    );
  }

  const { data: target, error: targetError } = await service.from(
    "portal_profile",
  )
    .select("id,role,active").eq("id", targetProfileId).eq("role", "internal")
    .eq("active", true).maybeSingle();
  if (targetError) throw targetError;
  if (!target) {
    throw new InternalWorkError(404, "Active workforce user not found.");
  }

  let department: Row | null = null;
  if (departmentKey) {
    const result = await service.from("portal_department")
      .select("department_key,status,sensitive_tier").eq(
        "department_key",
        departmentKey,
      ).maybeSingle();
    if (result.error) throw result.error;
    department = result.data;
    if (!department) {
      throw new InternalWorkError(400, "Choose a valid department.");
    }
    if (department.status === "held") {
      throw new InternalWorkError(
        409,
        "That department workflow is currently on hold.",
      );
    }
  }

  const { data: openRequest, error: duplicateError } = await service.from(
    "portal_access_request",
  )
    .select("reference").eq("target_profile_id", targetProfileId)
    .in("status", ["submitted", "under_review", "returned"]).maybeSingle();
  if (duplicateError) throw duplicateError;
  if (openRequest) {
    throw new InternalWorkError(
      409,
      `${openRequest.reference} is already open for this user.`,
    );
  }

  const riskTier = accessRequestRiskTier(
    requestedStaffRole,
    departmentKey,
    department?.sensitive_tier === true,
  );
  const requestedExpiresOn = isoDate(body.requestedExpiresOn);
  const { data, error } = await service.rpc("portal_submit_access_request", {
    p_requester_id: actor.id,
    p_requester_email: actor.email,
    p_target_profile_id: targetProfileId,
    p_requested_staff_role: requestedStaffRole,
    p_requested_department_key: departmentKey,
    p_requested_department_role: departmentRole,
    p_requested_expires_on: requestedExpiresOn,
    p_justification: justification,
    p_risk_tier: riskTier,
  });
  if (error) throw error;
  return { request: data };
}

async function decideAccessRequest(actor: Actor, body: Row): Promise<Row> {
  if (!actor.administrator) {
    throw new InternalWorkError(
      403,
      "Administrator access is required to decide access requests.",
    );
  }
  const id = uuid(body.accessRequestId, "access request");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InternalWorkError(
      400,
      "Refresh the access request before deciding it.",
    );
  }
  const decision = clean(body.decision, 40);
  const note = clean(body.note, 4000);
  const { data: current, error: currentError } = await service.from(
    "portal_access_request",
  )
    .select("status,requester_id,target_profile_id").eq("id", id).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new InternalWorkError(404, "Access request not found.");
  if (!accessRequestDecisionAllowed(String(current.status), decision)) {
    throw new InternalWorkError(
      409,
      "This access request is not in a reviewable state.",
    );
  }
  if (["returned", "denied"].includes(decision) && note.length < 8) {
    throw new InternalWorkError(
      400,
      "Enter a decision note before returning or denying access.",
    );
  }
  if (
    decision === "approved" && current.requester_id === actor.id &&
    current.target_profile_id === actor.id
  ) {
    throw new InternalWorkError(
      403,
      "You cannot approve your own access request.",
    );
  }

  const { data, error } = await service.rpc(
    "portal_apply_access_request_decision",
    {
      p_access_request_id: id,
      p_expected_version: expectedVersion,
      p_decision: decision,
      p_actor_id: actor.id,
      p_actor_email: actor.email,
      p_note: note,
    },
  );
  if (error) {
    if (String(error.message || "").includes("changed")) {
      throw new InternalWorkError(
        409,
        "This request changed. Refresh it before deciding.",
      );
    }
    throw error;
  }
  return { request: data };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const actor = await actorFor(request);
    if (request.method === "GET") return json(request, await overview(actor));
    const body = await request.json() as Row;
    const action = clean(body.action, 80);
    if (action === "create-access-request") {
      return json(request, await createAccessRequest(actor, body), 201);
    }
    if (action === "decide-access-request") {
      return json(request, await decideAccessRequest(actor, body));
    }
    if (action === "create-department-request") {
      return json(request, await createDepartmentRequest(actor, body), 201);
    }
    if (action === "decide-department-request") {
      return json(request, await decideDepartmentRequest(actor, body));
    }
    if (action === "create-purchase-request") {
      return json(request, await createPurchaseRequest(actor, body), 201);
    }
    if (action === "decide-purchase-request") {
      return json(request, await decidePurchaseRequest(actor, body));
    }
    if (action === "decide-purchase-business-approval") {
      return json(request, await decidePurchaseBusinessApproval(actor, body));
    }
    if (action === "mark-supply-order-ordered") {
      return json(request, await markSupplyOrderOrdered(actor, body));
    }
    if (action === "upload-purchase-document") {
      return json(request, await uploadPurchaseDocument(actor, body), 201);
    }
    if (action === "download-purchase-document") {
      return json(request, await downloadPurchaseDocument(actor, body));
    }
    if (action === "save-department-notification-recipient") {
      return json(request, await saveNotificationRecipient(actor, body));
    }
    if (action === "deactivate-department-notification-recipient") {
      return json(request, await deactivateNotificationRecipient(actor, body));
    }
    if (action === "start-offboarding") {
      return json(request, await startOffboarding(actor, body), 201);
    }
    if (action === "update-offboarding-checklist") {
      return json(request, await updateOffboardingChecklist(actor, body));
    }
    if (action === "update-governance-review") {
      return json(request, await updateGovernanceReview(actor, body));
    }
    if (action === "update-it-system") {
      return json(request, await updateItSystem(actor, body));
    }
    if (action === "create-emergency-change") {
      return json(request, await createEmergencyChange(actor, body), 201);
    }
    if (action === "decide-emergency-change") {
      return json(request, await decideEmergencyChange(actor, body));
    }
    throw new InternalWorkError(400, "Unsupported Internal work action.");
  } catch (error) {
    if (!(error instanceof InternalWorkError)) {
      console.error("portal-internal-work", error);
    }
    return json(request, {
      error: error instanceof InternalWorkError
        ? error.message
        : "The Internal workspace is temporarily unavailable.",
    }, error instanceof InternalWorkError ? error.status : 500);
  }
});
