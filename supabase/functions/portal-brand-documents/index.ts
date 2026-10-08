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
const BUCKET = "portal-brand-documents";
const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const CATEGORIES = new Set([
  "company",
  "license",
  "tax",
  "insurance",
  "quality",
  "commercial",
  "operations",
  "brand_logo",
  "brand_guidelines",
  "product_image",
  "packaging_artwork",
  "lifestyle_image",
  "sell_sheet",
  "menu_asset",
  "social_asset",
  "procedure",
  "work_instruction",
  "training",
  "form",
  "product_quality_plan",
  "sop",
  "manufacturing_batch_record",
  "master_manufacturing_plan",
  "gmp_haccp",
  "iso_certification",
  "sds_msds",
  "certificate_of_compliance",
  "food_grade",
  "allergen_statement",
  "origin_traceability",
  "kosher_halal",
  "packaging_certification",
  "hardware_safety",
  "engineering_diagram",
  "letter_of_guarantee",
  "other",
]);

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = {
  user: Row;
  profile: Row;
  organization: Row;
  membership: Row | null;
  internal: boolean;
  canRead: boolean;
  canContribute: boolean;
  canArchive: boolean;
  canReview: boolean;
};

class DocumentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
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

function uuidValue(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new DocumentError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function dateValue(value: unknown, label: string): string | null {
  const candidate = clean(value, 10);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || Number.isNaN(Date.parse(`${candidate}T12:00:00Z`))) {
    throw new DocumentError(400, `Enter ${label} as MM/DD/YYYY.`);
  }
  return candidate;
}

function actorEmail(actor: Actor): string {
  return clean(actor.user.email || actor.profile.full_name, 320).toLowerCase();
}

