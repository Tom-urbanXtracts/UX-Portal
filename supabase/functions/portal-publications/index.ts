import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_RESOLVER_RATE_SECRET = Deno.env.get("PUBLIC_RESOLVER_RATE_SECRET") ?? "";
const PUBLICATION_RELEASE_ENABLED = Deno.env.get("PUBLICATION_RELEASE_ENABLED") === "true";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row };
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
    "access-control-max-age": "86400", vary: "Origin",
  };
}
function json(request: Request, body: unknown, status = 200, publicResponse = false): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors(request), "content-type": "application/json; charset=utf-8",
    "cache-control": publicResponse ? "public, max-age=60" : "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}
function clean(value: unknown, max = 1000): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function protectedScope(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(PUBLIC_RESOLVER_RATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenHasAal2(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, authorization } });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select("id,full_name,role,staff_role,active")
    .eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") return null;
  const { data: grant } = await service.from("portal_role_permission").select("permission")
    .eq("staff_role", profile.staff_role).eq("permission", "publications.manage").maybeSingle();
  return grant ? { user, profile: profile as Row } : null;
}

function codeValue(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const parts = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${parts.slice(0, 5)}-${parts.slice(5, 10)}-${parts.slice(10, 15)}`;
}

async function draftCoa(caller: Caller, packageId: number): Promise<Row> {
  if (!Number.isSafeInteger(packageId) || packageId < 1) throw new PortalError(400, "Choose a Canix package.");
  const { data: coa, error } = await service.from("canix_package_coa").select("*").eq("package_id", packageId).maybeSingle();
  if (error) throw error;
  if (!coa) throw new PortalError(409, "That package has no normalized COA record.");
  const { data: sync } = await service.from("canix_sync_state").select("last_successful_run_id").eq("id", 1).maybeSingle();
  const { data: pkg } = sync?.last_successful_run_id
    ? await service.from("canix_package_current").select("item_name,product_name,packaged_date")
      .eq("sync_run_id", sync.last_successful_run_id).eq("package_id", packageId).maybeSingle()
    : { data: null };
  const payload = {
    productName: pkg?.product_name || pkg?.item_name || "Product name not recorded",
    complianceTag: coa.compliance_tag,
    batchNumber: coa.batch_number,
    packagedDate: pkg?.packaged_date || null,
    testedAt: coa.tested_at,
    resultStatus: coa.result_status,
    labName: coa.lab_name,
    version: coa.version,
    cannabinoids: coa.cannabinoids || [],
    terpenes: coa.terpenes || [],
    profile: coa.profile || {},
  };
  const { data, error: insertError } = await service.from("portal_publication").insert({
    publication_type: "coa", source_package_id: packageId,
    source_compliance_tag: coa.compliance_tag, state: "draft",
    display_payload: payload, created_by: caller.profile.id,
  }).select("*").single();
  if (insertError) throw insertError;
  return data as Row;
}

async function draftRecall(caller: Caller, body: Row): Promise<Row> {
  const tag = clean(body.complianceTag, 160);
  const title = clean(body.title, 240);
  const notice = clean(body.notice, 5000);
  if (!tag || title.length < 3 || notice.length < 20) {
    throw new PortalError(400, "A compliance tag, title, and approved notice draft are required.");
  }
  const { data, error } = await service.from("portal_publication").insert({
    publication_type: "recall", source_compliance_tag: tag, state: "draft",
    display_payload: { complianceTag: tag, title, notice }, created_by: caller.profile.id,
  }).select("*").single();
  if (error) throw error;
  return data as Row;
}

async function transition(caller: Caller, body: Row): Promise<Row> {
  const id = clean(body.publicationId, 80);
  const action = clean(body.action, 40);
  const { data: current, error } = await service.from("portal_publication").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!current) throw new PortalError(404, "Publication record not found.");
  if (action === "approve") {
    if (current.state !== "draft") throw new PortalError(409, "Only a draft can be approved.");
    if (String(current.created_by) === String(caller.profile.id)) throw new PortalError(409, "A different authorized user must approve this publication.");
    if (current.publication_type === "recall") {
      const { data: policy } = await service.from("portal_notification_policy").select("recall_copy_approved").eq("id", 1).single();
      if (policy?.recall_copy_approved !== true) throw new PortalError(409, "Compliance must approve recall wording and trigger policy first.");
    }
    const { data, error: updateError } = await service.from("portal_publication").update({
      state: "approved", approved_by: caller.profile.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", id).eq("state", "draft").select("*").single();
    if (updateError) throw updateError;
    return data as Row;
  }
  if (action === "publish") {
    if (!PUBLICATION_RELEASE_ENABLED) throw new PortalError(503, "Public publication remains off until Compliance and Security complete release approval.");
    if (current.state !== "approved") throw new PortalError(409, "Only an approved record can be published.");
    const code = codeValue();
    const { data, error: updateError } = await service.from("portal_publication").update({
      state: "published", public_code_hash: await sha256(code), published_by: caller.profile.id,
      published_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", id).eq("state", "approved").select("*").single();
    if (updateError) throw updateError;
    return { ...data, publicCode: code } as Row;
  }
  if (action === "revoke") {
    if (!new Set(["approved", "published"]).has(String(current.state))) throw new PortalError(409, "That publication is not active.");
    const { data, error: updateError } = await service.from("portal_publication").update({
      state: "revoked", revoked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", id).in("state", ["approved", "published"]).select("*").single();
    if (updateError) throw updateError;
    return data as Row;
  }
  throw new PortalError(400, "Unsupported publication action.");
}

async function publicResolve(request: Request, code: string): Promise<Response> {
  const unavailable = () => json(request, { state: "unavailable", message: "This public record is not available." }, 404, true);
  if (!PUBLICATION_RELEASE_ENABLED || PUBLIC_RESOLVER_RATE_SECRET.length < 32) return unavailable();
  const normalized = code.toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(normalized)) return unavailable();
  const source = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  const scope = await protectedScope(`public-record:${source}:${request.headers.get("user-agent") || ""}`);
  const { data: allowed, error: rateError } = await service.rpc("portal_claim_public_intake_rate", { p_scope_key: scope, p_limit: 20 });
  if (rateError || allowed !== true) return json(request, { state: "rate_limited", message: "Try again later." }, 429, true);
  const { data, error } = await service.from("portal_publication").select("*")
    .eq("public_code_hash", await sha256(normalized)).eq("state", "published").maybeSingle();
  if (error || !data) return unavailable();
  let documentUrl: string | null = null;
  if (data.publication_type === "coa" && data.source_package_id) {
    const { data: coa } = await service.from("canix_package_coa").select("portal_asset_id")
      .eq("package_id", data.source_package_id).maybeSingle();
    if (coa?.portal_asset_id) {
      const { data: asset } = await service.from("portal_asset").select("bucket_id,storage_path,state,scan_state")
        .eq("id", coa.portal_asset_id).eq("state", "active").eq("scan_state", "clean").maybeSingle();
      if (asset) {
        const { data: signed } = await service.storage.from(asset.bucket_id).createSignedUrl(asset.storage_path, 300);
        documentUrl = signed?.signedUrl || null;
      }
    }
  }
  return json(request, {
    state: "published", type: data.publication_type, publishedAt: data.published_at,
    record: data.display_payload, documentUrl,
  }, 200, true);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  try {
    const url = new URL(request.url);
    const publicCode = clean(url.searchParams.get("code"), 40);
    if (request.method === "GET" && publicCode) return await publicResolve(request, publicCode);
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    if (request.method === "GET") {
      const { data, error } = await service.from("portal_publication").select("*")
        .order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json(request, { publications: data ?? [], releaseEnabled: PUBLICATION_RELEASE_ENABLED });
    }
    if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
    const body = await request.json() as Row;
    const action = clean(body.action, 40);
    if (action === "draft-coa") return json(request, { publication: await draftCoa(caller, Number(body.packageId)) }, 201);
    if (action === "draft-recall") return json(request, { publication: await draftRecall(caller, body) }, 201);
    return json(request, { publication: await transition(caller, body) });
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-publications", error);
    return json(request, { error: error instanceof PortalError ? error.message : "The publication service is temporarily unavailable." },
      error instanceof PortalError ? error.status : 502);
  }
});
