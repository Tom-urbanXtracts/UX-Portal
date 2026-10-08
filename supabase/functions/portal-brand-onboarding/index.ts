import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import {
  ContentScanError,
  scanContent,
  sha256Hex,
} from "../_shared/content-scanner.ts";
import { mondayAccessToken } from "../_shared/monday-connection.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_BRAND_ONBOARDING_BOARD_ID =
  Deno.env.get("MONDAY_BRAND_ONBOARDING_BOARD_ID") ?? "";

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = {
  user: Row;
  profile: Row;
  organization: Row;
  membership: Row | null;
  scope: "brand" | "internal";
  canManage: boolean;
  canReview: boolean;
};

const SECTION_DEFINITIONS = [
  {
    key: "company",
    title: "Company profile",
    required: [
      "legal_name",
      "entity_type",
      "address_line_1",
      "city",
      "state",
      "postal_code",
    ],
  },
  {
    key: "contacts",
    title: "Contacts and authorized users",
    required: [
      "primary_name",
      "primary_email",
      "primary_phone",
      "shipping_name",
      "shipping_email",
      "shipping_phone",
    ],
  },
  {
    key: "billing",
    title: "Billing and remittance",
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
    title: "Qualified-vendor information",
    required: ["vendor_status", "quality_contact", "insurance_status"],
  },
  {
    key: "identifiers",
    title: "Operating identifiers",
    required: ["license_type", "license_number", "nci_status"],
  },
  {
    key: "documents",
    title: "Documents and attestations",
    required: ["document_attestation"],
  },
] as const;

const EDITABLE = new Set([
  "not_started",
  "draft",
  "in_progress",
  "changes_requested",
  "reopened",
]);

const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

class OnboardingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function origin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.has(candidate)
    ? candidate
    : "https://portal.urbanxtracts.com";
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

function uuidValue(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new OnboardingError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function safeData(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OnboardingError(400, "Section data must be an object.");
  }
  const entries = Object.entries(value as Row).slice(0, 120).map(
    ([key, entry]) => {
      const safeKey = clean(key, 80).replace(/[^a-zA-Z0-9_-]/g, "_");
      if (!safeKey) return null;
      if (typeof entry === "boolean") return [safeKey, entry];
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return [safeKey, entry];
      }
      if (Array.isArray(entry)) {
        return [safeKey, entry.slice(0, 50).map((item) => clean(item, 1000))];
      }
      return [safeKey, clean(entry, 12_000)];
    },
  ).filter(Boolean) as [string, unknown][];
  const output = Object.fromEntries(entries);
  if (JSON.stringify(output).length > 100_000) {
    throw new OnboardingError(413, "This section is too large to save.");
  }
  return output;
}

function actorEmail(actor: Actor): string {
  return clean(actor.user.email || actor.profile.full_name, 320).toLowerCase();
}

async function permission(profile: Row, name: string): Promise<boolean> {
  if (profile.role !== "internal") return false;
  const { data, error } = await service.from("portal_role_permission")
    .select("permission")
    .eq("staff_role", profile.staff_role).eq("permission", name).maybeSingle();
  if (error) throw error;
  return !!data;
}

async function actorFor(
  request: Request,
  organizationId: string,
): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) throw new OnboardingError(403, "Forbidden");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new OnboardingError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data: profile, error: profileError } = await service.from(
    "portal_profile",
  ).select("id,full_name,org,role,staff_role,active").eq("id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.active === false) {
    throw new OnboardingError(403, "Forbidden");
  }
  const { data: organization, error: organizationError } = await service.from(
    "portal_organization",
  ).select("id,kind,legal_name,display_name,status").eq("id", organizationId)
    .eq("kind", "brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) {
    throw new OnboardingError(404, "Brand organization not found.");
  }

  if (profile.role === "internal") {
    const canManage = await permission(profile as Row, "accounts.manage");
    const canReview = canManage;
    if (!canManage) throw new OnboardingError(403, "Forbidden");
    return {
      user,
      profile: profile as Row,
      organization: organization as Row,
      membership: null,
      scope: "internal",
      canManage,
      canReview,
    };
  }

  const { data: membership, error: membershipError } = await service.from(
    "portal_organization_membership",
  ).select("id,member_role,status").eq("profile_id", user.id)
    .eq("organization_id", organizationId).eq("workspace", "brand")
    .eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership || profile.role !== "brand") {
    throw new OnboardingError(403, "Forbidden");
  }
  const { data: permissions, error: permissionError } = await service.from(
    "portal_workspace_role_permission",
  ).select("permission").eq("workspace", "brand")
    .eq("member_role", membership.member_role)
    .in("permission", ["brand.company.read", "brand.company.manage"]);
  if (permissionError) throw permissionError;
  const names = new Set(
    (permissions ?? []).map((row) => String(row.permission)),
  );
  if (!names.has("brand.company.read")) {
    throw new OnboardingError(403, "Forbidden");
  }
  return {
    user,
    profile: profile as Row,
    organization: organization as Row,
    membership: membership as Row,
    scope: "brand",
    canManage: names.has("brand.company.manage"),
    canReview: false,
  };
}

