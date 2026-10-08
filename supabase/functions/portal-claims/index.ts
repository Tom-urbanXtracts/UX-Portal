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
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };
type Evidence = {
  bytes: Uint8Array;
  name: string;
  contentType: string;
  evidenceKind: string;
  digest: string;
};
class PortalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
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
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors(request), "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  } });
}
function clean(value: unknown, max = 1000): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  let canManage = false;
  if (profile.role === "internal" && profile.staff_role === "administrator") {
    const { data } = await service.from("portal_role_permission").select("permission")
      .eq("staff_role", profile.staff_role).eq("permission", "claims.manage").maybeSingle();
    canManage = !!data;
  }
  return { user, profile: profile as Row, canManage };
}

async function accessibleLicenses(caller: Caller): Promise<string[] | null> {
  if (caller.profile.role === "internal") {
    if (!caller.canManage) throw new PortalError(403, "This workforce role cannot review claims.");
    return null;
  }
  if (caller.profile.role === "owner") {
    const { data, error } = await service.from("portal_store").select("license_number")
      .eq("organization", caller.profile.org).eq("active", true);
    if (error) throw error;
    return (data ?? []).map((row) => String(row.license_number));
  }
  if (caller.profile.role === "buyer") {
    const { data, error } = await service.from("portal_profile_store").select("license_number")
      .eq("profile_id", caller.profile.id);
    if (error) throw error;
    return (data ?? []).map((row) => String(row.license_number));
  }
  throw new PortalError(403, "Receiving claims are available to Store Owners and Buyers.");
}

function serialize(row: Row): Row {
  return {
    id: row.id, claimNumber: row.claim_number, orderId: row.order_id,
    orderLineId: row.order_line_id, organization: row.organization,
    storeLicense: row.store_license, claimType: row.claim_type,
    quantity: row.quantity, narrative: row.narrative,
    evidenceState: row.evidence_state, evidenceRequired: row.evidence_required,
    evidence: row.portal_receiving_claim_evidence ?? [], state: row.state,
    resolutionNote: row.resolution_note, submittedByEmail: row.submitted_by_email,
    deliveryCompletedAt: row.delivery_completed_at, responseDueAt: row.response_due_at,
    firstResponseAt: row.first_response_at, lateSubmission: row.late_submission,
    lateOverrideReason: row.late_override_reason, submittedAt: row.submitted_at,
    decidedAt: row.decided_at, closedAt: row.closed_at, updatedAt: row.updated_at,
  };
}

async function claimPolicy(): Promise<Row> {
  const { data, error } = await service.from("portal_receiving_claim_policy").select("*")
    .eq("id", 1).single();
  if (error) throw error;
  return {
    eligibleOrderState: "delivered",
    claimWindowDays: data.claim_window_days,
    responseBusinessDays: data.initial_response_business_days,
    retentionYears: data.retention_years,
    evidenceRequiredFor: data.evidence_required_for,
    lateOverrideRole: data.late_override_role,
    automaticCredit: false,
    automaticRefund: false,
    automaticQuickBooksChange: false,
    states: ["submitted", "under_review", "more_information", "approved", "denied", "closed"],
    note: "Submit within five calendar days of delivery. Shortage, damage, and wrong-item claims require malware-scanned evidence. Administrators respond within two business days; no accounting record changes automatically.",
  };
}

async function listClaims(caller: Caller, request: Request): Promise<Row> {
  const licenses = await accessibleLicenses(caller);
  const url = new URL(request.url);
  const state = clean(url.searchParams.get("state"), 40);
  let query = service.from("portal_receiving_claim").select(
    "*,portal_receiving_claim_evidence(id,evidence_kind,original_name,created_at)",
  )
    .order("submitted_at", { ascending: false }).limit(250);
  if (licenses !== null) {
    if (!licenses.length) return { claims: [], policy: await claimPolicy() };
    query = query.in("store_license", licenses);
  }
  if (state && state !== "all") query = query.eq("state", state);
  const { data, error } = await query;
  if (error) throw error;
  return { claims: (data ?? []).map((row) => serialize(row as unknown as Row)), policy: await claimPolicy() };
}

function decodeEvidence(value: unknown, evidenceKindValue: unknown): Omit<Evidence, "digest"> {
  const file = value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  const contentType = clean(file.contentType, 120).toLowerCase();
  const allowed = new Set(["application/pdf", "image/png", "image/jpeg"]);
  const encoded = clean(file.base64, 15_000_000).replace(/\s/g, "");
  const evidenceKind = clean(evidenceKindValue, 40) || "photo";
  if (!allowed.has(contentType) || !encoded) {
    throw new PortalError(400, "Attach a PDF, PNG, or JPEG evidence file that is 10 MB or smaller.");
  }
  if (!new Set(["photo", "manifest", "proof_of_delivery", "other"]).has(evidenceKind)) {
    throw new PortalError(400, "Choose photo, manifest, proof of delivery, or other evidence.");
  }
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new PortalError(400, "The evidence file could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!Number(file.sizeBytes) || bytes.byteLength !== Number(file.sizeBytes) || bytes.byteLength > 10 * 1024 * 1024) {
    throw new PortalError(400, "Evidence files must be 10 MB or smaller.");
  }
  const signatureMatches = contentType === "application/pdf"
    ? bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
    : contentType === "image/png"
    ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!signatureMatches) throw new PortalError(400, "The evidence contents do not match the declared file type.");
  return { bytes, name: clean(file.name, 240) || "claim-evidence", contentType, evidenceKind };
}

