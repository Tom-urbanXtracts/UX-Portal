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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PORTAL_EMAIL_FROM = Deno.env.get("PORTAL_EMAIL_FROM") ??
  "urbanXtracts Portal <portal@updates.urbanxtracts.com>";
const PORTAL_URL = "https://portal.urbanxtracts.com";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = Row & {
  id: string;
  role: string;
  staff_role?: string;
  email?: string;
};

class BrandError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function origin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "https://portal.urbanxtracts.com",
      "https://tom-urbanxtracts.github.io",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(candidate)
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
    },
  });
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function email(value: unknown): string | null {
  const candidate = clean(value, 254).toLowerCase();
  if (!candidate) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
    throw new BrandError(400, "Enter a valid email address.");
  }
  return candidate;
}

function uuid(value: unknown, label = "record"): string {
  const candidate = clean(value, 80);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(candidate)
  ) {
    throw new BrandError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value: unknown): number {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function dayDistance(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

function choice(
  value: unknown,
  allowed: string[],
  fallback: string,
  label: string,
): string {
  const candidate = clean(value, 80) || fallback;
  if (!allowed.includes(candidate)) {
    throw new BrandError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function today(value: unknown): string | null {
  const candidate = clean(value, 10);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new BrandError(400, "Use a valid date.");
  }
  return candidate;
}

function decodeAgreementPdf(file: Row): {
  bytes: Uint8Array;
  contentType: "application/pdf";
  name: string;
} {
  const contentType = clean(file.contentType, 120).toLowerCase();
  const encoded = clean(file.base64, 15_000_000).replace(/\s/g, "");
  if (contentType !== "application/pdf" || !encoded) {
    throw new BrandError(
      400,
      "Attach a PDF agreement that is 10 MB or smaller.",
    );
  }
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new BrandError(400, "The agreement PDF could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (
    !declared || bytes.byteLength !== declared ||
    bytes.byteLength > 10 * 1024 * 1024
  ) {
    throw new BrandError(400, "Agreement PDFs must be 10 MB or smaller.");
  }
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46;
  if (!pdf) {
    throw new BrandError(400, "The uploaded contents do not match a PDF file.");
  }
  return {
    bytes,
    contentType: "application/pdf",
    name: clean(file.name, 240) || "agreement.pdf",
  };
}

async function actorFor(request: Request): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) {
    throw new BrandError(403, "Forbidden");
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new BrandError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active,org")
    .eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (
    !data || data.active === false ||
    !["internal", "brand"].includes(String(data.role))
  ) {
    throw new BrandError(403, "Forbidden");
  }
  return {
    ...data,
    email: clean(user.email, 254) || undefined,
  } as Actor;
}

async function brandAccess(
  actor: Actor,
  organizationId: string,
): Promise<Set<string>> {
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,kind,status")
    .eq("id", organizationId).eq("kind", "brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new BrandError(404, "Brand organization not found.");

  if (actor.role === "internal") {
    const { data: grants, error } = await service.from("portal_role_permission")
      .select("permission").eq("staff_role", actor.staff_role ?? "viewer");
    if (error) throw error;
    const internal = new Set(
      (grants ?? []).map((row) => String(row.permission)),
    );
    if (!internal.has("users.manage") && !internal.has("accounts.manage")) {
      throw new BrandError(
        403,
        "Your workforce role cannot access Brand administration.",
      );
    }
    return new Set([
      "brand.company.read",
      "brand.company.manage",
      "brand.agreements.read",
      "brand.agreements.manage",
      "brand.products.read",
      "brand.products.contribute",
      "brand.purchase_orders.read",
      "brand.purchase_orders.acknowledge",
      "brand.manufacturing.read",
      "brand.manufacturing.contribute",
      "brand.inventory.read",
      "brand.sales.read",
      "brand.financials.read",
      "brand.marketing.read",
      "brand.documents.read",
      "brand.users.read",
    ]);
  }

  const { data: membership, error: membershipError } = await service
    .from("portal_organization_membership").select("member_role")
    .eq("profile_id", actor.id).eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) {
    throw new BrandError(403, "This Brand is outside your access scope.");
  }
  const { data: grants, error: grantError } = await service
    .from("portal_workspace_role_permission").select("permission")
    .eq("workspace", "brand").eq("member_role", membership.member_role);
  if (grantError) throw grantError;
  return new Set((grants ?? []).map((row) => String(row.permission)));
}

function requirePermission(permissions: Set<string>, permission: string): void {
  if (!permissions.has(permission)) {
    throw new BrandError(403, "Your Brand role cannot perform this action.");
  }
}

async function latestCanix(
  account: Row | null,
): Promise<{ rows: Row[]; sync: Row | null }> {
  const { data: sync, error: syncError } = await service.from(
    "canix_sync_state",
  )
    .select(
      "status,last_successful_run_id,last_successful_at,latest_source_updated_at,last_error",
    )
    .eq("id", 1).maybeSingle();
  if (syncError) throw syncError;
  if (
    !account || account.scope_status !== "verified" ||
    !sync?.last_successful_run_id
  ) {
    return { rows: [], sync: (sync ?? null) as Row | null };
  }
  const ownerId = clean(account.canix_owner_id, 40);
  if (!/^\d+$/.test(ownerId)) {
    return { rows: [], sync: (sync ?? null) as Row | null };
  }
  const rows: Row[] = [];
  for (let start = 0;; start += 1000) {
    const { data, error } = await service.from("canix_package_current").select(
      "package_id,item_id,item_name,item_category_name,product_id,product_name,brand_id,brand_name,canix_package_owner_id,canix_package_owner_name,status,status_category,reservation_state,quantity_type,uom_code,case_quantity,case_quantity_unit,facility_id,source_updated_at",
    ).eq("sync_run_id", sync.last_successful_run_id)
      .neq("facility_id", 4546).eq("canix_package_owner_id", Number(ownerId))
      .order("source_updated_at", { ascending: false, nullsFirst: false })
      .range(start, start + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return { rows, sync: sync as Row };
}

async function latestBrandItems(account: Row | null): Promise<Row[]> {
  if (!account || account.scope_status !== "verified") return [];
  const brandId = clean(account.canix_brand_id, 40);
  const brandName = clean(account.canix_brand_name, 200).toLowerCase();
  if (!/^\d+$/.test(brandId) && !brandName) return [];
  const result: Row[] = [];
  for (let start = 0;; start += 1000) {
    let query = service.from("canix_item_current").select(
      "item_id,name,is_active,item_type_name,item_category_name,brand_id,brand_name,product_id,product_brand_id,product_brand_name,quantity_type,sku,accounting_inventory_type,facility_id,source_updated_at",
    ).eq("is_active", true).neq("facility_id", 4546);
    query = /^\d+$/.test(brandId)
      ? query.eq("brand_id", Number(brandId))
      : query.ilike("brand_name", brandName);
    const { data, error } = await query.order("name").range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as Row[];
    result.push(...page);
    if (page.length < 1000) break;
  }
  return result;
}

async function productsFor(
  itemRows: Row[],
  packageRows: Row[],
): Promise<Row[]> {
  const products = new Map<string, Row>();
  for (const row of itemRows) {
    const itemId = clean(row.item_id, 40);
    if (!itemId) continue;
    products.set(itemId, {
      canixItemId: itemId,
      canixProductId: clean(row.product_id, 40) || null,
      productName: clean(row.name, 300) || "Unnamed Canix item",
      itemType: clean(row.item_type_name, 160) || null,
      category: clean(row.item_category_name, 160) || "Not classified",
      quantityType: clean(row.quantity_type, 40) || null,
      accountingInventoryType: clean(row.accounting_inventory_type, 120) ||
        null,
      brandName: clean(row.brand_name, 200) || null,
      ownerName: null,
      sku: clean(row.sku, 160) || null,
      packageRecords: 0,
      availableRecords: 0,
      allocatedRecords: 0,
      uomCodes: [],
      caseQuantities: [],
      uomCode: null,
      lastUpdatedAt: row.source_updated_at ?? null,
    });
  }
  for (const row of packageRows) {
    const itemId = clean(row.item_id, 40);
    if (!itemId || !products.has(itemId)) continue;
    const existing = products.get(itemId) as Row;
    existing.packageRecords = Number(existing.packageRecords) + 1;
    existing.ownerName = clean(row.canix_package_owner_name, 200) || null;
    const packageUom = clean(row.uom_code, 20);
    const productUomCodes = Array.isArray(existing.uomCodes)
      ? existing.uomCodes as string[]
      : [];
    if (
      ["G_IN", "G_OUT", "G_DRY", "G_WET"].includes(packageUom) &&
      !productUomCodes.includes(packageUom)
    ) {
      productUomCodes.push(packageUom);
      existing.uomCodes = productUomCodes;
    }
    if (String(row.status_category).toLowerCase() === "available") {
      existing.availableRecords = Number(existing.availableRecords) + 1;
    }
    if (String(row.status_category).toLowerCase() === "allocated") {
      existing.allocatedRecords = Number(existing.allocatedRecords) + 1;
    }
    const caseQuantity = numberOrNull(row.case_quantity);
    const caseQuantities = Array.isArray(existing.caseQuantities)
      ? existing.caseQuantities as number[]
      : [];
    if (
      caseQuantity && caseQuantity > 0 && !caseQuantities.includes(caseQuantity)
    ) {
      caseQuantities.push(caseQuantity);
      existing.caseQuantities = caseQuantities;
    }
  }
  for (const product of products.values()) {
    const productUomCodes = Array.isArray(product.uomCodes)
      ? product.uomCodes as string[]
      : [];
    const classification = normalizedIdentity(
      [
        product.accountingInventoryType,
        product.itemType,
        product.category,
      ].filter(Boolean).join(" "),
    );
    const finishedGood = product.quantityType === "CountBased" ||
      classification.includes("finishedgood");
    product.uomCode = finishedGood
      ? "UNIT"
      : productUomCodes.length === 1
      ? productUomCodes[0]
      : null;
    product.uomState = product.uomCode
      ? "resolved"
      : productUomCodes.length > 1
      ? "conflict"
      : "missing";
    const caseQuantities = Array.isArray(product.caseQuantities)
      ? product.caseQuantities as number[]
      : [];
    product.caseSize = product.uomCode === "UNIT" && caseQuantities.length === 1
      ? caseQuantities[0]
      : null;
    product.caseState = product.uomCode !== "UNIT"
      ? "not_applicable"
      : caseQuantities.length === 1
      ? "resolved"
      : caseQuantities.length > 1
      ? "conflict"
      : "missing";
    product.availabilityState = Number(product.availableRecords) >= 3
      ? "available"
      : Number(product.availableRecords) > 0
      ? "limited"
      : Number(product.packageRecords) > 0
      ? "preorder"
      : "unavailable";
  }
  const ids = [...products.keys()].filter((id) => /^\d+$/.test(id)).map(Number);
  if (ids.length) {
    const [contentResult, linkResult, priceResult] = await Promise.all([
      service.from("portal_product_content").select(
        "canix_item_id,publication_state,monday_item_id,short_description,image_url,updated_at",
      ).in("canix_item_id", ids),
      service.from("monday_item_master_link").select(
        "canix_item_id,monday_item_id,completeness_status,mapping_origin,last_synced_at",
      ).in("canix_item_id", ids),
      service.from("portal_default_price").select(
        "canix_item_id,unit_price_cents,case_size,case_price_cents,published_at,active",
      ).in("canix_item_id", ids).eq("active", true),
    ]);
    if (contentResult.error) throw contentResult.error;
    if (linkResult.error) throw linkResult.error;
    if (priceResult.error) throw priceResult.error;
    for (const row of contentResult.data ?? []) {
      const target = products.get(String(row.canix_item_id));
      if (target) {
        Object.assign(target, {
          publicationState: row.publication_state,
          descriptionReady: !!row.short_description,
          imageReady: !!row.image_url,
          shortDescription: row.publication_state === "published"
            ? row.short_description
            : null,
          imageUrl: row.publication_state === "published"
            ? row.image_url
            : null,
          contentUpdatedAt: row.updated_at,
        });
      }
    }
    for (const row of priceResult.data ?? []) {
      const target = products.get(String(row.canix_item_id));
      if (target) {
        const packageCaseSize = numberOrNull(target.caseSize);
        const priceCaseSize = numberOrNull(row.case_size);
        const caseSize = priceCaseSize || packageCaseSize;
        Object.assign(target, {
          priceState: "available",
          unitPriceCents: Number(row.unit_price_cents),
          caseSize,
          caseState: caseSize ? "resolved" : target.caseState,
          casePriceCents: row.case_price_cents == null
            ? caseSize
              ? Math.round(Number(row.unit_price_cents) * caseSize)
              : null
            : Number(row.case_price_cents),
          pricePublishedAt: row.published_at,
        });
      }
    }
    for (const row of linkResult.data ?? []) {
      const target = products.get(String(row.canix_item_id));
      if (target) {
        Object.assign(target, {
          mondayItemId: String(row.monday_item_id),
          completenessStatus: row.completeness_status,
          mappingOrigin: row.mapping_origin,
        });
      }
    }
  }
  for (const product of products.values()) {
    if (!product.priceState) product.priceState = "request_price";
  }
  return [...products.values()].sort((a, b) =>
    String(a.productName).localeCompare(String(b.productName))
  );
}

function normalizedIdentity(value: unknown): string {
  return clean(value, 500).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function brandVisibleFinishedGood(product: Row): boolean {
  const text = [
    product.productName,
    product.name,
    product.category,
    product.itemType,
    product.accountingInventoryType,
  ].filter(Boolean).join(" ");
  if (
    /\b(?:clone|biomass|seeds?|oil|rosin|bulk|plant material)\b/i.test(text)
  ) {
    return false;
  }
  const classification = normalizedIdentity(text);
  return product.quantityType === "CountBased" ||
    product.uomCode === "UNIT" || classification.includes("finishedgood");
}

function testBrandProducts(): Row[] {
  return [
    [
      "990001",
      "Test Brand Citrus Gummies 10-Pack",
      "TB-GUM-CIT-10",
      "Edibles",
      1250,
      24,
      42,
      35,
    ],
    [
      "990002",
      "Test Brand Live Resin Vape 1g",
      "TB-VAPE-LR-1G",
      "Vaporizers",
      2125,
      12,
      31,
      24,
    ],
    [
      "990003",
      "Test Brand Nighttime Gummies 10-Pack",
      "TB-GUM-NGT-10",
      "Edibles",
      1400,
      24,
      18,
      12,
    ],
    [
      "990004",
      "Test Brand Infused Pre-Rolls 5-Pack",
      "TB-PR-INF-5",
      "Pre-Rolls",
      1800,
      10,
      25,
      19,
    ],
  ].map((
    [id, name, sku, category, unitPrice, caseSize, packages, available],
  ) => ({
    canixItemId: id,
    productName: name,
    sku,
    category,
    itemType: "Finished Good",
    accountingInventoryType: "Finished Good",
    quantityType: "CountBased",
    uomCode: "UNIT",
    uomState: "resolved",
    caseSize,
    caseState: "resolved",
    unitPriceCents: unitPrice,
    casePriceCents: Number(unitPrice) * Number(caseSize),
    priceState: "available",
    publicationState: "published",
    shortDescription: "Synthetic Test Brand product for portal demonstrations.",
    imageUrl: null,
    brandName: "Test Brand",
    ownerName: "Test Brand",
    packageRecords: packages,
    availableRecords: available,
    allocatedRecords: Number(packages) - Number(available),
    availabilityState: Number(available) > 20 ? "available" : "limited",
    demo: true,
  }));
}

async function marketplaceCatalogFor(
  account: Row | null,
  products: Row[],
): Promise<Row> {
  const { data: state, error: stateError } = await service.from(
    "canix_marketplace_sync_state",
  ).select(
    "status,shop_slug,source_url,source_mode,snapshot_scope,last_successful_run_id,last_successful_at,total_shop_product_count,snapshot_product_count,last_error",
  ).eq("id", 1).maybeSingle();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) {
    return {
      state: state?.status ?? "not_configured",
      source: state ?? null,
      summary: {
        published: 0,
        notPublished: products.length,
        marketplaceMismatch: 0,
        missingProductId: products.filter((product) =>
          !product.canixProductId
        ).length,
      },
      rows: [],
    };
  }
  const { data, error } = await service.from(
    "canix_marketplace_product_snapshot",
  ).select(
    "marketplace_product_id,product_gid,product_name,brand_id,brand_name,item_category_name,price_cents,msrp_cents,available_quantity,sale_unit,has_image,image_url,synced_at",
  ).eq("sync_run_id", state.last_successful_run_id).order("product_name");
  if (error) throw error;

  const mappedBrandId = clean(account?.canix_brand_id, 40);
  const mappedBrandName = normalizedIdentity(account?.canix_brand_name);
  const marketplaceRows = ((data ?? []) as Row[]).filter((row) => {
    const rowBrandId = clean(row.brand_id, 40);
    if (mappedBrandId && rowBrandId) return mappedBrandId === rowBrandId;
    return mappedBrandName &&
      normalizedIdentity(row.brand_name) === mappedBrandName;
  });
  const productsByProductId = new Map<string, Row[]>();
  const productsByExactName = new Map<string, Row[]>();
  for (const product of products) {
    const productId = clean(product.canixProductId, 40);
    if (productId) {
      productsByProductId.set(productId, [
        ...(productsByProductId.get(productId) ?? []),
        product,
      ]);
    }
    const exactName = clean(product.productName, 500).toLowerCase();
    if (exactName) {
      productsByExactName.set(exactName, [
        ...(productsByExactName.get(exactName) ?? []),
        product,
      ]);
    }
  }
  const matchedProductIds = new Set<string>();
  const matchedCanixItemIds = new Set<string>();
  const reconciled: Row[] = marketplaceRows.map((marketplace) => {
    const productId = clean(marketplace.marketplace_product_id, 40);
    const idMatches = productsByProductId.get(productId) ?? [];
    const exactName = clean(marketplace.product_name, 500).toLowerCase();
    const exactNameMatches = productsByExactName.get(exactName) ?? [];
    const matches = idMatches.length ? idMatches : exactNameMatches;
    if (matches.length) matchedProductIds.add(productId);
    for (const match of matches) {
      matchedCanixItemIds.add(clean(match.canixItemId, 40));
      const matchedProductId = clean(match.canixProductId, 40);
      if (matchedProductId) matchedProductIds.add(matchedProductId);
    }
    const gid = clean(marketplace.product_gid, 1000);
    return {
      reconciliationStatus: matches.length
        ? "published"
        : "marketplace_mismatch",
      matchMethod: idMatches.length
        ? "canix_product_id"
        : matches.length
        ? "exact_product_name_brand"
        : null,
      marketplaceProductId: productId,
      productGid: gid,
      productName: marketplace.product_name,
      brandName: marketplace.brand_name,
      category: marketplace.item_category_name,
      priceCents: marketplace.price_cents,
      msrpCents: marketplace.msrp_cents,
      displayedAvailableQuantity: marketplace.available_quantity,
      saleUnit: marketplace.sale_unit,
      imageState: marketplace.has_image ? "available" : "missing",
      imageUrl: marketplace.image_url,
      detailUrl: gid
        ? `https://app.canix.com/marketplace/${state.shop_slug}/products/${gid}`
        : null,
      canixItemIds: matches.map((match) => match.canixItemId),
      mondayItemIds: matches.map((match) => match.mondayItemId).filter(Boolean),
      contentStates: [
        ...new Set(
          matches.map((match) => clean(match.publicationState, 40) || "draft"),
        ),
      ],
      nameMatch: matches.some((match) =>
        normalizedIdentity(match.productName) ===
          normalizedIdentity(marketplace.product_name)
      ),
      syncedAt: marketplace.synced_at,
    };
  });

  const unmatched = new Map<string, Row>();
  const missingProductIdCount =
    products.filter((product) => !clean(product.canixProductId, 40)).length;
  for (const product of products) {
    const productId = clean(product.canixProductId, 40);
    const itemId = clean(product.canixItemId, 40);
    if (
      !productId || matchedProductIds.has(productId) ||
      matchedCanixItemIds.has(itemId)
    ) continue;
    const key = productId;
    const current = unmatched.get(key) ?? {
      reconciliationStatus: "not_published",
      matchMethod: "canix_product_id",
      marketplaceProductId: productId,
      productGid: null,
      productName: product.productName,
      brandName: product.brandName,
      category: product.category,
      priceCents: null,
      displayedAvailableQuantity: null,
      saleUnit: null,
      imageState: product.imageReady ? "available" : "missing",
      detailUrl: null,
      canixItemIds: [],
      mondayItemIds: [],
      contentStates: [],
      syncedAt: state.last_successful_at,
    };
    (current.canixItemIds as unknown[]).push(product.canixItemId);
    if (product.mondayItemId) {
      (current.mondayItemIds as unknown[]).push(product.mondayItemId);
    }
    (current.contentStates as unknown[]).push(
      clean(product.publicationState, 40) || "draft",
    );
    unmatched.set(key, current);
  }
  reconciled.push(...unmatched.values());
  reconciled.sort((a, b) =>
    String(a.productName).localeCompare(String(b.productName))
  );
  const summary = {
    published:
      reconciled.filter((row) => row.reconciliationStatus === "published")
        .length,
    notPublished:
      reconciled.filter((row) => row.reconciliationStatus === "not_published")
        .length,
    marketplaceMismatch:
      reconciled.filter((row) =>
        row.reconciliationStatus === "marketplace_mismatch"
      ).length,
    missingProductId: missingProductIdCount,
  };
  return {
    state: state.status,
    source: {
      shopSlug: state.shop_slug,
      sourceUrl: state.source_url,
      sourceMode: state.source_mode,
      snapshotScope: state.snapshot_scope,
      lastSuccessfulAt: state.last_successful_at,
      totalShopProductCount: state.total_shop_product_count,
      snapshotProductCount: state.snapshot_product_count,
      lastError: state.last_error,
    },
    summary,
    rows: reconciled,
  };
}

async function canixOwnerCoverage(
  account: Row | null,
  sync: Row | null,
): Promise<Row> {
  const brandId = numberOrNull(account?.canix_brand_id);
  const ownerId = numberOrNull(account?.canix_owner_id);
  const runId = clean(sync?.last_successful_run_id, 80);
  if (!brandId || !runId) {
    return {
      state: "brand_mapping_required",
      brandPackageRecords: 0,
      ownerScopedRecords: 0,
      matchedBrandOwnerRecords: 0,
      missingOwnerRecords: 0,
    };
  }
  const brandBase = () =>
    service.from("canix_package_current")
      .select("package_id", { count: "exact", head: true })
      .eq("sync_run_id", runId).eq("brand_id", brandId).neq(
        "facility_id",
        4546,
      );
  const ownerBase = () =>
    service.from("canix_package_current")
      .select("package_id", { count: "exact", head: true })
      .eq("sync_run_id", runId).neq("facility_id", 4546);
  const [allResult, missingResult, ownerScopedResult, matchedResult] =
    await Promise.all([
      brandBase(),
      brandBase().is("canix_package_owner_id", null),
      ownerId
        ? ownerBase().eq("canix_package_owner_id", ownerId)
        : Promise.resolve({ count: 0, error: null }),
      ownerId
        ? brandBase().eq("canix_package_owner_id", ownerId)
        : Promise.resolve({ count: 0, error: null }),
    ]);
  if (allResult.error) throw allResult.error;
  if (missingResult.error) throw missingResult.error;
  if (ownerScopedResult.error) throw ownerScopedResult.error;
  if (matchedResult.error) throw matchedResult.error;
  const total = Number(allResult.count || 0);
  const missing = Number(missingResult.count || 0);
  const ownerScoped = Number(ownerScopedResult.count || 0);
  const matched = Number(matchedResult.count || 0);
  return {
    state: ownerId
      ? missing > 0 ? "partial_owner_coverage" : "complete_owner_coverage"
      : "owner_mapping_required",
    brandId,
    ownerId,
    brandPackageRecords: total,
    ownerScopedRecords: ownerScoped,
    matchedBrandOwnerRecords: matched,
    missingOwnerRecords: missing,
    coveragePercent: total > 0 ? Math.round((matched / total) * 1000) / 10 : 0,
  };
}

async function quickBooksBrandFinancials(
  account: Row | null,
  financialPolicy: Row | null,
  sync: Row | null,
): Promise<Row> {
  const customerId = clean(account?.quickbooks_customer_id, 80);
  const runId = clean(sync?.last_financial_run_id, 80);
  const identityVerified = financialPolicy?.identity_status === "verified";
  const arEnabled = financialPolicy?.ar_visibility === "quickbooks_read_only";
  if (!customerId) {
    return { state: "customer_mapping_required", amountsVisible: false };
  }
  if (!runId) {
    return { state: "snapshot_unavailable", amountsVisible: false };
  }
  const visible = identityVerified && arEnabled;
  if (!visible) {
    const [invoiceResult, paymentResult, creditResult] = await Promise.all([
      service.from("quickbooks_invoice_cache").select("quickbooks_invoice_id", {
        count: "exact",
        head: true,
      }).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId),
      service.from("quickbooks_payment_cache").select("quickbooks_payment_id", {
        count: "exact",
        head: true,
      }).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId),
      service.from("quickbooks_credit_memo_cache").select(
        "quickbooks_credit_memo_id",
        { count: "exact", head: true },
      ).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId),
    ]);
    for (const result of [invoiceResult, paymentResult, creditResult]) {
      if (result.error) throw result.error;
    }
    return {
      state: identityVerified ? "ar_withheld" : "identity_review_required",
      amountsVisible: false,
      availableRecords: {
        invoices: Number(invoiceResult.count || 0),
        payments: Number(paymentResult.count || 0),
        credits: Number(creditResult.count || 0),
      },
    };
  }

  const [invoiceResult, paymentResult, creditResult] = await Promise.all([
    service.from("quickbooks_invoice_cache").select(
      "quickbooks_invoice_id,doc_number,txn_date,due_date,total_amount,balance,currency,source_updated_at",
    ).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId)
      .order("txn_date", { ascending: false }).limit(250),
    service.from("quickbooks_payment_cache").select(
      "quickbooks_payment_id,txn_date,total_amount,unapplied_amount,currency,payment_method_name,source_updated_at",
    ).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId)
      .order("txn_date", { ascending: false }).limit(250),
    service.from("quickbooks_credit_memo_cache").select(
      "quickbooks_credit_memo_id,doc_number,txn_date,total_amount,remaining_credit,currency,source_updated_at",
    ).eq("sync_run_id", runId).eq("quickbooks_customer_id", customerId)
      .order("txn_date", { ascending: false }).limit(250),
  ]);
  for (const result of [invoiceResult, paymentResult, creditResult]) {
    if (result.error) throw result.error;
  }
  const today = new Date().toISOString().slice(0, 10);
  const invoices = ((invoiceResult.data ?? []) as Row[]).map((row) => {
    const balanceCents = cents(row.balance);
    const dueDate = clean(row.due_date, 10) || null;
    const daysPastDue = balanceCents > 0 && dueDate && dueDate < today
      ? dayDistance(dueDate, today)
      : 0;
    return {
      id: row.quickbooks_invoice_id,
      docNumber: row.doc_number || row.quickbooks_invoice_id,
      txnDate: row.txn_date,
      dueDate,
      totalAmountCents: cents(row.total_amount),
      balanceCents,
      currency: row.currency || "USD",
      state: balanceCents <= 0 ? "paid" : daysPastDue > 0 ? "past_due" : "open",
      daysPastDue,
      sourceUpdatedAt: row.source_updated_at,
    };
  });
  const payments = ((paymentResult.data ?? []) as Row[]).map((row) => ({
    id: row.quickbooks_payment_id,
    txnDate: row.txn_date,
    totalAmountCents: cents(row.total_amount),
    unappliedAmountCents: cents(row.unapplied_amount),
    currency: row.currency || "USD",
    paymentMethod: row.payment_method_name || null,
    sourceUpdatedAt: row.source_updated_at,
  }));
  const credits = ((creditResult.data ?? []) as Row[]).map((row) => ({
    id: row.quickbooks_credit_memo_id,
    docNumber: row.doc_number || row.quickbooks_credit_memo_id,
    txnDate: row.txn_date,
    totalAmountCents: cents(row.total_amount),
    remainingCreditCents: cents(row.remaining_credit),
    currency: row.currency || "USD",
    sourceUpdatedAt: row.source_updated_at,
  }));
  const open = invoices.filter((invoice) => Number(invoice.balanceCents) > 0);
  const bucket = (minimum: number, maximum: number | null) =>
    open
      .filter((invoice) =>
        Number(invoice.daysPastDue) >= minimum &&
        (maximum === null || Number(invoice.daysPastDue) <= maximum)
      )
      .reduce((total, invoice) => total + Number(invoice.balanceCents), 0);
  return {
    state: "available",
    amountsVisible: true,
    summary: {
      invoiceCount: invoices.length,
      openInvoiceCount: open.length,
      outstandingCents: open.reduce(
        (total, invoice) => total + Number(invoice.balanceCents),
        0,
      ),
      paidCents: payments.reduce(
        (total, payment) => total + Number(payment.totalAmountCents),
        0,
      ),
      creditCents: credits.reduce(
        (total, credit) => total + Number(credit.totalAmountCents),
        0,
      ),
      remainingCreditCents: credits.reduce(
        (total, credit) => total + Number(credit.remainingCreditCents),
        0,
      ),
      aging: {
        currentCents: open.filter((invoice) =>
          Number(invoice.daysPastDue) === 0
        )
          .reduce((total, invoice) => total + Number(invoice.balanceCents), 0),
        days1To30Cents: bucket(1, 30),
        days31To60Cents: bucket(31, 60),
        days61To90Cents: bucket(61, 90),
        daysOver90Cents: bucket(91, null),
      },
    },
    invoices,
    payments,
    credits,
  };
}

