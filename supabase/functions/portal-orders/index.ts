import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  labFailed,
  labPassed,
  mondayOrderState,
  orderTransitionAllowed,
} from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAKE_ORDER_STATUS_WEBHOOK_URL =
  Deno.env.get("MAKE_ORDER_STATUS_WEBHOOK_URL") ??
    Deno.env.get("MAKE_WEBHOOK_URL") ?? "";
const MAKE_INTAKE_SECRET = Deno.env.get("MAKE_INTAKE_SECRET") ?? "";
const MONDAY_STATUS_SECRET = Deno.env.get("MONDAY_STATUS_SECRET") ?? "";
const ORDER_SYNC_CRON_SECRET = Deno.env.get("ORDER_SYNC_CRON_SECRET") ?? "";
const MONDAY_TOKEN_ENCRYPTION_KEY =
  Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_ORDER_BOARD_ID = Deno.env.get("MONDAY_ORDER_BOARD_ID") ??
  "18428025898";
const MONDAY_ORDER_STATUS_COLUMN_ID =
  Deno.env.get("MONDAY_ORDER_STATUS_COLUMN_ID") ?? "color_mm6jxv8f";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManageOrders: boolean };

class PortalError extends Error {
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
      "authorization, apikey, content-type, x-ux-monday-secret, x-ux-cron-secret",
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

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

async function mondayWriteToken(): Promise<string | null> {
  if (
    MONDAY_TOKEN_ENCRYPTION_KEY.length < 32 ||
    !/^\d+$/.test(MONDAY_ORDER_BOARD_ID)
  ) return null;
  const { data: state, error: stateError } = await service.from(
    "monday_connection_state",
  ).select("connection_status,granted_scopes").eq("id", 1).maybeSingle();
  if (stateError) throw stateError;
  if (
    state?.connection_status !== "connected" ||
    !Array.isArray(state.granted_scopes) ||
    !state.granted_scopes.includes("boards:write")
  ) return null;
  const { data, error } = await service.rpc("portal_get_monday_connection", {
    p_encryption_key: MONDAY_TOKEN_ENCRYPTION_KEY,
  });
  if (error) throw error;
  const connection = Array.isArray(data) ? data[0] : null;
  const token = clean(connection?.access_token, 10_000);
  return connection?.connection_status === "connected" && token ? token : null;
}

async function sendDirectMondayStatus(order: Row): Promise<boolean> {
  const accessToken = await mondayWriteToken();
  const itemId = clean(order.monday_item_id, 160);
  if (!accessToken || !/^\d+$/.test(itemId)) return false;
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: `mutation UpdatePortalOrderStatus(
        $boardId: ID!, $itemId: ID!, $columnValues: JSON!
      ) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $columnValues,
          create_labels_if_missing: true
        ) { id }
      }`,
      variables: {
        boardId: MONDAY_ORDER_BOARD_ID,
        itemId,
        columnValues: JSON.stringify({
          [MONDAY_ORDER_STATUS_COLUMN_ID]: {
            label: publicState(String(order.state)),
          },
        }),
      },
    }),
  });
  const body = await response.json().catch(() => ({})) as Row;
  if (!response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    throw new Error("Monday did not accept the direct status update.");
  }
  const data = body.data && typeof body.data === "object"
    ? body.data as Row
    : {};
  const changed = data.change_multiple_column_values as Row | undefined;
  if (String(changed?.id ?? "") !== itemId) {
    throw new Error("Monday did not confirm the direct status update.");
  }
  return true;
}

function positiveInteger(value: unknown): number | null {
  const raw = clean(value, 40);
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function publicState(state: string): string {
  return ({
    awaiting_owner_approval: "Ordered · approval required",
    ordered: "Ordered",
    approved: "Approved",
    processed: "Processed",
    delivered: "Delivered",
    declined: "Exception",
    canceled: "Exception",
    exception: "Exception",
  } as Record<string, string>)[state] ?? state;
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
    .select("id,full_name,org,role,staff_role,active,locations").eq(
      "id",
      user.id,
    ).maybeSingle();
  if (!profile || profile.active === false) return null;
  let canManageOrders = false;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission").select(
      "permission",
    )
      .eq("staff_role", profile.staff_role).eq("permission", "orders.manage")
      .maybeSingle();
    canManageOrders = !!grant;
  }
  return { user, profile: profile as Row, canManageOrders };
}

