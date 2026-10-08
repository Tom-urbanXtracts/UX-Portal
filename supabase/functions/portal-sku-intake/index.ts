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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = {
  user: Row;
  profile: Row;
  actorType: "internal" | "brand";
};
type Scope = {
  section: Row;
  intake: Row;
  invite?: Row;
  actorType: "internal" | "brand" | "contributor";
  actorEmail: string;
};

const SECTION_DEFINITIONS = [
  ["product_identity", "Product Identity & Ownership"],
  ["commercial_ordering", "Commercial & Ordering"],
  ["formulation_bom", "Formulation & Bill of Materials"],
  ["packaging_labeling", "Packaging & Labeling"],
  ["quality_compliance", "Manufacturing, Quality & Compliance"],
  ["marketing_launch", "Marketing, Integrations & Launch"],
] as const;
const REQUIRED_FIELDS: Record<string, string[]> = {
  product_identity: [
    "brand",
    "retail_product_name",
    "product_type",
    "product_category",
    "ownership_model",
    "economic_owner",
    "order_uom",
    "unit_size",
    "unit_size_uom",
  ],
  commercial_ordering: [
    "sale_availability",
    "price_status",
    "order_unit",
    "lead_time_days",
    "preorder_allowed",
  ],
  formulation_bom: [
    "formulation_summary",
    "component_rows",
    "target_yield",
    "allergen_status",
  ],
  packaging_labeling: [
    "primary_package",
    "net_quantity",
    "master_case_quantity",
    "child_resistant",
    "tamper_evident",
    "required_warnings",
  ],
  quality_compliance: [
    "manufacturing_facility",
    "manufacturing_method",
    "batch_size",
    "release_specification",
    "shelf_life",
    "storage_conditions",
    "quality_reviewer",
  ],
  marketing_launch: [
    "catalog_description",
    "selling_points",
    "catalog_visibility",
    "publication_state",
    "launch_approval",
  ],
};

function requiredFields(sectionKey: string, data: Row): string[] {
  const fields = [...(REQUIRED_FIELDS[sectionKey] ?? [])];
  if (
    sectionKey === "commercial_ordering" &&
    data.price_status === "Approved price"
  ) fields.push("standard_unit_price");
  if (
    sectionKey === "commercial_ordering" &&
    ["Case", "Unit and case"].includes(String(data.order_unit))
  ) fields.push("units_per_case");
  if (
    sectionKey === "formulation_bom" &&
    data.allergen_status === "Contains allergens"
  ) fields.push("allergen_detail");
  if (sectionKey === "quality_compliance" && data.solvent_used === "Yes") {
    fields.push("solvent_detail");
  }
  if (
    sectionKey === "marketing_launch" && data.catalog_visibility === "Published"
  ) fields.push("launch_date");
  return fields;
}

function sectionCompletion(sectionKey: string, data: Row): number {
  const required = requiredFields(sectionKey, data);
  if (!required.length) return 100;
  const complete = required.filter((key) => {
    const value = data[key];
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.length > 0;
    return String(value ?? "").trim().length > 0;
  }).length;
  return Math.round(complete / required.length * 100);
}
const EDITABLE = new Set([
  "not_started",
  "draft",
  "shared",
  "in_progress",
  "changes_requested",
  "reopened",
]);
const REVIEWABLE = new Set(["submitted"]);
const BRAND_RESTRICTED_FIELDS = new Set([
  "internal_product_name",
  "canix_item_id",
  "standard_unit_price",
  "applicable_agreement",
  "sales_notes",
  "quality_reviewer",
  "quickbooks_item_id",
  "catalog_visibility",
  "publication_state",
  "launch_approval",
  "final_internal_owner",
]);
const SECTION_DEFAULTS: Record<string, Row> = {
  commercial_ordering: { price_status: "Request for price" },
  quality_compliance: { quality_reviewer: "urbanXtracts Internal Review" },
  marketing_launch: {
    catalog_visibility: "Brand preview",
    publication_state: "Draft",
    launch_approval: "Pending",
  },
};
const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

