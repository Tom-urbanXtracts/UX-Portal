import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_PRODUCT_BOARD_ID = Deno.env.get("MONDAY_PRODUCT_BOARD_ID") ??
  "9620649212";
const MONDAY_LOT_BOARD_ID = Deno.env.get("MONDAY_LOT_BOARD_ID") ??
  "18429359264";
const QBO_ENVIRONMENT = (Deno.env.get("QBO_ENVIRONMENT") ?? "").trim()
  .toLowerCase();
const ASSET_UPLOADS_ENABLED = Deno.env.get("PORTAL_ASSET_UPLOADS_ENABLED") ===
  "true";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };
type Check = {
  state: "pass" | "warn" | "block" | "deferred";
  label: string;
  detail: string;
};

class ReadinessError extends Error {
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
      "https://portal.urbanxtracts.com",
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
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
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

function configured(name: string): boolean {
  return Boolean((Deno.env.get(name) ?? "").trim());
}

function ageMinutes(value: unknown): number | null {
  const parsed = value ? new Date(String(value)).getTime() : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(0, Math.round((Date.now() - parsed) / 60000))
    : null;
}

function effectiveQuickBooksConnectionStatus(qbo: Row | null): string {
  if (
    !["sandbox", "production"].includes(QBO_ENVIRONMENT) ||
    qbo?.connection_environment !== QBO_ENVIRONMENT
  ) return "disconnected";
  const status = String(qbo?.connection_status ?? "disconnected");
  if (status !== "authorizing") return status;
  const expiresAt = Date.parse(String(qbo?.oauth_state_expires_at ?? ""));
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? "authorizing"
    : "disconnected";
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  if (!verifiedTokenHasAal2(authorization)) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile")
    .select("id,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") {
    return null;
  }
  const { data: grants } = await service.from("portal_role_permission").select(
    "permission",
  )
    .eq("staff_role", profile.staff_role).in("permission", [
      "readiness.read",
      "readiness.manage",
    ]);
  const permissions = new Set((grants ?? []).map((row) => row.permission));
  return permissions.has("readiness.read")
    ? {
      user,
      profile: profile as Row,
      canManage: permissions.has("readiness.manage"),
    }
    : null;
}

function clean(value: unknown, max = 2000): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
}

function workTask(row: Row, comments: Row[], evidence: Row[]): Row {
  return {
    id: row.id,
    key: row.task_key,
    title: row.title,
    section: row.section,
    description: row.description,
    status: row.status,
    owner: row.owner_label,
    dueOn: row.due_on,
    evidenceSummary: row.evidence_summary,
    sourceReference: row.source_reference,
    completionCheck: row.completion_check,
    updatedAt: row.updated_at,
    comments: comments.filter((entry) => entry.task_id === row.id).map((entry) => ({
      id: entry.id,
      body: entry.body,
      actorEmail: entry.actor_email,
      createdAt: entry.created_at,
    })),
    evidence: evidence.filter((entry) => entry.task_id === row.id).map((entry) => ({
      id: entry.id,
      label: entry.label,
      url: entry.url,
      note: entry.note,
      actorEmail: entry.actor_email,
      createdAt: entry.created_at,
    })),
  };
}

async function workRegister(): Promise<Row[]> {
  const [taskResult, commentResult, evidenceResult] = await Promise.all([
    service.from("portal_readiness_task").select("*").eq("active", true)
      .order("sort_order").order("updated_at", { ascending: false }),
    service.from("portal_readiness_comment").select("*")
      .order("created_at", { ascending: false }).limit(1000),
    service.from("portal_readiness_evidence").select("*")
      .order("created_at", { ascending: false }).limit(1000),
  ]);
  if (taskResult.error) throw taskResult.error;
  if (commentResult.error) throw commentResult.error;
  if (evidenceResult.error) throw evidenceResult.error;
  return (taskResult.data ?? []).map((row) => workTask(
    row as Row,
    (commentResult.data ?? []) as Row[],
    (evidenceResult.data ?? []) as Row[],
  ));
}

