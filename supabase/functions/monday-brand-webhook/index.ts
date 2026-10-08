import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { mondayAccessToken } from "../_shared/monday-connection.ts";
import { verifyHs256Jwt } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_SIGNING_SECRET = Deno.env.get("MONDAY_SIGNING_SECRET") ?? "";
const TOKEN_ENCRYPTION_KEY = Deno.env.get("MONDAY_TOKEN_ENCRYPTION_KEY") ?? "";
const MONDAY_CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID") ?? "";
const MONDAY_CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

const STATUS_MAP: Record<string, string> = {
  submitted: "submitted",
  approved: "approved",
  scheduled: "scheduled",
  "in production": "in_production",
  "quality review": "quality_review",
  complete: "complete",
  shipped: "shipped",
  exception: "exception",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function uuid(value: unknown): string | null {
  const candidate = clean(value, 80).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : null;
}

function bearerToken(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function accountClaim(claims: Row): string {
  return clean(claims.accountId ?? claims.account_id, 80);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((item) => item.toString(16).padStart(2, "0")).join("");
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
    throw new Error("Monday item details could not be read.");
  }
  return body.data && typeof body.data === "object" ? body.data as Row : {};
}

function columnMap(item: Row): Map<string, Row> {
  const rows = Array.isArray(item.column_values) ? item.column_values as Row[] : [];
  return new Map(rows.map((row) => [String(row.id ?? ""), row]));
}

function columnText(columns: Map<string, Row>, columnId: string, max = 300): string {
  return clean(columns.get(columnId)?.text, max);
}

function columnDate(columns: Map<string, Row>, columnId: string): string | null {
  const column = columns.get(columnId);
  const raw = clean(column?.value, 2000);
  if (raw) {
    try {
      const value = JSON.parse(raw) as Row;
      const date = clean(value.date, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    } catch {
      // Fall back to the human-readable value below.
    }
  }
  const text = clean(column?.text, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : null;
}

async function finishEvent(
  eventKey: string,
  state: "processed" | "rejected" | "failed",
  responseStatus: number,
  error: string | null,
): Promise<void> {
  const { error: finishError } = await service.rpc("portal_finish_monday_webhook_event", {
    p_event_key: eventKey,
    p_state: state,
    p_response_status: responseStatus,
    p_error: error,
  });
  if (finishError) throw finishError;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await request.text();
  if (!raw || raw.length > 65_536) return json({ error: "Invalid webhook body" }, 400);
  let body: Row;
  try {
    body = JSON.parse(raw) as Row;
  } catch {
    return json({ error: "Invalid webhook JSON" }, 400);
  }
  const challenge = clean(body.challenge, 512);
  if (challenge && Object.keys(body).every((key) => key === "challenge")) {
    return json({ challenge });
  }
  if (!MONDAY_SIGNING_SECRET || !TOKEN_ENCRYPTION_KEY) {
    return json({ error: "Webhook receiver is not configured" }, 503);
  }
  const claims = await verifyHs256Jwt(bearerToken(request), MONDAY_SIGNING_SECRET);
  if (!claims) return json({ error: "Invalid webhook signature" }, 401);

  const event = body.event && typeof body.event === "object" ? body.event as Row : null;
  if (!event) return json({ error: "Missing webhook event" }, 400);
  const boardId = clean(event.boardId, 80);
  const columnId = clean(event.columnId, 160);
  const itemId = clean(event.pulseId ?? event.itemId, 160);
  const subscriptionId = clean(event.subscriptionId, 160);
  const value = event.value && typeof event.value === "object" ? event.value as Row : {};
  const label = value.label && typeof value.label === "object" ? value.label as Row : {};
  const statusLabel = clean(label.text, 120);
  const status = STATUS_MAP[statusLabel.toLowerCase()] ?? "";

  const [
    { data: connection },
    { data: binding, error: bindingError },
    { data: workflowControl },
  ] = await Promise.all([
    service.from("monday_connection_state").select("account_id,connection_status").eq("id", 1).maybeSingle(),
    service.from("monday_brand_milestone_state")
      .select("board_id,column_mapping,webhook_status")
      .eq("id", 1).maybeSingle(),
    service.from("portal_workflow_control").select("mode")
      .eq("workflow_key", "brand_manufacturing").maybeSingle(),
  ]);
  const mapping = binding?.column_mapping && typeof binding.column_mapping === "object"
    ? binding.column_mapping as Row
    : {};
  if (
    bindingError || !binding || binding.webhook_status !== "active" ||
    connection?.connection_status !== "connected"
  ) {
    return json({ error: "Unknown webhook subscription" }, 403);
  }
  if (
    boardId !== String(binding.board_id ?? "") ||
    columnId !== clean(mapping.status, 160) || !itemId || !subscriptionId || !status
  ) {
    return json({ error: "Webhook event is outside the approved Brand milestone scope" }, 403);
  }
  const signedAccountId = accountClaim(claims);
  if (signedAccountId && connection.account_id && signedAccountId !== String(connection.account_id)) {
    return json({ error: "Webhook account does not match the installed app" }, 403);
  }

  const payloadHash = await sha256(raw);
  const eventKey = clean(event.originalTriggerUuid ?? event.triggerUuid, 200) || payloadHash;
  const { data: claimRows, error: claimError } = await service.rpc(
    "portal_claim_monday_webhook_event",
    {
      p_event_key: eventKey,
      p_subscription_id: subscriptionId,
      p_board_id: boardId,
      p_item_id: itemId,
      p_status_label: statusLabel,
      p_payload_sha256: payloadHash,
    },
  );
  if (claimError) return json({ error: "Webhook replay check failed" }, 503);
  const claim = Array.isArray(claimRows) ? claimRows[0] : null;
  if (!claim?.claimed) {
    return json({ ok: true, duplicate: true, state: claim?.prior_state ?? "processing" });
  }

  if (workflowControl?.mode === "portal") {
    await finishEvent(eventKey, "processed", 200, null);
    return json({
      ok: true,
      ignored: true,
      reason: "portal_source_of_truth",
      itemId,
    });
  }

  try {
    const requiredKeys = ["organizationId", "reference", "productName", "purchaseOrderId", "plannedOn", "startedOn", "completedOn", "exceptionOwner", "exceptionNote"];
    if (requiredKeys.some((key) => !clean(mapping[key], 160))) {
      throw new Error("The stored Brand milestone column mapping is incomplete.");
    }
    const accessToken = await mondayAccessToken(service, {
      encryptionKey: TOKEN_ENCRYPTION_KEY,
      clientId: MONDAY_CLIENT_ID,
      clientSecret: MONDAY_CLIENT_SECRET,
    }, ["boards:read"]);
    if (!accessToken) throw new Error("The Monday connection cannot read the Brand milestone item.");
    const columnIds = requiredKeys.map((key) => clean(mapping[key], 160));
    const data = await mondayGraphql(
      accessToken,
      `query BrandMilestoneItem($itemIds: [ID!]!, $columnIds: [String!]) {
        items(ids: $itemIds) {
          id name board { id }
          column_values(ids: $columnIds) { id text value type }
        }
      }`,
      { itemIds: [itemId], columnIds },
    );
    const item = Array.isArray(data.items) ? data.items[0] as Row | undefined : undefined;
    const itemBoard = item?.board && typeof item.board === "object" ? item.board as Row : {};
    if (!item || String(item.id ?? "") !== itemId || String(itemBoard.id ?? "") !== boardId) {
      throw new Error("The Monday milestone item is missing or belongs to another board.");
    }
    const columns = columnMap(item);
    const organizationId = uuid(columnText(columns, clean(mapping.organizationId, 160), 80));
    const reference = columnText(columns, clean(mapping.reference, 160), 120);
    const purchaseOrderId = uuid(columnText(columns, clean(mapping.purchaseOrderId, 160), 80));
    const rawPurchaseOrderId = columnText(columns, clean(mapping.purchaseOrderId, 160), 80);
    const exceptionOwner = columnText(columns, clean(mapping.exceptionOwner, 160), 200);
    const exceptionNote = columnText(columns, clean(mapping.exceptionNote, 160), 2000);
    if (!organizationId || !reference) {
      throw new Error("Brand Organization ID and Reference are required before changing the milestone.");
    }
    if (rawPurchaseOrderId && !purchaseOrderId) {
      throw new Error("Purchase Order ID must be a valid portal UUID when supplied.");
    }
    if (status === "exception" && (!exceptionOwner || !exceptionNote)) {
      throw new Error("Exception Owner and Exception Note are required for an Exception milestone.");
    }
    const { data: organization } = await service.from("portal_organization")
      .select("id,kind,status").eq("id", organizationId).maybeSingle();
    if (!organization || organization.kind !== "brand" || organization.status === "inactive") {
      throw new Error("Brand Organization ID does not identify an active Brand workspace.");
    }
    if (purchaseOrderId) {
      const { data: purchaseOrder } = await service.from("portal_brand_purchase_order")
        .select("id").eq("id", purchaseOrderId).eq("organization_id", organizationId).maybeSingle();
      if (!purchaseOrder) throw new Error("Purchase Order ID is not part of this Brand workspace.");
    }
    const record = {
      organization_id: organizationId,
      purchase_order_id: purchaseOrderId,
      monday_item_id: itemId,
      reference,
      product_name: columnText(columns, clean(mapping.productName, 160), 300) || clean(item.name, 300) || null,
      status,
      planned_on: columnDate(columns, clean(mapping.plannedOn, 160)),
      started_on: columnDate(columns, clean(mapping.startedOn, 160)),
      completed_on: columnDate(columns, clean(mapping.completedOn, 160)),
      exception_owner: exceptionOwner || null,
      exception_note: exceptionNote || null,
      source_mode: "monday_historical",
      assigned_department: "Administrator",
      source_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data: projection, error: upsertError } = await service.from(
      "portal_brand_manufacturing_projection",
    ).upsert(record, { onConflict: "organization_id,monday_item_id" }).select("id").single();
    if (upsertError) throw upsertError;
    await service.from("portal_brand_operation_event").insert({
      organization_id: organizationId,
      actor_id: null,
      actor_email: "monday.webhook@system",
      action: "brand_manufacturing_updated_from_monday",
      target_type: "manufacturing_projection",
      target_id: projection.id,
      detail: { boardId, itemId, status, statusLabel, signedWebhook: true },
    });
    await service.from("monday_brand_milestone_state").update({
      last_verified_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    await finishEvent(eventKey, "processed", 200, null);
    return json({ ok: true, itemId, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Brand milestone processing failed.";
    const rejected = /required|valid|does not identify|not part of|another board/i.test(message);
    await finishEvent(eventKey, rejected ? "rejected" : "failed", rejected ? 422 : 503, message);
    await service.from("monday_brand_milestone_state").update({
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    return json({ error: message }, rejected ? 422 : 503);
  }
});
