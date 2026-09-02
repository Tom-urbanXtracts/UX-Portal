import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { approvedHttpsUrl } from "../_shared/security-contract.ts";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const CANIX_API_KEY = Deno.env.get("CANIX_API_KEY") ?? "";
const CANIX_CRON_SECRET = Deno.env.get("CANIX_CRON_SECRET") ?? "";
const CANIX_API_BASE = "https://api.canix.com/api/v1";
const PAGE_SIZE = 2000;
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
const UOM_CODES = new Set(["G_IN", "G_OUT", "G_DRY", "G_WET"]);
const QUANTITY_TYPES = new Set(["WeightBased", "CountBased"]);
const STATUS_CATEGORIES = new Set(["available", "in_progress", "allocated"]);

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STORED_PACKAGE_COLUMNS = [
  "package_id",
  "tag",
  "item_id",
  "item_name",
  "sku",
  "item_category_name",
  "item_sub_category_name",
  "product_id",
  "product_name",
  "brand_id",
  "brand_name",
  "owner_id",
  "owner_name",
  "canix_package_owner_id",
  "canix_package_owner_name",
  "strain_name",
  "strain_type",
  "quantity_type",
  "weight",
  "weight_unit_name",
  "c_weight_g",
  "c_reserved_weight",
  "reservation_state",
  "reservation_source_field",
  "orderable_units",
  "case_quantity",
  "case_quantity_unit",
  "uom_code",
  "lot_id",
  "production_batch_number",
  "facility_id",
  "facility_name",
  "facility_license",
  "room_id",
  "room_name",
  "status",
  "status_category",
  "compliance_submitted",
  "lab_test_status",
  "test_result_status",
  "has_coa",
  "marked_available",
  "coa_url",
  "coa_document_id",
  "lab_name",
  "lab_tested_at",
  "lab_batch_number",
  "cannabinoids",
  "terpenes",
  "lab_profile",
  "source_package_ids",
  "is_finished_good",
  "packaged_date",
  "expiration_date",
  "use_by_date",
  "age_days",
  "order_item_id",
  "cost_object_id",
  "sales_order_id",
  "sales_order_name",
  "sales_order_status",
  "sales_order_delivery_date",
  "source_updated_at",
] as const;

const PACKAGE_COLUMNS = [
  ...STORED_PACKAGE_COLUMNS,
  "inventory_bucket",
  "inventory_bucket_reason",
  "economic_partner_id",
  "economic_partner_name",
  "economic_partner_source",
  "economic_owner_id",
  "economic_owner_name",
  "commercial_model",
  "settlement_counterparty_id",
  "settlement_counterparty_name",
  "economic_owner_source",
  "economic_owner_source_field",
  "ownership_scope",
  "lot_control_status",
  "lot_allocation_eligible",
  "lot_control_detail",
  "lot_checked_at",
] as const;

type Json = Record<string, unknown>;
type Allocation = {
  order_item_id: number | null;
  sales_order_id: number | null;
  sales_order_name: string | null;
  sales_order_status: string | null;
  sales_order_delivery_date: string | null;
};

function inventoryBucket(row: Json): {
  bucket: "packaged" | "plant_material" | "bulk";
  reason: "default" | "item_name_keyword" | "bulk_item";
} {
  const itemName = String(row.item_name ?? "");
  if (/\b(?:clone|biomass|seeds?)\b/i.test(itemName)) {
    return { bucket: "plant_material", reason: "item_name_keyword" };
  }
  const bulkIdentity = [
    row.item_name,
    row.item_category_name,
    row.item_sub_category_name,
    row.product_name,
  ].filter(Boolean).join(" ");
  if (/\bbulk\b/i.test(bulkIdentity)) {
    return { bucket: "bulk", reason: "bulk_item" };
  }
  return { bucket: "packaged", reason: "default" };
}

function allowedOrigin(request: Request): string {
  const origin = request.headers.get("origin") ?? "";
  const allowed = new Set([
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "https://portal.urbanxtracts.com",
    "https://tom-urbanxtracts.github.io",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]);
  return allowed.has(origin)
    ? origin
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function corsHeaders(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-cron-secret",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function json(
  request: Request,
  body: unknown,
  status = 200,
  extra: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...extra,
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

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const detail = asObject(error);
  const parts = [detail.code, detail.message, detail.details, detail.hint]
    .map(stringOrNull)
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" | ") : "Unexpected inventory error";
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumberField(
  source: Json,
  fields: string[],
): { value: number | null; field: string | null } {
  for (const field of fields) {
    if (
      !(field in source) || source[field] === null ||
      source[field] === undefined || source[field] === ""
    ) continue;
    const value = numberOrNull(source[field]);
    if (value !== null && value >= 0) return { value, field };
  }
  return { value: null, field: null };
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

function isoOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function httpsUrlOrNull(value: unknown): string | null {
  return approvedHttpsUrl(value, ASSET_HOSTS);
}

function firstObject(...values: unknown[]): Json {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = asObject(item);
        if (Object.keys(candidate).length) return candidate;
      }
      continue;
    }
    const candidate = asObject(value);
    if (Object.keys(candidate).length) return candidate;
  }
  return {};
}

function analyteValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = stringOrNull(value);
  return text ? text.slice(0, 120) : null;
}

function normalizeAnalytes(value: unknown): Json[] {
  const rows: Array<[string | null, unknown]> = Array.isArray(value)
    ? value.slice(0, 100).map((entry) => [null, entry])
    : Object.entries(asObject(value)).slice(0, 100);
  const normalized: Json[] = [];
  for (const [fallbackName, raw] of rows) {
    const entry = asObject(raw);
    const name = stringOrNull(
      entry.name ?? entry.analyte ?? entry.compound ?? entry.cannabinoid ??
        entry.terpene ?? fallbackName,
    );
    const result = analyteValue(
      entry.value ?? entry.result ?? entry.amount ?? entry.percent ??
        entry.concentration ??
        (Object.keys(entry).length ? null : raw),
    );
    if (!name || result === null) continue;
    const unit =
      stringOrNull(entry.unit ?? entry.units ?? entry.uom)?.slice(0, 40) ??
        null;
    normalized.push({ name: name.slice(0, 120), value: result, unit });
  }
  return normalized;
}

function addKnownMeasures(
  rows: Json[],
  sources: Json[],
  definitions: Array<[string, string]>,
): Json[] {
  const output = rows.slice();
  const existing = new Set(
    output.map((row) => String(row.name ?? "").toLowerCase()),
  );
  for (const [field, label] of definitions) {
    const value = sources.map((source) => source[field]).find((candidate) =>
      candidate !== null && candidate !== undefined && candidate !== ""
    );
    const normalized = analyteValue(value);
    if (normalized === null || existing.has(label.toLowerCase())) continue;
    output.push({ name: label, value: normalized, unit: "%" });
    existing.add(label.toLowerCase());
  }
  return output.slice(0, 100);
}

function normalizeProfile(value: unknown): Json {
  const output: Json = {};
  for (
    const [rawKey, rawValue] of Object.entries(asObject(value)).slice(0, 50)
  ) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    if (Array.isArray(rawValue)) {
      output[key] = rawValue.slice(0, 30).map((item) =>
        String(item).trim().slice(0, 120)
      ).filter(Boolean);
    } else if (["string", "number", "boolean"].includes(typeof rawValue)) {
      output[key] = typeof rawValue === "string"
        ? rawValue.trim().slice(0, 300)
        : rawValue;
    }
  }
  return output;
}

function sourcePackageIds(source: Json): number[] {
  const candidates = [
    source.source_package_ids,
    source.parent_package_ids,
    source.source_packages,
    source.parent_packages,
  ];
  const ids: number[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const raw of candidate) {
      const object = asObject(raw);
      const id = numberOrNull(
        Object.keys(object).length ? object.id ?? object.package_id : raw,
      );
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, 100);
}

function weightInGrams(
  weight: number | null,
  unit: string | null,
): number | null {
  if (weight === null || !unit) return null;
  const normalized = unit.trim().toLowerCase();
  const multiplier =
    normalized === "grams" || normalized === "gram" || normalized === "g"
      ? 1
      : normalized === "kilograms" || normalized === "kilogram" ||
          normalized === "kg"
      ? 1000
      : normalized === "milligrams" || normalized === "milligram" ||
          normalized === "mg"
      ? 0.001
      : normalized === "ounces" || normalized === "ounce" || normalized === "oz"
      ? 28.349523125
      : normalized === "pounds" || normalized === "pound" ||
          normalized === "lb" || normalized === "lbs"
      ? 453.59237
      : null;
  return multiplier === null ? null : weight * multiplier;
}

