import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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
        "status,last_successful_at,last_error,customer_count",
      ).eq("id", 1).maybeSingle(),
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

    const canix = canixResult.data as Row | null;
    const qbo = qboResult.data as Row | null;
    const canixAge = ageMinutes(canix?.last_successful_at);
    const qboAge = ageMinutes(qbo?.last_successful_at);
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
            state:
              configured("MAKE_WEBHOOK_URL") && configured("MAKE_INTAKE_SECRET")
                ? "pass"
                : "block",
            label: "Order intake",
            detail:
              configured("MAKE_WEBHOOK_URL") && configured("MAKE_INTAKE_SECRET")
                ? "Authenticated Monday/Make intake is configured."
                : "MAKE_WEBHOOK_URL and MAKE_INTAKE_SECRET are required for live orders.",
          },
          {
            state: configured("MONDAY_STATUS_SECRET") &&
                configured("ORDER_SYNC_CRON_SECRET")
              ? "pass"
              : "block",
            label: "Status return and retry",
            detail: configured("MONDAY_STATUS_SECRET") &&
                configured("ORDER_SYNC_CRON_SECRET")
              ? "Authenticated status callback and retry scheduler are configured."
              : "Monday status or retry credentials are incomplete.",
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
            state: configured("MONDAY_PRODUCT_SECRET") ? "pass" : "warn",
            label: "Monday product content",
            detail: configured("MONDAY_PRODUCT_SECRET")
              ? `${publishedContent} published product records.`
              : "MONDAY_PRODUCT_SECRET is not configured; Canix identity still works, but merchandising content cannot sync.",
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
                configured("QBO_REALM_ID") && configured("QBO_REFRESH_TOKEN")
                ? "pass"
                : "warn",
            label: "Accounting connection",
            detail:
              configured("QBO_CLIENT_ID") && configured("QBO_CLIENT_SECRET") &&
                configured("QBO_REALM_ID") && configured("QBO_REFRESH_TOKEN")
                ? "Server-side customer, invoice, and payment sync is configured."
                : "QuickBooks credentials are incomplete; financials remain read-only with last-snapshot fallback.",
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
            state: "deferred",
            label: "Production domain",
            detail:
              "DNS and final Auth redirect changes remain deferred until deployment is approved.",
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
              : "Public onboarding remains unexposed on the owner-only preview; Turnstile enforcement is dormant.",
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
    });
  } catch (error) {
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected readiness error",
    }, 500);
  }
});
