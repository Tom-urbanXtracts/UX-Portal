import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import {
  ContentScanError,
  scanContent,
  sha256Hex,
} from "../_shared/content-scanner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const TURNSTILE_REQUIRED = Deno.env.get("TURNSTILE_REQUIRED") === "true";
const TURNSTILE_ALLOWED_HOSTS = new Set(
  String(Deno.env.get("TURNSTILE_ALLOWED_HOSTS") ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
);
const PUBLIC_INTAKE_RATE_SECRET = Deno.env.get("PUBLIC_INTAKE_RATE_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const APPLICATION_BUCKET = "portal-brand-application-documents";
const ONBOARDING_BUCKET = "portal-brand-onboarding-documents";

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type InternalActor = { user: Row; profile: Row };

const SECTION_DEFINITIONS = [
  {
    key: "company",
    title: "Company Profile",
    required: [
      "legal_name",
      "dba_name",
      "entity_type",
      "address_line_1",
      "city",
      "state",
      "postal_code",
    ],
  },
  {
    key: "contacts",
    title: "Contacts & Authorized Users",
    required: [
      "primary_name",
      "primary_email",
      "primary_phone",
      "shipping_name",
      "shipping_email",
      "shipping_phone",
      "portal_owner_name",
      "portal_owner_email",
      "authorized_signer",
    ],
  },
  {
    key: "billing",
    title: "Billing & Remittance",
    required: [
      "billing_contact_name",
      "billing_email",
      "billing_address_line_1",
      "billing_city",
      "billing_state",
      "billing_postal_code",
      "ein",
      "remittance_contact",
      "payment_terms_request",
    ],
  },
  {
    key: "qualified_vendor",
    title: "Qualification Information",
    required: [
      "vendor_status",
      "quality_contact",
      "insurance_status",
      "relationship_model",
      "services_requested",
      "launch_timeline",
      "estimated_product_count",
      "product_categories",
    ],
  },
  {
    key: "identifiers",
    title: "License & Operating Information",
    required: ["license_type", "license_number", "license_expiration", "nci_status"],
  },
  {
    key: "documents",
    title: "Document Upload",
    required: ["document_attestation"],
  },
] as const;

const EDITABLE = new Set(["not_started", "draft", "in_progress", "changes_requested", "reopened"]);
const PUBLIC_ACTIONS = new Set([
  "start",
  "request-resume",
  "resume",
  "save-section",
  "submit-section",
  "upload-document",
  "submit-application",
]);
const ALLOWED_DOCUMENT_FIELDS = new Set([
  "w9",
  "license_file",
  "insurance_policy",
  "certification_file",
  "other_document",
]);
const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

class ApplicationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function origin(request: Request): string {
  const value = request.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.has(value) ? value : "https://portal.urbanxtracts.com";
}
function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": origin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
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
function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
}
function email(value: unknown, label = "email address"): string {
  const result = clean(value, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) {
    throw new ApplicationError(400, `Enter a valid ${label}.`);
  }
  return result;
}
function uuid(value: unknown, label: string): string {
  const result = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new ApplicationError(400, `Choose a valid ${label}.`);
  }
  return result;
}
function safeData(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError(400, "Section data must be an object.");
  }
  const output = Object.fromEntries(
    Object.entries(value as Row).slice(0, 180).map(([key, entry]) => {
      const safeKey = clean(key, 80).replace(/[^A-Za-z0-9_-]/g, "_");
      if (!safeKey) return null;
      if (typeof entry === "boolean") return [safeKey, entry];
      if (typeof entry === "number" && Number.isFinite(entry)) return [safeKey, entry];
      if (Array.isArray(entry)) return [safeKey, entry.slice(0, 100).map((item) => clean(item, 1000))];
      return [safeKey, clean(entry, 12_000)];
    }).filter(Boolean) as [string, unknown][],
  );
  if (JSON.stringify(output).length > 100_000) {
    throw new ApplicationError(413, "This section is too large to save.");
  }
  return output;
}
function requiredFields(sectionKey: string, data: Row): string[] {
  const definition = SECTION_DEFINITIONS.find((item) => item.key === sectionKey);
  const required = definition ? [...definition.required] as string[] : [];
  if (sectionKey === "qualified_vendor") {
    const model = clean(data.relationship_model, 80).toLowerCase();
    if (["manufacturing", "processing"].includes(model)) {
      required.push("production_requirements", "expected_monthly_volume");
    }
    if (model === "distribution") required.push("distribution_scope");
    if (model === "tolling") required.push("ownership_arrangement");
    if (model === "revenue share") required.push("settlement_frequency");
  }
  return required;
}
function present(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return clean(value, 12_000).length > 0;
}
function completion(sectionKey: string, data: Row): number {
  const required = requiredFields(sectionKey, data);
  if (!required.length) return 100;
  return Math.round(required.filter((key) => present(data[key])).length / required.length * 100);
}
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function hashToken(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return Array.from(signature).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function verifyHuman(body: Row): Promise<void> {
  if (!TURNSTILE_REQUIRED) return;
  if (!TURNSTILE_SECRET_KEY || !PUBLIC_INTAKE_RATE_SECRET) {
    throw new ApplicationError(503, "Brand application verification is not configured.");
  }
  const token = clean(body.antiAbuseToken, 2048);
  if (!token) throw new ApplicationError(400, "Complete the verification challenge.");
  const form = new FormData();
  form.set("secret", TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("idempotency_key", crypto.randomUUID());
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new ApplicationError(503, "Verification is temporarily unavailable.");
  const result = await response.json() as Row;
  const hostname = clean(result.hostname, 200).toLowerCase();
  if (
    result.success !== true || result.action !== "brand_application" ||
    (TURNSTILE_ALLOWED_HOSTS.size && !TURNSTILE_ALLOWED_HOSTS.has(hostname))
  ) throw new ApplicationError(400, "The verification challenge was not accepted.");
}
async function claimRate(address: string): Promise<void> {
  if (!TURNSTILE_REQUIRED) return;
  const { data, error } = await service.rpc("portal_claim_public_intake_rate", {
    p_scope_key: await protectedScope(`brand-application:${address}`),
    p_limit: 6,
  });
  if (error) throw error;
  if (data !== true) throw new ApplicationError(429, "Too many secure-link requests were made today.");
}
function interpolate(template: string, values: Row): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key) => clean(values[key], 3000));
}
function emailHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const linked = escaped.replace(
    /https:\/\/portal\.urbanxtracts\.com\/#brand-application=[A-Za-z0-9_-]{40,80}/g,
    (url) => `<a href="${url}" style="color:#134a2b;font-weight:700">Open your Brand application</a>`,
  );
  return linked.split(/\n\n+/).map((paragraph) =>
    `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#170e0b">${paragraph.replace(/\n/g, "<br>")}</p>`
  ).join("");
}
async function sendTemplate(
  eventType: "brand_application_resume" | "brand_application_submitted",
  eventKey: string,
  recipient: string,
  variables: Row,
): Promise<string> {
  const { data: template, error: templateError } = await service.from("portal_notification_template")
    .select("*").eq("template_key", eventType).eq("approval_state", "approved").single();
  if (templateError) throw templateError;
  const { data: existing } = await service.from("portal_notification_outbox")
    .select("*").eq("event_key", eventKey).maybeSingle();
  let outbox = existing as Row | null;
  if (!outbox) {
    const { data, error } = await service.from("portal_notification_outbox").insert({
      event_key: eventKey,
      event_type: eventType,
      template_key: template.template_key,
      template_version: template.version,
      audience: "brand",
      mandatory: true,
      recipient_email: recipient,
      state: "pending",
      channel: "email",
      payload: variables,
      updated_at: new Date().toISOString(),
    }).select("*").single();
    if (error) throw error;
    outbox = data as Row;
  }
  if (outbox.state === "sent" || outbox.state === "delivered") return String(outbox.state);
  if (!RESEND_API_KEY) {
    await service.from("portal_notification_outbox").update({
      state: "held_provider",
      last_error: "Email provider credentials are not configured.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    throw new ApplicationError(503, "The application was saved, but its secure email could not be sent.");
  }
  const { data: quotaState, error: quotaError } = await service.rpc("portal_claim_resend_free_quota", {
    p_outbox_id: outbox.id,
  });
  if (quotaError) throw quotaError;
  if (quotaState !== "claimed") {
    throw new ApplicationError(503, "The application was saved, but email is temporarily at its no-cost limit.");
  }
  const subject = interpolate(String(template.subject_template), variables);
  const text = interpolate(String(template.text_template), variables);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": String(outbox.id),
    },
    body: JSON.stringify({
      from: PORTAL_EMAIL_FROM,
      to: [recipient],
      subject,
      text,
      html: emailHtml(text),
      tags: [{ name: "template", value: eventType }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Row;
  if (!response.ok || !result.id) {
    await service.from("portal_notification_outbox").update({
      state: response.status === 429 ? "held_provider" : "failed",
      last_error: clean(result.message || result.error, 500) || "Email provider rejected the request.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    throw new ApplicationError(502, "The application was saved, but its secure email could not be sent.");
  }
  await service.from("portal_notification_outbox").update({
    state: "sent",
    provider: "resend",
    provider_message_id: result.id,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", outbox.id);
  return "sent";
}
async function logEvent(
  applicationId: string,
  sectionId: string | null,
  action: string,
  actorScope: "applicant" | "internal" | "system",
  actorEmail: string | null,
  detail: Row = {},
): Promise<void> {
  const { error } = await service.from("portal_brand_application_event").insert({
    application_id: applicationId,
    section_id: sectionId,
    action,
    actor_scope: actorScope,
    actor_email: actorEmail,
    detail,
  });
  if (error) throw error;
}
async function internalActor(request: Request): Promise<InternalActor | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,full_name,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (!profile || profile.active === false || profile.role !== "internal" || profile.staff_role !== "administrator") {
    return null;
  }
  return { user, profile: profile as Row };
}
async function applicationForToken(rawToken: unknown): Promise<Row> {
  const token = clean(rawToken, 120);
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) throw new ApplicationError(401, "This application link is invalid.");
  const { data, error } = await service.from("portal_brand_application").select("*")
    .eq("resume_token_hash", await hashToken(token)).maybeSingle();
  if (error) throw error;
  if (!data || new Date(String(data.resume_token_expires_at)).getTime() <= Date.now()) {
    throw new ApplicationError(401, "This application link has expired. Request a fresh link.");
  }
  await service.from("portal_brand_application").update({
    email_verified_at: data.email_verified_at || new Date().toISOString(),
    resume_token_last_used_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", data.id);
  return data as Row;
}
async function sectionsFor(applicationId: string): Promise<Row[]> {
  const { data, error } = await service.from("portal_brand_application_section").select("*")
    .eq("application_id", applicationId).order("position");
  if (error) throw error;
  const sections = (data ?? []) as Row[];
  const ids = sections.map((section) => section.id);
  const { data: docs, error: docsError } = ids.length
    ? await service.from("portal_brand_application_document")
      .select("id,section_id,field_key,original_name,content_type,size_bytes,scan_state,scan_provider,created_at")
      .in("section_id", ids).order("created_at", { ascending: false })
    : { data: [], error: null };
  if (docsError) throw docsError;
  return sections.map((section) => ({
    ...section,
    documents: (docs ?? []).filter((document) => document.section_id === section.id),
  }));
}
async function snapshot(application: Row): Promise<Row> {
  return {
    application: {
      id: application.id,
      reference: application.reference,
      status: application.status,
      applicantName: application.applicant_name,
      applicantEmail: application.applicant_email,
      applicantPhone: application.applicant_phone,
      brandName: application.brand_name,
      website: application.website,
      assignedToEmail: application.assigned_to_email,
      decisionNote: application.decision_note,
      submittedAt: application.submitted_at,
      updatedAt: application.updated_at,
    },
    sections: await sectionsFor(String(application.id)),
  };
}
async function startApplication(request: Request, body: Row): Promise<Response> {
  await verifyHuman(body);
  const applicantEmail = email(body.applicantEmail);
  await claimRate(applicantEmail);
  const applicantName = clean(body.applicantName, 160);
  const brandName = clean(body.brandName, 200);
  if (!applicantName || !brandName) throw new ApplicationError(400, "Your name and Brand name are required.");
  const applicantPhone = clean(body.applicantPhone, 80) || null;
  const website = clean(body.website, 500) || null;
  const rawToken = newToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await service.from("portal_brand_application")
    .select("*").eq("applicant_email", applicantEmail).ilike("brand_name", brandName)
    .not("status", "in", '(approved,rejected,withdrawn)').maybeSingle();
  if (existingError) throw existingError;
  let application: Row;
  if (existing) {
    const { data, error } = await service.from("portal_brand_application").update({
      applicant_name: applicantName,
      applicant_phone: applicantPhone,
      website,
      resume_token_hash: tokenHash,
      resume_token_prefix: rawToken.slice(0, 8),
      resume_token_expires_at: expiresAt,
      resume_email_last_sent_at: now,
      updated_at: now,
    }).eq("id", existing.id).select("*").single();
    if (error) throw error;
    application = data as Row;
  } else {
    const { data, error } = await service.from("portal_brand_application").insert({
      applicant_name: applicantName,
      applicant_email: applicantEmail,
      applicant_phone: applicantPhone,
      brand_name: brandName,
      website,
      resume_token_hash: tokenHash,
      resume_token_prefix: rawToken.slice(0, 8),
      resume_token_expires_at: expiresAt,
      resume_email_last_sent_at: now,
    }).select("*").single();
    if (error) throw error;
    application = data as Row;
    const { error: sectionError } = await service.from("portal_brand_application_section").insert(
      SECTION_DEFINITIONS.map((definition, index) => ({
        application_id: application.id,
        section_key: definition.key,
        position: index + 1,
        title: definition.title,
        data: definition.key === "company"
          ? { legal_name: brandName, dba_name: brandName, website: website || "" }
          : definition.key === "contacts"
          ? { primary_name: applicantName, primary_email: applicantEmail, primary_phone: applicantPhone || "", portal_owner_name: applicantName, portal_owner_email: applicantEmail }
          : {},
      })),
    );
    if (sectionError) throw sectionError;
    await logEvent(String(application.id), null, "application-created", "applicant", applicantEmail, {});
  }
  const applicationUrl = `https://portal.urbanxtracts.com/#brand-application=${rawToken}`;
  const emailState = await sendTemplate(
    "brand_application_resume",
    `brand-application-resume:${application.id}:${rawToken.slice(0, 8)}`,
    applicantEmail,
    {
      applicantName,
      brandName,
      reference: application.reference,
      applicationUrl,
      expiresOn: new Intl.DateTimeFormat("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        timeZone: "America/New_York",
      }).format(new Date(expiresAt)),
    },
  );
  await logEvent(String(application.id), null, "secure-link-sent", "system", applicantEmail, { emailState });
  return json(request, {
    ok: true,
    reference: application.reference,
    message: "Check your email for a private link to continue the application.",
  }, existing ? 200 : 201);
}
async function requestResume(request: Request, body: Row): Promise<Response> {
  await verifyHuman(body);
  const applicantEmail = email(body.applicantEmail);
  await claimRate(applicantEmail);
  const { data: application, error } = await service.from("portal_brand_application").select("*")
    .eq("applicant_email", applicantEmail).not("status", "in", '(approved,rejected,withdrawn)')
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (application) {
    const rawToken = newToken();
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    const now = new Date().toISOString();
    const { error: updateError } = await service.from("portal_brand_application").update({
      resume_token_hash: await hashToken(rawToken),
      resume_token_prefix: rawToken.slice(0, 8),
      resume_token_expires_at: expiresAt,
      resume_email_last_sent_at: now,
      updated_at: now,
    }).eq("id", application.id);
    if (updateError) throw updateError;
    await sendTemplate(
      "brand_application_resume",
      `brand-application-resume:${application.id}:${rawToken.slice(0, 8)}`,
      applicantEmail,
      {
        applicantName: application.applicant_name,
        brandName: application.brand_name,
        reference: application.reference,
        applicationUrl: `https://portal.urbanxtracts.com/#brand-application=${rawToken}`,
        expiresOn: new Intl.DateTimeFormat("en-US", {
          month: "2-digit",
          day: "2-digit",
          year: "numeric",
          timeZone: "America/New_York",
        }).format(new Date(expiresAt)),
      },
    );
  }
  return json(request, {
    ok: true,
    message: "If an active application matches that email, a new private link is on its way.",
  });
}
async function sectionScope(application: Row, body: Row): Promise<Row> {
  const sectionId = uuid(body.sectionId, "application section");
  const { data, error } = await service.from("portal_brand_application_section").select("*")
    .eq("id", sectionId).eq("application_id", application.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApplicationError(404, "Application section not found.");
  return data as Row;
}
async function saveSection(application: Row, body: Row, submit: boolean): Promise<Row> {
  if (["approved", "rejected", "withdrawn"].includes(String(application.status))) {
    throw new ApplicationError(409, "This application is closed.");
  }
  const section = await sectionScope(application, body);
  if (!EDITABLE.has(String(section.status))) throw new ApplicationError(409, "This section is locked for review.");
  const expectedRevision = Number(body.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(section.revision)) {
    throw new ApplicationError(409, "This section changed in another session. Refresh before saving again.");
  }
  const data = safeData(body.data);
  const percent = completion(String(section.section_key), data);
  if (submit && percent !== 100) {
    const missing = requiredFields(String(section.section_key), data).filter((key) => !present(data[key]));
    throw new ApplicationError(400, `Complete the required fields: ${missing.join(", ").replace(/_/g, " ")}.`);
  }
  const nextRevision = Number(section.revision) + 1;
  const now = new Date().toISOString();
  const { data: updated, error } = await service.from("portal_brand_application_section").update({
    data,
    completion_percent: percent,
    revision: nextRevision,
    status: submit ? "submitted" : (percent ? "in_progress" : "draft"),
    submitted_at: submit ? now : section.submitted_at,
    review_note: submit ? null : section.review_note,
    updated_by_email: application.applicant_email,
    updated_at: now,
  }).eq("id", section.id).eq("revision", expectedRevision).select("*").single();
  if (error) throw error;
  const { error: applicationError } = await service.from("portal_brand_application").update({
    status: "in_progress",
    revision: Number(application.revision) + 1,
    updated_at: now,
  }).eq("id", application.id);
  if (applicationError) throw applicationError;
  await logEvent(String(application.id), String(section.id), submit ? "section-submitted" : "section-saved", "applicant", String(application.applicant_email), { completionPercent: percent });
  return updated as Row;
}
function decodeFile(body: Row): { bytes: Uint8Array; contentType: string; name: string } {
  const file = body.file && typeof body.file === "object" && !Array.isArray(body.file) ? body.file as Row : {};
  const encoded = clean(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new ApplicationError(400, "The document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (!declared || declared !== bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) {
    throw new ApplicationError(400, "The document size did not pass validation.");
  }
  const contentType = clean(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!((contentType === "application/pdf" && pdf) || (contentType === "image/png" && png) || (contentType === "image/jpeg" && jpeg))) {
    throw new ApplicationError(400, "The document contents do not match its file type.");
  }
  const name = clean(file.name, 240);
  if (!name) throw new ApplicationError(400, "The document needs a file name.");
  return { bytes, contentType, name };
}
async function uploadDocument(application: Row, body: Row): Promise<Row> {
  const section = await sectionScope(application, body);
  if (!EDITABLE.has(String(section.status))) throw new ApplicationError(409, "This section is locked for review.");
  const fieldKey = clean(body.fieldKey, 80);
  if (!ALLOWED_DOCUMENT_FIELDS.has(fieldKey)) {
    throw new ApplicationError(400, "Choose an approved application document category.");
  }
  if (/audit|recall/i.test(fieldKey)) {
    throw new ApplicationError(400, "Audit and recall materials are not collected in this application.");
  }
  const file = decodeFile(body);
  const digest = await sha256Hex(file.bytes);
  let scan;
  try {
    scan = await scanContent(file.bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new ApplicationError(422, "The document was blocked by malware scanning and was not retained.");
    }
    throw new ApplicationError(503, "The document could not be verified as clean. Try again later.");
  }
  const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/png" ? "png" : "jpg";
  const objectPath = `${application.id}/${section.id}/${fieldKey}/${digest}.${extension}`;
  const { error: uploadError } = await service.storage.from(APPLICATION_BUCKET).upload(objectPath, file.bytes, {
    contentType: file.contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (uploadError && !clean(uploadError.message, 500).toLowerCase().includes("already exists")) throw uploadError;
  const { data, error } = await service.from("portal_brand_application_document").upsert({
    section_id: section.id,
    field_key: fieldKey,
    object_path: objectPath,
    original_name: file.name,
    content_type: file.contentType,
    size_bytes: file.bytes.byteLength,
    sha256: digest,
    scan_state: "clean",
    scan_provider: scan.engine,
    uploaded_by_email: application.applicant_email,
  }, { onConflict: "section_id,field_key,sha256" }).select("id,section_id,field_key,original_name,content_type,size_bytes,scan_state,scan_provider,created_at").single();
  if (error) throw error;
  await logEvent(String(application.id), String(section.id), "document-uploaded", "applicant", String(application.applicant_email), { fieldKey, documentId: data.id });
  return data as Row;
}
async function submitApplication(application: Row): Promise<Row> {
  const sections = await sectionsFor(String(application.id));
  const incomplete = sections.filter((section) =>
    !["submitted", "approved"].includes(String(section.status)) || Number(section.completion_percent) !== 100
  );
  if (incomplete.length) {
    throw new ApplicationError(409, `Submit every completed section first: ${incomplete.map((section) => section.title).join(", ")}.`);
  }
  const now = new Date().toISOString();
  const { data, error } = await service.from("portal_brand_application").update({
    status: "submitted",
    submitted_at: now,
    revision: Number(application.revision) + 1,
    updated_at: now,
  }).eq("id", application.id).select("*").single();
  if (error) throw error;
  await logEvent(String(application.id), null, "application-submitted", "applicant", String(application.applicant_email), {});
  try {
    await sendTemplate(
      "brand_application_submitted",
      `brand-application-submitted:${application.id}:${Number(application.revision) + 1}`,
      String(application.applicant_email),
      {
        applicantName: application.applicant_name,
        brandName: application.brand_name,
        reference: application.reference,
      },
    );
  } catch (notificationError) {
    console.error("brand application submitted email", notificationError);
  }
  return data as Row;
}
async function internalList(): Promise<Row[]> {
  const { data, error } = await service.from("portal_brand_application").select("*")
    .order("updated_at", { ascending: false }).limit(500);
  if (error) throw error;
  const applicationIds = (data ?? []).map((row) => row.id);
  const { data: sections, error: sectionError } = applicationIds.length
    ? await service.from("portal_brand_application_section").select("application_id,status,completion_percent").in("application_id", applicationIds)
    : { data: [], error: null };
  if (sectionError) throw sectionError;
  return (data ?? []).map((application) => {
    const scoped = (sections ?? []).filter((section) => section.application_id === application.id);
    return {
      id: application.id,
      reference: application.reference,
      status: application.status,
      brandName: application.brand_name,
      applicantName: application.applicant_name,
      applicantEmail: application.applicant_email,
      submittedAt: application.submitted_at,
      updatedAt: application.updated_at,
      approvedSections: scoped.filter((section) => section.status === "approved").length,
      submittedSections: scoped.filter((section) => section.status === "submitted").length,
      completionPercent: scoped.length ? Math.round(scoped.reduce((sum, section) => sum + Number(section.completion_percent || 0), 0) / scoped.length) : 0,
    };
  });
}
async function reviewSection(applicationId: string, body: Row, actor: InternalActor): Promise<Row> {
  const sectionId = uuid(body.sectionId, "application section");
  const { data: section, error } = await service.from("portal_brand_application_section").select("*")
    .eq("id", sectionId).eq("application_id", applicationId).maybeSingle();
  if (error) throw error;
  if (!section || section.status !== "submitted") throw new ApplicationError(409, "Only a submitted section can be reviewed.");
  const decision = clean(body.decision, 40);
  const note = clean(body.note, 4000);
  if (!new Set(["approve", "request_changes"]).has(decision)) throw new ApplicationError(400, "Choose approve or request changes.");
  if (decision === "request_changes" && !note) throw new ApplicationError(400, "Describe the required change.");
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await service.from("portal_brand_application_section").update({
    status: decision === "approve" ? "approved" : "changes_requested",
    review_note: note || null,
    approved_at: decision === "approve" ? now : null,
    revision: Number(section.revision) + 1,
    updated_by_email: actor.user.email,
    updated_at: now,
  }).eq("id", sectionId).select("*").single();
  if (updateError) throw updateError;
  const { error: appError } = await service.from("portal_brand_application").update({
    status: decision === "approve" ? "qualification_review" : "changes_requested",
    decision_note: note || null,
    updated_at: now,
  }).eq("id", applicationId);
  if (appError) throw appError;
  await logEvent(applicationId, sectionId, decision === "approve" ? "section-approved" : "section-returned", "internal", String(actor.user.email || ""), { note: note || null });
  return updated as Row;
}
async function findAuthUser(targetEmail: string): Promise<Row | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const match = data.users.find((user) => String(user.email || "").toLowerCase() === targetEmail);
    if (match) return match as unknown as Row;
    if (data.users.length < 1000) break;
  }
  return null;
}
async function approveApplication(application: Row, actor: InternalActor, note: string): Promise<Row> {
  const sections = await sectionsFor(String(application.id));
  if (sections.length !== 6 || sections.some((section) => section.status !== "approved")) {
    throw new ApplicationError(409, "Approve all six sections before creating the Brand workspace.");
  }
  const company = sections.find((section) => section.section_key === "company")?.data as Row || {};
  const contacts = sections.find((section) => section.section_key === "contacts")?.data as Row || {};
  const legalName = clean(company.legal_name, 200) || clean(application.brand_name, 200);
  const displayName = clean(company.dba_name, 200) || clean(application.brand_name, 200);
  const ownerEmail = email(contacts.portal_owner_email, "Brand Owner email address");
  const ownerName = clean(contacts.portal_owner_name, 160);
  if (!ownerName) throw new ApplicationError(409, "The approved Contacts section needs a Brand Owner name.");

  let organizationId = clean(application.organization_id, 80);
  if (!organizationId) {
    const { data: existing, error: existingError } = await service.from("portal_organization").select("id")
      .eq("kind", "brand").ilike("legal_name", legalName).maybeSingle();
    if (existingError) throw existingError;
    if (existing) throw new ApplicationError(409, "A Brand workspace already uses this legal name. Reconcile it before approving the application.");
    const { data: organization, error } = await service.from("portal_organization").insert({
      kind: "brand",
      legal_name: legalName,
      display_name: displayName,
      status: "active",
    }).select("id").single();
    if (error) throw error;
    organizationId = String(organization.id);
    const { error: accountError } = await service.from("portal_brand_account").insert({
      organization_id: organizationId,
      scope_status: "pending",
      scope_note: "Created from an approved public Brand application. Canix and QuickBooks identities remain pending explicit mapping.",
    });
    if (accountError) throw accountError;
  }

  let onboardingId = "";
  const { data: existingOnboarding, error: existingOnboardingError } = await service.from("portal_brand_onboarding")
    .select("id").eq("organization_id", organizationId).maybeSingle();
  if (existingOnboardingError) throw existingOnboardingError;
  if (existingOnboarding) onboardingId = String(existingOnboarding.id);
  else {
    const { data: onboarding, error } = await service.from("portal_brand_onboarding").insert({
      organization_id: organizationId,
      status: "approved",
      approved_by: actor.profile.id,
      approved_by_email: actor.user.email,
      approved_at: new Date().toISOString(),
      monday_handoff_state: "not_ready",
    }).select("id").single();
    if (error) throw error;
    onboardingId = String(onboarding.id);
  }
  for (const section of sections) {
    const { data: onboardingSection, error } = await service.from("portal_brand_onboarding_section").upsert({
      onboarding_id: onboardingId,
      section_key: section.section_key,
      position: section.position,
      title: section.title,
      status: "approved",
      data: section.data,
      completion_percent: 100,
      review_note: section.review_note,
      submitted_at: section.submitted_at,
      approved_at: section.approved_at || new Date().toISOString(),
      updated_by: actor.profile.id,
      updated_by_email: actor.user.email,
      updated_at: new Date().toISOString(),
    }, { onConflict: "onboarding_id,section_key" }).select("id").single();
    if (error) throw error;
    for (const document of (Array.isArray(section.documents) ? section.documents : [])) {
      const { data: source, error: sourceError } = await service.from("portal_brand_application_document")
        .select("*").eq("id", document.id).single();
      if (sourceError) throw sourceError;
      const destination = `${organizationId}/${onboardingSection.id}/${source.field_key}/${source.sha256}.${source.content_type === "application/pdf" ? "pdf" : source.content_type === "image/png" ? "png" : "jpg"}`;
      const { data: sourceBlob, error: downloadError } = await service.storage.from(APPLICATION_BUCKET)
        .download(String(source.object_path));
      if (downloadError || !sourceBlob) throw downloadError ?? new Error("The application document could not be read.");
      const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
      if (await sha256Hex(sourceBytes) !== source.sha256) {
        throw new ApplicationError(409, "An application document no longer matches its approved digest.");
      }
      const { error: copyError } = await service.storage.from(ONBOARDING_BUCKET).upload(
        destination,
        sourceBytes,
        { contentType: String(source.content_type), cacheControl: "0", upsert: false },
      );
      if (copyError && !clean(copyError.message, 500).toLowerCase().includes("already exists")) throw copyError;
      const { error: documentError } = await service.from("portal_brand_onboarding_document").upsert({
        section_id: onboardingSection.id,
        field_key: source.field_key,
        object_path: destination,
        original_name: source.original_name,
        content_type: source.content_type,
        size_bytes: source.size_bytes,
        sha256: source.sha256,
        scan_state: "clean",
        scan_provider: source.scan_provider,
        uploaded_by: actor.profile.id,
        uploaded_by_email: source.uploaded_by_email,
      }, { onConflict: "section_id,field_key,sha256" });
      if (documentError) throw documentError;
    }
  }

  let target = await findAuthUser(ownerEmail);
  if (!target) {
    const { data, error } = await service.auth.admin.inviteUserByEmail(ownerEmail, {
      data: { full_name: ownerName },
    });
    if (error || !data.user) throw error ?? new Error("The Brand Owner invitation was not created.");
    target = data.user as unknown as Row;
  }
  const { data: profile, error: profileReadError } = await service.from("portal_profile")
    .select("id,role").eq("id", target.id).maybeSingle();
  if (profileReadError) throw profileReadError;
  if (profile && !new Set(["brand", "internal"]).has(String(profile.role))) {
    throw new ApplicationError(409, "The Brand Owner email is already assigned to a Store account. Use a separate identity.");
  }
  if (!profile) {
    const { error } = await service.from("portal_profile").insert({
      id: target.id,
      full_name: ownerName,
      org: displayName,
      role: "brand",
      locations: null,
      active: true,
      staff_role: null,
    });
    if (error) throw error;
  }
  const { error: membershipError } = await service.from("portal_organization_membership").upsert({
    profile_id: target.id,
    organization_id: organizationId,
    workspace: "brand",
    member_role: "brand_owner",
    status: "active",
    is_default: !profile || profile.role === "brand",
    updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id,organization_id,workspace" });
  if (membershipError) throw membershipError;

  const now = new Date().toISOString();
  const { data: approved, error: applicationError } = await service.from("portal_brand_application").update({
    status: "approved",
    organization_id: organizationId,
    approved_at: now,
    decision_note: note || null,
    updated_at: now,
  }).eq("id", application.id).select("*").single();
  if (applicationError) throw applicationError;
  await logEvent(String(application.id), null, "application-approved", "internal", String(actor.user.email || ""), { organizationId, ownerEmail });
  return approved as Row;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  try {
    const body = await request.json().catch(() => ({})) as Row;
    const action = clean(body.action, 60).toLowerCase();
    if (!action) throw new ApplicationError(400, "Choose an application action.");
    if (PUBLIC_ACTIONS.has(action)) {
      if (action === "start") return await startApplication(request, body);
      if (action === "request-resume") return await requestResume(request, body);
      const application = await applicationForToken(body.token);
      if (action === "resume") return json(request, { ok: true, ...(await snapshot(application)) });
      if (action === "save-section" || action === "submit-section") {
        await saveSection(application, body, action === "submit-section");
        const refreshed = await service.from("portal_brand_application").select("*").eq("id", application.id).single();
        if (refreshed.error) throw refreshed.error;
        return json(request, { ok: true, ...(await snapshot(refreshed.data as Row)) });
      }
      if (action === "upload-document") {
        const document = await uploadDocument(application, body);
        return json(request, { ok: true, document }, 201);
      }
      if (action === "submit-application") {
        const submitted = await submitApplication(application);
        return json(request, { ok: true, ...(await snapshot(submitted)) });
      }
    }

    const actor = await internalActor(request);
    if (!actor) throw new ApplicationError(403, "Administrator access is required.");
    if (action === "internal-list") return json(request, { ok: true, applications: await internalList() });
    const applicationId = uuid(body.applicationId, "Brand application");
    const { data: application, error } = await service.from("portal_brand_application").select("*").eq("id", applicationId).maybeSingle();
    if (error) throw error;
    if (!application) throw new ApplicationError(404, "Brand application not found.");
    if (action === "internal-get") return json(request, { ok: true, ...(await snapshot(application as Row)) });
    if (action === "internal-review-section") {
      await reviewSection(applicationId, body, actor);
      const refreshed = await service.from("portal_brand_application").select("*").eq("id", applicationId).single();
      if (refreshed.error) throw refreshed.error;
      return json(request, { ok: true, ...(await snapshot(refreshed.data as Row)) });
    }
    if (action === "internal-document-link") {
      const documentId = uuid(body.documentId, "application document");
      const { data: document, error: documentError } = await service.from("portal_brand_application_document")
        .select("object_path,original_name,section_id").eq("id", documentId).maybeSingle();
      if (documentError) throw documentError;
      if (!document) throw new ApplicationError(404, "Application document not found.");
      const { data: documentSection, error: documentSectionError } = await service
        .from("portal_brand_application_section").select("application_id")
        .eq("id", document.section_id).eq("application_id", applicationId).maybeSingle();
      if (documentSectionError) throw documentSectionError;
      if (!documentSection) throw new ApplicationError(404, "Application document not found.");
      const { data: signed, error: signedError } = await service.storage.from(APPLICATION_BUCKET)
        .createSignedUrl(String(document.object_path), 300, { download: String(document.original_name) });
      if (signedError) throw signedError;
      return json(request, { ok: true, url: signed.signedUrl, expiresIn: 300 });
    }
    if (action === "internal-final") {
      const decision = clean(body.decision, 40);
      const note = clean(body.note, 4000);
      if (decision === "approve") {
        const approved = await approveApplication(application as Row, actor, note);
        return json(request, { ok: true, ...(await snapshot(approved)) });
      }
      if (decision === "reject") {
        if (!note) throw new ApplicationError(400, "Enter the rejection reason.");
        const now = new Date().toISOString();
        const { data: rejected, error: rejectError } = await service.from("portal_brand_application").update({
          status: "rejected",
          rejected_at: now,
          decision_note: note,
          updated_at: now,
        }).eq("id", applicationId).select("*").single();
        if (rejectError) throw rejectError;
        await logEvent(applicationId, null, "application-rejected", "internal", String(actor.user.email || ""), { note });
        return json(request, { ok: true, ...(await snapshot(rejected as Row)) });
      }
      throw new ApplicationError(400, "Choose approve or reject.");
    }
    throw new ApplicationError(400, "Unsupported application action.");
  } catch (error) {
    console.error("portal-brand-application", error);
    if (error instanceof ApplicationError) return json(request, { error: error.message }, error.status);
    return json(request, { error: "The Brand application service could not complete the request." }, 500);
  }
});
