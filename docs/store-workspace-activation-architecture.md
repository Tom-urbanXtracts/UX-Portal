# UX OS Store Workspace activation architecture

Decision date: 14 October 2026
Planning status: **Approved for activation planning**
Release status: **Conditional owner instruction to deploy accepted demo/gated scope after checks; execution evidence pending. Broad live-retailer rollout is not accepted.**
Platform owner: IT; Executive Member is backup. Tom Jalallar remains temporary department head while permanent leads are held.

## Decision and evidence

The initial owner activation decision superseded the prior general hold on Store Workspace expansion and Store onboarding planning. Brand remains the primary staged delivery focus; Internal and Brand acceptance evidence must be reconciled with the Store pilot. The subsequent 14 October owner instruction authorizes Portal Build to complete dependencies and deploy accepted scope after checks. It does not establish passed acceptance, connected-system mutation authority, or a broad live-retailer rollout.

This is the architecture input for Store Onboarding Portal (the replacement for the failed Store Workspace task), Store Roles Portal, Systems Integrations, Identity/Roles/Permissions, Security/Audit/Retention, Shared Workflow Services, and Portal Build. Workstream assignments below are required inputs; they do not claim those tasks have accepted or completed them. Portal Build can assess dependencies now and may finalize implementation tasks only for scope whose mandatory policy and source inputs are accepted.

Repository evidence reviewed: `portal-three-workspace-restructure.md`, `retailer-account-and-onboarding-setup.md`, `order-workflow-setup.md`, `quickbooks-financials-setup.md`, the three-workspace foundation migration, and `supabase/functions/portal-admin/index.ts`. Existing documentation and code establish reusable foundations, not current production acceptance for the expanded Store release. No live configuration or deployment was changed by this review.

Reconciliation inputs reviewed on 14 October 2026: [Store Workspace first-release activation handoff](store-workspace-first-release-activation-handoff.md), including `OSPA-01` through `OSPA-12` and `SW-AC-01` through `SW-AC-18`; and the completed **Store Roles Portal** workstream output (task `01a118b5-1d99-7c42-9421-53b7554bcbe9`, turn `01a13c07-71e1-7c10-bf02-80e3789ca58a`). The Store Workspace task's later retry ended without a new output; this reconciliation uses its saved repository handoff and does not claim a new task sign-off. The dispositions below govern differences between these inputs; business approvals and execution evidence remain outstanding where named.

## Owner-decision correction

The [14 October dependency review](store-workspace-dependency-review-2026-10-14.md) carries forward the 9 October owner approvals for **25 stores per retailer**, **exact sellable-item quantities for Owners and Buyers**, one QuickBooks account across stores, and no Buyer approval of another Buyer's order. These supersede the architecture's earlier ten-store and qualitative-only defaults. Manager activation stays deferred even though the earlier quantity decision also named Manager.

Direct owner replies in Portal Build on 14 October select **urbanXtracts Store**, **Demo Store #1**, and **Demo Store #2**, and accept Finance terms/credit review plus a past-due ordering block until Finance clearance. The owner also instructed dependency completion followed by deployment. This correction is a document/acceptance-contract update only; DEP-01 through DEP-12 remain the evidence record for implementation gaps and separately completed repairs. No Store criterion is passed by this correction.

The subsequent direct owner replies set the live-order Canix inventory freshness maximum to **five minutes** and initial demo access to **Internal Administrators only**. Store-user invitations are not implied. The live cutoff and demo access checks are included below; other financial/publication freshness and class policies retain their assigned owners.

## Workspace and tenancy contract

| Context | Membership and scope | Permitted visibility |
| --- | --- | --- |
| Internal | Active workforce access plus explicit action, department, and sensitive-record permission | Authorized operating queues and projections; sensitive records require their own grant |
| Brand | Active membership in one verified Brand organization | Only that Brand's approved records and safe projections |
| Store | Active membership in one retailer organization plus role and normalized location assignments | Only that retailer and the locations permitted to the selected membership |
| Public kiosk | Revocable, expiring capability for one store | Published product education; no authenticated session or commercial/account access |

