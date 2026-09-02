import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { approvedHttpsUrl } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_PRODUCT_SECRET = Deno.env.get("MONDAY_PRODUCT_SECRET") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_PRODUCT_BOARD_ID = Deno.env.get("MONDAY_PRODUCT_BOARD_ID") ??
  "9620649212";
const MONDAY_PRODUCT_COLUMNS = Object.freeze({
  brandName: "short_textwtwb2vrw",
  productType: "dropdown_mksz27fn",
  strainFlavor: "text_mm1213qv",
  productBatchId: "text_mm0zvezb",
  canixItemId: "text_mm6shxmd",
  publicationState: "color_mm6sxyjd",
  shortDescription: "long_text_mm6srkee",
  longDescription: "long_text_mm6s9nke",
  sellingPoints: "long_text_mm6sf7mn",
  ingredients: "long_text_mm6sj45t",
  usageInformation: "long_text_mm6snz4t",
  productProfile: "long_text_mm6s7859",
  imageUrl: "link_mm6scxse",
  keywords: "long_text_mm6svyb9",
});
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

function splitLines(value: unknown): string[] {
  return cleanList(
    String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(
      Boolean,
    ),
    20,
    300,
  );
}

function splitKeywords(value: unknown): string[] {
  return cleanList(
    String(value ?? "").split(/[,\r\n]+/).map((item) => item.trim()).filter(
      Boolean,
    ),
    50,
    100,
  );
}

async function mondayGraphql(
  accessToken: string,
  query: string,
  variables: Row,
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
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    throw new ProductError(
      response.status === 401 ? 409 : 502,
      response.status === 401
        ? "Reconnect Monday before managing catalog content."
        : "Monday did not complete the catalog request.",
    );
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

function mondayColumnValues(item: Row): Map<string, Row> {
  return new Map(
    (Array.isArray(item.column_values) ? item.column_values as Row[] : [])
      .map((value) => [String(value.id ?? ""), value]),
  );
}

function mondayText(
  columns: Map<string, Row>,
  columnId: string,
): string | null {
  return clean(columns.get(columnId)?.text, 5000);
}

function mondayLink(
  columns: Map<string, Row>,
  columnId: string,
): string | null {
  const value = columns.get(columnId);
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value.value ?? "{}")) as Row;
    return clean(parsed.url, 2000) ?? clean(value.text, 2000);
  } catch {
    return clean(value.text, 2000);
  }
}

function mondayPublicationState(value: unknown): string | null {
  const state = String(value ?? "").trim().toLowerCase();
  return new Set(["draft", "published", "archived"]).has(state) ? state : null;
}

async function mondayProductItems(accessToken: string): Promise<Row[]> {
  const columnIds = Object.values(MONDAY_PRODUCT_COLUMNS);
  const firstData = await mondayGraphql(
    accessToken,
    `query PortalCatalogBoard(
      $boardIds: [ID!]!, $limit: Int!, $columnIds: [String!]
    ) {
      boards(ids: $boardIds) {
        id
        items_page(limit: $limit) {
          cursor
          items {
            id name updated_at
            group { id title }
            column_values(ids: $columnIds) { id text value }
          }
        }
      }
    }`,
    {
      boardIds: [MONDAY_PRODUCT_BOARD_ID],
      limit: 250,
      columnIds,
    },
  );
  const boards = Array.isArray(firstData.boards)
    ? firstData.boards as Row[]
    : [];
  const board = boards[0];
  if (!board || String(board.id ?? "") !== MONDAY_PRODUCT_BOARD_ID) {
    throw new ProductError(
      409,
      "The configured Monday catalog board is unavailable.",
    );
  }
  const firstPage = board.items_page && typeof board.items_page === "object"
    ? board.items_page as Row
    : {};
  const items = Array.isArray(firstPage.items)
    ? [...firstPage.items as Row[]]
    : [];
  let cursor = clean(firstPage.cursor, 2000);
  let pageCount = 1;
  while (cursor && pageCount < 40) {
    const pageData = await mondayGraphql(
      accessToken,
      `query PortalCatalogBoardNext(
        $cursor: String!, $limit: Int!, $columnIds: [String!]
      ) {
        next_items_page(cursor: $cursor, limit: $limit) {
          cursor
          items {
            id name updated_at
            group { id title }
            column_values(ids: $columnIds) { id text value }
          }
        }
      }`,
      { cursor, limit: 250, columnIds },
    );
    const page = pageData.next_items_page &&
        typeof pageData.next_items_page === "object"
      ? pageData.next_items_page as Row
      : {};
    if (Array.isArray(page.items)) items.push(...page.items as Row[]);
    cursor = clean(page.cursor, 2000);
    pageCount += 1;
  }
  if (cursor) {
    throw new ProductError(
      502,
      "Monday catalog pagination did not complete safely.",
    );
  }
  return items;
}

