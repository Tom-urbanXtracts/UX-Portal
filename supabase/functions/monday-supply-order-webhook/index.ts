import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { verifyHs256Jwt } from "../_shared/security-contract.ts";
import {
  stableSupplyOrderHash,
  supplyOrderApprovalRoute,
  type SupplyOrderLineInput,
  supplyOrderValidation,
} from "../_shared/supply-order-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_SIGNING_SECRET = Deno.env.get("MONDAY_SIGNING_SECRET") ?? "";
const MONDAY_WEBHOOK_SECRET = Deno.env.get("SUPPLY_ORDER_WEBHOOK_SECRET") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const SUPPLY_BOARD_ID = Deno.env.get("MONDAY_SUPPLY_ORDER_BOARD_ID") ??
  "18393924684";
const SUBITEM_BOARD_ID = Deno.env.get("MONDAY_SUPPLY_ORDER_SUBITEM_BOARD_ID") ??
  "18393924691";
const WEBHOOK_SETTLE_MS = Number(
  Deno.env.get("SUPPLY_ORDER_WEBHOOK_SETTLE_MS") ?? "8000",
);

const GROUPS = Object.freeze({
  newRequests: "topics",
  waiting: "group_mkzsxj7g",
  approved: "group_mkpbdzag",
  ordered: "group_mkrvjtx3",
  canceled: "new_group30958",
});

const COLUMNS = Object.freeze({
  titleFormula: "formula_mkyabg3d",
  priority: "single_select7",
  needBefore: "date0f09h7ao",
  vendor: "short_text82ua243b",
  department: "single_selectksq7r27",
  requester: "people",
  approval: "status2",
  orderStatus: "status",
  purchaseLink: "link_mkxke4qd",
  requestedOn: "date",
  total: "lookup_mkx0b8va",
  orderedOn: "date_mkxwnxzh",
});

const SUBITEM_COLUMNS = Object.freeze({
  purchaseLink: "link_mkx0rd2a",
  unitCost: "numeric_mkx0zqnw",
  quantity: "numeric_mkx06m2z",
  sku: "text_mkx0y7qp",
  department: "color_mkx092ce",
  expenseCategory: "dropdown_mkztj5p7",
  expenseSubcategory: "dropdown_mkzthc44",
  subtotal: "formula_mkx0s4x4",
  requiredDelivery: "date_mkxwgqqx",
  priority: "color_mkx06qmj",
  chartOfAccounts: "board_relation_mkzty9a8",
});

const AMRIT_USER_ID = 50414822;

