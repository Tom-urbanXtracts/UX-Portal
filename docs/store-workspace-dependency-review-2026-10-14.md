# Store activation dependency review

Initial review: 10/14/2026, around 4:15–4:20 PM America/New_York. Later controlled-demo implementation and execution evidence is recorded in [the Store demo release record](store-demo-release-2026-10-14.md); the initial findings below remain as a dated baseline.

This review covers the active Store activation package and the owner's request to deploy after its dependencies are complete. It records completed repairs separately from remaining implementation, business policy, and release evidence. Broad Store activation has not passed acceptance.

## Owner decisions carried forward

| Topic | Current owner direction | Build implication |
| --- | --- | --- |
| Demo organization | urbanXtracts Store | Separate synthetic tenant, distinct from the urbanXtracts Brand and Internal organization |
| Demo locations | Demo Store #1 and Demo Store #2 | Two synthetic location identifiers; never represent these as OCM-issued licenses |
| Finance ordering gate | Finance reviews payment terms and credit limits before enabling ordering; past-due accounts are blocked until Finance clears the hold | Record terms, credit decision, reviewer, time, explicit hold reason and clearance; an ordinary nonzero balance alone is not past due |
| Canix live submission freshness | Owner selected a five-minute maximum on 10/14/2026 | Reject submission when the last successful inventory snapshot is older than five minutes; retain the informational snapshot and draft |
| Initial demo access | Internal Administrators only, confirmed 10/14/2026 | No Store test-user invitations or memberships were issued by this pass |
| Organization limit | Owner approved 25 stores on 10/09/2026 | Planning is reconciled to 25. The deployed ten-store implementation remains unchanged; update database validation, API validation, UI and concurrency acceptance together |
| Inventory quantity visibility | Owner approved quantities for Store Owner and Buyer on 10/09/2026; Manager was also named but its activation remains deferred | Owner/Buyer may receive approved sellable-item quantities; no internal package ownership, cost, bulk materials, or unrelated facility information. Budtender/kiosk receive no commercial quantities |
| Accounting hierarchy | One QuickBooks account for all stores, confirmed 10/09/2026 | Owner can receive organization-scoped financials. An assigned-location Buyer cannot receive an aggregate spanning unassigned stores; withhold it unless reliable source attribution exists |
| Buyer approvals | Buyers cannot approve another Buyer's order, confirmed 10/09/2026 | Controlled Buyer-order approval stays with Owner; prevent self-approval |
| Document requirements | Mandatory versus conditional retailer documents remain on hold | Do not invent a required document list or expand upload classes. Reuse approved classes only after Store-specific visibility/scan tests |
| Outbound supply-order email | Prior hold applies to supply-order sending | Store activation does not change that unrelated delivery hold |

OS Portal Arch planning now records the 25-store limit and Owner/Buyer scoped sellable-item quantities. Manager activation remains deferred, and Budtender/kiosk quantity access remains denied. This is a documentation-level disposition only; deployed controls have not been changed by this reconciliation.

## Dependency findings