async function updateWorkRegister(caller: Caller, body: Row): Promise<void> {
  if (!caller.canManage) throw new ReadinessError(403, "Forbidden");
  const action = clean(body.action, 40).toLowerCase();
  const taskId = clean(body.taskId, 80);
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
    throw new ReadinessError(400, "A readiness task is required.");
  }
  const actorId = caller.profile.id;
  const actorEmail = clean(caller.user.email, 320) || null;
  if (action === "update-task") {
    const status = clean(body.status, 40);
    if (!new Set(["not_started", "in_progress", "completed", "controlled_hold"]).has(status)) {
      throw new ReadinessError(400, "Choose a supported readiness state.");
    }
    const dueOn = clean(body.dueOn, 10);
    if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
      throw new ReadinessError(400, "Use a valid due date.");
    }
    const { error } = await service.from("portal_readiness_task").update({
      status,
      owner_label: clean(body.owner, 240) || null,
      due_on: dueOn || null,
      evidence_summary: clean(body.evidenceSummary, 2000) || null,
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    }).eq("id", taskId).eq("active", true);
    if (error) throw error;
  } else if (action === "add-comment") {
    const comment = clean(body.comment, 3000);
    if (!comment) {
      throw new ReadinessError(400, "Enter a comment before saving.");
    }
    const { error } = await service.from("portal_readiness_comment").insert({
      task_id: taskId,
      body: comment,
      actor_id: actorId,
      actor_email: actorEmail,
    });
    if (error) throw error;
  } else if (action === "add-evidence") {
    const label = clean(body.label, 300);
    const url = clean(body.url, 2000);
    const note = clean(body.note, 3000);
    if (!label || (!url && !note)) {
      throw new ReadinessError(
        400,
        "Evidence needs a label and a URL or note.",
      );
    }
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ReadinessError(
          400,
          "Evidence URLs must be valid HTTPS links.",
        );
      }
      if (parsed.protocol !== "https:") {
        throw new ReadinessError(400, "Evidence URLs must use HTTPS.");
      }
    }
    const { error } = await service.from("portal_readiness_evidence").insert({
      task_id: taskId,
      label,
      url: url || null,
      note: note || null,
      actor_id: actorId,
      actor_email: actorEmail,
    });
    if (error) throw error;
  } else {
    throw new ReadinessError(400, "Unsupported readiness action.");
  }
  await service.from("portal_admin_audit").insert({
    actor_id: actorId,
    actor_org: caller.profile.org,
    action: `readiness.${action}`,
    detail: { taskId },
  });
}

