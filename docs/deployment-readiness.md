# UX OS portal deployment readiness

The current Sites domain stays in place until urbanXtracts chooses the production domain. No DNS or publishing change is part of the current local build.

## Production domain

- Choose the final hostname, preferably a dedicated subdomain such as `portal.urbanxtracts.com`.
- Add the hostname to the hosting project and complete DNS verification.
- Add the exact production callback URL to Supabase Auth redirect allow-lists.
- Update the Supabase Site URL after the production hostname is serving successfully.
- Keep the old Sites URL available during a short verification window, then redirect or retire it deliberately.

## Sign-in and workforce SSO

Email and password remain available. The urbanXtracts mail domain is on Google Workspace, and the dedicated Google/Supabase workforce SSO connection is enabled and tested. A hosting release exposes the SSO button only when it supplies the two values below.

Set these server-side deployment values only after the identity provider is configured in Supabase:

- `UX_SSO_PROVIDER`: `google`.
- `UX_SSO_DOMAIN`: `urbanxtracts.com` unless the approved workforce domain changes.

SSO configuration and cutover requirements:

- Create a Google Web OAuth client and set its authorized redirect URI to `https://cbhsavfbtcpdyxcvguay.supabase.co/auth/v1/callback`.
- Configure the Google client ID and secret in Supabase Auth, then enable the Google provider.
- Keep the Google app internal to the urbanXtracts Workspace organization when the selected Google Cloud project supports that audience setting.
- Add the current portal URL and, later, the final production URL to the Supabase Auth redirect allow-list. The Google OAuth redirect URI remains the Supabase callback above.
- Apply `20260901090000_portal_staff_access.sql` before deploying the permission-aware inventory function and portal.
- Apply `20260901101500_portal_admin_and_quickbooks.sql` before deploying user administration or QuickBooks customer sync.
- Apply `20260901123000_store_pricing_workflow.sql` before deploying store pricing. It also provisions first-time `@urbanxtracts.com` SSO users as least-privileged workforce Viewers.
- Apply `20260901133000_order_policy_and_preorders.sql` before deploying store approval thresholds or accepting orders from the updated portal.
- Apply `20260901150000_durable_portal_orders.sql` before deploying the durable order service or the updated order intake. It creates the authoritative portal order, line, event, and retry-outbox records; browsers have no direct table access.
- Apply `20260901170000_retailer_accounts_and_onboarding.sql` before deploying retailer controls or the updated intake. It normalizes QuickBooks-linked retailer organizations, enforces the ten-store cap, separates license and ordering gates, and makes multi-store onboarding durable.
- Apply `20260901190000_catalog_content_and_coa.sql` before deploying the enriched inventory/catalog functions. It creates versioned normalized COA records, a protected Monday product-content model, and the `catalog.manage` capability for Administrator, Operations, and Sales.
- Apply 20260901210000_quickbooks_financials.sql before enabling Financials or QuickBooks-backed store performance. It creates server-only versioned Invoice and Payment snapshots and grants financials.read only to Administrator, Operations, and Sales.
- Apply 20260901230000_economic_ownership.sql before deploying the updated Canix inventory function. It removes the incorrect Brand-to-Owner alias, adds explicit Canix Package Owner fields, and creates protected effective-dated Economic Owner mappings. Deploy portal-economic-ownership with the updated canix-inventory function. Administrator, Operations, and Sales receive economics.manage; all inventory readers may view the resulting internal classification.
- Apply `20260901320000_canix_brand_economic_partners.sql` before deploying the matching Canix inventory and economic-ownership functions. It creates a separate Canix Brand-to-Economic Partner registry, seeds every current nonblank Brand, normalizes `WANA` to the display name `Wana`, and leaves all explicit Economic Owner and Settlement Counterparty records unchanged.
- Apply `20260901240000_canix_availability_contract.sql` after the ownership migration. It records optional Canix product/case metadata, explicit reservation coverage, reservation-adjusted count-based orderable units, the approved `canix_item_id_v1` catalog identity, and the default-off per-store case enforcement switch.
- Apply `20260901250000_security_and_inventory_commitments.sql` after the availability contract. It atomically commits accepted portal quantities, releases commitments on terminal/rejected/legacy-exception outcomes, reconciles a commitment only to its explicitly linked Canix sales order, enforces the order transition graph in PostgreSQL, serializes Canix sync claims, and publishes a fully staged Canix snapshot in one database transaction.
- Apply `20260901260000_deterministic_sso_provisioning.sql` next. It consolidates new-user provisioning into one trigger: `@urbanxtracts.com` users receive active internal Viewer access, while external users receive a pending retailer profile. It preserves existing administrator assignments and inactive-user state.
- Apply `20260901270000_safe_canix_stage_cleanup.sql` after the inventory-commitment migration. It makes staging cleanup compatible with the database safe-update guard without weakening the guard.
- Apply `20260901280000_private_portal_assets.sql` next. It creates the private product/COA bucket, fail-closed asset lifecycle, atomic activation links, and privacy-preserving public-intake rate claims.
- The migrations initialize existing internal profiles as `viewer`; explicitly assign and verify the first `administrator` before releasing the fail-closed portal.
- Workforce users receive an active internal Viewer profile on first SSO sign-in. Administrator, Operations, Sales, and Quality elevation remains an explicit administrator action.
- Test sign-in, sign-out, deactivated users, missing profiles, and an account outside the approved domain.

