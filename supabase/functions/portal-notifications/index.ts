import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { Webhook } from "https://esm.sh/svix@1.81.0?target=denonext";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const PORTAL_URL = "https://portal.urbanxtracts.com";
const DOCUMENT_SCANNER_CONFIGURED = /^https:\/\//.test(Deno.env.get("DOCUMENT_SCANNER_URL") ?? "") &&
  (Deno.env.get("DOCUMENT_SCANNER_SHARED_SECRET") ?? "").length >= 32;
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; permissions: Set<string> };

class PortalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
    "https://portal.urbanxtracts.com",
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]).has(candidate) ? candidate : "https://portal.urbanxtracts.com";
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

async function handleResendWebhook(request: Request): Promise<Response> {
  if (!RESEND_WEBHOOK_SECRET) {
    throw new PortalError(503, "Notification delivery verification is not configured.");
  }
  const raw = await request.text();
  let event: Row;
  try {
    event = new Webhook(RESEND_WEBHOOK_SECRET).verify(raw, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    }) as Row;
  } catch {
    throw new PortalError(400, "Invalid notification webhook signature.");
  }
  const eventType = clean(event.type, 80);
  const eventData = event.data && typeof event.data === "object" ? event.data as Row : {};
  const providerMessageId = clean(eventData.email_id || eventData.id, 200);
  if (!providerMessageId || !eventType.startsWith("email.")) {
    return json(request, { received: true });
  }
  const changes: Row = { updated_at: new Date().toISOString() };
  if (eventType === "email.delivered") {
    changes.state = "delivered";
    changes.delivered_at = new Date().toISOString();
    changes.last_error = null;
  } else if (new Set(["email.bounced", "email.complained", "email.suppressed"]).has(eventType)) {
    changes.state = "bounced";
    changes.last_error = eventType === "email.complained"
      ? "The recipient reported this message as spam."
      : eventType === "email.suppressed"
      ? "The provider suppressed delivery to this recipient."
      : "The recipient mail server permanently rejected this message.";
  } else if (eventType === "email.failed") {
    changes.state = "failed";
    changes.last_error = "The provider could not deliver this message.";
  } else if (eventType === "email.delivery_delayed") {
    changes.last_error = "Delivery is delayed at the recipient mail server.";
  } else {
    return json(request, { received: true });
  }
  await service.from("portal_notification_outbox").update(changes)
    .eq("provider", "resend").eq("provider_message_id", providerMessageId);
  return json(request, { received: true });
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenHasAal2(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  const permissions = new Set<string>();
  if (profile.role === "internal") {
    const { data } = await service.from("portal_role_permission").select("permission")
      .eq("staff_role", profile.staff_role);
    for (const row of data ?? []) permissions.add(String(row.permission));
  }
  return { user, profile: profile as Row, permissions };
}

function requireManage(caller: Caller): void {
  if (caller.profile.role !== "internal" || !caller.permissions.has("notifications.manage")) {
    throw new PortalError(403, "This workforce role cannot manage communications.");
  }
}

function interpolate(template: string, variables: Row, allowed: string[]): string {
  const values: Row = { ...variables, portalUrl: PORTAL_URL };
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key) => {
    if (key !== "portalUrl" && !allowed.includes(key)) return "";
    return clean(values[key], 2000);
  });
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.split(/\n\n+/).map((paragraph) =>
    `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#170e0b">${paragraph.replace(/\n/g, "<br>")}</p>`
  ).join("");
}

async function templateFor(key: string): Promise<Row> {
  const { data, error } = await service.from("portal_notification_template").select("*")
    .eq("template_key", key).eq("approval_state", "approved").maybeSingle();
  if (error) throw error;
  if (!data) throw new PortalError(404, "That approved notification template was not found.");
  return data as Row;
}

async function profileRecipient(profileId: string): Promise<{ email: string; profile: Row }> {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) throw new PortalError(400, "Choose a portal user.");
  const { data: profile, error } = await service.from("portal_profile").select(
    "id,full_name,org,role,active",
  ).eq("id", profileId).maybeSingle();
  if (error) throw error;
  if (!profile || profile.active === false) throw new PortalError(409, "The recipient is not an active portal user.");
  const { data: authUser, error: userError } = await service.auth.admin.getUserById(profileId);
  if (userError || !authUser.user?.email) throw new PortalError(409, "The recipient does not have a deliverable email address.");
  return { email: authUser.user.email.toLowerCase(), profile: profile as Row };
}

