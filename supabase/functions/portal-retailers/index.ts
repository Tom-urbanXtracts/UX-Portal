import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row };

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
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "https://tom-urbanxtracts.github.io",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]).has(candidate) ? candidate : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,full_name,org,role,staff_role,active")
    .eq("id", user.id).maybeSingle();
  if (error || !profile || profile.active === false || profile.role !== "internal") return null;
  const { data: grant } = await service.from("portal_role_permission").select("permission")
    .eq("staff_role", profile.staff_role).eq("permission", "accounts.manage").maybeSingle();
  return grant ? { user, profile: profile as Row } : null;
}

function knownDatabaseError(error: Row): PortalError {
  const message = String(error.message || "");
  const known = [
    "QuickBooks customer not found",
    "already linked to another QuickBooks customer",
    "Retailer account not found",
    "inactive QuickBooks customer cannot be ready",
    "At least one qualified store",
    "Unsupported retailer status",
    "Store name and license number are required",
    "no more than ten stores",
    "license is already attached",
    "Retailer store not found",
    "Unsupported license status",
    "Unsupported ordering status",
    "Ordering cannot be ready",
    "Onboarding request not found",
    "onboarding request cannot be relinked after store creation",
    "must be linked to QuickBooks first",
    "Unsupported onboarding store qualification status",
    "Monday must accept the onboarding request",
    "License review is available only",
    "Onboarding store not found",
    "Unsupported onboarding stage",
    "onboarding request is already complete",
    "Onboarding stages must advance one step",
    "Every store license must be reviewed",
    "At least one store license must qualify",
    "Link a QuickBooks-backed retailer account",
    "linked retailer account is not ready",
    "Set the linked retailer account to ready",
    "Every qualified license must exist",
    "Every requested user must be invited",
    "At least one active Store Owner",
    "A rejection note is required",
  ].find((candidate) => message.includes(candidate));
  return known
    ? new PortalError(message.includes("not found") ? 404 : 409, known)
    : new PortalError(500, "The retailer account service could not save that change.");
}

async function rpc(name: string, parameters: Row): Promise<Row> {
  const { data, error } = await service.rpc(name, parameters);
  if (error) {
    console.error("portal-retailers rpc", name, error);
    throw knownDatabaseError(error as unknown as Row);
  }
  return data as unknown as Row;
}

async function accounts(): Promise<Row[]> {
  const { data: accountRows, error: accountError } = await service.from("portal_retailer_account")
    .select("id,quickbooks_customer_id,organization_name,display_name,portal_status,status_note,account_owner_email,created_at,updated_at")
    .order("display_name");
  if (accountError) throw accountError;
  const ids = (accountRows ?? []).map((account) => String(account.id));
  const { data: stores, error: storeError } = ids.length
    ? await service.from("portal_store")
      .select("license_number,retailer_account_id,quickbooks_customer_id,display_name,address,active,license_status,ordering_status,ordering_hold_reason,license_expires_on,qualified_at,closed_at,updated_at")
      .in("retailer_account_id", ids).order("display_name")
    : { data: [], error: null };
  if (storeError) throw storeError;
  return (accountRows ?? []).map((account) => ({
    id: account.id,
    quickbooksCustomerId: account.quickbooks_customer_id,
    organizationName: account.organization_name,
    displayName: account.display_name,
    portalStatus: account.portal_status,
    statusNote: account.status_note,
    accountOwnerEmail: account.account_owner_email,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
    stores: (stores ?? []).filter((store) => store.retailer_account_id === account.id).map((store) => ({
      licenseNumber: store.license_number,
      quickbooksCustomerId: store.quickbooks_customer_id,
      name: store.display_name,
      address: store.address,
      active: store.active,
      licenseStatus: store.license_status,
      orderingStatus: store.ordering_status,
      orderingHoldReason: store.ordering_hold_reason,
      licenseExpiresOn: store.license_expires_on,
      qualifiedAt: store.qualified_at,
      closedAt: store.closed_at,
      updatedAt: store.updated_at,
    })),
  }));
}

