import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "ux-portal-prototype.dc.html"), "utf8");
const inventory = await readFile(resolve(root, "supabase/functions/canix-inventory/index.ts"), "utf8");
const catalog = await readFile(resolve(root, "supabase/functions/canix-catalog/index.ts"), "utf8");
const intake = await readFile(resolve(root, "supabase/functions/portal-intake/index.ts"), "utf8");
const policy = await readFile(resolve(root, "supabase/functions/portal-order-policy/index.ts"), "utf8");
const admin = await readFile(resolve(root, "supabase/functions/portal-admin/index.ts"), "utf8");
const pricing = await readFile(resolve(root, "supabase/functions/portal-pricing/index.ts"), "utf8");
const financials = await readFile(resolve(root, "supabase/functions/quickbooks-financials/index.ts"), "utf8");
const orders = await readFile(resolve(root, "supabase/functions/portal-orders/index.ts"), "utf8");
const economicOwnership = await readFile(resolve(root, "supabase/functions/portal-economic-ownership/index.ts"), "utf8");
const productContent = await readFile(resolve(root, "supabase/functions/portal-product-content/index.ts"), "utf8");
const assets = await readFile(resolve(root, "supabase/functions/portal-assets/index.ts"), "utf8");
const quickbooksOAuth = await readFile(resolve(root, "supabase/functions/quickbooks-oauth/index.ts"), "utf8");
const mondayOAuth = await readFile(resolve(root, "supabase/functions/monday-oauth/index.ts"), "utf8");
const mondayConnection = await readFile(resolve(root, "supabase/functions/_shared/monday-connection.ts"), "utf8");
const mondayWebhook = await readFile(resolve(root, "supabase/functions/monday-webhook/index.ts"), "utf8");
const readiness = await readFile(resolve(root, "supabase/functions/portal-readiness/index.ts"), "utf8");
const migration = await readFile(resolve(root, "supabase/migrations/20260901240000_canix_availability_contract.sql"), "utf8");
const securityMigration = await readFile(resolve(root, "supabase/migrations/20260901250000_security_and_inventory_commitments.sql"), "utf8");
const assetMigration = await readFile(resolve(root, "supabase/migrations/20260901280000_private_portal_assets.sql"), "utf8");
const quickbooksOAuthMigration = await readFile(resolve(root, "supabase/migrations/20260901290000_quickbooks_oauth_broker.sql"), "utf8");
const orderCronMigration = await readFile(resolve(root, "supabase/migrations/20260901300000_order_outbox_cron.sql"), "utf8");
const mondayOAuthMigration = await readFile(resolve(root, "supabase/migrations/20260901310000_monday_oauth_and_signed_webhooks.sql"), "utf8");
const economicPartnerMigration = await readFile(resolve(root, "supabase/migrations/20260901320000_canix_brand_economic_partners.sql"), "utf8");
const gitignore = await readFile(resolve(root, ".gitignore"), "utf8");
const functionNames = (await readdir(resolve(root, "supabase/functions"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => entry.name).sort();

const checks = [];
function assertContract(condition, name) {
  checks.push({ name, ok: Boolean(condition) });
}

assertContract(inventory.includes('const QUANTITY_TYPES = new Set(["WeightBased", "CountBased"])'), "volume is excluded from the Canix cache");
assertContract(inventory.includes("function inventoryBucket(row: Json)") && inventory.includes('"inventory_bucket_reason"'), "inventory publishes one auditable lane classification per package");
assertContract(inventory.includes("/\\b(?:clone|biomass|seeds?)\\b/i.test(itemName)") && inventory.indexOf("item_name_keyword") < inventory.indexOf("bulkIdentity"), "Clone, Biomass, Seed, and Seeds item names take priority over Bulk routing");
assertContract(inventory.includes("row.item_category_name") && inventory.includes("row.item_sub_category_name") && inventory.includes("/\\bbulk\\b/i.test(bulkIdentity)"), "Bulk routing uses the Canix item and category identity");
assertContract(source.includes("invInventoryBuckets") && source.includes("invScopedPackages") && source.includes("inventoryBucketSelect(bucket)"), "inventory UI separates Packaged, plant-material, and Bulk lanes before filtering");
assertContract(inventory.includes('"economic_partner_name"') && inventory.includes('service.from("portal_brand_economic_partner")'), "inventory exposes Economic Partner independently from Economic Owner");
assertContract(economicPartnerMigration.includes("portal_sync_brand_economic_partners") && economicPartnerMigration.includes("Never used as an Economic Owner fallback"), "every current Canix Brand has a separate Economic Partner sync contract");
assertContract(economicPartnerMigration.includes("where party_code = 'WANA'") && economicPartnerMigration.includes("display_name = 'Wana'"), "Wana uses the requested Economic Partner display name");
assertContract(economicOwnership.includes('action === "sync-brand-partners"') && economicOwnership.includes("brandPartners"), "authorized staff can inspect and refresh Canix Brand partner mappings");
assertContract(source.includes("ECONOMIC PARTNER") && source.includes("invPartnerOptions") && source.includes("economic_partner_name"), "inventory UI filters, displays, and exports Economic Partner");
assertContract(inventory.includes("availability_rule:") && inventory.includes("active Canix package + status_category available; explicit reservations subtracted"), "inventory publishes the availability rule");
assertContract(inventory.includes('reservation_state: reservation.field ? "known" : "unknown"'), "unknown reservation coverage is explicit");
assertContract(catalog.includes('groupingPolicy: "canix_item_id_v1"'), "catalog grouping is the approved Canix item contract");
assertContract(catalog.includes('orderableUnits(row) > 0'), "zero-orderable packages are excluded from the catalog");
assertContract(intake.includes("store.enforce_case_quantity === true"), "case enforcement is verified server-side");
assertContract(intake.includes("orderable_units"), "order intake uses reservation-adjusted availability");
assertContract(policy.includes('action === "update-case-policy"'), "case policy has a protected update action");
assertContract(migration.includes("enforce_case_quantity boolean not null default false"), "case enforcement defaults off");
assertContract(intake.includes("labPassed(") && intake.includes("releasedUnitsByProduct"), "order release is quantity-aware and exact-status based");
assertContract(orders.includes("portal_inventory_commitment") && orders.includes("orderTransitionAllowed"), "order release and Monday transitions fail closed");
assertContract(orders.includes("mondayOrderState") && !orders.includes("/deliver|received|customer accepted/"), "Monday statuses use an exact allowlist rather than substring promotion");
assertContract(securityMigration.includes("pg_advisory_xact_lock") && securityMigration.includes("portal_inventory_commitment"), "order creation atomically commits product availability");
assertContract(securityMigration.includes("canix_sales_order_id") && securityMigration.includes("coverage.allocated_units"), "portal commitments reconcile only to their explicitly linked Canix sales order");
assertContract(securityMigration.includes("'exception'") && securityMigration.includes("orders.state not in ('delivered', 'declined', 'canceled', 'exception')"), "legacy exception orders cannot retain inventory commitments");
assertContract(securityMigration.includes("portal_enforce_order_transition_graph"), "the database enforces the order transition graph");
assertContract(inventory.includes('"canix_claim_sync_run"') && !inventory.includes("await syncInventory(true);"), "inventory reads are cache-only and sync claims are serialized");
assertContract(inventory.includes('"canix_package_sync_stage"') && inventory.includes('"canix_publish_sync_run"') && securityMigration.includes("Canix sync ownership was lost before snapshot publication"), "Canix snapshots publish atomically from a private stage");
assertContract(admin.includes("Store Owners may deactivate current Buyers and Budtenders only."), "Store Owners cannot mutate current Owner or internal roles");
assertContract(admin.includes("selected store must have a qualified license") && admin.includes('.eq("license_status", "active")'), "all retailer assignments bind to active qualified licenses");
assertContract(pricing.includes("canonicalProduct(productId)") && pricing.includes("currentStorePrice") && pricing.includes("canonicalCanixProductId(productId)"), "pricing proposals use authoritative normalized Canix identity and current price");
assertContract(financials.includes("const allStores = storeMappings") && financials.includes("for (const store of collisionStores") && financials.includes("parentCustomerOutsideOrganization"), "QuickBooks shared-customer checks include historical stores and organization parent mappings");
assertContract(catalog.includes("PORTAL_EXTERNAL_ASSET_HOSTS") && productContent.includes("PORTAL_EXTERNAL_ASSET_HOSTS"), "external catalog assets use an exact-host allowlist");
assertContract(assetMigration.includes("'portal-assets'") && assetMigration.includes("public = false") && assetMigration.includes("revoke all on table public.portal_asset from public, anon, authenticated"), "portal product and COA storage is private and browser tables are denied");
assertContract(assets.includes('state: "pending_review"') && assets.includes('"portal_review_asset"') && assetMigration.includes("target.state <> 'pending_review'") && assetMigration.includes("p_decision = 'approve'"), "portal assets fail closed until an authorized review activates them");
assertContract(catalog.includes('createSignedUrls(paths, 300)') && catalog.includes('.eq("state", "active")'), "catalog assets use short-lived URLs for active records only");
assertContract(intake.includes("TURNSTILE_REQUIRED") && intake.includes("siteverify") && !intake.includes('form.set("remoteip"'), "public onboarding supports Turnstile without sending visitor IP addresses");
assertContract(intake.includes("PUBLIC_INTAKE_RATE_SECRET") && intake.includes("portal_claim_public_intake_rate") && intake.includes("delete verifiedPayload.antiAbuseToken"), "public onboarding rate scope is HMAC-protected and the anti-bot token is not forwarded");
assertContract(readiness.includes("pendingAssetReviews") && readiness.includes('Deno.env.get("TURNSTILE_REQUIRED")'), "live readiness reports private assets and public-onboarding protection state");
assertContract(readiness.includes("directMondayIntakeReady") && readiness.includes("Direct, board-pinned Monday order intake is active"), "live readiness recognizes the direct Monday order path without depending on Make");
assertContract(readiness.includes("Latest signed callback") && readiness.includes("lastRefreshHasOneWebhook") && readiness.includes("Exactly one matching signed webhook remains"), "live readiness reports signed callback health and stale-webhook cleanup evidence");
assertContract(quickbooksOAuth.includes('scope: "com.intuit.quickbooks.accounting"') && quickbooksOAuth.includes("portal_consume_quickbooks_oauth_state") && quickbooksOAuth.includes("portal_store_quickbooks_connection"), "QuickBooks authorization is administrator-started, state-bound, and server-custodied");
assertContract(quickbooksOAuthMigration.includes("pgp_sym_encrypt") && quickbooksOAuthMigration.includes("oauth_state_expires_at > now()") && quickbooksOAuthMigration.includes("refresh_token = null"), "QuickBooks refresh tokens are encrypted and OAuth state is expiring and one-time");
assertContract(orderCronMigration.includes("portal-order-outbox-flush-5m") && orderCronMigration.includes("*/5 * * * *") && orderCronMigration.includes("vault.decrypted_secrets"), "order outbox retries every five minutes with a Vault-backed credential");
assertContract(!/[A-Fa-f0-9]{64}/.test(orderCronMigration), "the order retry migration contains no embedded high-entropy secret");
assertContract(mondayOAuth.includes("code_challenge_method: \"S256\"") && mondayOAuth.includes("portal_consume_monday_oauth_state") && mondayOAuth.includes("oauth_ms/oauth/token"), "Monday authorization is administrator-started, one-time, and PKCE-bound");
assertContract(mondayOAuth.includes('scope: REQUESTED_SCOPES.join(" ")') && mondayOAuth.includes('"me:read"') && mondayOAuth.includes('"boards:read"') && mondayOAuth.includes('"webhooks:read"') && mondayOAuth.includes('"webhooks:write"'), "Monday authorization explicitly requests the configured least-privilege scopes");
assertContract(mondayOAuth.includes("params.app_version_id = APP_VERSION_ID") && mondayOAuth.includes('params.force_install_if_needed = "true"'), "Monday draft collaborators use version-specific OAuth while the live-app path still enforces installation");
assertContract(mondayOAuth.includes("status: 303") && mondayOAuth.includes('target.searchParams.set("monday", "connected")') && mondayOAuth.includes("location: target.toString()"), "successful Monday authorization redirects cleanly back to the portal");
assertContract(mondayConnection.includes('grant_type: "refresh_token"') && mondayConnection.includes("portal_rotate_monday_tokens") && mondayConnection.includes("5 * 60_000"), "Monday OAuth tokens renew proactively and store the rotated refresh token server-side");
assertContract(intake.includes("mondayAccessToken") && orders.includes("mondayAccessToken") && mondayOAuth.includes("mondayAccessToken"), "every direct Monday order and webhook-admin path uses renewable OAuth custody");
assertContract(mondayOAuth.includes("webhooks(board_id: $boardId, app_webhooks_only: true)") && mondayOAuth.includes("change_status_column_value") && intake.includes("MONDAY_ORDER_BOARD_ID") && orders.includes("MONDAY_ORDER_BOARD_ID"), "Monday writes and signed callbacks are pinned to the configured order board");
assertContract(mondayWebhook.includes("verifyHs256Jwt") && mondayWebhook.includes("MONDAY_SIGNING_SECRET") && mondayWebhook.includes("portal_claim_monday_webhook_event"), "Monday board callbacks require signed, deduplicated events");
assertContract(mondayOAuth.includes('"boards:write"') && intake.includes("directMondayOrder") && intake.includes("MONDAY_ORDER_CLIENT_REQUEST_COLUMN_ID"), "orders have an idempotent, board-pinned direct Monday fallback");
assertContract(orders.includes("sendDirectMondayStatus") && orders.includes("MONDAY_ORDER_STATUS_COLUMN_ID"), "portal status changes have a board-pinned direct Monday fallback");
assertContract(mondayWebhook.includes("boardId !== ORDER_BOARD_ID") && mondayWebhook.includes("columnId !== ORDER_STATUS_COLUMN_ID") && mondayWebhook.includes("Unknown webhook subscription"), "Monday callbacks are pinned to one board, column, and subscription");
assertContract(mondayOAuthMigration.includes("pgp_sym_encrypt") && mondayOAuthMigration.includes("oauth_state_expires_at > now()") && mondayOAuthMigration.includes("encrypted_pkce_verifier"), "Monday tokens and PKCE verifier are encrypted and OAuth state is expiring and one-time");
assertContract(mondayOAuthMigration.includes("if existing_state = 'failed'") && mondayOAuthMigration.includes("attempt_count = attempt_count + 1"), "failed Monday callbacks can retry while processed events remain deduplicated");
assertContract(source.includes("QUICKBOOKS_OAUTH_API") && source.includes("connectQuickBooks()"), "portal administrators can launch the protected QuickBooks connection flow");
assertContract(source.includes("MONDAY_OAUTH_API") && source.includes("connectMonday()"), "portal administrators can launch the protected Monday connection flow");
assertContract(productContent.includes("MONDAY_PRODUCT_BOARD_ID") && productContent.includes("syncMondayProductBoard") && productContent.includes("missingCanixItemId") && !productContent.includes("match by name"), "Monday catalog sync is board-pinned and requires explicit Canix Item IDs");
assertContract(source.includes("syncMondayCatalog()") && source.includes("Sync catalog content"), "portal administrators can scan linked Monday catalog content from release readiness");
assertContract(readiness.includes("Latest Monday catalog scan") && readiness.includes("lastProductSyncMissingCanixItemId"), "live readiness reports Monday catalog mapping and sync evidence");
assertContract(gitignore.includes("/data/canix-inventory-snapshot.json"), "live Canix snapshots are excluded from source control");
assertContract(source.includes("PORTAL_READINESS_API"), "portal includes protected live release diagnostics");
assertContract(!source.includes("CANIX_API_KEY"), "Canix credentials are absent from the browser source");
assertContract(!source.includes("QBO_CLIENT_SECRET"), "QuickBooks client secret is absent from the browser source");

for (const name of functionNames) {
  const text = await readFile(resolve(root, "supabase/functions", name, "index.ts"), "utf8");
  assertContract(text.includes("authorization") || text.includes("x-ux-") || text.includes("x-cron-secret"), `${name} has an authentication boundary`);
}

if (process.argv.includes("--remote")) {
  const url = source.match(/const SUPABASE_URL =[^']*'([^']+)'/)?.[1];
  const key = source.match(/const SUPABASE_KEY =[^']*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error("Could not resolve the public Supabase endpoint configuration.");
  const methods = {
    "canix-inventory": "GET", "canix-catalog": "GET", "portal-admin": "POST",
    "portal-economic-ownership": "GET", "portal-intake": "POST", "portal-order-policy": "GET",
    "portal-orders": "GET", "portal-pricing": "GET", "portal-product-content": "GET",
    "portal-readiness": "GET", "portal-retailers": "GET", "quickbooks-financials": "GET",
    "quickbooks-retailers": "GET", "monday-webhook": "POST",
  };
  for (const name of functionNames) {
    const method = methods[name] || "GET";
    const anonymousBody = name === "portal-intake" ? { kind: "order", payload: {} } : {};
    const response = await fetch(`${url}/functions/v1/${name}`, {
      method,
      headers: { apikey: key, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(anonymousBody) : undefined,
    });
    assertContract([401, 403].includes(response.status), `${name} denies an anonymous request (${response.status})`);
  }
}

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
  console.error(`${checks.length - failures.length} of ${checks.length} release contracts passed.`);
  for (const failure of failures) console.error(`FAIL ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log(`${checks.length} release contracts passed${process.argv.includes("--remote") ? " (including remote anonymous-denial checks)" : ""}.`);
}