function identityKey(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function normalizedIdentityKey(value: unknown): string {
  return String(value ?? "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function brandKey(value: unknown): string {
  const normalized = normalizedIdentityKey(value);
  return ({
    "bud ese": "bud ese",
    cannaprint: "cannaprint",
    cannaprints: "cannaprint",
  } as Record<string, string>)[normalized] ?? normalized;
}

function mondayGroupTitle(item: Row): string {
  const group = item.group && typeof item.group === "object"
    ? item.group as Row
    : {};
  return clean(group.title, 240) ?? "";
}

function mondayMappingEligible(item: Row): boolean {
  return !new Set(["no longer valid", "non cannabis"]).has(
    normalizedIdentityKey(mondayGroupTitle(item)),
  );
}

type CanixCatalogItem = {
  itemId: number;
  itemName: string;
  sku: string | null;
  brands: string[];
  category: string | null;
  subcategory: string | null;
  quantityType: string | null;
  packageCount: number;
};

type MappingSuggestion = {
  mondayItemId: string;
  mondayItemName: string;
  mondayBrand: string | null;
  mondayProductType: string | null;
  mondayStrainFlavor: string | null;
  mondayGroup: string;
  mondayUrl: string;
  canixItemId: number;
  canixItemName: string;
  canixSku: string | null;
  canixBrand: string | null;
  canixCategory: string | null;
  packageCount: number;
  matchKind: "exact_name_brand" | "normalized_name_brand";
  matchLabel: string;
};

async function currentCanixCatalogItems(): Promise<CanixCatalogItem[]> {
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  ).select("last_successful_run_id").eq("id", 1).single();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) {
    throw new ProductError(
      409,
      "A successful Canix snapshot is required before product mappings can be reviewed.",
    );
  }
  const rows: Row[] = [];
  for (let start = 0; start < 20000; start += 1000) {
    const { data, error } = await service.from("canix_package_current").select(
      "package_id,item_id,item_name,sku,brand_name,item_category_name,item_sub_category_name,quantity_type",
    ).eq("sync_run_id", state.last_successful_run_id).order("package_id", {
      ascending: true,
    }).range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < 1000) break;
    if (start === 19000) {
      throw new ProductError(
        502,
        "The current Canix snapshot is too large to audit safely in one request.",
      );
    }
  }
  const grouped = new Map<number, CanixCatalogItem>();
  for (const row of rows) {
    const itemId = Number(row.item_id);
    const itemName = clean(row.item_name, 600);
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || !itemName) continue;
    const current = grouped.get(itemId) ?? {
      itemId,
      itemName,
      sku: clean(row.sku, 200),
      brands: [],
      category: clean(row.item_category_name, 240),
      subcategory: clean(row.item_sub_category_name, 240),
      quantityType: clean(row.quantity_type, 80),
      packageCount: 0,
    };
    const brand = clean(row.brand_name, 240);
    if (brand && !current.brands.includes(brand)) current.brands.push(brand);
    current.packageCount += 1;
    grouped.set(itemId, current);
  }
  return Array.from(grouped.values());
}

