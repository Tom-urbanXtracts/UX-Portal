import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };
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
  let canManage = false;
  if (profile.role === "internal") {
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
    evidenceState: row.evidence_state, state: row.state,
    resolutionNote: row.resolution_note, submittedByEmail: row.submitted_by_email,
    submittedAt: row.submitted_at, decidedAt: row.decided_at, updatedAt: row.updated_at,
  };
}

async function listClaims(caller: Caller, request: Request): Promise<Row> {
  const licenses = await accessibleLicenses(caller);
  const url = new URL(request.url);
  const state = clean(url.searchParams.get("state"), 40);
  let query = service.from("portal_receiving_claim").select("*")
    .order("submitted_at", { ascending: false }).limit(250);
  if (licenses !== null) {
    if (!licenses.length) return { claims: [], policy: claimPolicy() };
    query = query.in("store_license", licenses);
  }
  if (state && state !== "all") query = query.eq("state", state);
  const { data, error } = await query;
  if (error) throw error;
  return { claims: (data ?? []).map((row) => serialize(row as unknown as Row)), policy: claimPolicy() };
}

function claimPolicy(): Row {
  return {
    eligibleOrderState: "delivered",
    claimWindow: null,
    evidenceRequired: null,
    automaticCredit: false,
    note: "Operations still needs to approve a claim window and evidence rule. Valid delivered-order claims may be recorded now and always require human review.",
  };
}

async function createClaim(caller: Caller, body: Row): Promise<Row> {
  if (!new Set(["owner", "buyer"]).has(String(caller.profile.role))) {
    throw new PortalError(403, "Only a Store Owner or Buyer may submit a receiving claim.");
  }
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
  const { data: order, error } = await service.from("portal_order").select(
    "id,organization,location_license,state",
  ).eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order || order.state !== "delivered" || order.organization !== caller.profile.org) {
    throw new PortalError(403, "That delivered order is outside your organization.");
  }
  const licenses = await accessibleLicenses(caller);
  if (!licenses?.includes(String(order.location_license))) {
    throw new PortalError(403, "That order is outside your assigned stores.");
  }
  const { data, error: createError } = await service.rpc("portal_create_receiving_claim", {
    p_order_id: orderId, p_order_line_id: orderLineId,
    p_organization: order.organization, p_store_license: order.location_license,
    p_claim_type: claimType, p_quantity: quantity, p_narrative: narrative,
    p_submitted_by: caller.profile.id, p_submitted_by_email: caller.user.email || "",
  });
  if (createError) {
    if (/quantity|delivered|scope|line/i.test(createError.message || "")) {
      throw new PortalError(409, createError.message);
    }
    throw createError;
  }
  return serialize(data as Row);
}

async function decideClaim(caller: Caller, body: Row): Promise<Row> {
  if (!caller.canManage) throw new PortalError(403, "This workforce role cannot review claims.");
  const claimId = clean(body.claimId, 80);
  const state = clean(body.state, 40);
  const note = clean(body.resolutionNote, 2000);
  if (!/^[0-9a-f-]{36}$/i.test(claimId) || !new Set([
    "under_review", "approved", "partially_approved", "denied", "resolved",
  ]).has(state)) throw new PortalError(400, "Choose a supported claim decision.");
  if (state !== "under_review" && note.length < 3) {
    throw new PortalError(400, "A decision note is required.");
  }
  const terminal = new Set(["approved", "partially_approved", "denied", "resolved"]).has(state);
  const { data, error } = await service.from("portal_receiving_claim").update({
    state, resolution_note: note || null, decided_by: terminal ? caller.profile.id : null,
    decided_at: terminal ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  }).eq("id", claimId).in("state", ["submitted", "under_review", "approved", "partially_approved"])
    .select("*").maybeSingle();
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
    if (action === "decide") return json(request, { claim: await decideClaim(caller, body) });
    throw new PortalError(400, "Unsupported claims action.");
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-claims", error);
    return json(request, { error: error instanceof PortalError ? error.message : "The receiving-claims service is temporarily unavailable." },
      error instanceof PortalError ? error.status : 502);
  }
});
