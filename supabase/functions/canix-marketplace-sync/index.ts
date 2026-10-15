import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CANIX_API_KEY = Deno.env.get("CANIX_API_KEY") ?? "";
const CANIX_MARKETPLACE_TOKEN = Deno.env.get("CANIX_MARKETPLACE_TOKEN") ?? "";
const CANIX_CRON_SECRET = Deno.env.get("CANIX_CRON_SECRET") ?? "";
const SHOP_SLUG = Deno.env.get("CANIX_MARKETPLACE_SHOP_SLUG") ??
  "urbanXtracts";
const SHOP_GRAPHQL_URL = "https://api.canix.com/shop/graphql";

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

class MarketplaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://portal.urbanxtracts.com",
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "https://tom-urbanxtracts.github.io",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(candidate)
    ? candidate
    : "https://portal.urbanxtracts.com";
}

function headers(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-canix-cron-secret",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object") as Row[]
    : [];
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericGid(value: unknown): string | null {
  const encoded = clean(value, 500);
  if (!encoded) return null;
  try {
    const match = atob(encoded).match(/\/(\d+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function imageUrl(value: unknown): string | null {
  try {
    const url = new URL(clean(value, 2000));
    return url.protocol === "https:" && url.hostname === "assets.canix.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function authorize(request: Request): Promise<void> {
  const cronSecret = request.headers.get("x-canix-cron-secret") ?? "";
  if (
    CANIX_CRON_SECRET && cronSecret.length > 20 &&
    cronSecret === CANIX_CRON_SECRET
  ) return;

  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) throw new MarketplaceError(403, "Forbidden");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new MarketplaceError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data: profile, error: profileError } = await service.from(
    "portal_profile",
  ).select("id,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.active === false || profile.role !== "internal") {
    throw new MarketplaceError(403, "Forbidden");
  }
  const { data: grant, error: grantError } = await service.from(
    "portal_role_permission",
  ).select("permission").eq("staff_role", profile.staff_role)
    .eq("permission", "catalog.manage").maybeSingle();
  if (grantError) throw grantError;
  if (!grant) throw new MarketplaceError(403, "Forbidden");
}

async function graphql(
  operationName: string,
  query: string,
  variables: Row,
): Promise<Row> {
  if (!CANIX_MARKETPLACE_TOKEN && !CANIX_API_KEY) {
    throw new MarketplaceError(
      503,
      "A Canix Marketplace service credential is not configured.",
    );
  }
  const requestHeaders: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (CANIX_MARKETPLACE_TOKEN) {
    requestHeaders.authorization = `Bearer ${CANIX_MARKETPLACE_TOKEN}`;
  }
  if (CANIX_API_KEY) requestHeaders["X-API-KEY"] = CANIX_API_KEY;
  const response = await fetch(
    `${SHOP_GRAPHQL_URL}?gql=${encodeURIComponent(operationName)}`,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ operationName, variables, query }),
    },
  );
  const body = await response.json().catch(() => ({})) as Row;
  if (!response.ok) {
    throw new MarketplaceError(
      502,
      `Canix Marketplace returned ${response.status}.`,
    );
  }
  const errors = rows(body.errors);
  if (errors.length) {
    throw new MarketplaceError(
      502,
      clean(errors[0].message, 500) || "Canix Marketplace returned an error.",
    );
  }
  return object(body.data);
}

const SHOP_IDENTITY_QUERY =
  `query MarketplaceShopIdentity($shopSlug: String!, $sortOption: ProductSortOptionInput!) {
  shop(slug: $shopSlug) {
    id
    products(first: 1, sortOption: $sortOption) { count }
  }
}`;