function uniqueByKey<T>(
  values: T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

async function catalogMappingAudit(
  accessToken: string,
): Promise<{ summary: Row; suggestions: MappingSuggestion[] }> {
  const [mondayItems, canixItems] = await Promise.all([
    mondayProductItems(accessToken),
    currentCanixCatalogItems(),
  ]);
  const eligible = mondayItems.filter(mondayMappingEligible);
  const unmapped = eligible.filter((item) => {
    const columns = mondayColumnValues(item);
    return !mondayText(columns, MONDAY_PRODUCT_COLUMNS.canixItemId);
  });
  const mondayStrict = uniqueByKey(unmapped, (item) => identityKey(item.name));
  const mondayNormalized = uniqueByKey(
    unmapped,
    (item) => normalizedIdentityKey(item.name),
  );
  const canixStrict = uniqueByKey(
    canixItems,
    (item) => identityKey(item.itemName),
  );
  const canixNormalized = uniqueByKey(
    canixItems,
    (item) => normalizedIdentityKey(item.itemName),
  );
  const suggestions: MappingSuggestion[] = [];
  const pairedMonday = new Set<string>();
  const pairedCanix = new Set<number>();
  const brandConflicts = new Set<string>();
  const ambiguousNameCollisions = new Set<string>();

  function consider(
    mondayGroups: Map<string, Row[]>,
    canixGroups: Map<string, CanixCatalogItem[]>,
    matchKind: MappingSuggestion["matchKind"],
  ): void {
    for (const [key, mondayMatches] of mondayGroups) {
      const canixMatches = canixGroups.get(key) ?? [];
      if (!canixMatches.length) continue;
      if (mondayMatches.length !== 1 || canixMatches.length !== 1) {
        ambiguousNameCollisions.add(
          [
            ...mondayMatches.map((item) => `m${String(item.id ?? "")}`),
            ...canixMatches.map((item) => `c${item.itemId}`),
          ].sort().join(":"),
        );
        continue;
      }
      const monday = mondayMatches[0];
      const canix = canixMatches[0];
      const mondayId = String(monday.id ?? "");
      if (pairedMonday.has(mondayId) || pairedCanix.has(canix.itemId)) continue;
      const columns = mondayColumnValues(monday);
      const mondayBrand = mondayText(columns, MONDAY_PRODUCT_COLUMNS.brandName);
      const matchesBrand = !!mondayBrand &&
        canix.brands.some((brand) => brandKey(brand) === brandKey(mondayBrand));
      if (!matchesBrand) {
        brandConflicts.add(`${mondayId}:${canix.itemId}`);
        continue;
      }
      suggestions.push({
        mondayItemId: mondayId,
        mondayItemName: clean(monday.name, 600) ?? "Unnamed Monday item",
        mondayBrand,
        mondayProductType: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.productType,
        ),
        mondayStrainFlavor: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.strainFlavor,
        ),
        mondayGroup: mondayGroupTitle(monday),
        mondayUrl:
          `https://urban915991.monday.com/boards/${MONDAY_PRODUCT_BOARD_ID}/pulses/${mondayId}`,
        canixItemId: canix.itemId,
        canixItemName: canix.itemName,
        canixSku: canix.sku,
        canixBrand: canix.brands[0] ?? null,
        canixCategory: canix.category,
        packageCount: canix.packageCount,
        matchKind,
        matchLabel: matchKind === "exact_name_brand"
          ? "Exact product name + brand"
          : "Normalized product name + brand",
      });
      pairedMonday.add(mondayId);
      pairedCanix.add(canix.itemId);
    }
  }

  consider(mondayStrict, canixStrict, "exact_name_brand");
  consider(mondayNormalized, canixNormalized, "normalized_name_brand");
  suggestions.sort((left, right) =>
    left.matchKind.localeCompare(right.matchKind) ||
    left.mondayItemName.localeCompare(right.mondayItemName)
  );
  return {
    summary: {
      mondayRows: mondayItems.length,
      canixCurrentItems: canixItems.length,
      mappedRows: eligible.length - unmapped.length,
      unmappedRows: unmapped.length,
      excludedMondayRows: mondayItems.length - eligible.length,
      exactSuggestions:
        suggestions.filter((item) => item.matchKind === "exact_name_brand")
          .length,
      normalizedSuggestions:
        suggestions.filter((item) => item.matchKind === "normalized_name_brand")
          .length,
      brandConflicts: brandConflicts.size,
      ambiguousNameCollisions: ambiguousNameCollisions.size,
      automaticMappingsApplied: 0,
      identityRule:
        "Canix Item ID is the only authoritative join. Name and brand matches are review suggestions only.",
    },
    suggestions: suggestions.slice(0, 200),
  };
}