async function overview(actor: Actor, organizationId: string): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  const [
    organizationResult,
    accountResult,
    detailResult,
    contactsResult,
    agreementsResult,
    purchaseOrdersResult,
    manufacturingResult,
    governanceResult,
    requirementsResult,
    financialPolicyResult,
    settlementRulesResult,
    distributionResult,
    agreementEventsResult,
    reportingExceptionsResult,
    purchaseOrderWorkItemsResult,
    mondaySyncResult,
    quickbooksSyncResult,
  ] = await Promise.all([
    service.from("portal_organization").select(
      "id,legal_name,display_name,status,created_at,updated_at",
    ).eq("id", organizationId).single(),
    service.from("portal_brand_account").select("*").eq(
      "organization_id",
      organizationId,
    ).maybeSingle(),
    service.from("portal_brand_profile_detail").select("*").eq(
      "organization_id",
      organizationId,
    ).maybeSingle(),
    service.from("portal_brand_contact").select(
      "id,contact_type,full_name,email,phone,active,updated_at",
    ).eq("organization_id", organizationId).order("contact_type"),
    service.from("portal_brand_agreement").select(
      "id,requirement_code,agreement_type,reference,status,visibility,version_label,effective_on,expires_on,term_type,renewal_review_on,renewal_owner,renewal_notice_days,evidence_summary,monday_item_id,document_reference,submitted_by,submitted_at,review_decision,brand_response_note,reviewed_at,published_at,archived_at,supersedes_agreement_id,terms_mode,payment_terms,settlement_frequency,currency_code,responsible_internal_owner,finance_approver,legal_approver,source_clause_reference,commercial_terms_note,commercial_terms_state,finance_approved_by_email,finance_approved_at,legal_confirmed_by_email,legal_confirmed_at,updated_at,portal_brand_agreement_document(id,original_name,content_type,size_bytes,uploaded_by_type,created_at),portal_brand_agreement_renewal_notice(reminder_days,remind_on,status,sent_at),portal_brand_agreement_fee_line(id,line_number,fee_name,fee_category,calculation_method,rate_amount,percentage_rate,uom_code,calculation_basis,payer,recipient,scope_summary,effective_on,ends_on,billing_frequency,minimum_amount,maximum_amount,quickbooks_mapping,brand_visibility,status,conditional_detail)",
    ).eq("organization_id", organizationId).order("updated_at", {
      ascending: false,
    }),
    service.from("portal_brand_purchase_order").select(
      "*,portal_brand_purchase_order_line(*,portal_brand_purchase_order_fulfillment_event(*))",
    ).eq("organization_id", organizationId).order("updated_at", {
      ascending: false,
    }).limit(100),
    service.from("portal_brand_manufacturing_projection").select("*").eq(
      "organization_id",
      organizationId,
    ).order("updated_at", { ascending: false }).limit(100),
    service.from("portal_brand_governance_policy").select("*").eq(
      "organization_id",
      organizationId,
    ).maybeSingle(),
    service.from("portal_brand_agreement_requirement").select(
      "requirement_code,agreement_name,applicability,condition_summary,gate_code,sort_order,decision_reason,review_owner,target_review_on,evidence_summary,decision_by_email,decision_at,updated_at",
    ).eq("organization_id", organizationId).order("sort_order"),
    service.from("portal_brand_financial_policy").select("*").eq(
      "organization_id",
      organizationId,
    ).maybeSingle(),
    service.from("portal_brand_settlement_rule").select(
      "id,agreement_id,version,status,calculation_basis,settlement_frequency,percentage_bps,fixed_fee_cents,allowed_deductions,effective_on,expires_on,approved_at,updated_at",
    ).eq("organization_id", organizationId).order("version", {
      ascending: false,
    }).limit(25),
    service.from("portal_brand_distribution_milestone").select(
      "id,purchase_order_id,status,source_system,external_note,evidence_reference,occurred_at",
    ).eq("organization_id", organizationId).eq("brand_visible", true)
      .order("occurred_at", { ascending: false }).limit(100),
    service.from("portal_brand_operation_event").select(
      "id,action,target_id,detail,created_at",
    ).eq("organization_id", organizationId).eq("target_type", "brand_agreement")
      .order("created_at", { ascending: false }).limit(100),
    service.from("portal_brand_reporting_exception").select(
      "id,exception_code,source_system,severity,record_key,summary,detail,status,first_seen_at,last_seen_at,resolved_at,resolution_note",
    ).eq("organization_id", organizationId).neq("status", "resolved")
      .order("severity", { ascending: true }).order("last_seen_at", {
        ascending: false,
      }),
    service.from("portal_work_item").select(
      "id,reference,target_id,status,priority,assigned_department,assigned_user,due_at,source_mode,version,updated_at,portal_work_item_comment(id,body,visibility,created_by_email,created_at),portal_work_item_evidence(id,evidence_type,original_name,content_type,size_bytes,scan_state,created_by_email,created_at)",
    ).eq("workflow_key", "brand_purchase_orders")
      .eq("organization_id", organizationId).order("updated_at", {
        ascending: false,
      }),
    service.from("monday_item_master_sync_state").select(
      "status,last_successful_at,last_error,pending_count,conflict_count",
    ).eq("id", 1).maybeSingle(),
    service.from("quickbooks_sync_state").select(
      "status,last_successful_at,financial_last_successful_at,last_financial_run_id,last_error,customer_count,vendor_count,invoice_count,payment_count,credit_memo_count,connection_environment",
    ).eq("id", 1).maybeSingle(),
  ]);
  for (
    const result of [
      organizationResult,
      accountResult,
      detailResult,
      contactsResult,
      agreementsResult,
      purchaseOrdersResult,
      manufacturingResult,
      governanceResult,
      requirementsResult,
      financialPolicyResult,
      settlementRulesResult,
      distributionResult,
      agreementEventsResult,
      reportingExceptionsResult,
      purchaseOrderWorkItemsResult,
      mondaySyncResult,
      quickbooksSyncResult,
    ]
  ) {
    if (result.error) throw result.error;
  }
  const organization = organizationResult.data as Row;
  const account = (accountResult.data ?? null) as Row | null;
  const governance = (governanceResult.data ?? null) as Row | null;
  const financialPolicy = (financialPolicyResult.data ?? null) as Row | null;
  const agreementRequirements = (requirementsResult.data ?? []) as Row[];
  const visibleAgreements: Row[] = ((agreementsResult.data ?? []) as Row[])
    .filter(
      (agreement) => {
        if (actor.role === "internal") return true;
        if (["published", "archived"].includes(String(agreement.visibility))) {
          return true;
        }
        const rawDocuments = agreement.portal_brand_agreement_document;
        const documents = Array.isArray(rawDocuments)
          ? rawDocuments as Row[]
          : rawDocuments && typeof rawDocuments === "object"
          ? [rawDocuments as Row]
          : [];
        return documents.some((document) =>
          document.uploaded_by_type === "brand"
        ) &&
          ["in_review", "changes_requested"].includes(String(agreement.status));
      },
    ).map((agreement) => {
      const rawDocuments = agreement.portal_brand_agreement_document;
      const documents = Array.isArray(rawDocuments)
        ? rawDocuments as Row[]
        : rawDocuments && typeof rawDocuments === "object"
        ? [rawDocuments as Row]
        : [];
      const renewalNotices = Array.isArray(
          agreement.portal_brand_agreement_renewal_notice,
        )
        ? agreement.portal_brand_agreement_renewal_notice as Row[]
        : [];
      const feeLines = Array.isArray(agreement.portal_brand_agreement_fee_line)
        ? agreement.portal_brand_agreement_fee_line as Row[]
        : [];
      const document = documents[0] ?? null;
      const safeAgreement = { ...agreement };
      delete safeAgreement.portal_brand_agreement_document;
      delete safeAgreement.portal_brand_agreement_renewal_notice;
      delete safeAgreement.portal_brand_agreement_fee_line;
      delete safeAgreement.submitted_by;
      if (actor.role !== "internal") {
        delete safeAgreement.responsible_internal_owner;
        delete safeAgreement.finance_approver;
        delete safeAgreement.legal_approver;
        delete safeAgreement.source_clause_reference;
        delete safeAgreement.commercial_terms_note;
        delete safeAgreement.finance_approved_by_email;
        delete safeAgreement.finance_approved_at;
        delete safeAgreement.legal_confirmed_by_email;
        delete safeAgreement.legal_confirmed_at;
      }
      const visibleFeeLines = feeLines.filter((line) =>
        actor.role === "internal" || line.brand_visibility !== "hidden"
      ).map((line) => {
        if (actor.role === "internal") return line;
        const safeLine = { ...line };
        delete safeLine.quickbooks_mapping;
        if (line.brand_visibility === "summary") {
          delete safeLine.calculation_method;
          delete safeLine.rate_amount;
          delete safeLine.percentage_rate;
          delete safeLine.uom_code;
          delete safeLine.calculation_basis;
          delete safeLine.minimum_amount;
          delete safeLine.maximum_amount;
          delete safeLine.conditional_detail;
        }
        return safeLine;
      });
      return {
        ...safeAgreement,
        document: document
          ? {
            id: document.id,
            originalName: document.original_name,
            contentType: document.content_type,
            sizeBytes: document.size_bytes,
            createdAt: document.created_at,
          }
          : null,
        renewalNotices: renewalNotices.map((notice) => ({
          reminderDays: notice.reminder_days,
          remindOn: notice.remind_on,
          status: notice.status,
          sentAt: notice.sent_at,
        })).sort((a, b) => Number(b.reminderDays) - Number(a.reminderDays)),
        feeLines: visibleFeeLines.sort((left, right) =>
          Number(left.line_number) - Number(right.line_number)
        ),
      } as Row;
    });
  const visibleAgreementIds = new Set(
    visibleAgreements.map((agreement) => String(agreement.id)),
  );
  const agreementEvents = ((agreementEventsResult.data ?? []) as Row[])
    .filter((event) => visibleAgreementIds.has(String(event.target_id)))
    .map((event) => {
      const detail = event.detail && typeof event.detail === "object"
        ? event.detail as Row
        : {};
      return {
        id: event.id,
        action: event.action,
        agreementId: event.target_id,
        reference: clean(detail.reference, 200) || null,
        requirementCode: clean(detail.requirementCode, 80) || null,
        createdAt: event.created_at,
      };
    });
  const [{ rows: canixRows, sync: canixSync }, brandItems] = await Promise.all([
    latestCanix(account),
    latestBrandItems(account),
  ]);
  const ownerCoverage = await canixOwnerCoverage(account, canixSync);
  const demoTenant = organization.legal_name === "Test Brand";
  let products = permissions.has("brand.products.read")
    ? await productsFor(brandItems, canixRows)
    : [];
  if (demoTenant && permissions.has("brand.products.read")) {
    products = testBrandProducts();
  } else if (actor.role !== "internal") {
    products = products.filter(brandVisibleFinishedGood);
  }
  let marketplaceCatalog = permissions.has("brand.products.read")
    ? await marketplaceCatalogFor(account, products)
    : { state: "permission_required", summary: {}, rows: [] };
  if (demoTenant && permissions.has("brand.products.read")) {
    marketplaceCatalog = {
      state: "demo",
      source: { state: "demo", source_mode: "synthetic_isolated" },
      summary: {
        published: products.length,
        notPublished: 0,
        marketplaceMismatch: 0,
        missingProductId: 0,
      },
      rows: products.map((product) => ({
        reconciliationStatus: "published",
        matchMethod: "canix_product_id",
        marketplaceProductId: product.canixItemId,
        productName: product.productName,
        brandName: "Test Brand",
        category: product.category,
        priceCents: product.unitPriceCents,
        saleUnit: "UNIT",
        displayedAvailableQuantity: product.availableRecords,
        imageState: "missing",
        imageUrl: null,
        canixItemIds: [product.canixItemId],
        mondayItemIds: [],
        contentStates: ["published"],
        nameMatch: true,
        demo: true,
      })),
    };
  }

  let skuIntakes: Row[] = [];
  if (permissions.has("brand.products.read") && actor.role === "internal") {
    const { data, error } = await service.from("portal_sku_intake")
      .select("id,reference,brand_name,product_name,status,updated_at")
      .eq("organization_id", organizationId).order("updated_at", {
        ascending: false,
      }).limit(100);
    if (error) throw error;
    skuIntakes = (data ?? []) as Row[];
  }

  let sales: Row = { state: "permission_required" };
  if (permissions.has("brand.sales.read")) {
    const itemIds = products.map((product) => String(product.canixItemId));
    const lines: Row[] = [];
    for (let start = 0; start < itemIds.length; start += 100) {
      const { data, error } = await service.from("portal_order_line")
        .select(
          "order_id,product_id,product_name,quantity,unit,line_total_cents,order_mode",
        )
        .in("product_id", itemIds.slice(start, start + 100));
      if (error) throw error;
      lines.push(...((data ?? []) as Row[]));
    }
    const orderIds = [...new Set(lines.map((line) => String(line.order_id)))];
    const orders: Row[] = [];
    for (let start = 0; start < orderIds.length; start += 100) {
      const { data, error } = await service.from("portal_order")
        .select("id,state,submitted_at,updated_at").in(
          "id",
          orderIds.slice(start, start + 100),
        );
      if (error) throw error;
      orders.push(...((data ?? []) as Row[]));
    }
    const stateCounts: Record<string, number> = {};
    const orderById = new Map(orders.map((order) => [String(order.id), order]));
    const productTotals = new Map<string, {
      canixItemId: string;
      productName: string;
      units: number;
      fulfilledUnits: number;
      orderIds: Set<string>;
      orderDates: string[];
      periods: Map<string, { units: number; fulfilledUnits: number }>;
    }>();
    const periodTotals = new Map<string, {
      period: string;
      units: number;
      fulfilledUnits: number;
      orderIds: Set<string>;
    }>();
    const productById = new Map(
      products.map((product) => [String(product.canixItemId), product]),
    );
    const fulfilledStates = new Set(["delivered", "completed"]);
    for (const order of orders) {
      stateCounts[String(order.state)] =
        (stateCounts[String(order.state)] ?? 0) + 1;
    }
    for (const line of lines) {
      const orderId = String(line.order_id);
      const productId = String(line.product_id);
      const quantity = Number(line.quantity ?? 0);
      const product = productTotals.get(productId) ?? {
        canixItemId: productId,
        productName: clean(line.product_name, 300) || "Unnamed product",
        units: 0,
        fulfilledUnits: 0,
        orderIds: new Set<string>(),
        orderDates: [],
        periods: new Map<string, { units: number; fulfilledUnits: number }>(),
      };
      product.units += quantity;
      product.orderIds.add(orderId);
      const order = orderById.get(orderId);
      if (fulfilledStates.has(String(order?.state || "").toLowerCase())) {
        product.fulfilledUnits += quantity;
      }
      const sourceDate = clean(order?.submitted_at ?? order?.updated_at, 40);
      if (/^\d{4}-\d{2}-\d{2}/.test(sourceDate)) {
        product.orderDates.push(sourceDate.slice(0, 10));
      }
      productTotals.set(productId, product);

      const period = /^\d{4}-\d{2}/.test(sourceDate)
        ? sourceDate.slice(0, 7)
        : "Undated";
      const productPeriod = product.periods.get(period) ?? {
        units: 0,
        fulfilledUnits: 0,
      };
      productPeriod.units += quantity;
      if (fulfilledStates.has(String(order?.state || "").toLowerCase())) {
        productPeriod.fulfilledUnits += quantity;
      }
      product.periods.set(period, productPeriod);
      const month = periodTotals.get(period) ?? {
        period,
        units: 0,
        fulfilledUnits: 0,
        orderIds: new Set<string>(),
      };
      month.units += quantity;
      if (fulfilledStates.has(String(order?.state || "").toLowerCase())) {
        month.fulfilledUnits += quantity;
      }
      month.orderIds.add(orderId);
      periodTotals.set(period, month);
    }
    sales = {
      orderCount: orders.length,
      lineCount: lines.length,
      units: lines.reduce(
        (total, line) => total + Number(line.quantity ?? 0),
        0,
      ),
      states: stateCounts,
      products: [...productTotals.values()].map((product) => ({
        canixItemId: product.canixItemId,
        productName: product.productName,
        units: product.units,
        fulfilledUnits: product.fulfilledUnits,
        orderCount: product.orderIds.size,
        availabilityState:
          productById.get(product.canixItemId)?.availabilityState ??
            "unavailable",
        periods: [...product.periods.entries()].map(([period, values]) => ({
          period,
          units: values.units,
          fulfilledUnits: values.fulfilledUnits,
        })),
        reorderIntervalDays: (() => {
          const dates = [...new Set(product.orderDates)].sort();
          if (dates.length < 2) return null;
          const intervals = dates.slice(1).map((date, index) =>
            dayDistance(dates[index], date)
          );
          return Math.round(
            intervals.reduce((total, days) => total + days, 0) /
              intervals.length,
          );
        })(),
      })).sort((a, b) => b.units - a.units),
      periods: [...periodTotals.values()].map((period) => ({
        period: period.period,
        units: period.units,
        fulfilledUnits: period.fulfilledUnits,
        orderCount: period.orderIds.size,
      })).sort((a, b) => b.period.localeCompare(a.period)),
      reportingDimensions: governance?.sales_reporting_dimensions ?? [
        "sku",
        "month",
        "order",
        "territory",
      ],
      downloadEnabled: governance?.sales_download_enabled !== false,
      retailerDetailVisibility: "withheld_by_policy",
      destinationVisibility: governance?.destination_visibility ??
        "territory_only",
      revenueVisibility:
        governance?.sales_dollars_visibility === "finance_approved" &&
          financialPolicy?.sales_dollars_state === "approved"
          ? "pending_quickbooks_line_mapping"
          : "withheld_pending_finance_approval",
      approvalDefinition:
        "A posted, non-voided QuickBooks line mapped to the correct Brand and SKU, adjusted for approved credits and returns, and included in a Finance-closed period.",
      note:
        "Brand sales are aggregated without retailer or store identity. Dollar reporting remains unavailable until Finance approval and stable QuickBooks line mapping are both complete.",
    };
    if (demoTenant) {
      sales = {
        orderCount: 14,
        lineCount: 29,
        units: 1128,
        states: { completed: 9, delivered: 2, in_production: 2, submitted: 1 },
        products: [
          {
            canixItemId: "990001",
            productName: "Test Brand Citrus Gummies 10-Pack",
            units: 480,
            fulfilledUnits: 408,
            orderCount: 8,
            availabilityState: "available",
            reorderIntervalDays: 21,
          },
          {
            canixItemId: "990002",
            productName: "Test Brand Live Resin Vape 1g",
            units: 288,
            fulfilledUnits: 240,
            orderCount: 6,
            availabilityState: "available",
            reorderIntervalDays: 27,
          },
          {
            canixItemId: "990003",
            productName: "Test Brand Nighttime Gummies 10-Pack",
            units: 240,
            fulfilledUnits: 216,
            orderCount: 5,
            availabilityState: "limited",
            reorderIntervalDays: 30,
          },
          {
            canixItemId: "990004",
            productName: "Test Brand Infused Pre-Rolls 5-Pack",
            units: 120,
            fulfilledUnits: 90,
            orderCount: 3,
            availabilityState: "limited",
            reorderIntervalDays: 35,
          },
        ],
        periods: [
          { period: "2026-05", units: 120, fulfilledUnits: 96, orderCount: 2 },
          { period: "2026-06", units: 168, fulfilledUnits: 144, orderCount: 2 },
          { period: "2026-07", units: 216, fulfilledUnits: 192, orderCount: 3 },
          { period: "2026-08", units: 240, fulfilledUnits: 216, orderCount: 3 },
          { period: "2026-09", units: 264, fulfilledUnits: 234, orderCount: 3 },
          { period: "2026-10", units: 120, fulfilledUnits: 72, orderCount: 1 },
        ],
        reportingDimensions: ["sku", "month", "order", "territory"],
        downloadEnabled: true,
        retailerDetailVisibility: "withheld_by_policy",
        destinationVisibility: "territory_only",
        revenueVisibility: "demo_approved",
        approvalDefinition:
          "DEMO — synthetic performance data for executive review.",
        note: "DEMO — no retailer identity or live source record is included.",
      };
    }
  }

  let financials: Row = { state: "permission_required" };
  if (permissions.has("brand.financials.read")) {
    const classification = String(
      (detailResult.data as Row | null)?.classification ?? "external_partner",
    );
    if (classification === "company_owned") {
      financials = {
        state: "company_owned",
        relationship: "No external accounting party",
        amountVisibility: "internal_company_books_only",
        arVisibility: financialPolicy?.ar_visibility ?? "not_applicable",
        statementState: financialPolicy?.statement_state ?? "not_required",
        settlementState: financialPolicy?.settlement_state ?? "not_required",
        bankingSetupState: financialPolicy?.banking_setup_state ??
          "not_required",
        bankingSummary: null,
        policy: financialPolicy,
        note:
          "Company-level QuickBooks records remain restricted to authorized Internal financial views.",
      };
    } else {
      let customer: Row | null = null;
      if (account?.quickbooks_customer_id) {
        const { data, error } = await service.from("quickbooks_customer_cache")
          .select(
            "quickbooks_customer_id,display_name,company_name,active,source_updated_at",
          )
          .eq("quickbooks_customer_id", account.quickbooks_customer_id)
          .maybeSingle();
        if (error) throw error;
        customer = (data ?? null) as Row | null;
      }
      const quickBooksSnapshot = await quickBooksBrandFinancials(
        account,
        financialPolicy,
        (quickbooksSyncResult.data ?? null) as Row | null,
      );
      financials = {
        state: customer ? "identity_connected" : "identity_pending",
        relationship: financialPolicy?.quickbooks_classification ??
          account?.quickbooks_entity_type ?? "pending_finance_review",
        identityStatus: financialPolicy?.identity_status ??
          "pending_finance_review",
        customer,
        vendorId: account?.quickbooks_vendor_id ?? null,
        arVisibility: financialPolicy?.ar_visibility ?? "quickbooks_read_only",
        amountVisibility: financialPolicy?.sales_dollars_state ??
          "withheld_pending_finance_approval",
        statementState: financialPolicy?.statement_state ??
          "pending_finance_approval",
        settlementState: financialPolicy?.settlement_state ??
          "pending_agreement",
        bankingSetupState: financialPolicy?.banking_setup_state ?? "pending",
        bankingSummary: financialPolicy
          ? {
            bankName: financialPolicy.bank_name ?? null,
            accountHolderName: financialPolicy.account_holder_name ?? null,
            accountLastFour: financialPolicy.account_last_four ?? null,
            verifiedAt: financialPolicy.banking_verified_at ?? null,
            configured: !!financialPolicy.secure_provider_reference,
          }
          : null,
        quickBooksSnapshot,
        note:
          "QuickBooks remains authoritative. Full banking credentials are never stored; statements and dollar reporting remain gated by Finance approval and stable source mapping.",
      };
    }
    if (demoTenant) {
      financials = {
        state: "demo",
        relationship: "Synthetic QuickBooks customer",
        identityStatus: "verified",
        arVisibility: "quickbooks_read_only",
        amountVisibility: "approved",
        statementState: "enabled",
        settlementState: "not_required",
        bankingSetupState: "not_required",
        bankingSummary: null,
        quickBooksSnapshot: {
          amountsVisible: true,
          summary: {
            outstandingCents: 842500,
            openInvoiceCount: 3,
            paidCents: 1784000,
            creditCents: 45000,
            remainingCreditCents: 12000,
            aging: {
              currentCents: 412500,
              days1To30Cents: 310000,
              days31To60Cents: 120000,
              days61To90Cents: 0,
              daysOver90Cents: 0,
            },
          },
          invoices: [
            {
              id: "demo-inv-1042",
              docNumber: "DEMO-1042",
              state: "open",
              txnDate: "2026-09-18",
              dueDate: "2026-10-18",
              totalAmountCents: 504000,
              balanceCents: 504000,
            },
            {
              id: "demo-inv-1038",
              docNumber: "DEMO-1038",
              state: "partially_paid",
              txnDate: "2026-09-02",
              dueDate: "2026-10-02",
              totalAmountCents: 438500,
              balanceCents: 218500,
            },
            {
              id: "demo-inv-1029",
              docNumber: "DEMO-1029",
              state: "open",
              txnDate: "2026-08-19",
              dueDate: "2026-09-18",
              totalAmountCents: 120000,
              balanceCents: 120000,
            },
          ],
          payments: [{
            id: "DEMO-PAY-88",
            txnDate: "2026-09-12",
            totalAmountCents: 720000,
            paymentMethod: "ACH (demo)",
          }],
          credits: [{
            id: "DEMO-CM-14",
            docNumber: "DEMO-CM-14",
            txnDate: "2026-09-20",
            totalAmountCents: 45000,
            remainingCreditCents: 12000,
          }],
          availableRecords: { invoices: 3, payments: 1, credits: 1 },
        },
        note: "DEMO — synthetic financial records; QuickBooks was not queried.",
      };
    }
  }

  const reportingExceptions = ((reportingExceptionsResult.data ?? []) as Row[])
    .map((exception) => ({ ...exception }));
  const liveException = (
    code: string,
    sourceSystem: string,
    severity: string,
    summary: string,
    detail: string,
  ) => {
    const existing = reportingExceptions.find((row) =>
      row.exception_code === code
    );
    const record = {
      ...(existing ?? {}),
      exception_code: code,
      source_system: sourceSystem,
      severity,
      status: "open",
      summary,
      detail,
      live: true,
    };
    if (existing) Object.assign(existing, record);
    else reportingExceptions.push(record);
  };
  if (!demoTenant && Number(ownerCoverage.missingOwnerRecords || 0) > 0) {
    liveException(
      "canix_owner_coverage_incomplete",
      "Canix",
      account?.canix_owner_id ? "warning" : "blocking",
      `${ownerCoverage.missingOwnerRecords} Brand package record(s) are missing the Canix Owner field.`,
      account?.canix_owner_id
        ? `${ownerCoverage.ownerScopedRecords} record(s) are safely included under Owner ${account.canix_owner_id}; ${ownerCoverage.matchedBrandOwnerRecords} also carry the mapped Brand. Unowned records remain excluded.`
        : "Inventory remains blocked because Brand identity is not an ownership boundary.",
    );
  }
  if (!demoTenant && !account?.canix_owner_id) {
    liveException(
      "canix_owner_mapping_required",
      "Canix",
      "blocking",
      "An approved Canix Owner ID is required before inventory can be shown.",
      "Brand identity remains descriptive; inventory access fails closed.",
    );
  }
  if (!demoTenant && !account?.monday_account_item_id) {
    liveException(
      "monday_brand_mapping_required",
      "Monday",
      "blocking",
      "The Brand needs an approved Monday Brand record.",
      "Product content, production milestones, and handoffs remain unavailable until the stable Monday item ID is mapped.",
    );
  }
  if (
    !demoTenant &&
    (detailResult.data as Row | null)?.classification !== "company_owned" &&
    financialPolicy?.identity_status !== "verified"
  ) {
    liveException(
      "quickbooks_identity_review_required",
      "QuickBooks",
      "blocking",
      "Finance must verify the mapped QuickBooks party before amounts are shown.",
      account?.quickbooks_customer_id
        ? `Customer ${account.quickbooks_customer_id} is connected; amounts remain withheld.`
        : "No approved QuickBooks customer or vendor identity is mapped.",
    );
  }
  const sourceStates = demoTenant
    ? {
      canix: {
        state: "demo",
        coverage: {
          totalBrandRecords: 116,
          ownerScopedRecords: 116,
          missingOwnerRecords: 0,
        },
      },
      monday: { state: "demo", conflicts: 0 },
      quickbooks: { state: "demo", identityStatus: "verified" },
    }
    : {
      canix: {
        state: !account?.canix_owner_id
          ? "blocked"
          : Number(ownerCoverage.missingOwnerRecords || 0) > 0
          ? "attention"
          : canixSync?.status === "success"
          ? "healthy"
          : "attention",
        coverage: ownerCoverage,
      },
      monday: {
        state: !account?.monday_account_item_id
          ? "blocked"
          : mondaySyncResult.data?.status === "success"
          ? "healthy"
          : "attention",
        conflicts: mondaySyncResult.data?.conflict_count ?? null,
      },
      quickbooks: {
        state:
          (detailResult.data as Row | null)?.classification === "company_owned"
            ? "not_applicable"
            : !account?.quickbooks_customer_id && !account?.quickbooks_vendor_id
            ? "blocked"
            : financialPolicy?.identity_status !== "verified"
            ? "attention"
            : quickbooksSyncResult.data?.status === "ok"
            ? "healthy"
            : "attention",
        identityStatus: financialPolicy?.identity_status ?? "not_applicable",
      },
    };

  return {
    organization,
    detail: detailResult.data,
    account,
    governance,
    financialPolicy,
    contacts: contactsResult.data ?? [],
    agreementRequirements,
    agreements: visibleAgreements,
    agreementEvents,
    agreementCapabilities: {
      canSubmit: permissions.has("brand.agreements.manage"),
      canReview: actor.role === "internal" &&
        ["administrator", "operations"].includes(String(actor.staff_role)),
      canArchive: actor.role === "internal" &&
        ["administrator", "operations"].includes(String(actor.staff_role)),
    },
    products,
    marketplaceCatalog,
    skuIntakes,
    purchaseOrders: permissions.has("brand.purchase_orders.read")
      ? ((purchaseOrdersResult.data ?? []) as Row[]).map((order) => ({
        ...order,
        portal_brand_purchase_order_line: (Array.isArray(
            order.portal_brand_purchase_order_line,
          )
          ? order.portal_brand_purchase_order_line as Row[]
          : []).map((line) => ({
            ...line,
            portal_brand_purchase_order_fulfillment_event: (Array.isArray(
                line.portal_brand_purchase_order_fulfillment_event,
              )
              ? line.portal_brand_purchase_order_fulfillment_event as Row[]
              : []).filter((event) =>
                actor.role === "internal" || event.brand_visible !== false
              ),
          })),
        workItem: ((purchaseOrderWorkItemsResult.data ?? []) as Row[]).find(
          (item) => String(item.target_id) === String(order.id),
        ) ?? null,
      }))
      : [],
    manufacturing: permissions.has("brand.manufacturing.read")
      ? (manufacturingResult.data ?? []).filter((row) =>
        actor.role === "internal" || row.status !== "exception"
      )
      : [],
    distribution: permissions.has("brand.sales.read")
      ? distributionResult.data ?? []
      : [],
    sales,
    financials,
    reportingExceptions,
    sourceStates,
    ownerCoverage,
    settlementRules: permissions.has("brand.financials.read")
      ? settlementRulesResult.data ?? []
      : [],
    connections: {
      canix: {
        mapped: account?.scope_status === "verified",
        brandId: account?.canix_brand_id ?? null,
        ownerId: account?.canix_owner_id ?? null,
        status: canixSync?.status ?? "not_configured",
        lastSuccessfulAt: canixSync?.last_successful_at ?? null,
        error: canixSync?.last_error ?? null,
      },
      marketplace: marketplaceCatalog.source ?? {
        state: marketplaceCatalog.state,
      },
      monday: {
        mapped: !!account?.monday_account_item_id,
        itemId: account?.monday_account_item_id ?? null,
        status: mondaySyncResult.data?.status ?? "not_configured",
        lastSuccessfulAt: mondaySyncResult.data?.last_successful_at ?? null,
        conflicts: mondaySyncResult.data?.conflict_count ?? null,
        error: mondaySyncResult.data?.last_error ?? null,
      },
      quickbooks: {
        mapped:
          !!(account?.quickbooks_customer_id || account?.quickbooks_vendor_id),
        entityType: account?.quickbooks_entity_type ?? null,
        customerId: account?.quickbooks_customer_id ?? null,
        vendorId: account?.quickbooks_vendor_id ?? null,
        status: quickbooksSyncResult.data?.status ?? "not_configured",
        lastSuccessfulAt: quickbooksSyncResult.data?.last_successful_at ?? null,
        financialLastSuccessfulAt:
          quickbooksSyncResult.data?.financial_last_successful_at ?? null,
        invoiceCount: quickbooksSyncResult.data?.invoice_count ?? null,
        paymentCount: quickbooksSyncResult.data?.payment_count ?? null,
        creditMemoCount: quickbooksSyncResult.data?.credit_memo_count ?? null,
        error: quickbooksSyncResult.data?.last_error ?? null,
      },
    },
    sourcePolicy: {
      inventoryQuantities: "withheld_pending_decision",
      inventoryScope: "canix_owner_only",
      retailerDetails: "withheld_by_policy",
      salesDollars: financialPolicy?.sales_dollars_state ??
        "withheld_pending_finance_approval",
      externalFinancialAmounts: financialPolicy?.sales_dollars_state ??
        "withheld_pending_finance_approval",
      allocatedInventory: governance?.allocated_inventory_visibility ??
        "status_only",
      destinationIdentity: governance?.destination_visibility ??
        "territory_only",
      manifests: governance?.manifest_visibility ?? "approved_documents",
      deliveryAuthority: governance?.delivery_authority ??
        "milestone_sources",
      contractPublishing: governance?.contract_publish_mode ??
        "internal_approval",
      contractHistory: governance?.archive_visibility ??
        "published_executed_history",
      contractTerms: governance?.contract_terms_mode ?? "metadata_only",
      banking: "masked_status_only",
    },
    permissions: [...permissions],
  };
}

