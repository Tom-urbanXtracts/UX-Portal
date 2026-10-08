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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const PORTAL_URL = "https://portal.urbanxtracts.com";
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
): Promise<string> {
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
    payload: variables,
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
      html: emailHtml(text),
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
  return await Promise.all([...recipients].map(([email, name]) =>
    sendDepartmentNotification(
      "purchase_request_approval_required",
      email,
      { ...variables, recipientName: name },
      `${eventPrefix}:${email}`,
    )
  ));
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
      "*,portal_purchase_request_line(*),portal_purchase_request_decision(*)",
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

  const actorPurchaseApprovalTiers = (purchaseApproversResult.data ?? []).filter(
    (approver) => String(approver.approver_email).toLowerCase() === actor.email,
  ).map((approver) => String(approver.approval_tier));
  const purchaseRequests = ((purchaseRequestsResult.data ?? []) as Row[]).filter(
    (request) =>
      actor.administrator || String(request.requester_id) === actor.id ||
      actorPurchaseApprovalTiers.includes(String(request.approval_tier)),
  );
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
  const vendorName = clean(body.vendorName, 200);
  const purpose = clean(body.purpose, 4000);
  const priority = clean(body.priority || "normal", 20);
  const neededBy = isoDate(body.neededBy);
  const deliveryStartOn = isoDate(body.deliveryStartOn);
  const deliveryEndOn = isoDate(body.deliveryEndOn);
  const paymentMethod = clean(body.paymentMethod, 100);
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
    purpose.length < 12 || !new Set(["low", "normal", "high", "urgent"])
      .has(priority) || lines.length < 1 || lines.length > 50
  ) {
    throw new InternalWorkError(
      400,
      "Complete the department, vendor, business purpose, and at least one item.",
    );
  }
  const normalizedLines = lines.map((line, index) => {
    const itemDescription = clean(line.itemDescription, 500);
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unitCost);
    const expenseCategory = clean(line.expenseCategory, 30);
    const purchaseUrl = clean(line.purchaseUrl, 1200);
    const requiredDeliveryOn = isoDate(line.requiredDeliveryOn);
    if (
      itemDescription.length < 2 || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(unitCost) || unitCost < 0 ||
      !categories.has(expenseCategory) ||
      (purchaseUrl && !/^https:\/\//i.test(purchaseUrl))
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
      quantity,
      unitCost,
      expenseCategory,
      expenseSubcategory: clean(line.expenseSubcategory, 160),
      chartOfAccounts: clean(line.chartOfAccounts, 200),
      requiredDeliveryOn,
    };
  });
  const amount = normalizedLines.reduce(
    (total, line) => total + Math.round(line.quantity * line.unitCost * 100) / 100,
    0,
  );
  let route;
  try {
    route = purchaseApprovalRoute(amount);
  } catch {
    throw new InternalWorkError(
      400,
      "Enter a purchase amount greater than zero.",
    );
  }
  const { data, error } = await service.rpc("portal_submit_purchase_request_v2", {
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_department_key: departmentKey,
    p_vendor_name: vendorName,
    p_purpose: purpose,
    p_priority: priority,
    p_needed_by: neededBy,
    p_delivery_start_on: deliveryStartOn,
    p_delivery_end_on: deliveryEndOn,
    p_recurring_purchase: recurringPurchase,
    p_payment_method: paymentMethod,
    p_lines: normalizedLines,
  });
  if (error) throw error;
  const amountLabel = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
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
    await notifyTeam(
      "finance",
      "purchase_request_approval_required",
      {
        requestReference: data.reference,
        vendorName: data.vendor_name,
        amount: amountLabel,
        approvalAuthority: route.authority,
      },
      `purchase-request-approval-required:${data.id}:${data.version}`,
      actor.email,
    );
    await notifyPurchaseApprovers(
      route.tier,
      {
        requestReference: data.reference,
        vendorName: data.vendor_name,
        amount: amountLabel,
        approvalAuthority: route.authority,
      },
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