A retailer organization is the tenant; each licensed store location is a child scope. The owner approved a maximum of 25 stores per retailer organization on 9 October 2026. The deployed ten-store validation remains unchanged until Portal Build updates database, API, UI, and concurrency controls together and supplies acceptance evidence. QuickBooks parent/child customers describe accounting relationships, not tenancy grants. A Brand relationship or shared product never grants access to a retailer organization.

Retain the existing non-closed-location counting basis for the 25-store limit, including pending or paused locations. Align onboarding request size/numbering and total retailer limits. Test create, move, and reopen under concurrent attempts; editing an existing location at the cap remains allowed, and historical closed records remain retained. SW-AC-19 supplies the boundary cases.

Use immutable organization and store/license identities for authorization. Display names and legacy `portal_profile.org`/location labels may support compatibility only through verified mappings. Duplicate, missing, or ambiguous mappings deny the affected action and enter reconciliation. Do not rewrite historical migrations or infer an organization from an email domain or name match.

One identity may have several explicit workspace memberships. Signing in resolves active memberships and a permitted default. Switching selects workspace AND organization, reloads server-derived roles and location scope, clears prior-context state and subscriptions, and discards late responses from the old context. Browser cache, draft, file-link, and query keys must include the context. Deep links, downloads, exports, background requests, and another open tab must receive the same server checks. Workspace selection alone cannot grant authority.

Permissions from different memberships must not be combined to authorize an action. An Internal role does not become Store Owner authority, and a Store Owner role does not grant Brand management. Where multiple roles are supported within one context, Identity must document effective permissions and explicit restrictions; the legacy profile role alone cannot represent all of a multi-membership user's authority.

Membership deactivation revokes that scope; global identity suspension revokes every scope. A retailer Owner cannot suspend a shared identity's Brand or Internal access. Internal staff support Store users through explicit Internal capabilities; any future Store preview requires a separately audited, read-only design. Existing Brand preview must retain its own restrictions.

The Roles input's "session revocation" means immediate denial of the revoked Store context, including active tabs, subscriptions, refreshes, and file access. Identity must implement revocation without a global Auth ban or global sign-out that disrupts independent memberships. Previously issued file URLs need bounded expiry and a documented revocation approach; removing navigation alone is insufficient. Wider identity suspension stays with the separately authorized Internal process.

## Store roles and delegated administration

| Role | Scope | Planning baseline | Release dependency |
| --- | --- | --- | --- |
| Owner | All approved locations in own retailer organization | Catalog, approved sellable-item quantities, requests, orders, Owner approvals, receiving, full own-account statements with invoice references, approved exports, and bounded user/settings administration | Define the delegated administration action list and protect the last active Owner |
| Buyer | Explicitly assigned locations | Catalog, price, approved sellable-item quantities, requests, orders, receiving, approved statements for verified accounting scope, and approved scoped exports | Buyer cannot approve their own or another Buyer's order; controlled Buyer-order approval stays with Owner |
| Store Manager | Candidate assigned-location role; excluded from first pilot | Workspace proposes a non-purchasing operational role; Roles flags its conflict with the earlier Buyer/Manager baseline | No activation or permission grants until Store Roles and Sales/Operations confirm a distinct matrix; do not convert existing Buyers automatically |
| Budtender | Exactly one assigned location | Approved product education and resources | No prices, cart, orders, financials, exports, exact inventory, or administration; public COA/recall expansion stays outside scope |
| Kiosk visitor | One capability-bound location | Approved public education | No commercial or account data, private file links, or user administration |

Owner management is bounded by tenant and permission: it cannot grant Internal/Brand roles, Administrator access, another retailer's stores, legal-identity changes, license qualification, QuickBooks mappings, commercial publication, or release overrides. Buyer, Store Manager, and Budtender accounts cannot manage other users. Additional Owner appointments, ownership transfer, and sensitive settings require an IT-reviewed path until Store Roles and Identity approve a more specific policy.