async function deliver(outbox: Row, template: Row): Promise<Row> {
  if (!RESEND_API_KEY) {
    const { data } = await service.from("portal_notification_outbox").update({
      state: "held_provider",
      last_error: "Email provider credentials are not configured.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id).select("*").single();
    return data as Row;
  }
  const { data: quotaState, error: quotaError } = await service.rpc(
    "portal_claim_resend_free_quota",
    { p_outbox_id: outbox.id },
  );
  if (quotaError) throw quotaError;
  if (quotaState !== "claimed") {
    const { data } = await service.from("portal_notification_outbox").select("*").eq("id", outbox.id).single();
    return data as Row;
  }
  const payload = (outbox.payload && typeof outbox.payload === "object" ? outbox.payload : {}) as Row;
  const allowed = Array.isArray(template.allowed_variables) ? template.allowed_variables.map(String) : [];
  const subject = interpolate(String(template.subject_template), payload, allowed);
  const text = interpolate(String(template.text_template), payload, allowed);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": String(outbox.id),
    },
    body: JSON.stringify({
      from: PORTAL_EMAIL_FROM,
      to: [outbox.recipient_email],
      subject,
      text,
      html: textToHtml(text),
      tags: [{ name: "template", value: String(template.template_key).slice(0, 256) }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Row;
  if (!response.ok || !result.id) {
    const errorText = clean(result.message || result.error, 500) || "Email provider rejected the request.";
    await service.from("portal_notification_outbox").update({
      state: response.status === 429 ? "held_provider" : "failed",
      last_error: response.status === 429
        ? "The no-cost email provider limit was reached; message held for review."
        : errorText,
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    throw new PortalError(502, "The message was saved, but the email provider did not accept it.");
  }
  const { data, error } = await service.from("portal_notification_outbox").update({
    state: "sent", provider: "resend", provider_message_id: result.id,
    sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", outbox.id).select("*").single();
  if (error) throw error;
  return data as Row;
}

async function queueOne(template: Row, recipientEmail: string, variables: Row, scope: Row = {}): Promise<Row> {
  const eventKey = clean(scope.eventKey, 300) ||
    `${template.template_key}:${recipientEmail}:${crypto.randomUUID()}`;
  const { data: existing, error: existingError } = await service.from("portal_notification_outbox")
    .select("*").eq("event_key", eventKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing as Row;
  const { data, error } = await service.from("portal_notification_outbox").insert({
    event_key: eventKey,
    event_type: template.template_key === "store_welcome" ? "user_invitation"
      : template.template_key === "kiosk_mode_guide" ? "kiosk_guide"
      : template.template_key === "order_how_to" ? "order_guide"
      : template.template_key === "user_how_to" ? "user_guide"
      : template.template_key === "onboarding_submitted_store" || template.template_key === "onboarding_submitted_internal" ? "onboarding_submitted"
      : template.template_key === "onboarding_needs_information" ? "onboarding_incomplete"
      : template.template_key === "order_received" || template.template_key === "order_state_changed" ? "order_state"
      : template.template_key === "claim_received" || template.template_key === "claim_internal" ? "receiving_claim_submitted"
      : template.template_key,
    template_key: template.template_key,
    template_version: template.version,
    audience: template.audience,
    mandatory: template.mandatory,
    recipient_email: recipientEmail,
    retailer_account_id: scope.retailerAccountId || null,
    store_license: scope.storeLicense || null,
    onboarding_request_id: scope.onboardingRequestId || null,
    state: "pending",
    channel: "email",
    payload: variables,
    updated_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;
  return await deliver(data as Row, template);
}

async function sendTemplate(caller: Caller, body: Row): Promise<Row> {
  requireManage(caller);
  const template = await templateFor(clean(body.templateKey, 80));
  const recipient = await profileRecipient(clean(body.recipientProfileId, 80));
  if (template.audience === "store" && recipient.profile.role === "internal") {
    throw new PortalError(409, "Choose a store user for this template.");
  }
  if (template.audience === "internal" && recipient.profile.role !== "internal") {
    throw new PortalError(409, "Choose an urbanXtracts user for this template.");
  }
  const variables = body.variables && typeof body.variables === "object" ? body.variables as Row : {};
  variables.recipientName = variables.recipientName || recipient.profile.full_name || "there";
  return await queueOne(template, recipient.email, variables);
}

async function sendInvoiceNotice(caller: Caller, body: Row): Promise<Row[]> {
  requireManage(caller);
  if (!caller.permissions.has("financials.read")) throw new PortalError(403, "Financial access is required.");
  const invoiceId = clean(body.invoiceId, 120);
  const { data: sync } = await service.from("quickbooks_sync_state").select("last_financial_run_id")
    .eq("id", 1).maybeSingle();
  if (!sync?.last_financial_run_id) throw new PortalError(409, "A successful QuickBooks snapshot is required.");
  const { data: invoice, error } = await service.from("quickbooks_invoice_cache").select("*")
    .eq("sync_run_id", sync.last_financial_run_id).eq("quickbooks_invoice_id", invoiceId).maybeSingle();
  if (error) throw error;
  if (!invoice || Number(invoice.balance || 0) <= 0) throw new PortalError(409, "Choose an open invoice from the latest QuickBooks snapshot.");
  const customerId = String(invoice.quickbooks_customer_id);
  const { data: stores } = await service.from("portal_store").select(
    "license_number,display_name,organization,retailer_account_id",
  ).eq("quickbooks_customer_id", customerId).eq("active", true);
  const { data: account } = await service.from("portal_retailer_account").select("id,organization_name,display_name")
    .eq("quickbooks_customer_id", customerId).maybeSingle();
  const organization = String(stores?.[0]?.organization || account?.organization_name || "");
  if (!organization) throw new PortalError(409, "The invoice is not mapped to a portal retailer.");
  const { data: profiles } = await service.from("portal_profile").select("id,full_name,role,active")
    .eq("org", organization).eq("active", true).in("role", ["owner", "buyer"]);
  const template = await templateFor("invoice_notice");
  const results: Row[] = [];
  for (const profile of profiles ?? []) {
    if (profile.role === "buyer" && stores?.length) {
      const { data: assignments } = await service.from("portal_profile_store").select("license_number")
        .eq("profile_id", profile.id).in("license_number", stores.map((store) => store.license_number));
      if (!assignments?.length) continue;
    }
    const recipient = await profileRecipient(String(profile.id));
    results.push(await queueOne(template, recipient.email, {
      invoiceNumber: invoice.doc_number || invoice.quickbooks_invoice_id,
      storeName: stores?.length === 1 ? stores[0].display_name : account?.display_name || organization,
      balance: new Intl.NumberFormat("en-US", { style: "currency", currency: String(invoice.currency || "USD") }).format(Number(invoice.balance || 0)),
      dueDate: invoice.due_date || "not recorded",
    }, {
      eventKey: `invoice-notice:${invoiceId}:${profile.id}:${invoice.balance}`,
      retailerAccountId: stores?.[0]?.retailer_account_id || account?.id || null,
      storeLicense: stores?.length === 1 ? stores[0].license_number : null,
    }));
  }
  if (!results.length) throw new PortalError(409, "No active Store Owner or assigned Buyer has a deliverable email address.");
  return results;
}

async function listFor(caller: Caller): Promise<Row> {
  if (caller.profile.role === "internal") {
    requireManage(caller);
    const [templates, policy, outbox, profiles, retention, quotaUsage] = await Promise.all([
      service.from("portal_notification_template").select("*").neq("approval_state", "retired").order("audience").order("category").order("title"),
      service.from("portal_notification_policy").select("*").eq("id", 1).single(),
      service.from("portal_notification_outbox").select("*").order("created_at", { ascending: false }).limit(200),
      service.from("portal_profile").select("id,full_name,org,role,staff_role,active").eq("active", true).order("full_name"),
      service.from("portal_document_retention_rule").select("*").order("display_name"),
      service.rpc("portal_resend_free_quota_status"),
    ]);
    if (templates.error) throw templates.error;
    if (policy.error) throw policy.error;
    if (outbox.error) throw outbox.error;
    if (profiles.error) throw profiles.error;
    if (retention.error) throw retention.error;
    if (quotaUsage.error) throw quotaUsage.error;
    const quota = quotaUsage.data && typeof quotaUsage.data === "object" ? quotaUsage.data as Row : {};
    return {
      templates: templates.data ?? [], policy: policy.data, outbox: outbox.data ?? [], profiles: profiles.data ?? [],
      retentionRules: retention.data ?? [],
      sender: {
        provider: "Resend Free",
        configured: Boolean(RESEND_API_KEY),
        from: PORTAL_EMAIL_FROM,
        costMode: "free_tier_hard_cap",
        dailyUsed: Number(quota.dailyUsed ?? 0),
        dailyLimit: Number(policy.data?.daily_email_limit ?? 100),
        monthlyUsed: Number(quota.monthlyUsed ?? 0),
        monthlyLimit: Number(policy.data?.monthly_email_limit ?? 3000),
      },
      controls: {
        documentScannerConfigured: DOCUMENT_SCANNER_CONFIGURED,
        automaticDocumentDeletionEnabled: (retention.data ?? []).some((row) => row.automatic_deletion_enabled === true),
      },
    };
  }
  const email = clean(caller.user.email, 320).toLowerCase();
  const { data, error } = await service.from("portal_notification_outbox").select(
    "id,event_type,template_key,state,payload,mandatory,sent_at,delivered_at,created_at",
  ).eq("recipient_email", email).in("state", ["sent", "delivered", "bounced"]).order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return { notifications: data ?? [] };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!new Set(["GET", "POST"]).has(request.method)) return json(request, { error: "Method not allowed" }, 405);
  try {
    const url = new URL(request.url);
    if (request.method === "POST" && url.searchParams.get("webhook") === "resend") {
      return await handleResendWebhook(request);
    }
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    if (request.method === "GET") return json(request, await listFor(caller));
    const body = await request.json() as Row;
    const action = clean(body.action, 50);
    if (action === "send-template") return json(request, { message: await sendTemplate(caller, body) });
    if (action === "send-invoice-notice") return json(request, { messages: await sendInvoiceNotice(caller, body) });
    throw new PortalError(400, "Unsupported notification action.");
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-notifications", error);
    return json(request, { error: error instanceof PortalError ? error.message : "The communication service is temporarily unavailable." },
      error instanceof PortalError ? error.status : 502);
  }
});
