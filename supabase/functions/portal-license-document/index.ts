import { requestWorkspace, storeContext, StoreAccessError } from "../_shared/request-workspace.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

// License documents are private onboarding objects. Every link is issued only
// after portal_authorize_license_document authorizes and audits the read in the
// database, and is a short-lived signed URL. No object path is accepted from or
// returned to the browser, and no public or unsigned URL is ever produced.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "portal-onboarding-documents";
const SIGNED_URL_TTL_SECONDS = 60;
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; internal: boolean; membershipId: string | null };

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
      "https://portal.urbanxtracts.com",
      "https://tom-urbanxtracts.github.io",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(candidate)
    ? candidate
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "x-ux-membership-id, x-ux-organization-id, authorization, apikey, content-type",
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
    },
  });
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const DENIED = "This document is outside your access.";

// Owning Account Owner (Store membership) or an Internal member; the database
// decides Compliance, Finance and portal Administrator authority.
async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  if (!verifiedTokenIsAuthenticated(authorization)) return null;
  const user = await response.json() as Row;
  const { data: rawProfile, error } = await service.from("portal_profile")
    .select("id,org,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (error || !rawProfile || rawProfile.active === false) return null;
  const profile = await requestWorkspace(service, request, user, rawProfile as Row, "license_documents.read");
  if (profile.role === "internal") return { user, profile, internal: true, membershipId: null };
  const context = storeContext(profile);
  if (!context || context.memberRole !== "store_owner") throw new StoreAccessError(403, DENIED);
  return { user, profile, internal: false, membershipId: context.membershipId };
}

// The request names a document and an access mode only. Paths, URLs, buckets
// and actor or membership identifiers are never accepted from the browser.
async function issueLicenseDocumentLink(caller: Caller, body: Row): Promise<Row> {
  const keys = Object.keys(body || {});
  if (keys.some((key) => !["action", "documentId", "access"].includes(key))) {
    throw new PortalError(400, "Request a license document by its document ID only.");
  }
  const access = body.access === undefined ? "read" : body.access;
  if (!uuid(body.documentId) || !["read", "download"].includes(String(access))) {
    throw new PortalError(400, "Choose a license document and read or download access.");
  }
  const documentId = String(body.documentId).toLowerCase();
  const { data, error } = await service.rpc("portal_authorize_license_document", {
    p_actor_id: caller.profile.id,
    p_membership_id: caller.membershipId,
    p_document_id: documentId,
    p_access: access,
  });
  if (error) {
    if (error.code === "42501") throw new PortalError(403, DENIED);
    if (error.code === "22023") throw new PortalError(400, "Choose a license document and read or download access.");
    throw new PortalError(503, "The license document could not be authorized.");
  }
  const record = (data || {}) as Row;
  const requestId = String(record.onboardingRequestId || "");
  const sha256 = String(record.sha256 || "");
  const objectPath = String(record.objectPath || "");
  // Defense in depth: the stored path must be exactly the archive path for this
  // document; a stale or forged path is never signed.
  const pathOk = uuid(requestId) && /^[0-9a-f]{64}$/.test(sha256) &&
    new RegExp(`^${requestId}/${sha256}\\.(pdf|png|jpg)$`).test(objectPath);
  if (String(record.documentId || "").toLowerCase() !== documentId || !pathOk) {
    throw new PortalError(403, DENIED);
  }
  const { data: signed, error: signError } = await service.storage.from(BUCKET).createSignedUrl(
    objectPath,
    SIGNED_URL_TTL_SECONDS,
    access === "download" ? { download: String(record.originalName || "license") } : undefined,
  );
  const signedUrl = String(signed?.signedUrl || "");
  // Only a signed object URL for this bucket is returned; anything else fails closed.
  if (signError || !signedUrl.startsWith(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/`) || !/[?&]token=[^&]+/.test(signedUrl)) {
    throw new PortalError(503, "A secure document link could not be issued.");
  }
  return {
    documentId,
    access,
    signedUrl,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    originalName: String(record.originalName || ""),
    contentType: String(record.contentType || ""),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    const body = await request.json().catch(() => null) as Row | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.action !== "issue") {
      return json(request, { error: "Unsupported license document action." }, 400);
    }
    return json(request, await issueLicenseDocumentLink(caller, body));
  } catch (error) {
    if (error instanceof StoreAccessError) return json(request, { error: error.message }, error.status);
    if (error instanceof PortalError) return json(request, { error: error.message }, error.status);
    console.error("portal-license-document request failed");
    return json(request, { error: "The license document service is unavailable." }, 503);
  }
});