The current `portal-admin` implementation allows Owner invitations for new Buyers/Budtenders and deactivation of those users; existing-role/store-assignment changes remain Administrator-only. The deactivation path updates global profile/Auth state, so it needs a membership-scoped design before the same identity can safely hold independent Store and Brand/Internal memberships. Keep broader delegated administration unavailable until reconciled; this review does not label the existing path a proven isolation failure for today's single-context accounts.

Buyer full-statement approval does not permit financial leakage through a shared QuickBooks customer. If a customer or parent balance includes unassigned stores or another tenant, withhold the affected statement unless Finance approves a trustworthy scoped allocation. Do not split an aggregate balance by guesswork. Owner statements remain limited to their own retailer organization.

## Shared services and cross-workspace visibility

| Shared service | Reuse contract |
| --- | --- |
| Identity and permissions | Resolve active identity, membership, organization, action, location, expiration, and record sensitivity on every protected request; RLS and server checks agree |
| Requests, tasks, approvals | Reuse durable work items and append-only decisions with Store-specific authorization; expose only approved customer-facing status/comments, not Internal review notes |
| Orders and receiving | Share idempotency, transitions, evidence, and outbox mechanisms; retain distinct Brand and Store order types and commercial policies |
| Documents and evidence | Private storage, quarantine, clean scan, version, class, reviewer, scoped download, retention, legal hold, and audit before any new class is released |
| Notifications | Durable Resend outbox, approved templates, scoped recipients, deduplication, delivery/suppression evidence, and existing quota controls; no cross-tenant recipients |
| Reporting and exports | Source and last-successful/as-of labels on every report; unknown remains unknown; export permission, row/field redaction, and every-export audit |
| Audit and readiness | Correlate identity, selected context, action, record, decision, and source without exposing secrets or unrelated sensitive payloads |

Shared infrastructure does not mean shared record visibility. Store records do not appear in ordinary Brand tasks, notifications, search, documents, exports, or reports. Brand users continue to receive only approved Brand-scoped projections; retailer/store names, contact identities, addresses, identifiers, invoices, and account balances remain withheld. Any future Brand-to-store visibility needs a separate contract, field policy, and release test. Internal users receive only explicitly authorized cross-workspace views, with restricted HR/Finance/Quality controls preserved.

## Integrations, catalog, pricing, and order eligibility

| System | Authority and activation boundary |
| --- | --- |
| UX OS / Supabase | Identity, memberships, permissions, retailer qualification, portal orders, workflow state, tasks, evidence, notifications, and audit |
| Canix | Items, facilities, cannabis inventory, packages, quantities, compliance, lab/testing, and production facts; portal projections never alter or override these facts |
| QuickBooks | Accounting customer/vendor identity, invoices, payments, balances, receivables, and GL; portal reads verified mappings and does not create automatic accounting mutations |
| Monday.com | Preserve existing history and explicitly approved handoffs during transition. Store activation creates no new active Monday dependency, board, automation, or write path; any source-mode change requires approval |

Catalog eligibility must use the current approved source contract. The repository documents exact Marketplace Product-ID reconciliation to one count-based Canix item at facility `OCM-DIST-24-000069` (`4467`) and source-controlled release/preorder states. The owner approved exact sellable-item quantities for Store Owner and Buyer on 9 October 2026. The projection is limited to the actor's authorized retailer/location scope and approved sellable inventory; package tags, package ownership, cost, bulk/material inventory, reservation records, compliance-only fields, and unrelated facilities stay withheld. Store Manager remains deferred; Budtender/kiosk receive no commercial quantities. Partial, ambiguous, or expired Marketplace publication fails closed. The seven-day full-shop expiry and five-minute live inventory submission cutoff are distinct gates. Systems Integrations and Quality still supply the verified quantity calculation, deployed-contract proof, and source/failure acceptance evidence.

Current documented pricing precedence is an approved Store-specific override, then the valid full-shop Marketplace default. The older wholesale crosswalk and broader contract/promotion precedence language require reconciliation before they can be described as the Store checkout source. Promotions, stacking, and invented fallback prices remain held. Prices must be rechecked at submit and snapshotted on accepted lines.