async function onboardingQueue(): Promise<Row[]> {
  const { data, error } = await service.from("portal_onboarding_request")
    .select("id,client_request_id,retailer_account_id,quickbooks_customer_id,submission_type,legal_entity,dba,stage,workflow_state,workflow_error,monday_item_id,submitted_by_email,owner_name,owner_email,submitted_at,accepted_at,updated_at")
    .not("stage", "in", "(closed,rejected)").order("submitted_at", { ascending: false }).limit(100);
  if (error) throw error;
  const requestIds = (data ?? []).map((request) => String(request.id));
  const { data: stores, error: storeError } = requestIds.length
    ? await service.from("portal_onboarding_store")
      .select("onboarding_request_id,store_name,license_number,address,qualification_status,qualification_note")
      .in("onboarding_request_id", requestIds).order("store_number")
    : { data: [], error: null };
  if (storeError) throw storeError;
  const { data: people, error: peopleError } = requestIds.length
    ? await service.from("portal_onboarding_person")
      .select("id,onboarding_request_id,person_role,full_name,email,phone,store_license,portal_profile_id,access_status,invited_at")
      .in("onboarding_request_id", requestIds).order("created_at")
    : { data: [], error: null };
  if (peopleError) throw peopleError;
  const { data: events, error: eventError } = requestIds.length
    ? await service.from("portal_onboarding_event")
      .select("id,onboarding_request_id,source,from_stage,to_stage,actor_email,note,metadata,created_at")
      .in("onboarding_request_id", requestIds).order("created_at", { ascending: false })
    : { data: [], error: null };
  if (eventError) throw eventError;
  return (data ?? []).map((request) => ({
    id: request.id,
    clientRequestId: request.client_request_id,
    retailerAccountId: request.retailer_account_id,
    quickbooksCustomerId: request.quickbooks_customer_id,
    submissionType: request.submission_type,
    legalEntity: request.legal_entity,
    dba: request.dba,
    stage: request.stage,
    workflowState: request.workflow_state,
    workflowError: request.workflow_error,
    mondayItemId: request.monday_item_id,
    submittedByEmail: request.submitted_by_email,
    ownerName: request.owner_name,
    ownerEmail: request.owner_email,
    submittedAt: request.submitted_at,
    acceptedAt: request.accepted_at,
    updatedAt: request.updated_at,
    stores: (stores ?? []).filter((store) => store.onboarding_request_id === request.id).map((store) => ({
      name: store.store_name,
      license: store.license_number,
      address: store.address,
      qualificationStatus: store.qualification_status,
      qualificationNote: store.qualification_note,
    })),
    people: (people ?? []).filter((person) => person.onboarding_request_id === request.id).map((person) => ({
      id: person.id,
      role: person.person_role,
      name: person.full_name,
      email: person.email,
      phone: person.phone,
      storeLicense: person.store_license,
      portalProfileId: person.portal_profile_id,
      accessStatus: person.access_status,
      invitedAt: person.invited_at,
    })),
    events: (events ?? []).filter((event) => event.onboarding_request_id === request.id).slice(0, 20).map((event) => ({
      id: event.id,
      source: event.source,
      fromStage: event.from_stage,
      toStage: event.to_stage,
      actorEmail: event.actor_email,
      note: event.note,
      metadata: event.metadata,
      createdAt: event.created_at,
    })),
  }));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!new Set(["GET", "POST"]).has(request.method)) return json(request, { error: "Method not allowed" }, 405);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 200_000) return json(request, { error: "Request is too large" }, 413);
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (request.method === "GET") {
      const [accountRows, onboarding] = await Promise.all([accounts(), onboardingQueue()]);
      return json(request, { accounts: accountRows, onboarding });
    }

    const body = await request.json() as Row;
    const action = String(body.action || "");
    const actor = {
      p_actor_id: caller.profile.id,
      p_actor_email: caller.user.email ?? null,
    };
    let result: Row;
    if (action === "start-qualification") {
      result = await rpc("portal_create_or_link_retailer_account", {
        p_quickbooks_customer_id: String(body.quickbooksCustomerId || "").trim(),
        ...actor,
      });
    } else if (action === "set-account-status") {
      result = await rpc("portal_set_retailer_status", {
        p_account_id: String(body.accountId || ""),
        p_status: String(body.status || ""),
        p_note: String(body.note || "").trim().slice(0, 2000),
        ...actor,
      });
    } else if (action === "add-store") {
      result = await rpc("portal_add_retailer_store", {
        p_account_id: String(body.accountId || ""),
        p_license_number: String(body.licenseNumber || "").trim().slice(0, 120),
        p_display_name: String(body.name || "").trim().slice(0, 200),
        p_address: String(body.address || "").trim().slice(0, 500),
        p_quickbooks_customer_id: String(body.quickbooksCustomerId || "").trim() || null,
        ...actor,
      });
    } else if (action === "set-store-status") {
      const expires = String(body.licenseExpiresOn || "").trim();
      if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new PortalError(400, "Enter the license expiration as YYYY-MM-DD.");
      result = await rpc("portal_set_retailer_store_status", {
        p_account_id: String(body.accountId || ""),
        p_license_number: String(body.licenseNumber || "").trim().slice(0, 120),
        p_license_status: String(body.licenseStatus || ""),
        p_ordering_status: String(body.orderingStatus || ""),
        p_hold_reason: String(body.holdReason || "").trim().slice(0, 2000),
        p_license_expires_on: expires || null,
        ...actor,
      });
    } else if (action === "link-onboarding-account") {
      result = await rpc("portal_link_onboarding_account", {
        p_request_id: String(body.requestId || ""),
        p_account_id: String(body.accountId || ""),
        ...actor,
      });
    } else if (action === "set-onboarding-store") {
      result = await rpc("portal_set_onboarding_store_qualification", {
        p_request_id: String(body.requestId || ""),
        p_license_number: String(body.licenseNumber || "").trim().slice(0, 120),
        p_status: String(body.status || ""),
        p_note: String(body.note || "").trim().slice(0, 2000),
        ...actor,
      });
    } else if (action === "advance-onboarding") {
      result = await rpc("portal_advance_onboarding_request", {
        p_request_id: String(body.requestId || ""),
        p_target_stage: String(body.targetStage || ""),
        p_note: String(body.note || "").trim().slice(0, 2000),
        ...actor,
      });
    } else {
      throw new PortalError(400, "Unsupported retailer action");
    }
    return json(request, { ok: true, result });
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-retailers", error);
    return json(request, {
      error: error instanceof PortalError ? error.message : "The retailer account service is temporarily unavailable.",
    }, error instanceof PortalError ? error.status : 500);
  }
});
