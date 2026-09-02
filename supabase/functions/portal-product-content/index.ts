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
        ? "Reconnect Monday before synchronizing catalog content."
        : "Monday did not return the catalog board.",
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
    if (String(body.action ?? "").toLowerCase() === "sync-monday") {
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