| ID | Dependency and evidence | Status / next completion step | Owner |
| --- | --- | --- | --- |
| DEP-01 | Store organization memberships exist, but production `portal_workspace_role_permission` contains no Store permission rows. Most Store endpoints authorize through the legacy profile role/org rather than a selected membership | Implementation required: one shared Store context resolver, accepted role/action matrix, membership-specific location assignments, and matching server/RLS checks. Verify forged context and cross-retailer denial | IT / Identity / Portal Build |
| DEP-02 | `portal-admin` Store Owner deactivation changes global profile `active` and Auth ban state. Membership revocation alone would not protect existing profile-authorized endpoints | Implementation required: revoke Store membership/context and enforce it everywhere; preserve independent Brand/Internal memberships, active tabs, subscriptions and bounded file access. Protect last Owner | IT / Identity / Security |
| DEP-03 | Browser workspace switching clears many projections, but legacy profile fallback remains; broad multi-membership execution evidence is absent | Implementation required: context-aware request/cache/draft keys, cancellation or rejection of late responses, and no legacy fallback that restores revoked access. Test Store↔Brand↔Internal and another open tab | Portal Build / Identity |
| DEP-04 | Live Canix package snapshot: 1,465 packages, successful at 4:10 PM. Full Marketplace snapshot: 120 of 120 products, successful at 3:40 PM. Owner selected a five-minute inventory submission limit | Freshness repair deployed as `portal-intake` v54: validate successful run ID and source timestamp, reject missing/future/older-than-five-minute inventory before order creation/commitments. Four boundary/failure tests pass; deployed source matches. Exact-ID, release/preorder, case/minimum/increment and quantity projection still need full Store acceptance | Integrations / Operations / Quality / Sales |
| DEP-05 | QuickBooks scheduled requests were rejected with HTTP 401 / `Missing authorization header`; production `quickbooks-retailers` v47 had gateway JWT verification enabled although its scheduler uses a dedicated secret | Completed repair: deployed identical source as v48 with the repository's configured custom-authentication setting. No-credential and invalid-secret requests returned 403. Authenticated refresh succeeded. Scheduler-secret verification request 60417 returned 200 / `ok:true`; successful financial refresh recorded at 4:19:32 PM | IT / Integrations |
| DEP-06 | QuickBooks financial projection has existing Buyer shared-customer withholding logic, but Store membership-based scope, per-role field/export acceptance and Owner cross-retailer collision coverage remain unverified | Implementation and acceptance required: keep source read-only, withhold unassigned-store aggregate rows/totals, test both Owner and Buyer, approve exports, retain source/as-of labels. No guessed allocations | Finance / Integrations / Security |
| DEP-07 | Store order source mode is already `portal` in production; Store onboarding remains `hold`. Intake still treats onboarding as requiring Monday irrespective of source mode | Implementation required: respect hold server-side and implement the approved portal-native onboarding path. Preserve historical Monday IDs and records. Existing orders must not be sent to a new bridge or double-submitted | Portal Build / Operations / Migration |
| DEP-08 | Finance's ordering-gate policy is now chosen; portal account/store hold fields already exist, but the reviewed retailer/store schema lacks a complete structured terms/credit review record | Implementation required: explicit Finance decision/evidence, due-date-based past-due assessment with source freshness, manual clearance and audited overrides. Keep unknown financial state explicit | Finance / Portal Build |
| DEP-09 | Shared private storage, scanner, document versioning, outbox, audit and workflow services exist. Their Store class/field/audience contracts have no complete Store acceptance suite | Reuse existing services; keep unapproved uploads, announcement types and exports unavailable. Add tenant/location-safe public comment/evidence projections and send-time recipient checks | Shared Workflow / Quality / Security |
| DEP-10 | Requested demo account and locations were absent; retired demo records remained inactive | Staged: created urbanXtracts Store account, onboarding organization and two paused, unqualified location records with three audit events. No QB identity, membership, license approval, invoice or notification was created. A functional isolated demo order/financial path still needs implementation | Portal Build / IT |
| DEP-11 | Verification passes: 565 release contracts, 8 service tests, 13 security-contract tests, 4 Store inventory freshness tests; `portal-intake` type check passes. Unauthenticated order submission returns 401. These do not execute all 18 Store acceptance criteria | Store-specific execution still required: two-tenant negative tests, multi-membership, approval/idempotency/concurrency, documents, financial isolation, outage behavior, desktop/mobile and Brand/Internal regression | Portal Build / IT acceptance |
| DEP-12 | The database still showed `retailer-buying-desk` as `controlled_hold` while repository planning was active | Completed status reconciliation: applied reviewed status/evidence DML from `20261014213000_approve_store_workspace_activation_planning.sql`; verified `in_progress`, active and source-linked. This is planning evidence, not passed release acceptance. Pilot access controls, rollback rehearsal and final rollout evidence remain required | Portal Build / IT |

## Demo scaffold evidence

- Retailer account: `fbcdd8b8-f612-43bc-91e8-a3211a620255`, `setup_pending`, no QuickBooks customer.
- Organization: `c4c1ef6c-2768-4717-a5e1-0a0773668771`, retailer kind, onboarding status.
- Location identifiers: `DEMO-UX-STORE-001` and `DEMO-UX-STORE-002`.
- Both locations: inactive, `pending_qualification`, ordering paused, no qualified timestamp, no QuickBooks mapping.
- Three retailer events document the account and two location creations.
- Reproducible, insert-only staging script: [stage-store-activation-demo.sql](../scripts/stage-store-activation-demo.sql). It checks collisions and does not reactivate prior records on retry.

These are saved setup records. They do not yet provide a usable demo login or successful shopping/order workflow. The demo path must use separate synthetic orders/financial fixtures and suppress outbound integration writes and email. Never qualify synthetic licenses or attach a live QuickBooks customer to make a demo pass.

## Deployment sequence and remaining decisions

1. Treat the owner-approved 25-store limit and Owner/Buyer scoped sellable-item quantity rules as reconciled planning inputs; implement and test the shared authorization, projection, freshness, and concurrency contracts before activation.
2. Implement and verify DEP-01 through DEP-03 before granting new Store memberships or enabling the demo workspace.
3. Complete portal-native onboarding, catalog/order freshness, role-scoped financials and the Finance gate; apply only approved document/notification scope.
4. Enable the isolated urbanXtracts Store demo for approved existing test identities after the synthetic workflow and outbound suppression tests pass. Do not move or deactivate existing Brand/Internal memberships to achieve this.
5. Run all applicable `SW-AC-01` through `SW-AC-18` tests, desktop/mobile and Brand/Internal regressions, and a rollback rehearsal. Preserve accepted orders/evidence and Monday history.
6. Deploy the tested demo/gated release under the owner's instruction. A later live retailer rollout needs real retailer/license/account mappings and a named real cohort; the synthetic demo cannot supply that evidence.

