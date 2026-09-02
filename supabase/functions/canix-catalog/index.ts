import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  approvedHttpsUrl,
  labFailed,
  labPassed,
} from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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
    "access-control-allow-methods": "GET, OPTIONS",
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

async function authenticate(request: Request): Promise<Row | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json();
  const { data: profile } = await service.from("portal_profile").select(
    "id,role,active,org,locations",
  ).eq("id", user.id).maybeSingle();
  return profile && profile.active !== false ? profile as Row : null;
}

function httpsUrl(value: unknown): string | null {
  return approvedHttpsUrl(value, ASSET_HOSTS);
}

function arrayOfRows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object") as Row[]
    : [];
}

function objectOrEmpty(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

async function currentRows(
  runId: string,
  includeAllocated: boolean,
): Promise<Row[]> {
  const rows: Row[] = [];
  const fields =
    "package_id,tag,item_id,item_name,sku,item_category_name,item_sub_category_name,product_id,product_name,brand_name,strain_name,strain_type,quantity_type,status_category,weight,c_reserved_weight,reservation_state,orderable_units,case_quantity,case_quantity_unit,lab_test_status,test_result_status,has_coa,packaged_date,facility_name,room_name,source_package_ids,source_updated_at";
  for (let start = 0;; start += 1000) {
    let query = service.from("canix_package_current").select(fields).eq(
      "sync_run_id",
      runId,
    ).eq("quantity_type", "CountBased");
    query = includeAllocated
      ? query.in("status_category", ["available", "allocated"])
      : query.eq("status_category", "available");
    const { data, error } = await query.order("source_updated_at", {
      ascending: false,
      nullsFirst: false,
    }).range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function orderableUnits(row: Row): number {
  const explicit = Number(row.orderable_units);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  const fallback = Number(row.weight);
  return row.status_category === "available" && Number.isFinite(fallback)
    ? Math.max(0, fallback)
    : 0;
}

async function publishedContent(itemIds: number[]): Promise<Map<number, Row>> {
  if (!itemIds.length) return new Map();
  const { data, error } = await service.from("portal_product_content").select(
    "*",
  )
    .eq("publication_state", "published").in("canix_item_id", itemIds);
  if (error) throw error;
  return new Map(
    (data ?? []).map((
      row,
    ) => [Number(row.canix_item_id), row as unknown as Row]),
  );
}

async function currentCoas(packageIds: number[]): Promise<Map<number, Row>> {
  if (!packageIds.length) return new Map();
  const records: Row[] = [];
  for (let start = 0; start < packageIds.length; start += 500) {
    const { data, error } = await service.from("canix_package_coa").select("*")
      .in("package_id", packageIds.slice(start, start + 500));
    if (error) throw error;
    records.push(...(data ?? []) as unknown as Row[]);
  }
  return new Map(records.map((row) => [Number(row.package_id), row]));
}

async function activeAssetUrls(
  assetIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(
    new Set(assetIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id))),
  );
  if (!uniqueIds.length) return new Map();
  const assets: Row[] = [];
  for (let start = 0; start < uniqueIds.length; start += 500) {
    const { data, error } = await service.from("portal_asset").select(
      "id,storage_path",
    ).eq("state", "active").in("id", uniqueIds.slice(start, start + 500));
    if (error) throw error;
    assets.push(...(data ?? []) as unknown as Row[]);
  }
  if (!assets.length) return new Map();
  const paths = assets.map((asset) => String(asset.storage_path));
  const { data: signed, error: signError } = await service.storage.from(
    "portal-assets",
  ).createSignedUrls(paths, 300);
  if (signError) throw signError;
  const byPath = new Map(
    (signed ?? []).map((entry) => [entry.path, httpsUrl(entry.signedUrl)]),
  );
  return new Map(
    assets.flatMap((asset) => {
      const url = byPath.get(String(asset.storage_path));
      return url ? [[String(asset.id), url] as [string, string]] : [];
    }),
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "GET") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const profile = await authenticate(request);
    if (!profile) return json(request, { error: "Forbidden" }, 403);
    const { data: state, error: stateError } = await service.from(
      "canix_sync_state",
    ).select("last_successful_run_id,last_successful_at").eq("id", 1).single();
    if (stateError || !state?.last_successful_run_id) {
      return json(request, {
        error: "No successful Canix snapshot is available",
      }, 503);
    }
    const internal = profile.role === "internal";
    const rows = await currentRows(
      String(state.last_successful_run_id),
      internal,
    );
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      if (labFailed(row)) continue;
      const key = String(row.item_id ?? "");
      // item_id is the approved v1 grouping key. Live reporting showed that
      // product_id is absent on most active packages, while item_id preserves
      // SKU/format identity and avoids unsafe name-based merging.
      if (!/^\d+$/.test(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    const itemIds = Array.from(
      new Set(
        rows.map((row) => Number(row.item_id)).filter((id) =>
          Number.isSafeInteger(id) && id > 0
        ),
      ),
    );
    const packageIds = rows.map((row) => Number(row.package_id)).filter((id) =>
      Number.isSafeInteger(id) && id > 0
    );
    const [contentByItem, coaByPackage] = await Promise.all([
      publishedContent(itemIds),
      currentCoas(packageIds),
    ]);
    const assetUrls = await activeAssetUrls([
      ...Array.from(contentByItem.values()).map((row) =>
        String(row.image_asset_id ?? "")
      ),
      ...Array.from(coaByPackage.values()).map((row) =>
        String(row.portal_asset_id ?? "")
      ),
    ]);
    const products = Array.from(groups.entries()).map(([key, packages]) => {
      const first = packages[0];
      const availablePackages = packages.filter((row) =>
        row.status_category === "available" && orderableUnits(row) > 0
      );
      const availableUnits = availablePackages.reduce(
        (sum, row) => sum + orderableUnits(row),
        0,
      );
      const releasedUnits = availablePackages.filter(labPassed)
        .reduce((sum, row) => sum + orderableUnits(row), 0);
      const releaseVerified = releasedUnits > 0;
      const mixedRelease = releasedUnits > 0 && releasedUnits < availableUnits;
      const orderMode = !availablePackages.length
        ? "unavailable"
        : releaseVerified
        ? "standard"
        : "preorder";
      const content = contentByItem.get(Number(first.item_id)) ?? {};
      const caseQuantities = Array.from(
        new Set(
          packages.map((row) => Number(row.case_quantity))
            .filter((value) => Number.isSafeInteger(value) && value > 0),
        ),
      );
      const caseQuantity = caseQuantities.length === 1
        ? caseQuantities[0]
        : null;
      const caseUnits = Array.from(
        new Set(
          packages.map((row) => String(row.case_quantity_unit || "").trim())
            .filter(Boolean),
        ),
      );
      const lots = packages.slice(0, 24).map((row) => {
        const coa = coaByPackage.get(Number(row.package_id)) ?? {};
        const documentUrl = assetUrls.get(String(coa.portal_asset_id ?? "")) ??
          httpsUrl(coa.document_url);
        const lot: Row = {
          tag: row.tag || String(row.package_id || ""),
          packageId: row.package_id,
          packaged: row.packaged_date || "Not recorded",
          facility: row.facility_name || "Not recorded",
          room: row.room_name || "Not recorded",
          lab: coa.result_status || row.test_result_status ||
            row.lab_test_status || "No structured result",
          hasCoa: Boolean(documentUrl) || row.has_coa === true ||
            row.has_coa === 1,
          releaseVerified: labPassed(row),
          coa: {
            documentUrl,
            version: Number(coa.version) || null,
            sourceDocumentId: coa.source_document_id || null,
            labName: coa.lab_name || null,
            batchNumber: coa.batch_number || null,
            testedAt: coa.tested_at || null,
            cannabinoids: arrayOfRows(coa.cannabinoids),
            terpenes: arrayOfRows(coa.terpenes),
            profile: objectOrEmpty(coa.profile),
            sourceUpdatedAt: coa.source_updated_at || null,
          },
        };
        if (internal) {
          lot.availability = row.status_category;
          lot.orderableUnits = orderableUnits(row);
          lot.reservedQuantity = row.c_reserved_weight ?? null;
          lot.reservationState = row.reservation_state || "unknown";
          lot.sourcePackageIds = Array.isArray(row.source_package_ids)
            ? row.source_package_ids
            : [];
        }
        return lot;
      });
      const contentProjection = {
        shortDescription: content.short_description || null,
        longDescription: content.long_description || null,
        sellingPoints: Array.isArray(content.selling_points)
          ? content.selling_points
          : [],
        ingredients: content.ingredients || null,
        usageInformation: content.usage_information || null,
        productProfile: content.product_profile || null,
        imageUrl: assetUrls.get(String(content.image_asset_id ?? "")) ??
          httpsUrl(content.image_url),
        keywords: Array.isArray(content.keywords) ? content.keywords : [],
        source: Object.keys(content).length ? "Monday" : null,
        sourceUpdatedAt: content.source_updated_at || null,
      };
      const searchText = [
        contentProjection.shortDescription,
        contentProjection.longDescription,
        contentProjection.productProfile,
        contentProjection.ingredients,
        contentProjection.usageInformation,
        ...contentProjection.sellingPoints,
        ...contentProjection.keywords,
        ...lots.flatMap((lot) => {
          const coa = objectOrEmpty(lot.coa);
          return [
            ...arrayOfRows(coa.cannabinoids),
            ...arrayOfRows(coa.terpenes),
          ]
            .flatMap((entry) => [entry.name, entry.value, entry.unit]);
        }),
      ].filter(Boolean).join(" ");
      return {
        id: `canix-item-${key}`,
        sourceId: `canix:item:${key}`,
        name: first.product_name || first.item_name || "Unnamed Canix item",
        brand: first.brand_name || "Not recorded",
        category: first.item_category_name || "Other",
        subCategory: first.item_sub_category_name || null,
        format: first.item_sub_category_name || first.item_category_name ||
          "Available finished good",
        sku: first.sku || null,
        strain:
          [first.strain_name, first.strain_type].filter(Boolean).join(" · ") ||
          null,
        releaseVerified,
        mixedRelease,
        orderMode,
        releaseLabel: mixedRelease
          ? "Released inventory available · remainder is pre-order"
          : orderMode === "standard"
          ? "Released"
          : orderMode === "preorder"
          ? "Awaiting passing lab result"
          : "Allocated · unavailable to order",
        orderConstraints: {
          caseQuantity,
          caseQuantityUnit: caseUnits.length === 1 ? caseUnits[0] : null,
          caseEnforcementAvailable: caseQuantity !== null,
          minimumOrder: null,
          leadTimeDays: null,
        },
        content: contentProjection,
        searchText,
        lots,
      };
    }).sort((left, right) =>
      String(left.name).localeCompare(String(right.name))
    );
    return json(request, {
      source: "Canix",
      refreshedAt: state.last_successful_at,
      groupingPolicy: "canix_item_id_v1",
      availabilityPolicy:
        "active available count-based packages; explicit reservations subtracted; allocated packages are internal-only and unavailable",
      privacy: { exactQuantity: false, cost: false, allocatedLots: internal },
      products,
    });
  } catch (error) {
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected catalog error",
    }, 502);
  }
});