Live verification on 1 September 2026 found email/password and Google enabled in Supabase Auth. The dedicated Google client uses the Supabase callback, the current Sites and exact local paths are allowlisted, and Tom completed the full consent-and-return flow while retaining the existing Administrator preset. The database-side Viewer provisioning repair is deployed and both existing workforce profiles are configured. The final hostname remains a cutover check and must not be allowlisted before it is approved.

The current Sites callback to allow during pre-deployment testing is:

- `https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site/`

## Connected workflows

- Keep the per-function gateway policy in `supabase/config.toml`. `canix-inventory`, `portal-intake`, `portal-orders`, `portal-product-content`, and `quickbooks-retailers` set `verify_jwt = false` because their handlers authenticate cron, webhook, public-onboarding, or user calls themselves. User-only functions retain the platform JWT check.
- Canix inventory uses the private Supabase Edge Function and an active five-minute schedule. The 1 September 2026 production verification published 1,324 current package rows, zero volume rows, zero missing package IDs, and left no staged rows or sync error.
- Deploy `canix-catalog` alongside `canix-inventory`. It gives active portal users a quantity-withheld catalog projection: products with a passing lab result can be ordered normally, packages awaiting a passing result are labelled pre-order, and failed lab packages remain excluded.
- Set `PORTAL_EXTERNAL_ASSET_HOSTS` to the comma-separated exact hostnames approved for Canix COAs and Monday product images. Unlisted hosts fail closed; include the real storage/CDN hosts only after IT validates their redirect and content policies. Do not include Monday's current `protected_static` host: anonymous requests redirect to Monday sign-in and cannot serve as retailer-facing catalog assets.
- Apply `20260901280000_private_portal_assets.sql` and deploy `portal-assets` before allowing controlled image or COA uploads. The bucket is private, uploads fail closed pending review, and only active assets receive five-minute catalog URLs. Follow `docs/asset-storage-and-onboarding-protection.md` before enabling production uploads or public onboarding.
- Deploy `portal-product-content` with JWT gateway verification disabled and the server-only `MONDAY_PRODUCT_SECRET`, then configure the Monday product board to send factual content keyed by the current Canix item ID. The function self-authenticates either that secret or a Supabase user token. Only explicitly published Monday records join the catalog; every accepted update is audited.
- Deploy the updated `portal-admin` before enabling Add user, Change role, or Deactivate. Those actions are server-authorized, no longer write profile tables from the browser, and enforce exactly one normalized store assignment for every Budtender.
- Deploy `portal-pricing` before enabling Store pricing. Retailer Owners and Buyers may create proposals only for their server-assigned stores; `pricing.manage` is limited to Administrator, Operations, and Sales, and approval is the only action that publishes a store price.
- Deploy `portal-order-policy` before enabling the Buyer approval controls. Owners can read all policies in their organization, Buyers can read assigned-store policies, and only internal users with `accounts.manage` can change a policy.
- Deploy `portal-readiness` for internal users with `readiness.read`. It returns only booleans, counts, timestamps, and sanitized error summaries; it never returns credentials. Use it to verify connector configuration, snapshots, outbox health, account readiness, pricing approvals, content, and controlled deferrals.
- Deploy the updated `portal-intake` with `MAKE_WEBHOOK_URL`, `MAKE_INTAKE_SECRET`, and the encrypted Monday OAuth settings. It server-verifies store scope, current published prices, Canix availability/release state, and the store approval threshold. The database then atomically commits each accepted quantity before delivery. When the installed app has `boards:write`, the server uses a board-pinned, client-request-idempotent Monday API path and retains Make as the compatibility path for the other intake kinds. Live drafts remain intact until an authoritative order number and Monday item ID are returned.
- Deploy `portal-orders` with `MAKE_ORDER_STATUS_WEBHOOK_URL`, `MAKE_INTAKE_SECRET`, `MONDAY_STATUS_SECRET`, `ORDER_SYNC_CRON_SECRET`, and the encrypted Monday OAuth settings. With `boards:write`, status outbox events update only the pinned order board directly; Make remains the compatibility fallback.
- Configure the Monday intake scenario to deduplicate on `clientRequestId` and return JSON containing `orderNumber`, `mondayItemId`, and `mondayBoardId`. A repeated accepted `clientRequestId` must return the existing identifiers rather than create another item.
- Configure the Monday-to-portal scenario to call `portal-orders` with `action: monday-status`, an order identifier, an exact supported Monday status, and the positive numeric `canixSalesOrderId` after operations creates the Canix sales order. Authenticate with `x-ux-monday-secret`. This explicit one-to-one link prevents the same demand from being subtracted once as a portal commitment and again as a Canix allocation. Schedule `action: flush-outbox` with `x-ux-cron-secret` at least every five minutes so failed portal-to-Monday status writes recover automatically.
- Deploy quickbooks-oauth, quickbooks-retailers, quickbooks-financials, and portal-readiness. Configure QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_TOKEN_ENCRYPTION_KEY, QBO_CRON_SECRET, and the approved callback/return URLs. An Administrator then starts the one-time Intuit authorization from Release readiness; the callback stores the realm and encrypted refresh token server-side. Never copy a realm or refresh token into browser code or deployment documentation.
- Deploy `portal-retailers` after the retailer-account migration. Only internal users with `accounts.manage` can link a QuickBooks customer, change retailer readiness, add stores, qualify licenses, or enable/disable store ordering.
- The updated `portal-intake` records an onboarding request and its one-to-ten stores before calling Monday. Configure the Monday onboarding response to return `mondayItemId` and `mondayBoardId`; missing confirmation is retained as a reconciliation item rather than silently treated as success.
- Schedule the combined QuickBooks financial refresh at the cadence accounting approves. The internal Financials action also performs an authenticated server-side sync; retailer users can refresh only the already-authorized portal view.
- Cannabis Store (DEMO), its three licensed stores, and `qbo:customer:demo-*` accounts are synthetic, visibly labelled, resettable, and never forwarded to Canix, QuickBooks, Monday, or Make.
- Recall issuance remains disabled until a server-side notification workflow accepts and records the `recall` intake event. Enable it only by setting `UX_RECALL_NOTICE_ENABLED=true` after that workflow is verified.
- Cost/margin, customer API credential issuance, document retrieval, and payment collection remain out of primary navigation until their authoritative systems are connected. Financials is read-only: a displayed balance never creates an order hold, and payment or banking details are not collected.

