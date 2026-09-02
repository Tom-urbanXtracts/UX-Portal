import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "portal-assets";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; permissions: Set<string> };

class AssetError extends Error {
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
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

function clean(value: unknown, max = 300): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
}

function positiveId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AssetError(400, "A positive Canix identifier is required.");
  }
  return id;
}

function extension(contentType: string): string {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  } as Record<string, string>)[contentType] ?? "";
}

function requiredPermission(purpose: string): string {
  return purpose === "product_image" ? "catalog.manage" : "quality.manage";
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") {
    return null;
  }
  const { data: grants, error } = await service.from("portal_role_permission")
    .select("permission").eq("staff_role", profile.staff_role);
  if (error) throw error;
  return {
    user,
    profile: profile as Row,
    permissions: new Set((grants ?? []).map((row) => String(row.permission))),
  };
}

function requirePurposeAccess(caller: Caller, purpose: string): void {
  if (!new Set(["product_image", "coa_document"]).has(purpose)) {
    throw new AssetError(400, "Choose a supported asset purpose.");
  }
  if (!caller.permissions.has(requiredPermission(purpose))) {
    throw new AssetError(403, "This workforce role cannot manage that asset.");
  }
}

async function verifyOwner(
  purpose: string,
  ownerId: number,
): Promise<{ ownerType: string }> {
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  ).select("last_successful_run_id").eq("id", 1).single();
  if (stateError || !state?.last_successful_run_id) {
    throw new AssetError(503, "A successful Canix snapshot is required.");
  }
  const ownerType = purpose === "product_image"
    ? "canix_item"
    : "canix_package";
  const field = purpose === "product_image" ? "item_id" : "package_id";
  const { data, error } = await service.from("canix_package_current")
    .select(field).eq("sync_run_id", state.last_successful_run_id)
    .eq(field, ownerId).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new AssetError(
      409,
      "The Canix record is not in the current snapshot.",
    );
  }
  return { ownerType };
}

async function createUpload(caller: Caller, body: Row): Promise<Row> {
  const purpose = clean(body.purpose, 40);
  requirePurposeAccess(caller, purpose);
  const ownerId = positiveId(body.ownerId);
  const { ownerType } = await verifyOwner(purpose, ownerId);
  const contentType = clean(body.contentType, 100).toLowerCase();
  const expectedExtension = extension(contentType);
  if (!expectedExtension) {
    throw new AssetError(400, "Use JPEG, PNG, WebP, or PDF content.");
  }
  if (purpose === "product_image" && !contentType.startsWith("image/")) {
    throw new AssetError(400, "Product assets must be an approved image type.");
  }
  if (purpose === "coa_document" && contentType !== "application/pdf") {
    throw new AssetError(400, "COA assets must be PDF documents.");
  }
  const sizeBytes = Number(body.sizeBytes);
  const maximum = purpose === "product_image" ? 10_485_760 : 20_971_520;
  if (
    !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maximum
  ) {
    throw new AssetError(
      400,
      `The file must be between 1 byte and ${maximum} bytes.`,
    );
  }
  const originalFilename = clean(body.filename, 240) ||
    `${purpose}.${expectedExtension}`;
  const assetId = crypto.randomUUID();
  const storagePath = `${purpose}/${ownerId}/${assetId}.${expectedExtension}`;
  const { data: asset, error: insertError } = await service.from("portal_asset")
    .insert({
      id: assetId,
      purpose,
      owner_type: ownerType,
      owner_id: ownerId,
      storage_path: storagePath,
      original_filename: originalFilename,
      content_type: contentType,
      declared_size_bytes: sizeBytes,
      created_by: caller.profile.id,
      created_by_email: caller.user.email ?? null,
    }).select("*").single();
  if (insertError) throw insertError;
  const { data: upload, error: uploadError } = await service.storage.from(
    BUCKET,
  ).createSignedUploadUrl(storagePath, { upsert: false });
  if (uploadError) {
    await service.from("portal_asset").delete().eq("id", assetId);
    throw uploadError;
  }
  return {
    assetId,
    purpose,
    ownerId,
    state: asset.state,
    upload: {
      path: upload.path,
      token: upload.token,
      signedUrl: upload.signedUrl,
    },
  };
}

async function assetForReview(caller: Caller, assetId: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) {
    throw new AssetError(400, "A valid asset identifier is required.");
  }
  const { data, error } = await service.from("portal_asset").select("*")
    .eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!data) throw new AssetError(404, "Asset not found.");
  requirePurposeAccess(caller, String(data.purpose));
  return data as Row;
}

