import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { approvedHttpsUrl } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_PRODUCT_SECRET = Deno.env.get("MONDAY_PRODUCT_SECRET") ?? "";
const ASSET_HOSTS = new Set([
  ...String(Deno.env.get("PORTAL_EXTERNAL_ASSET_HOSTS") ?? "").split(",").map((
    host,
  ) => host.trim().toLowerCase()).filter(Boolean),
  (() => {
    try {
      return new URL(SUPABASE_URL).hostname.toLowerCase();
    } catch {
      return "";
    }
  })(),
].filter(Boolean));
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };

class ProductError extends Error {
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
    ]).has(candidate)
    ? candidate
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-ux-monday-secret",
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

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function clean(value: unknown, max = 1200): string | null {
  if (value === null || value === undefined) return null;
  const output = String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
  return output || null;
}

function cleanList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.map((item) => clean(item, maxLength)).filter((
        item,
      ): item is string => !!item),
    ),
  ).slice(0, maxItems);
}

function httpsUrl(value: unknown): string | null {
  return approvedHttpsUrl(clean(value, 2000), ASSET_HOSTS);
}

function iso(value: unknown): string | null {
  const raw = clean(value, 100);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile")
    .select("id,full_name,org,role,staff_role,active").eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.active === false) return null;
  let canManage = false;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission").select(
      "permission",
    )
      .eq("staff_role", profile.staff_role).eq("permission", "catalog.manage")
      .maybeSingle();
    canManage = !!grant;
  }
  return { user, profile: profile as Row, canManage };
}

function serialize(row: Row): Row {
  return {
    canixItemId: row.canix_item_id,
    mondayItemId: row.monday_item_id,
    mondayBoardId: row.monday_board_id,
    publicationState: row.publication_state,
    shortDescription: row.short_description,
    longDescription: row.long_description,
    sellingPoints: row.selling_points ?? [],
    ingredients: row.ingredients,
    usageInformation: row.usage_information,
    productProfile: row.product_profile,
    imageUrl: httpsUrl(row.image_url),
    keywords: row.keywords ?? [],
    sourceUpdatedAt: row.source_updated_at,
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

async function verifyCanixItems(itemIds: number[]): Promise<void> {
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  )
    .select("last_successful_run_id").eq("id", 1).single();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) {
    throw new ProductError(
      409,
      "A successful Canix snapshot is required before product content can be linked.",
    );
  }
  const { data, error } = await service.from("canix_package_current").select(
    "item_id",
  )
    .eq("sync_run_id", state.last_successful_run_id).in("item_id", itemIds);
  if (error) throw error;
  const found = new Set((data ?? []).map((row) => Number(row.item_id)));
  const missing = itemIds.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ProductError(
      409,
      `Canix item ${missing[0]} is not present in the current snapshot.`,
    );
  }
}