async function ensureOnboarding(actor: Actor): Promise<Row> {
  const organizationId = String(actor.organization.id);
  const { data: existing, error: existingError } = await service.from(
    "portal_brand_onboarding",
  ).select("*").eq("organization_id", organizationId).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing as Row;
  const { data: onboarding, error } = await service.from(
    "portal_brand_onboarding",
  ).insert({ organization_id: organizationId }).select("*").single();
  if (error) {
    if (String(error.code) === "23505") {
      const { data: raced, error: racedError } = await service.from(
        "portal_brand_onboarding",
      ).select("*").eq("organization_id", organizationId).single();
      if (racedError) throw racedError;
      return raced as Row;
    }
    throw error;
  }
  const { error: sectionError } = await service.from(
    "portal_brand_onboarding_section",
  ).insert(SECTION_DEFINITIONS.map((definition, index) => ({
    onboarding_id: onboarding.id,
    section_key: definition.key,
    position: index + 1,
    title: definition.title,
  })));
  if (sectionError) throw sectionError;
  await logEvent(actor, onboarding as Row, null, "onboarding-created", {});
  return onboarding as Row;
}

async function logEvent(
  actor: Actor,
  onboarding: Row,
  sectionId: string | null,
  action: string,
  detail: Row,
): Promise<void> {
  const { error } = await service.from("portal_brand_onboarding_event").insert({
    onboarding_id: onboarding.id,
    section_id: sectionId,
    action,
    actor_id: actor.user.id,
    actor_email: actorEmail(actor),
    actor_scope: actor.scope,
    detail,
  });
  if (error) throw error;
}

async function snapshot(
  actor: Actor,
  section: Row,
  action: string,
  note = "",
): Promise<void> {
  const { error } = await service.from(
    "portal_brand_onboarding_section_revision",
  ).insert({
    section_id: section.id,
    revision: section.revision,
    action,
    data: section.data ?? {},
    actor_id: actor.user.id,
    actor_email: actorEmail(actor),
    note: note || null,
  });
  if (error) throw error;
}

function definitionFor(section: Row) {
  return SECTION_DEFINITIONS.find((definition) =>
    definition.key === String(section.section_key)
  );
}

function completion(section: Row, data: Row): number {
  const definition = definitionFor(section);
  if (!definition) return 0;
  const required = [...definition.required] as string[];
  if (section.section_key === "billing" && data.payment_terms_request === "Other / discuss") {
    required.push("billing_notes");
  }
  if (section.section_key === "qualified_vendor") {
    if (data.vendor_status === "Not applicable") {
      const index = required.indexOf("quality_contact");
      if (index >= 0) required.splice(index, 1);
    }
    if (data.insurance_status === "Current") required.push("insurance_expiration");
  }
  if (section.section_key === "identifiers") {
    if (clean(data.license_number, 500)) required.push("license_expiration");
    if (data.nci_status === "Provided") required.push("nci_identifier");
  }
  const complete = [...new Set(required)].filter((key) => {
    const value = data[key];
    return typeof value === "boolean" ? value : clean(value, 12_000).length > 0;
  }).length;
  const uniqueRequired = [...new Set(required)];
  return uniqueRequired.length ? Math.round(complete / uniqueRequired.length * 100) : 100;
}