async function actorFor(request: Request, organizationId: string): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) {
    throw new DocumentError(403, "Forbidden");
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new DocumentError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data: profile, error: profileError } = await service.from("portal_profile")
    .select("id,full_name,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.active === false) throw new DocumentError(403, "Forbidden");
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,kind,legal_name,display_name,status")
    .eq("id", organizationId).eq("kind", "brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new DocumentError(404, "Brand organization not found.");

  if (profile.role === "internal" && profile.staff_role === "administrator") {
    return {
      user,
      profile: profile as Row,
      organization: organization as Row,
      membership: null,
      internal: true,
      canRead: true,
      canContribute: true,
      canArchive: true,
      canReview: true,
    };
  }
  if (profile.role !== "brand") throw new DocumentError(403, "Forbidden");
  const { data: membership, error: membershipError } = await service
    .from("portal_organization_membership").select("id,member_role,status")
    .eq("profile_id", profile.id).eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new DocumentError(403, "This Brand is outside your access scope.");
  const { data: permissions, error: permissionError } = await service
    .from("portal_workspace_role_permission").select("permission")
    .eq("workspace", "brand").eq("member_role", membership.member_role)
    .in("permission", ["brand.documents.read", "brand.documents.contribute"]);
  if (permissionError) throw permissionError;
  const grants = new Set((permissions ?? []).map((row) => String(row.permission)));
  const canRead = grants.has("brand.documents.read");
  if (!canRead) throw new DocumentError(403, "Your Brand role cannot read documents.");
  return {
    user,
    profile: profile as Row,
    organization: organization as Row,
    membership: membership as Row,
    internal: false,
    canRead,
    canContribute: grants.has("brand.documents.contribute"),
    canArchive: false,
    canReview: false,
  };
}

async function logEvent(actor: Actor, action: string, targetId: string | null, detail: Row): Promise<void> {
  const { error } = await service.from("portal_brand_operation_event").insert({
    organization_id: actor.organization.id,
    actor_id: actor.user.id,
    actor_email: actorEmail(actor),
    action,
    target_type: "brand_document",
    target_id: targetId,
    detail,
  });
  if (error) throw error;
}

function decodeFile(file: Row): { bytes: Uint8Array; contentType: string; name: string } {
  const encoded = clean(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new DocumentError(400, "The document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (!declared || declared !== bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) {
    throw new DocumentError(400, "Documents must be 10 MB or smaller.");
  }
  const contentType = clean(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!((contentType === "application/pdf" && pdf) ||
    (contentType === "image/png" && png) ||
    (contentType === "image/jpeg" && jpeg))) {
    throw new DocumentError(400, "Use a PDF, PNG, or JPEG whose contents match its file type.");
  }
  return { bytes, contentType, name: clean(file.name, 240) || "brand-document" };
}

function safeName(value: unknown, fallback: string): string {
  const name = clean(value, 180).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "").trim();
  return name || fallback;
}

function extensionFor(contentType: string): string {
  return contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
}

async function documentFor(actor: Actor, documentId: string): Promise<Row> {
  let query = service.from("portal_brand_document").select("*")
    .eq("id", documentId).eq("organization_id", actor.organization.id);
  if (!actor.internal) query = query.eq("visibility", "brand_and_internal");
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new DocumentError(404, "Document not found.");
  return data as Row;
}

async function snapshotFor(actor: Actor): Promise<Row> {
  let query = service.from("portal_brand_document").select(
    "id,category,title,document_date,expires_on,effective_on,review_on,document_owner,related_type,related_id,version_number,version_label,supersedes_document_id,visibility,status,review_note,reviewed_by_email,reviewed_at,notes,original_name,content_type,size_bytes,uploaded_by_email,archived_by_email,archived_at,created_at,updated_at",
  ).eq("organization_id", actor.organization.id)
    .order("version_number", { ascending: false })
    .order("created_at", { ascending: false });
  if (!actor.internal) query = query.eq("visibility", "brand_and_internal");
  const { data, error } = await query;
  if (error) throw error;
  const documents = (data ?? []) as Row[];
  const today = new Date();
  const inThirtyDays = new Date(today.getTime() + 30 * 86400_000);
  return {
    organization: actor.organization,
    documents,
    summary: {
      approved: documents.filter((document) => document.status === "approved").length,
      inReview: documents.filter((document) => document.status === "submitted").length,
      changesRequested: documents.filter((document) => document.status === "changes_requested").length,
      expiring: documents.filter((document) => {
        if (document.status !== "approved" || !document.expires_on) return false;
        const expires = new Date(`${document.expires_on}T12:00:00Z`);
        return expires >= today && expires <= inThirtyDays;
      }).length,
      archived: documents.filter((document) => document.status === "archived").length,
    },
    capabilities: {
      canContribute: actor.canContribute,
      canArchive: actor.canArchive,
      canReview: actor.canReview,
      canSetInternalVisibility: actor.internal,
      scope: actor.internal ? "internal" : "brand",
    },
  };
}

async function uploadDocument(actor: Actor, body: Row): Promise<Row> {
  if (!actor.canContribute) throw new DocumentError(403, "Your role cannot add Brand documents.");
  const category = clean(body.category, 40).toLowerCase();
  if (!CATEGORIES.has(category)) throw new DocumentError(400, "Choose a document category.");
  const title = clean(body.title, 240);
  if (!title) throw new DocumentError(400, "Enter a document title.");
  const documentDate = dateValue(body.documentDate, "the document date");
  const expiresOn = dateValue(body.expiresOn, "the expiration date");
  const effectiveOn = dateValue(body.effectiveOn, "the effective date");
  const reviewOn = dateValue(body.reviewOn, "the review date");
  if (documentDate && expiresOn && expiresOn < documentDate) {
    throw new DocumentError(400, "The expiration date cannot be before the document date.");
  }
  const requestedVisibility = clean(body.visibility, 40);
  const visibility = actor.internal && requestedVisibility === "internal_only"
    ? "internal_only"
    : "brand_and_internal";
  const file = body.file && typeof body.file === "object" ? body.file as Row : {};
  const { bytes, contentType, name } = decodeFile(file);
  const digest = await sha256Hex(bytes);
  let scan;
  try {
    scan = await scanContent(bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new DocumentError(422, "The document was blocked by malware scanning.");
    }
    throw new DocumentError(503, "The document scanner is unavailable. Nothing was stored.");
  }
  const { data: existing, error: existingError } = await service
    .from("portal_brand_document").select("id")
    .eq("organization_id", actor.organization.id).eq("category", category)
    .eq("sha256", digest).maybeSingle();
  if (existingError) throw existingError;
  if (existing) throw new DocumentError(409, "This exact document is already in the selected category.");
  const relatedType = clean(body.relatedType, 40).toLowerCase() || "brand";
  if (!["brand", "product", "vendor", "component"].includes(relatedType)) {
    throw new DocumentError(400, "Choose a valid linked record type.");
  }
  const relatedId = clean(body.relatedId, 240) || String(actor.organization.id);
  const { data: versions, error: versionError } = await service
    .from("portal_brand_document").select("version_number")
    .eq("organization_id", actor.organization.id).eq("category", category)
    .eq("title", title).order("version_number", { ascending: false }).limit(1);
  if (versionError) throw versionError;
  const versionNumber = Math.max(1, Number(versions?.[0]?.version_number || 0) + 1);
  const objectPath = `${actor.organization.id}/profile/${category}/${digest}.${extensionFor(contentType)}`;
  const { error: uploadError } = await service.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (uploadError && !String(uploadError.message || "").toLowerCase().includes("already exists")) {
    throw uploadError;
  }
  const { data: document, error } = await service.from("portal_brand_document").insert({
    organization_id: actor.organization.id,
    category,
    title,
    document_date: documentDate,
    expires_on: expiresOn,
    effective_on: effectiveOn,
    review_on: reviewOn,
    document_owner: clean(body.documentOwner, 240) || null,
    related_type: relatedType,
    related_id: relatedId,
    version_number: versionNumber,
    version_label: clean(body.versionLabel, 80) || `v${versionNumber}`,
    visibility,
    status: actor.internal ? "approved" : "submitted",
    notes: clean(body.notes, 4000) || null,
    object_path: objectPath,
    original_name: name,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: digest,
    scan_state: "clean",
    scan_provider: clean(scan.engine, 120) || "configured-scanner",
    uploaded_by: actor.user.id,
    uploaded_by_email: actorEmail(actor),
    reviewed_by: actor.internal ? actor.user.id : null,
    reviewed_by_email: actor.internal ? actorEmail(actor) : null,
    reviewed_at: actor.internal ? new Date().toISOString() : null,
  }).select("id").single();
  if (error) throw error;
  await logEvent(actor, "brand-document-uploaded", String(document.id), {
    category,
    title,
    visibility,
    sha256: digest,
    versionNumber,
    status: actor.internal ? "approved" : "submitted",
  });
  return document as Row;
}

async function downloadDocument(actor: Actor, documentId: string): Promise<Row> {
  const document = await documentFor(actor, documentId);
  const { data, error } = await service.storage.from(BUCKET)
    .createSignedUrl(String(document.object_path), 300, {
      download: safeName(document.original_name, "brand-document"),
    });
  if (error || !data?.signedUrl) throw error ?? new Error("Document download could not be signed.");
  await logEvent(actor, "brand-document-downloaded", documentId, {});
  return { signedUrl: data.signedUrl, fileName: document.original_name };
}

async function archiveDocument(actor: Actor, documentId: string): Promise<void> {
  if (!actor.canArchive) throw new DocumentError(403, "Only Internal administrators can archive documents.");
  const document = await documentFor(actor, documentId);
  if (document.status === "archived") return;
  const now = new Date().toISOString();
  const { error } = await service.from("portal_brand_document").update({
    status: "archived",
    archived_by: actor.user.id,
    archived_by_email: actorEmail(actor),
    archived_at: now,
    updated_at: now,
  }).eq("id", documentId).eq("organization_id", actor.organization.id).neq("status", "archived");
  if (error) throw error;
  await logEvent(actor, "brand-document-archived", documentId, {
    title: document.title,
    category: document.category,
  });
}

async function reviewDocument(actor: Actor, documentId: string, decision: string, note: string): Promise<void> {
  if (!actor.canReview) throw new DocumentError(403, "Only Internal administrators can review Brand documents.");
  const document = await documentFor(actor, documentId);
  if (!["approve", "request_changes", "reopen"].includes(decision)) {
    throw new DocumentError(400, "Choose a valid review decision.");
  }
  if (decision === "request_changes" && !note) {
    throw new DocumentError(400, "Explain what needs to change.");
  }
  const nextStatus = decision === "approve" ? "approved"
    : decision === "request_changes" ? "changes_requested" : "submitted";
  const now = new Date().toISOString();
  if (decision === "approve") {
    const { error: supersedeError } = await service.from("portal_brand_document").update({
      status: "superseded",
      updated_at: now,
    }).eq("organization_id", actor.organization.id)
      .eq("category", document.category).eq("title", document.title)
      .eq("status", "approved").neq("id", documentId);
    if (supersedeError) throw supersedeError;
  }
  const { error } = await service.from("portal_brand_document").update({
    status: nextStatus,
    review_note: note || null,
    reviewed_by: actor.user.id,
    reviewed_by_email: actorEmail(actor),
    reviewed_at: now,
    updated_at: now,
  }).eq("id", documentId).eq("organization_id", actor.organization.id);
  if (error) throw error;
  await logEvent(actor, `brand-document-${decision.replace("_", "-")}`, documentId, {
    title: document.title,
    category: document.category,
    note: note || null,
  });
}

function littleEndian(value: number, bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) output[index] = (value >>> (index * 8)) & 0xff;
  return output;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
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
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(checksum, 4), littleEndian(file.bytes.byteLength, 4),
      littleEndian(file.bytes.byteLength, 4), littleEndian(name.byteLength, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 4), littleEndian(offset, 4), name,
    ]));
    offset += local.byteLength;
  }
  const central = concatBytes(centralParts);
  return concatBytes([
    ...localParts,
    central,
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2),
    littleEndian(files.length, 2), littleEndian(files.length, 2),
    littleEndian(central.byteLength, 4), littleEndian(offset, 4), littleEndian(0, 2),
  ]);
}

