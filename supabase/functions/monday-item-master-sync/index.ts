import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CANIX_CRON_SECRET = Deno.env.get("CANIX_CRON_SECRET") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_ITEM_MASTER_BOARD_ID =
  Deno.env.get("MONDAY_ITEM_MASTER_BOARD_ID") ??
    "18429359264";
const ITEM_MASTER_GROUP_IDS = Object.freeze(
  {
    "Completed": "group_mm6tbvby",
    "Missing Brand": "group_mm6t1j7h",
    "Missing SKU": "group_mm6tmcfk",
    "Missing Type / Category": "group_mm6t9wvz",
    "Missing Quantity Type": "group_mm6thbx3",
    "Missing Facility": "group_mm6thgyw",
    "Missing Multiple": "group_mm6tpz7d",
    "Inactive / Reference": "group_mm6tmshj",
    "Sandbox / Test": "group_mm6te1wm",
  } as const,
);
const SANDBOX_FACILITY_ID = 4546;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

const COLUMNS = Object.freeze({
  canixItemId: "text_mm6ttbmr",
  completeness: "color_mm6tsg8f",
  sku: "text_mm6t45z7",
  brand: "text_mm6tm2gh",
  productBrand: "text_mm6t5t6",
  itemType: "text_mm6tvbhq",
  category: "text_mm6tf57h",
  subtype: "text_mm6t4nys",
  quantityType: "text_mm6tqbw5",
  facility: "text_mm6ts7h7",
  active: "color_mm6tz8y1",
  inventoryClass: "text_mm6tvgek",
  packageCount: "numeric_mm6t335z",
  missingFields: "long_text_mm6tedam",
  sourceUpdated: "date_mm6t94gy",
  description: "long_text_mm6txm7v",
  notes: "long_text_mm6tetcj",
  strain: "text_mm6tz7xs",
  unitWeight: "numeric_mm6tdk6h",
  unitWeightUnit: "text_mm6thwn2",
  caseQuantity: "text_mm6trsx8",
  caseUnit: "text_mm6t9yp9",
  ingredients: "long_text_mm6t4ycc",
});

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type BoardItem = {
  id: string;
  name: string;
  updatedAt: string | null;
  groupId: string;
  canixItemId: number | null;
};
type PreparedItem = {
  source: Row;
  canixItemId: number;
  name: string;
  inventoryClass: string;
  completenessStatus: string;
  missingFields: string[];
  columnValues: Row;
  sourceHash: string;
  boardItem: BoardItem | null;
  targetGroupId: string;
  mappingOrigin: "existing_id" | "created";
};