async function adminList(actor: Actor): Promise<Row> {
  if (
    actor.role !== "internal" ||
    !["administrator", "operations"].includes(String(actor.staff_role))
  ) {
    throw new BrandError(
      403,
      "Brand administration requires Administrator or Operations access.",
    );
  }
  const { data: organizations, error } = await service.from(
    "portal_organization",
  )
    .select(
      "id,legal_name,display_name,status,created_at,updated_at,portal_brand_account(*),portal_brand_profile_detail(*),portal_brand_governance_policy(*),portal_brand_financial_policy(*),portal_brand_agreement_requirement(*)",
    )
    .eq("kind", "brand").order("display_name");
  if (error) throw error;
  return {
    brands: organizations ?? [],
    canManageMappings: actor.staff_role === "administrator",
    canApproveReadiness: actor.staff_role === "administrator",
    canManageProfiles: ["administrator", "operations"].includes(
      String(actor.staff_role),
    ),
  };
}

async function adminPurchaseOrders(actor: Actor): Promise<Row> {
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Brand purchase-order control requires Administrator access.",
    );
  }
  const [ordersResult, organizationsResult, workItemsResult] = await Promise
    .all([
      service.from("portal_brand_purchase_order").select(
        "*,portal_brand_purchase_order_line(*,portal_brand_purchase_order_fulfillment_event(*))",
      ).order("updated_at", { ascending: false }).limit(250),
      service.from("portal_organization").select(
        "id,display_name,legal_name,status",
      )
        .eq("kind", "brand"),
      service.from("portal_work_item").select(
        "id,target_id,status,priority,assigned_department,due_at,version,portal_work_item_comment(id,body,visibility,created_by_email,created_at)",
      ).eq("workflow_key", "brand_purchase_orders"),
    ]);
  if (ordersResult.error) throw ordersResult.error;
  if (organizationsResult.error) throw organizationsResult.error;
  if (workItemsResult.error) throw workItemsResult.error;
  const organizations = new Map(
    ((organizationsResult.data ?? []) as Row[]).map((
      row,
    ) => [String(row.id), row]),
  );
  const workItems = new Map(
    ((workItemsResult.data ?? []) as Row[]).map((
      row,
    ) => [String(row.target_id), row]),
  );
  return {
    purchaseOrders: ((ordersResult.data ?? []) as Row[]).map((order) => ({
      ...order,
      organization: organizations.get(String(order.organization_id)) ?? null,
      workItem: workItems.get(String(order.id)) ?? null,
    })),
  };
}