Exact quantities require `inventory.quantity.read` within the selected membership and catalog scope, with unit basis, last-successful/as-of time, and released/preorder meaning. Internal reservation coverage must inform the computation without exposing reservation records. Never label a shared distribution inventory pool as stock physically held at the retailer. Unknown quantities/coverage remain unknown; stale last-good values are explicitly historical and cannot establish current orderability. Quantity permission does not grant package-level detail, unrelated facilities, or export permission. The demo uses labelled fixture quantities and cannot consume the live pool.

For live submit, the owner-approved successful Canix inventory snapshot must be no older than five minutes. Missing, failed, future-dated, or older timestamps block before order/commitment creation while retaining the draft and a labelled informational snapshot. Test the exact five-minute boundary and just beyond it; the independent seven-day Marketplace publication limit cannot substitute for this inventory check. Earlier 15/30/60-minute and four-hour proposals are superseded for live submission, rather than new blocking policy awaiting approval. Do not describe a partial freshness repair as full Store acceptance.

An order requires active identity/membership, authorized retailer/location, qualified unexpired license and review evidence, account and location ordering readiness, verified accounting relationship, Finance-reviewed payment terms, approved published item/price/unit/case policy, eligible Canix release/availability, and explicit commercial/approval gates. A due-date-based past-due state blocks ordering until Finance records clearance. An ordinary nonzero balance alone is not past due and never creates an inferred hold. Unknown or stale critical data blocks the affected decision and identifies the source exception.

Finance approval and clearance record reviewer, authority, terms decision, timestamp, scope, source snapshot, reason, and append-only evidence. Determine past due from verified QuickBooks invoice due dates and outstanding amounts, not the aggregate balance alone. Payment refresh never silently clears a held account. Finance clearance applies to the recorded assessment; later past-due assessments are evaluated again. Missing/stale required financial evidence cannot enable ordering or clear a hold. Stores and Brands have no credit cap: no credit-limit value is collected, displayed or enforced, and committed order value never blocks ordering. Actual payment terms, any hold-release/exception authority, and assessment freshness remain assigned Finance inputs. A Buyer may receive a safe Finance-hold message without unassigned-store invoices or balances.

Drafts reserve nothing. Preserve existing transaction-safe accepted-order commitments and idempotency; an outage or retry must not double-submit, double-allocate, or erase durable work. Submission is not fulfillment or accounting completion. Until a new multi-location checkout model is approved, one submitted order belongs to one licensed delivery location. Reorders revalidate today's eligibility and price rather than silently replay historical terms.

Receiving confirmations and claims remain portal evidence, not Canix adjustments or QuickBooks credits. Operations owns delivery start to finish; Operations and Quality jointly own inventory exceptions. Store users and authorized Sales Managers may record receiving within their approved scope. Direct Brand selling, representative-held Owner approval, payment collection, public Store API, and new accounting/inventory write paths are not included in this activation decision.

## Conflicts and accountable workstreams

Every row is an assigned planning input awaiting evidence, not an accepted implementation task. IT coordinates named assignees; Executive Member is backup while department leads remain held.