async function writeMondayMapping(
  accessToken: string,
  mondayItemId: string,
  canixItemId: number,
): Promise<void> {
  const data = await mondayGraphql(
    accessToken,
    `mutation ApprovePortalCatalogMapping(
      $boardId: ID!, $itemId: ID!, $columnValues: JSON!
    ) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $columnValues
      ) { id }
    }`,
    {
      boardId: MONDAY_PRODUCT_BOARD_ID,
      itemId: mondayItemId,
      columnValues: JSON.stringify({
        [MONDAY_PRODUCT_COLUMNS.canixItemId]: String(canixItemId),
        [MONDAY_PRODUCT_COLUMNS.publicationState]: { label: "Draft" },
      }),
    },
  );
  const changed = data.change_multiple_column_values as Row | undefined;
  if (String(changed?.id ?? "") !== mondayItemId) {
    throw new ProductError(
      502,
      "Monday did not confirm the product mapping update.",
    );
  }
}

function mondayProductRecord(
  item: Row,
  canixItemId: number,
  publicationState: string,
): Row {
  const columns = mondayColumnValues(item);
  return {
    canixItemId,
    mondayItemId: String(item.id ?? ""),
    mondayBoardId: MONDAY_PRODUCT_BOARD_ID,
    publicationState,
    shortDescription: mondayText(
      columns,
      MONDAY_PRODUCT_COLUMNS.shortDescription,
    ),
    longDescription: mondayText(
      columns,
      MONDAY_PRODUCT_COLUMNS.longDescription,
    ),
    sellingPoints: splitLines(
      mondayText(columns, MONDAY_PRODUCT_COLUMNS.sellingPoints),
    ),
    ingredients: mondayText(columns, MONDAY_PRODUCT_COLUMNS.ingredients),
    usageInformation: mondayText(
      columns,
      MONDAY_PRODUCT_COLUMNS.usageInformation,
    ),
    productProfile: mondayText(
      columns,
      MONDAY_PRODUCT_COLUMNS.productProfile,
    ),
    imageUrl: mondayLink(columns, MONDAY_PRODUCT_COLUMNS.imageUrl),
    keywords: splitKeywords(
      mondayText(columns, MONDAY_PRODUCT_COLUMNS.keywords),
    ),
    sourceUpdatedAt: iso(item.updated_at),
  };
}