class SyncError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request: Request): string {
  const origin = request.headers.get("origin") ?? "";
  return new Set([
      "https://portal.urbanxtracts.com",
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(origin)
    ? origin
    : "https://portal.urbanxtracts.com";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-cron-secret",
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

function asObject(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function clean(value: unknown, max = 5000): string | null {
  if (value === null || value === undefined) return null;
  const output = String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
  return output || null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  const raw = clean(value, 100);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function exactKey(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function itemBrand(row: Row): string | null {
  const values = [
    clean(row.brand_name, 240),
    clean(row.product_brand_name, 240),
  ]
    .filter((value): value is string => !!value);
  const distinct = Array.from(
    new Map(values.map((value) => [exactKey(value), value])).values(),
  );
  return distinct.length === 1 ? distinct[0] : null;
}

function inventoryClass(row: Row): string {
  const name = clean(row.name, 600) ?? "";
  if (/\b(?:clone|biomass|seeds?)\b/i.test(name)) return "Propagation";
  const bulkIdentity = [
    name,
    clean(row.item_type_name, 240),
    clean(row.item_category_name, 240),
    clean(row.item_sub_type_name, 240),
  ].filter(Boolean).join(" ");
  return /\bbulk\b/i.test(bulkIdentity) ? "Bulk" : "Catalog";
}

function missingFields(row: Row, itemClass: string): string[] {
  const missing: string[] = [];
  if (!clean(row.name, 600)) missing.push("Name");
  if (!clean(row.facility_name, 240)) missing.push("Facility");
  if (!clean(row.quantity_type, 100)) missing.push("Quantity Type");
  if (
    !clean(row.item_type_name, 240) &&
    !clean(row.item_category_name, 240) &&
    !clean(row.item_type, 240)
  ) missing.push("Type / Category");
  // Brand and SKU are catalog requirements, not false exceptions for bulk or
  // plant-material inventory.
  if (itemClass === "Catalog") {
    if (!itemBrand(row)) missing.push("Brand");
    if (!clean(row.sku, 240)) missing.push("SKU");
  }
  return missing;
}

function completenessStatus(row: Row, fields: string[]): string {
  if (Number(row.facility_id) === SANDBOX_FACILITY_ID) return "Sandbox / Test";
  if (row.is_active === false) return "Inactive / Reference";
  if (!fields.length) return "Completed";
  if (fields.length > 1) return "Missing Multiple";
  return ({
    Brand: "Missing Brand",
    SKU: "Missing SKU",
    "Type / Category": "Missing Type / Category",
    "Quantity Type": "Missing Quantity Type",
    Facility: "Missing Facility",
    Name: "Missing Multiple",
  } as Record<string, string>)[fields[0]] ?? "Missing Multiple";
}

function mondayText(value: unknown): string | null {
  const record = asObject(value);
  return clean(record.text, 5000);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function mondayGraphql(
  accessToken: string,
  query: string,
  variables: Row,
  attempt = 0,
): Promise<Row> {
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({})) as Row;
  const errors = Array.isArray(body.errors) ? body.errors as Row[] : [];
  const retryable = response.status === 429 || response.status >= 500 ||
    errors.some((error) =>
      new Set([
        "COMPLEXITY_BUDGET_EXHAUSTED",
        "RATE_LIMIT_EXCEEDED",
      ]).has(String(asObject(error.extensions).code ?? ""))
    );
  if (retryable && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    return mondayGraphql(accessToken, query, variables, attempt + 1);
  }
  if (!response.ok || errors.length) {
    const diagnostic = errors.slice(0, 3).map((error) => {
      const extensions = asObject(error.extensions);
      const code = clean(extensions.code, 120) ?? "MONDAY_ERROR";
      const message = clean(error.message, 300) ?? "request rejected";
      return `${code}: ${message}`;
    }).join(" | ");
    throw new SyncError(
      response.status === 401 ? 409 : 502,
      response.status === 401
        ? "Reconnect Monday before synchronizing the Item Master."
        : `Monday did not complete the Item Master request (HTTP ${response.status}${
          diagnostic ? `; ${diagnostic}` : ""
        }).`,
    );
  }
  return asObject(body.data);
}

async function authenticateCapability(
  request: Request,
  permission: string,
): Promise<Row | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!userResponse.ok || !verifiedTokenHasAal2(authorization)) return null;
  const user = asObject(await userResponse.json());
  const userId = clean(user.id, 100);
  if (!userId) return null;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active,org").eq("id", userId).maybeSingle();
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
  return profile as Row;
}

async function currentCanixItems(): Promise<Row[]> {
  const { data: state, error: stateError } = await service.from(
    "canix_item_sync_state",
  ).select("last_successful_run_id").eq("id", 1).single();
  if (stateError) throw stateError;
  const runId = clean(state?.last_successful_run_id, 100);
  if (!runId) {
    throw new SyncError(
      409,
      "A successful Canix Item Master snapshot is required.",
    );
  }
  const columns = [
    "item_id",
    "name",
    "is_active",
    "item_type",
    "item_type_name",
    "item_category_name",
    "item_sub_type_name",
    "brand_name",
    "product_brand_name",
    "quantity_type",
    "sku",
    "facility_id",
    "facility_name",
    "strain_name",
    "unit_weight",
    "unit_weight_unit",
    "case_quantity",
    "case_quantity_unit",
    "description",
    "notes",
    "public_ingredients",
    "source_updated_at",
  ].join(",");
  const rows: Row[] = [];
  for (let start = 0; start < 10_000; start += 1000) {
    const { data, error } = await service.from("canix_item_current").select(
      columns,
    )
      .eq("sync_run_id", runId).order("item_id", { ascending: true })
      .range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
  throw new SyncError(
    502,
    "The Canix Item Master exceeded the safe synchronization limit.",
  );
}

async function currentPackageCounts(): Promise<Map<number, number>> {
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  ).select("last_successful_run_id").eq("id", 1).single();
  if (stateError) throw stateError;
  const runId = clean(state?.last_successful_run_id, 100);
  const counts = new Map<number, number>();
  if (!runId) return counts;
  for (let start = 0; start < 50_000; start += 1000) {
    const { data, error } = await service.from("canix_package_current")
      .select("item_id").eq("sync_run_id", runId).range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    for (const row of page) {
      const itemId = positiveInteger(row.item_id);
      if (itemId) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
    }
    if (page.length < 1000) return counts;
  }
  throw new SyncError(
    502,
    "The package snapshot exceeded the safe counting limit.",
  );
}

async function mondayBoardItems(accessToken: string): Promise<BoardItem[]> {
  const columnIds = [
    COLUMNS.canixItemId,
  ];
  const first = await mondayGraphql(
    accessToken,
    `query CanixItemMasterBoard($boardIds: [ID!]!, $limit: Int!, $columnIds: [String!]) {
      boards(ids: $boardIds) {
        id
        groups { id title }
        columns { id }
        items_page(limit: $limit) {
          cursor
          items { id name updated_at group { id } column_values(ids: $columnIds) { id text } }
        }
      }
    }`,
    { boardIds: [MONDAY_ITEM_MASTER_BOARD_ID], limit: 250, columnIds },
  );
  const board = Array.isArray(first.boards) ? asObject(first.boards[0]) : {};
  if (String(board.id ?? "") !== MONDAY_ITEM_MASTER_BOARD_ID) {
    throw new SyncError(
      409,
      "The configured Monday Item Master board is unavailable.",
    );
  }
  const boardColumns = new Set(
    (Array.isArray(board.columns) ? board.columns as Row[] : []).map((column) =>
      String(column.id ?? "")
    ),
  );
  const missingColumns = Object.values(COLUMNS).filter((id) =>
    !boardColumns.has(id)
  );
  const groups = Array.isArray(board.groups) ? board.groups as Row[] : [];
  const boardGroupIds = new Set(groups.map((group) => String(group.id ?? "")));
  if (
    missingColumns.length ||
    Object.values(ITEM_MASTER_GROUP_IDS).some((id) => !boardGroupIds.has(id))
  ) {
    throw new SyncError(
      409,
      "The Monday Item Master board schema does not match the pinned configuration.",
    );
  }

  const convert = (item: Row): BoardItem => {
    const values = new Map(
      (Array.isArray(item.column_values) ? item.column_values as Row[] : [])
        .map((value) => [String(value.id ?? ""), value]),
    );
    const rawId = mondayText(values.get(COLUMNS.canixItemId));
    return {
      id: String(item.id ?? ""),
      name: clean(item.name, 600) ?? "",
      updatedAt: iso(item.updated_at),
      groupId: clean(asObject(item.group).id, 240) ?? "",
      canixItemId: positiveInteger(rawId),
    };
  };
  const page = asObject(board.items_page);
  const items = (Array.isArray(page.items) ? page.items as Row[] : []).map(
    convert,
  );
  let cursor = clean(page.cursor, 2000);
  let pageCount = 1;
  while (cursor && pageCount < 40) {
    const next = await mondayGraphql(
      accessToken,
      `query CanixItemMasterBoardNext($cursor: String!, $limit: Int!, $columnIds: [String!]) {
        next_items_page(cursor: $cursor, limit: $limit) {
          cursor
          items { id name updated_at group { id } column_values(ids: $columnIds) { id text } }
        }
      }`,
      { cursor, limit: 250, columnIds },
    );
    const nextPage = asObject(next.next_items_page);
    items.push(
      ...(Array.isArray(nextPage.items) ? nextPage.items as Row[] : []).map(
        convert,
      ),
    );
    cursor = clean(nextPage.cursor, 2000);
    pageCount += 1;
  }
  if (cursor) {
    throw new SyncError(
      502,
      "Monday board pagination did not complete safely.",
    );
  }
  return items;
}

async function allLinks(): Promise<Map<number, Row>> {
  const links = new Map<number, Row>();
  for (let start = 0; start < 10_000; start += 1000) {
    const { data, error } = await service.from("monday_item_master_link")
      .select(
        "canix_item_id,monday_item_id,source_hash,last_monday_updated_at,mapping_origin",
      )
      .range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    for (const row of page) {
      const itemId = positiveInteger(row.canix_item_id);
      if (itemId) links.set(itemId, row);
    }
    if (page.length < 1000) return links;
  }
  throw new SyncError(
    502,
    "The Monday Item Master ledger exceeded the safe limit.",
  );
}

function columnValues(
  row: Row,
  packageCount: number,
  itemClass: string,
  fields: string[],
  completeness: string,
): Row {
  const date = iso(row.source_updated_at)?.slice(0, 10) ?? null;
  return {
    [COLUMNS.canixItemId]: String(positiveInteger(row.item_id) ?? ""),
    [COLUMNS.completeness]: { label: completeness },
    [COLUMNS.sku]: clean(row.sku, 240) ?? "",
    [COLUMNS.brand]: clean(row.brand_name, 240) ?? "",
    [COLUMNS.productBrand]: clean(row.product_brand_name, 240) ?? "",
    [COLUMNS.itemType]: clean(row.item_type_name, 240) ??
      clean(row.item_type, 240) ?? "",
    [COLUMNS.category]: clean(row.item_category_name, 240) ?? "",
    [COLUMNS.subtype]: clean(row.item_sub_type_name, 240) ?? "",
    [COLUMNS.quantityType]: clean(row.quantity_type, 100) ?? "",
    [COLUMNS.facility]: clean(row.facility_name, 240) ?? "",
    [COLUMNS.active]: {
      label: row.is_active === true
        ? "Active"
        : row.is_active === false
        ? "Inactive"
        : "Unknown",
    },
    [COLUMNS.inventoryClass]: itemClass,
    [COLUMNS.packageCount]: String(packageCount),
    [COLUMNS.missingFields]: fields.join("\n"),
    [COLUMNS.sourceUpdated]: date ? { date } : null,
    [COLUMNS.description]: clean(row.description, 10_000) ?? "",
    [COLUMNS.notes]: clean(row.notes, 10_000) ?? "",
    [COLUMNS.strain]: clean(row.strain_name, 240) ?? "",
    [COLUMNS.unitWeight]: numberValue(row.unit_weight) === null
      ? ""
      : String(numberValue(row.unit_weight)),
    [COLUMNS.unitWeightUnit]: clean(row.unit_weight_unit, 100) ?? "",
    [COLUMNS.caseQuantity]: clean(row.case_quantity, 240) ?? "",
    [COLUMNS.caseUnit]: clean(row.case_quantity_unit, 100) ?? "",
    [COLUMNS.ingredients]: clean(row.public_ingredients, 10_000) ?? "",
  };
}

async function prepareItems(
  canixRows: Row[],
  packageCounts: Map<number, number>,
  mondayItems: BoardItem[],
): Promise<{ prepared: PreparedItem[]; conflictIds: Set<number> }> {
  const linkedLists = new Map<number, BoardItem[]>();
  for (const item of mondayItems) {
    if (!item.canixItemId) continue;
    linkedLists.set(item.canixItemId, [
      ...(linkedLists.get(item.canixItemId) ?? []),
      item,
    ]);
  }
  const conflictIds = new Set(
    Array.from(linkedLists.entries()).filter(([, values]) => values.length > 1)
      .map(([itemId]) => itemId),
  );
  const prepared: PreparedItem[] = [];
  for (const source of canixRows) {
    const canixItemId = positiveInteger(source.item_id);
    if (!canixItemId || conflictIds.has(canixItemId)) continue;
    const linked = linkedLists.get(canixItemId) ?? [];
    const boardItem = linked.length === 1 ? linked[0] : null;
    const itemClass = inventoryClass(source);
    const fields = missingFields(source, itemClass);
    const completeness = completenessStatus(source, fields);
    const targetGroupId = ITEM_MASTER_GROUP_IDS[
      completeness as keyof typeof ITEM_MASTER_GROUP_IDS
    ];
    const values = columnValues(
      source,
      packageCounts.get(canixItemId) ?? 0,
      itemClass,
      fields,
      completeness,
    );
    prepared.push({
      source,
      canixItemId,
      name: clean(source.name, 600) ?? `Canix Item ${canixItemId}`,
      inventoryClass: itemClass,
      completenessStatus: completeness,
      missingFields: fields,
      columnValues: values,
      sourceHash: await sha256(JSON.stringify({ values, targetGroupId })),
      boardItem,
      targetGroupId,
      mappingOrigin: linked.length === 1 ? "existing_id" : "created",
    });
  }
  return { prepared, conflictIds };
}

async function mutateBatch(
  accessToken: string,
  items: PreparedItem[],
): Promise<
  Array<
    {
      prepared: PreparedItem;
      mondayItemId: string;
      updatedAt: string | null;
      created: boolean;
    }
  >
> {
  const variables: Row = { boardId: MONDAY_ITEM_MASTER_BOARD_ID };
  const declarations = ["$boardId: ID!"];
  const fields: string[] = [];
  items.forEach((item, index) => {
    variables[`values${index}`] = JSON.stringify(item.columnValues);
    variables[`groupId${index}`] = item.targetGroupId;
    declarations.push(
      `$values${index}: JSON!`,
      `$groupId${index}: String!`,
    );
    if (item.boardItem) {
      variables[`itemId${index}`] = item.boardItem.id;
      declarations.push(`$itemId${index}: ID!`);
      fields.push(`m${index}: change_multiple_column_values(
        board_id: $boardId, item_id: $itemId${index}, column_values: $values${index}
      ) { id updated_at }`);
      if (item.boardItem.groupId !== item.targetGroupId) {
        fields.push(`g${index}: move_item_to_group(
          item_id: $itemId${index}, group_id: $groupId${index}
        ) { id updated_at }`);
      }
    } else {
      variables[`name${index}`] = item.name;
      declarations.push(`$name${index}: String!`);
      fields.push(`m${index}: create_item(
        board_id: $boardId, group_id: $groupId${index}, item_name: $name${index},
        column_values: $values${index}
      ) { id updated_at }`);
    }
  });
  const data = await mondayGraphql(
    accessToken,
    `mutation SyncCanixItemMaster(${declarations.join(", ")}) { ${
      fields.join("\n")
    } }`,
    variables,
  );
  return items.map((prepared, index) => {
    const moved = asObject(data[`g${index}`]);
    const result = Object.keys(moved).length
      ? moved
      : asObject(data[`m${index}`]);
    const mondayItemId = clean(result.id, 100);
    if (!mondayItemId) {
      throw new SyncError(502, "Monday did not confirm an Item Master write.");
    }
    return {
      prepared,
      mondayItemId,
      updatedAt: iso(result.updated_at),
      created: !prepared.boardItem,
    };
  });
}

async function upsertLinks(
  mutations: Awaited<ReturnType<typeof mutateBatch>>,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = mutations.map(({ prepared, mondayItemId, updatedAt }) => ({
    canix_item_id: prepared.canixItemId,
    monday_item_id: Number(mondayItemId),
    source_hash: prepared.sourceHash,
    completeness_status: prepared.completenessStatus,
    inventory_class: prepared.inventoryClass,
    mapping_origin: prepared.mappingOrigin,
    last_monday_updated_at: updatedAt,
    last_synced_at: now,
    updated_at: now,
  }));
  const { error } = await service.from("monday_item_master_link").upsert(rows, {
    onConflict: "canix_item_id",
  });
  if (error) throw error;
}

async function runSync(limit: number): Promise<Row> {
  const runId = crypto.randomUUID();
  const { data: claimResult, error: claimError } = await service.rpc(
    "portal_claim_monday_item_master_sync",
    { p_run_id: runId, p_stale_seconds: 900 },
  );
  if (claimError) throw claimError;
  const claim = asObject(claimResult);
  if (claim.claimed !== true) {
    return { skipped: true, reason: claim.reason ?? "not_claimed" };
  }

  try {
    const accessToken = await mondayAccessToken(service, {
      encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
      clientId: MONDAY_CLIENT_ID,
      clientSecret: MONDAY_CLIENT_SECRET,
    }, ["boards:read", "boards:write"]);
    if (!accessToken) {
      throw new SyncError(
        409,
        "Connect Monday with board read and write access first.",
      );
    }

    const [canixRows, packageCounts, mondayItems, links] = await Promise.all([
      currentCanixItems(),
      currentPackageCounts(),
      mondayBoardItems(accessToken),
      allLinks(),
    ]);
    const { prepared, conflictIds } = await prepareItems(
      canixRows,
      packageCounts,
      mondayItems,
    );
    const unchanged = prepared.filter((item) => {
      const link = links.get(item.canixItemId);
      if (
        !link || String(link.monday_item_id ?? "") !== item.boardItem?.id ||
        link.source_hash !== item.sourceHash ||
        item.boardItem?.groupId !== item.targetGroupId
      ) return false;
      const boardUpdated = item.boardItem?.updatedAt;
      const recordedUpdated = iso(link.last_monday_updated_at);
      return !boardUpdated || boardUpdated === recordedUpdated;
    });
    const unchangedIds = new Set(unchanged.map((item) => item.canixItemId));
    const pending = prepared.filter((item) =>
      !unchangedIds.has(item.canixItemId)
    );
    pending.sort((left, right) => {
      const rank = (item: PreparedItem) => {
        if (Number(item.source.facility_id) === SANDBOX_FACILITY_ID) return 4;
        if (item.source.is_active === false) return 3;
        if (item.inventoryClass === "Catalog") return 0;
        if (item.inventoryClass === "Bulk") return 1;
        return 2;
      };
      return rank(left) - rank(right) || left.canixItemId - right.canixItemId;
    });
    const selected = pending.slice(0, limit);
    let created = 0;
    let updated = 0;
    for (let index = 0; index < selected.length; index += 20) {
      const result = await mutateBatch(
        accessToken,
        selected.slice(index, index + 20),
      );
      await upsertLinks(result);
      created += result.filter((entry) => entry.created).length;
      updated += result.filter((entry) => !entry.created).length;
    }
    const sourceRemaining = Math.max(0, pending.length - selected.length);
    const remaining = sourceRemaining;
    const processed = selected.length;
    const { data: finished, error: finishError } = await service.rpc(
      "portal_finish_monday_item_master_sync",
      {
        p_run_id: runId,
        p_source_item_count: canixRows.length,
        p_board_item_count: mondayItems.length + created,
        p_processed_count: processed,
        p_created_count: created,
        p_updated_count: updated,
        p_unchanged_count: unchanged.length,
        p_pending_count: remaining,
        p_conflict_count: conflictIds.size,
      },
    );
    if (finishError) throw finishError;
    if (finished !== true) {
      throw new SyncError(409, "Monday Item Master sync ownership was lost.");
    }
    return {
      runId,
      boardId: MONDAY_ITEM_MASTER_BOARD_ID,
      sourceItems: canixRows.length,
      boardItems: mondayItems.length + created,
      processed,
      created,
      updated,
      unchanged: unchanged.length,
      pending: remaining,
      conflicts: conflictIds.size,
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unexpected Monday Item Master error";
    await service.from("monday_item_master_sync_state").update({
      status: "error",
      active_run_id: null,
      last_completed_at: new Date().toISOString(),
      last_error: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    }).eq("id", 1).eq("active_run_id", runId);
    throw error;
  }
}

async function runScheduledSync(limit: number): Promise<void> {
  const result = await runSync(limit);
  if (Number(result.pending ?? 0) <= 0 || result.skipped === true) return;
  // Continue the one-time backfill in a fresh Edge invocation so every 100
  // writes has its own runtime budget. Once pending reaches zero, only the
  // five-minute incremental scheduler remains.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/monday-item-master-sync`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": CANIX_CRON_SECRET,
      },
      body: JSON.stringify({
        source: "backfill-continuation",
        limit: DEFAULT_LIMIT,
      }),
    },
  );
  if (!response.ok) {
    throw new Error("Monday Item Master continuation was not accepted.");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    if (request.method === "GET") {
      const profile = await authenticateCapability(request, "inventory.read");
      if (!profile) return json(request, { error: "Forbidden" }, 403);
      const { data, error } = await service.from(
        "monday_item_master_sync_state",
      )
        .select(
          "status,last_started_at,last_completed_at,last_successful_at,source_item_count,board_item_count,processed_count,created_count,updated_count,unchanged_count,pending_count,conflict_count,last_error",
        )
        .eq("id", 1).single();
      if (error) throw error;
      return json(request, {
        boardId: MONDAY_ITEM_MASTER_BOARD_ID,
        sync: data,
      });
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
    const body = asObject(await request.json().catch(() => ({})));
    const requestedLimit = positiveInteger(body.limit) ?? DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, requestedLimit);
    const edgeRuntime = (globalThis as unknown as {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }).EdgeRuntime;
    if (cronAuthorized && edgeRuntime) {
      edgeRuntime.waitUntil(runScheduledSync(limit));
      return json(request, { ok: true, sync: { scheduled: true, limit } }, 202);
    }
    const result = await runSync(limit);
    if (profile) {
      await service.from("portal_admin_audit").insert({
        actor_id: profile.id,
        actor_org: profile.org,
        action: "monday.item_master_synced",
        detail: result,
      });
    }
    return json(request, { ok: true, sync: result });
  } catch (error) {
    const status = error instanceof SyncError ? error.status : 502;
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected Monday Item Master error",
    }, status);
  }
});