async function refreshOnboarding(onboardingId: string): Promise<Row> {
  const { data: onboarding, error: onboardingError } = await service.from(
    "portal_brand_onboarding",
  ).select("*").eq("id", onboardingId).single();
  if (onboardingError) throw onboardingError;
  const { data: sections, error } = await service.from(
    "portal_brand_onboarding_section",
  ).select("status").eq("onboarding_id", onboardingId);
  if (error) throw error;
  const states = (sections ?? []).map((row) => String(row.status));
  let status = "draft";
  if (
    states.length === SECTION_DEFINITIONS.length &&
    states.every((state) => state === "approved")
  ) {
    status = "approved";
  } else if (
    states.some((state) => ["changes_requested", "reopened"].includes(state))
  ) {
    status = "changes_requested";
  } else if (states.some((state) => state === "submitted")) {
    status = "in_review";
  } else if (states.some((state) => state !== "not_started")) {
    status = "in_progress";
  }
  const wasApproved = onboarding.status === "approved";
  const nextRevision = status === "approved" && !wasApproved
    ? Number(onboarding.revision) + 1
    : Number(onboarding.revision);
  const patch: Row = {
    status,
    revision: nextRevision,
    updated_at: new Date().toISOString(),
  };
  if (status !== "approved") {
    Object.assign(patch, {
      approved_by: null,
      approved_by_email: null,
      approved_at: null,
      monday_handoff_state: "not_ready",
    });
  } else if (!wasApproved) {
    Object.assign(patch, {
      monday_handoff_state: "portal_native",
      monday_handoff_error: null,
    });
  }
  const { data: updated, error: updateError } = await service.from(
    "portal_brand_onboarding",
  ).update(patch).eq("id", onboardingId).select("*").single();
  if (updateError) throw updateError;
  return updated as Row;
}

async function onboardingPayload(onboarding: Row): Promise<Row> {
  const { data: organization, error: organizationError } = await service.from(
    "portal_organization",
  ).select("id,legal_name,display_name").eq("id", onboarding.organization_id)
    .single();
  if (organizationError) throw organizationError;
  const { data: sections, error: sectionError } = await service.from(
    "portal_brand_onboarding_section",
  ).select("section_key,title,data,revision,approved_at").eq(
    "onboarding_id",
    onboarding.id,
  ).order("position");
  if (sectionError) throw sectionError;
  return {
    reference: onboarding.reference,
    organization,
    onboardingRevision: onboarding.revision,
    approvedAt: onboarding.approved_at,
    sections: sections ?? [],
  };
}

async function snapshotFor(actor: Actor): Promise<Row> {
  const onboarding = await ensureOnboarding(actor);
  const { data: sections, error: sectionError } = await service.from(
    "portal_brand_onboarding_section",
  ).select("*").eq("onboarding_id", onboarding.id).order("position");
  if (sectionError) throw sectionError;
  const sectionIds = (sections ?? []).map((section) => section.id);
  const { data: documents, error: documentError } = sectionIds.length
    ? await service.from("portal_brand_onboarding_document")
      .select(
        "id,section_id,field_key,original_name,content_type,size_bytes,created_at",
      )
      .in("section_id", sectionIds).order("created_at")
    : { data: [], error: null };
  if (documentError) throw documentError;
  const { data: members, error: memberError } = await service.from(
    "portal_organization_membership",
  ).select("id,profile_id,member_role,status,portal_profile!inner(full_name)")
    .eq("organization_id", actor.organization.id).eq("workspace", "brand")
    .eq("status", "active");
  if (memberError) throw memberError;
  const docsBySection = new Map<string, Row[]>();
  for (const document of documents ?? []) {
    const key = String(document.section_id);
    docsBySection.set(key, [
      ...(docsBySection.get(key) ?? []),
      document as Row,
    ]);
  }
  const memberRows = (members ?? []).map((member) => {
    const joined = member.portal_profile as Row | Row[] | null;
    const profile = Array.isArray(joined) ? joined[0] : joined;
    return {
      membershipId: member.id,
      profileId: member.profile_id,
      name: clean(profile?.full_name, 200) || "Brand member",
      role: member.member_role,
    };
  });
  const currentMembershipId = actor.membership
    ? String(actor.membership.id)
    : "";
  return {
    organization: actor.organization,
    onboarding,
    sections: (sections ?? []).map((section) => ({
      ...section,
      documents: docsBySection.get(String(section.id)) ?? [],
      canEdit: actor.canManage || (
        !!currentMembershipId &&
        String(section.assigned_membership_id || "") === currentMembershipId
      ),
      canReview: actor.canReview,
    })),
    members: memberRows,
    capabilities: {
      canManage: actor.canManage,
      canReview: actor.canReview,
      canAssign: actor.scope === "internal" && actor.canManage,
      scope: actor.scope,
    },
  };
}

async function sectionFor(
  actor: Actor,
  sectionId: string,
): Promise<{ onboarding: Row; section: Row }> {
  const onboarding = await ensureOnboarding(actor);
  const { data: section, error } = await service.from(
    "portal_brand_onboarding_section",
  ).select("*").eq("id", sectionId).eq("onboarding_id", onboarding.id)
    .maybeSingle();
  if (error) throw error;
  if (!section) throw new OnboardingError(404, "Onboarding section not found.");
  return { onboarding, section: section as Row };
}