async function approveCatalogMapping(
  caller: Caller,
  body: Row,
): Promise<Row> {
  const mondayItemId = clean(body.mondayItemId, 160) ?? "";
  const canixItemId = Number(body.canixItemId);
  if (
    !/^\d+$/.test(mondayItemId) || !Number.isSafeInteger(canixItemId) ||
    canixItemId <= 0
  ) {
    throw new ProductError(400, "Choose a valid Monday and Canix item pair.");
  }
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read", "boards:write"]);
  if (!accessToken) {
    throw new ProductError(
      409,
      "Reconnect Monday with board read and write access before approving product mappings.",
    );
  }
  const audit = await catalogMappingAudit(accessToken);
  const suggestion = audit.suggestions.find((item) =>
    item.mondayItemId === mondayItemId && item.canixItemId === canixItemId
  );
  if (!suggestion) {
    throw new ProductError(
      409,
      "That suggestion is no longer a unique product-name and brand match. Refresh the review queue.",
    );
  }
  const mondayItems = await mondayProductItems(accessToken);
  const mondayItem = mondayItems.find((item) =>
    String(item.id ?? "") === mondayItemId
  );
  if (!mondayItem) {
    throw new ProductError(
      409,
      "The Monday product row is no longer available.",
    );
  }
  await verifyCanixItems([canixItemId]);
  const { data: existingSource, error: existingSourceError } = await service
    .from("portal_product_content").select("canix_item_id,monday_item_id")
    .eq("canix_item_id", canixItemId).maybeSingle();
  if (existingSourceError) throw existingSourceError;
  if (
    existingSource?.monday_item_id &&
    String(existingSource.monday_item_id) !== mondayItemId
  ) {
    throw new ProductError(
      409,
      "That Canix item is already linked to a different Monday product row.",
    );
  }
  await writeMondayMapping(accessToken, mondayItemId, canixItemId);
  const products = await upsertItems(
    [
      mondayProductRecord(mondayItem, canixItemId, "draft"),
    ],
    caller,
    "monday",
  );
  const detail = {
    mondayItemId,
    mondayItemName: suggestion.mondayItemName,
    canixItemId,
    canixItemName: suggestion.canixItemName,
    matchKind: suggestion.matchKind,
    publicationState: "draft",
  };
  const { error: auditError } = await service.from("portal_admin_audit")
    .insert({
      actor_id: caller.profile.id,
      actor_org: caller.profile.org,
      action: "monday.product_mapping_approved",
      detail,
    });
  if (auditError) throw auditError;
  return { mapping: detail, product: products[0] ?? null };
}

async function currentCanixItemIds(itemIds: number[]): Promise<Set<number>> {
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  ).select("last_successful_run_id").eq("id", 1).single();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) return new Set();
  const found = new Set<number>();
  for (let index = 0; index < itemIds.length; index += 100) {
    const batch = itemIds.slice(index, index + 100);
    const { data, error } = await service.from("canix_package_current").select(
      "item_id",
    ).eq("sync_run_id", state.last_successful_run_id).in("item_id", batch);
    if (error) throw error;
    for (const row of data ?? []) found.add(Number(row.item_id));
  }
  return found;
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