async function audit(
  actor: Actor,
  organizationId: string,
  action: string,
  targetType: string,
  targetId: unknown,
  detail: Row,
): Promise<void> {
  const { error } = await service.from("portal_brand_operation_event").insert({
    organization_id: organizationId,
    actor_id: actor.id,
    actor_email: actor.email ?? null,
    action,
    target_type: targetType,
    target_id: targetId ? String(targetId) : null,
    detail,
  });
  if (error) throw error;
}

function interpolateNotification(
  template: string,
  variables: Row,
  allowed: string[],
): string {
  const values: Row = { ...variables, portalUrl: PORTAL_URL };
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key) => {
    if (key !== "portalUrl" && !allowed.includes(key)) return "";
    return clean(values[key], 2000);
  });
}

function notificationHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.split(/\n\n+/).map((paragraph) =>
    `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#170e0b">${
      paragraph.replace(/\n/g, "<br>")
    }</p>`
  ).join("");
}

async function deliverBrandNotification(
  outbox: Row,
  template: Row,
): Promise<string> {
  const { data: policy, error: policyError } = await service.from(
    "portal_notification_policy",
  ).select("mandatory_notice_email_enabled").eq("id", 1).maybeSingle();
  if (policyError) throw policyError;
  if (
    template.mandatory === true &&
    policy?.mandatory_notice_email_enabled !== true
  ) {
    await service.from("portal_notification_outbox").update({
      state: "held_policy",
      last_error: "Mandatory email notices are paused by policy.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return "held_policy";
  }
  if (!RESEND_API_KEY) {
    await service.from("portal_notification_outbox").update({
      state: "held_provider",
      last_error: "Email provider credentials are not configured.",
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return "held_provider";
  }
  const { data: quotaState, error: quotaError } = await service.rpc(
    "portal_claim_resend_free_quota",
    { p_outbox_id: outbox.id },
  );
  if (quotaError) throw quotaError;
  if (quotaState !== "claimed") return "held_provider";

  const payload = outbox.payload && typeof outbox.payload === "object"
    ? outbox.payload as Row
    : {};
  const allowed = Array.isArray(template.allowed_variables)
    ? template.allowed_variables.map(String)
    : [];
  const subject = interpolateNotification(
    String(template.subject_template),
    payload,
    allowed,
  );
  const text = interpolateNotification(
    String(template.text_template),
    payload,
    allowed,
  );
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": String(outbox.id),
    },
    body: JSON.stringify({
      from: PORTAL_EMAIL_FROM,
      to: [outbox.recipient_email],
      subject,
      text,
      html: notificationHtml(text),
      tags: [{
        name: "template",
        value: String(template.template_key).slice(0, 256),
      }],
    }),
  });
  const result = await response.json().catch(() => ({})) as Row;
  if (!response.ok || !result.id) {
    const providerMessage = clean(result.message || result.error, 500) ||
      "Email provider rejected the request.";
    await service.from("portal_notification_outbox").update({
      state: response.status === 429 ? "held_provider" : "failed",
      last_error: response.status === 429
        ? "The no-cost email provider limit was reached; message held for review."
        : providerMessage,
      updated_at: new Date().toISOString(),
    }).eq("id", outbox.id);
    return response.status === 429 ? "held_provider" : "failed";
  }
  await service.from("portal_notification_outbox").update({
    state: "sent",
    provider: "resend",
    provider_message_id: result.id,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", outbox.id);
  return "sent";
}

async function queueBrandNotification(
  templateKey: string,
  recipientEmail: string,
  eventKey: string,
  variables: Row,
): Promise<string> {
  const { data: existing, error: existingError } = await service.from(
    "portal_notification_outbox",
  ).select("id,state").eq("event_key", eventKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return String(existing.state);
  const { data: template, error: templateError } = await service.from(
    "portal_notification_template",
  ).select("*").eq("template_key", templateKey).eq(
    "approval_state",
    "approved",
  ).maybeSingle();
  if (templateError) throw templateError;
  if (!template) {
    throw new Error(`Approved template ${templateKey} is missing.`);
  }
  const { data: outbox, error } = await service.from(
    "portal_notification_outbox",
  ).insert({
    event_key: eventKey,
    event_type: "order_state",
    template_key: templateKey,
    template_version: template.version,
    audience: template.audience,
    mandatory: template.mandatory,
    recipient_email: recipientEmail.toLowerCase(),
    state: "pending",
    channel: "email",
    payload: variables,
    updated_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;
  return await deliverBrandNotification(outbox as Row, template as Row);
}

async function deliverableEmail(profileId: string): Promise<string | null> {
  const { data, error } = await service.auth.admin.getUserById(profileId);
  if (error || !data.user?.email) return null;
  return clean(data.user.email, 254).toLowerCase() || null;
}

async function administratorRecipients(): Promise<
  Array<{ id: string; email: string }>
> {
  const { data, error } = await service.from("portal_profile").select("id")
    .eq("role", "internal").eq("staff_role", "administrator").eq(
      "active",
      true,
    );
  if (error) throw error;
  const recipients: Array<{ id: string; email: string }> = [];
  for (const profile of data ?? []) {
    const recipientEmail = await deliverableEmail(String(profile.id));
    if (recipientEmail) {
      recipients.push({ id: String(profile.id), email: recipientEmail });
    }
  }
  return recipients;
}

async function brandRecipients(
  organizationId: string,
  includeProfileId?: string | null,
): Promise<Array<{ id: string; email: string }>> {
  const { data, error } = await service.from("portal_organization_membership")
    .select("profile_id,member_role").eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active")
    .in("member_role", ["brand_owner", "brand_manager"]);
  if (error) throw error;
  const profileIds = new Set((data ?? []).map((row) => String(row.profile_id)));
  if (includeProfileId) profileIds.add(includeProfileId);
  const recipients: Array<{ id: string; email: string }> = [];
  for (const profileId of profileIds) {
    const recipientEmail = await deliverableEmail(profileId);
    if (recipientEmail) {
      recipients.push({ id: profileId, email: recipientEmail });
    }
  }
  return recipients;
}

async function brandName(organizationId: string): Promise<string> {
  const { data, error } = await service.from("portal_organization").select(
    "display_name,legal_name",
  ).eq("id", organizationId).single();
  if (error) throw error;
  return clean(data.display_name || data.legal_name, 300) || "Brand";
}

async function notifyPurchaseOrderSubmitted(
  actor: Actor,
  organizationId: string,
  purchaseOrder: Row,
): Promise<Row> {
  const name = await brandName(organizationId);
  const reference = clean(purchaseOrder.reference, 120);
  const variables = { purchaseOrderNumber: reference, brandName: name };
  const results: Row[] = [];
  if (actor.role === "brand" && actor.email) {
    results.push({
      audience: "brand",
      state: await queueBrandNotification(
        "brand_purchase_order_received",
        actor.email,
        `brand-po-submitted:${purchaseOrder.id}:brand:${actor.id}`,
        variables,
      ),
    });
  }
  for (const recipient of await administratorRecipients()) {
    results.push({
      audience: "internal",
      state: await queueBrandNotification(
        "brand_purchase_order_internal",
        recipient.email,
        `brand-po-submitted:${purchaseOrder.id}:internal:${recipient.id}`,
        variables,
      ),
    });
  }
  return { attempted: results.length, results };
}

async function notifyPurchaseOrderStatus(
  organizationId: string,
  purchaseOrder: Row,
  creatorProfileId: string | null,
): Promise<Row> {
  const name = await brandName(organizationId);
  const variables = {
    purchaseOrderNumber: clean(purchaseOrder.reference, 120),
    brandName: name,
    purchaseOrderState: clean(purchaseOrder.status, 80).replace(/_/g, " "),
  };
  const results: Row[] = [];
  for (
    const recipient of await brandRecipients(organizationId, creatorProfileId)
  ) {
    results.push({
      audience: "brand",
      state: await queueBrandNotification(
        "brand_purchase_order_state_changed",
        recipient.email,
        `brand-po-status:${purchaseOrder.id}:${purchaseOrder.revision}:${recipient.id}`,
        variables,
      ),
    });
  }
  return { attempted: results.length, results };
}

async function notificationResult(operation: () => Promise<Row>): Promise<Row> {
  try {
    return await operation();
  } catch (error) {
    console.error("brand purchase-order notification", error);
    return {
      attempted: 0,
      warning:
        "The workflow was saved, but its email notice needs review in Communications.",
    };
  }
}

async function saveProfile(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.company.manage");
  if (
    actor.role !== "internal" ||
    !["administrator", "operations"].includes(String(actor.staff_role))
  ) {
    throw new BrandError(
      403,
      "Only Administrators and Operations can manage Brand profiles.",
    );
  }
  const { data: currentDetail, error: currentError } = await service.from(
    "portal_brand_profile_detail",
  ).select(
    "agreement_state,w9_state,insurance_state,payment_terms_state,contacts_state,product_approval_state",
  ).eq("organization_id", organizationId).maybeSingle();
  if (currentError) throw currentError;
  const classification = clean(body.classification, 40);
  const activationState = clean(body.activationState, 40);
  const requestedAgreementState = clean(body.agreementState, 40);
  if (!["company_owned", "external_partner"].includes(classification)) {
    throw new BrandError(400, "Choose a valid Brand classification.");
  }
  if (
    !["onboarding", "active", "suspended", "closed"].includes(activationState)
  ) throw new BrandError(400, "Choose a valid activation state.");
  if (
    !["pending", "in_review", "active", "expired", "not_required"].includes(
      requestedAgreementState,
    )
  ) throw new BrandError(400, "Choose a valid agreement state.");
  const [requiredResult, agreementResult] = await Promise.all([
    service.from("portal_brand_agreement_requirement").select(
      "requirement_code",
    )
      .eq("organization_id", organizationId).eq("applicability", "required"),
    service.from("portal_brand_agreement").select(
      "requirement_code,status,visibility",
    )
      .eq("organization_id", organizationId),
  ]);
  if (requiredResult.error) throw requiredResult.error;
  if (agreementResult.error) throw agreementResult.error;
  const requiredCodes = new Set(
    (requiredResult.data ?? []).map((row) => String(row.requirement_code)),
  );
  const agreementRows = (agreementResult.data ?? []) as Row[];
  const coveredCodes = new Set(
    agreementRows.filter((agreement) =>
      agreement.visibility === "published" &&
      ["active", "expiring"].includes(String(agreement.status))
    ).map((agreement) => String(agreement.requirement_code)),
  );
  const hasAgreementReview = agreementRows.some((agreement) =>
    agreement.status === "in_review"
  );
  const agreementState = classification === "company_owned"
    ? "not_required"
    : requiredCodes.size > 0 &&
        [...requiredCodes].every((code) => coveredCodes.has(code))
    ? "active"
    : hasAgreementReview
    ? "in_review"
    : "pending";
  if (requestedAgreementState === "active" && agreementState !== "active") {
    throw new BrandError(
      409,
      "The agreement gate cannot be marked active until every relationship-required agreement is published.",
    );
  }
  const readinessValues = [
    "pending",
    "in_review",
    "approved",
    "rejected",
    "expired",
  ];
  const readiness = {
    w9_state: clean(body.w9State, 40) || clean(currentDetail?.w9_state, 40) ||
      "pending",
    insurance_state: clean(body.insuranceState, 40) ||
      clean(currentDetail?.insurance_state, 40) || "pending",
    payment_terms_state: clean(body.paymentTermsState, 40) ||
      clean(currentDetail?.payment_terms_state, 40) || "pending",
    contacts_state: clean(body.contactsState, 40) ||
      clean(currentDetail?.contacts_state, 40) || "pending",
    product_approval_state: clean(body.productApprovalState, 40) ||
      clean(currentDetail?.product_approval_state, 40) || "pending",
  };
  if (
    Object.values(readiness).some((value) => !readinessValues.includes(value))
  ) {
    throw new BrandError(400, "Choose a valid readiness status.");
  }
  const readinessChanged =
    agreementState !== clean(currentDetail?.agreement_state, 40) ||
    Object.entries(readiness).some(([key, value]) =>
      value !== clean((currentDetail as Row | null)?.[key], 40)
    );
  if (readinessChanged && actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Only a UX Administrator can approve or change activation evidence.",
    );
  }
  const readinessComplete = agreementState === "active" &&
    Object.values(readiness).every((value) => value === "approved");
  if (
    classification === "external_partner" && activationState === "active" &&
    !readinessComplete
  ) {
    throw new BrandError(
      409,
      "Agreement, W-9, insurance, payment terms, contacts, and product approval must all be approved before activation.",
    );
  }
  const legalName = clean(body.legalName, 240);
  const primaryContactName = clean(body.primaryContactName, 200);
  const primaryContactEmail = email(body.primaryContactEmail);
  if (
    classification === "external_partner" &&
    (!legalName || !primaryContactName || !primaryContactEmail)
  ) {
    throw new BrandError(
      400,
      "External Brands require a legal name, primary contact name, and primary contact email.",
    );
  }
  const record = {
    organization_id: organizationId,
    classification,
    activation_state: activationState,
    legal_name: legalName || null,
    dba_name: clean(body.dbaName, 240) || null,
    website: clean(body.website, 500) || null,
    primary_contact_name: primaryContactName || null,
    primary_contact_email: primaryContactEmail,
    primary_contact_phone: clean(body.primaryContactPhone, 80) || null,
    operations_contact_email: email(body.operationsContactEmail),
    finance_contact_email: email(body.financeContactEmail),
    quality_contact_email: email(body.qualityContactEmail),
    agreement_state: agreementState,
    ...readiness,
    readiness_reviewed_by: readinessChanged ? actor.id : undefined,
    readiness_reviewed_at: readinessChanged
      ? new Date().toISOString()
      : undefined,
    internal_note: clean(body.internalNote, 3000) || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_brand_profile_detail")
    .upsert(record).select().single();
  if (error) throw error;
  await service.from("portal_organization").update({
    status: activationState === "active"
      ? "active"
      : activationState === "onboarding"
      ? "onboarding"
      : "inactive",
    updated_at: new Date().toISOString(),
  }).eq("id", organizationId);
  await audit(
    actor,
    organizationId,
    "brand_profile_updated",
    "brand_profile",
    organizationId,
    {
      classification,
      activationState,
      agreementState,
      readiness,
      readinessComplete,
      readinessReviewedByAdministrator: readinessChanged,
    },
  );
  return { detail: data, readinessComplete };
}

async function saveMapping(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Only an Administrator can change source mappings.",
    );
  }
  await brandAccess(actor, organizationId);
  const canixBrandId = clean(body.canixBrandId, 40) || null;
  const canixOwnerId = clean(body.canixOwnerId, 40) || null;
  if (canixBrandId && !/^\d+$/.test(canixBrandId)) {
    throw new BrandError(400, "Canix Brand ID must be numeric.");
  }
  if (canixOwnerId && !/^\d+$/.test(canixOwnerId)) {
    throw new BrandError(400, "Canix Owner ID must be numeric.");
  }
  const scopeStatus = clean(body.scopeStatus, 40);
  if (!["pending", "verified", "blocked"].includes(scopeStatus)) {
    throw new BrandError(400, "Choose a valid mapping status.");
  }
  if (scopeStatus === "verified" && !canixOwnerId) {
    throw new BrandError(
      400,
      "A verified mapping needs one Canix Owner ID. Brand is product identity, not inventory scope.",
    );
  }
  const scopeNote = clean(body.scopeNote, 2000);
  if (scopeStatus === "verified" && !scopeNote) {
    throw new BrandError(
      400,
      "A verified Canix Owner mapping requires a verification note or evidence reference.",
    );
  }
  if (canixOwnerId) {
    const { data: ownerMatch, error: ownerError } = await service.from(
      "portal_brand_account",
    ).select("organization_id").eq("canix_owner_id", canixOwnerId)
      .neq("organization_id", organizationId).maybeSingle();
    if (ownerError) throw ownerError;
    if (ownerMatch) {
      throw new BrandError(
        409,
        "That Canix Owner is already assigned to another Brand organization.",
      );
    }
  }
  const entityType = clean(body.quickbooksEntityType, 20) || null;
  if (entityType && !["customer", "vendor", "both"].includes(entityType)) {
    throw new BrandError(400, "Choose a valid QuickBooks relationship.");
  }
  const quickbooksCustomerId = clean(body.quickbooksCustomerId, 80) || null;
  const quickbooksVendorId = clean(body.quickbooksVendorId, 80) || null;
  if (
    ["customer", "both"].includes(String(entityType)) && !quickbooksCustomerId
  ) {
    throw new BrandError(
      400,
      "A QuickBooks customer relationship requires a Customer ID.",
    );
  }
  if (["vendor", "both"].includes(String(entityType)) && !quickbooksVendorId) {
    throw new BrandError(
      400,
      "A QuickBooks vendor relationship requires a Vendor ID.",
    );
  }
  const record = {
    organization_id: organizationId,
    canix_brand_id: canixBrandId,
    canix_brand_name: clean(body.canixBrandName, 200) || null,
    canix_owner_id: canixOwnerId,
    canix_owner_name: clean(body.canixOwnerName, 200) || null,
    monday_account_item_id: clean(body.mondayItemId, 80) || null,
    quickbooks_entity_type: entityType,
    quickbooks_customer_id: quickbooksCustomerId,
    quickbooks_vendor_id: quickbooksVendorId,
    scope_status: scopeStatus,
    scope_note: scopeNote ||
      (canixOwnerId
        ? "Canix Owner is the approved inventory scope; Brand remains descriptive product identity."
        : null),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_brand_account").upsert(
    record,
  ).select().single();
  if (error) throw error;
  await audit(
    actor,
    organizationId,
    "brand_mapping_updated",
    "brand_account",
    organizationId,
    {
      canixBrandId,
      canixOwnerId,
      mondayItemId: record.monday_account_item_id,
      quickbooksEntityType: entityType,
      quickbooksCustomerId: record.quickbooks_customer_id,
      quickbooksVendorId: record.quickbooks_vendor_id,
      scopeStatus,
    },
  );
  return { account: data };
}

async function savePolicy(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Only an Administrator can change Brand governance or Finance policy.",
    );
  }
  await brandAccess(actor, organizationId);
  const { data: currentPolicy, error: currentPolicyError } = await service.from(
    "portal_brand_governance_policy",
  ).select("*").eq("organization_id", organizationId)
    .maybeSingle();
  if (currentPolicyError) throw currentPolicyError;
  const { data: profileDetail, error: profileDetailError } = await service.from(
    "portal_brand_profile_detail",
  ).select("classification").eq("organization_id", organizationId)
    .maybeSingle();
  if (profileDetailError) throw profileDetailError;
  const classification = clean(profileDetail?.classification, 40) ||
    "external_partner";
  const relationshipTemplate = choice(
    body.relationshipTemplate,
    [
      "custom",
      "manufacturing_sales_distribution",
      "distribution_only",
      "toll",
      "consignment",
      "revenue_share",
      "company_owned",
    ],
    "custom",
    "relationship template",
  );
  if (
    relationshipTemplate === "company_owned" &&
    classification !== "company_owned"
  ) {
    throw new BrandError(
      400,
      "The company-owned template is only available to a company-owned Brand.",
    );
  }
  const templateFlags: Record<string, Row> = {
    manufacturing_sales_distribution: {
      manufacturingEnabled: true,
      salesEnabled: true,
      distributionEnabled: true,
    },
    distribution_only: { distributionEnabled: true },
    toll: { manufacturingEnabled: true, ownershipModel: "toll" },
    consignment: { salesEnabled: true, consignmentEnabled: true },
    revenue_share: { salesEnabled: true, revenueShareEnabled: true },
    company_owned: {
      manufacturingEnabled: true,
      salesEnabled: true,
      distributionEnabled: true,
      ownershipModel: "ux",
    },
  };
  const template = templateFlags[relationshipTemplate] ?? {};
  const flag = (key: string, existingKey: string): boolean =>
    typeof template[key] === "boolean"
      ? template[key] === true
      : typeof body[key] === "boolean"
      ? body[key] === true
      : currentPolicy?.[existingKey] === true;
  const manufacturingEnabled = flag(
    "manufacturingEnabled",
    "manufacturing_enabled",
  );
  const salesEnabled = flag("salesEnabled", "sales_enabled");
  const distributionEnabled = flag(
    "distributionEnabled",
    "distribution_enabled",
  );
  const trademarkLicenseRequired = flag(
    "trademarkLicenseRequired",
    "trademark_license_required",
  );
  const msaCoversConfidentiality = flag(
    "msaCoversConfidentiality",
    "msa_covers_confidentiality",
  );
  const consignmentEnabled = flag("consignmentEnabled", "consignment_enabled");
  const revenueShareEnabled = flag(
    "revenueShareEnabled",
    "revenue_share_enabled",
  );
  const electronicPaymentsEnabled = flag(
    "electronicPaymentsEnabled",
    "electronic_payments_enabled",
  );
  const ownershipModel = choice(
    template.ownershipModel ?? body.ownershipModel,
    ["not_set", "ux", "toll", "split", "test"],
    classification === "company_owned" ? "ux" : "not_set",
    "ownership model",
  );
  const manufacturingContact = clean(body.manufacturingContact, 500);
  const shippingContact = clean(body.shippingContact, 500);
  const deliveryTerms = clean(body.deliveryTerms, 2000);
  const settlementMethod = clean(body.settlementMethod, 2000);
  const brandLicenseType = clean(body.brandLicenseType, 160);
  const brandLicenseNumber = clean(body.brandLicenseNumber, 200);
  const brandLicenseExpiresOn = today(body.brandLicenseExpiresOn);
  const relationshipExceptionReason = clean(
    body.relationshipExceptionReason,
    2000,
  );
  const relationshipExceptionEvidence = clean(
    body.relationshipExceptionEvidence,
    2000,
  );
  if (manufacturingEnabled && !manufacturingContact) {
    throw new BrandError(
      400,
      "Manufacturing or processing requires a manufacturing contact.",
    );
  }
  if (distributionEnabled && (!shippingContact || !deliveryTerms)) {
    throw new BrandError(
      400,
      "Distribution requires a shipping contact and delivery terms.",
    );
  }
  if (revenueShareEnabled && !settlementMethod) {
    throw new BrandError(400, "Revenue share requires a settlement method.");
  }
  if (
    (brandLicenseType || brandLicenseNumber || brandLicenseExpiresOn ||
      trademarkLicenseRequired) &&
    (!brandLicenseType || !brandLicenseNumber || !brandLicenseExpiresOn)
  ) {
    throw new BrandError(
      400,
      "Brand licensing requires the license type, number, and expiration date together.",
    );
  }
  if (
    Boolean(relationshipExceptionReason) !==
      Boolean(relationshipExceptionEvidence)
  ) {
    throw new BrandError(
      400,
      "An approved exception requires both a reason and an evidence reference.",
    );
  }
  const governance = {
    organization_id: organizationId,
    policy_version: Math.max(
      1,
      Math.trunc(Number(currentPolicy?.policy_version ?? 0)) + 1,
    ),
    effective_on: today(body.effectiveOn) ??
      new Date().toISOString().slice(0, 10),
    contract_publish_mode: "internal_approval",
    archive_visibility: choice(
      body.archiveVisibility,
      ["published_executed_history", "current_only"],
      "published_executed_history",
      "contract-history rule",
    ),
    contract_terms_mode: choice(
      body.contractTermsMode,
      ["metadata_only", "approved_structured_terms"],
      "metadata_only",
      "contract-terms rule",
    ),
    renewal_default_owner: clean(body.renewalDefaultOwner, 160) || "Operations",
    renewal_reminder_days: [90, 60, 30, 0],
    sales_units_visibility: choice(
      body.salesUnitsVisibility,
      ["enabled", "withheld"],
      "enabled",
      "sales-unit visibility",
    ),
    sales_dollars_visibility: choice(
      body.salesDollarsVisibility,
      ["withheld", "finance_approved"],
      "finance_approved",
      "sales-dollar visibility",
    ),
    retailer_identity_visibility: "withheld",
    sales_download_enabled: body.salesDownloadEnabled !== false,
    sales_reporting_dimensions: ["sku", "month", "order", "territory"],
    allocated_inventory_visibility: choice(
      body.allocatedInventoryVisibility,
      ["hidden", "status_only", "approved_quantity"],
      "status_only",
      "allocated-inventory visibility",
    ),
    destination_visibility: choice(
      body.destinationVisibility,
      ["hidden", "territory_only"],
      "territory_only",
      "destination visibility",
    ),
    manifest_visibility: choice(
      body.manifestVisibility,
      ["hidden", "approved_documents"],
      "approved_documents",
      "manifest visibility",
    ),
    delivery_authority: choice(
      body.deliveryAuthority,
      ["milestone_sources", "monday_with_evidence"],
      "milestone_sources",
      "delivery authority",
    ),
    relationship_template: relationshipTemplate,
    manufacturing_enabled: manufacturingEnabled,
    sales_enabled: salesEnabled,
    distribution_enabled: distributionEnabled,
    trademark_license_required: trademarkLicenseRequired,
    msa_covers_confidentiality: msaCoversConfidentiality,
    ownership_model: ownershipModel,
    consignment_enabled: consignmentEnabled,
    revenue_share_enabled: revenueShareEnabled,
    electronic_payments_enabled: electronicPaymentsEnabled,
    manufacturing_contact: manufacturingContact || null,
    shipping_contact: shippingContact || null,
    delivery_terms: deliveryTerms || null,
    settlement_method: settlementMethod || null,
    brand_license_type: brandLicenseType || null,
    brand_license_number: brandLicenseNumber || null,
    brand_license_expires_on: brandLicenseExpiresOn,
    relationship_exception_reason: relationshipExceptionReason || null,
    relationship_exception_evidence: relationshipExceptionEvidence || null,
    relationship_exception_approved_by: relationshipExceptionReason
      ? actor.id
      : null,
    relationship_exception_approved_by_email: relationshipExceptionReason
      ? actor.email ?? null
      : null,
    relationship_exception_approved_at: relationshipExceptionReason
      ? new Date().toISOString()
      : null,
    approved_by: actor.id,
    approved_by_email: actor.email ?? null,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const financial = {
    organization_id: organizationId,
    quickbooks_classification: choice(
      body.quickbooksClassification,
      [
        "customer",
        "vendor",
        "both",
        "company_owned_not_applicable",
        "pending_finance_review",
      ],
      "pending_finance_review",
      "QuickBooks classification",
    ),
    identity_status: choice(
      body.identityStatus,
      ["pending_finance_review", "verified", "blocked"],
      "pending_finance_review",
      "Finance identity status",
    ),
    ar_visibility: choice(
      body.arVisibility,
      ["not_applicable", "quickbooks_read_only", "withheld"],
      "quickbooks_read_only",
      "AR visibility",
    ),
    statement_state: choice(
      body.statementState,
      ["not_required", "pending_finance_approval", "enabled"],
      "pending_finance_approval",
      "statement state",
    ),
    sales_dollars_state: choice(
      body.salesDollarsState,
      ["internal_only", "withheld_pending_finance_approval", "approved"],
      "withheld_pending_finance_approval",
      "sales-dollar state",
    ),
    settlement_state: choice(
      body.settlementState,
      ["not_required", "pending_agreement", "configured", "approved"],
      "pending_agreement",
      "settlement state",
    ),
    banking_setup_state: choice(
      body.bankingSetupState,
      ["not_required", "pending", "verified"],
      "pending",
      "banking setup state",
    ),
    bank_name: clean(body.bankName, 200) || null,
    account_holder_name: clean(body.accountHolderName, 200) || null,
    account_last_four: clean(body.accountLastFour, 4) || null,
    secure_provider_reference: clean(body.secureProviderReference, 300) || null,
    banking_verified_at: clean(body.bankingSetupState, 40) === "verified"
      ? new Date().toISOString()
      : null,
    reviewed_by: actor.id,
    reviewed_by_email: actor.email ?? null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (
    financial.account_last_four &&
    !/^\d{4}$/.test(String(financial.account_last_four))
  ) {
    throw new BrandError(
      400,
      "Banking may retain only four numeric account digits.",
    );
  }
  if (
    financial.banking_setup_state === "verified" &&
    !financial.secure_provider_reference
  ) {
    throw new BrandError(
      400,
      "Verified banking requires an approved secure-provider reference.",
    );
  }
  if (
    electronicPaymentsEnabled &&
    (financial.banking_setup_state !== "verified" ||
      !financial.secure_provider_reference)
  ) {
    throw new BrandError(
      400,
      "Electronic payments require verified banking and an approved secure-provider reference.",
    );
  }
  if (
    revenueShareEnabled &&
    !["configured", "approved"].includes(String(financial.settlement_state))
  ) {
    throw new BrandError(
      400,
      "Revenue share requires a configured or approved settlement state.",
    );
  }
  const requirements = Array.isArray(body.requirements)
    ? body.requirements
    : [];
  const allowedRequirementCodes = new Set([
    "nda",
    "msa",
    "manufacturing",
    "sales",
    "distribution",
    "quality",
    "brand_ip",
    "tolling",
    "consignment",
    "revenue_share",
    "pricing_fee",
    "ach",
  ]);
  const derivedApplicability: Record<string, string> = {
    nda: classification === "external_partner" && !msaCoversConfidentiality
      ? "required"
      : "not_required",
    msa: classification === "external_partner" ? "required" : "not_required",
    manufacturing: classification === "external_partner" && manufacturingEnabled
      ? "required"
      : "not_required",
    sales: classification === "external_partner" && salesEnabled
      ? "required"
      : "not_required",
    distribution: classification === "external_partner" && distributionEnabled
      ? "required"
      : "not_required",
    quality: classification === "external_partner" && manufacturingEnabled
      ? "required"
      : "not_required",
    brand_ip: classification === "external_partner" && trademarkLicenseRequired
      ? "required"
      : "not_required",
    tolling: classification === "external_partner" && ownershipModel === "toll"
      ? "required"
      : "not_required",
    consignment: classification === "external_partner" && consignmentEnabled
      ? "required"
      : "not_required",
    revenue_share: classification === "external_partner" && revenueShareEnabled
      ? "required"
      : "not_required",
    pricing_fee: classification === "external_partner" && salesEnabled
      ? "required"
      : "not_required",
    ach: classification === "external_partner" && electronicPaymentsEnabled
      ? "required"
      : "not_required",
  };
  const requirementUpdates = requirements.map((entry) => {
    const row = entry as Row;
    const requirementCode = clean(row.requirementCode, 80);
    if (!allowedRequirementCodes.has(requirementCode)) {
      throw new BrandError(400, "Choose a valid agreement requirement.");
    }
    const applicability = derivedApplicability[requirementCode] ??
      "conditional";
    const decisionReason = applicability === "not_required"
      ? clean(row.decisionReason, 2000) ||
        "Not applicable under the saved Brand relationship activities."
      : null;
    return {
      organization_id: organizationId,
      requirement_code: requirementCode,
      applicability,
      decision_reason: decisionReason,
      review_owner: applicability === "pending_review"
        ? clean(row.reviewOwner, 200) || null
        : null,
      target_review_on: applicability === "pending_review"
        ? today(row.targetReviewOn)
        : null,
      evidence_summary: clean(row.evidenceSummary, 2000) || null,
      decision_by: applicability === "not_required" ? actor.id : null,
      decision_by_email: applicability === "not_required"
        ? actor.email ?? "unknown@urbanxtracts.com"
        : null,
      decision_at: applicability === "not_required"
        ? new Date().toISOString()
        : null,
      updated_at: new Date().toISOString(),
    };
  });

  const [governanceResult, financialResult] = await Promise.all([
    service.from("portal_brand_governance_policy").upsert(governance).select()
      .single(),
    service.from("portal_brand_financial_policy").upsert(financial).select()
      .single(),
  ]);
  if (governanceResult.error) throw governanceResult.error;
  if (financialResult.error) throw financialResult.error;
  if (requirementUpdates.length) {
    for (const requirement of requirementUpdates) {
      const { error } = await service.from("portal_brand_agreement_requirement")
        .update({
          applicability: requirement.applicability,
          decision_reason: requirement.decision_reason,
          review_owner: requirement.review_owner,
          target_review_on: requirement.target_review_on,
          evidence_summary: requirement.evidence_summary,
          decision_by: requirement.decision_by,
          decision_by_email: requirement.decision_by_email,
          decision_at: requirement.decision_at,
          updated_at: requirement.updated_at,
        }).eq("organization_id", organizationId)
        .eq("requirement_code", requirement.requirement_code);
      if (error) throw error;
    }
  }
  await refreshAgreementState(organizationId);
  await audit(
    actor,
    organizationId,
    "brand_governance_policy_updated",
    "brand_policy",
    organizationId,
    {
      policyVersion: governance.policy_version,
      archiveVisibility: governance.archive_visibility,
      salesDollarsVisibility: governance.sales_dollars_visibility,
      retailerIdentityVisibility: governance.retailer_identity_visibility,
      deliveryAuthority: governance.delivery_authority,
      quickbooksClassification: financial.quickbooks_classification,
      identityStatus: financial.identity_status,
      bankingSetupState: financial.banking_setup_state,
      previousRelationship: {
        template: currentPolicy?.relationship_template ?? null,
        manufacturing: currentPolicy?.manufacturing_enabled ?? false,
        sales: currentPolicy?.sales_enabled ?? false,
        distribution: currentPolicy?.distribution_enabled ?? false,
        ownershipModel: currentPolicy?.ownership_model ?? "not_set",
        consignment: currentPolicy?.consignment_enabled ?? false,
        revenueShare: currentPolicy?.revenue_share_enabled ?? false,
        electronicPayments: currentPolicy?.electronic_payments_enabled ?? false,
      },
      relationshipTemplate,
      activities: {
        manufacturing: manufacturingEnabled,
        sales: salesEnabled,
        distribution: distributionEnabled,
        consignment: consignmentEnabled,
        revenueShare: revenueShareEnabled,
        electronicPayments: electronicPaymentsEnabled,
        ownershipModel,
      },
      requirements: requirementUpdates.map((requirement) => ({
        requirementCode: requirement.requirement_code,
        applicability: requirement.applicability,
      })),
    },
  );
  return {
    governance: governanceResult.data,
    financialPolicy: financialResult.data,
    requirementsUpdated: requirementUpdates.length,
  };
}

async function refreshAgreementState(organizationId: string): Promise<void> {
  const [detailResult, requirementsResult, agreementsResult] = await Promise
    .all([
      service.from("portal_brand_profile_detail").select("classification")
        .eq("organization_id", organizationId).maybeSingle(),
      service.from("portal_brand_agreement_requirement").select(
        "requirement_code",
      )
        .eq("organization_id", organizationId).eq("applicability", "required"),
      service.from("portal_brand_agreement").select(
        "requirement_code,status,visibility",
      )
        .eq("organization_id", organizationId),
    ]);
  if (detailResult.error) throw detailResult.error;
  if (requirementsResult.error) throw requirementsResult.error;
  if (agreementsResult.error) throw agreementsResult.error;
  const classification = String(
    detailResult.data?.classification ?? "external_partner",
  );
  const required = new Set(
    (requirementsResult.data ?? []).map((row) => String(row.requirement_code)),
  );
  const agreements = (agreementsResult.data ?? []) as Row[];
  const covered = new Set(
    agreements.filter((agreement) =>
      agreement.visibility === "published" &&
      ["active", "expiring"].includes(String(agreement.status))
    ).map((agreement) => String(agreement.requirement_code)),
  );
  const hasReview = agreements.some((agreement) =>
    agreement.status === "in_review"
  );
  const agreementState = classification === "company_owned"
    ? "not_required"
    : required.size > 0 && [...required].every((code) => covered.has(code))
    ? "active"
    : hasReview
    ? "in_review"
    : "pending";
  const { error } = await service.from("portal_brand_profile_detail").update({
    agreement_state: agreementState,
    updated_at: new Date().toISOString(),
  }).eq("organization_id", organizationId);
  if (error) throw error;
}

function agreementCommercialTerms(body: Row): {
  header: Row;
  feeLines: Row[];
  state: string;
} {
  const input =
    body.commercialTerms && typeof body.commercialTerms === "object" &&
      !Array.isArray(body.commercialTerms)
      ? body.commercialTerms as Row
      : {};
  const paymentTerms = clean(input.paymentTerms, 300);
  const settlementFrequency = clean(input.settlementFrequency, 120);
  const responsibleOwner = clean(input.responsibleInternalOwner, 200);
  const financeApprover = clean(input.financeApprover, 200);
  const legalApprover = clean(input.legalApprover, 200);
  const sourceReference = clean(input.sourceClauseReference, 500);
  const note = clean(input.note, 4000);
  const currency = clean(input.currencyCode, 3).toUpperCase() || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BrandError(400, "Use a three-letter currency code.");
  }
  const rawLines = Array.isArray(body.feeLines)
    ? body.feeLines.slice(0, 50)
    : [];
  const feeLines = rawLines.map((raw, index) => {
    const line = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Row
      : {};
    const feeName = clean(line.feeName, 200);
    if (!feeName) {
      throw new BrandError(400, `Fee line ${index + 1} needs a name.`);
    }
    const feeCategory = choice(
      line.feeCategory,
      [
        "onboarding_setup",
        "manufacturing_processing",
        "toll",
        "packaging",
        "ingredient_component",
        "lab",
        "storage",
        "distribution",
        "sales_commission",
        "revenue_share",
        "licensing_royalty",
        "monthly_minimum",
        "pass_through",
        "credit_rebate",
        "other",
      ],
      "other",
      "fee category",
    );
    const calculationMethod = choice(
      line.calculationMethod,
      [
        "fixed",
        "per_unit",
        "per_case",
        "per_pound",
        "per_gram",
        "percentage_gross",
        "percentage_net",
        "percentage_collected",
        "tiered",
        "cost_plus",
        "pass_through",
        "custom_manual",
      ],
      "fixed",
      "calculation method",
    );
    const calculationBasis = clean(line.calculationBasis, 1000);
    const uomCode = clean(line.uomCode, 80);
    const percentageRate = numberOrNull(line.percentageRate);
    if (
      calculationMethod.startsWith("percentage_") &&
      (percentageRate === null || !calculationBasis)
    ) {
      throw new BrandError(
        400,
        `Fee line ${index + 1} needs a percentage and calculation basis.`,
      );
    }
    if (
      ["per_unit", "per_case", "per_pound", "per_gram"].includes(
        calculationMethod,
      ) && !uomCode
    ) {
      throw new BrandError(
        400,
        `Fee line ${index + 1} needs a unit of measure.`,
      );
    }
    const conditional =
      line.conditionalDetail && typeof line.conditionalDetail === "object" &&
        !Array.isArray(line.conditionalDetail)
        ? Object.fromEntries(
          Object.entries(line.conditionalDetail as Row).slice(0, 30).map((
            [key, value],
          ) => [
            clean(key, 80).replace(/[^a-zA-Z0-9_-]/g, "_"),
            clean(value, 2000),
          ]),
        )
        : {};
    return {
      line_number: index + 1,
      fee_name: feeName,
      fee_category: feeCategory,
      calculation_method: calculationMethod,
      rate_amount: numberOrNull(line.rateAmount),
      percentage_rate: percentageRate,
      uom_code: uomCode || null,
      calculation_basis: calculationBasis || null,
      payer: clean(line.payer, 200) || null,
      recipient: clean(line.recipient, 200) || null,
      scope_summary: clean(line.scopeSummary, 2000) || null,
      effective_on: today(line.effectiveOn),
      ends_on: today(line.endsOn),
      billing_frequency: clean(line.billingFrequency, 120) || null,
      minimum_amount: numberOrNull(line.minimumAmount),
      maximum_amount: numberOrNull(line.maximumAmount),
      quickbooks_mapping: clean(line.quickbooksMapping, 300) || null,
      brand_visibility: choice(
        line.brandVisibility,
        ["hidden", "summary", "full"],
        "summary",
        "Brand visibility",
      ),
      status: "draft",
      conditional_detail: conditional,
    };
  });
  const hasTerms = feeLines.length > 0 || !!paymentTerms ||
    !!settlementFrequency;
  return {
    state: hasTerms ? "pending_finance" : "not_applicable",
    header: {
      payment_terms: paymentTerms || null,
      settlement_frequency: settlementFrequency || null,
      currency_code: currency,
      responsible_internal_owner: responsibleOwner || null,
      finance_approver: financeApprover || null,
      legal_approver: legalApprover || null,
      source_clause_reference: sourceReference || null,
      commercial_terms_note: note || null,
    },
    feeLines,
  };
}

async function submitAgreement(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.agreements.manage");
  const requirementCode = clean(body.requirementCode, 80);
  const { data: requirement, error: requirementError } = await service.from(
    "portal_brand_agreement_requirement",
  ).select("requirement_code,agreement_name,applicability").eq(
    "organization_id",
    organizationId,
  ).eq("requirement_code", requirementCode).maybeSingle();
  if (requirementError) throw requirementError;
  if (!requirement) throw new BrandError(400, "Choose a valid agreement type.");
  if (requirement.applicability === "not_required") {
    throw new BrandError(
      409,
      "This agreement is not required for the selected Brand.",
    );
  }
  const reference = clean(body.reference, 200);
  const versionLabel = clean(body.versionLabel, 80);
  if (!reference || !versionLabel) {
    throw new BrandError(400, "Agreement reference and version are required.");
  }
  const effectiveOn = today(body.effectiveOn);
  const expiresOn = today(body.expiresOn);
  const termType = choice(
    body.termType,
    ["fixed_term", "evergreen", "indefinite"],
    "fixed_term",
    "agreement term",
  );
  const renewalReviewOn = today(body.renewalReviewOn);
  const renewalOwner = clean(body.renewalOwner, 160);
  const evidenceSummary = clean(body.evidenceSummary, 3000);
  const requestedCommercialTerms = body.commercialTerms &&
      typeof body.commercialTerms === "object" &&
      !Array.isArray(body.commercialTerms)
    ? body.commercialTerms as Row
    : {};
  const requestedFeeLines = Array.isArray(body.feeLines) ? body.feeLines : [];
  const hasCommercialInput = requestedFeeLines.length > 0 ||
    Object.values(requestedCommercialTerms).some((value) =>
      value !== null && value !== undefined && clean(value, 1) !== ""
    );
  if (actor.role !== "internal" && hasCommercialInput) {
    throw new BrandError(
      403,
      "Commercial terms and fee schedules are maintained by the Internal team.",
    );
  }
  const commercial = actor.role === "internal"
    ? agreementCommercialTerms(body)
    : {
      state: "not_applicable",
      header: {
        payment_terms: null,
        settlement_frequency: null,
        currency_code: "USD",
        responsible_internal_owner: null,
        finance_approver: null,
        legal_approver: null,
        source_clause_reference: null,
        commercial_terms_note: null,
      },
      feeLines: [],
    };
  if (!effectiveOn) {
    throw new BrandError(
      400,
      "Every agreement record requires an effective date.",
    );
  }
  if (effectiveOn && expiresOn && expiresOn < effectiveOn) {
    throw new BrandError(
      400,
      "The expiration date cannot precede the effective date.",
    );
  }
  if (termType === "fixed_term" && (!expiresOn || !renewalOwner)) {
    throw new BrandError(
      400,
      "Fixed-term agreements require an expiration date and renewal owner.",
    );
  }
  if (
    termType === "evergreen" && (expiresOn || !renewalReviewOn || !renewalOwner)
  ) {
    throw new BrandError(
      400,
      "Evergreen agreements require a renewal review date and owner, and must leave expiration blank.",
    );
  }
  if (termType === "indefinite" && expiresOn) {
    throw new BrandError(
      400,
      "Indefinite agreements must leave expiration blank.",
    );
  }
  const { data: duplicate, error: duplicateError } = await service.from(
    "portal_brand_agreement",
  ).select("id").eq("organization_id", organizationId).eq(
    "reference",
    reference,
  )
    .maybeSingle();
  if (duplicateError) throw duplicateError;
  if (duplicate) {
    throw new BrandError(
      409,
      "That agreement reference already exists. Use a new version reference.",
    );
  }
  const file = body.file && typeof body.file === "object"
    ? body.file as Row
    : {};
  const hasFile = !!clean(file.base64, 20);
  if (!hasFile && !evidenceSummary) {
    throw new BrandError(
      400,
      "When no PDF is attached, enter an evidence note describing where the signed agreement is retained.",
    );
  }
  let filePayload: ReturnType<typeof decodeAgreementPdf> | null = null;
  let digest: string | null = null;
  let scan: { engine?: string } | null = null;
  if (hasFile) {
    filePayload = decodeAgreementPdf(file);
    digest = await sha256Hex(filePayload.bytes);
    try {
      scan = await scanContent(filePayload.bytes, digest);
    } catch (error) {
      if (error instanceof ContentScanError && error.verdict === "infected") {
        throw new BrandError(
          422,
          "The agreement was blocked by malware scanning.",
        );
      }
      throw new BrandError(
        503,
        "The agreement could not be verified as clean. Nothing was stored; try again later.",
      );
    }
  }

  const { data: governance, error: governanceError } = await service.from(
    "portal_brand_governance_policy",
  ).select("contract_terms_mode,renewal_default_owner,renewal_reminder_days")
    .eq("organization_id", organizationId).maybeSingle();
  if (governanceError) throw governanceError;
  const agreementId = crypto.randomUUID();
  const objectPath = filePayload && digest
    ? `${organizationId}/${agreementId}/${digest}.pdf`
    : null;
  if (filePayload && objectPath) {
    const { error: uploadError } = await service.storage.from(
      "portal-brand-agreements",
    ).upload(objectPath, filePayload.bytes, {
      contentType: filePayload.contentType,
      cacheControl: "0",
      upsert: false,
    });
    if (uploadError) throw uploadError;
  }

  let agreement: Row | null = null;
  try {
    const { data, error } = await service.from("portal_brand_agreement").insert(
      {
        id: agreementId,
        organization_id: organizationId,
        requirement_code: requirementCode,
        agreement_type: requirement.agreement_name,
        reference,
        status: "in_review",
        visibility: "internal",
        version_label: versionLabel,
        effective_on: effectiveOn,
        expires_on: expiresOn,
        term_type: termType,
        renewal_review_on: renewalReviewOn,
        evidence_summary: evidenceSummary || null,
        renewal_owner: renewalOwner ||
          clean(governance?.renewal_default_owner, 160) || "Operations",
        renewal_notice_days: governance?.renewal_reminder_days ??
          [90, 60, 30, 0],
        document_reference: objectPath,
        submitted_by: actor.id,
        submitted_by_email: actor.email ?? null,
        submitted_at: new Date().toISOString(),
        terms_mode: governance?.contract_terms_mode ?? "metadata_only",
        ...commercial.header,
        commercial_terms_state: commercial.state,
        updated_at: new Date().toISOString(),
      },
    ).select().single();
    if (error) throw error;
    agreement = data as Row;
    if (filePayload && objectPath && digest) {
      const { error: documentError } = await service.from(
        "portal_brand_agreement_document",
      ).insert({
        agreement_id: agreementId,
        object_path: objectPath,
        original_name: filePayload.name,
        content_type: filePayload.contentType,
        size_bytes: filePayload.bytes.byteLength,
        sha256: digest,
        scan_state: "clean",
        scan_provider: clean(scan?.engine, 120) || "configured-scanner",
        uploaded_by_type: actor.role === "internal" ? "internal" : "brand",
        uploaded_by: actor.id,
        uploaded_by_email: actor.email ?? null,
      });
      if (documentError) throw documentError;
    }
    if (commercial.feeLines.length) {
      const { error: feeError } = await service.from(
        "portal_brand_agreement_fee_line",
      ).insert(commercial.feeLines.map((line) => ({
        ...line,
        agreement_id: agreementId,
      })));
      if (feeError) throw feeError;
    }
  } catch (error) {
    if (agreement) {
      await service.from("portal_brand_agreement").delete().eq(
        "id",
        agreementId,
      );
    }
    if (objectPath) {
      await service.storage.from("portal-brand-agreements").remove([
        objectPath,
      ]);
    }
    throw error;
  }
  await refreshAgreementState(organizationId);
  await audit(
    actor,
    organizationId,
    "brand_agreement_submitted",
    "brand_agreement",
    agreementId,
    {
      requirementCode,
      reference,
      versionLabel,
      termType,
      hasDocument: hasFile,
      commercialTermsState: commercial.state,
      feeLineCount: commercial.feeLines.length,
    },
  );
  return { agreementId, status: "in_review" };
}

function requireAgreementReviewer(actor: Actor): void {
  if (
    actor.role !== "internal" ||
    !["administrator", "operations"].includes(String(actor.staff_role))
  ) {
    throw new BrandError(
      403,
      "Only Administration or Operations can review and publish agreements.",
    );
  }
}

async function approveAgreementCommercialTerms(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Commercial-term approvals require Administrator access.",
    );
  }
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.agreements.manage");
  const agreementId = uuid(body.agreementId, "agreement");
  const stage = choice(
    body.stage,
    ["finance", "legal"],
    "finance",
    "approval stage",
  );
  const approverName = clean(body.approverName, 200);
  const note = clean(body.note, 3000);
  if (!approverName) {
    throw new BrandError(400, "Record the Finance or Legal approver.");
  }
  const { data: agreement, error } = await service.from(
    "portal_brand_agreement",
  )
    .select("id,reference,status,visibility,commercial_terms_state")
    .eq("id", agreementId).eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  if (!agreement) throw new BrandError(404, "Agreement not found.");
  if (agreement.visibility !== "internal" || agreement.status !== "in_review") {
    throw new BrandError(
      409,
      "Commercial terms can be approved only while the agreement is in review.",
    );
  }
  const now = new Date().toISOString();
  if (stage === "finance") {
    if (agreement.commercial_terms_state !== "pending_finance") {
      throw new BrandError(
        409,
        "These terms are not awaiting Finance approval.",
      );
    }
    const { error: updateError } = await service.from("portal_brand_agreement")
      .update({
        commercial_terms_state: "pending_legal",
        finance_approver: approverName,
        finance_approved_by: actor.id,
        finance_approved_by_email: actor.email ?? null,
        finance_approved_at: now,
        commercial_terms_note: note || null,
        updated_at: now,
      }).eq("id", agreementId).eq("commercial_terms_state", "pending_finance");
    if (updateError) throw updateError;
  } else {
    if (agreement.commercial_terms_state !== "pending_legal") {
      throw new BrandError(
        409,
        "Finance must approve these terms before Legal confirmation.",
      );
    }
    const { error: updateError } = await service.from("portal_brand_agreement")
      .update({
        commercial_terms_state: "approved",
        legal_approver: approverName,
        legal_confirmed_by: actor.id,
        legal_confirmed_by_email: actor.email ?? null,
        legal_confirmed_at: now,
        commercial_terms_note: note || null,
        updated_at: now,
      }).eq("id", agreementId).eq("commercial_terms_state", "pending_legal");
    if (updateError) throw updateError;
    const { error: feeError } = await service.from(
      "portal_brand_agreement_fee_line",
    )
      .update({ status: "active", updated_at: now }).eq(
        "agreement_id",
        agreementId,
      )
      .eq("status", "draft");
    if (feeError) throw feeError;
  }
  await audit(
    actor,
    organizationId,
    `brand_agreement_terms_${stage}_approved`,
    "brand_agreement",
    agreementId,
    { reference: agreement.reference, approverName, note },
  );
  return {
    agreementId,
    commercialTermsState: stage === "finance" ? "pending_legal" : "approved",
  };
}

async function reviewAgreement(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  requireAgreementReviewer(actor);
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.agreements.manage");
  const agreementId = uuid(body.agreementId, "agreement");
  const decision = choice(
    body.decision,
    ["approve", "request_changes"],
    "request_changes",
    "agreement decision",
  );
  const note = clean(body.note, 3000);
  const { data: agreement, error: agreementError } = await service.from(
    "portal_brand_agreement",
  ).select("id,requirement_code,reference,version_label,status,visibility")
    .eq("id", agreementId).eq("organization_id", organizationId).maybeSingle();
  if (agreementError) throw agreementError;
  if (!agreement) throw new BrandError(404, "Agreement not found.");
  if (agreement.status !== "in_review" || agreement.visibility !== "internal") {
    throw new BrandError(
      409,
      "Only an agreement awaiting review can be decided.",
    );
  }
  if (decision === "request_changes") {
    if (!note) {
      throw new BrandError(400, "Explain the changes the Brand must make.");
    }
    const { error } = await service.from("portal_brand_agreement").update({
      status: "changes_requested",
      review_decision: "changes_requested",
      review_note: note,
      brand_response_note: note,
      reviewed_by: actor.id,
      reviewed_by_email: actor.email ?? null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", agreementId).eq("status", "in_review");
    if (error) throw error;
    await refreshAgreementState(organizationId);
    await audit(
      actor,
      organizationId,
      "brand_agreement_changes_requested",
      "brand_agreement",
      agreementId,
      {
        requirementCode: agreement.requirement_code,
        reference: agreement.reference,
        versionLabel: agreement.version_label,
      },
    );
    return { agreementId, status: "changes_requested" };
  }

  const { data: published, error: publishError } = await service.rpc(
    "portal_publish_brand_agreement",
    {
      p_agreement_id: agreementId,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? "",
      p_review_note: note || null,
    },
  );
  if (publishError) throw publishError;
  await refreshAgreementState(organizationId);
  await audit(
    actor,
    organizationId,
    "brand_agreement_published",
    "brand_agreement",
    agreementId,
    {
      requirementCode: agreement.requirement_code,
      reference: agreement.reference,
      versionLabel: agreement.version_label,
      supersedesAgreementId: published?.supersedes_agreement_id ?? null,
    },
  );
  return {
    agreementId,
    status: published?.status ?? "active",
    published: true,
  };
}

async function archiveAgreement(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  requireAgreementReviewer(actor);
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.agreements.manage");
  const agreementId = uuid(body.agreementId, "agreement");
  const note = clean(body.note, 3000);
  if (!note) {
    throw new BrandError(400, "Record why this agreement is being archived.");
  }
  const { data: agreement, error: agreementError } = await service.from(
    "portal_brand_agreement",
  ).select("id,requirement_code,reference,version_label,status,visibility")
    .eq("id", agreementId).eq("organization_id", organizationId).maybeSingle();
  if (agreementError) throw agreementError;
  if (!agreement) throw new BrandError(404, "Agreement not found.");
  if (agreement.visibility !== "published") {
    throw new BrandError(409, "Only a published agreement can be archived.");
  }
  const { error } = await service.from("portal_brand_agreement").update({
    status: agreement.status === "expired" ? "expired" : "terminated",
    visibility: "archived",
    archived_at: new Date().toISOString(),
    archived_by: actor.id,
    review_note: note,
    updated_at: new Date().toISOString(),
  }).eq("id", agreementId).eq("visibility", "published");
  if (error) throw error;
  await service.from("portal_brand_agreement_renewal_notice").update({
    status: "skipped",
    updated_at: new Date().toISOString(),
  }).eq("agreement_id", agreementId).eq("status", "pending");
  await refreshAgreementState(organizationId);
  await audit(
    actor,
    organizationId,
    "brand_agreement_archived",
    "brand_agreement",
    agreementId,
    {
      requirementCode: agreement.requirement_code,
      reference: agreement.reference,
      versionLabel: agreement.version_label,
    },
  );
  return { agreementId, status: "archived" };
}

async function agreementDownload(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.agreements.read");
  const agreementId = uuid(body.agreementId, "agreement");
  const { data: agreement, error: agreementError } = await service.from(
    "portal_brand_agreement",
  ).select("id,reference,requirement_code,visibility")
    .eq("id", agreementId).eq("organization_id", organizationId).maybeSingle();
  if (agreementError) throw agreementError;
  if (!agreement) throw new BrandError(404, "Agreement not found.");
  if (
    actor.role !== "internal" &&
    !["published", "archived"].includes(String(agreement.visibility))
  ) {
    const { data: submitted, error: submittedError } = await service.from(
      "portal_brand_agreement_document",
    ).select("uploaded_by_type").eq("agreement_id", agreementId).maybeSingle();
    if (submittedError) throw submittedError;
    if (submitted?.uploaded_by_type !== "brand") {
      throw new BrandError(
        403,
        "This agreement is not published to the Brand.",
      );
    }
  }
  const { data: document, error: documentError } = await service.from(
    "portal_brand_agreement_document",
  ).select("object_path,original_name").eq("agreement_id", agreementId)
    .maybeSingle();
  if (documentError) throw documentError;
  if (!document) throw new BrandError(404, "Agreement PDF not found.");
  const { data: signed, error: signedError } = await service.storage.from(
    "portal-brand-agreements",
  ).createSignedUrl(document.object_path, 300, {
    download: document.original_name,
  });
  if (signedError) throw signedError;
  await audit(
    actor,
    organizationId,
    "brand_agreement_opened",
    "brand_agreement",
    agreementId,
    {
      requirementCode: agreement.requirement_code,
      reference: agreement.reference,
    },
  );
  return {
    agreementId,
    filename: document.original_name,
    signedUrl: signed.signedUrl,
    expiresInSeconds: 300,
  };
}

async function savePurchaseOrder(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.purchase_orders.acknowledge");
  const requestType = clean(body.requestType, 50) || "finished_goods_purchase";
  if (
    !["manufacturing_request", "raw_material_supply", "finished_goods_purchase"]
      .includes(requestType)
  ) {
    throw new BrandError(400, "Choose a valid request type.");
  }
  const lines = Array.isArray(body.lines) ? body.lines as Row[] : [];
  if (!lines.length) {
    throw new BrandError(400, "Add at least one product line.");
  }
  const [{ data: account, error: accountError }, {
    data: organization,
    error: organizationError,
  }] = await Promise.all([
    service.from("portal_brand_account").select("*").eq(
      "organization_id",
      organizationId,
    ).maybeSingle(),
    service.from("portal_organization").select("legal_name").eq(
      "id",
      organizationId,
    ).single(),
  ]);
  if (accountError) throw accountError;
  if (organizationError) throw organizationError;
  const [{ rows: packageRows }, itemRows] = await Promise.all([
    latestCanix((account ?? null) as Row | null),
    latestBrandItems((account ?? null) as Row | null),
  ]);
  const scopedProducts = organization?.legal_name === "Test Brand"
    ? testBrandProducts()
    : await productsFor(itemRows, packageRows);
  const productsByItemId = new Map(
    scopedProducts.map((product) => [String(product.canixItemId), product]),
  );
  const purchaseOrderId = body.purchaseOrderId
    ? uuid(body.purchaseOrderId, "purchase order")
    : crypto.randomUUID();
  const submit = body.submit === true;
  if (body.purchaseOrderId) {
    const { data: existing, error: existingError } = await service.from(
      "portal_brand_purchase_order",
    ).select("id,status").eq("id", purchaseOrderId).eq(
      "organization_id",
      organizationId,
    ).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new BrandError(404, "Purchase order not found.");
    if (existing.status !== "draft") {
      throw new BrandError(
        409,
        "A submitted purchase order is controlled through its review timeline and cannot be overwritten as a draft.",
      );
    }
  }
  const lineRecords = lines.map((line, index) => {
    const quantity = numberOrNull(line.quantity);
    if (!quantity || quantity <= 0) {
      throw new BrandError(400, `Line ${index + 1} needs a positive quantity.`);
    }
    const canixItemId = clean(line.canixItemId, 40);
    const product = productsByItemId.get(canixItemId);
    if (!product) {
      throw new BrandError(
        400,
        `Line ${index + 1} is not a current product for this Brand.`,
      );
    }
    const uomCode = clean(product.uomCode, 20);
    if (!uomCode) {
      throw new BrandError(
        409,
        `Line ${index + 1} needs one item-based unit before it can be ordered.`,
      );
    }
    const suppliedUom = clean(line.uomCode, 20);
    if (suppliedUom && suppliedUom !== uomCode) {
      throw new BrandError(
        409,
        `Line ${
          index + 1
        } no longer matches the unit assigned to the Canix item.`,
      );
    }
    if (uomCode === "UNIT" && !Number.isInteger(quantity)) {
      throw new BrandError(
        400,
        `Line ${index + 1} needs a whole-unit quantity.`,
      );
    }
    if (product.availabilityState === "unavailable") {
      throw new BrandError(
        409,
        `Line ${
          index + 1
        } is unavailable and cannot be added to a purchase order.`,
      );
    }
    const unitPriceCents = numberOrNull(product.unitPriceCents);
    if (!unitPriceCents || unitPriceCents <= 0) {
      throw new BrandError(
        409,
        `Line ${index + 1} does not have an approved wholesale price.`,
      );
    }
    const orderBasis = choice(
      line.orderBasis,
      ["unit", "case"],
      "unit",
      `line ${index + 1} order basis`,
    );
    const caseQuantity = numberOrNull(product.caseSize);
    if (orderBasis === "case") {
      if (uomCode !== "UNIT" || !caseQuantity || caseQuantity <= 0) {
        throw new BrandError(
          409,
          `Line ${index + 1} does not have one approved units-per-case value.`,
        );
      }
      if (!Number.isInteger(quantity)) {
        throw new BrandError(
          400,
          `Line ${index + 1} needs a whole-case quantity.`,
        );
      }
    }
    const orderedUnits = orderBasis === "case"
      ? quantity * Number(caseQuantity)
      : quantity;
    const casePriceCents = orderBasis === "case"
      ? numberOrNull(product.casePriceCents) ||
        Math.round(unitPriceCents * Number(caseQuantity))
      : numberOrNull(product.casePriceCents);
    const lineTotalCents = orderBasis === "case"
      ? Math.round(quantity * Number(casePriceCents))
      : Math.round(quantity * unitPriceCents);
    return {
      purchase_order_id: purchaseOrderId,
      line_number: index + 1,
      canix_item_id: numberOrNull(product.canixItemId),
      product_name: clean(product.productName, 300),
      sku: clean(product.sku, 120) || null,
      requested_quantity: orderedUnits,
      uom_code: uomCode,
      order_basis: orderBasis,
      ordered_units: orderedUnits,
      case_quantity: caseQuantity,
      unit_price_cents: Math.round(unitPriceCents),
      case_price_cents: casePriceCents == null
        ? null
        : Math.round(casePriceCents),
      line_total_cents: lineTotalCents,
    };
  });
  const subtotalCents = lineRecords.reduce(
    (total, line) => total + Number(line.line_total_cents || 0),
    0,
  );
  const shippingDestination = clean(body.shippingDestination, 1000);
  if (submit && shippingDestination.length < 4) {
    throw new BrandError(
      400,
      "Add the shipping destination before submitting.",
    );
  }
  const neededBy = today(body.neededBy);
  if (submit && !neededBy) {
    throw new BrandError(400, "Add the needed-by date before submitting.");
  }
  const record = {
    id: purchaseOrderId,
    organization_id: organizationId,
    request_type: requestType,
    status: submit ? "submitted" : "draft",
    requested_on: today(body.requestedOn) ??
      new Date().toISOString().slice(0, 10),
    needed_by: neededBy,
    shipping_destination: shippingDestination || null,
    customer_reference: clean(body.customerReference, 200) || null,
    notes: clean(body.notes, 4000) || null,
    currency: "USD",
    total_amount: subtotalCents / 100,
    subtotal_cents: subtotalCents,
    handoff_state: submit ? "portal_native" : "not_ready",
    priority: choice(body.priority, ["P0", "P1", "P2", "P3"], "P0", "priority"),
    assigned_department: "Administrator",
    due_at: today(body.neededBy) ? `${today(body.neededBy)}T23:59:59Z` : null,
    created_by: actor.id,
    created_by_email: actor.email ?? null,
    submitted_at: submit ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { data: order, error } = await service.from(
    "portal_brand_purchase_order",
  ).upsert(record).select().single();
  if (error) throw error;
  await service.from("portal_brand_purchase_order_line").delete().eq(
    "purchase_order_id",
    purchaseOrderId,
  );
  const { data: savedLines, error: lineError } = await service.from(
    "portal_brand_purchase_order_line",
  ).insert(lineRecords).select();
  if (lineError) throw lineError;
  await audit(
    actor,
    organizationId,
    submit ? "brand_purchase_order_submitted" : "brand_purchase_order_saved",
    "brand_purchase_order",
    purchaseOrderId,
    {
      requestType,
      lineCount: lineRecords.length,
      subtotalCents,
      handoffState: record.handoff_state,
    },
  );
  const notifications = submit
    ? await notificationResult(() =>
      notifyPurchaseOrderSubmitted(actor, organizationId, order as Row)
    )
    : null;
  return {
    purchaseOrder: {
      ...order,
      portal_brand_purchase_order_line: savedLines ?? lineRecords,
    },
    notifications,
  };
}

async function transitionPurchaseOrder(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.purchase_orders.read");
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Purchase-order decisions currently require Administrator access.",
    );
  }
  const purchaseOrderId = uuid(body.purchaseOrderId, "purchase order");
  const targetStatus = choice(
    body.status,
    [
      "under_review",
      "approved",
      "scheduled",
      "in_production",
      "quality_review",
      "ready_to_ship",
      "shipped",
      "delivered",
      "completed",
      "on_hold",
      "rejected",
      "cancelled",
      "exception",
    ],
    "",
    "purchase-order status",
  );
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new BrandError(400, "Refresh the purchase order before updating it.");
  }
  const note = clean(body.note, 2000);
  if (
    ["on_hold", "rejected", "cancelled", "exception"].includes(targetStatus) &&
    note.length < 8
  ) {
    throw new BrandError(400, "Record the reason for this status.");
  }
  const { data: current, error: currentError } = await service.from(
    "portal_brand_purchase_order",
  ).select("id,reference,status,revision,created_by").eq("id", purchaseOrderId)
    .eq(
      "organization_id",
      organizationId,
    ).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new BrandError(404, "Purchase order not found.");
  if (Number(current.revision) !== expectedRevision) {
    throw new BrandError(
      409,
      "This purchase order changed since it was opened. Refresh before updating it.",
    );
  }
  const normalTransitions: Record<string, string[]> = {
    submitted: ["under_review", "approved", "on_hold", "rejected", "cancelled"],
    under_review: ["approved", "on_hold", "rejected", "cancelled"],
    approved: ["scheduled", "on_hold", "cancelled"],
    acknowledged: ["scheduled", "on_hold", "cancelled"],
    scheduled: ["in_production", "on_hold", "cancelled"],
    in_production: ["quality_review", "ready_to_ship", "on_hold", "exception"],
    quality_review: ["in_production", "ready_to_ship", "on_hold", "exception"],
    ready_to_ship: ["shipped", "on_hold", "exception"],
    shipped: ["delivered", "exception"],
    delivered: ["completed", "exception"],
    on_hold: [
      "under_review",
      "approved",
      "scheduled",
      "in_production",
      "cancelled",
    ],
    exception: ["under_review", "in_production", "ready_to_ship", "cancelled"],
  };
  if (
    !(normalTransitions[String(current.status)] ?? []).includes(targetStatus)
  ) {
    throw new BrandError(
      409,
      `A purchase order cannot move from ${
        String(current.status).replace(/_/g, " ")
      } to ${targetStatus.replace(/_/g, " ")}.`,
    );
  }
  const now = new Date().toISOString();
  const { data, error } = await service.from("portal_brand_purchase_order")
    .update({
      status: targetStatus,
      handoff_state: "portal_native",
      revision: expectedRevision + 1,
      approved_at: targetStatus === "approved" ? now : undefined,
      completed_at: targetStatus === "completed" ? now : undefined,
      updated_at: now,
    }).eq("id", purchaseOrderId).eq("organization_id", organizationId)
    .eq("revision", expectedRevision).select(
      "*,portal_brand_purchase_order_line(*)",
    ).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new BrandError(
      409,
      "This purchase order changed since it was opened. Refresh before updating it.",
    );
  }
  const { data: workItem, error: workItemError } = await service.from(
    "portal_work_item",
  ).select("id").eq("workflow_key", "brand_purchase_orders")
    .eq("target_type", "brand_purchase_order")
    .eq("target_id", purchaseOrderId).maybeSingle();
  if (workItemError) throw workItemError;
  if (workItem && note) {
    const { error: commentError } = await service.from(
      "portal_work_item_comment",
    ).insert({
      work_item_id: workItem.id,
      body: note,
      visibility: body.brandVisible === false ? "internal" : "brand",
      created_by: actor.id,
      created_by_email: actor.email ?? null,
    });
    if (commentError) throw commentError;
  }
  await audit(
    actor,
    organizationId,
    "brand_purchase_order_status_changed",
    "brand_purchase_order",
    purchaseOrderId,
    {
      reference: current.reference,
      fromStatus: current.status,
      toStatus: targetStatus,
      note: note || null,
      source: "Portal",
    },
  );
  const notifications = await notificationResult(() =>
    notifyPurchaseOrderStatus(
      organizationId,
      data as Row,
      clean(current.created_by, 80) || null,
    )
  );
  return { purchaseOrder: data, notifications };
}

