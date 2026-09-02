import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY = Deno.env.get(
  "MONDAY_TOKEN_ENCRYPTION_KEY",
) ?? "";
const LOT_CRON_SECRET = Deno.env.get("PORTAL_LOT_CRON_SECRET") ?? "";
const LOT_BOARD_ID = Deno.env.get("MONDAY_LOT_BOARD_ID") ?? "18429359264";

const COLUMN_IDS = {
  lotId: Deno.env.get("MONDAY_LOT_ID_COLUMN_ID") ?? "text_mm6t4qyx",
  ownershipCode: Deno.env.get("MONDAY_LOT_OWNERSHIP_COLUMN_ID") ??
    "color_mm6t90az",
  partnerId: Deno.env.get("MONDAY_LOT_PARTNER_ID_COLUMN_ID") ??
    "text_mm6txncv",
  economicPartner: Deno.env.get("MONDAY_LOT_PARTNER_COLUMN_ID") ??
    "text_mm6tyag2",
  agreementReference: Deno.env.get("MONDAY_LOT_AGREEMENT_COLUMN_ID") ??
    "text_mm6tyzn8",
  dealType: Deno.env.get("MONDAY_LOT_DEAL_TYPE_COLUMN_ID") ??
    "dropdown_mm6t5e10",
  pricingBasis: Deno.env.get("MONDAY_LOT_PRICING_COLUMN_ID") ??
    "text_mm6tjh9y",
  settlementTrigger: Deno.env.get("MONDAY_LOT_SETTLEMENT_COLUMN_ID") ??
    "text_mm6tbf9z",
  splitTerms: Deno.env.get("MONDAY_LOT_SPLIT_TERMS_COLUMN_ID") ??
    "long_text_mm6tje4s",
  expectedQuantity: Deno.env.get("MONDAY_LOT_EXPECTED_QTY_COLUMN_ID") ??
    "numeric_mm6tr11q",
  uomCode: Deno.env.get("MONDAY_LOT_UOM_COLUMN_ID") ?? "color_mm6tkx5z",
  receivedQuantity: Deno.env.get("MONDAY_LOT_RECEIVED_QTY_COLUMN_ID") ??
    "numeric_mm6terkb",
  metrcTransferReference: Deno.env.get("MONDAY_LOT_METRC_COLUMN_ID") ??
    "text_mm6tmt30",
  canixPackageReferences: Deno.env.get("MONDAY_LOT_PACKAGES_COLUMN_ID") ??
    "long_text_mm6ty9mn",
  costObjectId: Deno.env.get("MONDAY_LOT_COST_OBJECT_COLUMN_ID") ??
    "text_mm6tm2f9",
  approvalStatus: Deno.env.get("MONDAY_LOT_APPROVAL_COLUMN_ID") ??
    "color_mm6tjtab",
  approvedBy: Deno.env.get("MONDAY_LOT_APPROVER_COLUMN_ID") ??
    "multiple_person_mm6t4yeg",
  effectiveDate: Deno.env.get("MONDAY_LOT_EFFECTIVE_DATE_COLUMN_ID") ??
    "date_mm6te3t3",
  approvalDate: Deno.env.get("MONDAY_LOT_APPROVAL_DATE_COLUMN_ID") ??
    "date_mm6tee1s",
} as const;

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { id: string; org: string; staffRole: string };

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
      "referrer-policy": "no-referrer",
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function clean(value: unknown, max = 1000): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function dateOrNull(value: unknown): string | null {
  const text = clean(value, 40);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isoOrNull(value: unknown): string | null {
  const parsed = value ? new Date(String(value)) : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : null;
}

async function callerFor(
  request: Request,
  permission: string,
): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok || !verifiedTokenHasAal2(authorization)) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (
    !profile || profile.active === false || profile.role !== "internal" ||
    !profile.staff_role
  ) return null;
  const { data: grant } = await service.from("portal_role_permission").select(
    "permission",
  ).eq("staff_role", profile.staff_role).eq("permission", permission)
    .maybeSingle();
  return grant
    ? {
      id: String(profile.id),
      org: String(profile.org || "urbanXtracts"),
      staffRole: String(profile.staff_role),
    }
    : null;
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
      "api-version": "2026-04",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({})) as Row;
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    throw new Error("Monday did not return the protected lot register.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

function pageFrom(value: unknown): { cursor: string | null; items: Row[] } {
  const row = value && typeof value === "object" ? value as Row : {};
  return {
    cursor: clean(row.cursor, 2000),
    items: Array.isArray(row.items) ? row.items as Row[] : [],
  };
}

async function fetchMondayItems(accessToken: string): Promise<Row[]> {
  const first = await mondayGraphql(
    accessToken,
    `query LotRegister($boardIds: [ID!]!, $columnIds: [String!]) {
      boards(ids: $boardIds) {
        id
        items_page(limit: 500) {
          cursor
          items {
            id name updated_at
            column_values(ids: $columnIds) { id text value }
          }
        }
      }
    }`,
    { boardIds: [LOT_BOARD_ID], columnIds: Object.values(COLUMN_IDS) },
  );
  const boards = Array.isArray(first.boards) ? first.boards as Row[] : [];
  if (boards.length !== 1 || String(boards[0].id ?? "") !== LOT_BOARD_ID) {
    throw new Error("The configured Monday lot-register board is unavailable.");
  }
  let page = pageFrom(boards[0].items_page);
  const items = [...page.items];
  while (page.cursor) {
    const next = await mondayGraphql(
      accessToken,
      `query NextLotRegisterPage($cursor: String!, $columnIds: [String!]) {
        next_items_page(limit: 500, cursor: $cursor) {
          cursor
          items {
            id name updated_at
            column_values(ids: $columnIds) { id text value }
          }
        }
      }`,
      { cursor: page.cursor, columnIds: Object.values(COLUMN_IDS) },
    );
    page = pageFrom(next.next_items_page);
    items.push(...page.items);
    if (items.length > 10_000) {
      throw new Error("Monday lot register exceeds the supported 10,000 rows.");
    }
  }
  return items;
}

function normalizeItem(item: Row): Row {
  const values = new Map<string, string>();
  for (
    const value of Array.isArray(item.column_values)
      ? item.column_values as Row[]
      : []
  ) {
    values.set(String(value.id ?? ""), String(value.text ?? "").trim());
  }
  const read = (id: string, max = 1000) => clean(values.get(id), max);
  return {
    monday_item_id: clean(item.id, 80),
    monday_item_name: clean(item.name, 255),
    source_lot_id: read(COLUMN_IDS.lotId, 200),
    ownership_code: read(COLUMN_IDS.ownershipCode, 40),
    partner_id: read(COLUMN_IDS.partnerId, 200),
    economic_partner: read(COLUMN_IDS.economicPartner, 300),
    agreement_reference: read(COLUMN_IDS.agreementReference, 500),
    deal_type: read(COLUMN_IDS.dealType, 120),
    pricing_basis: read(COLUMN_IDS.pricingBasis, 500),
    settlement_trigger: read(COLUMN_IDS.settlementTrigger, 500),
    split_terms: read(COLUMN_IDS.splitTerms, 4000),
    expected_quantity: numberOrNull(read(COLUMN_IDS.expectedQuantity, 80)),
    uom_code: read(COLUMN_IDS.uomCode, 40),
    received_quantity: numberOrNull(read(COLUMN_IDS.receivedQuantity, 80)),
    metrc_transfer_reference: read(
      COLUMN_IDS.metrcTransferReference,
      500,
    ),
    canix_package_references: read(
      COLUMN_IDS.canixPackageReferences,
      10_000,
    ),
    cost_object_id: read(COLUMN_IDS.costObjectId, 200),
    approval_status: read(COLUMN_IDS.approvalStatus, 80),
    approved_by: read(COLUMN_IDS.approvedBy, 500),
    effective_date: dateOrNull(read(COLUMN_IDS.effectiveDate, 40)),
    approval_date: dateOrNull(read(COLUMN_IDS.approvalDate, 40)),
    source_updated_at: isoOrNull(item.updated_at),
    raw_payload: {
      id: clean(item.id, 80),
      name: clean(item.name, 255),
      updated_at: isoOrNull(item.updated_at),
      column_values: Array.isArray(item.column_values)
        ? item.column_values
        : [],
    },
  };
}

async function syncRegister(caller: Caller | null): Promise<Row> {
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read"]);
  if (!accessToken) {
    throw new Error("Monday must be connected with boards:read access.");
  }
  const rows = (await fetchMondayItems(accessToken)).map(normalizeItem);
  const { data, error } = await service.rpc("portal_publish_monday_lots", {
    p_board_id: LOT_BOARD_ID,
    p_rows: rows,
  });
  if (error) throw error;
  await service.from("portal_admin_audit").insert({
    actor_id: caller?.id ?? null,
    actor_org: caller?.org ?? "urbanXtracts",
    action: "monday.lot_register_synced",
    detail: {
      boardId: LOT_BOARD_ID,
      rows: rows.length,
      enforcementMode: (data as Row | null)?.enforcementMode ?? "monitor",
      source: caller ? "administrator" : "scheduler",
    },
  });
  return data && typeof data === "object" ? data as Row : {};
}

async function unknownLotCandidates(): Promise<
  Array<{ lotId: string; packageReferences: string }>
> {
  const controls: Row[] = [];
  for (let start = 0;; start += 1000) {
    const { data, error } = await service.from("portal_package_lot_control")
      .select("package_id,lot_id").eq("integrity_status", "unknown_lot")
      .range(start, start + 999);
    if (error) throw error;
    controls.push(...(data ?? []) as Row[]);
    if ((data ?? []).length < 1000) break;
  }
  const packageIds = controls.map((row) => Number(row.package_id)).filter(
    Number.isSafeInteger,
  );
  const packages: Row[] = [];
  for (let start = 0; start < packageIds.length; start += 250) {
    const { data, error } = await service.from("canix_package_current").select(
      "package_id,tag,item_id,item_name,brand_name,facility_id,facility_name",
    ).in("package_id", packageIds.slice(start, start + 250));
    if (error) throw error;
    packages.push(...(data ?? []) as Row[]);
  }
  const packageById = new Map(
    packages.map((row) => [String(row.package_id), row]),
  );
  const grouped = new Map<string, string[]>();
  for (const control of controls) {
    const lotId = clean(control.lot_id, 200);
    if (!lotId || !/^[A-Z0-9-]{1,20}$/.test(lotId)) continue;
    const packageRow = packageById.get(String(control.package_id)) ?? {};
    if (Number(packageRow.facility_id) === 4546) continue;
    const reference = [
      clean(packageRow.tag, 120) ?? `Package ${control.package_id}`,
      clean(packageRow.item_name, 180),
      clean(packageRow.brand_name, 100),
      clean(packageRow.facility_name, 120),
    ].filter(Boolean).join(" · ");
    const current = grouped.get(lotId) ?? [];
    current.push(reference);
    grouped.set(lotId, current);
  }
  return Array.from(grouped.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([lotId, references]) => ({
    lotId,
    packageReferences: Array.from(new Set(references)).join("\n").slice(
      0,
      10_000,
    ),
  }));
}

async function createMondayReviewItem(
  accessToken: string,
  candidate: { lotId: string; packageReferences: string },
): Promise<string> {
  const data = await mondayGraphql(
    accessToken,
    `mutation StageCanixLot(
      $boardId: ID!, $itemName: String!, $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) { id }
    }`,
    {
      boardId: LOT_BOARD_ID,
      itemName: candidate.lotId,
      columnValues: JSON.stringify({
        [COLUMN_IDS.lotId]: candidate.lotId,
        [COLUMN_IDS.canixPackageReferences]: candidate.packageReferences,
        [COLUMN_IDS.approvalStatus]: { label: "Pending Review" },
      }),
    },
  );
  const created = data.create_item && typeof data.create_item === "object"
    ? data.create_item as Row
    : {};
  const itemId = clean(created.id, 80);
  if (!itemId) throw new Error("Monday did not confirm the staged lot row.");
  return itemId;
}

async function markStaged(
  lotId: string,
  state: "created" | "error",
  mondayItemId: string | null,
  errorMessage: string | null,
): Promise<void> {
  const { error } = await service.rpc("portal_finish_lot_review_staging", {
    p_lot_id: lotId,
    p_state: state,
    p_monday_item_id: mondayItemId,
    p_error: errorMessage,
  });
  if (error) throw error;
}

async function stageUnknownLots(caller: Caller): Promise<Row> {
  const accessToken = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read", "boards:write"]);
  if (!accessToken) {
    throw new Error("Monday must be connected with board read/write access.");
  }
  const [candidates, boardItems] = await Promise.all([
    unknownLotCandidates(),
    fetchMondayItems(accessToken),
  ]);
  const existing = new Map<string, string>();
  for (const item of boardItems) {
    const normalized = normalizeItem(item);
    const lotId = clean(normalized.source_lot_id, 200);
    const itemId = clean(normalized.monday_item_id, 80);
    if (lotId && itemId && !existing.has(lotId)) existing.set(lotId, itemId);
  }

  const results: Row[] = [];
  for (let start = 0; start < candidates.length; start += 5) {
    const batch = candidates.slice(start, start + 5);
    results.push(
      ...await Promise.all(batch.map(async (candidate) => {
        const existingItemId = existing.get(candidate.lotId);
        if (existingItemId) {
          const { error } = await service.from("portal_lot_review_staging")
            .upsert({
              lot_id: candidate.lotId,
              state: "created",
              monday_item_id: existingItemId,
              last_error: null,
              completed_at: new Date().toISOString(),
              last_attempt_at: new Date().toISOString(),
            }, { onConflict: "lot_id" });
          if (error) throw error;
          return { lotId: candidate.lotId, state: "already_present" };
        }
        const { data: claimed, error: claimError } = await service.rpc(
          "portal_claim_lot_review_staging",
          { p_lot_id: candidate.lotId },
        );
        if (claimError) throw claimError;
        if (claimed !== true) {
          return { lotId: candidate.lotId, state: "already_claimed" };
        }
        try {
          const itemId = await createMondayReviewItem(accessToken, candidate);
          await markStaged(candidate.lotId, "created", itemId, null);
          return { lotId: candidate.lotId, state: "created", itemId };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "Monday lot staging failed.";
          await markStaged(candidate.lotId, "error", null, message);
          return { lotId: candidate.lotId, state: "error", error: message };
        }
      })),
    );
  }
  const registerSync = await syncRegister(caller);
  const summary = {
    discovered: candidates.length,
    created: results.filter((row) => row.state === "created").length,
    alreadyPresent: results.filter((row) => row.state === "already_present")
      .length,
    alreadyClaimed: results.filter((row) => row.state === "already_claimed")
      .length,
    failed: results.filter((row) => row.state === "error").length,
  };
  await service.from("portal_admin_audit").insert({
    actor_id: caller.id,
    actor_org: caller.org,
    action: "monday.lots_staged_for_review",
    detail: { boardId: LOT_BOARD_ID, ...summary },
  });
  return { ...summary, registerSync };
}

async function snapshot(): Promise<Row> {
  const [stateResult, exceptionResult] = await Promise.all([
    service.from("portal_lot_integrity_state").select(
      "monday_board_id,enforcement_mode,register_sync_status,last_register_sync_at,last_integrity_run_at,last_error,register_rows,approved_register_rows,invalid_register_rows,duplicate_register_rows,package_rows,valid_package_rows,exception_package_rows,allocation_exception_rows,updated_at",
    ).eq("id", 1).maybeSingle(),
    service.from("portal_package_lot_control").select(
      "package_id,lot_id,integrity_status,allocation_eligible,detail,checked_at",
    ).neq("integrity_status", "valid").order("checked_at", {
      ascending: false,
    }).limit(500),
  ]);
  if (stateResult.error) throw stateResult.error;
  if (exceptionResult.error) throw exceptionResult.error;
  const controls = (exceptionResult.data ?? []) as Row[];
  const packageIds = controls.map((row) => Number(row.package_id)).filter(
    Number.isSafeInteger,
  );
  const packageResult = packageIds.length
    ? await service.from("canix_package_current").select(
      "package_id,tag,item_id,item_name,brand_name,facility_id,facility_name,status_category,quantity_type,weight,weight_unit_name",
    ).in("package_id", packageIds)
    : { data: [], error: null };
  if (packageResult.error) throw packageResult.error;
  const packages = new Map(
    ((packageResult.data ?? []) as Row[]).map((row) => [
      String(row.package_id),
      row,
    ]),
  );
  return {
    state: stateResult.data ?? null,
    exceptions: controls.map((control) => ({
      ...control,
      package: packages.get(String(control.package_id)) ?? null,
    })),
    exceptionLimit: 500,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Row;
      const action = clean(body.action, 80) ?? "sync";
      const suppliedSecret = request.headers.get("x-cron-secret") ?? "";
      const cronAuthorized = LOT_CRON_SECRET.length >= 32 &&
        constantTimeEqual(suppliedSecret, LOT_CRON_SECRET);
      const caller = cronAuthorized
        ? null
        : await callerFor(request, "inventory.sync");
      if (!cronAuthorized && !caller) {
        return json(request, { error: "Forbidden" }, 403);
      }
      if (action === "stage-unknown-lots") {
        if (!caller) return json(request, { error: "Forbidden" }, 403);
        return json(request, {
          ok: true,
          staging: await stageUnknownLots(caller),
        });
      }
      if (action !== "sync") {
        return json(request, { error: "Unsupported action" }, 400);
      }
      const result = await syncRegister(caller);
      return json(request, { ok: true, sync: result });
    }
    const caller = await callerFor(request, "inventory.read");
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    return json(request, await snapshot());
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Lot integrity synchronization failed.";
    await service.from("portal_lot_integrity_state").update({
      register_sync_status: "error",
      last_error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    return json(request, { error: message }, 502);
  }
});