### Live connector status — 1 September 2026

- Supabase migrations are reconciled through `20260901300000`; all 15 Edge Functions are active and the 68-contract remote suite, including anonymous-denial checks, passes.
- Canix is healthy and serving the last atomically published snapshot on the active five-minute schedule.
- Make scenario `6043707` (`UX Portal intake to monday`) was repaired and saved inactive on 1 September 2026. Its structurally validated blueprint now finds orders by `clientRequestId`, stores both portal identifiers, returns the complete identifier contract, handles portal-to-Monday order-status updates, and returns onboarding item identifiers. The Make organization remains paused after exceeding its free operation allowance, so no runtime execution has passed; its webhook remains detached, the Monday-to-portal callback and retry schedule remain unverified, and live orders stay gated until the end-to-end matrix passes and activation is deliberate.
- Follow `docs/make-order-automation-remediation.md` for the exact repair sequence and acceptance matrix; do not modify the unrelated finance sandbox scenario.
- `MONDAY_STATUS_SECRET`, `ORDER_SYNC_CRON_SECRET`, and `MONDAY_PRODUCT_SECRET` are configured server-side. The independent Vault-backed five-minute outbox job is active and returned HTTP 200 during its controlled empty-queue test. Monday-to-portal callbacks and product-content ingestion remain disabled operationally until their sending workflows are connected and tested.
- QuickBooks OAuth values are not configured; retailer financial views remain on the safe last-snapshot/blank path and do not write to QuickBooks.
- Google Workspace SSO is enabled in Google and Supabase and passed a Tom-account round trip to the local portal. The current owner-only Sites release supplies and exposes the Google provider/domain flags. The final-domain callback must still be added and retested during cutover.
- Private portal asset infrastructure and Turnstile-ready onboarding protection are implemented. Asset activation remains empty pending Quality/IT review policy; the public challenge remains disabled until a public host, widget site key, server secret, and exact hostname list are approved.