async function downloadAll(actor: Actor): Promise<Row> {
  let query = service.from("portal_brand_document")
    .select("id,category,title,object_path,original_name,size_bytes")
    .eq("organization_id", actor.organization.id).eq("status", "approved")
    .order("category").order("created_at");
  if (!actor.internal) query = query.eq("visibility", "brand_and_internal");
  const { data: documents, error } = await query;
  if (error) throw error;
  if (!documents?.length) throw new DocumentError(409, "There are no approved Brand documents to download.");
  const totalBytes = documents.reduce((total, document) => total + Number(document.size_bytes || 0), 0);
  if (totalBytes > 55 * 1024 * 1024) {
    throw new DocumentError(413, "The document set is larger than 55 MB. Download the files individually.");
  }
  const names = new Map<string, number>();
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const document of documents as Row[]) {
    const { data: blob, error: downloadError } = await service.storage.from(BUCKET)
      .download(String(document.object_path));
    if (downloadError || !blob) throw downloadError ?? new Error("Document unavailable.");
    const folder = safeName(document.category, "other");
    const base = safeName(document.original_name, "brand-document");
    const key = `${folder}/${base}`.toLowerCase();
    const count = names.get(key) ?? 0;
    names.set(key, count + 1);
    files.push({
      name: count ? `${folder}/${count + 1}-${base}` : `${folder}/${base}`,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  const archive = storedZip(files);
  const objectPath = `${actor.organization.id}/exports/profile-documents-${Date.now()}.zip`;
  const { error: uploadError } = await service.storage.from(BUCKET).upload(objectPath, archive, {
    contentType: "application/zip",
    cacheControl: "0",
    upsert: false,
  });
  if (uploadError) throw uploadError;
  const fileName = `${safeName(actor.organization.display_name || actor.organization.legal_name, "brand")}-profile-documents.zip`;
  const { data: signed, error: signedError } = await service.storage.from(BUCKET)
    .createSignedUrl(objectPath, 300, { download: fileName });
  if (signedError || !signed?.signedUrl) throw signedError ?? new Error("Document archive could not be signed.");
  await logEvent(actor, "brand-documents-zip-created", null, {
    documentCount: files.length,
    sizeBytes: archive.byteLength,
  });
  return { signedUrl: signed.signedUrl, fileName, documentCount: files.length };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) {
      throw new DocumentError(403, "Forbidden");
    }
    const body = await request.json().catch(() => ({})) as Row;
    const organizationId = uuidValue(body.organizationId, "Brand organization");
    const actor = await actorFor(request, organizationId);
    const action = clean(body.action, 60).toLowerCase();
    if (action === "get") return json(request, { ok: true, ...(await snapshotFor(actor)) });
    if (action === "upload") {
      const document = await uploadDocument(actor, body);
      return json(request, { ok: true, document, ...(await snapshotFor(actor)) }, 201);
    }
    if (action === "download-document") {
      return json(request, { ok: true, ...(await downloadDocument(actor, uuidValue(body.documentId, "document"))) });
    }
    if (action === "download-all") {
      return json(request, { ok: true, ...(await downloadAll(actor)) });
    }
    if (action === "archive") {
      await archiveDocument(actor, uuidValue(body.documentId, "document"));
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    if (action === "review") {
      await reviewDocument(
        actor,
        uuidValue(body.documentId, "document"),
        clean(body.decision, 40).toLowerCase(),
        clean(body.note, 4000),
      );
      return json(request, { ok: true, ...(await snapshotFor(actor)) });
    }
    throw new DocumentError(400, "Unknown Brand document action.");
  } catch (error) {
    const status = error instanceof DocumentError ? error.status : 500;
    if (status === 500) console.error("portal-brand-documents", error);
    return json(request, {
      error: status === 500
        ? "The Brand document register could not complete the request."
        : error instanceof Error ? error.message : "Request failed.",
    }, status);
  }
});
