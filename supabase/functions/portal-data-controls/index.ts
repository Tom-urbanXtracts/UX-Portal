import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = {
  id: string;
  email: string;
  staffRole: string;
  departments: string[];
  permissions: string[];
};

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
    : "https://portal.urbanxtracts.com";
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
      "referrer-policy": "no-referrer",
    },
  });
}

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(clean(value, 40));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function decisionStatus(value: unknown): string {
  const status = clean(value, 40).toLowerCase();
  return new Set([
      "pending_review",
      "approved",
      "conflict",
      "not_required",
      "archived",
    ]).has(status)
    ? status
    : "pending_review";
}

function lotStatus(value: unknown): string {
  const status = clean(value, 40).toLowerCase();
  return new Set([
      "draft",
      "pending_review",
      "approved",
      "rejected",
      "conflict",
      "archived",
    ]).has(status)
    ? status
    : "pending_review";
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  if (!verifiedTokenIsAuthenticated(authorization)) return null;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!authResponse.ok) return null;
  const user = await authResponse.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") {
    return null;
  }
  const [{ data: permissionRows }, { data: departmentRows }] = await Promise
    .all([
      service.from("portal_role_permission").select("permission").eq(
        "staff_role",
        profile.staff_role,
      ),
      service.from("portal_profile_department").select("department_key").eq(
        "profile_id",
        profile.id,
      ).eq("status", "active"),
    ]);
  return {
    id: String(profile.id),
    email: clean(user.email, 320),
    staffRole: clean(profile.staff_role, 80),
    departments: (departmentRows ?? []).map((row) =>
      clean(row.department_key, 80)
    ),
    permissions: (permissionRows ?? []).map((row) =>
      clean(row.permission, 100)
    ),
  };
}

function canRead(caller: Caller): boolean {
  return caller.permissions.includes("inventory.read") ||
    caller.permissions.includes("financials.read") ||
    caller.departments.includes("finance") ||
    caller.staffRole === "administrator";
}

function canManageData(caller: Caller): boolean {
  return ["administrator", "operations"].includes(caller.staffRole);
}

function canManageCostObjects(caller: Caller): boolean {
  return caller.permissions.includes("cost_objects.manage") ||
    caller.departments.includes("finance") ||
    caller.staffRole === "administrator";
}

async function allCurrentPackages(): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await service.from("canix_package_current").select(
      "package_id,tag,item_id,item_name,brand_name,canix_package_owner_id,canix_package_owner_name,lot_id,status,status_category,source_updated_at",
    ).order("package_id", { ascending: true }).range(
      offset,
      offset + pageSize - 1,
    );
    if (error) throw error;
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function allCurrentItems(): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await service.from("canix_item_current").select(
      "item_id,name,is_active,item_type_name,item_category_name,brand_name,product_brand_name,sku,facility_name,source_updated_at",
    ).order("item_id", { ascending: true }).range(
      offset,
      offset + pageSize - 1,
    );
    if (error) throw error;
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function normalizedLotId(value: unknown): string | null {
  const valueString = clean(value, 80).toUpperCase();
  return /^[A-Z0-9-]{1,40}$/.test(valueString) ? valueString : null;
}

async function event(
  caller: Caller,
  controlType: string,
  controlKey: string,
  action: string,
  prior: Row | null,
  current: Row,
): Promise<void> {
  const { error } = await service.from("portal_data_control_event").insert({
    control_type: controlType,
    control_key: controlKey,
    action,
    prior_state: prior,
    current_state: current,
    actor_id: caller.id,
    actor_email: caller.email,
  });
  if (error) throw error;
}

function eventAction(prior: Row | null, status: string): string {
  if (status === "not_required") return "not_required";
  if (status === "conflict") return "conflict";
  if (status === "archived") return "archived";
  if (status === "pending_review") return prior ? "returned" : "created";
  return prior ? "replaced" : "approved";
}