async function prepareEvidence(value: unknown, evidenceKind: unknown): Promise<Evidence> {
  const decoded = decodeEvidence(value, evidenceKind);
  const digest = await sha256Hex(decoded.bytes);
  try {
    await scanContent(decoded.bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError) throw new PortalError(error.verdict === "infected" ? 422 : 503, error.message);
    throw error;
  }
  return { ...decoded, digest };
}

async function storeEvidence(claimId: string, caller: Caller, evidence: Evidence): Promise<Row> {
  const extension = evidence.contentType === "application/pdf" ? "pdf" : evidence.contentType === "image/png" ? "png" : "jpg";
  const objectPath = `${claimId}/${crypto.randomUUID()}-${evidence.digest.slice(0, 16)}.${extension}`;
  const { error: uploadError } = await service.storage.from("portal-claim-evidence").upload(
    objectPath, evidence.bytes, { contentType: evidence.contentType, upsert: false },
  );
  if (uploadError) throw uploadError;
  const { data, error } = await service.from("portal_receiving_claim_evidence").insert({
    claim_id: claimId, evidence_kind: evidence.evidenceKind, object_path: objectPath,
    original_name: evidence.name, content_type: evidence.contentType,
    size_bytes: evidence.bytes.byteLength, sha256: evidence.digest, scan_state: "clean",
    uploaded_by: caller.profile.id, uploaded_by_email: caller.user.email || null,
  }).select("id,evidence_kind,original_name,created_at").single();
  if (error) {
    await service.storage.from("portal-claim-evidence").remove([objectPath]);
    throw error;
  }
  return data as Row;
}

async function claimForAccess(caller: Caller, claimId: string): Promise<Row> {
  const { data, error } = await service.from("portal_receiving_claim").select("*").eq("id", claimId).maybeSingle();
  if (error) throw error;
  if (!data) throw new PortalError(404, "Claim not found.");
  if (caller.canManage) return data as Row;
  if (!new Set(["owner", "buyer"]).has(String(caller.profile.role)) || data.organization !== caller.profile.org) {
    throw new PortalError(403, "That claim is outside your organization.");
  }
  const licenses = await accessibleLicenses(caller);
  if (!licenses?.includes(String(data.store_license))) throw new PortalError(403, "That claim is outside your assigned stores.");
  return data as Row;
}

async function createClaim(caller: Caller, body: Row, lateOverride = false): Promise<Row> {
  if (!lateOverride && !new Set(["owner", "buyer"]).has(String(caller.profile.role))) {
    throw new PortalError(403, "Only a Store Owner or Buyer may submit a receiving claim.");
  }
  if (lateOverride && !caller.canManage) throw new PortalError(403, "Only an Administrator may approve a late receiving claim.");
  const orderId = clean(body.orderId, 80);
  const orderLineId = Number(body.orderLineId);
  const quantity = Number(body.quantity);
  const claimType = clean(body.claimType, 40);
  const narrative = clean(body.narrative, 2000);
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || !Number.isSafeInteger(orderLineId) || orderLineId < 1) {
    throw new PortalError(400, "Choose a delivered order line.");
  }
  if (!new Set(["short", "damaged", "wrong_item", "refused", "other"]).has(claimType)) {
    throw new PortalError(400, "Choose a supported claim type.");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || narrative.length < 3) {
    throw new PortalError(400, "Enter a quantity and a short description of the receiving issue.");
  }
  const evidenceRequired = new Set(["short", "damaged", "wrong_item"]).has(claimType);
  const evidence = body.evidence ? await prepareEvidence(body.evidence, body.evidenceKind) : null;
  if (evidenceRequired && !evidence) {
    throw new PortalError(400, "Shortage, damaged, and wrong-item claims require a photo, manifest, or proof-of-delivery file.");
  }
  const { data: order, error } = await service.from("portal_order").select(
    "id,organization,location_license,state",
  ).eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order || order.state !== "delivered" || (!lateOverride && order.organization !== caller.profile.org)) {
    throw new PortalError(403, "That delivered order is outside your organization.");
  }
  if (!lateOverride) {
    const licenses = await accessibleLicenses(caller);
    if (!licenses?.includes(String(order.location_license))) {
      throw new PortalError(403, "That order is outside your assigned stores.");
    }
  }
  const overrideReason = clean(body.lateOverrideReason, 1000);
  if (lateOverride && overrideReason.length < 8) throw new PortalError(400, "Enter the Administrator reason for accepting this late claim.");
  const { data, error: createError } = await service.rpc("portal_create_receiving_claim", {
    p_order_id: orderId, p_order_line_id: orderLineId,
    p_organization: order.organization, p_store_license: order.location_license,
    p_claim_type: claimType, p_quantity: quantity, p_narrative: narrative,
    p_submitted_by: caller.profile.id, p_submitted_by_email: caller.user.email || "",
    p_late_override_by: lateOverride ? caller.profile.id : null,
    p_late_override_reason: lateOverride ? overrideReason : null,
  });
  if (createError) {
    if (/quantity|delivered|scope|line|window|override|evidence/i.test(createError.message || "")) {
      throw new PortalError(409, createError.message);
    }
    throw createError;
  }
  let created = data as Row;
  if (evidence) {
    await storeEvidence(String(created.id), caller, evidence);
    const { data: updated, error: updateError } = await service.from("portal_receiving_claim").update({
      evidence_state: "clean", state: created.state === "more_information" ? "submitted" : created.state,
    }).eq("id", created.id).select("*,portal_receiving_claim_evidence(id,evidence_kind,original_name,created_at)").single();
    if (updateError) throw updateError;
    created = updated as unknown as Row;
  }
  return serialize(created);
}