function mayEdit(actor: Actor, section: Row): boolean {
  return actor.canManage || !!(
    actor.membership &&
    String(section.assigned_membership_id || "") === String(actor.membership.id)
  );
}

async function saveSection(
  actor: Actor,
  onboarding: Row,
  section: Row,
  body: Row,
  submit: boolean,
): Promise<void> {
  if (!mayEdit(actor, section)) {
    throw new OnboardingError(403, "This section is not assigned to you.");
  }
  if (!EDITABLE.has(String(section.status))) {
    throw new OnboardingError(409, "This section is locked for review.");
  }
  const expectedRevision = Number(body.expectedRevision);
  if (
    !Number.isInteger(expectedRevision) ||
    expectedRevision !== Number(section.revision)
  ) {
    throw new OnboardingError(
      409,
      "This section changed elsewhere. Refresh before saving.",
    );
  }
  const data = safeData(body.data);
  const percent = completion(section, data);
  if (submit && percent < 100) {
    throw new OnboardingError(
      409,
      "Complete every required field before submitting this section.",
    );
  }
  const nextRevision = Number(section.revision) + 1;
  const now = new Date().toISOString();
  const { data: updated, error } = await service.from(
    "portal_brand_onboarding_section",
  ).update({
    data,
    completion_percent: percent,
    revision: nextRevision,
    status: submit ? "submitted" : "draft",
    submitted_at: submit ? now : null,
    approved_at: null,
    review_note: submit ? null : section.review_note,
    updated_by: actor.user.id,
    updated_by_email: actorEmail(actor),
    updated_at: now,
  }).eq("id", section.id).eq("revision", expectedRevision).select("*")
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new OnboardingError(
      409,
      "This section changed before it could be saved.",
    );
  }
  await snapshot(actor, updated as Row, submit ? "submitted" : "saved");
  await logEvent(
    actor,
    onboarding,
    String(section.id),
    submit ? "section-submitted" : "section-saved",
    { revision: nextRevision, completionPercent: percent },
  );
  await refreshOnboarding(String(onboarding.id));
}

function decodeFile(
  file: Row,
): { bytes: Uint8Array; contentType: string; name: string } {
  const encoded = clean(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new OnboardingError(400, "The document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (
    !declared || bytes.byteLength !== declared ||
    bytes.byteLength > 10 * 1024 * 1024
  ) {
    throw new OnboardingError(400, "Documents must be 10 MB or smaller.");
  }
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
    throw new OnboardingError(
      400,
      "Use a PDF, PNG, or JPEG whose contents match its file type.",
    );
  }
  return {
    bytes,
    contentType,
    name: clean(file.name, 240) || "brand-document",
  };
}

async function uploadDocument(
  actor: Actor,
  onboarding: Row,
  section: Row,
  body: Row,
): Promise<Row> {
  if (!mayEdit(actor, section)) {
    throw new OnboardingError(403, "This section is not assigned to you.");
  }
  if (!EDITABLE.has(String(section.status))) {
    throw new OnboardingError(409, "This section is locked.");
  }
  const fieldKey = clean(body.fieldKey, 80).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!fieldKey) {
    throw new OnboardingError(400, "The document field is required.");
  }
  const file = body.file && typeof body.file === "object"
    ? body.file as Row
    : {};
  const { bytes, contentType, name } = decodeFile(file);
  const digest = await sha256Hex(bytes);
  let scan;
  try {
    scan = await scanContent(bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new OnboardingError(
        422,
        "The document was blocked by malware scanning.",
      );
    }
    throw new OnboardingError(
      503,
      "The document scanner is unavailable. Nothing was stored.",
    );
  }
  const extension = contentType === "application/pdf"
    ? "pdf"
    : contentType === "image/png"
    ? "png"
    : "jpg";
  const objectPath =
    `${actor.organization.id}/${section.id}/${fieldKey}/${digest}.${extension}`;
  const { error: uploadError } = await service.storage.from(
    "portal-brand-onboarding-documents",
  ).upload(objectPath, bytes, {
    contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (
    uploadError &&
    !String(uploadError.message || "").toLowerCase().includes("already exists")
  ) {
    throw uploadError;
  }
  const { data: document, error } = await service.from(
    "portal_brand_onboarding_document",
  ).upsert({
    section_id: section.id,
    field_key: fieldKey,
    object_path: objectPath,
    original_name: name,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: digest,
    scan_state: "clean",
    scan_provider: clean(scan.engine, 120) || "configured-scanner",
    uploaded_by: actor.user.id,
    uploaded_by_email: actorEmail(actor),
  }, { onConflict: "section_id,field_key,sha256" }).select(
    "id,section_id,field_key,original_name,content_type,size_bytes,created_at",
  ).single();
  if (error) throw error;
  await logEvent(actor, onboarding, String(section.id), "document-uploaded", {
    fieldKey,
    documentId: document.id,
    sha256: digest,
  });
  return document as Row;
}

function littleEndian(value: number, bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    output[index] = (value >>> (index * 8)) & 0xff;
  }
  return output;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipName(value: unknown, fallback: string): string {
  const name = clean(value, 180).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "").trim();
  return name || fallback;
}

function storedZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const local = concatBytes([
      littleEndian(0x04034b50, 4), littleEndian(20, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(checksum, 4), littleEndian(file.bytes.byteLength, 4),
      littleEndian(file.bytes.byteLength, 4), littleEndian(name.byteLength, 2),
      littleEndian(0, 2), name, file.bytes,
    ]);
    localParts.push(local);
    centralParts.push(concatBytes([
      littleEndian(0x02014b50, 4), littleEndian(20, 2), littleEndian(20, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(checksum, 4),
      littleEndian(file.bytes.byteLength, 4), littleEndian(file.bytes.byteLength, 4),
      littleEndian(name.byteLength, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 4),
      littleEndian(offset, 4), name,
    ]));
    offset += local.byteLength;
  }
  const central = concatBytes(centralParts);
  return concatBytes([
    ...localParts, central,
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2),
    littleEndian(files.length, 2), littleEndian(files.length, 2),
    littleEndian(central.byteLength, 4), littleEndian(offset, 4),
    littleEndian(0, 2),
  ]);
}

async function onboardingDocumentDownload(
  actor: Actor,
  documentId: string,
): Promise<Row> {
  const onboarding = await ensureOnboarding(actor);
  const { data: document, error } = await service.from(
    "portal_brand_onboarding_document",
  ).select("id,section_id,object_path,original_name").eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!document) throw new OnboardingError(404, "Document not found.");
  const { data: section, error: sectionError } = await service.from(
    "portal_brand_onboarding_section",
  ).select("id,onboarding_id").eq("id", document.section_id).maybeSingle();
  if (sectionError) throw sectionError;
  if (!section || String(section.onboarding_id) !== String(onboarding.id)) {
    throw new OnboardingError(403, "This document is outside your Brand.");
  }
  const { data: signed, error: signedError } = await service.storage.from(
    "portal-brand-onboarding-documents",
  ).createSignedUrl(String(document.object_path), 300, {
    download: zipName(document.original_name, "brand-document"),
  });
  if (signedError || !signed?.signedUrl) {
    throw signedError ?? new Error("Document download could not be signed.");
  }
  await logEvent(actor, onboarding, String(section.id), "document-downloaded", {
    documentId: document.id,
  });
  return { signedUrl: signed.signedUrl, fileName: document.original_name };
}