async function exactCount(
  table: string,
  apply?: (query: any) => any,
): Promise<number> {
  let query = service.from(table).select("*", { count: "exact", head: true });
  if (apply) query = apply(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Row;
      await updateWorkRegister(caller, body);
      return json(request, { ok: true, tasks: await workRegister(), canManage: caller.canManage });
    }
    const today = new Date().toISOString().slice(0, 10);

    const [
      canixResult,
      canixSchedulerResult,
      canixItemResult,
      canixItemSchedulerResult,
      qboResult,
      qboSchedulerResult,
      mondayResult,
      lotIntegrityResult,
      lotSchedulerResult,
      latestMondayEventResult,
      latestMondayRefreshResult,
      latestMondayProductSyncResult,
      pendingOutbox,
      failedOutbox,
      activeCommitments,
      publishedContent,
      coaCount,
      canixOwnerAssignments,
      readyRetailers,
      readyStores,
      openOnboardingRequests,
      onboardingReconciliationRequests,
      activeStoresMissingSourceEvidence,
      activeProfiles,
      pendingPrices,
      wholesaleSourceRows,
      verifiedWholesaleRows,
      publishedDefaultPrices,
      pendingAssetReviews,
      activeAssets,
      quarantinedAssets,
      costObjectDecisionResult,
      costObjectSourceResult,
      validLotPointerResult,
    ] = await Promise.all([
      service.from("canix_sync_state").select(
        "status,last_successful_at,last_error,package_count,latest_source_updated_at",
      ).eq("id", 1).maybeSingle(),
      service.rpc("portal_canix_scheduler_state"),
      service.from("canix_item_sync_state").select(
        "status,last_successful_at,last_error,item_count,item_pages,latest_source_updated_at",
      ).eq("id", 1).maybeSingle(),
      service.rpc("portal_canix_item_scheduler_state"),
      service.from("quickbooks_sync_state").select(
        "status,connection_status,connection_environment,connected_at,realm_id,oauth_state_expires_at,last_successful_at,last_error,last_intuit_tid,customer_count",
      ).eq("id", 1).maybeSingle(),
      service.rpc("portal_quickbooks_scheduler_state"),
      service.from("monday_connection_state").select(
        "connection_status,connected_at,account_id,granted_scopes,access_token_expires_at,webhook_id,webhook_board_id,webhook_column_id,webhook_status,webhook_created_at,last_error",
      ).eq("id", 1).maybeSingle(),
      service.from("portal_lot_integrity_state").select(
        "monday_board_id,enforcement_mode,register_sync_status,last_register_sync_at,last_integrity_run_at,last_error,register_rows,approved_register_rows,invalid_register_rows,duplicate_register_rows,package_rows,valid_package_rows,exception_package_rows,allocation_exception_rows",
      ).eq("id", 1).maybeSingle(),
      service.rpc("portal_lot_integrity_scheduler_state"),
      service.from("monday_webhook_event").select(
        "subscription_id,board_id,item_id,status_label,processing_state,attempt_count,received_at,processed_at,response_status,last_error",
      ).order("received_at", { ascending: false }).limit(1).maybeSingle(),
      service.from("portal_admin_audit").select("created_at,detail").eq(
        "action",
        "monday.webhook_refreshed",
      ).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      service.from("portal_admin_audit").select("created_at,detail").eq(
        "action",
        "monday.product_content_synced",
      ).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      exactCount(
        "portal_order_sync_outbox",
        (query) => query.eq("state", "pending"),
      ),
      exactCount(
        "portal_order_sync_outbox",
        (query) => query.eq("state", "failed"),
      ),
      exactCount(
        "portal_inventory_commitment",
        (query) => query.eq("active", true),
      ),
      exactCount(
        "portal_product_content",
        (query) => query.eq("publication_state", "published"),
      ),
      exactCount("canix_package_coa"),
      exactCount(
        "canix_package_current",
        (query) => query.not("canix_package_owner_name", "is", null),
      ),
      exactCount(
        "portal_retailer_account",
        (query) => query.eq("portal_status", "ready_to_order"),
      ),
      exactCount(
        "portal_store",
        (query) =>
          query.eq("active", true).eq("license_status", "active").eq(
            "ordering_status",
            "ready",
          ).not("quickbooks_customer_id", "is", null).gt(
            "license_expires_on",
            today,
          ),
      ),
      exactCount(
        "portal_onboarding_request",
        (query) => query.not("stage", "in", "(ready,closed,rejected)"),
      ),
      exactCount(
        "portal_onboarding_request",
        (query) => query.eq("workflow_state", "needs_reconciliation"),
      ),
      exactCount(
        "portal_store",
        (query) =>
          query.eq("active", true).or(
            `quickbooks_customer_id.is.null,license_expires_on.is.null,license_expires_on.lte.${today}`,
          ),
      ),
      exactCount("portal_profile", (query) => query.eq("active", true)),
      exactCount(
        "portal_price_proposal",
        (query) => query.eq("state", "pending"),
      ),
      exactCount("portal_wholesale_price_source"),
      exactCount(
        "portal_wholesale_price_source",
        (query) => query.eq("review_state", "verified"),
      ),
      exactCount(
        "portal_default_price",
        (query) => query.eq("active", true),
      ),
      exactCount(
        "portal_asset",
        (query) => query.eq("state", "pending_review"),
      ),
      exactCount("portal_asset", (query) => query.eq("state", "active")),
      exactCount(
        "portal_asset",
        (query) => query.eq("state", "quarantined"),
      ),
      service.from("portal_lot_cost_object_decision").select(
        "lot_id,decision_status,cost_object_id",
      ),
      service.from("portal_inbound_lot").select(
        "lot_id,cost_object_id,approval_status",
      ).eq("active", true),
      service.from("portal_package_lot_control").select("lot_id").eq(
        "integrity_status",
        "valid",
      ).not("lot_id", "is", null),
    ]);
    if (canixResult.error) throw canixResult.error;
    if (canixSchedulerResult.error) throw canixSchedulerResult.error;
    if (canixItemResult.error) throw canixItemResult.error;
    if (canixItemSchedulerResult.error) throw canixItemSchedulerResult.error;
    if (qboResult.error) throw qboResult.error;
    if (qboSchedulerResult.error) throw qboSchedulerResult.error;
    if (mondayResult.error) throw mondayResult.error;
    if (lotIntegrityResult.error) throw lotIntegrityResult.error;
    if (lotSchedulerResult.error) throw lotSchedulerResult.error;
    if (latestMondayEventResult.error) throw latestMondayEventResult.error;
    if (latestMondayRefreshResult.error) throw latestMondayRefreshResult.error;
    if (latestMondayProductSyncResult.error) {
      throw latestMondayProductSyncResult.error;
    }
    if (costObjectDecisionResult.error) throw costObjectDecisionResult.error;
    if (costObjectSourceResult.error) throw costObjectSourceResult.error;
    if (validLotPointerResult.error) throw validLotPointerResult.error;

    const canix = canixResult.data as Row | null;
    const canixScheduler = Array.isArray(canixSchedulerResult.data) &&
        canixSchedulerResult.data.length
      ? canixSchedulerResult.data[0] as Row
      : null;
    const canixItem = canixItemResult.data as Row | null;
    const canixItemScheduler = Array.isArray(canixItemSchedulerResult.data) &&
        canixItemSchedulerResult.data.length
      ? canixItemSchedulerResult.data[0] as Row
      : null;
    const qbo = qboResult.data as Row | null;
    const qboScheduler = Array.isArray(qboSchedulerResult.data) &&
        qboSchedulerResult.data.length
      ? qboSchedulerResult.data[0] as Row
      : null;
    const monday = mondayResult.data as Row | null;
    const lotIntegrity = lotIntegrityResult.data as Row | null;
    const lotScheduler = Array.isArray(lotSchedulerResult.data) &&
        lotSchedulerResult.data.length
      ? lotSchedulerResult.data[0] as Row
      : null;
    const latestMondayEvent = latestMondayEventResult.data as Row | null;
    const latestMondayRefresh = latestMondayRefreshResult.data as Row | null;
    const latestMondayProductSync = latestMondayProductSyncResult.data as
      | Row
      | null;
    const costObjectDecisions = (costObjectDecisionResult.data ?? []) as Row[];
    const costObjectSources = new Map(
      ((costObjectSourceResult.data ?? []) as Row[]).map((row) => [
        String(row.lot_id ?? ""),
        row,
      ]),
    );
    const validLotIds = new Set(
      ((validLotPointerResult.data ?? []) as Row[]).map((row) =>
        String(row.lot_id ?? "")
      ).filter(Boolean),
    );
    const costObjectDecisionByLot = new Map(
      costObjectDecisions.map((row) => [String(row.lot_id ?? ""), row]),
    );
    let costObjectPending = 0;
    let costObjectAssigned = 0;
    let costObjectNotRequired = 0;
    let costObjectConflicts = 0;
    for (const lotId of validLotIds) {
      const decision = costObjectDecisionByLot.get(lotId);
      const source = costObjectSources.get(lotId);
      const status = String(decision?.decision_status ?? "pending_assignment");
      const sourceCode = String(source?.cost_object_id ?? "").trim()
        .toUpperCase();
      const decisionCode = String(decision?.cost_object_id ?? "").trim()
        .toUpperCase();
      if (status === "assigned") {
        if (
          source?.approval_status === "approved" && sourceCode &&
          sourceCode === decisionCode
        ) costObjectAssigned += 1;
        else costObjectConflicts += 1;
      } else if (status === "not_required") {
        if (sourceCode) costObjectConflicts += 1;
        else costObjectNotRequired += 1;
      } else costObjectPending += 1;
    }
    const latestMondayRefreshDetail = latestMondayRefresh?.detail &&
        typeof latestMondayRefresh.detail === "object"
      ? latestMondayRefresh.detail as Row
      : {};
    const remainingWebhookIds = Array.isArray(
        latestMondayRefreshDetail.remainingWebhookIds,
      )
      ? latestMondayRefreshDetail.remainingWebhookIds.map(String)
      : [];
    const failedWebhookIds = Array.isArray(
        latestMondayRefreshDetail.failedWebhookIds,
      )
      ? latestMondayRefreshDetail.failedWebhookIds.map(String)
      : [];
    const removedWebhookIds = Array.isArray(
        latestMondayRefreshDetail.removedWebhookIds,
      )
      ? latestMondayRefreshDetail.removedWebhookIds.map(String)
      : [];
    const latestMondayProductDetail = latestMondayProductSync?.detail &&
        typeof latestMondayProductSync.detail === "object"
      ? latestMondayProductSync.detail as Row
      : {};
    const mondayScopes = Array.isArray(monday?.granted_scopes)
      ? monday.granted_scopes.map(String)
      : [];
    const canixAge = ageMinutes(canix?.last_successful_at);
    const canixItemAge = ageMinutes(canixItem?.last_successful_at);
    const qboAge = ageMinutes(qbo?.last_successful_at);
    const mondayCallbackAge = ageMinutes(latestMondayEvent?.received_at);
    const mondayOAuthReady = configured("MONDAY_CLIENT_ID") &&
      configured("MONDAY_CLIENT_SECRET") &&
      configured("MONDAY_TOKEN_ENCRYPTION_KEY") &&
      monday?.connection_status === "connected";
    const qboConnectionStatus = effectiveQuickBooksConnectionStatus(qbo);
    const directMondayIntakeReady = mondayOAuthReady &&
      configured("MONDAY_ORDER_BOARD_ID") &&
      configured("MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID");
    const directMondayProductReady = mondayOAuthReady &&
      mondayScopes.includes("boards:read") &&
      /^\d+$/.test(MONDAY_PRODUCT_BOARD_ID);
    const mondayLotRegisterReady = mondayOAuthReady &&
      mondayScopes.includes("boards:read") &&
      /^\d+$/.test(MONDAY_LOT_BOARD_ID) &&
      String(lotIntegrity?.monday_board_id ?? "") === MONDAY_LOT_BOARD_ID;
    const signedMondayReady = mondayOAuthReady &&
      configured("MONDAY_SIGNING_SECRET") &&
      monday?.webhook_status === "active" && Boolean(monday?.webhook_id);
    const latestMondayCallbackOk = Boolean(latestMondayEvent) &&
      latestMondayEvent?.processing_state === "processed" &&
      Number(latestMondayEvent?.response_status) === 200 &&
      !latestMondayEvent?.last_error &&
      String(latestMondayEvent?.board_id ?? "") ===
        String(monday?.webhook_board_id ?? "");
    const lastRefreshHasOneWebhook = Boolean(latestMondayRefresh) &&
      failedWebhookIds.length === 0 && remainingWebhookIds.length === 1 &&
      remainingWebhookIds[0] === String(monday?.webhook_id ?? "");
    const checks: Array<{ key: string; label: string; checks: Check[] }> = [
      {
        key: "canix",
        label: "Canix inventory",
        checks: [
          {
            state: configured("CANIX_API_KEY") ? "pass" : "block",
            label: "Server credential",
            detail: configured("CANIX_API_KEY")
              ? "Configured server-side; never sent to the browser."
              : "CANIX_API_KEY is not configured.",
          },
          {
            state: configured("CANIX_CRON_SECRET") &&
                canixScheduler?.secret_configured &&
                canixScheduler?.job_scheduled
              ? "pass"
              : "block",
            label: "Vault-backed five-minute scheduler",
            detail: configured("CANIX_CRON_SECRET") &&
                canixScheduler?.secret_configured &&
                canixScheduler?.job_scheduled
              ? "The Edge credential and matching Vault-backed job are configured; no secret is embedded in the cron command."
              : "The Canix Edge credential, Vault credential, or active five-minute job is incomplete.",
          },
          {
            state: canix?.last_successful_at
              ? (canixAge !== null && canixAge <= 10 ? "pass" : "warn")
              : "block",
            label: "Last successful snapshot",
            detail: canix?.last_successful_at
              ? `${canix.package_count ?? 0} packages; ${canixAge} minutes old.`
              : "No successful snapshot is recorded.",
          },
          {
            state: canix?.status === "error" ? "block" : "pass",
            label: "Current sync state",
            detail: canix?.status === "error"
              ? `Error recorded: ${
                String(canix.last_error ?? "Unknown error").slice(0, 240)
              }`
              : `State: ${canix?.status ?? "never"}.`,
          },
          {
            state: canixItem?.last_successful_at
              ? (canixItemAge !== null && canixItemAge <= 10 ? "pass" : "warn")
              : "block",
            label: "Complete Item Master snapshot",
            detail: canixItem?.last_successful_at
              ? `${
                canixItem.item_count ?? 0
              } active and inactive Item IDs; ${canixItemAge} minutes old.`
              : "No complete GET /items snapshot is recorded.",
          },
          {
            state: configured("CANIX_CRON_SECRET") &&
                canixItemScheduler?.secret_configured &&
                canixItemScheduler?.job_scheduled &&
                canixItem?.status !== "error"
              ? "pass"
              : "block",
            label: "Independent Item Master scheduler",
            detail: configured("CANIX_CRON_SECRET") &&
                canixItemScheduler?.secret_configured &&
                canixItemScheduler?.job_scheduled &&
                canixItem?.status !== "error"
              ? "The complete Item Master refresh is active and fault-isolated from package inventory."
              : canixItem?.status === "error"
              ? `Item Master error: ${
                String(canixItem.last_error ?? "Unknown error").slice(0, 240)
              }`
              : "The Vault-backed Item Master job is incomplete.",
          },
          {
            state: canixOwnerAssignments > 0 ? "pass" : "warn",
            label: "Canix Package Owner source",
            detail: canixOwnerAssignments > 0
              ? `${canixOwnerAssignments} current package assignments are available as an operational Canix user field; Economic Owner remains separate.`
              : "The REST-backed portal snapshot contains no Package Owner assignments. Canix Reporting has an owner field, but the runtime needs a supported Reporting bridge or a documented REST property before this can be treated as connected.",
          },
          {
            state: lotIntegrity?.enforcement_mode === "block"
              ? Number(lotIntegrity?.allocation_exception_rows ?? 0) === 0
                ? "pass"
                : "block"
              : "warn",
            label: "Economic-ownership allocation gate",
            detail: lotIntegrity?.enforcement_mode === "block"
              ? `${
                lotIntegrity?.allocation_exception_rows ?? 0
              } available or allocated packages fail the enforced lot-pointer control.`
              : `${
                lotIntegrity?.allocation_exception_rows ?? 0
              } available or allocated packages currently fail the lot-pointer control. Monitor mode intentionally preserves ordering during historical reconciliation.`,
          },
          {
            state: costObjectConflicts > 0
              ? "block"
              : costObjectPending > 0
              ? "warn"
              : "pass",
            label: "Lot-level Cost Object decisions",
            detail:
              `${costObjectPending} pending; ${costObjectAssigned} assigned and source-validated; ${costObjectNotRequired} approved Not Required; ${costObjectConflicts} source conflicts.`,
          },
        ],
      },
      {
        key: "orders",
        label: "Orders and Monday",
        checks: [
          {
            state: directMondayIntakeReady ? "pass" : "block",
            label: "Order intake",
            detail: directMondayIntakeReady
              ? "Direct, board-pinned Monday order and onboarding intake is active; no shared intake credential is retained."
              : "The direct Monday app path is not ready.",
          },
          {
            state: signedMondayReady ? "pass" : "block",
            label: "Signed status return",
            detail: signedMondayReady
              ? `App OAuth is connected; signed webhook ${monday.webhook_id} is active for the order board.`
              : "An administrator must install the dedicated Monday app and create its signed order-status webhook.",
          },
          {
            state: !latestMondayEvent
              ? "warn"
              : latestMondayCallbackOk
              ? "pass"
              : "block",
            label: "Latest signed callback",
            detail: !latestMondayEvent
              ? "No signed Monday callback has been recorded yet."
              : latestMondayCallbackOk
              ? `${
                latestMondayEvent.status_label ?? "Status change"
              } processed ${mondayCallbackAge} minutes ago on attempt ${
                latestMondayEvent.attempt_count ?? 1
              }; HTTP 200.`
              : `Latest callback did not complete cleanly: ${
                String(
                  latestMondayEvent.last_error ??
                    latestMondayEvent.processing_state ?? "unknown state",
                ).slice(0, 240)
              }`,
          },
          {
            state: !latestMondayRefresh
              ? "warn"
              : lastRefreshHasOneWebhook
              ? "pass"
              : "block",
            label: "Last webhook refresh",
            detail: !latestMondayRefresh
              ? "No administrator webhook-refresh audit is recorded."
              : lastRefreshHasOneWebhook
              ? `Exactly one matching signed webhook remains; ${removedWebhookIds.length} obsolete subscription${
                removedWebhookIds.length === 1 ? " was" : "s were"
              } removed during the last refresh.`
              : `${remainingWebhookIds.length} matching webhooks remain and ${failedWebhookIds.length} deletions failed; refresh the signed webhook again.`,
          },
          {
            state: configured("ORDER_SYNC_CRON_SECRET") ? "pass" : "block",
            label: "Status retry scheduler",
            detail: configured("ORDER_SYNC_CRON_SECRET")
              ? "The durable status outbox retries every five minutes."
              : "ORDER_SYNC_CRON_SECRET is not configured.",
          },
          {
            state: failedOutbox > 0
              ? "block"
              : pendingOutbox > 0
              ? "warn"
              : "pass",
            label: "Status outbox",
            detail: `${pendingOutbox} pending; ${failedOutbox} failed.`,
          },
          {
            state: "pass",
            label: "Inventory commitments",
            detail:
              `${activeCommitments} active portal item commitments protect accepted orders from concurrent oversell.`,
          },
          {
            state: mondayLotRegisterReady ? "pass" : "block",
            label: "Protected inbound-lot register",
            detail: mondayLotRegisterReady
              ? `Monday board ${MONDAY_LOT_BOARD_ID} is pinned and readable through the server-side app connection.`
              : "The pinned private Monday inbound-lot register is not available through the server-side app connection.",
          },
          {
            state: lotIntegrity?.register_sync_status === "success"
              ? "pass"
              : lotIntegrity?.register_sync_status === "error"
              ? "block"
              : "warn",
            label: "Lot-register snapshot",
            detail: lotIntegrity?.register_sync_status === "success"
              ? `${lotIntegrity?.approved_register_rows ?? 0} of ${
                lotIntegrity?.register_rows ?? 0
              } register rows are approved; last synchronized ${
                ageMinutes(lotIntegrity?.last_register_sync_at)
              } minutes ago.`
              : lotIntegrity?.last_error
              ? `Latest lot-register sync failed: ${
                String(lotIntegrity.last_error).slice(0, 240)
              }`
              : "No successful Monday lot-register snapshot is recorded.",
          },
          {
            state:
              lotScheduler?.secret_configured && lotScheduler?.job_scheduled
                ? "pass"
                : "warn",
            label: "Daily lot-integrity scheduler",
            detail:
              lotScheduler?.secret_configured && lotScheduler?.job_scheduled
                ? "The Vault-authenticated Monday register sync and integrity check runs daily."
                : lotScheduler?.secret_configured
                ? "The scheduler credential exists, but the daily job still needs to be enabled."
                : "The database Vault credential lot_integrity_cron_secret is not configured; manual administrator sync remains available.",
          },
        ],
      },
      {
        key: "retailers",
        label: "Retailers, pricing, and access",
        checks: [
          {
            state: readyRetailers > 0 && readyStores > 0 ? "pass" : "warn",
            label: "Orderable accounts",
            detail:
              `${readyRetailers} ready retailer accounts; ${readyStores} qualified orderable stores.`,
          },
          {
            state: "pass",
            label: "Active users",
            detail:
              `${activeProfiles} active portal profiles. Deactivation is checked on every protected request.`,
          },
          {
            state: onboardingReconciliationRequests > 0 ? "warn" : "pass",
            label: "Store onboarding queue",
            detail:
              `${openOnboardingRequests} open requests; ${onboardingReconciliationRequests} require workflow reconciliation. The queue remains readable when QuickBooks is unavailable.`,
          },
          {
            state: activeStoresMissingSourceEvidence > 0 ? "warn" : "pass",
            label: "Store source evidence",
            detail: activeStoresMissingSourceEvidence > 0
              ? `${activeStoresMissingSourceEvidence} active legacy stores still need an explicit QuickBooks customer and/or license expiration. Newly qualified stores cannot pass without both.`
              : "Every active store has an explicit QuickBooks customer and recorded license expiration.",
          },
          {
            state: pendingPrices > 0 ? "warn" : "pass",
            label: "Pricing approvals",
            detail:
              `${pendingPrices} store-price proposals awaiting internal decision.`,
          },
          {
            state: wholesaleSourceRows > 0
              ? (publishedDefaultPrices > 0 ? "pass" : "warn")
              : "warn",
            label: "Default wholesale list",
            detail: wholesaleSourceRows > 0
              ? `${wholesaleSourceRows} approved source rows staged; ${verifiedWholesaleRows} verified but unpublished; ${publishedDefaultPrices} active default prices.`
              : "The approved wholesale source has not been staged.",
          },
        ],
      },
      {
        key: "content",
        label: "Catalog content and COAs",
        checks: [
          {
            state:
              directMondayProductReady || configured("MONDAY_PRODUCT_SECRET")
                ? "pass"
                : "warn",
            label: "Monday product content",
            detail: directMondayProductReady
              ? "The dedicated Monday app can scan the pinned product board using renewed server tokens."
              : configured("MONDAY_PRODUCT_SECRET")
              ? "Authenticated push ingestion is configured."
              : "Neither direct Monday board sync nor authenticated push ingestion is ready.",
          },
          {
            state: publishedContent > 0 ? "pass" : "warn",
            label: "Published merchandising records",
            detail:
              `${publishedContent} published product records. Canix product identity remains available when merchandising content is blank.`,
          },
          {
            state: !latestMondayProductSync
              ? "warn"
              : Number(latestMondayProductDetail.synced ?? 0) > 0
              ? "pass"
              : "warn",
            label: "Latest Monday catalog scan",
            detail: !latestMondayProductSync
              ? "No direct Monday product-board scan has been recorded yet."
              : `${Number(latestMondayProductDetail.synced ?? 0)} of ${
                Number(latestMondayProductDetail.scanned ?? 0)
              } board rows synchronized; ${
                Number(latestMondayProductDetail.missingCanixItemId ?? 0)
              } still need an explicit Canix Item ID and ${
                Number(latestMondayProductDetail.missingPublicationState ?? 0)
              } linked rows still need a publication state.`,
          },
          {
            state: configured("PORTAL_EXTERNAL_ASSET_HOSTS") ? "pass" : "warn",
            label: "Approved image and COA hosts",
            detail: configured("PORTAL_EXTERNAL_ASSET_HOSTS")
              ? "External catalog assets are restricted to the configured exact-host allowlist."
              : "PORTAL_EXTERNAL_ASSET_HOSTS is empty; external product images and COA links fail closed.",
          },
          {
            state: coaCount > 0 ? "pass" : "warn",
            label: "Structured COA records",
            detail:
              `${coaCount} current package COA records are stored with revision history enabled.`,
          },
          {
            state: quarantinedAssets > 0
              ? "warn"
              : pendingAssetReviews > 0
              ? "warn"
              : "pass",
            label: "Private portal assets",
            detail:
              `${activeAssets} active; ${pendingAssetReviews} awaiting review; ${quarantinedAssets} quarantined. Only active assets receive five-minute signed URLs.`,
          },
          {
            state: ASSET_UPLOADS_ENABLED ? "warn" : "deferred",
            label: "Portal-managed uploads",
            detail: ASSET_UPLOADS_ENABLED
              ? "Uploads are enabled and require a separate authorized reviewer; confirm the approved scanner is operating before production use."
              : "Product-image and portal-managed COA uploads are intentionally on hold until an approved content scanner is connected. Canix-supplied COA data remains available.",
          },
        ],
      },
      {
        key: "quickbooks",
        label: "QuickBooks read model",
        checks: [
          {
            state: QBO_ENVIRONMENT === "production"
              ? "pass"
              : QBO_ENVIRONMENT === "sandbox"
              ? "warn"
              : "block",
            label: "Environment isolation",
            detail: QBO_ENVIRONMENT === "production"
              ? "Production API routing is explicit; sandbox connections and snapshots cannot be reused."
              : QBO_ENVIRONMENT === "sandbox"
              ? "Sandbox API routing is explicit for pre-production evidence. Switching to production clears the sandbox cache before a live connection is accepted."
              : "QBO_ENVIRONMENT must be explicitly set to sandbox or production before authorization.",
          },
          {
            state:
              configured("QBO_CLIENT_ID") && configured("QBO_CLIENT_SECRET") &&
                configured("QBO_TOKEN_ENCRYPTION_KEY") &&
                qboConnectionStatus === "connected" && Boolean(qbo?.realm_id)
                ? "pass"
                : "warn",
            label: "Accounting connection",
            detail:
              configured("QBO_CLIENT_ID") && configured("QBO_CLIENT_SECRET") &&
                configured("QBO_TOKEN_ENCRYPTION_KEY") &&
                qboConnectionStatus === "connected" && Boolean(qbo?.realm_id)
                ? `The encrypted server-side customer, invoice, and payment connection is active in ${QBO_ENVIRONMENT}.`
                : `An administrator must finish the dedicated QuickBooks connection; financials remain read-only with last-snapshot fallback.${
                  qbo?.last_error
                    ? ` Latest connection result: ${qbo.last_error}`
                    : ""
                }${
                  qbo?.last_intuit_tid
                    ? ` Latest Intuit support ID: ${qbo.last_intuit_tid}.`
                    : ""
                }`,
          },
          {
            state: qbo?.last_successful_at ? "pass" : "warn",
            label: "Last successful snapshot",
            detail: qbo?.last_successful_at
              ? `${qbo.customer_count ?? 0} customers; ${qboAge} minutes old.`
              : "No successful QuickBooks snapshot is recorded.",
          },
          {
            state: qboScheduler?.secret_configured &&
                qboScheduler?.job_scheduled
              ? "pass"
              : "warn",
            label: "Five-minute scheduler",
            detail: qboScheduler?.secret_configured &&
                qboScheduler?.job_scheduled
              ? "The Vault-authenticated read sync is scheduled every five minutes."
              : qboScheduler?.secret_configured
              ? "The scheduler credential exists, but the five-minute job still needs to be enabled."
              : "The database Vault credential qbo_cron_secret is not configured; no failing job is scheduled.",
          },
        ],
      },
      {
        key: "controlled",
        label: "Controlled release boundaries",
        checks: [
          {
            state: "pass",
            label: "Production domain",
            detail:
              "portal.urbanxtracts.com is active with Wix DNS and SSL. The outer hosting gate is removed; the portal's Supabase session and server-side permissions remain the authorization boundary.",
          },
          {
            state: "pass",
            label: "Multi-factor assurance",
            detail:
              "This diagnostics request arrived with an aal2 session. Browser sign-in, authenticated Edge Functions, and restrictive profile policies require the same MFA assurance level.",
          },
          {
            state: "deferred",
            label: "Payment collection",
            detail:
              "The current release displays invoices and payments but does not collect funds.",
          },
          {
            state: "deferred",
            label: "Public COA and recall notices",
            detail:
              "Publication remains disabled pending CCO-approved content, retention, trigger, and anti-enumeration policy.",
          },
          {
            state: Deno.env.get("TURNSTILE_REQUIRED") === "true"
              ? configured("TURNSTILE_SECRET_KEY") &&
                  configured("TURNSTILE_ALLOWED_HOSTS") &&
                  configured("PUBLIC_INTAKE_RATE_SECRET")
                ? "pass"
                : "block"
              : "deferred",
            label: "Public onboarding protection",
            detail: Deno.env.get("TURNSTILE_REQUIRED") === "true"
              ? configured("TURNSTILE_SECRET_KEY") &&
                  configured("TURNSTILE_ALLOWED_HOSTS") &&
                  configured("PUBLIC_INTAKE_RATE_SECRET")
                ? "Turnstile and HMAC-scoped daily limits are configured without IP collection."
                : "Public onboarding is enabled but its protection values are incomplete."
              : "Public onboarding protection is disabled; signed-out intake must remain unexposed.",
          },
        ],
      },
    ];
    const flat = checks.flatMap((section) => section.checks);
    const blocking = flat.filter((item) => item.state === "block").length;
    const warnings = flat.filter((item) => item.state === "warn").length;
    return json(request, {
      generatedAt: new Date().toISOString(),
      status: blocking
        ? "action_required"
        : warnings
        ? "ready_for_qa_with_warnings"
        : "ready_for_qa",
      blocking,
      warnings,
      checks,
      policy: {
        sellable: "Canix active + status_category available",
        reservations:
          "Subtract explicit Canix reservation values; never replace unknown reservation data with zero in the source contract",
        catalogGrouping: "canix_item_id_v1",
        quantityTypes: ["WeightBased", "CountBased"],
        volumeExcluded: true,
      },
      tasks: await workRegister(),
      canManageTasks: caller.canManage,
      integrations: {
        canix: {
          packageLastSuccessfulAt: canix?.last_successful_at ?? null,
          packageCount: canix?.package_count ?? 0,
          itemMasterLastSuccessfulAt: canixItem?.last_successful_at ?? null,
          itemMasterLatestUpdatedAt: canixItem?.latest_source_updated_at ??
            null,
          itemMasterCount: canixItem?.item_count ?? 0,
          itemMasterPages: canixItem?.item_pages ?? 0,
          itemMasterStatus: canixItem?.status ?? "never_run",
        },
        monday: {
          connectionStatus: monday?.connection_status ?? "disconnected",
          connectedAt: monday?.connected_at ?? null,
          accountId: monday?.account_id ?? null,
          webhookStatus: monday?.webhook_status ?? "not_configured",
          webhookId: monday?.webhook_id ?? null,
          webhookBoardId: monday?.webhook_board_id ?? null,
          webhookColumnId: monday?.webhook_column_id ?? null,
          webhookCreatedAt: monday?.webhook_created_at ?? null,
          latestCallbackAt: latestMondayEvent?.received_at ?? null,
          latestCallbackStatus: latestMondayEvent?.status_label ?? null,
          latestCallbackResponseStatus: latestMondayEvent?.response_status ??
            null,
          latestCallbackSubscriptionId: latestMondayEvent?.subscription_id ??
            null,
          matchingWebhookCount: remainingWebhookIds.length || null,
          lastWebhookRefreshAt: latestMondayRefresh?.created_at ?? null,
          accessTokenExpiresAt: monday?.access_token_expires_at ?? null,
          productBoardId: MONDAY_PRODUCT_BOARD_ID,
          lotBoardId: MONDAY_LOT_BOARD_ID,
          lotRegisterSyncStatus: lotIntegrity?.register_sync_status ??
            "never_run",
          lotRegisterSyncAt: lotIntegrity?.last_register_sync_at ?? null,
          lotIntegrityCheckAt: lotIntegrity?.last_integrity_run_at ?? null,
          lotEnforcementMode: lotIntegrity?.enforcement_mode ?? "monitor",
          lotRegisterRows: lotIntegrity?.register_rows ?? 0,
          lotPackageExceptions: lotIntegrity?.exception_package_rows ?? 0,
          lotAllocationExceptions: lotIntegrity?.allocation_exception_rows ?? 0,
          lastProductSyncAt: latestMondayProductSync?.created_at ?? null,
          lastProductSyncScanned: latestMondayProductDetail.scanned ?? null,
          lastProductSyncSynced: latestMondayProductDetail.synced ?? null,
          lastProductSyncMissingCanixItemId:
            latestMondayProductDetail.missingCanixItemId ?? null,
        },
        quickbooks: {
          connectionStatus: qboConnectionStatus,
          environment: ["sandbox", "production"].includes(QBO_ENVIRONMENT)
            ? QBO_ENVIRONMENT
            : "not_configured",
          connectedEnvironment: qbo?.connection_environment ?? null,
          connectedAt: qbo?.connected_at ?? null,
          lastSuccessfulAt: qbo?.last_successful_at ?? null,
        },
      },
    });
  } catch (error) {
    const status = error instanceof ReadinessError ? error.status : 500;
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected readiness error",
    }, status);
  }
});