| ID | Conflict or required decision | Accountable workstream | Required output and release gate |
| --- | --- | --- | --- |
| SA-01 | Membership model versus legacy single profile/org role and location fields | Identity/Roles/Permissions; Portal Build | Per-endpoint scope matrix, additive compatibility mapping, multi-membership/switch/deactivation tests; no broad activation with ambiguous authority |
| SA-02 | Retailer tenant versus license location versus QuickBooks customer | Store Workspace; Systems Integrations; Finance | Verified parent/child and location crosswalk, duplicate resolution, shared-customer denial evidence |
| SA-03 | Intended Owner management versus current Administrator-only updates/global deactivation | Store Roles; Identity/Roles/Permissions; Security/Audit/Retention | Exact action list, last-Owner rule, membership-scoped revocation, audited invitation/role lifecycle; unsupported actions stay gated |
| SA-04 | Buyer full statements versus organization-wide accounting rows | Finance; Store Roles; Security/Audit/Retention | Approved allocation/visibility rules; no unassigned-store or cross-retailer statement leakage |
| SA-05 | Owner approval thresholds and escalation | Store Roles; Sales/Commercial; Shared Workflow Services | Buyer self/peer approval stays denied; qualify Owner approvals by threshold and retain scoped authority, escalation, and evidence without timeout auto-approval |
| SA-06 | Marketplace default versus older wholesale crosswalk/contract pricing descriptions | Systems Integrations; Sales/Commercial; Finance; Portal Build | One deployed pricing/catalog contract, exact-ID join and stale/partial-source tests; promotions stay held |
| SA-07 | Inventory freshness, release/preorder, and reservation semantics | Systems Integrations; Operations; Quality | Source SLAs and fail-closed decisions with outage, failed lab, mixed release, concurrency, and retry evidence |
| SA-08 | Shared workflow, document, search, and notification data exposure | Shared Workflow Services; Security/Audit/Retention | Customer-safe projections, recipient scope, document class/retention/export policy, negative tenant tests |
| SA-09 | Brand access to retailer/store identity and transactions | Store Workspace; Brand Workspace; Security/Audit/Retention | Preserve withheld identity across every surface; any expansion requires separately approved contract and tests |
| SA-10 | Monday handoffs versus portal-native replacement | Systems Integrations; Monday Migration; Portal Build | Per-workflow source mode, stable IDs, deduplication, reconciliation owner, attachment handling, parallel-run/freeze decision |
| SA-11 | Multi-location purchasing and account administration | Store Workspace; Store Roles; Operations | First pilot uses one location per order; specify later parent-cart split/approval/fulfillment before expansion |
| SA-12 | Pilot scope, acceptance, staged release, and rollback | Portal Build; IT; Operations; Quality; Finance | Reconciled implementation plan and evidence-linked readiness rows; named pilot and release owner |

## Reconciled Store workstream dispositions

"Baseline resolved" means the architecture direction is selected for planning; it does not mean implementation or testing passed. "Assigned" means the named owner must supply the outstanding policy/evidence. Optional scope is excluded while unresolved. Mandatory isolation, compliance, pricing, and order-eligibility decisions remain release gates.