async function snapshot(caller: Caller): Promise<Row> {
  const [
    owners,
    packageLots,
    items,
    lots,
    costObjects,
    parties,
    skuRows,
    catalogRows,
    events,
    packageSources,
    itemSources,
    packageSync,
    itemSync,
  ] = await Promise.all([
    service.from("portal_canix_owner_mapping").select("*").order("updated_at", {
      ascending: false,
    }).limit(2500),
    service.from("portal_package_lot_overlay").select("*").order("updated_at", {
      ascending: false,
    }).limit(5000),
    service.from("portal_item_identity_mapping").select("*").order(
      "updated_at",
      { ascending: false },
    ).limit(5000),
    service.from("portal_lot_register").select("*").order("updated_at", {
      ascending: false,
    }).limit(5000),
    service.from("portal_lot_cost_object_decision").select("*").order(
      "updated_at",
      { ascending: false },
    ).limit(5000),
    service.from("portal_economic_party").select(
      "id,party_code,display_name,active",
    ).eq("active", true).order("display_name"),
    service.from("portal_sku_intake").select(
      "id,reference,brand_name,product_name,status",
    ).order("updated_at", { ascending: false }).limit(2500),
    service.from("portal_product_content").select(
      "canix_item_id,publication_state,workflow_state,completeness_score,approved_at,scheduled_publish_at,updated_at",
    ).order("updated_at", { ascending: false }).limit(5000),
    service.from("portal_data_control_event").select(
      "id,control_type,control_key,action,actor_email,created_at",
    ).order("created_at", { ascending: false }).limit(100),
    allCurrentPackages(),
    allCurrentItems(),
    service.from("canix_sync_state").select(
      "status,last_successful_at,latest_source_updated_at,package_count,last_error",
    ).eq("id", 1).maybeSingle(),
    service.from("canix_item_sync_state").select(
      "status,last_successful_at,latest_source_updated_at,item_count,last_error",
    ).eq("id", 1).maybeSingle(),
  ]);
  const resultSets = [
    owners,
    packageLots,
    items,
    lots,
    costObjects,
    parties,
    skuRows,
    catalogRows,
    events,
    packageSync,
    itemSync,
  ];
  const failed = resultSets.find((result) => result.error);
  if (failed?.error) throw failed.error;
  const lotRows = lots.data ?? [];
  const savedOwnerRows = owners.data ?? [];
  const savedPackageLotRows = packageLots.data ?? [];
  const savedItemRows = items.data ?? [];
  const catalog = catalogRows.data ?? [];
  const savedOwnerById = new Map(
    savedOwnerRows.map((row) => [String(row.canix_owner_id), row]),
  );
  const savedPackageLotById = new Map(
    savedPackageLotRows.map((row) => [String(row.canix_package_id), row]),
  );
  const savedItemById = new Map(
    savedItemRows.map((row) => [String(row.canix_item_id), row]),
  );
  const approvedLots = new Set(
    lotRows.filter((row) => row.approval_status === "approved").map((row) =>
      clean(row.lot_id, 40)
    ),
  );
  const ownerGroups = new Map<string, Row>();
  let packagesMissingOwner = 0;
  for (const row of packageSources) {
    const ownerId = positiveInteger(row.canix_package_owner_id);
    if (!ownerId) {
      packagesMissingOwner += 1;
      continue;
    }
    const key = String(ownerId);
    const current = ownerGroups.get(key) ?? {
      canix_owner_id: ownerId,
      canix_owner_name: clean(row.canix_package_owner_name, 200) || null,
      package_count: 0,
      source_discovery: true,
    };
    current.package_count = Number(current.package_count ?? 0) + 1;
    if (!current.canix_owner_name && row.canix_package_owner_name) {
      current.canix_owner_name = clean(row.canix_package_owner_name, 200);
    }
    ownerGroups.set(key, current);
  }
  const ownerRows = Array.from(ownerGroups.entries()).map(([key, source]) => ({
    ...source,
    decision_status: "pending_review",
    decision_note: "",
    ...(savedOwnerById.get(key) ?? {}),
  }));
  for (const saved of savedOwnerRows) {
    if (!ownerGroups.has(String(saved.canix_owner_id))) {
      ownerRows.push({ ...saved, source_discovery: false, package_count: 0 });
    }
  }

  const packageLotRows = packageSources.flatMap((source) => {
    const key = String(source.package_id);
    const saved = savedPackageLotById.get(key);
    const sourceLotId = normalizedLotId(source.lot_id);
    const sourceLotStatus = !sourceLotId
      ? "missing"
      : approvedLots.has(sourceLotId)
      ? "approved"
      : "unapproved_or_unknown";
    if (!saved && sourceLotStatus === "approved") return [];
    return [{
      canix_package_id: source.package_id,
      compliance_tag: source.tag ?? null,
      lot_id: sourceLotId,
      decision_status: "pending_review",
      decision_note: "",
      source_lot_id: sourceLotId,
      source_lot_status: sourceLotStatus,
      canix_item_id: source.item_id ?? null,
      canix_item_name: source.item_name ?? null,
      canix_brand_name: source.brand_name ?? null,
      package_status: source.status ?? source.status_category ?? null,
      source_updated_at: source.source_updated_at ?? null,
      source_discovery: true,
      ...(saved ?? {}),
    }];
  });
  for (const saved of savedPackageLotRows) {
    if (
      !packageSources.some((row) =>
        String(row.package_id) === String(saved.canix_package_id)
      )
    ) {
      packageLotRows.push({
        ...saved,
        source_discovery: false,
        source_lot_status: "not_in_current_snapshot",
      });
    }
  }

  const itemRows = itemSources.map((source) => {
    const key = String(source.item_id);
    return {
      canix_item_id: source.item_id,
      canix_item_name: source.name ?? null,
      canix_brand_name: source.product_brand_name ?? source.brand_name ?? null,
      canix_sku: source.sku ?? null,
      canix_item_type: source.item_type_name ?? source.item_category_name ??
        null,
      canix_facility_name: source.facility_name ?? null,
      canix_active: source.is_active === true,
      decision_status: "pending_review",
      decision_note: "",
      source_updated_at: source.source_updated_at ?? null,
      source_discovery: true,
      ...(savedItemById.get(key) ?? {}),
    };
  });
  const currentItemIds = new Set(itemSources.map((row) => String(row.item_id)));
  for (const saved of savedItemRows) {
    if (!currentItemIds.has(String(saved.canix_item_id))) {
      itemRows.push({ ...saved, source_discovery: false, canix_active: false });
    }
  }
  return {
    source: {
      system: "Supabase",
      mode: "portal_overlay",
      writesToCanix: false,
      retrievedAt: new Date().toISOString(),
      canixPackages: packageSync.data ?? null,
      canixItems: itemSync.data ?? null,
    },
    permissions: {
      canManageData: canManageData(caller),
      canManageCostObjects: canManageCostObjects(caller),
    },
    summary: {
      ownerMappings: ownerRows.length,
      ownerPending:
        ownerRows.filter((row) =>
          row.decision_status !== "approved" &&
          row.decision_status !== "not_required"
        ).length,
      packageLotOverlays: packageLotRows.length,
      packageLotPending:
        packageLotRows.filter((row) =>
          row.decision_status !== "approved" &&
          row.decision_status !== "not_required"
        ).length,
      itemMappings: itemRows.length,
      itemPending:
        itemRows.filter((row) =>
          row.decision_status !== "approved" &&
          row.decision_status !== "not_required"
        ).length,
      lots: lotRows.length,
      lotsPending: lotRows.filter((row) =>
        row.approval_status !== "approved" &&
        row.approval_status !== "archived"
      ).length,
      catalogRecords: catalog.length,
      catalogPending:
        catalog.filter((row) => row.publication_state !== "published").length,
      sourcePackages: packageSources.length,
      packagesMissingOwner,
      sourceItems: itemSources.length,
    },
    ownerMappings: ownerRows,
    packageLots: packageLotRows,
    itemMappings: itemRows,
    lots: lotRows,
    costObjects: costObjects.data ?? [],
    parties: parties.data ?? [],
    skus: skuRows.data ?? [],
    catalog,
    events: events.data ?? [],
  };
}

