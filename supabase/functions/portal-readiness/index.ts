import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_PRODUCT_BOARD_ID = Deno.env.get("MONDAY_PRODUCT_BOARD_ID") ??
  "9620649212";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Check = {
  state: "pass" | "warn" | "block" | "deferred";
  label: string;
  detail: string;
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
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
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

async function callerFor(request: Request): Promise<Row | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile")
    .select("id,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") {
    return null;
  }
  const { data: grant } = await service.from("portal_role_permission").select(
    "permission",
  )
    .eq("staff_role", profile.staff_role).eq("permission", "readiness.read")
    .maybeSingle();
  return grant ? profile as Row : null;
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
  if (request.method !== "GET") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);

    const [
      canixResult,
      qboResult,
      mondayResult,
      latestMondayEventResult,
      latestMondayRefreshResult,
      latestMondayProductSyncResult,
      pendingOutbox,
      failedOutbox,
      activeCommitments,
      publishedContent,
      coaCount,
      readyRetailers,
      readyStores,
      activeProfiles,
      pendingPrices,
      pendingAssetReviews,
      activeAssets,
      quarantinedAssets,
    ] = await Promise.all([
      service.from("canix_sync_state").select(
        "status,last_successful_at,last_error,package_count,latest_source_updated_at",
      ).eq("id", 1).maybeSingle(),
      service.from("quickbooks_sync_state").select(
        "status,connection_status,connected_at,realm_id,last_successful_at,last_error,customer_count",
      ).eq("id", 1).maybeSingle(),
      service.from("monday_connection_state").select(
        "connection_status,connected_at,account_id,granted_scopes,access_token_expires_at,webhook_id,webhook_board_id,webhook_column_id,webhook_status,webhook_created_at,last_error",
      ).eq("id", 1).maybeSingle(),
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
        "portal_retailer_account",
        (query) => query.eq("portal_status", "ready_to_order"),
      ),
      exactCount(
        "portal_store",
        (query) =>
          query.eq("active", true).eq("license_status", "active").eq(
            "ordering_status",
            "ready",
          ),
      ),
      exactCount("portal_profile", (query) => query.eq("active", true)),
      exactCount(
        "portal_price_proposal",
        (query) => query.eq("state", "pending"),
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
    ]);
    if (canixResult.error) throw canixResult.error;
    if (qboResult.error) throw qboResult.error;
    if (mondayResult.error) throw mondayResult.error;
    if (latestMondayEventResult.error) throw latestMondayEventResult.error;
    if (latestMondayRefreshResult.error) throw latestMondayRefreshResult.error;
    if (latestMondayProductSyncResult.error) {
      throw latestMondayProductSyncResult.error;
    }

    const canix = canixResult.data as Row | null;
    const qbo = qboResult.data as Row | null;
    const monday = mondayResult.data as Row | null;
    const latestMondayEvent = latestMondayEventResult.data as Row | null;
    const latestMondayRefresh = latestMondayRefreshResult.data as Row | null;
    const latestMondayProductSync = latestMondayProductSyncResult.data as
      | Row
      | null;
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
    const qboAge = ageMinutes(qbo?.last_successful_at);
    const mondayCallbackAge = ageMinutes(latestMondayEvent?.received_at);
    const mondayOAuthReady = configured("MONDAY_CLIENT_ID") &&
      configured("MONDAY_CLIENT_SECRET") &&
      configured("MONDAY_TOKEN_ENCRYPTION_KEY") &&
      monday?.connection_status === "connected";
    const directMondayIntakeReady = mondayOAuthReady &&
      configured("MONDAY_ORDER_BOARD_ID") &&
      configured("MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID");
    const directMondayProductReady = mondayOAuthReady &&
      mondayScopes.includes("boards:read") &&
      /^\d+$/.test(MONDAY_PRODUCT_BOARD_ID);
    const makeIntakeReady = configured("MAKE_WEBHOOK_URL") &&
      configured("MAKE_INTAKE_SECRET");
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
            state: configured("CANIX_CRON_SECRET") ? "pass" : "block",
            label: "Five-minute scheduler authentication",
            detail: configured("CANIX_CRON_SECRET")
              ? "Scheduler secret is configured."
              : "CANIX_CRON_SECRET is not configured.",
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
        ],
      },
      {
        key: "orders",
        label: "Orders and Monday",
        checks: [
          {
            state: directMondayIntakeReady || makeIntakeReady
              ? "pass"
              : "block",
            label: "Order intake",
            detail: directMondayIntakeReady
              ? "Direct, board-pinned Monday order intake is active; Make remains a compatibility path."
              : makeIntakeReady
              ? "Authenticated Make intake is configured as the compatibility path."
              : "Neither the direct Monday app path nor the authenticated Make compatibility path is ready.",
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
            state: pendingPrices > 0 ? "warn" : "pass",
            label: "Pricing approvals",
            detail:
              `${pendingPrices} store-price proposals awaiting internal decision.`,
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
        ],
      },
      {
        key: "quickbooks",
        label: "QuickBooks read model",
        checks: [
          {
            state:
              configured("QBO_CLIENT_ID") && configured("QBO_CLIENT_SECRET") &&
                configured("QBO_TOKEN_ENCRYPTION_KEY") &&
                qbo?.connection_status === "connected" && Boolean(qbo?.realm_id)
                ? "pass"
                : "warn",
            label: "Accounting connection",
            detail:
              configured("QBO_CLIENT_ID") && configured("QBO_CLIENT_SECRET") &&
                configured("QBO_TOKEN_ENCRYPTION_KEY") &&
                qbo?.connection_status === "connected" && Boolean(qbo?.realm_id)
                ? "The encrypted server-side customer, invoice, and payment connection is active."
                : "An administrator must finish the dedicated QuickBooks connection; financials remain read-only with last-snapshot fallback.",
          },
          {
            state: qbo?.last_successful_at ? "pass" : "warn",
            label: "Last successful snapshot",
            detail: qbo?.last_successful_at
              ? `${qbo.customer_count ?? 0} customers; ${qboAge} minutes old.`
              : "No successful QuickBooks snapshot is recorded.",
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
      integrations: {
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
          lastProductSyncAt: latestMondayProductSync?.created_at ?? null,
          lastProductSyncScanned: latestMondayProductDetail.scanned ?? null,
          lastProductSyncSynced: latestMondayProductDetail.synced ?? null,
          lastProductSyncMissingCanixItemId:
            latestMondayProductDetail.missingCanixItemId ?? null,
        },
        quickbooks: {
          connectionStatus: qbo?.connection_status ?? "disconnected",
          connectedAt: qbo?.connected_at ?? null,
          lastSuccessfulAt: qbo?.last_successful_at ?? null,
        },
      },
    });
  } catch (error) {
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected readiness error",
    }, 500);
  }
});