async function recordPurchaseOrderFulfillment(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  await brandAccess(actor, organizationId);
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Fulfillment and receiving records require Administrator access.",
    );
  }
  const purchaseOrderId = uuid(body.purchaseOrderId, "purchase order");
  const lineId = Number(body.purchaseOrderLineId);
  if (!Number.isInteger(lineId) || lineId < 1) {
    throw new BrandError(400, "Choose a purchase-order line.");
  }
  const eventType = choice(
    body.eventType,
    ["shipped", "received", "damaged", "rejected", "refused"],
    "",
    "fulfillment event",
  );
  const quantity = numberOrNull(body.quantity);
  if (!quantity || quantity <= 0) {
    throw new BrandError(400, "Enter a positive fulfillment quantity.");
  }
  const shipmentReference = clean(body.shipmentReference, 200);
  if (!shipmentReference) {
    throw new BrandError(400, "Enter a shipment reference.");
  }
  const note = clean(body.note, 2000);
  if (
    ["damaged", "rejected", "refused"].includes(eventType) && note.length < 8
  ) {
    throw new BrandError(400, "Record the reason for this exception.");
  }
  const receiverName = clean(body.receiverName, 200);
  if (eventType === "received" && !receiverName) {
    throw new BrandError(400, "Record who received the shipment.");
  }
  const { data: line, error: lineError } = await service.from(
    "portal_brand_purchase_order_line",
  ).select(
    "id,purchase_order_id,product_name,uom_code,portal_brand_purchase_order!inner(id,organization_id,reference,status)",
  ).eq("id", lineId).eq("purchase_order_id", purchaseOrderId).maybeSingle();
  if (lineError) throw lineError;
  const purchaseOrderRelation = line?.portal_brand_purchase_order;
  const purchaseOrder =
    (Array.isArray(purchaseOrderRelation)
      ? purchaseOrderRelation[0]
      : purchaseOrderRelation) as Row | null;
  if (
    !line || !purchaseOrder || purchaseOrder.organization_id !== organizationId
  ) {
    throw new BrandError(404, "Purchase-order line not found.");
  }
  const allowedStates = eventType === "shipped"
    ? ["ready_to_ship", "shipped"]
    : ["shipped", "delivered", "completed"];
  if (!allowedStates.includes(String(purchaseOrder.status))) {
    throw new BrandError(
      409,
      eventType === "shipped"
        ? "Move the purchase order to Ready to ship before recording a shipment."
        : "Record the shipment before receiving or recording delivery exceptions.",
    );
  }
  const occurredOn = today(body.occurredOn) ||
    new Date().toISOString().slice(0, 10);
  const { data, error } = await service.from(
    "portal_brand_purchase_order_fulfillment_event",
  ).insert({
    organization_id: organizationId,
    purchase_order_id: purchaseOrderId,
    purchase_order_line_id: lineId,
    event_type: eventType,
    quantity,
    shipment_reference: shipmentReference,
    carrier: clean(body.carrier, 200) || null,
    tracking_number: clean(body.trackingNumber, 300) || null,
    manifest_reference: clean(body.manifestReference, 1000) || null,
    proof_of_delivery_reference: clean(body.proofOfDeliveryReference, 1000) ||
      null,
    receiver_name: receiverName || null,
    note: note || null,
    occurred_on: occurredOn,
    brand_visible: body.brandVisible !== false,
    recorded_by: actor.id,
    recorded_by_email: actor.email ?? null,
  }).select().single();
  if (error) throw error;
  await audit(
    actor,
    organizationId,
    `brand_purchase_order_${eventType}`,
    "brand_purchase_order",
    purchaseOrderId,
    {
      reference: purchaseOrder.reference,
      lineId,
      productName: line.product_name,
      quantity,
      uomCode: line.uom_code,
      shipmentReference,
      occurredOn,
    },
  );
  return { fulfillmentEvent: data };
}