async function addEvidence(caller: Caller, body: Row): Promise<Row> {
  const claimId = clean(body.claimId, 80);
  if (!/^[0-9a-f-]{36}$/i.test(claimId)) throw new PortalError(400, "Choose a valid receiving claim.");
  const claim = await claimForAccess(caller, claimId);
  if (new Set(["approved", "denied", "closed", "withdrawn"]).has(String(claim.state))) {
    throw new PortalError(409, "Evidence cannot be added after the claim decision is complete.");
  }
  const evidence = await prepareEvidence(body.evidence, body.evidenceKind);
  await storeEvidence(claimId, caller, evidence);
  const nextState = claim.state === "more_information" ? "submitted" : claim.state;
  const { data, error } = await service.from("portal_receiving_claim").update({
    evidence_state: "clean", state: nextState,
  }).eq("id", claimId).select("*,portal_receiving_claim_evidence(id,evidence_kind,original_name,created_at)").single();
  if (error) throw error;
  return serialize(data as unknown as Row);
}

async function decideClaim(caller: Caller, body: Row): Promise<Row> {
  if (!caller.canManage) throw new PortalError(403, "This workforce role cannot review claims.");
  const claimId = clean(body.claimId, 80);
  const state = clean(body.state, 40);
  const note = clean(body.resolutionNote, 2000);
  if (!/^[0-9a-f-]{36}$/i.test(claimId) || !new Set([
    "under_review", "more_information", "approved", "denied", "closed",
  ]).has(state)) throw new PortalError(400, "Choose a supported claim decision.");
  if (state !== "under_review" && note.length < 3) {
    throw new PortalError(400, "A decision note is required.");
  }
  const terminalDecision = new Set(["approved", "denied"]).has(state);
  const changes: Row = { state, resolution_note: note || null };
  if (terminalDecision) {
    changes.decided_by = caller.profile.id;
    changes.decided_at = new Date().toISOString();
  }
  if (state === "closed") changes.closed_at = new Date().toISOString();
  const { data, error } = await service.from("portal_receiving_claim").update(changes)
    .eq("id", claimId).in("state", ["submitted", "under_review", "more_information", "approved", "denied", "partially_approved", "resolved"])
    .select("*,portal_receiving_claim_evidence(id,evidence_kind,original_name,created_at)").maybeSingle();
  if (error) throw error;
  if (!data) throw new PortalError(409, "That claim changed or can no longer be decided.");
  return serialize(data as unknown as Row);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!new Set(["GET", "POST"]).has(request.method)) return json(request, { error: "Method not allowed" }, 405);
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    if (request.method === "GET") return json(request, await listClaims(caller, request));
    const body = await request.json() as Row;
    const action = clean(body.action, 40);
    if (action === "create") return json(request, { claim: await createClaim(caller, body) }, 201);
    if (action === "create-late") return json(request, { claim: await createClaim(caller, body, true) }, 201);
    if (action === "add-evidence") return json(request, { claim: await addEvidence(caller, body) });
    if (action === "decide") return json(request, { claim: await decideClaim(caller, body) });
    throw new PortalError(400, "Unsupported claims action.");
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-claims", error);
    return json(request, { error: error instanceof PortalError ? error.message : "The receiving-claims service is temporarily unavailable." },
      error instanceof PortalError ? error.status : 502);
  }
});