const SHOP_PRODUCTS_QUERY =
  `query ShopListItemsQuery($shopSlug: String!, $first: Int, $after: String, $marketplaceShopId: ID!, $sortOption: ProductSortOptionInput!) {
  shop(slug: $shopSlug) {
    id
    products(first: $first, after: $after, sortOption: $sortOption) {
      count
      edges {
        cursor
        node {
          id
          name
          brand { id name }
          itemCategory { id name }
          productPhotos { url type }
          prices(marketplaceShopId: $marketplaceShopId) {
            effectivePrice { cents }
            msrp { cents }
          }
          availableToSellQuantity {
            scalar
            unit { abbreviation name singularName quantityType }
          }
          saleUnit { abbreviation name singularName quantityType }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function fetchMarketplace(): Promise<{
  shopId: string;
  totalCount: number;
  products: Row[];
}> {
  const sortOption = { field: "name", direction: "asc" };
  const identity = object(
    (await graphql(
      "MarketplaceShopIdentity",
      SHOP_IDENTITY_QUERY,
      { shopSlug: SHOP_SLUG, sortOption },
    )).shop,
  );
  const shopId = clean(identity.id, 500);
  if (!shopId) {
    throw new MarketplaceError(
      404,
      "The Canix Marketplace shop was not found.",
    );
  }

  const products: Row[] = [];
  let cursor: string | null = null;
  let totalCount = Number(object(identity.products).count ?? 0);
  for (let page = 0; page < 20; page += 1) {
    const data = await graphql("ShopListItemsQuery", SHOP_PRODUCTS_QUERY, {
      shopSlug: SHOP_SLUG,
      first: 50,
      after: cursor,
      marketplaceShopId: shopId,
      sortOption,
    });
    const connection = object(object(data.shop).products);
    if (!Object.keys(connection).length) {
      throw new MarketplaceError(
        502,
        "The Canix Shop credential cannot read Marketplace products.",
      );
    }
    totalCount = Number(connection.count ?? totalCount);
    for (const edge of rows(connection.edges)) {
      const node = object(edge.node);
      const gid = clean(node.id, 500);
      const productId = numericGid(gid);
      if (!productId) continue;
      const brand = object(node.brand);
      const category = object(node.itemCategory);
      const price = object(node.prices);
      const effectivePrice = object(price.effectivePrice);
      const msrp = object(price.msrp);
      const availability = object(node.availableToSellQuantity);
      const quantityUnit = object(availability.unit);
      const saleUnit = object(node.saleUnit);
      const firstPhoto = rows(node.productPhotos)
        .map((photo) => imageUrl(photo.url)).find(Boolean) ?? null;
      products.push({
        marketplace_product_id: productId,
        product_gid: gid,
        product_name: clean(node.name, 500) || `Canix product ${productId}`,
        brand_id: numericGid(brand.id),
        brand_name: clean(brand.name, 300) || "Brand not recorded",
        item_category_name: clean(category.name, 300) || null,
        price_cents: finiteNumber(effectivePrice.cents),
        msrp_cents: finiteNumber(msrp.cents),
        available_quantity: finiteNumber(availability.scalar),
        sale_unit: clean(
          saleUnit.singularName ?? saleUnit.abbreviation ?? saleUnit.name ??
            quantityUnit.singularName ?? quantityUnit.abbreviation ??
            quantityUnit.name,
          80,
        ) || null,
        has_image: Boolean(firstPhoto),
        image_url: firstPhoto,
      });
    }
    const pageInfo = object(connection.pageInfo);
    if (pageInfo.hasNextPage !== true) break;
    cursor = clean(pageInfo.endCursor, 1000) || null;
    if (!cursor) {
      throw new MarketplaceError(
        502,
        "Canix Marketplace pagination stopped early.",
      );
    }
  }
  if (!products.length || products.length < totalCount) {
    throw new MarketplaceError(
      502,
      `Canix Marketplace returned ${products.length} of ${totalCount} products.`,
    );
  }
  return { shopId, totalCount, products };
}

async function syncMarketplace(): Promise<Row> {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: runningError } = await service.from(
    "canix_marketplace_sync_state",
  ).upsert({
    id: 1,
    shop_slug: SHOP_SLUG,
    source_url: `https://app.canix.com/marketplace/${SHOP_SLUG}`,
    status: "running",
    updated_at: now,
  });
  if (runningError) throw runningError;

  try {
    const snapshot = await fetchMarketplace();
    const syncedRows = snapshot.products.map((product) => ({
      ...product,
      sync_run_id: runId,
      shop_slug: SHOP_SLUG,
      synced_at: now,
    }));
    for (let start = 0; start < syncedRows.length; start += 250) {
      const { error } = await service.from("canix_marketplace_product_snapshot")
        .insert(syncedRows.slice(start, start + 250));
      if (error) throw error;
    }
    const { error: stateError } = await service.from(
      "canix_marketplace_sync_state",
    ).update({
      marketplace_shop_id: snapshot.shopId,
      status: "success",
      source_mode: "canix_shop_graphql",
      snapshot_scope: "full_shop",
      last_successful_run_id: runId,
      last_successful_at: now,
      total_shop_product_count: snapshot.totalCount,
      snapshot_product_count: syncedRows.length,
      last_error: null,
      updated_at: now,
    }).eq("id", 1);
    if (stateError) throw stateError;
    await service.from("canix_marketplace_product_snapshot").delete().neq(
      "sync_run_id",
      runId,
    );
    return {
      ok: true,
      syncRunId: runId,
      shopSlug: SHOP_SLUG,
      productCount: syncedRows.length,
      totalShopProductCount: snapshot.totalCount,
      lastSuccessfulAt: now,
    };
  } catch (error) {
    await service.from("canix_marketplace_product_snapshot").delete().eq(
      "sync_run_id",
      runId,
    );
    await service.from("canix_marketplace_sync_state").update({
      status: "error",
      last_error: error instanceof Error
        ? error.message.slice(0, 1000)
        : "Marketplace sync failed.",
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    await authorize(request);
    return json(request, await syncMarketplace());
  } catch (error) {
    if (!(error instanceof MarketplaceError)) {
      console.error("canix-marketplace-sync", error);
    }
    return json(request, {
      error: error instanceof MarketplaceError
        ? error.message
        : "The Canix Marketplace sync failed.",
    }, error instanceof MarketplaceError ? error.status : 500);
  }
});