function daysSince(value: string | null): number | null {
  if (!value) return null;
  const start = new Date(`${value}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
}

async function canixRequest(path: string, attempt = 0): Promise<Json[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28_000);
  try {
    const response = await fetch(`${CANIX_API_BASE}/${path}`, {
      headers: { accept: "application/json", "X-API-KEY": CANIX_API_KEY },
      signal: controller.signal,
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
      return canixRequest(path, attempt + 1);
    }
    if (!response.ok) {
      throw new Error(
        `Canix ${path.split("?")[0]} returned ${response.status}`,
      );
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error(`Canix ${path.split("?")[0]} did not return an array`);
    }
    return body.map(asObject);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAll(
  endpoint: string,
  where?: string,
): Promise<{ rows: Json[]; pages: number }> {
  const rows: Json[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      order_by: "id asc",
    });
    if (where) params.set("where", where);
    const page = await canixRequest(`${endpoint}?${params.toString()}`);
    rows.push(...page);
    pages += 1;
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (pages >= 100) {
      throw new Error(`Canix ${endpoint} exceeded the 100-page safety limit`);
    }
  }
  return { rows, pages };
}

function allocationMap(orders: Json[]): Map<number, Allocation> {
  const allocations = new Map<number, Allocation>();
  for (const order of orders) {
    const orderId = numberOrNull(order.id);
    const allocationBase = {
      sales_order_id: orderId,
      sales_order_name: stringOrNull(order.name),
      sales_order_status: stringOrNull(order.display_status) ??
        stringOrNull(order.status),
      sales_order_delivery_date: isoOrNull(order.delivery_date),
    };
    const contents = Array.isArray(order.contents) ? order.contents : [];
    for (const rawLine of contents) {
      const line = asObject(rawLine);
      const packageIds = Array.isArray(line.package_ids)
        ? line.package_ids
        : [];
      for (const rawPackageId of packageIds) {
        const packageId = numberOrNull(rawPackageId);
        if (packageId === null) continue;
        const next: Allocation = {
          ...allocationBase,
          order_item_id: numberOrNull(line.id),
        };
        const current = allocations.get(packageId);
        if (
          !current ||
          String(next.sales_order_status).toLowerCase() !== "archived"
        ) allocations.set(packageId, next);
      }
    }
  }
  return allocations;
}

function normalizePackage(
  source: Json,
  facilities: Map<number, Json>,
  allocations: Map<number, Allocation>,
  runId: string,
): Json | null {
  const packageId = numberOrNull(source.id);
  const item = asObject(source.item);
  const quantityType = stringOrNull(item.quantity_type);
  if (
    packageId === null || !quantityType || !QUANTITY_TYPES.has(quantityType)
  ) return null;
  if (source.is_active === false || source.is_testing_package === true) {
    return null;
  }

  const allocation = allocations.get(packageId) ?? {
    order_item_id: null,
    sales_order_id: null,
    sales_order_name: null,
    sales_order_status: null,
    sales_order_delivery_date: null,
  };
  const packageBrand = asObject(source.brand);
  const itemBrand = asObject(item.brand);
  const productBrand = asObject(item.product_brand);
  const brand = Object.keys(packageBrand).length
    ? packageBrand
    : Object.keys(itemBrand).length
    ? itemBrand
    : productBrand;
  const packageOwner = firstObject(source.owner, source.package_owner);
  const strain = asObject(item.strain);
  const itemType = asObject(item.type);
  const itemSubType = asObject(item.sub_type);
  const location = asObject(source.location);
  const facilityId = numberOrNull(item.facility_id);
  const facility = facilityId === null ? {} : facilities.get(facilityId) ?? {};
  const status = stringOrNull(source.status);
  const normalizedStatus = status?.toUpperCase() ?? null;
  const uomCode = normalizedStatus && UOM_CODES.has(normalizedStatus)
    ? normalizedStatus
    : null;
  const weight = numberOrNull(source.weight);
  const weightUnit = stringOrNull(source.weight_unit) ??
    stringOrNull(item.weight_unit);
  const packagedDate = dateOrNull(source.packaged_date);
  const sourceUpdatedAt = isoOrNull(source.updated_at);
  const available = source.available_for_sale === true;
  const sourceStatusCategory =
    stringOrNull(source.status_category)?.toLowerCase() ?? null;
  const statusCategory = allocation.order_item_id !== null
    ? "allocated"
    : sourceStatusCategory && STATUS_CATEGORIES.has(sourceStatusCategory)
    ? sourceStatusCategory
    : available
    ? "available"
    : "in_progress";
  const reservation = nonNegativeNumberField(source, [
    "c_reserved_weight",
    "reserved_weight",
    "reserved_quantity",
  ]);
  const orderableUnits =
    quantityType === "CountBased" && statusCategory === "available"
      ? Math.max(0, (weight ?? 0) - (reservation.value ?? 0))
      : 0;
  const testStatus = stringOrNull(source.test_status);
  const lab = firstObject(
    source.lab_result,
    source.lab_results,
    source.test_result,
    source.test_results,
    source.lab_test,
    source.coa,
  );
  const coaUrl = httpsUrlOrNull(
    source.coa_url ?? lab.coa_url ?? lab.document_url ?? lab.url,
  );
  const cannabinoids = addKnownMeasures(
    normalizeAnalytes(
      source.cannabinoids ?? source.cannabinoid_results ?? lab.cannabinoids ??
        lab.cannabinoid_results,
    ),
    [source, lab],
    [
      ["total_thc_percent", "Total THC"],
      ["total_cbd_percent", "Total CBD"],
      ["total_cannabinoids_percent", "Total cannabinoids"],
      ["thca_percent", "THCA"],
      ["delta_9_thc_percent", "Delta-9 THC"],
      ["cbda_percent", "CBDA"],
      ["cbg_percent", "CBG"],
      ["cbn_percent", "CBN"],
    ],
  );
  const terpenes = addKnownMeasures(
    normalizeAnalytes(
      source.terpenes ?? source.terpene_results ?? lab.terpenes ??
        lab.terpene_results,
    ),
    [source, lab],
    [["total_terpenes_percent", "Total terpenes"]],
  );
  const labProfile = normalizeProfile(
    source.lab_profile ?? source.flavor_profile ?? lab.profile ??
      lab.flavor_profile,
  );

  return {
    package_id: packageId,
    tag: stringOrNull(source.tag),
    item_id: numberOrNull(item.id),
    item_name: stringOrNull(item.name),
    sku: stringOrNull(item.sku),
    item_category_name: stringOrNull(itemType.product_category) ??
      stringOrNull(item.item_type) ?? stringOrNull(itemType.name),
    item_sub_category_name: stringOrNull(itemSubType.name),
    product_id: numberOrNull(item.product_id) ??
      numberOrNull(asObject(item.product).id),
    product_name: stringOrNull(item.product_name) ??
      stringOrNull(asObject(item.product).name) ??
      stringOrNull(source.product_name),
    brand_id: numberOrNull(brand.id),
    brand_name: stringOrNull(brand.name),
    // These compatibility fields previously and incorrectly copied Brand. They
    // now remain blank. Canix Package Owner is a user, not the economic owner.
    owner_id: null,
    owner_name: null,
    canix_package_owner_id: numberOrNull(packageOwner.id),
    canix_package_owner_name: stringOrNull(packageOwner.name) ??
      stringOrNull(packageOwner.full_name) ??
      stringOrNull(source.owner_name) ??
      stringOrNull(source.package_owner_name),
    strain_name: stringOrNull(strain.name),
    strain_type: stringOrNull(strain.type),
    quantity_type: quantityType,
    weight,
    weight_unit_name: weightUnit,
    c_weight_g: quantityType === "WeightBased"
      ? weightInGrams(weight, weightUnit)
      : null,
    c_reserved_weight: reservation.value,
    reservation_state: reservation.field ? "known" : "unknown",
    reservation_source_field: reservation.field,
    orderable_units: orderableUnits,
    case_quantity: positiveIntegerOrNull(item.case_quantity),
    case_quantity_unit: stringOrNull(item.case_quantity_unit) ??
      stringOrNull(item.case_unit),
    uom_code: uomCode,
    lot_id: stringOrNull(source.lot_id),
    production_batch_number: stringOrNull(source.production_batch) ??
      stringOrNull(source.production_batch_number),
    facility_id: facilityId,
    facility_name: stringOrNull(facility.name),
    facility_license: stringOrNull(facility.license_number),
    room_id: numberOrNull(location.id),
    room_name: stringOrNull(location.name),
    status,
    status_category: statusCategory,
    compliance_submitted: true,
    lab_test_status: testStatus,
    test_result_status: testStatus,
    has_coa: Boolean(coaUrl),
    marked_available: available,
    coa_url: coaUrl,
    coa_document_id: stringOrNull(source.coa_id ?? lab.document_id ?? lab.id),
    lab_name: stringOrNull(
      lab.lab_name ?? lab.laboratory_name ?? source.lab_name,
    ),
    lab_tested_at: isoOrNull(
      lab.tested_at ?? lab.test_date ?? source.tested_at ?? source.test_date,
    ),
    lab_batch_number: stringOrNull(
      lab.batch_number ?? lab.batch_id ?? source.batch_number,
    ),
    cannabinoids,
    terpenes,
    lab_profile: labProfile,
    source_package_ids: sourcePackageIds(source),
    is_finished_good: typeof source.is_finished_good === "boolean"
      ? source.is_finished_good
      : typeof item.is_finished_good === "boolean"
      ? item.is_finished_good
      : null,
    packaged_date: packagedDate,
    expiration_date: dateOrNull(source.expiration_date),
    use_by_date: null,
    age_days: daysSince(packagedDate),
    order_item_id: allocation.order_item_id,
    cost_object_id: allocation.order_item_id,
    sales_order_id: allocation.sales_order_id,
    sales_order_name: allocation.sales_order_name,
    sales_order_status: allocation.sales_order_status,
    sales_order_delivery_date: allocation.sales_order_delivery_date,
    source_updated_at: sourceUpdatedAt,
    sync_run_id: runId,
    synced_at: new Date().toISOString(),
    source_payload: source,
  };
}

async function syncInventory(force = false): Promise<Json> {
  if (!CANIX_API_KEY) throw new Error("CANIX_API_KEY is not configured");
  const runId = crypto.randomUUID();
  const { data: claimResult, error: claimError } = await service.rpc(
    "canix_claim_sync_run",
    {
      p_run_id: runId,
      p_force: force,
      p_fresh_seconds: 300,
    },
  );
  if (claimError) throw claimError;
  const claim = asObject(claimResult);
  if (claim.claimed !== true) {
    return {
      skipped: true,
      reason: claim.reason ?? "not_claimed",
      last_successful_at: claim.lastSuccessfulAt ?? null,
      last_started_at: claim.lastStartedAt ?? null,
    };
  }

  try {
    const [packageResult, facilityResult, salesOrderResult] = await Promise.all(
      [
        fetchAll("packages", "is_active=true AND is_testing_package=false"),
        fetchAll("facilities"),
        fetchAll(
          "sales_orders",
          "status IN ('created','approved','filled','shipped','requested','accepted')",
        ),
      ],
    );
    const facilities = new Map<number, Json>();
    for (const facility of facilityResult.rows) {
      const id = numberOrNull(facility.id);
      if (id !== null) facilities.set(id, facility);
    }
    const allocations = allocationMap(salesOrderResult.rows);
    const packages = packageResult.rows
      .map((row) => normalizePackage(row, facilities, allocations, runId))
      .filter((row): row is Json => row !== null);

    for (let index = 0; index < packages.length; index += 250) {
      const { error } = await service.from("canix_package_sync_stage").upsert(
        packages.slice(index, index + 250),
        {
          onConflict: "sync_run_id,package_id",
        },
      );
      if (error) throw error;
    }

    const latest = packages.reduce<string | null>((max, row) => {
      const value = stringOrNull(row.source_updated_at);
      return value && (!max || value > max) ? value : max;
    }, null);
    const { data: published, error: publishError } = await service.rpc(
      "canix_publish_sync_run",
      {
        p_run_id: runId,
        p_package_count: packages.length,
        p_package_pages: packageResult.pages,
        p_sales_order_pages: salesOrderResult.pages,
        p_latest_source_updated_at: latest,
      },
    );
    if (publishError) throw publishError;
    if (asObject(published).published !== true) {
      throw new Error("Canix snapshot publication did not complete.");
    }
    const [partnerSyncResult, lotIntegrityResult] = await Promise.all([
      service.rpc("portal_sync_brand_economic_partners"),
      service.rpc("portal_reconcile_lot_integrity"),
    ]);
    return {
      run_id: runId,
      packages: packages.length,
      package_pages: packageResult.pages,
      sales_order_pages: salesOrderResult.pages,
      latest_source_updated_at: latest,
      economic_partner_sync: partnerSyncResult.error
        ? { synced: false, reason: "economic_partner_sync_failed" }
        : asObject(partnerSyncResult.data),
      lot_integrity: lotIntegrityResult.error
        ? { checked: false, reason: "lot_integrity_reconciliation_failed" }
        : asObject(lotIntegrityResult.data),
    };
  } catch (error) {
    const message = errorMessage(error);
    await service.from("canix_package_sync_stage").delete().eq(
      "sync_run_id",
      runId,
    );
    await service.from("canix_sync_state").update({
      status: "error",
      active_run_id: null,
      last_completed_at: new Date().toISOString(),
      last_error: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    }).eq("id", 1).eq("active_run_id", runId);
    throw error;
  }
}

async function authenticateCapability(
  request: Request,
  permission: string,
): Promise<Json | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!userResponse.ok) return null;
  if (!verifiedTokenHasAal2(authorization)) return null;
  const user = asObject(await userResponse.json());
  const userId = stringOrNull(user.id);
  if (!userId) return null;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active,org,locations")
    .eq("id", userId)
    .maybeSingle();
  if (
    error || !profile || profile.active === false ||
    profile.role !== "internal" || !profile.staff_role
  ) return null;
  const { data: grant, error: grantError } = await service.from(
    "portal_role_permission",
  )
    .select("permission")
    .eq("staff_role", profile.staff_role)
    .eq("permission", permission)
    .maybeSingle();
  if (grantError || !grant) return null;
  return profile as Json;
}

async function allCurrentPackages(runId: string): Promise<Json[]> {
  const rows: Json[] = [];
  for (let start = 0;; start += 1000) {
    const { data, error } = await service.from("canix_package_current")
      .select(STORED_PACKAGE_COLUMNS.join(","))
      .eq("sync_run_id", runId)
      .order("source_updated_at", { ascending: false, nullsFirst: false })
      .range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Json[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function allLotControls(runId: string): Promise<Json[]> {
  const rows: Json[] = [];
  for (let start = 0;; start += 1000) {
    const { data, error } = await service.from("portal_package_lot_control")
      .select(
        "package_id,integrity_status,allocation_eligible,detail,checked_at",
      )
      .eq("sync_run_id", runId)
      .range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Json[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function withEconomicOwnership(rows: Json[]): Promise<Json[]> {
  const [ownershipResult, partyResult, partnerResult] = await Promise.all([
    service.from("portal_inventory_ownership")
      .select(
        "scope_type,canix_item_id,canix_package_id,economic_owner_party_id,commercial_model,settlement_counterparty_party_id,source_system,source_field",
      )
      .is("effective_to", null),
    service.from("portal_economic_party").select("id,display_name,active"),
    service.from("portal_brand_economic_partner")
      .select(
        "brand_key,economic_partner_party_id,source_system,is_current",
      )
      .eq("is_current", true),
  ]);
  if (ownershipResult.error) throw ownershipResult.error;
  if (partyResult.error) throw partyResult.error;
  if (partnerResult.error) throw partnerResult.error;

  const partyNames = new Map<string, string>();
  for (const party of partyResult.data ?? []) {
    if (party.id && party.display_name) {
      partyNames.set(String(party.id), String(party.display_name));
    }
  }
  const itemDefaults = new Map<number, Json>();
  const packageOverrides = new Map<number, Json>();
  const brandPartners = new Map<string, Json>();
  for (const partner of (partnerResult.data ?? []) as unknown as Json[]) {
    const brandKey = stringOrNull(partner.brand_key);
    if (brandKey) brandPartners.set(brandKey, partner);
  }
  for (const ownership of (ownershipResult.data ?? []) as unknown as Json[]) {
    if (ownership.scope_type === "package") {
      const packageId = numberOrNull(ownership.canix_package_id);
      if (packageId !== null) packageOverrides.set(packageId, ownership);
    } else {
      const itemId = numberOrNull(ownership.canix_item_id);
      if (itemId !== null) itemDefaults.set(itemId, ownership);
    }
  }

  return rows.map((row) => {
    const packageId = numberOrNull(row.package_id);
    const itemId = numberOrNull(row.item_id);
    const ownership =
      (packageId === null ? null : packageOverrides.get(packageId)) ??
        (itemId === null ? null : itemDefaults.get(itemId)) ??
        null;
    const economicOwnerId = ownership
      ? stringOrNull(ownership.economic_owner_party_id)
      : null;
    const settlementId = ownership
      ? stringOrNull(ownership.settlement_counterparty_party_id)
      : null;
    const brandKey = stringOrNull(row.brand_name)?.trim().toLowerCase() ?? null;
    const economicPartner = brandKey
      ? brandPartners.get(brandKey) ?? null
      : null;
    const economicPartnerId = economicPartner
      ? stringOrNull(economicPartner.economic_partner_party_id)
      : null;
    const inventoryClassification = inventoryBucket(row);
    return {
      ...row,
      inventory_bucket: inventoryClassification.bucket,
      inventory_bucket_reason: inventoryClassification.reason,
      economic_partner_id: economicPartnerId,
      economic_partner_name: economicPartnerId
        ? partyNames.get(economicPartnerId) ?? null
        : null,
      economic_partner_source: economicPartner
        ? stringOrNull(economicPartner.source_system)
        : null,
      economic_owner_id: economicOwnerId,
      economic_owner_name: economicOwnerId
        ? partyNames.get(economicOwnerId) ?? null
        : null,
      commercial_model: ownership
        ? stringOrNull(ownership.commercial_model)
        : null,
      settlement_counterparty_id: settlementId,
      settlement_counterparty_name: settlementId
        ? partyNames.get(settlementId) ?? null
        : null,
      economic_owner_source: ownership
        ? stringOrNull(ownership.source_system)
        : null,
      economic_owner_source_field: ownership
        ? stringOrNull(ownership.source_field)
        : null,
      ownership_scope: ownership ? stringOrNull(ownership.scope_type) : null,
    };
  });
}

function summarize(rows: Json[], key: string): Json[] {
  const groups = new Map<
    string,
    { packages: number; weight_g: number; units: number }
  >();
  for (const row of rows) {
    const value = stringOrNull(row[key]) ?? "Not recorded";
    const current = groups.get(value) ?? { packages: 0, weight_g: 0, units: 0 };
    current.packages += 1;
    if (row.quantity_type === "WeightBased") {
      current.weight_g += numberOrNull(row.c_weight_g) ?? 0;
    }
    if (row.quantity_type === "CountBased") {
      current.units += numberOrNull(row.weight) ?? 0;
    }
    groups.set(value, current);
  }
  return Array.from(groups, ([value, totals]) => ({ [key]: value, ...totals }))
    .sort((a, b) => Number(b.packages) - Number(a.packages));
}

async function cachedPayload(): Promise<Json | null> {
  const { data: state, error } = await service.from("canix_sync_state").select(
    "*",
  ).eq("id", 1).single();
  if (error) throw error;
  const runId = stringOrNull(state.last_successful_run_id);
  if (!runId) return null;
  const [ownedRows, lotControls, lotStateResult] = await Promise.all([
    withEconomicOwnership(await allCurrentPackages(runId)),
    allLotControls(runId),
    service.from("portal_lot_integrity_state").select(
      "monday_board_id,enforcement_mode,register_sync_status,last_register_sync_at,last_integrity_run_at,last_error,register_rows,approved_register_rows,invalid_register_rows,duplicate_register_rows,package_rows,valid_package_rows,exception_package_rows,allocation_exception_rows",
    ).eq("id", 1).maybeSingle(),
  ]);
  if (lotStateResult.error) throw lotStateResult.error;
  const lotControlByPackage = new Map(
    lotControls.map((control) => [String(control.package_id), control]),
  );
  const rows: Json[] = ownedRows.map((row): Json => {
    const control = lotControlByPackage.get(String(row.package_id));
    return {
      ...row,
      coa_url: httpsUrlOrNull(row.coa_url),
      lot_control_status: control?.integrity_status ?? "not_checked",
      lot_allocation_eligible: control?.allocation_eligible ?? false,
      lot_control_detail: control?.detail ??
        "Lot pointer has not been checked against the Monday register.",
      lot_checked_at: control?.checked_at ?? null,
    };
  });
  const lotState = lotStateResult.data as Json | null;
  const sandboxRows = rows.filter((row) =>
    numberOrNull(row.facility_id) === 4546
  );
  const productionRows = rows.filter((row) =>
    numberOrNull(row.facility_id) !== 4546
  );
  const weightRows = productionRows.filter((row) =>
    row.quantity_type === "WeightBased"
  );
  const countRows = productionRows.filter((row) =>
    row.quantity_type === "CountBased"
  );
  const sandboxWeightRows = sandboxRows.filter((row) =>
    row.quantity_type === "WeightBased"
  );
  const sandboxCountRows = sandboxRows.filter((row) =>
    row.quantity_type === "CountBased"
  );
  const lastSuccess = isoOrNull(state.last_successful_at);
  return {
    source: {
      system: "Canix",
      domain: "REST API",
      table: "GET /packages + GET /sales_orders",
      grain: "one row per package",
      refresh: "server-side five-minute target",
      latest_updated_at: state.latest_source_updated_at,
      last_successful_sync_at: lastSuccess,
      stale: lastSuccess
        ? Date.now() - new Date(lastSuccess).getTime() > 10 * 60 * 1000
        : true,
      connection_mode: "server_side_canix_api_cache",
      ownership_model: "portal_item_default_with_package_override",
      ownership_fallback: "none",
      lot_register_system: "Monday UX Inbound Lot Register",
      lot_register_board_id: lotState?.monday_board_id ?? null,
      lot_register_last_sync_at: lotState?.last_register_sync_at ?? null,
      lot_integrity_last_checked_at: lotState?.last_integrity_run_at ?? null,
      availability_rule:
        "active Canix package + status_category available; explicit reservations subtracted",
      catalog_grouping: "canix_item_id_v1",
    },
    scope: {
      excluded_facility_ids: [4546],
      excluded_samples: true,
      active_only: true,
      status_categories: ["available", "in_progress", "allocated"],
      quantity_types: ["WeightBased", "CountBased"],
      volume_excluded: true,
      lot_enforcement_mode: lotState?.enforcement_mode ?? "monitor",
    },
    summary: {
      packages: productionRows.length,
      weight_g: weightRows.reduce(
        (sum, row) => sum + (numberOrNull(row.c_weight_g) ?? 0),
        0,
      ),
      units: countRows.reduce(
        (sum, row) => sum + (numberOrNull(row.weight) ?? 0),
        0,
      ),
      orderable_units: countRows.reduce(
        (sum, row) => sum + (numberOrNull(row.orderable_units) ?? 0),
        0,
      ),
    },
    quantity_types: summarize(productionRows, "quantity_type"),
    statuses: summarize(productionRows, "status_category"),
    facilities: summarize(productionRows, "facility_id").map((entry) => {
      const facilityId = numberOrNull(entry.facility_id);
      const sample = productionRows.find((row) =>
        numberOrNull(row.facility_id) === facilityId
      ) ?? {};
      return {
        ...entry,
        facility_id: facilityId,
        facility_name: sample.facility_name,
        facility_license: sample.facility_license,
      };
    }),
    sandbox: {
      facility_id: 4546,
      packages: sandboxRows.length,
      weight_g: sandboxWeightRows.reduce(
        (sum, row) => sum + (numberOrNull(row.c_weight_g) ?? 0),
        0,
      ),
      units: sandboxCountRows.reduce(
        (sum, row) => sum + (numberOrNull(row.weight) ?? 0),
        0,
      ),
      latest_updated_at: sandboxRows[0]?.source_updated_at ?? null,
    },
    checks: {
      active_inactive_conflicts: null,
      zero_quantity_packages:
        productionRows.filter((row) => (numberOrNull(row.weight) ?? 0) === 0)
          .length,
      failed_lab_packages:
        productionRows.filter((row) =>
          String(row.lab_test_status ?? "").toLowerCase().includes("fail")
        ).length,
      not_submitted_packages: 0,
      expired_packages: productionRows.filter((row) =>
        row.expiration_date &&
        String(row.expiration_date) < new Date().toISOString().slice(0, 10)
      ).length,
      reservation_known_packages:
        productionRows.filter((row) => row.reservation_state === "known")
          .length,
      reserved_available_count_packages:
        productionRows.filter((row) =>
          row.quantity_type === "CountBased" &&
          row.status_category === "available" &&
          (numberOrNull(row.c_reserved_weight) ?? 0) > 0
        ).length,
      count_items_with_case_quantity: new Set(
        productionRows.filter((row) =>
          row.quantity_type === "CountBased" &&
          positiveIntegerOrNull(row.case_quantity) !== null
        ).map((row) => numberOrNull(row.item_id)).filter((id) => id !== null),
      ).size,
      lot_valid_packages:
        productionRows.filter((row) => row.lot_control_status === "valid")
          .length,
      lot_exception_packages:
        productionRows.filter((row) => row.lot_control_status !== "valid")
          .length,
      lot_missing_pointer_packages:
        productionRows.filter((row) =>
          row.lot_control_status === "missing_pointer"
        ).length,
      lot_multiple_value_packages:
        productionRows.filter((row) =>
          row.lot_control_status === "multiple_lots"
        ).length,
      lot_allocation_exception_packages:
        productionRows.filter((row) =>
          row.lot_control_status !== "valid" &&
          ["available", "allocated"].includes(String(row.status_category))
        ).length,
      lot_register_rows: numberOrNull(lotState?.register_rows),
      lot_register_approved_rows: numberOrNull(
        lotState?.approved_register_rows,
      ),
      lot_register_invalid_rows: numberOrNull(lotState?.invalid_register_rows),
      lot_register_duplicate_rows: numberOrNull(
        lotState?.duplicate_register_rows,
      ),
    },
    package_columns: PACKAGE_COLUMNS,
    packages: productionRows.map((row) =>
      PACKAGE_COLUMNS.map((column) => row[column] ?? null)
    ),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405, {
      allow: "GET, POST, OPTIONS",
    });
  }

  try {
    if (request.method === "POST") {
      const suppliedCronSecret = request.headers.get("x-cron-secret") ?? "";
      const cronAuthorized = Boolean(CANIX_CRON_SECRET) &&
        constantTimeEqual(suppliedCronSecret, CANIX_CRON_SECRET);
      const profile = cronAuthorized
        ? { role: "cron" }
        : await authenticateCapability(request, "inventory.sync");
      if (!profile) return json(request, { error: "Forbidden" }, 403);
      const force = new URL(request.url).searchParams.get("force") === "true";
      const edgeRuntime = (globalThis as unknown as {
        EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
      }).EdgeRuntime;
      if (cronAuthorized && edgeRuntime) {
        edgeRuntime.waitUntil(syncInventory(force));
        return json(request, { ok: true, sync: { scheduled: true } }, 202);
      }
      const result = await syncInventory(force);
      return json(request, { ok: true, sync: result });
    }

    const profile = await authenticateCapability(request, "inventory.read");
    if (!profile) return json(request, { error: "Forbidden" }, 403);
    const payload = await cachedPayload();
    if (!payload) {
      return json(
        request,
        { error: "No successful Canix snapshot is available" },
        503,
        { "retry-after": "30" },
      );
    }
    return json(request, payload);
  } catch (error) {
    const message = errorMessage(error);
    return json(request, { error: message }, 502, { "retry-after": "30" });
  }
});