## Executive-demo baseline

The administrator-only reset restores this complete scenario set and restarts the required seven-step walkthrough. Production orders, drafts, pricing, policies, users, and audit history are preserved.

| Demo store | Licensed-store condition | Approval policy | Demonstration record |
| --- | --- | --- | --- |
| Demo Downtown | Ready to order | Buyer orders above $500 require Store Owner approval | Delivered order `DEMO-SO-1007`, declined order `DEMO-SO-1010`, and a pending store-price proposal |
| Demo Riverside | Explicit account ordering hold; past-due QuickBooks invoice displayed | Every Buyer order requires Store Owner approval | `DEMO-SO-1008` waiting for Store Owner approval |
| Demo Northgate | Expired license blocks new submission | Value approval disabled | Approved pre-order `DEMO-SO-1009` held until Canix release |

The catalog is a stable snapshot of real product names with synthetic demo prices, factual education, lab values, and scenarios. It does not refresh from Canix or Monday while a demo location is selected. Live Canix, Monday, order, and pricing data are excluded from the demo views; demo rows are likewise excluded from production views.

Demo-only QuickBooks accounts, users, onboarding, documents, invoices, notifications, failed-lab metrics, and recall-impact rows follow the same boundary. The recall scenario uses a demo catalog tag across the three demo stores plus synthetic in-custody stock; it never identifies a production retailer or enables the disabled notification connector.

## Release checks