async function completeUpload(caller: Caller, assetId: string): Promise<Row> {
  const asset = await assetForReview(caller, assetId);
  if (asset.state !== "pending_upload") {
    throw new AssetError(409, "Only a pending upload can be completed.");
  }
  const path = String(asset.storage_path);
  const slash = path.lastIndexOf("/");
  const prefix = path.slice(0, slash);
  const filename = path.slice(slash + 1);
  const { data: objects, error } = await service.storage.from(BUCKET).list(
    prefix,
    { limit: 2, search: filename },
  );
  if (error) throw error;
  const stored = (objects ?? []).find((object) => object.name === filename);
  if (!stored) throw new AssetError(409, "The uploaded file was not found.");
  const metadata = (stored.metadata ?? {}) as Row;
  const observedSize = Number(metadata.size ?? 0);
  const observedType = clean(metadata.mimetype ?? metadata.contentType, 100)
    .toLowerCase();
  if (
    !Number.isSafeInteger(observedSize) || observedSize <= 0 ||
    observedSize > Number(asset.declared_size_bytes) ||
    (observedType && observedType !== asset.content_type)
  ) {
    await service.from("portal_asset").update({
      state: "quarantined",
      review_note: "Stored object metadata did not match the declared upload.",
      observed_size_bytes: observedSize > 0 ? observedSize : null,
      updated_at: new Date().toISOString(),
    }).eq("id", assetId);
    throw new AssetError(409, "The uploaded file failed metadata validation.");
  }
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await service.from(
    "portal_asset",
  ).update({
    state: "pending_review",
    observed_size_bytes: observedSize,
    updated_at: now,
  }).eq("id", assetId).select("*").single();
  if (updateError) throw updateError;
  return updated as Row;
}

async function reviewAsset(
  caller: Caller,
  assetId: string,
  decision: string,
  note: string,
): Promise<Row> {
  const asset = await assetForReview(caller, assetId);
  if (asset.state !== "pending_review") {
    throw new AssetError(
      409,
      "Only an uploaded asset awaiting review can be decided.",
    );
  }
  if (!new Set(["approve", "quarantine"]).has(decision)) {
    throw new AssetError(400, "Choose approve or quarantine.");
  }
  const { data: updated, error } = await service.rpc("portal_review_asset", {
    p_asset_id: assetId,
    p_decision: decision,
    p_note: note || null,
    p_reviewer_id: caller.profile.id,
    p_reviewer_email: caller.user.email ?? null,
  });
  if (error) throw error;
  return updated as Row;
}

async function listAssets(caller: Caller, request: Request): Promise<Row[]> {
  const url = new URL(request.url);
  const purpose = clean(url.searchParams.get("purpose"), 40);
  if (purpose) requirePurposeAccess(caller, purpose);
  let query = service.from("portal_asset").select(
    "id,purpose,owner_type,owner_id,original_filename,content_type,declared_size_bytes,observed_size_bytes,state,review_note,created_by_email,reviewed_by_email,reviewed_at,created_at,updated_at",
  ).order("updated_at", { ascending: false }).limit(250);
  if (purpose) query = query.eq("purpose", purpose);
  const ownerId = url.searchParams.get("ownerId");
  if (ownerId) query = query.eq("owner_id", positiveId(ownerId));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (request.method === "GET") {
      return json(request, { assets: await listAssets(caller, request) });
    }
    const body = await request.json() as Row;
    const action = clean(body.action, 40);
    if (action === "create-upload") {
      return json(request, await createUpload(caller, body), 201);
    }
    if (action === "complete-upload") {
      return json(
        request,
        await completeUpload(caller, clean(body.assetId, 80)),
      );
    }
    if (action === "review") {
      return json(
        request,
        await reviewAsset(
          caller,
          clean(body.assetId, 80),
          clean(body.decision, 30),
          clean(body.note, 1000),
        ),
      );
    }
    return json(request, { error: "Unsupported asset action" }, 400);
  } catch (error) {
    const status = error instanceof AssetError ? error.status : 502;
    if (!(error instanceof AssetError)) console.error("portal-assets", error);
    return json(request, {
      error: error instanceof AssetError
        ? error.message
        : "The asset service is temporarily unavailable.",
    }, status);
  }
});
