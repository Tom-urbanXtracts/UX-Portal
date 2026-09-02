import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifyHs256Jwt } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_SIGNING_SECRET = Deno.env.get("MONDAY_SIGNING_SECRET") ?? "";
const MONDAY_STATUS_SECRET = Deno.env.get("MONDAY_STATUS_SECRET") ?? "";
const ORDER_BOARD_ID = Deno.env.get("MONDAY_ORDER_BOARD_ID") ?? "18428025898";
const ORDER_STATUS_COLUMN_ID = Deno.env.get("MONDAY_ORDER_STATUS_COLUMN_ID") ??
  "color_mm6jxv8f";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

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

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes)).map((item) =>
    item.toString(16).padStart(2, "0")
  ).join("");
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  return authorization.replace(/^Bearer\s+/i, "");
}

function accountClaim(claims: Row): string {
  return clean(claims.accountId ?? claims.account_id, 80);
}

async function finishEvent(
  eventKey: string,
  state: "processed" | "rejected" | "failed",
  responseStatus: number,
  error: string | null,
): Promise<void> {
  const { error: finishError } = await service.rpc(
    "portal_finish_monday_webhook_event",
    {
      p_event_key: eventKey,
      p_state: state,
      p_response_status: responseStatus,
      p_error: error,
    },
  );
  if (finishError) throw finishError;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const raw = await request.text();
  if (!raw || raw.length > 65_536) {
    return json({ error: "Invalid webhook body" }, 400);
  }
  let body: Row;
  try {
    body = JSON.parse(raw) as Row;
  } catch {
    return json({ error: "Invalid webhook JSON" }, 400);
  }

  const challenge = clean(body.challenge, 512);
  if (challenge && Object.keys(body).every((key) => key === "challenge")) {
    // monday.com's URL-verification request is intentionally non-mutating and
    // is echoed before a subscription exists. All event requests below require
    // the app Signing Secret JWT.
    return json({ challenge });
  }
  if (!MONDAY_SIGNING_SECRET || !MONDAY_STATUS_SECRET) {
    return json({ error: "Webhook receiver is not configured" }, 503);
  }

  const claims = await verifyHs256Jwt(
    bearerToken(request),
    MONDAY_SIGNING_SECRET,
  );
  if (!claims) return json({ error: "Invalid webhook signature" }, 401);

  const event = body.event && typeof body.event === "object"
    ? body.event as Row
    : null;
  if (!event) return json({ error: "Missing webhook event" }, 400);
  const boardId = clean(event.boardId, 80);
  const columnId = clean(event.columnId, 160);
  const itemId = clean(event.pulseId ?? event.itemId, 160);
  const subscriptionId = clean(event.subscriptionId, 160);
  const value = event.value && typeof event.value === "object"
    ? event.value as Row
    : {};
  const label = value.label && typeof value.label === "object"
    ? value.label as Row
    : {};
  const statusLabel = clean(label.text, 120);
  if (
    boardId !== ORDER_BOARD_ID || columnId !== ORDER_STATUS_COLUMN_ID ||
    !itemId || !subscriptionId || !statusLabel
  ) {
    console.error("monday-webhook scope rejected", JSON.stringify({
      boardId,
      columnId,
      itemId,
      subscriptionId,
      statusLabel,
      expectedBoardId: ORDER_BOARD_ID,
      expectedColumnId: ORDER_STATUS_COLUMN_ID,
    }));
    return json({
      error: "Webhook event is outside the configured order status scope",
    }, 403);
  }

  const { data: connection, error: connectionError } = await service.from(
    "monday_connection_state",
  ).select("account_id,webhook_id,webhook_status").eq("id", 1).maybeSingle();
  if (connectionError) {
    return json({ error: "Webhook state is temporarily unavailable" }, 503);
  }
  if (!connection || connection.webhook_status !== "active") {
    console.error("monday-webhook connection rejected", JSON.stringify({
      webhookStatus: String(connection?.webhook_status ?? "missing"),
    }));
    return json({ error: "Unknown webhook subscription" }, 403);
  }
  // monday's event.subscriptionId identifies the integration event
  // subscription and is not the same ID returned by create_webhook. The
  // signed account plus the exact active board and column are the binding;
  // the event subscription ID remains useful for audit and replay records.
  const signedAccountId = accountClaim(claims);
  if (
    signedAccountId && connection.account_id &&
    signedAccountId !== String(connection.account_id)
  ) {
    console.error("monday-webhook account rejected", JSON.stringify({
      signedAccountId,
      expectedAccountId: String(connection.account_id),
    }));
    return json(
      { error: "Webhook account does not match the installed app" },
      403,
    );
  }

  const payloadHash = await sha256(raw);
  const eventKey = clean(
    event.originalTriggerUuid ?? event.triggerUuid,
    200,
  ) || payloadHash;
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
    return json({
      ok: true,
      duplicate: true,
      state: claim?.prior_state ?? "processing",
    });
  }

  let portalResponse: Response;
  let portalBody: Row = {};
  try {
    portalResponse = await fetch(`${SUPABASE_URL}/functions/v1/portal-orders`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        "content-type": "application/json",
        "x-ux-monday-secret": MONDAY_STATUS_SECRET,
      },
      body: JSON.stringify({
        action: "monday-status",
        mondayItemId: itemId,
        mondayBoardId: boardId,
        status: statusLabel,
        note: "Authenticated monday.com board status webhook",
      }),
    });
    portalBody = await portalResponse.json().catch(() => ({})) as Row;
  } catch {
    await finishEvent(
      eventKey,
      "failed",
      503,
      "Portal order callback could not be reached.",
    );
    return json({ error: "Portal order callback could not be reached" }, 503);
  }

  if (portalResponse.ok) {
    await finishEvent(eventKey, "processed", portalResponse.status, null);
    return json({ ok: true, duplicate: false });
  }
  const portalError = clean(portalBody.error, 500) ||
    `Portal order callback returned ${portalResponse.status}.`;
  if (portalResponse.status === 400) {
    // An authenticated but unmapped status is deliberately rejected once. It
    // cannot change a portal order, and retrying the same label adds no value.
    await finishEvent(eventKey, "rejected", portalResponse.status, portalError);
    return json({ ok: true, ignored: true, reason: portalError });
  }
  await finishEvent(eventKey, "failed", portalResponse.status, portalError);
  return json(
    { error: "Portal order callback was not accepted" },
    portalResponse.status >= 500 ? 503 : portalResponse.status,
  );
});