async function onboardingDocumentsZip(actor: Actor): Promise<Row> {
  const onboarding = await ensureOnboarding(actor);
  const { data: sections, error: sectionError } = await service.from(
    "portal_brand_onboarding_section",
  ).select("id,position,title").eq("onboarding_id", onboarding.id)
    .order("position");
  if (sectionError) throw sectionError;
  const sectionRows = (sections ?? []) as Row[];
  const sectionIds = sectionRows.map((section) => String(section.id));
  if (!sectionIds.length) throw new OnboardingError(404, "No onboarding sections were found.");
  const { data: documents, error } = await service.from(
    "portal_brand_onboarding_document",
  ).select("id,section_id,object_path,original_name,size_bytes,created_at")
    .in("section_id", sectionIds).order("created_at");
  if (error) throw error;
  if (!documents?.length) {
    throw new OnboardingError(409, "There are no onboarding documents to download.");
  }
  const totalBytes = documents.reduce(
    (total, document) => total + Number(document.size_bytes || 0), 0,
  );
  if (totalBytes > 40 * 1024 * 1024) {
    throw new OnboardingError(413, "The document set is larger than 40 MB. Download the files individually.");
  }
  const sectionById = new Map(sectionRows.map((section) => [String(section.id), section]));
  const names = new Map<string, number>();
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const document of documents as Row[]) {
    const { data: blob, error: downloadError } = await service.storage.from(
      "portal-brand-onboarding-documents",
    ).download(String(document.object_path));
    if (downloadError || !blob) throw downloadError ?? new Error("Document unavailable.");
    const section = sectionById.get(String(document.section_id));
    const folder = `${String(section?.position || 0).padStart(2, "0")}-${zipName(section?.title, "Section")}`;
    const base = zipName(document.original_name, "brand-document");
    const key = `${folder}/${base}`.toLowerCase();
    const count = names.get(key) ?? 0;
    names.set(key, count + 1);
    const finalName = count ? `${folder}/${count + 1}-${base}` : `${folder}/${base}`;
    files.push({ name: finalName, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const archive = storedZip(files);
  const objectPath = `${actor.organization.id}/exports/${onboarding.id}-${Date.now()}.zip`;
  const { error: uploadError } = await service.storage.from(
    "portal-brand-onboarding-documents",
  ).upload(objectPath, archive, { contentType: "application/zip", cacheControl: "0", upsert: false });
  if (uploadError) throw uploadError;
  const fileName = `${zipName(actor.organization.display_name ?? actor.organization.legal_name, "brand")}-onboarding-documents.zip`;
  const { data: signed, error: signedError } = await service.storage.from(
    "portal-brand-onboarding-documents",
  ).createSignedUrl(objectPath, 300, { download: fileName });
  if (signedError || !signed?.signedUrl) {
    throw signedError ?? new Error("Document archive could not be signed.");
  }
  await logEvent(actor, onboarding, null, "documents-zip-created", {
    documentCount: files.length,
    sizeBytes: archive.byteLength,
  });
  return { signedUrl: signed.signedUrl, fileName, documentCount: files.length };
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
    throw new Error("Monday did not accept the Brand onboarding handoff.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

async function ensureMondayTextColumn(
  accessToken: string,
  boardId: string,
  title: string,
  type: "text" | "long_text",
): Promise<string> {
  const boards = await mondayGraphql(
    accessToken,
    `query BrandBoardColumns($boardIds: [ID!]!) { boards(ids: $boardIds) { columns { id title } } }`,
    { boardIds: [boardId] },
  );
  const board = Array.isArray(boards.boards)
    ? (boards.boards as Row[])[0]
    : null;
  const columns = board && Array.isArray(board.columns)
    ? board.columns as Row[]
    : [];
  const existing = columns.find((column) =>
    clean(column.title, 200).toLowerCase() === title.toLowerCase()
  );
  if (existing?.id) return clean(existing.id, 100);
  const created = await mondayGraphql(
    accessToken,
    `mutation BrandCreateColumn($boardId: ID!, $title: String!) { create_column(board_id: $boardId, title: $title, column_type: ${type}) { id } }`,
    { boardId, title },
  );
  const column = created.create_column as Row | undefined;
  if (!column?.id) {
    throw new Error(`Monday did not create the ${title} column.`);
  }
  return clean(column.id, 100);
}

function firstItem(value: unknown): Row | null {
  const page = value && typeof value === "object"
    ? (value as Row).items_page_by_column_values
    : null;
  const items =
    page && typeof page === "object" && Array.isArray((page as Row).items)
      ? (page as Row).items as Row[]
      : [];
  return items[0] ?? null;
}

async function processMonday(onboardingId: string): Promise<Row> {
  if (!/^\d+$/.test(MONDAY_BRAND_ONBOARDING_BOARD_ID)) {
    return { configured: false, state: "queued" };
  }
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:write"]);
  if (!accessToken) return { configured: false, state: "queued" };
  const { data: outbox, error } = await service.from(
    "portal_brand_onboarding_outbox",
  ).select("*").eq("onboarding_id", onboardingId).in("state", [
    "pending",
    "failed",
  ])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!outbox) return { configured: true, state: "accepted" };
  await service.from("portal_brand_onboarding_outbox").update({
    state: "processing",
    attempts: Number(outbox.attempts) + 1,
    updated_at: new Date().toISOString(),
  }).eq("id", outbox.id);
  try {
    const requestColumnId = await ensureMondayTextColumn(
      accessToken,
      MONDAY_BRAND_ONBOARDING_BOARD_ID,
      "Portal Brand Onboarding ID",
      "text",
    );
    const snapshotColumnId = await ensureMondayTextColumn(
      accessToken,
      MONDAY_BRAND_ONBOARDING_BOARD_ID,
      "Portal Brand Onboarding Snapshot",
      "long_text",
    );
    const requestId = String(outbox.id);
    const existingData = await mondayGraphql(
      accessToken,
      `query ExistingBrandOnboarding($boardId: ID!, $requestId: String!) {
        items_page_by_column_values(board_id: $boardId, limit: 1, columns: [{ column_id: "${requestColumnId}", column_values: [$requestId] }]) { items { id name } }
      }`,
      { boardId: MONDAY_BRAND_ONBOARDING_BOARD_ID, requestId },
    );
    let mondayItemId = clean(firstItem(existingData)?.id, 100);
    if (!mondayItemId) {
      const payload = outbox.payload as Row;
      const organization = payload.organization as Row || {};
      const columnValues = {
        [requestColumnId]: requestId,
        [snapshotColumnId]: JSON.stringify(payload).slice(0, 20_000),
      };
      const createdData = await mondayGraphql(
        accessToken,
        `mutation CreateBrandOnboarding($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
          create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: true) { id }
        }`,
        {
          boardId: MONDAY_BRAND_ONBOARDING_BOARD_ID,
          itemName: `Brand onboarding · ${
            clean(organization.display_name || organization.legal_name, 300)
          }`,
          columnValues: JSON.stringify(columnValues),
        },
      );
      mondayItemId = clean(
        (createdData.create_item as Row | undefined)?.id,
        100,
      );
      if (!mondayItemId) {
        throw new Error("Monday did not return a Brand onboarding item ID.");
      }
    }
    await service.from("portal_brand_onboarding_outbox").update({
      state: "accepted",
      monday_board_id: MONDAY_BRAND_ONBOARDING_BOARD_ID,
      monday_item_id: mondayItemId,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    await service.from("portal_brand_onboarding").update({
      monday_handoff_state: "accepted",
      monday_board_id: MONDAY_BRAND_ONBOARDING_BOARD_ID,
      monday_item_id: mondayItemId,
      monday_handoff_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", onboardingId);
    return { configured: true, state: "accepted", mondayItemId };
  } catch (handoffError) {
    const message = handoffError instanceof Error
      ? handoffError.message
      : "Monday handoff failed.";
    await service.from("portal_brand_onboarding_outbox").update({
      state: "failed",
      last_error: message.slice(0, 1000),
      next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    await service.from("portal_brand_onboarding").update({
      monday_handoff_state: "reconciliation_required",
      monday_handoff_error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq("id", onboardingId);
    return {
      configured: true,
      state: "reconciliation_required",
      error: message,
    };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (
      !authorization.startsWith("Bearer ") ||
      !verifiedTokenIsAuthenticated(authorization)
    ) {
      throw new OnboardingError(403, "Forbidden");
    }
    const body = await request.json().catch(() => ({})) as Row;
    const action = clean(body.action, 50).toLowerCase();
    const organizationId = clean(body.organizationId, 80);
    if (!/^[0-9a-f-]{36}$/i.test(organizationId)) {
      throw new OnboardingError(400, "A Brand organization is required.");
    }
    const actor = await actorFor(request, organizationId);
    if (action === "get") {
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    if (action === "sync-monday") {
      throw new OnboardingError(
        409,
        "Brand onboarding is now managed in the Portal. Existing Monday records are retained as history and are not updated.",
      );
    }
    if (action === "download-document") {
      const documentId = uuidValue(body.documentId, "document");
      return json(request, { ok: true, ...(await onboardingDocumentDownload(actor, documentId)) });
    }
    if (action === "download-all-documents") {
      return json(request, { ok: true, ...(await onboardingDocumentsZip(actor)) });
    }
    const sectionId = clean(body.sectionId, 80);
    if (!/^[0-9a-f-]{36}$/i.test(sectionId)) {
      throw new OnboardingError(400, "An onboarding section is required.");
    }
    const { onboarding, section } = await sectionFor(actor, sectionId);
    if (action === "save-section" || action === "submit-section") {
      await saveSection(
        actor,
        onboarding,
        section,
        body,
        action === "submit-section",
      );
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    if (action === "upload-document") {
      const document = await uploadDocument(actor, onboarding, section, body);
      return json(request, {
        ok: true,
        document,
        ...(await snapshotFor(actor)),
      }, 201);
    }
    if (action === "assign-section") {
      if (actor.scope !== "internal" || !actor.canManage) {
        throw new OnboardingError(
          403,
          "Only an authorized urbanXtracts Internal user can assign Brand onboarding sections.",
        );
      }
      const membershipId = clean(body.membershipId, 80) || null;
      if (membershipId) {
        const { data: target, error } = await service.from(
          "portal_organization_membership",
        )
          .select("id").eq("id", membershipId).eq(
            "organization_id",
            organizationId,
          )
          .eq("workspace", "brand").eq("status", "active").maybeSingle();
        if (error) throw error;
        if (!target) {
          throw new OnboardingError(
            400,
            "Choose an active member of this Brand.",
          );
        }
      }
      const nextRevision = Number(section.revision) + 1;
      const { data: updated, error } = await service.from(
        "portal_brand_onboarding_section",
      )
        .update({
          assigned_membership_id: membershipId,
          revision: nextRevision,
          updated_by: actor.user.id,
          updated_by_email: actorEmail(actor),
          updated_at: new Date().toISOString(),
        }).eq("id", section.id).eq("revision", section.revision).select("*")
        .maybeSingle();
      if (error) throw error;
      if (!updated) {
        throw new OnboardingError(
          409,
          "This section changed before assignment was saved.",
        );
      }
      await snapshot(
        actor,
        updated as Row,
        "assigned",
        membershipId ? "Section assigned." : "Assignment cleared.",
      );
      await logEvent(actor, onboarding, sectionId, "section-assigned", {
        membershipId,
      });
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    if (action === "review-section") {
      if (!actor.canReview) {
        throw new OnboardingError(
          403,
          "Only authorized internal reviewers can decide a section.",
        );
      }
      if (section.status !== "submitted") {
        throw new OnboardingError(
          409,
          "Only a submitted section can be reviewed.",
        );
      }
      const decision = clean(body.decision, 30);
      const note = clean(body.note, 4000);
      if (!["approve", "request_changes"].includes(decision)) {
        throw new OnboardingError(400, "Choose approve or request changes.");
      }
      if (decision === "request_changes" && !note) {
        throw new OnboardingError(400, "Describe the required changes.");
      }
      const nextRevision = Number(section.revision) + 1;
      const now = new Date().toISOString();
      const { data: updated, error } = await service.from(
        "portal_brand_onboarding_section",
      )
        .update({
          status: decision === "approve" ? "approved" : "changes_requested",
          review_note: note || null,
          approved_at: decision === "approve" ? now : null,
          revision: nextRevision,
          updated_by: actor.user.id,
          updated_by_email: actorEmail(actor),
          updated_at: now,
        }).eq("id", section.id).eq("revision", section.revision).select("*")
        .maybeSingle();
      if (error) throw error;
      if (!updated) {
        throw new OnboardingError(
          409,
          "This section changed before the decision was saved.",
        );
      }
      await snapshot(
        actor,
        updated as Row,
        decision === "approve" ? "approved" : "changes_requested",
        note,
      );
      await logEvent(
        actor,
        onboarding,
        sectionId,
        decision === "approve"
          ? "section-approved"
          : "section-changes-requested",
        { note },
      );
      const refreshed = await refreshOnboarding(String(onboarding.id));
      if (refreshed.status === "approved") {
        const { data: approvedOnboarding, error: approvalError } = await service
          .from("portal_brand_onboarding").update({
            approved_by: actor.user.id,
            approved_by_email: actorEmail(actor),
            approved_at: now,
            monday_handoff_state: "portal_native",
            monday_handoff_error: null,
          }).eq("id", onboarding.id).select("*").single();
        if (approvalError) throw approvalError;
        await logEvent(
          actor,
          approvedOnboarding as Row,
          null,
          "portal-native-onboarding-approved",
          { source: "Portal", mondayRetention: "retain_read_only" },
        );
      }
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    if (action === "reopen-section") {
      if (!actor.canReview) {
        throw new OnboardingError(
          403,
          "Only authorized internal reviewers can reopen a section.",
        );
      }
      if (section.status !== "approved") {
        throw new OnboardingError(
          409,
          "Only an approved section can be reopened.",
        );
      }
      const note = clean(body.note, 4000);
      if (!note) {
        throw new OnboardingError(
          400,
          "Record why the section is being reopened.",
        );
      }
      const nextRevision = Number(section.revision) + 1;
      const { data: updated, error } = await service.from(
        "portal_brand_onboarding_section",
      )
        .update({
          status: "reopened",
          review_note: note,
          approved_at: null,
          revision: nextRevision,
          updated_by: actor.user.id,
          updated_by_email: actorEmail(actor),
          updated_at: new Date().toISOString(),
        }).eq("id", section.id).eq("revision", section.revision).select("*")
        .maybeSingle();
      if (error) throw error;
      if (!updated) {
        throw new OnboardingError(
          409,
          "This section changed before it could be reopened.",
        );
      }
      await snapshot(actor, updated as Row, "reopened", note);
      await logEvent(
        actor,
        onboarding,
        sectionId,
        "approved-section-reopened",
        { note },
      );
      await refreshOnboarding(String(onboarding.id));
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    throw new OnboardingError(400, "Unknown Brand onboarding action.");
  } catch (error) {
    const status = error instanceof OnboardingError ? error.status : 500;
    console.error("portal-brand-onboarding", error);
    return json(request, {
      error: status === 500
        ? "Brand onboarding could not complete the request."
        : error instanceof Error
        ? error.message
        : "Request failed.",
    }, status);
  }
});