| Store input | Architecture disposition | Accountable owner / architecture link | Acceptance and first-pilot effect |
| --- | --- | --- | --- |
| OSPA-01: Store Manager | **Deferred from pilot.** Owner, Buyer, and named Budtender remain the role baseline. A separate operational Manager is a candidate, not an approved role or an automatic migration from Buyer/Manager. | Store Roles + Sales/Operations; SA-01, SA-11 | Verify Manager assignment/activation is denied. A future matrix and compatibility plan must explicitly resolve commercial, receiving, license, and financial permissions. SW-AC-04 tests this denial. |
| OSPA-02: Monday order bridge | **Current source mode recorded; implementation evidence assigned.** DEP-07 reports Store orders are already `portal` and onboarding is `hold`. Do not route portal-mode orders back to Monday. Respect the onboarding hold until the approved portal-native path is accepted. Preserve historical IDs/records; add no new boards, automations, or write paths. | Systems Integrations + Monday Migration + Portal Build; SA-10 | SW-AC-07/14/16. Verify portal-mode acceptance without a Monday dependency, server-side hold denial, and no duplicate downstream effects. |
| OSPA-03: shared accounting customer | **Baseline resolved; mapping evidence assigned.** Parent/child customer relationships never grant location access. Withhold rows and totals spanning unauthorized stores or retailers; no guessed allocation. Parent mapping is allowed only where every returned row is within the actor's scope. | Finance + Systems Integrations; SA-02, SA-04 | SW-AC-11/12. Buyer full statements retain invoice references only within verified assigned accounting scope; the parent total is not a substitute. |
| OSPA-04: catalog/price/quantity source | **Baseline selected; deployment proof assigned.** Exact Marketplace-to-Canix identity; approved Store override then valid Marketplace default; scoped sellable-item quantities for Owner and Buyer only. No legacy wholesale/fuzzy fallback, package-internal projection, or promotion engine. | Systems Integrations + Sales/Finance + Portal Build; SA-06, SA-07 | SW-AC-04/05/06/08/14. Confirm the deployed contract, quantity definition, and freshness values; separately test role/location scope, source, price, quantity, availability, release, and preorder gates. |
| OSPA-05: documents/licenses | **Assigned; unapproved upload classes excluded.** Reuse existing approved classes only after Store-specific visibility and scan/download evidence. New classes require class owner, reviewer, retention, legal hold, expiry, export, and archive rules. | Quality + Operations + Security + Shared Workflow; SA-08 | SW-AC-09/10/12/13. Browsing approved documents does not authorize upload; a quarantine or unknown scan result denies release. |
| OSPA-06: Finance ordering gate | **Owner direction resolved; implementation evidence assigned.** Finance reviews payment terms before ordering is enabled; there is no Store or Brand credit cap. A due-date-based past-due account is held until Finance records clearance. A nonzero balance alone is not past due. | Finance + Sales/Commercial + Portal Build; SA-06, SA-12 | SW-AC-06/08/12/14. The pilot account must have the Finance decision, reviewer, time, evidence, hold reason, source/as-of state, and any clearance recorded. Unknown or stale mandatory eligibility blocks ordering. |
| OSPA-07: approvals/escalation | **Baseline resolved; expansion deferred.** Owner approves qualifying Buyer orders. Buyers cannot approve their own or another Buyer's order. Owner-originated orders do not receive the Buyer value hold. Representative-held approval stays disabled. Shared controlled requests retain their separate no-self-approval rules. | Store Roles + Sales + Shared Workflow; SA-05 | SW-AC-04/07/09. No auto-approval on timeout. Internal permission controls threshold changes; pilot threshold and notifications require named approval. |
| OSPA-08: draft reservations | **Baseline resolved.** Drafts reserve nothing. Recheck on submit and preserve existing atomic accepted-order commitments with idempotency and explicit Canix reconciliation. | Operations + Systems Integrations; SA-07 | SW-AC-06/07/08. Concurrent requests cannot overcommit; lost responses and retries cannot duplicate acceptance. |
| OSPA-09: announcements/notifications | **Shared-service contract resolved; audiences assigned.** Reuse approved templates, sender controls, dedupe, quotas, and audience checks. New announcement types/escalations require an owner and policy. | Shared Workflow + IT + Sales/Operations; SA-08 | SW-AC-13/14. Check scope again at send time; suppress/retry without recipient expansion. Budtender receives only approved education/support notices. |
| OSPA-10: product images | **Expansion deferred.** Display only approved published assets under the existing source/publication rules. New Store upload or public publication is outside the pilot until Quality/IT approval. | Quality + Marketing + IT; SA-06, SA-08 | SW-AC-05/10. Unavailable assets have honest empty states; asset exceptions never broaden file access. |
| OSPA-11: retailer hierarchy/cap | **Owner direction resolved; implementation evidence assigned.** Retailer is tenant, locations are child scopes, cap is 25, and one location belongs to each accepted order. No ambiguous grouping or automatic merge/split. | Store Workspace + Identity + Systems Integrations + Portal Build; SA-02, SA-11 | SW-AC-02/03/07/11. Update every enforcement layer together and verify the 25-store cap under concurrency; retain historical identity, mapping, and attribution through future approved restructuring. |
| OSPA-12: deactivation/session scope | **Architecture resolved; implementation evidence assigned.** Revoke Store membership/context immediately; Owner cannot globally ban or sign out an identity. Preserve independent Brand/Internal memberships and history. | Identity + Security + Portal Build; SA-01, SA-03 | SW-AC-03/15/17. Test active tabs, subscriptions, refresh, downloads, and delayed requests; verify independent memberships remain usable. |

Additional Roles input dispositions:

- **Budtender operating model:** first-pilot baseline is a named authenticated user assigned to exactly one store. Shared education devices use approved public kiosk capabilities; a shared authenticated Budtender identity is excluded pending Identity/Security policy.
- **Owner delegation:** invitations, Buyer/Budtender assignments, and membership deactivation are intended bounded capabilities, subject to SA-03 implementation and tests. Until then, use the existing narrower IT-mediated path. Additional Owners, ownership transfer, final-Owner removal/replacement, and sensitive account settings require Internal review. Never grant these powers through a job title alone.
- **Financial fields and exports:** approve per-role field/dataset/format allowlists before release. Full statements do not imply every QuickBooks object is supported: standalone credits/credit memos require a confirmed source contract before display. Invoice/payment/balance projections must retain original source and as-of labels. Undefined exports and document classes remain denied.
- **Kiosk lifecycle:** retain existing Administrator-managed issuance/revocation unless separately delegated. Departing staff triggers review of related capabilities; a public link is not a user membership. Kiosk access remains education-only, revocable, and independently testable.
- **Contractors, emergency access, and View as Store:** no default contractor/vendor Store access or new preview/emergency grant is part of pilot. Any exception needs scoped Internal authority, purpose, expiration, and audit; it cannot override tenant, compliance, or source gates.
- **Demonstration data:** use the owner-selected synthetic tenant **urbanXtracts Store** with **Demo Store #1** and **Demo Store #2** for isolated demonstrations. Keep it separate from Internal, Brand, real retailer, Canix, QuickBooks, outbound notification, and production-order effects. Synthetic demonstration evidence does not satisfy real-retailer pilot or production acceptance.

The dependency review records demo identifiers `DEMO-UX-STORE-001` and `DEMO-UX-STORE-002` as paused, unqualified scaffolds. They are not OCM-issued licenses. The functional demo must use labelled synthetic orders, financial and quantity fixtures, and a server-authorized demo context; never qualify those IDs as real licenses, attach a live QuickBooks customer, create live inventory commitments, or send Canix/QuickBooks/Monday writes or email. A client-supplied demo flag cannot bypass real eligibility. Preserve all existing Brand/Internal memberships and keep retired fixtures inactive. SW-AC-21 covers demo isolation and outbound suppression.

Initial demo entry requires an active Internal Administrator with explicit demo action authority. It is not a general Store role, does not grant a live Store membership, and cannot expose real retailer data. Owner/Buyer/Budtender role acceptance is exercised using isolated test contexts; it does not authorize inviting external demo users. Non-Administrator staff, ordinary Store/Brand users, anonymous users, and forged demo requests must be denied.

| Acceptance inputs | Readiness destination |
| --- | --- |
| SW-AC-01, SW-AC-02, SW-AC-03, SW-AC-04, SW-AC-15, and the Roles negative-permission suite | Gate C: isolation and scoped revocation |
| SW-AC-05, SW-AC-06, SW-AC-07, SW-AC-08, SW-AC-09, SW-AC-10, SW-AC-11, SW-AC-12, SW-AC-13, SW-AC-14 | Gate D: workflows, source behavior, documents, financials, and recipients |
| SW-AC-16 | Gate B: preserved migration history and source identity |
| SW-AC-17 | Gate G: rollback rehearsal |
| SW-AC-18 | Gates F/G: recorded accepted demo/gated scope under the conditional owner deployment instruction; named real-cohort decision before broad live activation |
| SW-AC-19, SW-AC-20, SW-AC-21 | Gates B/C/D/F/G: 25-location enforcement, Finance ordering gate, synthetic demo isolation, and accepted deployment scope |
| Brand/Internal critical-path regressions from both workstreams | Gate E: shared-service regression acceptance |

No acceptance ID is complete merely because it is mapped here.

## Release Readiness, migration, pilot, and rollback