Still requiring a business/source answer: the final mandatory retailer-document list; exact per-item case/minimum/increment values; financial/export field allowlists; and the live retailer cohort/acceptance owners when production ordering is requested. Preserve their holds or disable the affected optional capability rather than treating this dependency review as approval.

Owner answered the two follow-up questions: use **five minutes**, and **Internal Administrators only initially**. The proposed 15-minute option was not approved. The new freshness helper is [store-inventory-freshness.ts](../supabase/functions/_shared/store-inventory-freshness.ts); its tests are [store_inventory_freshness_test.ts](../supabase/tests/store_inventory_freshness_test.ts). The existing information-read path retains the last successful snapshot, and the rejection occurs before durable order/commitment creation. A signed-in Store stale-order walkthrough has not been executed and is still required for SW-AC acceptance.

## Shared-service impact map

| Existing path | Current authorization or behavior | Required Store dependency |
| --- | --- | --- |
| `portal_my_workspaces()` / organization membership | Returns active explicit memberships; global profile state still gates every membership | Preserve global suspension while implementing Store-only revocation and explicit context |
| Browser `portalIdentity`, `signIn`, `switchWorkspace` | Loads memberships with legacy fallback and clears many projections during switching | Prevent fallback from restoring revoked Store access; context-bound draft/cache/request state and reject late responses |
| `portal-admin` | Brand membership checks coexist with legacy Store role/org and global ban updates | Store membership action/location scope, transactional assignment/invitation changes, last-Owner protection and separate global suspension |
| `canix-catalog` | Authenticates profile, joins Marketplace to Canix, currently emits `exactQuantity:false` | Selected Store membership, current approved catalog/quantity projection, stock freshness checks, no internal package fields |
| `portal-pricing` | Legacy profile/org, per-user Store assignment, Internal publish approval | Membership/location checks, maintain internal price publication approval and customer-safe pricing fields |
| `portal-intake` | Profile-based order validation, transactional acceptance/commitments, workflow source mode; onboarding always requires Monday | Shared context, source freshness, Finance hold, accepted onboarding source mode, synthetic demo isolation and idempotency |
| `portal-orders` / `portal-order-policy` | Legacy Owner/Buyer org/location scope and Internal manage permission | Shared Store context, Owner-only controlled approval, customer-safe milestones and membership revocation |
| `quickbooks-financials` | Profile/org and assigned-store mapping; Buyer shared-customer denial | Membership-based scope, Owner/Buyer collision acceptance, source freshness, export/field allowlists |
| `portal-claims` | Profile/org/location, delivered-order and claim-window checks | Shared membership and location authorization, controlled public evidence, no inventory/accounting writes |
| `portal-retailers` | Internal-only administration and independent qualification/order gates | Keep internal decisions protected; six-section application review and explicit Finance decision/evidence |
| `portal-notifications` | Profile role/org audience checks, assignments, outbox, suppression and provider states | Membership-aware recipient checks at send time, demo suppression, approved Store event matrix |
| `portal-assets` / `portal-kiosk` | Internal-managed uploads/links; capability-based kiosk resolution | Maintain separate kiosk education scope and revocation; approved Store file classes/download authorization |

This map records local code inspection, not an executed authorization suite. Shared-service changes require tests of existing Brand/Internal consumers as well as Store paths.

QuickBooks repair rollback: redeploy the captured v47 source/settings only if required, with the known consequence that gateway JWT enforcement would again block the secret-only scheduler. Do not roll back by deleting caches, rotating connection credentials, or modifying accounting records. Inventory repair rollback: the captured intake v53 is the previous version, but restoring it removes the five-minute check; keep Store submissions disabled if that rollback is needed. Demo scaffold rollback: retain the paused records/history and grant no memberships; never delete unrelated retailer data.

## Controlled-demo follow-up, 10/14/2026

The implemented demo uses a private per-Administrator synthetic session and a protected service-only commit path; no Store memberships or real retailer qualification were created. The separate `store.demo` grant, current active Internal Administrator membership, server pause and revision checks are enforced on every request/commit. Owner/Buyer/Budtender/Internal are simulated views inside this controlled context, not live grants.

DEP-10 is implemented and verified for this narrow demonstration. DEP-02/03/06/08/11/12 have **demo-specific** evidence in the release record, not completion of their broader live Store contracts. The 25-store functions, trigger, API error handling, UI and draft restoration were updated together; cap/reopening checks passed in a rolled-back database test. The Store onboarding hold now blocks intake before persistence or external forwarding. Owner cross-retailer accounting collision checks and five projection tests passed.

Remaining live dependencies are still DEP-01–03 shared membership/location authorization and bounded administration; DEP-04 real catalog/case/quantity acceptance; DEP-06 approved financial/export fields; DEP-07 accepted portal-native onboarding activation; DEP-08 structured real Finance reviews/freshness; DEP-09 Store document/recipient contracts; and DEP-11/12 full real-cohort acceptance and rollout evidence. Do not mark the overall `retailer-buying-desk` completed from the demo.