async function addPurchaseOrderComment(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.purchase_orders.read");
  const purchaseOrderId = uuid(body.purchaseOrderId, "purchase order");
  const comment = clean(body.comment, 4000);
  if (!comment) throw new BrandError(400, "Enter a comment before saving.");
  const { data: workItem, error } = await service.from("portal_work_item")
    .select("id").eq("workflow_key", "brand_purchase_orders")
    .eq("target_type", "brand_purchase_order")
    .eq("target_id", purchaseOrderId).eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!workItem) {
    throw new BrandError(
      409,
      "Submit the draft before adding timeline comments.",
    );
  }
  const { data, error: commentError } = await service.from(
    "portal_work_item_comment",
  ).insert({
    work_item_id: workItem.id,
    body: comment,
    visibility: actor.role === "brand"
      ? "brand"
      : body.brandVisible === false
      ? "internal"
      : "brand",
    created_by: actor.id,
    created_by_email: actor.email ?? null,
  }).select().single();
  if (commentError) throw commentError;
  await audit(
    actor,
    organizationId,
    "brand_purchase_order_comment_added",
    "brand_purchase_order",
    purchaseOrderId,
    { visibility: data.visibility },
  );
  return { comment: data };
}

async function saveManufacturing(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.manufacturing.contribute");
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Brand manufacturing decisions currently require Administrator access.",
    );
  }
  const status = choice(
    body.status,
    [
      "planned",
      "submitted",
      "approved",
      "scheduled",
      "in_production",
      "quality_hold",
      "quality_review",
      "complete",
      "shipped",
      "closed",
      "on_hold",
      "cancelled",
      "exception",
    ],
    "planned",
    "manufacturing status",
  );
  const reference = clean(body.reference, 120);
  const productName = clean(body.productName, 300);
  if (!reference || !productName) {
    throw new BrandError(400, "Reference and product name are required.");
  }
  const plannedOn = today(body.plannedOn);
  const startedOn = today(body.startedOn);
  const completedOn = today(body.completedOn);
  const exceptionOwner = clean(body.exceptionOwner, 200) || null;
  const exceptionNote = clean(body.exceptionNote, 2000) || null;
  if (status === "scheduled" && !plannedOn) {
    throw new BrandError(400, "A scheduled milestone needs a planned date.");
  }
  if (
    ["in_production", "quality_hold", "quality_review"].includes(status) &&
    !startedOn
  ) {
    throw new BrandError(
      400,
      "This manufacturing status needs a started date.",
    );
  }
  if (["complete", "shipped", "closed"].includes(status) && !completedOn) {
    throw new BrandError(
      400,
      "This manufacturing status needs a completed date.",
    );
  }
  if (
    ["quality_hold", "on_hold", "exception"].includes(status) &&
    (!exceptionOwner || !exceptionNote || exceptionNote.length < 8)
  ) {
    throw new BrandError(
      400,
      "A hold or exception needs an owner and a reason of at least eight characters.",
    );
  }
  const manufacturingId = body.manufacturingId
    ? uuid(body.manufacturingId, "manufacturing milestone")
    : crypto.randomUUID();
  let current: Row | null = null;
  if (body.manufacturingId) {
    const { data, error } = await service.from(
      "portal_brand_manufacturing_projection",
    ).select("id,status,revision,source_mode").eq("id", manufacturingId).eq(
      "organization_id",
      organizationId,
    ).maybeSingle();
    if (error) throw error;
    if (!data) throw new BrandError(404, "Manufacturing milestone not found.");
    if (data.source_mode !== "portal") {
      throw new BrandError(409, "Historical Monday milestones are read-only.");
    }
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new BrandError(400, "Refresh the milestone before updating it.");
    }
    if (Number(data.revision) !== expectedRevision) {
      throw new BrandError(
        409,
        "This milestone changed since it was opened. Refresh before updating it.",
      );
    }
    const transitions: Record<string, string[]> = {
      planned: ["submitted", "cancelled", "on_hold"],
      submitted: ["approved", "cancelled", "on_hold"],
      approved: ["scheduled", "cancelled", "on_hold"],
      scheduled: ["in_production", "cancelled", "on_hold"],
      in_production: [
        "quality_hold",
        "quality_review",
        "complete",
        "on_hold",
        "exception",
      ],
      quality_hold: ["in_production", "quality_review", "cancelled"],
      quality_review: [
        "in_production",
        "complete",
        "quality_hold",
        "exception",
      ],
      complete: ["shipped", "closed", "exception"],
      shipped: ["closed", "exception"],
      on_hold: [
        "submitted",
        "approved",
        "scheduled",
        "in_production",
        "cancelled",
      ],
      exception: ["in_production", "quality_review", "cancelled", "closed"],
    };
    if (
      status !== data.status &&
      !(transitions[String(data.status)] ?? []).includes(status)
    ) {
      throw new BrandError(
        409,
        `A milestone cannot move from ${
          String(data.status).replace(/_/g, " ")
        } to ${status.replace(/_/g, " ")}.`,
      );
    }
    current = data as Row;
  }
  const record = {
    id: manufacturingId,
    organization_id: organizationId,
    purchase_order_id: body.purchaseOrderId
      ? uuid(body.purchaseOrderId, "purchase order")
      : null,
    monday_item_id: null,
    reference,
    product_name: productName,
    status,
    planned_on: plannedOn,
    started_on: startedOn,
    completed_on: completedOn,
    exception_owner: exceptionOwner,
    exception_note: exceptionNote,
    source_mode: "portal",
    priority: choice(body.priority, ["P0", "P1", "P2", "P3"], "P1", "priority"),
    assigned_department: "Administrator",
    assigned_user: body.assignedUser
      ? uuid(body.assignedUser, "assignee")
      : null,
    due_at: plannedOn ? `${plannedOn}T23:59:59Z` : null,
    created_by: current ? undefined : actor.id,
    updated_by: actor.id,
    source_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const query = current
    ? service.from("portal_brand_manufacturing_projection").update(record).eq(
      "id",
      manufacturingId,
    ).eq("revision", Number(current.revision))
    : service.from("portal_brand_manufacturing_projection").insert(record);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new BrandError(
      409,
      "This milestone changed since it was opened. Refresh before updating it.",
    );
  }
  await audit(
    actor,
    organizationId,
    current ? "brand_manufacturing_updated" : "brand_manufacturing_created",
    "brand_manufacturing",
    data.id,
    { reference, status, source: "Portal" },
  );
  return { manufacturing: data };
}