| Gate | Evidence required | Accountable owner |
| --- | --- | --- |
| A. Planning reconciliation | Store Workspace, Store Roles, and architecture inputs agree; SA-01 through SA-12 have an owner and disposition; affected document/permission/source contracts are explicit | Architecture / IT with involved workstreams |
| B. Migration readiness | Verified organizations, licenses, members, accounting IDs, and item/price crosswalks; counts and source timestamps; duplicate and missing-data queue; scoped records and private attachment manifests; existing history retained | Systems Integrations / Monday Migration / Operations |
| C. Isolation acceptance | Two retailers with multiple locations, a Brand, Owner, limited Buyer, named Budtender, disabled candidate Manager, Internal limited user, deactivated user, and multi-membership identity; test reads/writes, forged IDs, deep links, cache switches, late responses, files, exports, notifications, and direct API/RLS denial | Identity / Security / Portal Build |
| D. Workflow acceptance | Scoped onboarding to ready; catalog to draft/submit/Owner approval; price/source changes; rejection; retry and outage recovery; delivery and receiving/claim evidence; financial visibility; export audit; no duplicate downstream item or accounting mutation | Store Workspace / Operations / Finance / Quality |
| E. Regression acceptance | Brand pilot and Internal critical workflows remain accepted; existing shared security/release contracts and affected tests pass; desktop/mobile Store role walkthroughs show actual eligible data | Portal Build / Shared Workflow Services |
| F. Controlled demonstration and live pilot | First prove the isolated urbanXtracts Store / Demo Store #1 / Demo Store #2 path with synthetic records and outbound effects suppressed. A later live-retailer pilot separately requires verified retailer/license/account mappings, permitted users, catalog subset, limits, support owner, monitoring window, and acceptance evidence. | IT with Operations / Quality / Finance |
| G. Rollback rehearsal and release | Demonstrate server-side disabling of affected Store actions, preserved orders/evidence, deliberate outbox pause/drain, compatible release restoration, and Brand/Internal regression. Record passed checks and exact demo/gated deployment scope under the existing conditional owner instruction; later broad live activation needs its named real-cohort decision | Portal Build / IT / Executive backup |

Use additive migrations and explicit source modes. Read-only migration discovery does not authorize external writes or board modification; any live copy/import needs its approved scope. Keep Monday history and outbox IDs intact, and prevent a parallel workflow from emitting the same operation twice. Record reconciliation counts, file hashes where copied, mapping exceptions, approvals, and a replay cursor or source timestamp before cutover.

Pilot monitoring must cover unauthorized access attempts, scope mismatches, license expiry, source freshness, price mismatches, failed transitions, duplicate requests, outbox backlog, scan failures, and notification delivery. Trigger rollback for tenant/financial leakage, unauthorized action, unresolved duplicate commitments/orders, or failure of critical eligibility gates; IT leads triage with Operations, Quality, and Finance.

Observability evidence must name the alert owner, response channel, pilot monitoring window, review cadence, and escalation contact. Correlate membership/workspace, organization/location, request/idempotency key, transition, source snapshot, and outbox attempt in restricted logs; include counts, last success, queue age, and denial category without copying tokens, private documents, or unrelated tenant payloads. Verify alerts through deliberate connector failure, rejected scope, and stalled-outbox drills. Monitoring and support access require their own permissions.

Rollback must not delete records, rewrite accepted prices, cancel valid orders automatically, reverse Canix/QuickBooks records, or remove Brand/Internal memberships. Already accepted work stays visible to authorized Internal operators for reconciliation. Cross-system deactivation and automatic deletion remain held.

## Portal Build handoff

1. Use this document and its reconciled dispositions with the Store Workspace handoff and recorded Store Roles output. Finalize tasks only for the scope whose mandatory policy inputs have been accepted; exclude Manager activation and other deferred optional scope explicitly.
2. Produce an endpoint and data-contract impact map for the shared services, including compatibility fields and remaining global-profile assumptions.
3. Turn SA-01 through SA-12 and gates A through G into reviewable tasks with owner, evidence, dependencies, source, status, and acceptance conditions. Documentation here does not claim that live readiness records were created.
4. Implement only reconciled scope in isolated changes; shared identity, pricing, workflow, and database contracts have one integration owner and require consumer review. Each workstream owns its assigned files and hands off shared-contract changes before dependent merges.
5. Attach focused authorization/workflow regression evidence, pilot acceptance, and rollback rehearsal to the release decision. Label the expanded capability **Approved for activation planning** until readiness supports a later status.
