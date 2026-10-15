# Store Workspace Portal Build planning queue
Intake date: 14 October 2026

Work package: **UX OS Store Workspace Activation**

Intake status: **Active Portal Build queue — planning and implementation preparation**

Capability status: **Activation planning approved — expanded release not yet approved**

Initial intake authorized planning only. On 14 October 2026 the owner requested dependency completion followed by deployment. Implementation and deployment may proceed for accepted scope after its dependency and release checks pass; broad Store activation remains incomplete.

Current evidence and remaining work: [Store activation dependency review](store-workspace-dependency-review-2026-10-14.md).

Architecture correction completed 14 October: see [owner-decision correction](store-workspace-activation-architecture.md#owner-decision-correction) and the updated [acceptance contract](store-workspace-first-release-activation-handoff.md#10-acceptance-criteria). The original 18 criteria have three supplements: SW-AC-19 (25-store boundaries/concurrency), SW-AC-20 (Finance review/past-due hold/clearance), and SW-AC-21 (Internal-Administrator-only synthetic demo and outbound suppression). Map these to SW-PB-01/02/09, SW-PB-05/07/09, and SW-PB-09/10 respectively. The live Canix submission freshness maximum is five minutes. These are recorded requirements, not passed Store execution evidence.

The owner selected **urbanXtracts Store**, **Demo Store #1**, and **Demo Store #2** for a synthetic demonstration and accepted Finance review of terms/credit limits plus a past-due ordering block until Finance clearance. The demo account/location scaffolds are saved with ordering disabled. This supplies a demo cohort, not real-license or production-order acceptance evidence.

Additional owner decisions: the initial demo is **Internal Administrator-only**, and live submissions require a successful Canix inventory snapshot no older than **five minutes**. The inventory guard and QuickBooks scheduler repair are deployed and individually verified; the remaining Store dependencies and full acceptance evidence are still open in the dependency review.

## Accepted source package

- [Store Workspace activation architecture](store-workspace-activation-architecture.md)
- [Store Workspace first-release activation handoff](store-workspace-first-release-activation-handoff.md)
- Store Roles Portal reconciled output referenced by the architecture
- Store Onboarding Portal is the active Store onboarding/workspace workstream; it replaces the earlier Store Workspace Portal task that ended with a system error

The architecture dispositions for `OSPA-01` through `OSPA-12` and assignments `SA-01` through `SA-12` are accepted for dependency decomposition. The mapping of `SW-AC-01` through `SW-AC-18` to readiness gates A through G is accepted as planning coverage only. It is not passed test evidence, business-policy approval, pilot acceptance, or release authorization.

The Internal Workspace intake received on 14 October 2026 is reconciled into this same package rather than creating a duplicate queue. Its requested gated build phases are recorded below. Entry gates must be accepted before the affected implementation begins; the intake does not establish that they are satisfied.

## Entry-gate assessment

| Entry gate | Current evidence | Remaining dependency |
| --- | --- | --- |
| Reconciled Store scope | Saved Store onboarding/workspace handoff and architecture dispositions received | Business acceptance of mandatory policies and exact first-pilot scope; optional deferrals remain excluded |
| Approved Store roles and permissions | Store Roles output referenced by OS Portal Arch; Owner, Buyer, named Budtender and education-only kiosk baseline recorded | Accepted action/field/export matrix, bounded Owner administration, last-Owner recovery, and scoped revocation requirements |
| OS Portal Arch confirmation | Reconciled architecture covers workspace switching, tenancy, shared services and source-system boundaries | Per-service impact map and accepted compatibility/source contracts before dependent implementation |
| Security, audit, export, retention and separation of duties | Accountable workstreams assigned in SA-01 through SA-12 | Accepted document classes, financial/export allowlists, reviewer rules, audit coverage and retention controls |
| Release Readiness criteria | SW-AC-01 through SW-AC-18 mapped to gates A through G | Named acceptance owners, execution records, pilot roster and rollback evidence; mapping alone passes no gate |

## Requested build sequence

| Phase | Scope | Existing queue packages | Exit evidence |
| --- | --- | --- | --- |
| Preparation | Current-state impact map, policy acceptance, migration inventory, shared-contract review and test design | SW-PB-00, 02, 08, 09 | Gate A inputs accepted for the affected scope; approved source modes and import boundaries recorded |
| 1. Shared foundations and isolation | Membership, explicit workspace/organization switching, retailer/location tenancy, role scope, bounded administration, immediate Store membership revocation and audit; reuse shared services | SW-PB-01, 03, 08, 09 | Gate C authorization/isolation evidence, including independent Brand/Internal memberships, active tabs, files, exports and notifications |
| 2. Store first-release experience | Dashboard, catalog, permitted pricing, ordering and license gates, draft/submit/status, locations, approved documents, scoped requests/comments/evidence, approved announcements/notifications and support | SW-PB-04, 05, 06, 08, 09 | Gate D workflow evidence and desktop/mobile walkthroughs for catalog, ordering, status, documents/licenses, requests and notifications |
| 3. Approved projections and operational controls | Canix inventory/compliance and verified read-only QuickBooks projections, freshness/failure behavior, connector health, reconciliation, migration continuity and audit | SW-PB-02, 04, 07, 08, 09 | Gates B/D evidence, shared-customer withholding, source/failure drills and verified reconciliation |
| Pilot and release | Controlled cohort, observability/support, Brand/Internal regression, rollback rehearsal and separately recorded activation decision | SW-PB-09, 10 | Gates E/F/G and applicable SW-AC criteria pass with execution evidence |

The phase sequence does not postpone essential Canix eligibility checks until phase 3: catalog and order submission in phase 2 depend on the accepted Canix source/freshness contract. QuickBooks-dependent ordering gates likewise require a verified accounting relationship before submission. Mobile acceptance belongs to each affected experience, not a later cosmetic pass.

Brand remains the primary staged focus. Preserve approved Internal and Brand scope, accepted records and existing workflow behavior. Schedule shared identity, authorization, pricing, notification and document changes through one integration owner, with affected consumer review and Brand/Internal regression evidence before dependent merges. Store preparation may proceed alongside existing work where it does not alter their shared contracts. Store pilot access waits for its own release gates.

Planned or unaccepted capabilities retain **Designed Intent** or **In Development** labels as applicable; the expanded workspace remains **Activation planning approved — expanded release not yet approved** until the separate release decision is recorded.

## Non-negotiable boundaries

- A retailer organization is the Store tenant; licensed locations are child authorization and order scopes.
- Store, Brand, and Internal memberships remain independent. Permissions from different memberships are never combined to authorize an action.
- Store membership revocation must deny the Store context without globally banning or signing out independent Brand or Internal memberships.
- Canix remains authoritative for cannabis inventory, packages, quantities, compliance, lab/testing, release, and production facts.
- QuickBooks remains authoritative for accounting records. First-release Store financials are read-only, verified projections.
- QuickBooks rows or totals spanning unauthorized stores or retailers are withheld. UX OS never guesses an allocation.
- Existing Monday history and already approved handoffs are preserved. This intake creates no new Monday board, automation, write path, or dependency.
- Candidate Store Manager activation is excluded from the first pilot. Existing Buyers are not converted automatically.
- Store Owner and Buyer may receive approved current sellable-item quantities only within their authorized organization/location scope. Store Manager remains deferred; Budtender and kiosk receive no commercial quantities. Package tags, ownership, cost, bulk/material inventory, reservations, compliance-only fields, and unrelated facilities remain withheld.
- Finance reviews payment terms and credit limits before ordering is enabled. A due-date-based past-due state blocks ordering until Finance records clearance; a nonzero balance alone is not past due.
- The owner-approved retailer-organization limit is 25 stores. Existing ten-store controls remain unchanged until database, API, UI, and concurrency enforcement are updated and accepted together.
- Draft orders reserve nothing. First-pilot submitted orders belong to one licensed delivery location.
- Optional or unresolved capabilities fail closed or remain outside the first release.

## Planning and dependency queue

These are planning packages, not implementation tickets. A package may be decomposed now where the work is read-only analysis or contract definition. An implementation task may be finalized only after every mandatory input in its row is accepted.

| Queue ID | Planning package | Architecture links | Readiness / acceptance coverage | Planning state | Mandatory input before implementation task is finalized |
| --- | --- | --- | --- | --- | --- |
| SW-PB-00 | Current-state impact map: endpoints, tables, RLS, storage, functions, navigation, cache/subscriptions, outboxes, exports, and legacy profile assumptions | SA-01 through SA-12 | Gate A | Ready to decompose | None for read-only discovery; findings return to the named architecture owner before shared-contract changes |
| SW-PB-01 | Retailer tenancy, location scope, multi-membership context, membership-scoped revocation, and compatibility model | SA-01, SA-02, SA-03, SA-11 | Gate C; SW-AC-01 through 04 and 15 | Planning only | Identity/Roles endpoint-action matrix; last-Owner rule; scoped revocation design; verified retailer/location identities |
| SW-PB-02 | Migration and reconciliation inventory for organizations, licenses, users, accounting IDs, item/price mappings, documents, and Monday history | SA-02, SA-10, SA-11 | Gate B; SW-AC-16 | Ready to decompose | Approved live import scope, source timestamps/cursors, duplicate policy, file manifest, reconciliation owner, and source mode before any copy/write |
| SW-PB-03 | Store role and delegated-administration contract for Owner, Buyer, Budtender, and kiosk; explicit Manager denial | SA-01, SA-03, SA-05, SA-11 | Gates A/C; SW-AC-04 and 15 | Planning only | Accepted role/action/field/export matrix; Owner invitation/deactivation boundaries; Buyer approval policy; kiosk lifecycle owner |
| SW-PB-04 | Catalog identity, publication, Owner/Buyer scoped sellable-item quantities, price precedence, case/minimum/increment, freshness, and fail-closed eligibility | SA-06, SA-07 | Gate D; SW-AC-04, 05, 06, 08, and 14 | Planning only | Deployed exact-ID and quantity-projection contract evidence; Sales/Operations/Quality approval; role/location field matrix; price and freshness thresholds; case/minimum/increment source |
| SW-PB-05 | One-location Store order lifecycle, Finance eligibility gate, idempotent acceptance, Owner approval, customer-safe status, receiving, claims, and existing bridge boundary | SA-05, SA-07, SA-10, SA-11 | Gate D; SW-AC-06 through 09, 12 through 14, and 16 | Planning only | Approved pilot order source mode; Finance terms/credit decision and due-date-based past-due/clearance contract; Owner approval policy; transition/action matrix; existing bridge stable IDs and reconciliation owner |
| SW-PB-06 | Store licenses and approved document/evidence classes with scanner, quarantine, review, expiry, retention, download, export, and archive controls | SA-08 | Gate D; SW-AC-10 and 13 | Blocked on policy | Quality/Operations/IT-approved class list, reviewers, visibility, expiry, retention, export rules, and scanner evidence |
| SW-PB-07 | Read-only QuickBooks Store projection, account/location mapping, field redaction, stale behavior, and audited exports | SA-02, SA-04 | Gate D; SW-AC-11, 12, and 14 | Blocked on Finance inputs | Finance-approved fields and exports; verified customer/location mapping; shared-customer withholding rules; freshness/fallback policy |
| SW-PB-08 | Shared workflow, comments, public evidence, notifications, announcements, support, reporting, export, audit, and readiness-service impact | SA-08, SA-09 | Gates D/E; SW-AC-09, 10, 12 through 14 | Ready to decompose | Per-event audience/field rules and accepted document/notification policy before consumer implementation |
| SW-PB-09 | Negative authorization, RLS, files, exports, notification recipients, context switching, idempotency, concurrency, connector failure, and Brand/Internal regression plan | All SA rows | Gates C/D/E; SW-AC-01 through 16 | Ready to decompose | Test data and environments may be designed now; execution waits for a release candidate and accepted contracts |
| SW-PB-10 | Isolated synthetic demonstration, later live-retailer pilot, observability, support/runbook, rollback rehearsal, evidence packet, and separate release decision | SA-12 | Gates F/G; SW-AC-17 and 18 | Synthetic demo cohort named; live pilot blocked | Demonstration: urbanXtracts Store with Demo Store #1 and Demo Store #2, synthetic fixtures, outbound suppression, support/monitoring, and rollback control. Live pilot: named real retailer, verified locations/users/mappings, catalog subset, limits, dates, acceptance owners, and release authority |

## Shared-service dependency owners

| Shared dependency | Required Portal Build treatment | Primary planning owner |
| --- | --- | --- |
| Identity and permissions | One membership/context authorization model with server and RLS agreement; no Store-specific parallel permission engine | Identity/Roles/Permissions and Security/Audit/Retention |
| Requests, tasks, approvals, comments, and evidence | Reuse shared workflow services with Store-specific tenant/location and customer-safe projection rules | Shared Workflow Services |
| Documents and files | Reuse private storage, scanning, versioning, classification, download authorization, retention, and audit | Security/Audit/Retention with Quality/Operations |
| Notifications | Reuse durable outbox, approved templates, quota, deduplication, delivery evidence, and send-time recipient authorization | Shared Workflow Services and IT |
| Reporting and exports | Reuse source/as-of labels, field redaction, permission checks, and export audit | Reporting/Data with Finance/Sales policy owners |
| Canix | Read-only authoritative inventory/compliance inputs with explicit freshness and fail-closed behavior | Systems Integrations with Operations/Quality |
| QuickBooks | Read-only authoritative accounting projections with verified scope and no inferred allocation | Systems Integrations with Finance |
| Monday.com | Preserve history and approved existing handoffs; add no dependency or write path | Monday Migration and Systems Integrations |
| Release Readiness | Create evidence-linked readiness work only after its planning owner and acceptance source are known | Portal Build and IT |

## Explicit first-pilot exclusions

- Store Manager activation or automatic Buyer/Manager conversion
- promotions, discount stacking, and automatic commercial offers
- payment collection or QuickBooks mutations
- Canix writes, inventory adjustments, or draft reservations
- representative-held Owner approval or automatic approval escalation
- multi-location cart splitting
- unapproved Store document/media classes or Store-originated publication
- package-level/internal inventory detail and quantities for Manager/Budtender/kiosk
- public COA/recall publication, customer Store API, or AI buying assistant
- new Monday boards, automations, write paths, or dependencies

## Portal Build release rule

Planning packages may be refined, estimated, and dependency-mapped. No implementation package may be marked ready until its mandatory policy and source inputs are accepted. No readiness criterion may be marked passed without execution evidence. Record gates A through G, all applicable SW-AC-01 through SW-AC-21 evidence, Brand/Internal regression, rollback rehearsal, and the exact accepted demo/gated deployment scope under the existing conditional owner instruction. A later broad live-retailer activation requires its named real-cohort decision; synthetic evidence cannot qualify real licenses/accounts or authorize real orders.