async function existing(
  table: string,
  column: string,
  value: string | number,
): Promise<Row | null> {
  const { data, error } = await service.from(table).select("*").eq(
    column,
    value,
  ).maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

async function saveOwner(caller: Caller, body: Row): Promise<Row> {
  const ownerId = positiveInteger(body.canixOwnerId);
  if (!ownerId) throw new Error("Choose a valid Canix Owner ID.");
  const status = decisionStatus(body.status);
  const code = clean(body.ownershipCode, 20).toUpperCase() || null;
  if (
    status === "approved" &&
    !new Set(["UX", "TOLL", "SPLIT", "TEST"]).has(code ?? "")
  ) {
    throw new Error(
      "Approved Owner mappings require UX, TOLL, SPLIT, or TEST.",
    );
  }
  const note = clean(body.note, 1500);
  if (status !== "pending_review" && note.length < 8) {
    throw new Error("Enter an evidence note of at least 8 characters.");
  }
  const partyId = clean(body.economicPartyId, 80) || null;
  if (partyId) {
    const party = await existing("portal_economic_party", "id", partyId);
    if (!party || party.active !== true) {
      throw new Error("Choose an active economic party.");
    }
  }
  const prior = await existing(
    "portal_canix_owner_mapping",
    "canix_owner_id",
    ownerId,
  );
  const row = {
    canix_owner_id: ownerId,
    canix_owner_name: clean(body.canixOwnerName, 200) || null,
    economic_party_id: partyId,
    ownership_code: code,
    decision_status: status,
    decision_note: note,
    source_system: "portal",
    approved_by: status === "approved" || status === "not_required"
      ? caller.id
      : null,
    approved_by_email: status === "approved" || status === "not_required"
      ? caller.email
      : null,
    approved_at: status === "approved" || status === "not_required"
      ? new Date().toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_canix_owner_mapping")
    .upsert(row).select("*").single();
  if (error) throw error;
  await event(
    caller,
    "owner_mapping",
    String(ownerId),
    eventAction(prior, status),
    prior,
    data as Row,
  );
  return data as Row;
}

async function savePackageLot(caller: Caller, body: Row): Promise<Row> {
  const packageId = positiveInteger(body.canixPackageId);
  if (!packageId) throw new Error("Choose a valid Canix package ID.");
  const status = decisionStatus(body.status);
  const lotId = clean(body.lotId, 40).toUpperCase() || null;
  if (status === "approved" && (!lotId || !/^[A-Z0-9-]{1,40}$/.test(lotId))) {
    throw new Error("Approved package overlays require a valid Lot ID.");
  }
  if (lotId) {
    const lot = await existing("portal_lot_register", "lot_id", lotId);
    if (!lot || lot.approval_status !== "approved") {
      throw new Error(
        "The Lot ID must be approved in the Portal register first.",
      );
    }
  }
  const note = clean(body.note, 1500);
  if (status !== "pending_review" && note.length < 8) {
    throw new Error("Enter an evidence note of at least 8 characters.");
  }
  const prior = await existing(
    "portal_package_lot_overlay",
    "canix_package_id",
    packageId,
  );
  const row = {
    canix_package_id: packageId,
    compliance_tag: clean(body.complianceTag, 200) || null,
    lot_id: status === "not_required" ? null : lotId,
    decision_status: status,
    decision_note: note,
    source_system: "portal",
    approved_by: status === "approved" || status === "not_required"
      ? caller.id
      : null,
    approved_by_email: status === "approved" || status === "not_required"
      ? caller.email
      : null,
    approved_at: status === "approved" || status === "not_required"
      ? new Date().toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_package_lot_overlay")
    .upsert(row).select("*").single();
  if (error) throw error;
  await event(
    caller,
    "package_lot",
    String(packageId),
    eventAction(prior, status),
    prior,
    data as Row,
  );
  return data as Row;
}

async function saveItem(caller: Caller, body: Row): Promise<Row> {
  const itemId = positiveInteger(body.canixItemId);
  if (!itemId) throw new Error("Choose a valid Canix Item ID.");
  const status = decisionStatus(body.status);
  const skuReference = clean(body.portalSkuReference, 160) || null;
  if (status === "approved" && !skuReference) {
    throw new Error("Approved Item mappings require a Portal SKU reference.");
  }
  const note = clean(body.note, 1500);
  if (status !== "pending_review" && note.length < 8) {
    throw new Error("Enter an evidence note of at least 8 characters.");
  }
  const skuId = clean(body.portalSkuId, 80) || null;
  if (status === "approved") {
    const { data: matchedSku, error: skuError } = skuId
      ? await service.from("portal_sku_intake").select("id,reference").eq(
        "id",
        skuId,
      ).maybeSingle()
      : await service.from("portal_sku_intake").select("id,reference").eq(
        "reference",
        skuReference,
      ).maybeSingle();
    if (skuError) throw skuError;
    if (!matchedSku || clean(matchedSku.reference, 160) !== skuReference) {
      throw new Error(
        "Choose an existing Portal SKU whose reference matches this mapping.",
      );
    }
  }
  const prior = await existing(
    "portal_item_identity_mapping",
    "canix_item_id",
    itemId,
  );
  const row = {
    canix_item_id: itemId,
    portal_sku_reference: status === "not_required" ? null : skuReference,
    portal_sku_id: status === "not_required" ? null : skuId,
    canix_item_name: clean(body.canixItemName, 240) || null,
    canix_brand_name: clean(body.canixBrandName, 200) || null,
    decision_status: status,
    decision_note: note,
    source_system: "portal",
    approved_by: status === "approved" || status === "not_required"
      ? caller.id
      : null,
    approved_by_email: status === "approved" || status === "not_required"
      ? caller.email
      : null,
    approved_at: status === "approved" || status === "not_required"
      ? new Date().toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_item_identity_mapping")
    .upsert(row).select("*").single();
  if (error) throw error;
  await event(
    caller,
    "item_mapping",
    String(itemId),
    eventAction(prior, status),
    prior,
    data as Row,
  );
  return data as Row;
}

async function saveLot(caller: Caller, body: Row): Promise<Row> {
  const lotId = clean(body.lotId, 40).toUpperCase();
  if (!/^[A-Z0-9-]{1,40}$/.test(lotId)) {
    throw new Error("Lot ID must use uppercase letters, numbers, and hyphens.");
  }
  const status = lotStatus(body.status);
  const ownershipCode = clean(body.ownershipCode, 20).toUpperCase() || null;
  if (
    status === "approved" &&
    !new Set(["UX", "TOLL", "SPLIT", "TEST"]).has(ownershipCode ?? "")
  ) {
    throw new Error(
      "Approved lots require UX, TOLL, SPLIT, or TEST ownership.",
    );
  }
  const lotName = clean(body.lotName, 240);
  if (!lotName) throw new Error("Lot name is required.");
  const costObjectCandidate =
    clean(body.costObjectCandidate, 80).toUpperCase() || null;
  if (
    costObjectCandidate &&
    !/^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$/.test(costObjectCandidate)
  ) {
    throw new Error("Cost Object must use DEPT-LINE or DEPT-LINE-VARIANT.");
  }
  const note = clean(body.note, 1500);
  if (
    ["approved", "rejected", "conflict"].includes(status) && note.length < 8
  ) {
    throw new Error("Enter an evidence note of at least 8 characters.");
  }
  const prior = await existing("portal_lot_register", "lot_id", lotId);
  const uomCode = clean(body.uomCode, 20).toUpperCase() || null;
  if (uomCode && !new Set(["G_IN", "G_OUT", "G_DRY", "G_WET"]).has(uomCode)) {
    throw new Error("UOM must be G_IN, G_OUT, G_DRY, or G_WET.");
  }
  const expectedQuantity =
    body.expectedQuantity === "" || body.expectedQuantity === null ||
      body.expectedQuantity === undefined
      ? null
      : Number(body.expectedQuantity);
  const receivedQuantity =
    body.receivedQuantity === "" || body.receivedQuantity === null ||
      body.receivedQuantity === undefined
      ? null
      : Number(body.receivedQuantity);
  if (
    (expectedQuantity !== null &&
      (!Number.isFinite(expectedQuantity) || expectedQuantity < 0)) ||
    (receivedQuantity !== null &&
      (!Number.isFinite(receivedQuantity) || receivedQuantity < 0))
  ) {
    throw new Error("Lot quantities must be valid non-negative numbers.");
  }
  const row = {
    lot_id: lotId,
    lot_name: lotName,
    ownership_code: ownershipCode,
    canix_owner_id: positiveInteger(body.canixOwnerId),
    economic_party_id: clean(body.economicPartyId, 80) || null,
    agreement_reference: clean(body.agreementReference, 240) || null,
    deal_type: clean(body.dealType, 160) || null,
    uom_code: uomCode,
    expected_quantity: expectedQuantity,
    received_quantity: receivedQuantity,
    cost_object_candidate: costObjectCandidate,
    approval_status: status,
    source_system: "portal",
    source_record_id: prior?.source_record_id ?? lotId,
    import_decision: prior?.import_decision ?? "manually_created",
    decision_note: note,
    approved_by: status === "approved" ? caller.id : null,
    approved_by_email: status === "approved" ? caller.email : null,
    approved_at: status === "approved" ? new Date().toISOString() : null,
    effective_date: clean(body.effectiveDate, 20) || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await service.from("portal_lot_register").upsert(row)
    .select("*").single();
  if (error) throw error;
  await event(
    caller,
    "lot_register",
    lotId,
    eventAction(prior, status),
    prior,
    data as Row,
  );
  return data as Row;
}

async function saveCostObject(caller: Caller, body: Row): Promise<Row> {
  if (!canManageCostObjects(caller)) {
    throw new Error(
      "Finance, Operations, or Administrator approval is required.",
    );
  }
  const { data, error } = await service.rpc(
    "portal_set_lot_cost_object_decision",
    {
      p_lot_id: clean(body.lotId, 40),
      p_decision_status: clean(body.status, 40),
      p_cost_object_id: clean(body.costObjectId, 80),
      p_decision_note: clean(body.note, 1500),
      p_actor_id: caller.id,
      p_actor_email: caller.email,
    },
  );
  if (error) throw error;
  return data as Row;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors(request) });
  }
  const caller = await callerFor(request);
  if (!caller || !canRead(caller)) {
    return json(request, { error: "Not authorized" }, 403);
  }
  try {
    if (request.method === "GET") return json(request, await snapshot(caller));
    if (request.method !== "POST") {
      return json(request, { error: "Method not allowed" }, 405);
    }
    const body = await request.json().catch(() => ({})) as Row;
    const action = clean(body.action, 80);
    if (action === "save-cost-object") {
      return json(request, {
        ok: true,
        record: await saveCostObject(caller, body),
      });
    }
    if (!canManageData(caller)) {
      return json(request, {
        error: "Operations or Administrator approval is required.",
      }, 403);
    }
    const handlers: Record<string, () => Promise<Row>> = {
      "save-owner-mapping": () => saveOwner(caller, body),
      "save-package-lot": () => savePackageLot(caller, body),
      "save-item-mapping": () => saveItem(caller, body),
      "save-lot": () => saveLot(caller, body),
    };
    if (!handlers[action]) {
      return json(request, { error: "Unsupported action" }, 400);
    }
    return json(request, { ok: true, record: await handlers[action]() });
  } catch (error) {
    console.error("portal-data-controls", error);
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Data-control request failed.",
    }, 400);
  }
});
