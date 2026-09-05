import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "ux-portal-prototype.dc.html"), "utf8");
const siteBuild = await readFile(resolve(root, "scripts/build-sites.mjs"), "utf8");
const inventory = await readFile(resolve(root, "supabase/functions/canix-inventory/index.ts"), "utf8");
const itemMaster = await readFile(resolve(root, "supabase/functions/canix-item-master/index.ts"), "utf8");
const mondayItemMasterSync = await readFile(resolve(root, "supabase/functions/monday-item-master-sync/index.ts"), "utf8");
const catalog = await readFile(resolve(root, "supabase/functions/canix-catalog/index.ts"), "utf8");
const intake = await readFile(resolve(root, "supabase/functions/portal-intake/index.ts"), "utf8");
const policy = await readFile(resolve(root, "supabase/functions/portal-order-policy/index.ts"), "utf8");
const admin = await readFile(resolve(root, "supabase/functions/portal-admin/index.ts"), "utf8");
const pricing = await readFile(resolve(root, "supabase/functions/portal-pricing/index.ts"), "utf8");
const financials = await readFile(resolve(root, "supabase/functions/quickbooks-financials/index.ts"), "utf8");
const orders = await readFile(resolve(root, "supabase/functions/portal-orders/index.ts"), "utf8");
const lotIntegrity = await readFile(resolve(root, "supabase/functions/portal-lot-integrity/index.ts"), "utf8");
const economicOwnership = await readFile(resolve(root, "supabase/functions/portal-economic-ownership/index.ts"), "utf8");
const productContent = await readFile(resolve(root, "supabase/functions/portal-product-content/index.ts"), "utf8");
const assets = await readFile(resolve(root, "supabase/functions/portal-assets/index.ts"), "utf8");
const quickbooksOAuth = await readFile(resolve(root, "supabase/functions/quickbooks-oauth/index.ts"), "utf8");
const quickbooksRetailers = await readFile(resolve(root, "supabase/functions/quickbooks-retailers/index.ts"), "utf8");
const portalRetailers = await readFile(resolve(root, "supabase/functions/portal-retailers/index.ts"), "utf8");
const quickbooksOAuthDiscovery = await readFile(resolve(root, "supabase/functions/_shared/quickbooks-oauth.ts"), "utf8");
const quickbooksEgressProxy = await readFile(resolve(root, "services/qbo-egress-proxy/server.mjs"), "utf8");
const mondayOAuth = await readFile(resolve(root, "supabase/functions/monday-oauth/index.ts"), "utf8");
const mondayConnection = await readFile(resolve(root, "supabase/functions/_shared/monday-connection.ts"), "utf8");
const mondayWebhook = await readFile(resolve(root, "supabase/functions/monday-webhook/index.ts"), "utf8");
const readiness = await readFile(resolve(root, "supabase/functions/portal-readiness/index.ts"), "utf8");
const migration = await readFile(resolve(root, "supabase/migrations/20260901240000_canix_availability_contract.sql"), "utf8");
const securityMigration = await readFile(resolve(root, "supabase/migrations/20260901250000_security_and_inventory_commitments.sql"), "utf8");
const assetMigration = await readFile(resolve(root, "supabase/migrations/20260901280000_private_portal_assets.sql"), "utf8");
const assetPolicyMigration = await readFile(resolve(root, "supabase/migrations/20260905120000_asset_review_retention_policy.sql"), "utf8");
const quickbooksOAuthMigration = await readFile(resolve(root, "supabase/migrations/20260901290000_quickbooks_oauth_broker.sql"), "utf8");
const orderCronMigration = await readFile(resolve(root, "supabase/migrations/20260901300000_order_outbox_cron.sql"), "utf8");
const mondayOAuthMigration = await readFile(resolve(root, "supabase/migrations/20260901310000_monday_oauth_and_signed_webhooks.sql"), "utf8");
const economicPartnerMigration = await readFile(resolve(root, "supabase/migrations/20260901320000_canix_brand_economic_partners.sql"), "utf8");
const wholesaleMigration = await readFile(resolve(root, "supabase/migrations/20260902010000_wholesale_default_pricing.sql"), "utf8");
const quickbooksTraceMigration = await readFile(resolve(root, "supabase/migrations/20260902020000_quickbooks_intuit_trace_ids.sql"), "utf8");
const quickbooksCronMigration = await readFile(resolve(root, "supabase/migrations/20260902030000_quickbooks_sync_cron.sql"), "utf8");
const mfaMigration = await readFile(resolve(root, "supabase/migrations/20260902040000_mfa_enforcement.sql"), "utf8");
const quickbooksEnvironmentMigration = await readFile(resolve(root, "supabase/migrations/20260902050000_quickbooks_environment_isolation.sql"), "utf8");
const quickbooksSafeCacheMigration = await readFile(resolve(root, "supabase/migrations/20260902060000_quickbooks_environment_safe_cache_clear.sql"), "utf8");
const retailerStoreControlsMigration = await readFile(resolve(root, "supabase/migrations/20260905130000_retailer_store_accounting_controls.sql"), "utf8");
const canixStaleRecoveryMigration = await readFile(resolve(root, "supabase/migrations/20260905150000_canix_stale_sync_recovery.sql"), "utf8");
const lotIntegrityMigration = await readFile(resolve(root, "supabase/migrations/20260902070000_inbound_lot_integrity.sql"), "utf8");
const lotIntegrityCronMigration = await readFile(resolve(root, "supabase/migrations/20260902080000_lot_integrity_cron.sql"), "utf8");
const canixCronMigration = await readFile(resolve(root, "supabase/migrations/20260902090000_canix_sync_cron_vault.sql"), "utf8");
const lotReviewStagingMigration = await readFile(resolve(root, "supabase/migrations/20260902100000_lot_review_staging.sql"), "utf8");
const itemMasterMigration = await readFile(resolve(root, "supabase/migrations/20260902110000_canix_item_master.sql"), "utf8");
const itemMasterCronMigration = await readFile(resolve(root, "supabase/migrations/20260902120000_canix_item_sync_cron.sql"), "utf8");
const mondayItemMasterMigration = await readFile(resolve(root, "supabase/migrations/20260902130000_monday_item_master_sync.sql"), "utf8");
const mondayItemMasterTuningMigration = await readFile(resolve(root, "supabase/migrations/20260902140000_monday_item_master_batch_tuning.sql"), "utf8");
const mondayItemMasterRetargetMigration = await readFile(resolve(root, "supabase/migrations/20260902150000_monday_item_master_retarget.sql"), "utf8");
const mfaHelper = await readFile(resolve(root, "supabase/functions/_shared/mfa.ts"), "utf8");
const wholesaleSourceScript = await readFile(resolve(root, "scripts/prepare-wholesale-pricing.mjs"), "utf8");
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
assertContract(lotIntegrityMigration.includes("enforcement_mode text not null default 'monitor'") && lotIntegrityMigration.includes("portal_set_lot_integrity_mode") && source.includes("MONITOR ONLY"), "lot-integrity rollout defaults to visible monitor mode and requires an explicit server-side activation");
assertContract(lotIntegrityMigration.includes("lot_id_change_detected") && lotIntegrityMigration.includes("target.lot_id_locked_at is not null") && lotIntegrityMigration.includes("register_lock_violation"), "approved Monday Lot IDs lock in the protected portal mirror and later edits become exceptions");
assertContract(lotIntegrityMigration.includes("missing_pointer") && lotIntegrityMigration.includes("multiple_lots") && lotIntegrityMigration.includes("unknown_lot") && lotIntegrityMigration.includes("duplicate_register_lot") && lotIntegrityMigration.includes("unapproved_lot"), "lot-pointer reconciliation preserves distinct actionable exception states");
assertContract(catalog.includes('lotEnforcementMode === "block"') && orders.includes('enforcement_mode === "block"') && lotIntegrityMigration.includes("enforcement_mode_value <> 'block'"), "catalog, pre-order release, and atomic commitments share the same lot-allocation gate");
assertContract(lotIntegrity.includes('const LOT_BOARD_ID = Deno.env.get("MONDAY_LOT_BOARD_ID")') && lotIntegrity.includes('const LOT_GROUP_ID = Deno.env.get("MONDAY_LOT_GROUP_ID")') && lotIntegrity.includes('=== LOT_GROUP_ID') && lotIntegrity.includes('group_id: $groupId') && lotIntegrity.includes('permission: string'), "Monday lot synchronization is board-and-group pinned and capability-gated");
assertContract(lotIntegrityCronMigration.includes("portal-lot-integrity-daily") && lotIntegrityCronMigration.includes("vault.decrypted_secrets") && lotIntegrityCronMigration.includes("portal_lot_integrity_scheduler_state"), "lot ownership has a Vault-gated daily synchronization and integrity scheduler");
assertContract(!/[A-Fa-f0-9]{64}/.test(lotIntegrityCronMigration), "the lot-integrity scheduler migration contains no embedded high-entropy secret");
assertContract(canixCronMigration.includes("canix-inventory-sync-5m") && canixCronMigration.includes("vault.decrypted_secrets") && canixCronMigration.includes("portal_canix_scheduler_state"), "Canix refresh uses a Vault-backed five-minute scheduler and protected readiness state");
assertContract(!/[A-Fa-f0-9]{64}/.test(canixCronMigration) && !canixCronMigration.includes("sb_publishable_"), "the Canix scheduler migration contains no embedded cron secret or public API key");
assertContract(itemMaster.includes('fetchAll("items")') && !itemMaster.includes('fetchAll("items",') && itemMaster.includes("Canix returned duplicate Item IDs"), "Item Master sync fetches every active and inactive Canix item and fails closed on incomplete identity");
assertContract(itemMaster.includes('const reportQuantityTotals = quantityType === "WeightBased"') && itemMaster.includes("total_for_sale: reportQuantityTotals"), "Item Master retains every item definition without publishing volume quantities");
assertContract(itemMaster.includes('service.from("canix_item_sync_stage").upsert') && itemMaster.includes('"canix_publish_item_sync_run"') && itemMasterMigration.includes("delete from public.canix_item_current where sync_run_id <> p_run_id"), "Canix Item Master publishes atomically from an independent private stage");
assertContract(itemMasterMigration.includes("source_payload jsonb") && itemMasterMigration.includes("revoke all on table public.canix_item_current from public, anon, authenticated"), "complete Canix Item source objects remain server-only");
assertContract(itemMasterCronMigration.includes("canix-item-master-sync-5m") && itemMasterCronMigration.includes("vault.decrypted_secrets") && itemMasterCronMigration.includes("portal_canix_item_scheduler_state"), "Canix Item Master has an independent Vault-backed five-minute scheduler");
assertContract(!/[A-Fa-f0-9]{64}/.test(itemMasterCronMigration) && !itemMasterCronMigration.includes("sb_publishable_"), "the Item Master scheduler migration contains no embedded cron secret or public API key");
assertContract(inventory.includes("STORED_ITEM_MASTER_COLUMNS") && inventory.includes('hasCapability(profile, "economics.manage")') && inventory.includes("cost_fields_included: canReadCosts"), "Item Master is exposed to inventory readers while standard cost remains capability-gated");
assertContract(itemMaster.includes("standardCost.cost") && itemMaster.includes("current_standard_cost_currency"), "Canix current standard-cost objects normalize their documented and live amount shapes without inferring currency");
assertContract(source.includes("Canix Item Master") && source.includes("itemMasterFilter(patch)") && source.includes("itemMasterSort(key)") && source.includes("Export filtered CSV"), "Inventory provides a searchable, filterable, sortable, exportable Item Master workbench");
assertContract(source.includes('aria-label="Inventory sections"') && source.includes("inventoryPanel: 'packages'") && source.includes("invFiltersOpen") && source.includes("Source details"), "Inventory defaults to a compact package workspace with switchable sections and progressive detail controls");
assertContract(mondayItemMasterSync.includes('"18429359264"') && mondayItemMasterSync.includes('ITEM_MASTER_GROUP_IDS') && mondayItemMasterSync.includes('Object.values(COLUMNS).filter'), "Monday Item Master synchronization is pinned to the selected board, physical completeness groups, and exact source-column schema");
assertContract(mondayItemMasterSync.includes('"existing_id" | "created"') && mondayItemMasterSync.includes('const needsGroupId = !item.boardItem') && mondayItemMasterSync.includes('move_item_to_group') && mondayItemMasterMigration.includes('monday_item_master_link'), "Monday Item Master writes are ID-only, idempotent, keep physical groups current, and declare group variables only when used");
assertContract(mondayItemMasterSync.includes('"Missing Multiple"') && mondayItemMasterSync.includes('"Inactive / Reference"') && mondayItemMasterSync.includes('"Sandbox / Test"') && mondayItemMasterSync.includes('itemClass === "Catalog"'), "Monday Item Master completeness separates actionable missing data from inactive, sandbox, Bulk, and Propagation records");
assertContract(!mondayItemMasterSync.includes("classifyBoardOnlyBatch") && !mondayItemMasterSync.includes('"Missing Canix ID"') && !mondayItemMasterSync.includes("exactMatches"), "inbound-lot rows are never reclassified or name-matched by the Item Master writer");
assertContract(mondayItemMasterSync.includes('/\\b(?:clone|biomass|seeds?)\\b/i') && mondayItemMasterSync.includes('/\\bbulk\\b/i'), "Monday Item Master preserves the portal Propagation-before-Bulk routing policy");
assertContract(!mondayItemMasterSync.includes('current_standard_cost') && !mondayItemMasterSync.includes('source_payload'), "Monday Item Master excludes permission-gated cost and private raw Canix payloads");
assertContract(mondayItemMasterMigration.includes("monday-item-master-sync-5m") && mondayItemMasterMigration.includes("'3-59/5 * * * *'") && mondayItemMasterMigration.includes("vault.decrypted_secrets"), "Monday Item Master converges through a Vault-backed five-minute incremental schedule after Canix refresh");
assertContract(!/[A-Fa-f0-9]{64}/.test(mondayItemMasterMigration), "the Monday Item Master scheduler contains no embedded high-entropy secret");
assertContract(mondayItemMasterSync.includes("runScheduledSync") && mondayItemMasterSync.includes('source: "backfill-continuation"') && mondayItemMasterTuningMigration.includes("'limit', 100"), "Monday Item Master backfill checkpoints in runtime-safe self-continuing batches");
assertContract(!/[A-Fa-f0-9]{64}/.test(mondayItemMasterTuningMigration), "the Monday Item Master batch tuning contains no embedded credential");
assertContract(mondayItemMasterRetargetMigration.includes("18429359264") && mondayItemMasterRetargetMigration.includes("delete from public.monday_item_master_link") && !mondayItemMasterRetargetMigration.includes("portal_enable_monday_item_master_schedule() then"), "the Item Master retarget clears the former private ledger and leaves scheduling stopped for deploy ordering");
assertContract(lotReviewStagingMigration.includes("portal_claim_lot_review_staging") && lotReviewStagingMigration.includes("target.last_attempt_at < now() - interval '10 minutes'") && lotReviewStagingMigration.includes("portal_finish_lot_review_staging"), "unknown Canix Lot ID staging is retryable and idempotency-claimed before Monday creation");
assertContract(lotIntegrity.includes('action === "stage-unknown-lots"') && lotIntegrity.includes('["boards:read", "boards:write"]') && lotIntegrity.includes('{ label: "Pending Review" }') && source.includes("stageUnknownLots()"), "authorized staff can stage unknown valid Canix lots as unapproved Monday review rows without inferring ownership");
assertContract(inventory.includes('"canix_claim_sync_run"') && !inventory.includes("await syncInventory(true);"), "inventory reads are cache-only and sync claims are serialized");
assertContract(inventory.includes('"canix_package_sync_stage"') && inventory.includes('"canix_publish_sync_run"') && securityMigration.includes("Canix sync ownership was lost before snapshot publication"), "Canix snapshots publish atomically from a private stage");
assertContract(canixStaleRecoveryMigration.includes("stale_after_seconds") && canixStaleRecoveryMigration.includes("delete from public.canix_package_sync_stage") && source.includes("Synchronize packages now"), "abandoned Canix package runs recover safely and administrators can request an immediate refresh");
assertContract(admin.includes("Store Owners may deactivate current Buyers and Budtenders only."), "Store Owners cannot mutate current Owner or internal roles");
assertContract(admin.includes('action === "list-users"') && admin.includes("service.auth.admin.listUsers") && source.includes("loadUsers(force)"), "user access renders the protected live portal directory instead of production fixture rows");
assertContract(admin.includes('action === "remove-test-user"') && admin.includes("testDemoReason") && admin.includes("deleteUser(") && admin.includes("dana@downtownprovisions.com") && admin.includes("toni@urbanxtracts.com") && source.includes("Remove test user"), "test-user removal is administrator-only, server-classified, includes the exact legacy fixture allowlist, soft-deleted, and separately exposed");
assertContract(admin.includes("selected store must have a qualified license") && admin.includes('.eq("license_status", "active")'), "all retailer assignments bind to active qualified licenses");
assertContract(quickbooksRetailers.includes("parentCustomerId: row.parent_customer_id") && retailerStoreControlsMigration.includes("Store QuickBooks customer must be the retailer account or its direct child"), "store accounting identity is an explicit QuickBooks parent-or-child relationship");
assertContract(portalRetailers.includes("Start the retailer account from the top-level QuickBooks customer") && source.includes("A child customer cannot become a second retailer organisation"), "QuickBooks child customers map to stores rather than duplicate retailer organizations");
assertContract(retailerStoreControlsMigration.includes("portal_set_onboarding_store_details") && retailerStoreControlsMigration.includes("license_expires_on <= current_date") && retailerStoreControlsMigration.includes("A license review note is required"), "store onboarding records QuickBooks identity, current license expiration, and review evidence before qualification");
assertContract(intake.includes('if (!store.license_expires_on)') && intake.includes('if (!store.quickbooks_customer_id)'), "stores fail closed on missing license dates or accounting identity at order intake");
assertContract(source.includes("onbLocationOptions") && source.includes("All qualified stores") && source.includes("Choose exactly one store"), "onboarding binds buyer and Budtender scope to submitted stores instead of free text");
assertContract(source.includes("accounts.rows.concat(QUICKBOOKS_DEMO_ACCOUNTS)") && source.includes("retailerOnboarding: onboarding.rows"), "the onboarding queue remains available when QuickBooks is temporarily unavailable");
assertContract(pricing.includes("canonicalProduct(productId)") && pricing.includes("currentStorePrice") && pricing.includes("canonicalCanixProductId(productId)"), "pricing proposals use authoritative normalized Canix identity and current price");
assertContract(financials.includes("const allStores = storeMappings") && financials.includes("for (const store of collisionStores") && financials.includes("parentCustomerOutsideOrganization"), "QuickBooks shared-customer checks include historical stores and organization parent mappings");
assertContract(catalog.includes("PORTAL_EXTERNAL_ASSET_HOSTS") && productContent.includes("PORTAL_EXTERNAL_ASSET_HOSTS"), "external catalog assets use an exact-host allowlist");
assertContract(assetMigration.includes("'portal-assets'") && assetMigration.includes("public = false") && assetMigration.includes("revoke all on table public.portal_asset from public, anon, authenticated"), "portal product and COA storage is private and browser tables are denied");
assertContract(assets.includes('state: "pending_review"') && assets.includes('"portal_review_asset"') && assetMigration.includes("target.state <> 'pending_review'") && assetMigration.includes("p_decision = 'approve'"), "portal assets fail closed until an authorized review activates them");
assertContract(assets.includes("PORTAL_ASSET_UPLOADS_ENABLED") && assets.includes("A different authorized reviewer") && assetPolicyMigration.includes("interval '90 days'") && assetPolicyMigration.includes("interval '365 days'"), "portal-managed assets stay held until scanning is enabled and enforce reviewer separation plus retention");
assertContract(catalog.includes('createSignedUrls(paths, 300)') && catalog.includes('.eq("state", "active")'), "catalog assets use short-lived URLs for active records only");
assertContract(intake.includes("TURNSTILE_REQUIRED") && intake.includes("siteverify") && !intake.includes('form.set("remoteip"'), "public onboarding supports Turnstile without sending visitor IP addresses");
assertContract(intake.includes("PUBLIC_INTAKE_RATE_SECRET") && intake.includes("portal_claim_public_intake_rate") && intake.includes("delete verifiedPayload.antiAbuseToken"), "public onboarding rate scope is HMAC-protected and the anti-bot token is not forwarded");
assertContract(source.includes("TURNSTILE_SITE_KEY") && source.includes("action: 'retailer_onboarding'") && source.includes("antiAbuseToken:"), "public onboarding renders Turnstile and sends its single-use token");
assertContract(intake.includes('result.action !== "retailer_onboarding"') && intake.includes('"https://portal.urbanxtracts.com"'), "Turnstile validation binds the onboarding action and production portal origin");
assertContract(siteBuild.includes("UX_TURNSTILE_SITE_KEY") && siteBuild.includes("frame-src https://challenges.cloudflare.com") && siteBuild.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://challenges.cloudflare.com"), "the hosted worker injects Turnstile configuration and permits only its required script and frame origins");
assertContract(source.includes("/auth/v1/factors") && source.includes("/challenge") && source.includes("/verify") && source.includes("portalJwtClaims(upgraded).aal !== 'aal2'"), "Google and password sessions complete TOTP enrollment or challenge before portal access");
assertContract(source.includes("grant_type=refresh_token") && source.includes("scheduleSessionRefresh(token, refreshToken)") && source.includes("this.portalFetch("), "aal2 browser sessions renew before expiry and retry protected portal requests once");
assertContract(source.includes("sessionStorage.setItem(PORTAL_SESSION_KEY") && source.includes("sessionStorage.removeItem(PORTAL_SESSION_KEY") && source.includes("PORTAL_SESSION_MAX_IDLE_MS") && source.includes("restorePortalSession(session)") && !source.includes("localStorage."), "aal2 sessions survive same-tab refresh without creating a persistent trusted-device token");
assertContract(source.includes("Reset MFA") && source.includes("resetUserMfa(user)") && admin.includes('action === "reset-mfa"') && admin.includes("deleteFactor"), "administrators have an audited factor recovery flow that prevents self-lockout");
assertContract(siteBuild.includes("UX_MFA_REQUIRED") && siteBuild.includes('mfaRequired: env.UX_MFA_REQUIRED !== "false"'), "hosted MFA is on by default with an explicit emergency rollback switch");
assertContract(mfaMigration.includes("as restrictive") && mfaMigration.includes("public.portal_mfa_verified()") && mfaMigration.includes("auth.jwt() ->> 'aal'"), "database profile and pending-profile access require an aal2 session");
assertContract(mfaHelper.includes('?.aal === "aal2"'), "Edge Function assurance gate accepts only aal2 claims after Auth validation");
assertContract(readiness.includes("pendingAssetReviews") && readiness.includes('Deno.env.get("TURNSTILE_REQUIRED")'), "live readiness reports private assets and public-onboarding protection state");
assertContract(readiness.includes('label: "Multi-factor assurance"') && readiness.includes("This diagnostics request arrived with an aal2 session"), "live readiness records successful MFA assurance without exposing factor details");
assertContract(readiness.includes("directMondayIntakeReady") && readiness.includes("Direct, board-pinned Monday order intake is active"), "live readiness recognizes the direct Monday order path without depending on Make");
assertContract(readiness.includes("Latest signed callback") && readiness.includes("lastRefreshHasOneWebhook") && readiness.includes("Exactly one matching signed webhook remains"), "live readiness reports signed callback health and stale-webhook cleanup evidence");
assertContract(quickbooksOAuth.includes('scope: "com.intuit.quickbooks.accounting"') && quickbooksOAuth.includes("portal_consume_quickbooks_oauth_state") && quickbooksOAuth.includes("portal_store_quickbooks_connection"), "QuickBooks authorization is administrator-started, state-bound, and server-custodied");
assertContract(quickbooksOAuth.includes('headers.get("intuit_tid")') && quickbooksRetailers.includes('headers.get("intuit_tid")') && quickbooksRetailers.includes("error instanceof IntuitApiError") && quickbooksTraceMigration.includes("last_intuit_tid text"), "QuickBooks OAuth and data errors retain a sanitized Intuit support trace ID");
assertContract(!quickbooksOAuth.includes("tokenBody,") && !quickbooksRetailers.includes("body,"), "QuickBooks support diagnostics do not persist or log raw Intuit response bodies");
assertContract(quickbooksOAuth.includes('target.searchParams.set("quickbooks", result)') && quickbooksOAuth.includes("window.opener.postMessage") && quickbooksOAuth.includes('return portalRedirect("connected")'), "successful QuickBooks authorization reports completion to the existing production portal session");
assertContract(quickbooksOAuth.includes("recordCallbackFailure") && quickbooksOAuth.includes("QuickBooks connection storage failed") && readiness.includes("Latest connection result"), "QuickBooks callback failures retain a bounded protected diagnostic without exposing authorization material");
assertContract(quickbooksOAuth.includes("intuitOAuthEndpoints") && quickbooksRetailers.includes("intuitOAuthEndpoints") && quickbooksOAuthDiscovery.includes(".well-known/openid_configuration") && quickbooksOAuthDiscovery.includes('url.hostname !== expectedHost'), "QuickBooks OAuth uses Intuit discovery metadata with exact-host validation");
assertContract(quickbooksRetailers.includes("transientAccountingStatus") && quickbooksRetailers.includes("attempt < 3") && quickbooksRetailers.includes("accountingGet(") && !quickbooksRetailers.includes("tokenPostWithRetry"), "read-only QuickBooks queries have a bounded transient retry policy without retrying token POSTs");
assertContract(quickbooksOAuthDiscovery.includes("QBO_EGRESS_PROXY_URL") && quickbooksOAuthDiscovery.includes("QBO_EGRESS_PROXY_SECRET") && quickbooksOAuthDiscovery.includes("request is outside the egress proxy allowlist") && quickbooksOAuth.includes("intuitFetch") && quickbooksRetailers.includes("intuitFetch"), "QuickBooks calls can use the exact-route static-egress proxy without changing portal authorization");
assertContract(quickbooksOAuthDiscovery.includes('"sandbox-quickbooks.api.intuit.com"') && quickbooksOAuthDiscovery.includes("QBO_ENVIRONMENT") && quickbooksRetailers.includes("quickBooksAccountingBase(QBO_ENVIRONMENT)"), "QuickBooks Accounting requests require an explicit sandbox or production environment");
assertContract(quickbooksEgressProxy.includes("timingSafeEqual") && quickbooksEgressProxy.includes("x-ux-egress-secret") && quickbooksEgressProxy.includes("MAX_REQUESTS_PER_MINUTE") && quickbooksEgressProxy.includes('request.headers["x-forwarded-proto"]'), "the QuickBooks egress proxy requires constant-time shared-secret authentication, HTTPS, and rate limits");
assertContract(quickbooksEgressProxy.includes('"https://developer.api.intuit.com/.well-known/openid_configuration"') && quickbooksEgressProxy.includes('"https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"') && quickbooksEgressProxy.includes('"https://quickbooks.api.intuit.com"') && quickbooksEgressProxy.includes('"https://sandbox-quickbooks.api.intuit.com"') && quickbooksEgressProxy.includes("(sandbox|production)") && !quickbooksEgressProxy.includes("target="), "the QuickBooks egress proxy has fixed environment-specific Intuit destinations and no arbitrary target parameter");
assertContract(quickbooksEgressProxy.includes('["intuit_tid", "retry-after"]') && !quickbooksEgressProxy.includes("console.log(request") && !quickbooksEgressProxy.includes("console.log(payload"), "the QuickBooks egress proxy preserves support headers without logging requests or accounting payloads");
assertContract(quickbooksCronMigration.includes("portal-quickbooks-sync-5m") && quickbooksCronMigration.includes("*/5 * * * *") && quickbooksCronMigration.includes("vault.decrypted_secrets") && quickbooksCronMigration.includes("portal_quickbooks_scheduler_state"), "QuickBooks read sync has a Vault-gated five-minute scheduler and protected readiness state");
assertContract(!/[A-Fa-f0-9]{64}/.test(quickbooksCronMigration), "the QuickBooks scheduler migration contains no embedded high-entropy secret");
assertContract(readiness.includes("qboSchedulerResult") && readiness.includes("Five-minute scheduler"), "live readiness reports QuickBooks scheduler and Vault-credential state");
assertContract(quickbooksRetailers.includes("quickBooksConnected") && quickbooksRetailers.includes('reason: "QuickBooks is not connected."') && quickbooksRetailers.includes("}, 202)"), "scheduled QuickBooks refreshes skip cleanly until the encrypted production connection exists");
assertContract(quickbooksOAuthMigration.includes("pgp_sym_encrypt") && quickbooksOAuthMigration.includes("oauth_state_expires_at > now()") && quickbooksOAuthMigration.includes("refresh_token = null"), "QuickBooks refresh tokens are encrypted and OAuth state is expiring and one-time");
assertContract(quickbooksEnvironmentMigration.includes("oauth_environment = p_environment") && quickbooksEnvironmentMigration.includes("connection_environment = p_environment") && quickbooksEnvironmentMigration.includes("delete from public.quickbooks_customer_cache") && quickbooksOAuth.includes("portal_consume_quickbooks_oauth_state_v2") && quickbooksRetailers.includes("portal_get_quickbooks_connection_v2"), "QuickBooks OAuth, encrypted connection, and cache are isolated across sandbox and production");
assertContract(quickbooksSafeCacheMigration.includes("delete from public.quickbooks_invoice_cache where true") && quickbooksSafeCacheMigration.includes("delete from public.quickbooks_payment_cache where true") && quickbooksSafeCacheMigration.includes("delete from public.quickbooks_customer_cache where true"), "QuickBooks environment cache clearing is explicit and compatible with API safe-update enforcement");
assertContract(financials.includes("state?.connection_environment !== QBO_ENVIRONMENT") && readiness.includes('label: "Environment isolation"') && source.includes("quickBooksEnvironmentLabel"), "QuickBooks financial views and readiness expose and enforce the selected environment");
assertContract(orderCronMigration.includes("portal-order-outbox-flush-5m") && orderCronMigration.includes("*/5 * * * *") && orderCronMigration.includes("vault.decrypted_secrets"), "order outbox retries every five minutes with a Vault-backed credential");
assertContract(!/[A-Fa-f0-9]{64}/.test(orderCronMigration), "the order retry migration contains no embedded high-entropy secret");
assertContract(mondayOAuth.includes("code_challenge_method: \"S256\"") && mondayOAuth.includes("portal_consume_monday_oauth_state") && mondayOAuth.includes("oauth_ms/oauth/token"), "Monday authorization is administrator-started, one-time, and PKCE-bound");
assertContract(mondayOAuth.includes('scope: REQUESTED_SCOPES.join(" ")') && mondayOAuth.includes('"me:read"') && mondayOAuth.includes('"boards:read"') && mondayOAuth.includes('"webhooks:read"') && mondayOAuth.includes('"webhooks:write"'), "Monday authorization explicitly requests the configured least-privilege scopes");
assertContract(mondayOAuth.includes("params.app_version_id = APP_VERSION_ID") && mondayOAuth.includes('params.force_install_if_needed = "true"'), "Monday draft collaborators use version-specific OAuth while the live-app path still enforces installation");
assertContract(mondayOAuth.includes('target.searchParams.set("monday", "connected")') && mondayOAuth.includes("window.opener.postMessage") && source.includes("watchConnectorWindow") && source.includes("window.open('', 'ux-portal-quickbooks-oauth'"), "successful connector authorization uses a verified popup and preserves the portal session");
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
assertContract(productContent.includes("MONDAY_PRODUCT_BOARD_ID") && productContent.includes("syncMondayProductBoard") && productContent.includes("missingCanixItemId") && productContent.includes('automaticMappingPublicationState: "draft"'), "Monday catalog sync is board-pinned and keeps automatic mappings draft-only");
assertContract(productContent.includes("catalogMappingAuditFrom") && productContent.includes('matchKind: "exact_name_brand"') && productContent.includes("mondayMappingEligible") && productContent.includes("linkedCanixIds") && productContent.includes("canixBrandKeys.size === 1"), "catalog identity matching excludes invalid groups, reused Canix IDs, ambiguous brands, and name collisions");
assertContract(productContent.includes("applyExactProductMappings") && productContent.includes('unique_exact_product_name_and_brand_v1') && productContent.includes('monday.product_exact_mappings_auto_approved') && productContent.includes('action === "approve-exact-mappings"'), "unique exact product-name and brand pairs have a protected auditable bulk approval path");
assertContract(productContent.includes('action === "approve-mapping"') && productContent.includes('monday.product_mapping_approved') && productContent.includes('["boards:read", "boards:write"]') && productContent.includes('{ label: "Draft" }'), "catalog mapping approval is permission-gated, auditable, board-writable, and draft-only");
assertContract(productContent.includes('action === "approve-manual-mapping"') && productContent.includes('monday.product_mapping_manually_approved') && productContent.includes('reviewNote.length < 8') && source.includes('MANUAL IDENTITY REVIEW NOTE'), "manual catalog identity exceptions require a current unique Canix ID, reviewer note, Draft state, and audit event");
assertContract(wholesaleSourceScript.includes('rows.length !== 118') && wholesaleSourceScript.includes('SOURCE_DOCUMENT_ID') && wholesaleMigration.includes('portal_wholesale_price_source') && wholesaleMigration.includes('portal_default_price'), "the approved 118-row wholesale source is reproducibly staged apart from published default pricing");
assertContract(wholesaleMigration.includes('portal_verify_wholesale_price_source') && wholesaleMigration.includes('portal_publish_wholesale_price_source') && wholesaleMigration.includes("review_state <> 'verified'") && wholesaleMigration.includes('pricing.wholesale_default_published'), "default wholesale publication requires verified current Canix identity and writes an audit event");
assertContract(pricing.includes('verify-exact-wholesale') && pricing.includes('publish-verified-wholesale') && pricing.includes('wholesalePriceSnapshot') && source.includes('Wholesale list to Canix review queue'), "pricing managers receive a protected wholesale identity, verification, and publication queue");
assertContract(pricing.includes('structuredIdentityKey') && pricing.includes('reviewState = "structured_review"') && source.includes("structured_review: 'Structured candidate'"), "same-Brand reordered or internally prefixed wholesale names surface as review-only structured candidates without weakening exact auto-verification");
assertContract(intake.includes('portal_default_price') && intake.indexOf('defaultPriceResult.data') < intake.indexOf('storePriceResult.data'), "order intake uses published default wholesale pricing with approved store prices taking precedence");
assertContract(source.includes("Monday to Canix review queue") && source.includes("approveExactCatalogMappings") && source.includes("onCatalogMappingApproveExact") && source.includes("Verify & link") && source.includes("catalogMappingPending"), "catalog managers can batch exact matches while retaining the protected review queue");
assertContract(source.includes("Export filtered CSV") && source.includes("exportCatalogMappingReview") && source.includes("CATALOG REVIEW EXPORTED") && source.includes("^[\\t\\r\\n ]*[=+\\-@]"), "catalog managers can export spreadsheet-safe filtered identity exceptions for offline review");
assertContract(productContent.includes("reviewItems: reviewItems.slice(0, 1000)") && source.includes("SEARCH REVIEW QUEUE") && source.includes("catalogMappingStatusOptions") && source.includes("catalogMappingFilteredCount"), "every awaiting Monday-to-Canix identity is returned in a searchable, filterable, sortable review table");
assertContract(source.includes("syncMondayCatalog()") && source.includes("Sync catalog content"), "portal administrators can scan linked Monday catalog content from release readiness");
assertContract(readiness.includes("Latest Monday catalog scan") && readiness.includes("lastProductSyncMissingCanixItemId"), "live readiness reports Monday catalog mapping and sync evidence");
assertContract(readiness.includes("Economic-ownership allocation gate") && readiness.includes("Daily lot-integrity scheduler") && readiness.includes("lotAllocationExceptions"), "live readiness reports lot-register, scheduler, and allocation-control state");
assertContract(gitignore.includes("/data/canix-inventory-snapshot.json"), "live Canix snapshots are excluded from source control");
assertContract(source.includes("PORTAL_READINESS_API"), "portal includes protected live release diagnostics");
assertContract(source.includes('https://www.urbanxtracts.com/contact') && source.includes('Contact support'), "sign-in provides an in-app support contact path");
assertContract(!source.includes("CANIX_API_KEY"), "Canix credentials are absent from the browser source");
assertContract(!source.includes("QBO_CLIENT_SECRET"), "QuickBooks client secret is absent from the browser source");

for (const name of functionNames) {
  const text = await readFile(resolve(root, "supabase/functions", name, "index.ts"), "utf8");
  assertContract(text.includes("authorization") || text.includes("x-ux-") || text.includes("x-cron-secret"), `${name} has an authentication boundary`);
  if (name === "monday-webhook") {
    assertContract(!text.includes("access-control-allow-origin"), "monday-webhook remains server-to-server and does not expose a browser CORS surface");
  } else {
    assertContract(text.includes('"https://portal.urbanxtracts.com"'), `${name} permits the production portal origin`);
    assertContract(text.includes("verifiedTokenHasAal2"), `${name} rejects authenticated aal1 sessions`);
  }
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