class IntakeError extends Error {
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
function safeEmail(value: unknown): string {
  const email = clean(value, 320).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new IntakeError(400, "Enter a valid contributor email address.");
  }
  return email;
}
function safeData(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntakeError(400, "Section data must be an object.");
  }
  const entries = Object.entries(value as Row).slice(0, 160).map(
    ([key, entry]) => {
      const safeKey = clean(key, 80).replace(/[^a-zA-Z0-9_-]/g, "_");
      if (!safeKey) return null;
      if (typeof entry === "boolean") return [safeKey, entry];
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return [safeKey, entry];
      }
      if (Array.isArray(entry)) {
        return [
          safeKey,
          entry.slice(0, 100).map((item) => clean(item, 1000)),
        ];
      }
      return [safeKey, clean(entry, 12000)];
    },
  ).filter(Boolean) as [string, unknown][];
  const output = Object.fromEntries(entries);
  if (JSON.stringify(output).length > 100_000) {
    throw new IntakeError(413, "This section is too large to save.");
  }
  return output;
}
async function hashToken(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function interpolate(template: string, values: Row): string {
  return template.replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (_match, key) => clean(values[key], 2000),
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
async function sendSectionInvite(
  inviteId: string,
  recipient: string,
  variables: Row,
): Promise<string> {
  const { data: template, error: templateError } = await service.from(
    "portal_notification_template",
  ).select("*")
    .eq("template_key", "sku_section_assignment").eq(
      "approval_state",
      "approved",
    ).single();
  if (templateError) throw templateError;
  const eventKey = `sku-section-assignment:${inviteId}`;
  const { data: outbox, error } = await service.from(
    "portal_notification_outbox",
  ).insert({
    event_key: eventKey,
    event_type: "sku_section_assignment",
    template_key: template.template_key,
    template_version: template.version,
    audience: template.audience,
    mandatory: true,
    recipient_email: recipient,
    state: "pending",
    channel: "email",
    payload: variables,
    updated_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;
  if (!RESEND_API_KEY) {
    await service.from("portal_notification_outbox").update({
      state: "held_provider",
      last_error: "Email provider credentials are not configured.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return "held_provider";
  }
  const { data: claim, error: quotaError } = await service.rpc(
    "portal_claim_resend_free_quota",
    { p_outbox_id: outbox.id },
  );
  if (quotaError) throw quotaError;
  if (claim !== "claimed") return "held_quota";
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
      tags: [{ name: "template", value: "sku_section_assignment" }],
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
  }).eq("id", outbox.id);
  return "sent";
}
async function actorFor(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,full_name,org,role,staff_role,active").eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (
    !profile || profile.active === false ||
    !["internal", "brand"].includes(String(profile.role))
  ) {
    return null;
  }
  return {
    user,
    profile: profile as unknown as Row,
    actorType: profile.role === "internal" ? "internal" : "brand",
  };
}
async function staffHas(
  actor: Actor,
  required: "sku_intake.read" | "sku_intake.manage",
): Promise<boolean> {
  if (actor.actorType !== "internal") return false;
  const { data: grant, error } = await service.from(
    "portal_role_permission",
  )
    .select("permission").eq("staff_role", actor.profile.staff_role).eq(
      "permission",
      required,
    ).maybeSingle();
  if (error) throw error;
  return !!grant;
}
async function brandHas(
  actor: Actor,
  organizationId: string,
  permission: "brand.products.read" | "brand.products.contribute",
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return false;
  const { data: organization, error: organizationError } = await service.from(
    "portal_organization",
  ).select("id,kind,status").eq("id", organizationId).eq("kind", "brand")
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization || organization.status === "inactive") return false;
  if (actor.actorType === "internal") {
    return await staffHas(
      actor,
      permission === "brand.products.read"
        ? "sku_intake.read"
        : "sku_intake.manage",
    );
  }
  const { data: membership, error: membershipError } = await service.from(
    "portal_organization_membership",
  ).select("member_role").eq("profile_id", actor.profile.id).eq(
    "organization_id",
    organizationId,
  ).eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return false;
  const { data: grant, error } = await service.from(
    "portal_workspace_role_permission",
  ).select("permission").eq("workspace", "brand").eq(
    "member_role",
    membership.member_role,
  ).eq("permission", permission).maybeSingle();
  if (error) throw error;
  return !!grant;
}
function actorEmail(actor: Actor): string {
  return clean(actor.user.email ?? actor.profile.full_name, 320).toLowerCase();
}
async function logEvent(
  intakeId: string,
  sectionId: string | null,
  action: string,
  actorType: string,
  email: string,
  detail: Row = {},
): Promise<void> {
  const { error } = await service.from("portal_sku_intake_event").insert({
    intake_id: intakeId,
    section_id: sectionId,
    action,
    actor_type: actorType,
    actor_email: email || null,
    detail,
  });
  if (error) throw error;
}
async function snapshotSection(
  section: Row,
  action: string,
  actorType: string,
  email: string,
  note = "",
): Promise<void> {
  const { error } = await service.from("portal_sku_intake_section_revision")
    .insert({
      section_id: section.id,
      revision: section.revision,
      action,
      data: section.data ?? {},
      actor_type: actorType,
      actor_email: email || null,
      note: note || null,
    });
  if (error) throw error;
}
async function refreshIntakeStatus(intakeId: string): Promise<void> {
  const { data: sections, error } = await service.from(
    "portal_sku_intake_section",
  )
    .select("status").eq("intake_id", intakeId);
  if (error) throw error;
  const statuses = (sections ?? []).map((row) => String(row.status));
  let status = "draft";
  if (
    statuses.length === 6 && statuses.every((value) => value === "approved")
  ) status = "approved";
  else if (
    statuses.some((value) => ["changes_requested", "reopened"].includes(value))
  ) status = "changes_requested";
  else if (statuses.some((value) => value === "submitted")) {
    status = "in_review";
  } else if (statuses.some((value) => value !== "not_started")) {
    status = "in_progress";
  }
  const patch: Row = { status, updated_at: new Date().toISOString() };
  if (status !== "approved") {
    Object.assign(patch, {
      approved_by: null,
      approved_by_email: null,
      approved_at: null,
    });
  }
  const { error: updateError } = await service.from("portal_sku_intake").update(
    patch,
  ).eq("id", intakeId);
  if (updateError) throw updateError;
}
function brandSafeData(value: unknown): Row {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Row) }
    : {};
  for (const field of BRAND_RESTRICTED_FIELDS) delete data[field];
  return data;
}
function brandSafeSection(section: Row): Row {
  return {
    ...section,
    data: brandSafeData(section.data),
    assigned_email: undefined,
    updated_by_email: undefined,
  };
}
async function intakeSnapshot(
  id?: string,
  organizationId?: string,
  brandView = false,
): Promise<Row> {
  let query = service.from("portal_sku_intake").select("*").order(
    "updated_at",
    { ascending: false },
  ).limit(250);
  if (id) query = query.eq("id", id);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data: intakes, error } = await query;
  if (error) throw error;
  const ids = (intakes ?? []).map((row) => row.id);
  const { data: sections, error: sectionError } = ids.length
    ? await service.from("portal_sku_intake_section").select("*").in(
      "intake_id",
      ids,
    ).order("position")
    : { data: [], error: null };
  if (sectionError) throw sectionError;
  const sectionIds = (sections ?? []).map((row) => row.id);
  const { data: documents, error: documentError } = sectionIds.length
    ? await service.from("portal_sku_intake_document")
      .select(
        "id,section_id,field_key,original_name,content_type,size_bytes,created_at",
      )
      .in("section_id", sectionIds)
    : { data: [], error: null };
  if (documentError) throw documentError;
  const docsBySection = new Map<string, Row[]>();
  for (const document of documents ?? []) {
    const key = String(document.section_id);
    docsBySection.set(key, [
      ...(docsBySection.get(key) ?? []),
      document as Row,
    ]);
  }
  return {
    intakes: (intakes ?? []).map((intake) => ({
      ...intake,
      ...(brandView
        ? {
          created_by: undefined,
          created_by_email: undefined,
          approved_by: undefined,
          approved_by_email: undefined,
        }
        : {}),
      sections: (sections ?? []).filter((section) =>
        section.intake_id === intake.id
      )
        .map((section) => ({
          ...section,
          data: brandView ? brandSafeData(section.data) : section.data,
          ...(brandView
            ? { assigned_email: undefined, updated_by_email: undefined }
            : {}),
          documents: docsBySection.get(String(section.id)) ?? [],
        })),
    })),
  };
}
async function externalScope(token: string): Promise<Scope> {
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) {
    throw new IntakeError(
      404,
      "This section link is invalid or no longer active.",
    );
  }
  const { data: invite, error } = await service.from(
    "portal_sku_intake_section_invite",
  ).select("*")
    .eq("token_hash", await hashToken(token)).eq("active", true).maybeSingle();
  if (error) throw error;
  if (!invite) {
    throw new IntakeError(
      404,
      "This section link is invalid or no longer active.",
    );
  }
  if (new Date(String(invite.expires_at)).getTime() <= Date.now()) {
    throw new IntakeError(
      410,
      "This section link has expired. Ask urbanXtracts for a current link.",
    );
  }
  const { data: section, error: sectionError } = await service.from(
    "portal_sku_intake_section",
  ).select("*").eq("id", invite.section_id).single();
  if (sectionError) throw sectionError;
  const { data: intake, error: intakeError } = await service.from(
    "portal_sku_intake",
  ).select("id,reference,brand_name,product_name,status").eq(
    "id",
    section.intake_id,
  ).single();
  if (intakeError) throw intakeError;
  if (!EDITABLE.has(String(section.status))) {
    throw new IntakeError(
      409,
      "This section is locked while urbanXtracts reviews it.",
    );
  }
  const now = new Date().toISOString();
  await service.from("portal_sku_intake_section_invite").update({
    last_used_at: now,
    access_count: Number(invite.access_count || 0) + 1,
  }).eq("id", invite.id);
  return {
    section: section as Row,
    intake: intake as Row,
    invite: invite as Row,
    actorType: "contributor",
    actorEmail: clean(invite.contributor_email, 320).toLowerCase(),
  };
}
async function authenticatedScope(
  actor: Actor,
  sectionId: string,
  organizationId: string,
  access: "read" | "contribute" | "manage",
): Promise<Scope> {
  const { data: section, error } = await service.from(
    "portal_sku_intake_section",
  ).select("*").eq("id", sectionId).maybeSingle();
  if (error) throw error;
  if (!section) throw new IntakeError(404, "SKU intake section not found.");
  const { data: intake, error: intakeError } = await service.from(
    "portal_sku_intake",
  ).select("*").eq("id", section.intake_id).single();
  if (intakeError) throw intakeError;
  if (access === "manage") {
    if (!await staffHas(actor, "sku_intake.manage")) {
      throw new IntakeError(
        403,
        "Only an authorized Internal reviewer can perform this action.",
      );
    }
  } else if (organizationId) {
    if (String(intake.organization_id || "") !== organizationId) {
      throw new IntakeError(404, "SKU intake section not found.");
    }
    const permission = access === "read"
      ? "brand.products.read"
      : "brand.products.contribute";
    if (!await brandHas(actor, organizationId, permission)) {
      throw new IntakeError(
        403,
        "This SKU intake is outside your Brand access scope.",
      );
    }
  } else if (
    actor.actorType !== "internal" ||
    !await staffHas(
      actor,
      access === "read" ? "sku_intake.read" : "sku_intake.manage",
    )
  ) {
    throw new IntakeError(403, "Forbidden");
  }
  return {
    section: section as Row,
    intake: intake as Row,
    actorType: actor.actorType,
    actorEmail: actorEmail(actor),
  };
}
async function saveSection(
  scope: Scope,
  body: Row,
  submit: boolean,
): Promise<Row> {
  const section = scope.section;
  if (!EDITABLE.has(String(section.status))) {
    throw new IntakeError(
      409,
      "This section is locked while it is being reviewed or after approval.",
    );
  }
  const expected = Number(body.expectedRevision);
  if (!Number.isInteger(expected) || expected !== Number(section.revision)) {
    throw new IntakeError(
      409,
      "This section changed elsewhere. Refresh before saving again.",
    );
  }
  let data = safeData(body.data);
  if (scope.actorType !== "internal") {
    const current = scope.section.data && typeof scope.section.data === "object"
      ? scope.section.data as Row
      : {};
    for (const field of BRAND_RESTRICTED_FIELDS) {
      if (current[field] !== undefined) data[field] = current[field];
      else delete data[field];
    }
    if (String(section.section_key) === "product_identity") {
      data.brand = scope.intake.brand_name;
    }
  }
  const completion = sectionCompletion(String(section.section_key), data);
  if (submit && completion < 100) {
    throw new IntakeError(
      400,
      "Complete every required field before submitting this section.",
    );
  }
  const nextRevision = expected + 1;
  const status = submit
    ? "submitted"
    : completion > 0
    ? "in_progress"
    : "draft";
  const patch: Row = {
    data,
    completion_percent: completion,
    revision: nextRevision,
    status,
    updated_by_email: scope.actorEmail || null,
    updated_at: new Date().toISOString(),
  };
  if (submit) {
    Object.assign(patch, {
      submitted_at: new Date().toISOString(),
      review_note: null,
    });
  }
  const { data: updated, error } = await service.from(
    "portal_sku_intake_section",
  ).update(patch)
    .eq("id", section.id).eq("revision", expected).select("*").maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new IntakeError(
      409,
      "This section changed elsewhere. Refresh before saving again.",
    );
  }
  await snapshotSection(
    updated as Row,
    submit ? "submitted" : "saved",
    scope.actorType,
    scope.actorEmail,
  );
  await logEvent(
    String(section.intake_id),
    String(section.id),
    submit ? "section-submitted" : "section-saved",
    scope.actorType,
    scope.actorEmail,
    { revision: nextRevision, completionPercent: completion },
  );
  if (submit && scope.invite) {
    await service.from("portal_sku_intake_section_invite").update({
      active: false,
      revoked_at: new Date().toISOString(),
    }).eq("id", scope.invite.id);
  }
  await refreshIntakeStatus(String(section.intake_id));
  return updated as Row;
}
function decodeFile(
  file: Row,
): { bytes: Uint8Array; contentType: string; name: string } {
  const encoded = clean(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new IntakeError(400, "The document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (
    !declared || bytes.byteLength !== declared ||
    bytes.byteLength > 10 * 1024 * 1024
  ) throw new IntakeError(400, "Documents must be 10 MB or smaller.");
  const contentType = clean(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (
    !((contentType === "application/pdf" && pdf) ||
      (contentType === "image/png" && png) ||
      (contentType === "image/jpeg" && jpeg))
  ) {
    throw new IntakeError(
      400,
      "Use a PDF, PNG, or JPEG whose contents match its file type.",
    );
  }
  return {
    bytes,
    contentType,
    name: clean(file.name, 240) || "supporting-document",
  };
}
async function uploadDocument(scope: Scope, body: Row): Promise<Row> {
  if (!EDITABLE.has(String(scope.section.status))) {
    throw new IntakeError(409, "This section is locked.");
  }
  const file = body.file && typeof body.file === "object"
    ? body.file as Row
    : {};
  const fieldKey = clean(body.fieldKey, 80).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!fieldKey) throw new IntakeError(400, "The document field is required.");
  const { bytes, contentType, name } = decodeFile(file);
  const digest = await sha256Hex(bytes);
  let scan;
  try {
    scan = await scanContent(bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new IntakeError(
        422,
        "The document was blocked by malware scanning.",
      );
    }
    throw new IntakeError(
      503,
      "The document could not be verified as clean. Nothing was stored; try again later.",
    );
  }
  const extension = contentType === "application/pdf"
    ? "pdf"
    : contentType === "image/png"
    ? "png"
    : "jpg";
  const objectPath =
    `${scope.intake.id}/${scope.section.id}/${fieldKey}/${digest}.${extension}`;
  const { error: uploadError } = await service.storage.from(
    "portal-sku-intake-documents",
  ).upload(objectPath, bytes, {
    contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (
    uploadError &&
    !String(uploadError.message || "").toLowerCase().includes("already exists")
  ) throw uploadError;
  const { data: document, error } = await service.from(
    "portal_sku_intake_document",
  ).upsert({
    section_id: scope.section.id,
    field_key: fieldKey,
    object_path: objectPath,
    original_name: name,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: digest,
    scan_state: "clean",
    scan_provider: clean(scan.engine, 120) || "configured-scanner",
    uploaded_by_type: scope.actorType,
    uploaded_by_email: scope.actorEmail || null,
  }, { onConflict: "section_id,field_key,sha256" }).select(
    "id,section_id,field_key,original_name,content_type,size_bytes,created_at",
  ).single();
  if (error) throw error;
  await logEvent(
    String(scope.section.intake_id),
    String(scope.section.id),
    "document-uploaded",
    scope.actorType,
    scope.actorEmail,
    { fieldKey, documentId: document.id, sha256: digest },
  );
  return document as Row;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const body = await request.json().catch(() => ({})) as Row;
    const action = clean(body.action, 50).toLowerCase();
    if (
      ["resolve", "save-section", "submit-section", "upload-document"].includes(
        action,
      ) && clean(body.token, 100)
    ) {
      const scope = await externalScope(clean(body.token, 100));
      if (action === "resolve") {
        const { data: documents, error } = await service.from(
          "portal_sku_intake_document",
        ).select(
          "id,field_key,original_name,content_type,size_bytes,created_at",
        ).eq("section_id", scope.section.id).order("created_at");
        if (error) throw error;
        return json(request, {
          ok: true,
          intake: scope.intake,
          section: brandSafeSection({
            ...scope.section,
            documents: documents ?? [],
          }),
        });
      }
      if (action === "upload-document") {
        return json(request, {
          ok: true,
          document: await uploadDocument(scope, body),
        }, 201);
      }
      return json(request, {
        ok: true,
        section: brandSafeSection(
          await saveSection(scope, body, action === "submit-section"),
        ),
      });
    }

    const readActor = await actorFor(request);
    if (!readActor) return json(request, { error: "Forbidden" }, 403);
    const organizationId = clean(body.organizationId, 80);
    if (
      organizationId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(organizationId)
    ) throw new IntakeError(400, "Choose a valid Brand organization.");
    if (readActor.actorType === "brand" && !organizationId) {
      throw new IntakeError(400, "Choose your Brand workspace.");
    }
    if (action === "list") {
      const allowed = organizationId
        ? await brandHas(readActor, organizationId, "brand.products.read")
        : await staffHas(readActor, "sku_intake.read");
      if (!allowed) throw new IntakeError(403, "Forbidden");
      return json(request, {
        ok: true,
        ...(await intakeSnapshot(
          undefined,
          organizationId || undefined,
          readActor.actorType === "brand",
        )),
      });
    }
    if (action === "get") {
      const allowed = organizationId
        ? await brandHas(readActor, organizationId, "brand.products.read")
        : await staffHas(readActor, "sku_intake.read");
      if (!allowed) throw new IntakeError(403, "Forbidden");
      return json(request, {
        ok: true,
        ...(await intakeSnapshot(
          clean(body.intakeId, 80),
          organizationId || undefined,
          readActor.actorType === "brand",
        )),
      });
    }
    if (action === "create") {
      let brandName = clean(body.brandName, 200);
      const productName = clean(body.productName, 300);
      if (organizationId) {
        if (
          !await brandHas(
            readActor,
            organizationId,
            "brand.products.contribute",
          )
        ) {
          throw new IntakeError(
            403,
            "Your Brand role cannot create SKU intakes.",
          );
        }
        const { data: organization, error: organizationError } = await service
          .from("portal_organization").select("display_name")
          .eq("id", organizationId).eq("kind", "brand").single();
        if (organizationError) throw organizationError;
        brandName = clean(organization.display_name, 200);
      } else if (!await staffHas(readActor, "sku_intake.manage")) {
        throw new IntakeError(403, "Forbidden");
      }
      if (!brandName || !productName) {
        throw new IntakeError(400, "Brand and product name are required.");
      }
      const email = actorEmail(readActor);
      const { data: intake, error } = await service.from("portal_sku_intake")
        .insert({
          organization_id: organizationId || null,
          brand_name: brandName,
          product_name: productName,
          created_by: readActor.profile.id,
          created_by_email: email,
        }).select("*").single();
      if (error) throw error;
      const { error: sectionError } = await service.from(
        "portal_sku_intake_section",
      ).insert(SECTION_DEFINITIONS.map(([key, title], index) => {
        const data: Row = {
          ...(SECTION_DEFAULTS[key] ?? {}),
          ...(key === "product_identity" ? { brand: brandName } : {}),
        };
        return {
          intake_id: intake.id,
          section_key: key,
          position: index + 1,
          title,
          data,
          completion_percent: sectionCompletion(key, data),
        };
      }));
      if (sectionError) {
        await service.from("portal_sku_intake").delete().eq("id", intake.id);
        throw sectionError;
      }
      await logEvent(
        String(intake.id),
        null,
        "intake-created",
        readActor.actorType,
        email,
        { brandName, productName },
      );
      return json(request, {
        ok: true,
        ...(await intakeSnapshot(
          String(intake.id),
          organizationId || undefined,
          readActor.actorType === "brand",
        )),
      }, 201);
    }
    const sectionId = clean(body.sectionId, 80);
    if (action === "save-section" || action === "submit-section") {
      const scope = await authenticatedScope(
        readActor,
        sectionId,
        organizationId,
        "contribute",
      );
      return json(request, {
        ok: true,
        section: readActor.actorType === "brand"
          ? brandSafeSection(
            await saveSection(scope, body, action === "submit-section"),
          )
          : await saveSection(scope, body, action === "submit-section"),
      });
    }
    if (action === "upload-document") {
      const scope = await authenticatedScope(
        readActor,
        sectionId,
        organizationId,
        "contribute",
      );
      return json(request, {
        ok: true,
        document: await uploadDocument(scope, body),
      }, 201);
    }
    const scope = await authenticatedScope(
      readActor,
      sectionId,
      organizationId,
      "manage",
    );
    if (action === "create-invite") {
      if (!EDITABLE.has(String(scope.section.status))) {
        throw new IntakeError(409, "Only an editable section can be shared.");
      }
      const email = safeEmail(body.contributorEmail);
      const days = Math.max(1, Math.min(30, Number(body.expiresInDays) || 7));
      const token = newToken(), now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      await service.from("portal_sku_intake_section_invite").update({
        active: false,
        revoked_at: now,
      }).eq("section_id", sectionId).eq("active", true);
      const { data: invite, error } = await service.from(
        "portal_sku_intake_section_invite",
      ).insert({
        section_id: sectionId,
        token_hash: await hashToken(token),
        token_prefix: token.slice(0, 8),
        contributor_email: email || null,
        expires_at: expiresAt,
        created_by: readActor.profile.id,
        created_by_email: actorEmail(readActor),
      }).select("id").single();
      if (error) throw error;
      if (["not_started", "draft"].includes(String(scope.section.status))) {
        await service.from("portal_sku_intake_section").update({
          status: "shared",
          assigned_email: email || null,
          updated_at: now,
        }).eq("id", sectionId);
      }
      await logEvent(
        String(scope.section.intake_id),
        sectionId,
        "section-link-created",
        "internal",
        actorEmail(readActor),
        { contributorEmail: email || null, expiresInDays: days },
      );
      const sectionUrl =
        `https://portal.urbanxtracts.com/#sku-section=${token}`;
      let emailState = "not_requested";
      if (email) {
        try {
          emailState = await sendSectionInvite(String(invite.id), email, {
            sectionTitle: scope.section.title,
            productName: scope.intake.product_name,
            brandName: scope.intake.brand_name,
            reference: scope.intake.reference,
            expiresOn: new Intl.DateTimeFormat("en-US", {
              month: "2-digit",
              day: "2-digit",
              year: "numeric",
              timeZone: "America/New_York",
            }).format(new Date(expiresAt)),
            sectionUrl,
          });
        } catch (notificationError) {
          console.error("sku section invitation email", notificationError);
          emailState = "failed";
        }
      }
      return json(request, { ok: true, token, sectionUrl, emailState }, 201);
    }
    if (action === "review-section") {
      if (!REVIEWABLE.has(String(scope.section.status))) {
        throw new IntakeError(409, "Only a submitted section can be reviewed.");
      }
      const decision = clean(body.decision, 30), note = clean(body.note, 4000);
      if (!["approve", "request_changes"].includes(decision)) {
        throw new IntakeError(400, "Choose approve or request changes.");
      }
      if (decision === "request_changes" && !note) {
        throw new IntakeError(400, "Describe the required change.");
      }
      const nextRevision = Number(scope.section.revision) + 1;
      const patch: Row = {
        revision: nextRevision,
        status: decision === "approve" ? "approved" : "changes_requested",
        review_note: note || null,
        updated_at: new Date().toISOString(),
        updated_by_email: actorEmail(readActor),
      };
      if (decision === "approve") patch.approved_at = new Date().toISOString();
      else patch.approved_at = null;
      const { data: updated, error } = await service.from(
        "portal_sku_intake_section",
      ).update(patch).eq("id", sectionId).eq("revision", scope.section.revision)
        .select("*").maybeSingle();
      if (error) throw error;
      if (!updated) {
        throw new IntakeError(
          409,
          "The section changed before this decision was saved.",
        );
      }
      await snapshotSection(
        updated as Row,
        decision === "approve" ? "approved" : "changes_requested",
        "internal",
        actorEmail(readActor),
        note,
      );
      await service.from("portal_sku_intake_section_invite").update({
        active: false,
        revoked_at: new Date().toISOString(),
      }).eq("section_id", sectionId).eq("active", true);
      await logEvent(
        String(scope.section.intake_id),
        sectionId,
        decision === "approve"
          ? "section-approved"
          : "section-changes-requested",
        "internal",
        actorEmail(readActor),
        { note },
      );
      await refreshIntakeStatus(String(scope.section.intake_id));
      if (decision === "approve") {
        const { data: intake } = await service.from("portal_sku_intake").select(
          "status",
        ).eq("id", scope.section.intake_id).single();
        if (intake?.status === "approved") {
          await service.from("portal_sku_intake").update({
            approved_by: readActor.profile.id,
            approved_by_email: actorEmail(readActor),
            approved_at: new Date().toISOString(),
          }).eq("id", scope.section.intake_id);
        }
      }
      return json(request, {
        ok: true,
        ...(await intakeSnapshot(String(scope.section.intake_id))),
      });
    }
    if (action === "reopen-section") {
      if (scope.section.status !== "approved") {
        throw new IntakeError(409, "Only an approved section can be reopened.");
      }
      const note = clean(body.note, 4000);
      if (!note) {
        throw new IntakeError(
          400,
          "Record why this approved section is being reopened.",
        );
      }
      const nextRevision = Number(scope.section.revision) + 1;
      const { data: updated, error } = await service.from(
        "portal_sku_intake_section",
      ).update({
        status: "reopened",
        revision: nextRevision,
        review_note: note,
        approved_at: null,
        updated_at: new Date().toISOString(),
        updated_by_email: actorEmail(readActor),
      }).eq("id", sectionId).eq("revision", scope.section.revision).select("*")
        .maybeSingle();
      if (error) throw error;
      if (!updated) {
        throw new IntakeError(
          409,
          "The section changed before it could be reopened.",
        );
      }
      await snapshotSection(
        updated as Row,
        "reopened",
        "internal",
        actorEmail(readActor),
        note,
      );
      await logEvent(
        String(scope.section.intake_id),
        sectionId,
        "approved-section-reopened",
        "internal",
        actorEmail(readActor),
        { note },
      );
      await refreshIntakeStatus(String(scope.section.intake_id));
      return json(request, {
        ok: true,
        ...(await intakeSnapshot(String(scope.section.intake_id))),
      });
    }
    throw new IntakeError(400, "Unknown SKU intake action.");
  } catch (error) {
    const status = error instanceof IntakeError ? error.status : 500;
    console.error("portal-sku-intake", error);
    return json(request, {
      error: status === 500
        ? "SKU intake could not complete the request."
        : error instanceof Error
        ? error.message
        : "Request failed.",
    }, status);
  }
});
