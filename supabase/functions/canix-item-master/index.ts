import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const CANIX_API_KEY = Deno.env.get("CANIX_API_KEY") ?? "";
const CANIX_CRON_SECRET = Deno.env.get("CANIX_CRON_SECRET") ?? "";
const CANIX_API_BASE = "https://api.canix.com/api/v1";
const PAGE_SIZE = 2000;

type Json = Record<string, unknown>;

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
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

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function firstObject(...values: unknown[]): Json {
  for (const value of values) {
    const object = asObject(value);
    if (Object.keys(object).length) return object;
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const detail = asObject(error);
  return [detail.code, detail.message, detail.details, detail.hint]
    .map(stringOrNull).filter(Boolean).join(" | ") ||
    "Unexpected Canix Item Master error";
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

function normalizeItem(
  source: Json,
  facilities: Map<number, Json>,
  runId: string,
): Json {
  const itemId = numberOrNull(source.id);
  if (itemId === null || !Number.isSafeInteger(itemId)) {
    throw new Error("Canix returned an Item without a valid numeric ID");
  }
  const facilityId = numberOrNull(source.facility_id);
  const facility = facilityId === null ? {} : facilities.get(facilityId) ?? {};
  const brand = asObject(source.brand);
  const productBrand = asObject(source.product_brand);
  const itemType = asObject(source.type);
  const itemSubType = asObject(source.sub_type);
  const strain = asObject(source.strain);
  const standardCost = firstObject(
    source.current_standard_cost,
    source.current_standard_costing,
  );
  const sageItem = asObject(source.sage_item);
  const leaflinkItem = asObject(source.leaflink_item);
  const dutchieProduct = asObject(source.dutchie_product);
  const billsOfMaterials = Array.isArray(source.bills_of_materials)
    ? source.bills_of_materials.map(asObject)
    : [];
  const quantityType = stringOrNull(source.quantity_type) ??
    stringOrNull(itemType.quantity_type);
  const reportQuantityTotals = quantityType === "WeightBased" ||
    quantityType === "CountBased";

  return {
    item_id: itemId,
    name: stringOrNull(source.name),
    is_active: booleanOrNull(source.is_active),
    item_type: stringOrNull(source.item_type),
    item_type_id: numberOrNull(itemType.id),
    item_type_name: stringOrNull(itemType.name),
    item_category_name: stringOrNull(itemType.product_category),
    item_sub_type_id: numberOrNull(itemSubType.id),
    item_sub_type_name: stringOrNull(itemSubType.name),
    brand_id: numberOrNull(brand.id),
    brand_name: stringOrNull(brand.name),
    product_id: numberOrNull(source.product_id),
    product_brand_id: numberOrNull(productBrand.id),
    product_brand_name: stringOrNull(productBrand.name),
    quantity_type: quantityType,
    sku: stringOrNull(source.sku),
    accounting_inventory_type: stringOrNull(source.accounting_inventory_type),
    notes: stringOrNull(source.notes),
    facility_id: facilityId,
    facility_name: stringOrNull(facility.name),
    facility_license: stringOrNull(facility.license_number),
    strain_id: numberOrNull(strain.id),
    strain_name: stringOrNull(strain.name),
    strain_type: stringOrNull(strain.type),
    weight_unit: stringOrNull(source.weight_unit),
    unit_weight: numberOrNull(source.unit_weight),
    unit_weight_unit: stringOrNull(source.unit_weight_unit),
    case_quantity: stringOrNull(source.case_quantity),
    case_quantity_unit: stringOrNull(source.case_quantity_unit) ??
      stringOrNull(source.case_unit),
    unit_cbd_weight: numberOrNull(source.unit_cbd_weight),
    unit_cbd_weight_unit: stringOrNull(source.unit_cbd_weight_unit),
    unit_thc_weight: numberOrNull(source.unit_thc_weight),
    unit_thc_weight_unit: stringOrNull(source.unit_thc_weight_unit),
    unit_cbd_percent: numberOrNull(source.unit_cbd_percent),
    unit_thc_percent: numberOrNull(source.unit_thc_percent),
    description: stringOrNull(source.description),
    serving_size: numberOrNull(source.serving_size),
    number_of_doses: numberOrNull(source.number_of_doses),
    public_ingredients: stringOrNull(source.public_ingredients),
    supply_duration_days: numberOrNull(source.supply_duration_days),
    administration_method: stringOrNull(source.administration_method),
    allergens: stringOrNull(source.allergens),
    transfer_source_license: stringOrNull(source.transfer_source_license),
    phenotype: stringOrNull(source.phenotype),
    bills_of_materials: billsOfMaterials,
    sage_item_external_id: stringOrNull(sageItem.external_id),
    sage_item_name: stringOrNull(sageItem.name),
    leaflink_item_external_id: stringOrNull(leaflinkItem.external_id),
    leaflink_item_name: stringOrNull(leaflinkItem.name),
    dutchie_product_external_id: stringOrNull(dutchieProduct.external_id),
    dutchie_product_name: stringOrNull(dutchieProduct.name),
    // Retain every Item definition, including a possible volume-based item,
    // without measuring or publishing volume quantities in UX OS.
    total_for_sale: reportQuantityTotals
      ? numberOrNull(source.total_for_sale)
      : null,
    ordered: reportQuantityTotals ? numberOrNull(source.ordered) : null,
    backordered: reportQuantityTotals ? numberOrNull(source.backordered) : null,
    unordered: reportQuantityTotals ? numberOrNull(source.unordered) : null,
    current_standard_cost_amount: numberOrNull(
      standardCost.standard_cost_amount ?? standardCost.amount ??
        standardCost.cost,
    ),
    current_standard_cost_currency: stringOrNull(
      standardCost.standard_cost_currency ?? standardCost.currency,
    ),
    current_standard_cost_start_date: dateOrNull(
      standardCost.start_date,
    ),
    current_standard_cost_end_date: dateOrNull(standardCost.end_date),
    source_updated_at: isoOrNull(source.updated_at),
    sync_run_id: runId,
    synced_at: new Date().toISOString(),
    source_payload: source,
  };
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
  if (!userResponse.ok || !verifiedTokenHasAal2(authorization)) return null;
  const user = asObject(await userResponse.json());
  const userId = stringOrNull(user.id);
  if (!userId) return null;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active,org,locations")
    .eq("id", userId).maybeSingle();
  if (
    error || !profile || profile.active === false ||
    profile.role !== "internal" ||
    !profile.staff_role
  ) return null;
  const { data: grant, error: grantError } = await service.from(
    "portal_role_permission",
  ).select("permission").eq("staff_role", profile.staff_role).eq(
    "permission",
    permission,
  ).maybeSingle();
  if (grantError || !grant) return null;
  return profile as Json;
}

async function syncItemMaster(force = false): Promise<Json> {
  if (!CANIX_API_KEY) throw new Error("CANIX_API_KEY is not configured");
  const runId = crypto.randomUUID();
  const { data: claimResult, error: claimError } = await service.rpc(
    "canix_claim_item_sync_run",
    { p_run_id: runId, p_force: force, p_fresh_seconds: 300 },
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
    const [itemResult, facilityResult] = await Promise.all([
      fetchAll("items"),
      fetchAll("facilities"),
    ]);
    const facilities = new Map<number, Json>();
    for (const facility of facilityResult.rows) {
      const id = numberOrNull(facility.id);
      if (id !== null) facilities.set(id, facility);
    }
    const items = itemResult.rows.map((row) =>
      normalizeItem(row, facilities, runId)
    );
    const itemIds = new Set(items.map((item) => String(item.item_id)));
    if (itemIds.size !== items.length) {
      throw new Error(
        "Canix returned duplicate Item IDs in the complete snapshot",
      );
    }

    for (let index = 0; index < items.length; index += 250) {
      const { error } = await service.from("canix_item_sync_stage").upsert(
        items.slice(index, index + 250),
        { onConflict: "sync_run_id,item_id" },
      );
      if (error) throw error;
    }
    const latest = items.reduce<string | null>((maximum, item) => {
      const value = stringOrNull(item.source_updated_at);
      return value && (!maximum || value > maximum) ? value : maximum;
    }, null);
    const { data: published, error: publishError } = await service.rpc(
      "canix_publish_item_sync_run",
      {
        p_run_id: runId,
        p_item_count: items.length,
        p_item_pages: itemResult.pages,
        p_latest_source_updated_at: latest,
      },
    );
    if (publishError) throw publishError;
    if (asObject(published).published !== true) {
      throw new Error("Canix Item Master publication did not complete");
    }
    return {
      run_id: runId,
      items: items.length,
      item_pages: itemResult.pages,
      facility_pages: facilityResult.pages,
      latest_source_updated_at: latest,
    };
  } catch (error) {
    const message = errorMessage(error);
    await service.from("canix_item_sync_stage").delete().eq(
      "sync_run_id",
      runId,
    );
    await service.from("canix_item_sync_state").update({
      status: "error",
      active_run_id: null,
      last_completed_at: new Date().toISOString(),
      last_error: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    }).eq("id", 1).eq("active_run_id", runId);
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    if (request.method === "GET") {
      const profile = await authenticateCapability(request, "inventory.read");
      if (!profile) return json(request, { error: "Forbidden" }, 403);
      const { data, error } = await service.from("canix_item_sync_state")
        .select(
          "status,last_successful_at,latest_source_updated_at,item_count,item_pages,last_error",
        ).eq("id", 1).single();
      if (error) throw error;
      return json(request, { source: "Canix GET /items", sync: data });
    }

    const suppliedSecret = request.headers.get("x-cron-secret") ?? "";
    const cronAuthorized = CANIX_CRON_SECRET.length >= 32 &&
      constantTimeEqual(suppliedSecret, CANIX_CRON_SECRET);
    const profile = cronAuthorized
      ? null
      : await authenticateCapability(request, "inventory.sync");
    if (!cronAuthorized && !profile) {
      return json(request, { error: "Forbidden" }, 403);
    }
    const force = new URL(request.url).searchParams.get("force") === "true";
    const edgeRuntime = (globalThis as unknown as {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }).EdgeRuntime;
    if (cronAuthorized && edgeRuntime) {
      edgeRuntime.waitUntil(syncItemMaster(force));
      return json(request, { ok: true, sync: { scheduled: true } }, 202);
    }
    const result = await syncItemMaster(force);
    if (profile) {
      await service.from("portal_admin_audit").insert({
        actor_id: profile.id,
        actor_org: profile.org,
        action: "canix.item_master_synced",
        detail: {
          items: result.items ?? null,
          pages: result.item_pages ?? null,
          skipped: result.skipped ?? false,
        },
      });
    }
    return json(request, { ok: true, sync: result });
  } catch (error) {
    return json(request, { error: errorMessage(error) }, 502);
  }
});