async function saveDistributionMilestone(
  actor: Actor,
  organizationId: string,
  body: Row,
): Promise<Row> {
  const permissions = await brandAccess(actor, organizationId);
  requirePermission(permissions, "brand.manufacturing.contribute");
  if (actor.role !== "internal" || actor.staff_role !== "administrator") {
    throw new BrandError(
      403,
      "Distribution decisions currently require Administrator access.",
    );
  }
  const status = choice(
    body.status,
    [
      "draft",
      "ordered",
      "approved",
      "production",
      "preparing_for_shipment",
      "shipped",
      "delivered",
      "completed",
      "on_hold",
      "delayed",
      "partially_shipped",
      "action_required",
      "rejected",
      "cancelled",
    ],
    "ordered",
    "distribution milestone",
  );
  const sourceSystem = choice(
    body.sourceSystem,
    ["Portal", "Carrier"],
    "Portal",
    "milestone source",
  );
  const purchaseOrderId = body.purchaseOrderId
    ? uuid(body.purchaseOrderId, "purchase order")
    : null;
  if (purchaseOrderId) {
    const { data: purchaseOrder, error } = await service.from(
      "portal_brand_purchase_order",
    ).select("id").eq("id", purchaseOrderId).eq(
      "organization_id",
      organizationId,
    ).maybeSingle();
    if (error) throw error;
    if (!purchaseOrder) {
      throw new BrandError(404, "The Brand purchase order was not found.");
    }
  }
  const evidenceReference = clean(body.evidenceReference, 1000) || null;
  if (
    status === "delivered" && sourceSystem === "Carrier" && !evidenceReference
  ) {
    throw new BrandError(
      400,
      "Carrier delivery confirmation requires an evidence reference.",
    );
  }
  if (
    [
      "production",
      "preparing_for_shipment",
      "shipped",
      "delivered",
      "completed",
    ]
      .includes(status) && !["Portal", "Carrier"].includes(sourceSystem)
  ) {
    throw new BrandError(
      400,
      "Operational shipment milestones must come from the Portal or an approved carrier confirmation.",
    );
  }
  const { data, error } = await service.from(
    "portal_brand_distribution_milestone",
  ).insert({
    organization_id: organizationId,
    purchase_order_id: purchaseOrderId,
    status,
    source_system: sourceSystem,
    brand_visible: body.brandVisible !== false,
    external_note: clean(body.externalNote, 2000) || null,
    evidence_reference: evidenceReference,
    occurred_at: clean(body.occurredAt, 40) || new Date().toISOString(),
    recorded_by: actor.id,
  }).select().single();
  if (error) throw error;
  if (purchaseOrderId) {
    const purchaseOrderStatus: Record<string, string> = {
      ordered: "submitted",
      approved: "acknowledged",
      production: "in_production",
      preparing_for_shipment: "in_production",
      shipped: "in_production",
      delivered: "complete",
      completed: "complete",
      cancelled: "cancelled",
      rejected: "exception",
      delayed: "exception",
      action_required: "exception",
    };
    if (purchaseOrderStatus[status]) {
      await service.from("portal_brand_purchase_order").update({
        status: purchaseOrderStatus[status],
        updated_at: new Date().toISOString(),
      }).eq("id", purchaseOrderId).eq("organization_id", organizationId);
    }
  }
  await audit(
    actor,
    organizationId,
    "brand_distribution_milestone_recorded",
    "distribution_milestone",
    data.id,
    { purchaseOrderId, status, sourceSystem, evidenceReference },
  );
  return { milestone: data };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const actor = await actorFor(request);
    const body = await request.json() as Row;
    const action = clean(body.action, 80) || "overview";
    if (action === "admin-list") return json(request, await adminList(actor));
    if (action === "admin-purchase-orders") {
      return json(request, await adminPurchaseOrders(actor));
    }
    const organizationId = uuid(body.organizationId, "Brand organization");
    if (action === "overview") {
      return json(request, await overview(actor, organizationId));
    }
    if (action === "save-profile") {
      return json(request, await saveProfile(actor, organizationId, body));
    }
    if (action === "save-mapping") {
      return json(request, await saveMapping(actor, organizationId, body));
    }
    if (action === "save-policy") {
      return json(request, await savePolicy(actor, organizationId, body));
    }
    if (action === "submit-agreement") {
      return json(request, await submitAgreement(actor, organizationId, body));
    }
    if (action === "approve-agreement-commercial-terms") {
      return json(
        request,
        await approveAgreementCommercialTerms(actor, organizationId, body),
      );
    }
    if (action === "review-agreement") {
      return json(request, await reviewAgreement(actor, organizationId, body));
    }
    if (action === "archive-agreement") {
      return json(request, await archiveAgreement(actor, organizationId, body));
    }
    if (action === "agreement-download") {
      return json(
        request,
        await agreementDownload(actor, organizationId, body),
      );
    }
    if (action === "save-purchase-order") {
      return json(
        request,
        await savePurchaseOrder(actor, organizationId, body),
      );
    }
    if (action === "transition-purchase-order") {
      return json(
        request,
        await transitionPurchaseOrder(actor, organizationId, body),
      );
    }
    if (action === "record-purchase-order-fulfillment") {
      return json(
        request,
        await recordPurchaseOrderFulfillment(actor, organizationId, body),
      );
    }
    if (action === "add-purchase-order-comment") {
      return json(
        request,
        await addPurchaseOrderComment(actor, organizationId, body),
      );
    }
    if (action === "save-manufacturing") {
      return json(
        request,
        await saveManufacturing(actor, organizationId, body),
      );
    }
    if (action === "save-distribution") {
      return json(
        request,
        await saveDistributionMilestone(actor, organizationId, body),
      );
    }
    throw new BrandError(400, "Unsupported Brand operation.");
  } catch (error) {
    if (!(error instanceof BrandError)) {
      console.error("portal-brand-operations", error);
    }
    return json(request, {
      error: error instanceof BrandError
        ? error.message
        : "Brand operations are temporarily unavailable.",
    }, error instanceof BrandError ? error.status : 500);
  }
});