type Row = Record<string, unknown>;

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function asObject(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function text(value: unknown, max = 1000): string | null {
  const output = clean(value, max);
  return output || null;
}

function bearerToken(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function authenticated(request: Request): Promise<boolean> {
  const secret = new URL(request.url).searchParams.get("secret") ?? "";
  if (MONDAY_WEBHOOK_SECRET && secret === MONDAY_WEBHOOK_SECRET) return true;
  if (!MONDAY_SIGNING_SECRET) return false;
  return !!(await verifyHs256Jwt(bearerToken(request), MONDAY_SIGNING_SECRET));
}

async function mondayWriteToken(): Promise<string> {
  const token = await mondayAccessToken(service, {
    encryptionKey: MONDAY_TOKEN_ENCRYPTION_KEY,
    clientId: MONDAY_CLIENT_ID,
    clientSecret: MONDAY_CLIENT_SECRET,
  }, ["boards:read", "boards:write"]);
  if (!token) throw new Error("Monday app connection is not available.");
  return token;
}

async function mondayGraphql(
  accessToken: string,
  query: string,
  variables: Row = {},
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
    console.error(
      "monday-supply-order-api",
      JSON.stringify(body.errors ?? body),
    );
    throw new Error("Monday API request failed.");
  }
  return asObject(body.data);
}

function columnMap(item: Row): Map<string, Row> {
  const values = Array.isArray(item.column_values)
    ? item.column_values as Row[]
    : [];
  return new Map(values.map((value) => [String(value.id ?? ""), value]));
}

function columnText(values: Map<string, Row>, id: string): string | null {
  return text(values.get(id)?.text);
}

function numberColumn(values: Map<string, Row>, id: string): number | null {
  const raw = columnText(values, id);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function linkColumn(values: Map<string, Row>, id: string): string | null {
  try {
    const raw = values.get(id)?.value;
    const value = asObject(raw ? JSON.parse(String(raw)) : {});
    return text(value.url) ?? columnText(values, id);
  } catch {
    return columnText(values, id);
  }
}

function requesterIds(values: Map<string, Row>): number[] {
  const raw = values.get(COLUMNS.requester)?.value;
  if (!raw) return [];
  try {
    const value = asObject(JSON.parse(String(raw)));
    const people = Array.isArray(value.personsAndTeams)
      ? value.personsAndTeams as Row[]
      : [];
    return people.map((person) => Number(person.id)).filter((id) =>
      Number.isSafeInteger(id) && id > 0
    );
  } catch {
    return [];
  }
}

function eventItemId(event: Row): string {
  return clean(event.pulseId ?? event.itemId ?? event.entityId, 80);
}

function parentItemId(item: Row): string {
  return clean(asObject(item.parent_item).id, 80) || clean(item.id, 80);
}

async function fetchSupplyOrder(
  accessToken: string,
  itemId: string,
): Promise<Row | null> {
  const data = await mondayGraphql(
    accessToken,
    `query SupplyOrder($ids: [ID!], $parentColumns: [String!], $subColumns: [String!]) {
      items(ids: $ids) {
        id
        name
        url
        board { id }
        group { id title }
        parent_item { id }
        column_values(ids: $parentColumns) { id text value type }
        subitems {
          id
          name
          url
          column_values(ids: $subColumns) { id text value type }
        }
      }
    }`,
    {
      ids: [itemId],
      parentColumns: Object.values(COLUMNS),
      subColumns: Object.values(SUBITEM_COLUMNS),
    },
  );
  const item = Array.isArray(data.items)
    ? data.items[0] as Row | undefined
    : null;
  if (!item) return null;
  const boardId = clean(asObject(item.board).id, 80);
  if (boardId === SUBITEM_BOARD_ID) {
    const parentId = parentItemId(item);
    if (parentId && parentId !== itemId) {
      return await fetchSupplyOrder(accessToken, parentId);
    }
    return null;
  }
  return boardId === SUPPLY_BOARD_ID ? item : null;
}

function lineInput(subitem: Row): SupplyOrderLineInput {
  const values = columnMap(subitem);
  return {
    name: text(subitem.name),
    linkUrl: linkColumn(values, SUBITEM_COLUMNS.purchaseLink),
    unitCost: numberColumn(values, SUBITEM_COLUMNS.unitCost),
    quantity: numberColumn(values, SUBITEM_COLUMNS.quantity),
    sku: columnText(values, SUBITEM_COLUMNS.sku),
    department: columnText(values, SUBITEM_COLUMNS.department),
    expenseCategory: columnText(values, SUBITEM_COLUMNS.expenseCategory),
    expenseSubcategory: columnText(values, SUBITEM_COLUMNS.expenseSubcategory),
    chartOfAccounts: columnText(values, SUBITEM_COLUMNS.chartOfAccounts),
  };
}

async function updateColumns(
  accessToken: string,
  itemId: string,
  columnValues: Row,
): Promise<void> {
  await mondayGraphql(
    accessToken,
    `mutation UpdateSupplyOrder($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $values,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: SUPPLY_BOARD_ID,
      itemId,
      values: JSON.stringify(columnValues),
    },
  );
}

async function moveToGroup(
  accessToken: string,
  item: Row,
  groupId: string,
): Promise<void> {
  if (clean(asObject(item.group).id, 80) === groupId) return;
  await mondayGraphql(
    accessToken,
    `mutation MoveSupplyOrder($itemId: ID!, $groupId: String!) {
      move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
    }`,
    { itemId: clean(item.id, 80), groupId },
  );
}

async function notifyUsers(
  accessToken: string,
  itemId: string,
  userIds: number[],
  message: string,
): Promise<void> {
  const unique = Array.from(new Set(userIds)).filter((id) => id > 0);
  for (const userId of unique) {
    await mondayGraphql(
      accessToken,
      `mutation NotifySupplyOrder($userId: ID!, $itemId: ID!, $text: String!) {
        create_notification(
          user_id: $userId,
          target_id: $itemId,
          target_type: Project,
          text: $text
        ) { id }
      }`,
      { userId: String(userId), itemId, text: message.slice(0, 500) },
    );
  }
}

async function createUpdate(
  accessToken: string,
  itemId: string,
  body: string,
): Promise<void> {
  await mondayGraphql(
    accessToken,
    `mutation SupplyOrderUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body },
  );
}

async function readState(itemId: string): Promise<Row> {
  const { data, error } = await service
    .from("monday_supply_order_review_state")
    .select("*")
    .eq("item_id", itemId)
    .maybeSingle();
  if (error) throw error;
  return data ?? {};
}

async function writeState(itemId: string, changes: Row): Promise<void> {
  const { error } = await service.from("monday_supply_order_review_state")
    .upsert({
      item_id: itemId,
      ...changes,
      updated_at: new Date().toISOString(),
    }, { onConflict: "item_id" });
  if (error) throw error;
}

async function processOrder(accessToken: string, item: Row): Promise<Row> {
  const itemId = clean(item.id, 80);
  const values = columnMap(item);
  const approvalStatus = columnText(values, COLUMNS.approval);
  const orderStatus = columnText(values, COLUMNS.orderStatus);
  const lines = (Array.isArray(item.subitems) ? item.subitems as Row[] : [])
    .map(lineInput);
  const validation = supplyOrderValidation({
    requesterIds: requesterIds(values),
    department: columnText(values, COLUMNS.department),
    vendor: columnText(values, COLUMNS.vendor),
    needBeforeDate: columnText(values, COLUMNS.needBefore),
    priority: columnText(values, COLUMNS.priority),
    lines,
  });
  const stateHash = await sha256(
    stableSupplyOrderHash(validation, approvalStatus),
  );
  const state = await readState(itemId);

  if (!validation.complete) {
    const missingHash = await sha256(validation.missing.join("|"));
    await updateColumns(accessToken, itemId, {
      [COLUMNS.approval]: { label: "Needs Info" },
      [COLUMNS.orderStatus]: { label: "Hold" },
    });
    await moveToGroup(accessToken, item, GROUPS.newRequests);
    if (state.last_missing_hash !== missingHash) {
      const missingList = validation.missing.map((field) => `- ${field}`).join(
        "<br>",
      );
      await createUpdate(
        accessToken,
        itemId,
        `<p>This request needs more information before it can be routed for approval.</p><p>${missingList}</p><p>Please update the request information; approval notifications will wait until the request is complete.</p>`,
      );
      await notifyUsers(
        accessToken,
        itemId,
        requesterIds(values),
        `Supply order needs more information before approval: ${
          validation.missing.slice(0, 4).join(", ")
        }`,
      );
    }
    await writeState(itemId, {
      last_state_hash: stateHash,
      last_missing_hash: missingHash,
      last_workflow_state: "needs_info",
      last_total: validation.total,
      last_approval_status: approvalStatus,
    });
    return { action: "needs_info", missing: validation.missing };
  }

  if (approvalStatus === "Approved") {
    await moveToGroup(accessToken, item, GROUPS.approved);
    if (state.last_approved_hash !== stateHash) {
      await notifyUsers(
        accessToken,
        itemId,
        [AMRIT_USER_ID],
        `Supply order approved for ordering: ${clean(item.name, 160)}`,
      );
      await createUpdate(
        accessToken,
        itemId,
        "<p>This supply order has been approved for ordering. Amrit Kharas has been notified.</p>",
      );
    }
    await writeState(itemId, {
      last_state_hash: stateHash,
      last_approved_hash: stateHash,
      last_workflow_state: "approved_for_ordering",
      last_total: validation.total,
      last_approval_status: approvalStatus,
    });
    return { action: "approved_notified_amrit", total: validation.total };
  }

  if (approvalStatus === "Rejected") {
    await moveToGroup(accessToken, item, GROUPS.canceled);
    if (state.last_rejected_hash !== stateHash) {
      await notifyUsers(
        accessToken,
        itemId,
        requesterIds(values),
        `Supply order rejected: ${clean(item.name, 160)}`,
      );
    }
    await writeState(itemId, {
      last_state_hash: stateHash,
      last_rejected_hash: stateHash,
      last_workflow_state: "rejected",
      last_total: validation.total,
      last_approval_status: approvalStatus,
    });
    return { action: "rejected", total: validation.total };
  }

  if (orderStatus === "Ordered") {
    await updateColumns(accessToken, itemId, {
      [COLUMNS.orderedOn]: { date: new Date().toISOString().slice(0, 10) },
    });
    await moveToGroup(accessToken, item, GROUPS.ordered);
    await writeState(itemId, {
      last_state_hash: stateHash,
      last_workflow_state: "ordered",
      last_total: validation.total,
      last_approval_status: approvalStatus,
    });
    return { action: "ordered", total: validation.total };
  }

  const route = supplyOrderApprovalRoute(validation.total ?? 0);
  const routeHash = await sha256(`${route.tier}:${validation.total}`);
  await updateColumns(accessToken, itemId, {
    [COLUMNS.approval]: { label: "Waiting" },
    [COLUMNS.orderStatus]: { label: ":" },
  });
  await moveToGroup(accessToken, item, GROUPS.waiting);
  if (state.last_route_hash !== routeHash) {
    await notifyUsers(
      accessToken,
      itemId,
      route.mondayUserIds,
      `Supply order needs approval from ${route.authority}: ${
        clean(item.name, 160)
      } ($${validation.total?.toFixed(2)})`,
    );
    await createUpdate(
      accessToken,
      itemId,
      `<p>This complete request has been routed for approval to ${route.authority} based on an estimated total of $${
        validation.total?.toFixed(2)
      }.</p>`,
    );
  }
  await writeState(itemId, {
    last_state_hash: stateHash,
    last_route_hash: routeHash,
    last_workflow_state: `waiting:${route.tier}`,
    last_total: validation.total,
    last_approval_status: "Waiting",
  });
  return {
    action: "routed_for_approval",
    total: validation.total,
    authority: route.authority,
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const raw = await request.text();
  if (!raw || raw.length > 128_000) return json({ error: "Invalid body" }, 400);
  let body: Row;
  try {
    body = JSON.parse(raw) as Row;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const challenge = clean(body.challenge, 1000);
  if (challenge && Object.keys(body).every((key) => key === "challenge")) {
    return json({ challenge });
  }
  if (!(await authenticated(request))) {
    return json({ error: "Invalid webhook authentication" }, 401);
  }
  const event = asObject(body.event);
  const boardId = clean(event.boardId, 80);
  const pulseId = eventItemId(event);
  if (![SUPPLY_BOARD_ID, SUBITEM_BOARD_ID].includes(boardId) || !pulseId) {
    return json({ ok: true, ignored: true });
  }
  const eventKey = clean(event.originalTriggerUuid ?? event.triggerUuid, 200) ||
    await sha256(raw);
  const payloadHash = await sha256(raw);
  const { data: claimRows, error: claimError } = await service.rpc(
    "portal_claim_monday_webhook_event",
    {
      p_event_key: `supply:${eventKey}`,
      p_subscription_id: clean(event.subscriptionId, 160) || "supply-order",
      p_board_id: boardId,
      p_item_id: pulseId,
      p_status_label: clean(asObject(asObject(event.value).label).text, 120) ||
        clean(event.type, 120) || "changed",
      p_payload_sha256: payloadHash,
    },
  );
  if (claimError) return json({ error: "Webhook replay check failed" }, 503);
  const claim = Array.isArray(claimRows)
    ? claimRows[0] as Row | undefined
    : null;
  if (claim && claim.claimed === false) {
    return json({ ok: true, duplicate: true });
  }

  try {
    if (WEBHOOK_SETTLE_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, WEBHOOK_SETTLE_MS));
    }
    const token = await mondayWriteToken();
    const item = await fetchSupplyOrder(token, pulseId);
    if (!item) {
      await service.rpc("portal_finish_monday_webhook_event", {
        p_event_key: `supply:${eventKey}`,
        p_state: "rejected",
        p_response_status: 200,
        p_error: "Not a Supply Order Form item.",
      });
      return json({ ok: true, ignored: true });
    }
    const result = await processOrder(token, item);
    await service.rpc("portal_finish_monday_webhook_event", {
      p_event_key: `supply:${eventKey}`,
      p_state: "processed",
      p_response_status: 200,
      p_error: null,
    });
    return json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Supply order webhook failed.";
    console.error("monday-supply-order-webhook", message);
    await service.rpc("portal_finish_monday_webhook_event", {
      p_event_key: `supply:${eventKey}`,
      p_state: "failed",
      p_response_status: 500,
      p_error: message,
    });
    return json({ error: message }, 503);
  }
});