async function accessibleStores(caller: Caller): Promise<Row[]> {
  if (caller.profile.role === "internal") {
    if (!caller.canManageOrders) return [];
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active").eq(
        "active",
        true,
      )
      .order("organization").order("display_name");
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  if (caller.profile.role === "owner") {
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active")
      .eq("organization", caller.profile.org).eq("active", true).order(
        "display_name",
      );
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  if (caller.profile.role !== "buyer") return [];
  const { data: assignments, error: assignmentError } = await service.from(
    "portal_profile_store",
  )
    .select("license_number").eq("profile_id", caller.profile.id);
  if (assignmentError) throw assignmentError;
  const licenses = (assignments ?? []).map((row) => String(row.license_number));
  if (!licenses.length) return [];
  const { data, error } = await service.from("portal_store")
    .select("license_number,organization,display_name,active")
    .eq("organization", caller.profile.org).eq("active", true).in(
      "license_number",
      licenses,
    ).order("display_name");
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

function serializeLine(row: Row): Row {
  return {
    lineNumber: Number(row.line_number),
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    tag: row.compliance_tag,
    quantity: Number(row.quantity),
    unit: row.unit,
    unitPriceCents: Number(row.unit_price_cents),
    lineTotalCents: Number(row.line_total_cents),
    orderMode: row.order_mode,
    releaseState: row.release_state,
  };
}

function serializeEvent(row: Row): Row {
  return {
    id: row.id,
    source: row.source,
    fromState: row.from_state,
    toState: row.to_state,
    actorEmail: row.actor_email,
    rawStatus: row.raw_status,
    note: row.note,
    createdAt: row.created_at,
  };
}

async function hydrateOrders(orders: Row[]): Promise<Row[]> {
  const ids = orders.map((row) => String(row.id));
  if (!ids.length) return [];
  const [lineResult, eventResult, syncResult] = await Promise.all([
    service.from("portal_order_line").select("*").in("order_id", ids).order(
      "line_number",
    ),
    service.from("portal_order_event").select("*").in("order_id", ids).order(
      "created_at",
    ),
    service.from("portal_order_sync_outbox").select(
      "order_id,state,last_error,last_attempt_at,sent_at",
    ).in("order_id", ids).order("created_at", { ascending: false }),
  ]);
  if (lineResult.error) throw lineResult.error;
  if (eventResult.error) throw eventResult.error;
  if (syncResult.error) throw syncResult.error;
  const linesByOrder = new Map<string, Row[]>();
  const eventsByOrder = new Map<string, Row[]>();
  const syncByOrder = new Map<string, Row>();
  for (const row of lineResult.data ?? []) {
    const id = String(row.order_id);
    linesByOrder.set(
      id,
      (linesByOrder.get(id) ?? []).concat([
        serializeLine(row as unknown as Row),
      ]),
    );
  }
  for (const row of eventResult.data ?? []) {
    const id = String(row.order_id);
    eventsByOrder.set(
      id,
      (eventsByOrder.get(id) ?? []).concat([
        serializeEvent(row as unknown as Row),
      ]),
    );
  }
  for (const row of syncResult.data ?? []) {
    const id = String(row.order_id);
    if (!syncByOrder.has(id)) syncByOrder.set(id, row as unknown as Row);
  }
  return orders.map((row) => {
    const id = String(row.id);
    const sync = syncByOrder.get(id);
    return {
      id,
      clientRequestId: row.client_request_id,
      portalReference: row.portal_reference,
      orderNumber: row.order_number,
      mondayItemId: row.monday_item_id,
      mondayBoardId: row.monday_board_id,
      canixSalesOrderId: row.canix_sales_order_id,
      organization: row.organization,
      locationLicense: row.location_license,
      locationName: row.location_name,
      submittedByEmail: row.submitted_by_email,
      submittedByRole: row.submitted_by_role,
      state: row.state,
      publicState: publicState(String(row.state)),
      workflowState: row.workflow_state,
      workflowError: row.workflow_error,
      ownerApprovalRequired: row.owner_approval_required,
      approvalThresholdCents: row.approval_threshold_cents,
      orderValueCents: Number(row.order_value_cents),
      containsPreorder: row.contains_preorder,
      releaseHold: row.release_hold,
      deliveryWindow: row.delivery_window,
      receivingContact: row.receiving_contact,
      receivingInstructions: row.receiving_instructions,
      submittedAt: row.submitted_at,
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
      syncState: sync?.state ?? "not_queued",
      syncError: sync?.last_error ?? null,
      lines: linesByOrder.get(id) ?? [],
      events: eventsByOrder.get(id) ?? [],
    };
  });
}

async function orderById(orderId: string): Promise<Row | null> {
  const { data, error } = await service.from("portal_order").select("*").eq(
    "id",
    orderId,
  ).maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

async function assertOrderAccess(caller: Caller, order: Row): Promise<void> {
  const stores = await accessibleStores(caller);
  if (
    !stores.some((store) =>
      String(store.license_number) === String(order.location_license)
    )
  ) {
    throw new PortalError(
      403,
      "That order is outside your assigned store access.",
    );
  }
}

async function releaseReady(orderId: string): Promise<boolean> {
  const { data: lines, error: lineError } = await service.from(
    "portal_order_line",
  )
    .select("id,product_id,quantity,order_mode").eq("order_id", orderId).eq(
      "order_mode",
      "preorder",
    );
  if (lineError) throw lineError;
  if (!lines?.length) return true;
  const itemIds = lines.map((line) => String(line.product_id)).filter((id) =>
    id.startsWith("canix:item:")
  )
    .map((id) => id.slice("canix:item:".length)).filter((id) =>
      /^\d+$/.test(id)
    );
  if (itemIds.length !== lines.length) return false;
  const { data: sync } = await service.from("canix_sync_state").select(
    "last_successful_run_id",
  ).eq("id", 1).maybeSingle();
  if (!sync?.last_successful_run_id) return false;
  const { data: packages, error: packageError } = await service.from(
    "canix_package_current",
  )
    .select(
      "item_id,status_category,quantity_type,weight,orderable_units,lab_test_status,test_result_status,sales_order_id",
    )
    .eq("sync_run_id", sync.last_successful_run_id).in(
      "status_category",
      ["available", "allocated"],
    )
    .eq("quantity_type", "CountBased").in("item_id", itemIds);
  if (packageError) throw packageError;
  const productIds = Array.from(
    new Set(lines.map((line) => String(line.product_id))),
  );
  const { data: commitments, error: commitmentError } = await service.from(
    "portal_inventory_commitment",
  )
    .select("order_id,product_id,quantity").eq("active", true).in(
      "product_id",
      productIds,
    );
  if (commitmentError) throw commitmentError;
  const commitmentOrderIds = Array.from(
    new Set(
      (commitments ?? []).map((row) => String(row.order_id)),
    ),
  );
  const { data: commitmentOrders, error: orderError } = await service.from(
    "portal_order",
  ).select("id,canix_sales_order_id").in("id", commitmentOrderIds);
  if (orderError) throw orderError;
  const canixOrderByPortalOrder = new Map(
    (commitmentOrders ?? []).map((row) => [
      String(row.id),
      row.canix_sales_order_id === null
        ? null
        : String(row.canix_sales_order_id),
    ]),
  );
  const currentCanixOrderId = canixOrderByPortalOrder.get(orderId) ?? null;
  const allocatedByOrderProduct = new Map<string, number>();
  for (const row of packages ?? []) {
    if (
      row.status_category !== "allocated" || !row.sales_order_id ||
      labFailed(row as unknown as Row)
    ) continue;
    const key = `${row.sales_order_id}:canix:item:${row.item_id}`;
    allocatedByOrderProduct.set(
      key,
      (allocatedByOrderProduct.get(key) ?? 0) +
        Math.max(0, Number(row.weight) || 0),
    );
  }
  const everyReleased = itemIds.every((itemId) => {
    const productId = `canix:item:${itemId}`;
    const passingAvailable = (packages ?? []).filter((row) =>
      String(row.item_id) === itemId && row.status_category === "available" &&
      labPassed(row as unknown as Row)
    )
      .reduce(
        (sum, row) =>
          sum + Math.max(0, Number(row.orderable_units ?? row.weight) || 0),
        0,
      );
    const currentCommitment = (commitments ?? []).filter((row) =>
      String(row.order_id) === orderId && String(row.product_id) === productId
    ).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const otherUncovered = (commitments ?? []).filter((row) =>
      String(row.order_id) !== orderId && String(row.product_id) === productId
    ).reduce((sum, row) => {
      const canixOrderId = canixOrderByPortalOrder.get(String(row.order_id));
      const covered = canixOrderId
        ? allocatedByOrderProduct.get(`${canixOrderId}:${productId}`) ?? 0
        : 0;
      return sum + Math.max(0, Number(row.quantity || 0) - covered);
    }, 0);
    const ownAllocatedPassing = currentCanixOrderId
      ? (packages ?? []).filter((row) =>
        String(row.item_id) === itemId && row.status_category === "allocated" &&
        String(row.sales_order_id) === currentCanixOrderId &&
        labPassed(row as unknown as Row)
      )
        .reduce((sum, row) => sum + Math.max(0, Number(row.weight) || 0), 0)
      : 0;
    return currentCommitment > 0 &&
      ownAllocatedPassing + Math.max(0, passingAvailable - otherUncovered) >=
        currentCommitment;
  });
  if (everyReleased) {
    const { error } = await service.from("portal_order_line").update({
      release_state: "released",
    })
      .eq("order_id", orderId).eq("order_mode", "preorder");
    if (error) throw error;
  }
  return everyReleased;
}

function transitionAllowed(
  caller: Caller,
  from: string,
  to: string,
): { allowed: boolean; source: string } {
  if (caller.profile.role === "owner") {
    return {
      allowed: (from === "awaiting_owner_approval" &&
        ["ordered", "declined"].includes(to)) ||
        (from === "processed" && to === "delivered"),
      source: "store-owner",
    };
  }
  if (caller.profile.role === "buyer") {
    return {
      allowed: from === "processed" && to === "delivered",
      source: "store-user",
    };
  }
  const allowed = caller.profile.role === "internal" &&
    caller.canManageOrders &&
    ((from === "ordered" && to === "approved") ||
      (from === "approved" && to === "processed") ||
      (from === "processed" && to === "delivered"));
  return { allowed, source: "internal" };
}

async function sendOutbox(eventId: string): Promise<Row> {
  const { data: outbox, error: outboxError } = await service.from(
    "portal_order_sync_outbox",
  )
    .select("*").eq("event_id", eventId).maybeSingle();
  if (outboxError) throw outboxError;
  if (!outbox) return { state: "not_queued" };
  const { data: order, error: orderError } = await service.from("portal_order")
    .select("*").eq("id", outbox.order_id).maybeSingle();
  if (orderError) throw orderError;
  if (!order) throw new PortalError(404, "Portal order not found.");
  const { data: event, error: eventError } = await service.from(
    "portal_order_event",
  ).select("*").eq("id", eventId).maybeSingle();
  if (eventError) throw eventError;
  const attempt = Number(outbox.attempts || 0) + 1;
  const attemptedAt = new Date().toISOString();
  let errorMessage: string | null = null;
  let sentDirectly = false;
  try {
    sentDirectly = await sendDirectMondayStatus(order as unknown as Row);
  } catch (error) {
    errorMessage = error instanceof Error && error.name === "AbortError"
      ? "Monday status workflow timed out."
      : error instanceof Error
      ? error.message
      : "Monday status workflow failed.";
  }
  if (!sentDirectly && MAKE_ORDER_STATUS_WEBHOOK_URL && MAKE_INTAKE_SECRET) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      let response: Response;
      try {
        response = await fetch(MAKE_ORDER_STATUS_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            kind: "order-status",
            secret: MAKE_INTAKE_SECRET,
            sentAt: attemptedAt,
            source: "UX Store Portal",
            payload: {
              portalOrderId: order.id,
              portalReference: order.portal_reference,
              orderNumber: order.order_number,
              mondayItemId: order.monday_item_id,
              account: order.organization,
              licenceNumber: order.location_license,
              location: order.location_name,
              state: order.state,
              publicState: publicState(String(order.state)),
              eventId,
              fromState: event?.from_state,
              rawStatus: event?.raw_status,
              note: event?.note,
            },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      errorMessage = response.ok
        ? null
        : `Monday status workflow returned ${response.status}.`;
    } catch (error) {
      errorMessage = error instanceof Error && error.name === "AbortError"
        ? "Monday status workflow timed out."
        : error instanceof Error
        ? error.message
        : "Monday status workflow failed.";
    }
  } else if (!sentDirectly && !errorMessage) {
    errorMessage = "Monday status synchronization is not configured.";
  }
  const state = errorMessage ? "failed" : "sent";
  const { error: updateError } = await service.from("portal_order_sync_outbox")
    .update({
      state,
      attempts: attempt,
      last_error: errorMessage,
      last_attempt_at: attemptedAt,
      sent_at: errorMessage ? null : attemptedAt,
    }).eq("id", outbox.id);
  if (updateError) throw updateError;
  return { state, error: errorMessage, attempts: attempt };
}

async function applyTransition(
  order: Row,
  targetState: string,
  source: string,
  actorId: string | null,
  actorEmail: string | null,
  note: string | null,
  rawStatus: string | null,
  enqueueMonday: boolean,
): Promise<Row> {
  let releaseHold: boolean | null = null;
  if (
    ["processed", "delivered"].includes(targetState) &&
    order.release_hold === true
  ) {
    if (!(await releaseReady(String(order.id)))) {
      throw new PortalError(
        409,
        "This order still contains a pre-order without a passing Canix release. Processing remains held.",
      );
    }
    releaseHold = false;
  }
  const { data, error } = await service.rpc("portal_apply_order_transition", {
    p_order_id: order.id,
    p_expected_state: order.state,
    p_target_state: targetState,
    p_actor_id: actorId,
    p_actor_email: actorEmail,
    p_source: source,
    p_note: note,
    p_raw_status: rawStatus,
    p_metadata: {},
    p_release_hold: releaseHold,
    p_enqueue_monday: enqueueMonday,
  });
  if (error) {
    if (/state changed/i.test(error.message || "")) {
      throw new PortalError(
        409,
        "This order changed since it was opened. Refresh the order before trying again.",
      );
    }
    throw error;
  }
  const transition = data as unknown as Row;
  let sync: Row = { state: "not_queued" };
  if (enqueueMonday) {
    try {
      sync = await sendOutbox(String(transition.eventId));
    } catch (error) {
      // The portal transition is already committed and its outbox row is
      // durable. A downstream/readback failure must never make the caller
      // believe the portal state was rolled back.
      sync = {
        state: "failed",
        error: error instanceof Error
          ? error.message
          : "Monday synchronization is pending retry.",
      };
    }
  }
  return { transition, sync };
}

async function mondayOrder(body: Row): Promise<Row | null> {
  const orderId = clean(body.portalOrderId, 80);
  const mondayItemId = clean(body.mondayItemId || body.itemId, 160);
  const orderNumber = clean(body.orderNumber, 160);
  const portalReference = clean(body.portalReference, 160);
  let query = service.from("portal_order").select("*");
  if (orderId) query = query.eq("id", orderId);
  else if (mondayItemId) query = query.eq("monday_item_id", mondayItemId);
  else if (orderNumber) query = query.eq("order_number", orderNumber);
  else if (portalReference) {
    query = query.eq("portal_reference", portalReference);
  } else throw new PortalError(400, "A portal order identifier is required.");
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

async function handleMonday(request: Request, body: Row): Promise<Response> {
  if (
    !MONDAY_STATUS_SECRET ||
    request.headers.get("x-ux-monday-secret") !== MONDAY_STATUS_SECRET
  ) {
    return json(request, { error: "Forbidden" }, 403);
  }
  let order = await mondayOrder(body);
  if (!order) return json(request, { error: "Portal order not found" }, 404);
  const rawStatus = clean(body.status || body.state, 120);
  const target = mondayOrderState(rawStatus);
  if (!target) {
    return json(request, {
      error: "That Monday status is not mapped to a portal order state.",
    }, 400);
  }
  const mondayItemId = clean(body.mondayItemId || body.itemId, 160);
  const mondayBoardId = clean(body.mondayBoardId || body.boardId, 160);
  const callbackOrderNumber = clean(body.orderNumber, 160);
  const rawCanixSalesOrderId = clean(body.canixSalesOrderId, 40);
  const canixSalesOrderId = positiveInteger(rawCanixSalesOrderId);
  if (rawCanixSalesOrderId && canixSalesOrderId === null) {
    return json(request, {
      error: "The Canix sales order ID must be a positive integer.",
    }, 400);
  }
  if (mondayItemId || mondayBoardId || canixSalesOrderId) {
    const { error } = await service.from("portal_order").update({
      monday_item_id: mondayItemId || order.monday_item_id,
      monday_board_id: mondayBoardId || order.monday_board_id,
      canix_sales_order_id: canixSalesOrderId ?? order.canix_sales_order_id,
      updated_at: new Date().toISOString(),
    }).eq("id", order.id);
    if (error) throw error;
  }
  // A later authenticated Monday callback can safely resolve an uncertain
  // intake without resending it, provided it supplies both identifiers that
  // prove the downstream item already exists.
  if (
    order.workflow_state === "needs_reconciliation" && callbackOrderNumber &&
    mondayItemId
  ) {
    const { error } = await service.rpc("portal_mark_order_workflow", {
      p_order_id: order.id,
      p_workflow_state: "accepted",
      p_order_number: callbackOrderNumber,
      p_monday_item_id: mondayItemId,
      p_monday_board_id: mondayBoardId || null,
      p_error: null,
      p_metadata: {
        reconciledBy: "monday-callback",
        reconciledAt: new Date().toISOString(),
      },
    });
    if (error) throw error;
    order = await orderById(String(order.id));
    if (!order) return json(request, { error: "Portal order not found" }, 404);
  }
  if (target === order.state) {
    const refreshed = await orderById(String(order.id));
    return json(request, {
      ok: true,
      ignored: true,
      reason: "Order is already in that state.",
      order: refreshed ? (await hydrateOrders([refreshed]))[0] : null,
    });
  }
  if (order.state === "awaiting_owner_approval") {
    return json(request, {
      error:
        "Store Owner approval is still required before Monday may advance this order.",
    }, 409);
  }
  const rank: Record<string, number> = {
    ordered: 1,
    approved: 2,
    processed: 3,
    delivered: 4,
  };
  const currentState = String(order.state);
  if (rank[target] && rank[currentState] && rank[target] < rank[currentState]) {
    return json(request, {
      ok: true,
      ignored: true,
      reason: "A stale Monday status cannot move the portal order backward.",
    });
  }
  if (!orderTransitionAllowed(currentState, target)) {
    return json(request, {
      error:
        "Monday must advance the portal order one approved state at a time; terminal orders cannot be canceled.",
    }, 409);
  }
  await applyTransition(
    order,
    target,
    "monday",
    null,
    null,
    clean(body.note, 1200) || null,
    rawStatus,
    false,
  );
  const updated = await orderById(String(order.id));
  return json(request, {
    ok: true,
    order: updated ? (await hydrateOrders([updated]))[0] : null,
  });
}

async function flushOutbox(): Promise<Row> {
  const { data, error } = await service.from("portal_order_sync_outbox")
    .select("event_id").in("state", ["pending", "failed"]).order("created_at")
    .limit(25);
  if (error) throw error;
  const results: Row[] = [];
  for (const row of data ?? []) {
    results.push({
      eventId: row.event_id,
      ...(await sendOutbox(String(row.event_id))),
    });
  }
  return {
    attempted: results.length,
    sent: results.filter((row) => row.state === "sent").length,
    failed: results.filter((row) => row.state === "failed").length,
    pending: results.filter((row) => row.state === "pending").length,
    results,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    let body: Row = {};
    if (request.method === "POST") body = await request.json() as Row;
    if (
      request.method === "POST" && String(body.action || "") === "monday-status"
    ) return await handleMonday(request, body);

    const cronAuthorized = request.method === "POST" &&
      String(body.action || "") === "flush-outbox" &&
      !!ORDER_SYNC_CRON_SECRET &&
      request.headers.get("x-ux-cron-secret") === ORDER_SYNC_CRON_SECRET;
    if (cronAuthorized) {
      return json(request, { ok: true, ...(await flushOutbox()) });
    }

    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (
      !new Set(["internal", "owner", "buyer"]).has(String(caller.profile.role))
    ) return json(request, { error: "Forbidden" }, 403);
    if (caller.profile.role === "internal" && !caller.canManageOrders) {
      return json(request, { error: "Forbidden" }, 403);
    }

    if (request.method === "GET") {
      const stores = await accessibleStores(caller);
      const licenses = stores.map((store) => String(store.license_number));
      if (!licenses.length) return json(request, { orders: [] });
      let query = service.from("portal_order").select("*").in(
        "location_license",
        licenses,
      );
      query = caller.profile.role === "internal"
        ? query.in("workflow_state", ["accepted", "needs_reconciliation"])
        : query.eq("workflow_state", "accepted");
      const { data, error } = await query.order("submitted_at", {
        ascending: false,
      }).limit(250);
      if (error) throw error;
      return json(request, {
        orders: await hydrateOrders((data ?? []) as unknown as Row[]),
      });
    }

    const action = clean(body.action, 40).toLowerCase();
    if (action === "flush-outbox") {
      if (caller.profile.role !== "internal" || !caller.canManageOrders) {
        return json(request, { error: "Forbidden" }, 403);
      }
      return json(request, { ok: true, ...(await flushOutbox()) });
    }
    if (action === "resync-monday-status") {
      if (caller.profile.role !== "internal" || !caller.canManageOrders) {
        return json(request, { error: "Forbidden" }, 403);
      }
      const orderId = clean(body.orderId, 80);
      if (!orderId) {
        return json(request, { error: "The portal order is required." }, 400);
      }
      const order = await orderById(orderId);
      if (!order || order.workflow_state !== "accepted") {
        return json(request, { error: "Portal order not found" }, 404);
      }
      await assertOrderAccess(caller, order);
      if (
        clean(order.monday_board_id, 160) !== MONDAY_ORDER_BOARD_ID ||
        !/^\d+$/.test(clean(order.monday_item_id, 160))
      ) {
        return json(request, {
          error: "That order is not linked to the configured Monday order board.",
        }, 409);
      }
      if (!(await sendDirectMondayStatus(order))) {
        return json(request, {
          error: "Monday write access is not connected.",
        }, 409);
      }
      return json(request, {
        ok: true,
        synced: true,
        state: String(order.state),
        mondayItemId: String(order.monday_item_id),
      });
    }
    if (action === "reconcile") {
      if (caller.profile.role !== "internal" || !caller.canManageOrders) {
        return json(request, { error: "Forbidden" }, 403);
      }
      const orderId = clean(body.orderId, 80);
      const orderNumber = clean(body.orderNumber, 160);
      const mondayItemId = clean(body.mondayItemId, 160);
      const mondayBoardId = clean(body.mondayBoardId, 160);
      if (!orderId || !orderNumber || !mondayItemId) {
        return json(request, {
          error:
            "The portal order, Monday order number, and Monday item ID are required.",
        }, 400);
      }
      const order = await orderById(orderId);
      if (!order || order.workflow_state !== "needs_reconciliation") {
        return json(request, {
          error: "That order is not awaiting reconciliation.",
        }, 409);
      }
      await assertOrderAccess(caller, order);
      const { error } = await service.rpc("portal_mark_order_workflow", {
        p_order_id: orderId,
        p_workflow_state: "accepted",
        p_order_number: orderNumber,
        p_monday_item_id: mondayItemId,
        p_monday_board_id: mondayBoardId || null,
        p_error: null,
        p_metadata: {
          reconciledBy: caller.user.email ?? caller.profile.id,
          reconciledAt: new Date().toISOString(),
        },
      });
      if (error) throw error;
      const updated = await orderById(orderId);
      return json(request, {
        ok: true,
        reconciled: true,
        order: updated ? (await hydrateOrders([updated]))[0] : null,
      });
    }
    if (action !== "transition") {
      return json(request, { error: "Unsupported order action" }, 400);
    }
    const orderId = clean(body.orderId, 80);
    const targetState = clean(body.targetState, 80).toLowerCase();
    if (
      !orderId ||
      !new Set(["ordered", "approved", "processed", "delivered", "declined"])
        .has(targetState)
    ) {
      return json(
        request,
        { error: "Choose a supported order transition." },
        400,
      );
    }
    const order = await orderById(orderId);
    if (!order || order.workflow_state !== "accepted") {
      return json(request, { error: "Portal order not found" }, 404);
    }
    await assertOrderAccess(caller, order);
    const permission = transitionAllowed(
      caller,
      String(order.state),
      targetState,
    );
    if (!permission.allowed) {
      return json(request, {
        error: "Your role cannot make that order transition.",
      }, 403);
    }
    const result = await applyTransition(
      order,
      targetState,
      permission.source,
      String(caller.profile.id),
      clean(caller.user.email, 320) || null,
      clean(body.note, 1200) || null,
      null,
      true,
    );
    const updated = await orderById(orderId);
    return json(request, {
      ok: true,
      ...result,
      order: updated ? (await hydrateOrders([updated]))[0] : null,
    });
  } catch (error) {
    const status = error instanceof PortalError ? error.status : 500;
    if (!(error instanceof PortalError)) console.error("portal-orders", error);
    return json(request, {
      error: error instanceof PortalError
        ? error.message
        : "The order service is temporarily unavailable.",
    }, status);
  }
});