async function syncMondayProductBoard(caller: Caller | null): Promise<Row> {
  if (!/^\d+$/.test(MONDAY_PRODUCT_BOARD_ID)) {
    throw new ProductError(503, "The Monday catalog board is not configured.");
  }
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read"]);
  if (!accessToken) {
    throw new ProductError(
      409,
      "Connect Monday with board read access before synchronizing catalog content.",
    );
  }
  const mondayItems = await mondayProductItems(accessToken);
  const parsed: Array<{ itemId: number; record: Row }> = [];
  let missingCanixItemId = 0;
  let invalidCanixItemId = 0;
  let missingPublicationState = 0;
  for (const item of mondayItems) {
    const columns = mondayColumnValues(item);
    const rawItemId = mondayText(columns, MONDAY_PRODUCT_COLUMNS.canixItemId);
    const publicationState = mondayPublicationState(
      mondayText(columns, MONDAY_PRODUCT_COLUMNS.publicationState),
    );
    if (!rawItemId) {
      missingCanixItemId += 1;
      continue;
    }
    if (!/^\d+$/.test(rawItemId)) {
      invalidCanixItemId += 1;
      continue;
    }
    const canixItemId = Number(rawItemId);
    if (!Number.isSafeInteger(canixItemId) || canixItemId <= 0) {
      invalidCanixItemId += 1;
      continue;
    }
    if (!publicationState) {
      missingPublicationState += 1;
      continue;
    }
    parsed.push({
      itemId: canixItemId,
      record: {
        canixItemId,
        mondayItemId: String(item.id ?? ""),
        mondayBoardId: MONDAY_PRODUCT_BOARD_ID,
        publicationState,
        shortDescription: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.shortDescription,
        ),
        longDescription: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.longDescription,
        ),
        sellingPoints: splitLines(
          mondayText(columns, MONDAY_PRODUCT_COLUMNS.sellingPoints),
        ),
        ingredients: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.ingredients,
        ),
        usageInformation: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.usageInformation,
        ),
        productProfile: mondayText(
          columns,
          MONDAY_PRODUCT_COLUMNS.productProfile,
        ),
        imageUrl: mondayLink(columns, MONDAY_PRODUCT_COLUMNS.imageUrl),
        keywords: splitKeywords(
          mondayText(columns, MONDAY_PRODUCT_COLUMNS.keywords),
        ),
        sourceUpdatedAt: iso(item.updated_at),
      },
    });
  }
  const occurrences = new Map<number, number>();
  for (const entry of parsed) {
    occurrences.set(entry.itemId, (occurrences.get(entry.itemId) ?? 0) + 1);
  }
  const duplicateCanixItemIds = Array.from(occurrences.entries()).filter(
    ([, count]) => count > 1,
  ).map(([itemId]) => itemId);
  const duplicateSet = new Set(duplicateCanixItemIds);
  const unique = parsed.filter((entry) => !duplicateSet.has(entry.itemId));
  const currentIds = await currentCanixItemIds(
    unique.map((entry) => entry.itemId),
  );
  const missingFromCanix = unique.filter((entry) =>
    !currentIds.has(entry.itemId)
  )
    .map((entry) => entry.itemId);
  const accepted = unique.filter((entry) => currentIds.has(entry.itemId));
  let synced = 0;
  for (let index = 0; index < accepted.length; index += 100) {
    const batch = accepted.slice(index, index + 100).map((entry) =>
      entry.record
    );
    const results = await upsertItems(batch, caller, "monday");
    synced += results.length;
  }
  const summary = {
    boardId: MONDAY_PRODUCT_BOARD_ID,
    scanned: mondayItems.length,
    eligible: parsed.length,
    synced,
    missingCanixItemId,
    invalidCanixItemId,
    missingPublicationState,
    duplicateCanixItemIds,
    missingFromCurrentCanix: missingFromCanix,
  };
  let actorId = caller?.profile.id ?? null;
  const actorOrg = caller?.profile.org ?? "urbanXtracts";
  if (!actorId) {
    const { data: connection, error: connectionError } = await service.from(
      "monday_connection_state",
    ).select("connected_by").eq("id", 1).maybeSingle();
    if (connectionError) throw connectionError;
    actorId = connection?.connected_by ?? null;
  }
  if (actorId) {
    const { error: auditError } = await service.from("portal_admin_audit")
      .insert({
        actor_id: actorId,
        actor_org: actorOrg,
        action: "monday.product_content_synced",
        detail: summary,
      });
    if (auditError) throw auditError;
  }
  return summary;
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
    const action = String(body.action ?? "").toLowerCase();
    if (action === "mapping-audit") {
      if (mondayAuthorized || !caller || !caller.canManage) {
        return json(request, { error: "Forbidden" }, 403);
      }
      const accessToken = await mondayAccessToken(service, {
        encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
        clientId: MONDAY_CLIENT_ID,
        clientSecret: MONDAY_CLIENT_SECRET,
      }, ["boards:read"]);
      if (!accessToken) {
        throw new ProductError(
          409,
          "Reconnect Monday with board read access before reviewing product mappings.",
        );
      }
      const audit = await catalogMappingAudit(accessToken);
      return json(request, { ok: true, ...audit }, 200);
    }
    if (action === "approve-mapping") {
      if (mondayAuthorized || !caller || !caller.canManage) {
        return json(request, { error: "Forbidden" }, 403);
      }
      const result = await approveCatalogMapping(caller, body);
      return json(request, { ok: true, ...result }, 200);
    }
    if (action === "sync-monday") {
      if (!mondayAuthorized && (!caller || !caller.canManage)) {
        return json(request, { error: "Forbidden" }, 403);
      }
      const summary = await syncMondayProductBoard(caller);
      return json(request, { ok: true, summary }, 200);
    }
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