- Run `npm run build`.
- Confirm the packed portal script matches `ux-portal-prototype.dc.html`.
- Verify `/` and `/portal` locally; `/api/inventory` must return `404` because inventory is available only through the authenticated Supabase Edge Function.
- Confirm the portal HTML contains no Canix package rows or inventory snapshot payload.
- Confirm the Edge Function returns inventory only for `inventory.read`, allows user-triggered sync only for `inventory.sync`, contains only `WeightBased` and `CountBased` quantities, and excludes volume.
- Confirm Brand, Canix Package Owner, and Economic Owner remain independent; blank Economic Owner values render as Not classified and never inherit Brand. Verify an item default, a package override, and a backend revenue-share example where urbanXtracts is Economic Owner and the brand partner is Settlement Counterparty.
- Confirm every nonblank Brand in the latest Canix snapshot has a current Economic Partner mapping. Specifically verify items 2867738 → Wana, 2806248 → PAX, and 2907006 → Royal Genetics. Confirm the Economic Partner filter, table column, package detail, CSV export, and administration mapping counts all agree.
- Confirm `canix-catalog` returns no exact on-hand quantity, cost, or owner-only accounting data; labels pending-release products as pre-order; and excludes failed lab packages.
- Confirm external catalog responses exclude allocated lots while internal catalog responses label them unavailable. Verify product content is published-only and `groupingPolicy` is `canix_item_id_v1`.
- Confirm the production (non-sandbox) Canix snapshot subtracts any explicit count-based reservations, exposes unknown reservation coverage without replacing it with zero, and never treats an allocated or zero-orderable package as sellable.
- Fail a Canix sync after its first staged batch and confirm inventory continues serving the prior successful package count and values. Complete the next run and confirm the new snapshot and COA revisions become visible together only after publication.
- Sync a Monday product record and a Canix package with structured lab values. Confirm Catalog, Kiosk, COA, and Lineage search reproduce the supplied values and units, retain blanks, and preserve a prior COA revision when the current record changes.
- Test a successful order and a rejected intake. Success must clear the draft only after an order number is returned; failure must leave the draft intact.
- Request more units than the current Canix count-based availability and confirm intake rejects the order without disclosing the available total. Confirm retailer-selected lot tags are discarded and fulfillment allocation remains with urbanXtracts.
- Repeat the same order submission with the same `clientRequestId`; confirm that one portal order and one Monday item exist. Simulate a timeout after Monday accepts the first call and confirm the retry enters reconciliation without creating another order.
- Submit two different request IDs concurrently for the final available units. Confirm only one transaction commits, then cancel it and confirm the released commitment permits a later order. Link an accepted portal order to its unique Canix sales order, allocate its packages in Canix, refresh, and confirm only the uncovered commitment remains deducted.
- Test organization and store isolation on order history, owner approval/decline, internal approval/processing, retailer delivery confirmation, stale concurrent transitions, and deactivated-user denial.
- Test QuickBooks Owner and Buyer scoping, shared-customer fail-closed behavior across both store mappings and another retailer's parent customer ID, Budtender denial, workforce financials.read, last-successful snapshot fallback, invoice sorting/filtering, payment history, and the rule that a non-zero balance never infers an ordering hold.
- Stop the Monday status scenario, make a portal transition, and confirm the portal state remains saved with a pending/failed outbox row. Restore the scenario, flush the outbox, and confirm it reaches `sent` without adding another portal event.
- Send Monday statuses forward, backward, and with a skipped intermediate state. Only exact allowlisted labels and Ordered → Approved → Processed → Delivered may advance; labels such as `Delivery failed`, `Not approved`, and `Processing error`, plus stale/backward/skipped transitions and terminal cancellation, must be rejected or ignored.
- Test user invitation, existing-user role change, cross-organisation denial, self-deactivation denial, session revocation after deactivation, and Store Owner denial when a Buyer or Budtender is assigned to a pending/rejected store.
- Test owner organization-wide pricing scope, buyer assigned-store scope, duplicate-pending rejection, unauthorized publication denial, internal approval/rejection, zero-padded Canix item alias rejection/canonicalization, and catalog use of only approved store prices.
- Test order approval policy values `NULL` (disabled), `0` (every Buyer order), and a positive threshold (only orders above the value). Confirm Store Owner orders never receive a value-approval hold.
- Test per-store case enforcement off and on. On must reject missing/ambiguous Canix case data and non-multiples; off must continue accepting positive whole-number eaches.
- Test a pre-order through approval and internal confirmation. It must not move to Processed/Delivered until a refreshed Canix catalog reports a passing lab result; a standard released order must continue normally.
- Test QuickBooks active and inactive customers, explicit portal readiness, non-zero balances, and multi-store links without inferring past-due status from balance alone.
- Test the retailer-account gate sequence: start qualification, add a store, qualify its license, enable store ordering, then set the account ready. Confirm every earlier state blocks order submission server-side.
- Test a three-store onboarding submission, a repeated `clientRequestId`, and a simulated Monday timeout. Confirm the internal queue shows the durable request and its reconciliation state without duplicate Monday items.
- Walk one onboarding request through all six stages. Confirm licenses must be individually reviewed, only qualified stores are materialized, account relinking stops after store creation, requested users are invited with server-derived organization/store scope, and Ready remains blocked until account, store, and Owner prerequisites pass.
- Test email/password and the selected SSO provider on the final domain before inviting users.
- Enter Cannabis Store (DEMO) as an Administrator, complete all seven forced walkthrough steps, and confirm free roam begins only after the last step.
- Mutate a demo order, draft, price, policy, and access record; use Reset executive demo; confirm the baseline above returns and no production record changes.
- Confirm Demo Owner sees all three demo stores, Demo Buyer sees Downtown and Riverside, and Demo Budtender sees Downtown only.
- Confirm demo catalog, pricing, order, QuickBooks snapshot, onboarding, kiosk, and exception views display no production rows and make no external write.