async function upsertItems(
  items: Row[],
  caller: Caller | null,
  source: "monday" | "internal",
): Promise<Row[]> {
  if (!items.length || items.length > 100) {
    throw new ProductError(
      400,
      "Submit between one and 100 product content records.",
    );
  }
  const itemIds = items.map((item) => Number(item.canixItemId));
  if (itemIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ProductError(400, "Every record requires a valid Canix item ID.");
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw new ProductError(
      400,
      "A Canix item may appear only once per request.",
    );
  }
  await verifyCanixItems(itemIds);

  const { data: existingRows, error: existingError } = await service.from(
    "portal_product_content",
  )
    .select("*").in("canix_item_id", itemIds);
  if (existingError) throw existingError;
  const existingById = new Map(
    (existingRows ?? []).map((row) => [Number(row.canix_item_id), row as Row]),
  );
  const results: Row[] = [];

  for (const item of items) {
    const canixItemId = Number(item.canixItemId);
    const existing = existingById.get(canixItemId) ?? {};
    const mondayItemId = clean(item.mondayItemId, 160) ??
      clean(existing.monday_item_id, 160);
    const mondayBoardId = clean(item.mondayBoardId, 160) ??
      clean(existing.monday_board_id, 160);
    if (source === "monday" && (!mondayItemId || !mondayBoardId)) {
      throw new ProductError(
        400,
        "Monday product updates require both the Monday item and board identifiers.",
      );
    }
    const requestedState = clean(item.publicationState, 20) ??
      clean(existing.publication_state, 20) ?? "draft";
    if (!new Set(["draft", "published", "archived"]).has(requestedState)) {
      throw new ProductError(
        400,
        "Publication state must be draft, published, or archived.",
      );
    }
    const suppliedImage = Object.prototype.hasOwnProperty.call(
      item,
      "imageUrl",
    );
    const imageUrl = suppliedImage
      ? httpsUrl(item.imageUrl)
      : httpsUrl(existing.image_url);
    if (suppliedImage && clean(item.imageUrl, 2000) && !imageUrl) {
      throw new ProductError(
        400,
        "Product images must use HTTPS on an approved asset host.",
      );
    }
    const now = new Date().toISOString();
    const record = {
      canix_item_id: canixItemId,
      monday_item_id: mondayItemId,
      monday_board_id: mondayBoardId,
      publication_state: requestedState,
      short_description:
        Object.prototype.hasOwnProperty.call(item, "shortDescription")
          ? clean(item.shortDescription, 600)
          : existing.short_description ?? null,
      long_description:
        Object.prototype.hasOwnProperty.call(item, "longDescription")
          ? clean(item.longDescription, 5000)
          : existing.long_description ?? null,
      selling_points:
        Object.prototype.hasOwnProperty.call(item, "sellingPoints")
          ? cleanList(item.sellingPoints, 20, 300)
          : existing.selling_points ?? [],
      ingredients: Object.prototype.hasOwnProperty.call(item, "ingredients")
        ? clean(item.ingredients, 3000)
        : existing.ingredients ?? null,
      usage_information:
        Object.prototype.hasOwnProperty.call(item, "usageInformation")
          ? clean(item.usageInformation, 3000)
          : existing.usage_information ?? null,
      product_profile:
        Object.prototype.hasOwnProperty.call(item, "productProfile")
          ? clean(item.productProfile, 3000)
          : existing.product_profile ?? null,
      image_url: imageUrl,
      keywords: Object.prototype.hasOwnProperty.call(item, "keywords")
        ? cleanList(item.keywords, 50, 100)
        : existing.keywords ?? [],
      source_updated_at: iso(item.sourceUpdatedAt) ??
        existing.source_updated_at ?? null,
      last_synced_at: now,
      updated_by: caller?.profile.id ?? null,
      updated_by_email: caller?.user.email ??
        (source === "monday" ? "Monday product sync" : null),
      updated_at: now,
    };
    const previousState = clean(existing.publication_state, 20);
    const action = !Object.keys(existing).length
      ? "created"
      : requestedState === "archived" && previousState !== "archived"
      ? "archived"
      : requestedState === "published" && previousState !== "published"
      ? "published"
      : "updated";
    const { data, error } = await service.rpc("portal_upsert_product_content", {
      p_canix_item_id: canixItemId,
      p_monday_item_id: record.monday_item_id,
      p_monday_board_id: record.monday_board_id,
      p_publication_state: record.publication_state,
      p_short_description: record.short_description,
      p_long_description: record.long_description,
      p_selling_points: record.selling_points,
      p_ingredients: record.ingredients,
      p_usage_information: record.usage_information,
      p_product_profile: record.product_profile,
      p_image_url: record.image_url,
      p_keywords: record.keywords,
      p_source_updated_at: record.source_updated_at,
      p_actor_id: record.updated_by,
      p_actor_email: record.updated_by_email,
      p_source: source,
      p_action: action,
      p_detail: {
        mondayItemId,
        mondayBoardId,
        sourceUpdatedAt: record.source_updated_at,
      },
    });
    if (error) throw error;
    results.push(serialize(data as Row));
  }
  return results;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const suppliedSecret = request.headers.get("x-ux-monday-secret") ?? "";
    const mondayAuthorized = Boolean(MONDAY_PRODUCT_SECRET) &&
      constantTimeEqual(suppliedSecret, MONDAY_PRODUCT_SECRET);
    const caller = mondayAuthorized ? null : await callerFor(request);
    if (request.method === "GET") {
      if (!caller) return json(request, { error: "Forbidden" }, 403);
      let query = service.from("portal_product_content").select("*").order(
        "updated_at",
        { ascending: false },
      ).limit(1000);
      if (!caller.canManage) query = query.eq("publication_state", "published");
      const { data, error } = await query;
      if (error) throw error;
      return json(request, {
        products: (data ?? []).map((row) => serialize(row as unknown as Row)),
      });
    }
    if (!mondayAuthorized && (!caller || !caller.canManage)) {
      return json(request, { error: "Forbidden" }, 403);
    }
    const body = await request.json() as Row;
    const items = Array.isArray(body.items)
      ? body.items.filter((item) => item && typeof item === "object") as Row[]
      : [body];
    const products = await upsertItems(
      items,
      caller,
      mondayAuthorized ? "monday" : "internal",
    );
    return json(request, { ok: true, products }, 200);
  } catch (error) {
    const status = error instanceof ProductError ? error.status : 502;
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected product content error",
    }, status);
  }
});
