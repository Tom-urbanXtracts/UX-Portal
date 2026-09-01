import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };

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
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors(request), "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  } });
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, authorization } });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile")
    .select("id,full_name,org,role,staff_role,active,locations").eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  let canManage = false;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission").select("permission")
      .eq("staff_role", profile.staff_role).eq("permission", "accounts.manage").maybeSingle();
    canManage = !!grant;
  }
  return { user, profile: profile as Row, canManage };
}

async function storesFor(caller: Caller): Promise<Row[]> {
  if (caller.profile.role === "internal") {
    if (!caller.canManage) return [];
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active,approval_threshold_cents,enforce_case_quantity,approval_policy_updated_at")
      .eq("active", true).order("organization").order("display_name");
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  if (caller.profile.role === "owner") {
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active,approval_threshold_cents,enforce_case_quantity,approval_policy_updated_at")
      .eq("organization", caller.profile.org).eq("active", true).order("display_name");
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  if (caller.profile.role !== "buyer") return [];
  const { data: assignments, error: assignmentError } = await service.from("portal_profile_store")
    .select("license_number").eq("profile_id", caller.profile.id);
  if (assignmentError) throw assignmentError;
  const licenses = (assignments ?? []).map((row) => String(row.license_number));
  if (!licenses.length) return [];
  const { data, error } = await service.from("portal_store")
    .select("license_number,organization,display_name,active,approval_threshold_cents,enforce_case_quantity,approval_policy_updated_at")
    .eq("organization", caller.profile.org).eq("active", true).in("license_number", licenses).order("display_name");
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

function serialize(store: Row): Row {
  const threshold = store.approval_threshold_cents;
  return {
    locationLicense: store.license_number,
    locationName: store.display_name,
    organization: store.organization,
    thresholdCents: threshold === null || threshold === undefined ? null : Number(threshold),
    mode: threshold === null || threshold === undefined ? "disabled" : Number(threshold) === 0 ? "all_buyer_orders" : "above_threshold",
    enforceCaseQuantity: store.enforce_case_quantity === true,
    updatedAt: store.approval_policy_updated_at,
  };
}

async function audit(caller: Caller, store: Row, thresholdCents: number | null): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: caller.profile.id,
    actor_org: caller.profile.org,
    action: "order-approval-policy-updated",
    target_org: store.organization,
    detail: {
      locationLicense: store.license_number,
      locationName: store.display_name,
      thresholdCents,
      mode: thresholdCents === null ? "disabled" : thresholdCents === 0 ? "all_buyer_orders" : "above_threshold",
    },
  });
  if (error) throw error;
}

async function auditCasePolicy(caller: Caller, store: Row, enabled: boolean): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: caller.profile.id,
    actor_org: caller.profile.org,
    action: "order-case-policy-updated",
    target_org: store.organization,
    detail: {
      locationLicense: store.license_number,
      locationName: store.display_name,
      enforceCaseQuantity: enabled,
    },
  });
  if (error) throw error;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!new Set(["GET", "POST"]).has(request.method)) return json(request, { error: "Method not allowed" }, 405);
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (!new Set(["internal", "owner", "buyer"]).has(String(caller.profile.role))) return json(request, { error: "Forbidden" }, 403);
    if (caller.profile.role === "internal" && !caller.canManage) return json(request, { error: "Forbidden" }, 403);

    if (request.method === "GET") {
      return json(request, { policies: (await storesFor(caller)).map(serialize) });
    }

    if (caller.profile.role !== "internal" || !caller.canManage) {
      return json(request, { error: "Only Administrator, Operations, or Sales may change store approval policy." }, 403);
    }
    const body = await request.json() as Row;
    const action = String(body.action || "");
    const locationLicense = String(body.locationLicense || "").trim().slice(0, 120);
    const stores = await storesFor(caller);
    const store = stores.find((row) => String(row.license_number) === locationLicense);
    if (!store) return json(request, { error: "Store not found" }, 404);
    if (action === "update-case-policy") {
      if (typeof body.enforceCaseQuantity !== "boolean") {
        return json(request, { error: "Case enforcement must be true or false." }, 400);
      }
      const { error } = await service.from("portal_store").update({
        enforce_case_quantity: body.enforceCaseQuantity,
        approval_policy_updated_by: caller.profile.id,
        approval_policy_updated_at: new Date().toISOString(),
      }).eq("license_number", locationLicense);
      if (error) throw error;
      await auditCasePolicy(caller, store, body.enforceCaseQuantity);
      const policies = (await storesFor(caller)).map(serialize);
      return json(request, { ok: true, policy: policies.find((row) => row.locationLicense === locationLicense), policies });
    }
    if (action !== "update") return json(request, { error: "Unsupported policy action" }, 400);
    const mode = String(body.mode || "").trim();
    let thresholdCents: number | null;
    if (mode === "disabled") thresholdCents = null;
    else if (mode === "all_buyer_orders") thresholdCents = 0;
    else if (mode === "above_threshold") {
      thresholdCents = Number(body.thresholdCents);
      if (!Number.isInteger(thresholdCents) || thresholdCents <= 0 || thresholdCents > 100000000) {
        return json(request, { error: "Enter a valid positive approval threshold." }, 400);
      }
    } else return json(request, { error: "Choose a supported approval policy." }, 400);

    const { error } = await service.from("portal_store").update({
      approval_threshold_cents: thresholdCents,
      approval_policy_updated_by: caller.profile.id,
      approval_policy_updated_at: new Date().toISOString(),
    }).eq("license_number", locationLicense);
    if (error) throw error;
    await audit(caller, store, thresholdCents);
    const policies = (await storesFor(caller)).map(serialize);
    return json(request, { ok: true, policy: policies.find((row) => row.locationLicense === locationLicense), policies });
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "Unexpected order policy error" }, 500);
  }
});
