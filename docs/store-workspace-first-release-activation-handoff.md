# Store Workspace first-release activation handoff

Decision date: 14 October 2026

Decision owner: Owner

Planning status: **Approved for activation planning**

Release status: **Owner conditionally authorized accepted demo/gated deployment after checks; acceptance pending and broad live-retailer rollout not accepted**

Architecture input: `docs/store-workspace-activation-architecture.md`

Architecture reconciliation, 14 October 2026: [reconciled Store workstream dispositions](store-workspace-activation-architecture.md#reconciled-store-workstream-dispositions) govern differences with Store Roles Portal. Store Manager is excluded from the first pilot; new document classes, undefined exports, and broader administration remain gated. Source-mode decisions and execution evidence remain with their assigned owners.

## 1. Outcome and completion rule

This handoff is the build contract for the first Store Workspace release. The initial activation decision reopened planning. The subsequent 14 October owner instruction authorizes Portal Build to complete dependencies and deploy accepted demo/gated scope after checks; it does not waive Release Readiness, establish passed acceptance, or approve a broad live-retailer rollout.

Owner corrections and implementation evidence are linked in [Store activation dependency review](store-workspace-dependency-review-2026-10-14.md) and the architecture's [owner-decision correction](store-workspace-activation-architecture.md#owner-decision-correction). The approved limit is 25 stores; Owner and Buyer may see exact approved sellable-item quantities; Finance reviews terms/credit before enabling ordering and clears past-due holds. The demo is urbanXtracts Store with Demo Store #1 and Demo Store #2. SW-AC-19 through SW-AC-21 supplement the original 18 acceptance criteria; none is passed by this document.

Later owner replies on 14 October set a five-minute maximum age for the successful Canix inventory snapshot at live submit and restrict initial demo access to Internal Administrators. The demo requires no external Store invitations; its synthetic evidence cannot qualify real licenses/accounts.

The Store Onboarding Portal workstream is the replacement source for the Store Workspace Portal input because the earlier task ended with a system error. Preserve any usable earlier evidence, but use this handoff as the Store onboarding/workspace input for reconciliation. This replacement changes workstream continuity only; it does not broaden scope or authority.

Portal Build may estimate and decompose the work from this handoff. Final implementation tasks that change shared identity, roles, data contracts, pricing, ordering, or integrations require OS Portal Arch to reconcile this handoff with the Store Roles input and close or explicitly disposition the conflicts in section 12.

The first release is complete only when:

1. every required acceptance criterion in section 10 passes with evidence;
2. all shared-service dependencies in section 8 are accepted for the Store scope;
3. the controlled pilot in section 11 passes without an open severity-one or severity-two issue;
4. rollback is rehearsed and the release can be disabled without deleting accepted records;
5. Release Readiness records contain named owners, evidence, source references, and completion checks; and
6. the release record identifies the accepted demo/gated scope, passed checks, and existing conditional owner deployment instruction. Broad live-retailer activation additionally requires a named real cohort and its activation decision.

Until then, use the label **Activation planning approved — expanded release not yet approved**.

## 2. Non-negotiable authority and access boundaries

Canix remains authoritative for cannabis inventory and compliance. QuickBooks remains authoritative for accounting. UX OS owns the portal workflow and permission layer without replacing either source system.

| Boundary | Build contract | Failure behavior |
| --- | --- | --- |
| Canix | Authoritative for cannabis items, facilities, packages, physical availability, quantities, compliance, lab/testing, holds, release states, and production facts. UX OS may project those facts but may not invent, override, or mutate them. | Unknown, ambiguous, stale, unreleased, or noncompliant inventory blocks the affected catalog/order action. Do not show zero as a substitute. |
| QuickBooks | Authoritative for accounting customers, invoices, payments, balances, receivables, and GL facts. First release is read-only. | Unverified or shared accounting scope withholds affected financial rows. Do not split or infer balances. No accounting write follows a portal approval. |
| UX OS / Supabase | Authoritative for portal identity, memberships, retailer/location scope, portal orders, workflow state, comments, evidence, notifications, source-labelled projections, audit, and readiness evidence. | Deny the request server-side and record a safe audit event. Navigation hiding is never the authorization boundary. |
| Monday.com | Existing history and already approved transition handoffs are preserved. This decision creates no new active Monday dependency, board, automation, or write path. | New Store work stays portal-native or disabled. Any proposed source-mode change or expansion of an existing bridge requires approval and OS Portal Arch disposition. |
| Workspace access | Store membership grants Store access only. It never implies Internal, Brand, Administrator, another retailer, or another location. | Deny by default. A person with multiple workspaces must hold a separate explicit membership and select an authorized context. |
| Commercial visibility | Catalog rows, prices, order eligibility, exports, and financial fields require explicit action and field permissions within retailer and location scope. | Withhold the field or action; do not broaden access to make the screen complete. |

## 3. First-release capability slices

| Slice | Required first-release behavior | Source and label | Permission and safe failure |
| --- | --- | --- | --- |
| Store dashboard | Show scoped open orders, customer-facing status, account/license alerts, permitted receivables summary, frequently reordered products, announcements, and actionable requests. Every connected card shows source and as-of/last-successful time. | UX OS workflow/order facts; Canix availability; QuickBooks financial projection; Portal announcements. | Compose cards only after each service authorizes the selected retailer/location. One unavailable service degrades its card, not the tenancy boundary. |
| Catalog and availability | Show only published, orderable products for the selected location. Label product content source and inventory source. Store Owner and Buyer may see the approved current sellable-item quantity within their authorized location scope. Budtender and kiosk receive no commercial quantity. Package tags, ownership, cost, bulk/material inventory, reservations, compliance-only fields, and unrelated facilities remain withheld. Show current case/minimum/increment rules and approved product documents. | Marketplace/product publication plus exact Canix item mapping; Canix release/availability/compliance and approved quantity projection. | Requires `catalog.read`; price requires `pricing.read`; exact sellable quantity requires `inventory.quantity.read`. Ambiguous mapping, stale full-shop publication, stale/failed Canix data, compliance hold, or missing unit/case policy makes the line non-orderable with a reason and withholds current quantity. |
| Pricing | Apply one reconciled precedence contract. Planning baseline: approved Store-specific override, then valid Marketplace default. Recheck and snapshot price at submission. | Approved portal pricing record and published Marketplace default, with source/as-of label. | Requires `pricing.read`; no price guessing, promotion stacking, or older wholesale fallback. Missing/expired/conflicting price blocks ordering. |
| Order creation | Create a draft for exactly one licensed delivery location, add only currently eligible lines, show case/minimum/increment rules, submit idempotently, and route Owner approval when policy requires it. Drafts reserve nothing. | UX OS owns draft, accepted order, line snapshots, approval, evidence, and idempotency. Canix is rechecked for eligibility/availability. | Requires `orders.create` for the selected location. Submit rechecks membership, license, price, unit/case, availability, and approval policy. A retry cannot duplicate an order or commitment. |
| Order status and receiving | Expose customer-safe states `Ordered`, `Approved`, `Processed`, and `Delivered`, plus permitted exception/receiving evidence. Internal-only notes and operational states stay hidden. | UX OS order events and customer-safe projection; any existing approved operational handoff remains source-labelled. | Requires `orders.read`; receiving requires `orders.receive`. Store evidence never mutates Canix inventory or creates a QuickBooks credit. |
| Retailer organizations | Treat one retailer organization as the tenant. Maintain verified legal/DBA identity, accounting mapping, permitted users, delivery/commercial readiness, and organization-level alerts. | UX OS qualification and membership; verified QuickBooks customer relationship. | Requires membership in that retailer plus action permission. Names, email domains, Brand relationships, or QuickBooks parent links do not grant tenancy. |
| Licensed locations | Treat each licensed store as a child authorization and order/delivery scope. Maintain license number, jurisdiction, status/expiry, address, contacts, hours, delivery requirements, and explicit user assignments. | UX OS verified location record and license evidence; compliance facts remain source-labelled. | Missing, expired, ambiguous, or unreviewed license blocks location ordering. First pilot uses one location per submitted order. |
| Documents and licenses | Upload approved Store document classes to private storage; quarantine, scan, version, classify, review, scope downloads, retain, archive, and audit. Show license expiry and review state. | UX OS document/evidence service; malware scanner; named reviewer. | Requires class-specific upload/read/download permission. No new class releases without approved owner, retention, export, and scanner controls. Scan failure or unknown result blocks release/download. |
| Financial visibility | Show only Finance-approved read-only invoices, credits, balances, aging/payment history, and statement references for verified accounting scope. Label QuickBooks and last-successful refresh. | QuickBooks read-only projection through approved mapping. | Requires `financials.read` and approved field/export permission. Shared parent/customer totals that include an unauthorized location are withheld, never allocated by inference. No payment collection or QuickBooks write. |
| Requests and support | Let Store users open scoped operational, order, account, document, and portal-support requests. Preserve assignee, public status, due state, and source. | Shared UX OS workflow service. | Request type and related record are authorized server-side. Internal triage, restricted fields, and other tenants are never projected. |
| Comments and evidence | Provide customer-visible comments and evidence on permitted requests/orders. Keep internal comments, quarantined files, and restricted evidence separate. | Shared UX OS comments/evidence/audit services. | Every read/write/download checks retailer, location, related-record access, visibility class, and action permission. |
| Notifications | Send only approved transactional notifications to authorized scoped recipients; deduplicate and retain delivery/suppression evidence. | Shared notification outbox and approved templates. | Recipient scope is resolved at send time. Cross-tenant, disabled, expired, or suppressed recipients are excluded; no sensitive payload is placed in subject lines. |
| Announcements | Show active, approved announcements targeted to the Store workspace, retailer, role, or location. Support acknowledgement when required. | UX OS announcements/workflow service. | Audience targeting is an authorization filter, not a display hint. Store announcements cannot expose Internal/Brand content or another tenant. |

Out of the first release: payment collection, any Canix or QuickBooks write, package-level/internal inventory detail, quantities for Manager/Budtender/kiosk, promotions/stacking, representative-held Owner approval, public COA/recall publishing, customer Store API, AI buying assistant, cross-workspace search, and any new Monday automation or dependency.

### Store application and approval workflow

The first release reuses the six-section Brand onboarding interaction pattern without sharing Brand records, memberships, approvals, or permissions.

| Stage | Applicant or Store action | Internal action and evidence | Exit condition |
| --- | --- | --- | --- |
| 1. Company profile | Provide legal name, DBA, entity/contact details, and requested retailer relationship. | Operations verifies the organization identity and checks for an existing retailer tenant or duplicate request. | One verified or pending retailer organization ID; ambiguity enters reconciliation. |
| 2. Stores and licenses | Add each requested licensed location, license number/jurisdiction/expiry, address, hours, and location contacts. | Operations and Quality review license evidence, location identity, status, expiry, and duplicate/multi-license relationships. | Every pilot location has an immutable ID and approved license evidence; unapproved locations remain non-orderable. |
| 3. Contacts and access | Name the Store Owner and proposed Buyer, Store Manager, and Budtender users with location assignments. | IT/Identity verifies email ownership, duplicate identities, explicit Store membership, role, locations, expiry where applicable, and separation from any Internal/Brand membership. | Store membership plan matches section 4 and grants no implied workspace or cross-location access. |
| 4. Delivery and commercial | Supply delivery instructions, ordering contacts, preferred windows, and requested commercial terms. | Operations/Sales verify delivery readiness and case/minimum/increment policy; Finance records the accounting relationship, payment terms and credit-limit decision, reviewer, time, evidence, and any due-date-based past-due hold or clearance. | Finance review is complete before ordering is enabled. A past-due account remains held until Finance records clearance; a nonzero balance alone is not past due. Unknown or stale mandatory eligibility remains visibly blocked. |
| 5. Documents and terms | Upload only approved license, agreement, tax, insurance, or other released Store document classes and attest to current terms. | Scanner quarantines and scans; class owners review version, visibility, expiry, retention, and acceptance evidence. | Required approved classes are clean and accepted; unknown/failed scan or unapproved class cannot qualify the location. |
| 6. Review and submit | Review the scoped organization, locations, users, terms, and documents; correct validation errors; submit once. | UX OS creates one idempotent application and routes independent Operations, Quality, Finance, and IT decisions. Requester cannot satisfy a controlled approval. | Application is `submitted` with immutable source/evidence references and no duplicate downstream request. |
| 7. Qualification decision | Respond to customer-visible requests for changes. | Authorized reviewers approve, return, or deny their own control area with reason, evidence, timestamp, and audit event. Internal notes remain internal. | All required control areas are approved, or the application remains changes-requested/denied with safe customer status. |
| 8. Workspace preparation | No access is implied by application approval. Named pilot users accept invitations only after the pilot cohort is approved. | IT creates scoped memberships/location assignments; Operations loads only approved catalog/order settings; Finance enables only approved read-only fields. | Workspace is `pilot_ready`, not live, and still waits for Release Readiness and the separate activation decision. |

The customer-visible application states are `Draft`, `Submitted`, `Changes requested`, `Under review`, `Qualified`, and `Not approved`. Internal sub-decisions retain their owning control area and must not expose restricted notes. `Qualified` means the application evidence is accepted; it is not a release or ordering entitlement. Workspace membership, catalog publication, order eligibility, financial visibility, pilot inclusion, and production activation remain independent gates.

Applications created by authorized Internal staff use the same validation, evidence, approval, tenancy, and audit path as externally submitted applications. Internal initiation cannot bypass applicant confirmation, license/document review, Finance scope, role assignment, Release Readiness, or the separate activation decision.

## 4. Role and permission baseline

The Store Roles workstream must finalize action names, but it may not broaden these boundaries. `Allow` means only within the user's explicit retailer/location scope and after server authorization.

| Capability | Store Owner | Buyer | Store Manager | Budtender | Public kiosk |
| --- | --- | --- | --- | --- | --- |
| Dashboard and account alerts | Allow, all assigned organization locations | Allow, assigned locations | Allow, assigned locations | Education/announcement subset only | Published education only |
| Catalog/product education | Allow | Allow | Allow | Allow approved education | Allow published education |
| Wholesale price | Allow | Allow | Deny | Deny | Deny |
| Sellable-item quantity | Allow for authorized organization locations | Allow for assigned locations | Deny while Manager is deferred | Deny | Deny |
| Create/submit order | Allow | Allow | Deny | Deny | Deny |
| Approve order | Allow under approved policy | Deny: cannot approve self or another Buyer's order | Deny | Deny | Deny |
| Order status/receiving | Allow | Allow for assigned locations | Allow receiving/status for assigned locations | Deny | Deny |
| Financial statements | Allow for verified organization scope | Allow only if Finance and Store Roles approve assigned accounting scope | Deny | Deny | Deny |
| Documents/licenses | Read/download approved classes; upload/request where granted | Scoped read/upload where granted | Scoped operational read/upload where granted | Approved education resources only | Published education only |
| Requests/comments/evidence/support | Allow | Allow | Allow | Allow support and approved education requests | Support/contact link only |
| Manage Store users/settings | Bounded allow; no Internal/Brand/Admin grants and no legal/accounting/release override | Deny | Deny | Deny | Deny |
| Export | Explicit permission only | Explicit scoped permission only | Deny by default | Deny | Deny |

Store Manager is proposed as a separate operational role in this matrix. Architecture disposition of `OSPA-01` excludes its activation from the first pilot while Store Roles and Sales/Operations resolve its conflict with the earlier `Buyer / Manager` baseline. Every Manager allow in the matrix is candidate future scope, not a pilot permission grant; do not convert existing Buyers automatically.

No Store role may grant itself a wider role, change tenancy/accounting mappings, publish products/prices, override compliance/credit/readiness gates, view Internal/Brand records, or access another retailer/location.

## 5. Strict tenancy contract

For every protected read, write, transition, file, export, notification, and subscription, authorize this tuple server-side:

`identity + active membership + workspace=Store + retailer_organization_id + licensed_location_ids + role + action + field/export class + record sensitivity + membership expiry`

Implementation rules:

1. Retailer organization is the tenant; licensed location is the child scope. Both use immutable IDs.
2. RLS and service/end-point checks must agree. Service-role access never replaces caller-scope filtering.
3. Client-provided retailer, location, role, price, eligibility, or financial scope is untrusted and re-derived server-side.
4. Email/domain, display name, URL, QuickBooks parent/child relation, Monday assignment, Brand relationship, prior browser state, and navigation visibility never confer access.
5. Cache keys, drafts, subscriptions, file links, exports, and background requests include membership/organization/location context. Switching context clears old state and ignores late responses.
6. Multi-membership identities receive no union of scopes. Store, Brand, and Internal memberships are evaluated independently.
7. Deactivating a Store membership revokes Store access only. Global suspension requires separate authority and must not be triggered by a retailer Owner.
8. Ambiguous retailer/location/account mappings fail closed and enter a reconciliation queue.
9. A QuickBooks customer or parent spanning an unauthorized location causes the affected financial projection to be withheld.
10. Tenant-negative tests use at least two retailer organizations, multiple locations, a Brand, limited Internal users, a deactivated user, and a multi-membership identity.

## 6. Source labels, freshness, and ordering gates

| Data/action | Label required | Release gate | Unavailable/stale behavior |
| --- | --- | --- | --- |
| Product identity/content | Marketplace/product publication plus mapped Canix item | Exact approved identity and current publication | Hide or mark non-orderable; no fuzzy runtime substitution |
| Availability/compliance | Canix and last successful refresh | Eligible facility/item/package/release/compliance state and successful inventory snapshot no older than five minutes at live submit | Withhold current availability and block before live order/commitment creation when missing, future-dated, failed, or older; preserve draft and labelled informational snapshot |
| Price | Store override or Marketplace default and effective/as-of time | One valid price under approved precedence | Withhold price and block order action |
| Order state | UX OS and event time; approved bridge source if applicable | Valid append-only transition and authorized actor | Show last accepted state and source exception; never invent progression |
| License | UX OS verified document/state and review/expiry time | Active reviewed license for selected delivery location | Block ordering for the location and alert authorized users |
| Financial facts | QuickBooks and last successful refresh | Verified retailer/location accounting scope and Finance-approved fields | Show unavailable/stale state or last-successful snapshot only where policy permits; never replace with zero |

The documented seven-day full-shop publication expiry is independent of the owner-approved five-minute successful Canix inventory cutoff at live submit. Test exactly five minutes and just beyond it, along with missing/invalid/future timestamps and snapshot failures. Pricing and financial freshness policies still need their assigned acceptance. A warning threshold never overrides a blocking eligibility, compliance, or isolation failure.

## 7. Order lifecycle contract

1. Draft: portal-owned, one licensed location, no inventory reservation.
2. Validate: re-resolve membership/location, license, product identity, publication, price, case/minimum/increment, Canix eligibility/availability, account readiness, and approval policy.
3. Accept: create order, lines, immutable source/price/policy snapshot, event, and any commitment atomically under a stable idempotency key.
4. Approve: Owner approval when the approved threshold/policy requires it; requester cannot satisfy a controlled approval unless the final policy explicitly permits it.
5. Process: authorized Internal operations progress the order; Store users receive customer-safe status only.
6. Deliver/receive: record permitted delivery and receiving/claim evidence without creating Canix adjustments or QuickBooks credits.
7. Reorder: start a new draft and revalidate current price, eligibility, availability, license, and permissions. Never replay historical terms silently.

DEP-07 reports Store orders already use `portal` mode; accepted portal-native orders must not be sent to a new or revived Monday bridge. Preserve historical IDs and records. Onboarding remains `hold` until its approved portal-native path is accepted, with server-side hold enforcement. Any separately approved historical handoff retains stable IDs, idempotency, source labels, and reconciliation; it cannot be extended to new Store workflows. See the reconciled `OSPA-02` disposition.

## 8. Shared-service dependency checklist

| Dependency | Reuse requirement | Evidence before pilot | Failure mode |
| --- | --- | --- | --- |
| Identity/membership | Separate Store membership and active context; scoped revocation | Multi-membership, context-switch, expiry, and deactivation tests | Deny Store request without revoking unrelated memberships |
| Permission/RLS | Action, tenant, location, field, export, sensitivity checks | Endpoint/RLS matrix and cross-tenant negative suite | Deny and safe-audit |
| Workflow | Portal-owned requests/tasks/approvals/status/comments | State transition, self-approval, visibility, retry tests | Keep last accepted state; queue exception |
| Documents/evidence | Private, scanned, versioned, classified, scoped, retained | Class policy, clean/quarantine test, download/export denial | Quarantine/withhold |
| Notifications/announcements | Scoped templates/audiences, dedupe, suppression, delivery evidence | Cross-tenant recipient test and quota/failed-delivery path | Suppress or retry without duplicate |
| Reporting/exports | Source/as-of labels, unknown stays unknown, field redaction, export audit | Role/location/field/export test matrix | Withhold report/export |
| Audit | Append-only identity/context/action/record/result/source evidence | Tamper/coverage checks for sensitive paths | Block controlled action if required audit cannot be written |
| Connector health/readiness | Canix, QuickBooks, scanner, notification, and any approved order bridge health | Last-success evidence, stale/failure drills, named owner | Degrade or block affected capability only; never broaden access |

## 9. Ordered build plan

### Gate 0 — architecture reconciliation

- OS Portal Arch records an owner and disposition for every conflict in section 12.
- Store Roles publishes the exact pilot role/action matrix. Candidate Store Manager activation stays excluded while its distinct-role decision and compatibility plan are deferred.
- Systems Integrations publishes the selected source mode for every existing Store/Monday path.
- Finance approves financial fields, accounting scope, and stale-snapshot behavior.
- Operations, Quality, and Sales approve catalog, price, availability, license, case/minimum, and order-approval policies.

Exit check: no unresolved conflict can change tenancy, authority, price precedence, order eligibility, or financial visibility. Unresolved optional scope is removed or fails closed.

### Gate 1 — tenant and role foundation

- Add/verify retailer organization, licensed location, membership, role/action, field/export, and context models through additive migrations.
- Replace unsafe global-profile assumptions with membership-scoped decisions while preserving compatibility mappings.
- Enforce RLS/service checks and build the negative tenant suite.

Exit check: two-retailer cross-scope tests pass for records, files, exports, notifications, subscriptions, deep links, cached state, and direct APIs.

### Gate 2 — organization, location, license, and document readiness

- Build verified organization/location/account mappings and exception queues.
- Implement approved document/license classes with scanner, review, expiry, archive, and audit controls.

Exit check: an authorized user sees only assigned locations; ambiguous accounting or expired/unreviewed license blocks the affected action.

### Gate 3 — catalog, price, and order eligibility

- Implement the reconciled Marketplace/Canix identity contract, source labels, Owner/Buyer scoped sellable-item quantities, price precedence, case/minimum/increment display, freshness, and fail-closed reasons.
- Implement idempotent one-location order submission and Owner approval routing.

Exit check: order acceptance survives retry without duplication and rejects stale, conflicting, unauthorized, unlicensed, noncompliant, or mispriced submissions.

### Gate 4 — status, financials, and shared interactions

- Implement customer-safe status/receiving, dashboard composition, approved QuickBooks projections, requests, public comments/evidence, notifications, announcements, and support.
- Verify Internal notes and restricted records do not enter Store projections.

Exit check: role matrix and field/export rules pass for every surface; source failure affects only the governed slice and is visibly labelled.

### Gate 5 — pilot, readiness, and release decision

- Run section 10 acceptance and section 11 pilot/rollback rehearsal.
- Attach evidence to Release Readiness and close or accept every pilot exception.
- Record passed checks, exact accepted demo/gated deployment scope, and the existing conditional owner instruction. Obtain the named real-cohort decision before broader live-retailer activation.

Exit check: only the recorded decision may change the capability claim from activation planning to a released state.

## 10. Acceptance criteria

| ID | Given / When / Then |
| --- | --- |
| SW-AC-01 | Given a Store-only identity, when it attempts an Internal or Brand route/API/file/export, then the server denies it and no protected metadata is returned. |
| SW-AC-02 | Given retailer A, when a user for A supplies retailer B or B's location/record/file ID, then every read/write/subscription/export/notification path denies it and writes safe audit evidence. |
| SW-AC-03 | Given one user with explicit Store and Brand memberships, when the context changes, then roles, queries, drafts, subscriptions, cached data, files, and late responses remain isolated. |
| SW-AC-04 | Given Owner, Buyer, Budtender, and approved kiosk contexts, when each Store surface/action is exercised, then results match the reconciled role boundaries; candidate Manager assignment/activation is denied in the first pilot. Hidden controls alone are not counted as a pass. |
| SW-AC-05 | Given a catalog row and verified snapshot, when displayed or requested directly, then product/content, price, and inventory show the correct source/as-of state; Owner and Buyer receive exact approved sellable-item quantities with unit and released/preorder meaning within their authorized catalog/location scope. Manager remains disabled; Budtender/kiosk and forged other-tenant/unassigned-location contexts receive no quantity. Unknown/stale quantities are not current availability or zero. Package/internal fields and unapproved quantity exports remain denied. |
| SW-AC-06 | Given missing/ambiguous/stale publication, Canix eligibility/quantity, unit/case policy, license, price, Finance review, or required past-due clearance, when ordering is attempted, then block the affected line/order with a source-specific reason. For live inventory, test five minutes exactly, just over five minutes, missing/invalid/future timestamps, and failed snapshots; beyond the cutoff no order/commitment is created and the draft remains. Publication freshness alone cannot pass the inventory gate. A nonzero balance alone is not past due. |
| SW-AC-07 | Given an authorized valid cart, when submit is retried or the network response is lost, then exactly one accepted order/commitment and one durable event chain exist. |
| SW-AC-08 | Given a price, availability, permission, or license change between draft and submit, when validation runs, then the order is stopped or explicitly re-confirmed under the approved policy; the old value is not silently accepted. |
| SW-AC-09 | Given a Store order, when statuses/comments/evidence are read, then Store users see only customer-safe states/content and Internal notes/restricted evidence stay hidden. |
| SW-AC-10 | Given an unreviewed/expired license or quarantined/failed-scan document, when ordering/download is attempted, then the governed action is denied and an authorized remediation alert is shown. |
| SW-AC-11 | Given a QuickBooks customer spanning an unassigned location or another tenant, when financials are requested, then the affected rows/totals are withheld and no allocation is guessed. |
| SW-AC-12 | Given an allowed QuickBooks projection, when it is shown/exported, then it is read-only, source/as-of labelled, field-redacted by permission, and the export is audited. |
| SW-AC-13 | Given a request/comment/evidence/notification/announcement/support event, when delivered, then record and recipient scopes remain inside the authorized retailer/location/audience and retries do not duplicate delivery. |
| SW-AC-14 | Given Canix, QuickBooks, scanner, notification, or approved bridge failure, when the workspace loads, then the affected capability degrades or blocks according to section 8 while unrelated authorized data remains available. |
| SW-AC-15 | Given a deactivated/expired Store membership, when any active session, link, subscription, download, or direct API is used, then Store access is denied without revoking an independent Internal/Brand membership. |
| SW-AC-16 | Given a historical Monday record, when it is referenced, then history and source identity remain intact; no new board/write/automation is created without separate approval. |
| SW-AC-17 | Given a pilot release, when the rollback trigger is activated, then new Store entry/order/financial actions stop server-side, accepted records/evidence remain available to authorized reconciliation staff, and Brand/Internal critical paths continue. |
| SW-AC-18 | Given the owner's conditional instruction to deploy after dependencies/checks, when Release Readiness or scope-specific acceptance/rollback evidence is incomplete, then no deployment is claimed accepted. After checks pass, record the accepted demo/gated deployment scope under that instruction. Broad live-retailer activation still requires a named real cohort and its decision; synthetic demo evidence cannot satisfy real license/account readiness. |
| SW-AC-19 | Given a retailer with non-closed locations, when locations 1 through 25 are added under authorized scope, then the approved limit is accepted; a 26th create, move, or reopen is rejected server-side. From 24 locations, two concurrent additions admit at most one. At 25, editing an existing location succeeds. Database, API, UI, onboarding request size/numbering, total account limit, and historical retention agree. |
| SW-AC-20 | Given a real retailer requiring Finance review, when terms/credit approval is absent, source evidence is unknown/stale, or verified invoices establish past due, then submission is blocked. A current non-past-due nonzero balance alone does not block. Finance approval/hold/clearance requires scoped authority and audited evidence; payment refresh never silently clears an existing hold. Clearance applies to its recorded assessment, later past-due evidence is reassessed, and Buyer hold messaging reveals no unassigned-store financials. |
| SW-AC-21 | Given urbanXtracts Store with Demo Store #1 and Demo Store #2, when active Internal Administrators with explicit demo authority browse, submit/retry, approve, receive, and view synthetic financials/quantities, then fixtures are labelled synthetic and remain in the demo context. Initial entry is denied to non-Administrator staff, ordinary Store/Brand users, and anonymous/forged requests. No live commitments, real license qualification, live accounting mapping, Canix/QuickBooks/Monday writes, outbound email, or external user invitation occurs. A forged demo flag cannot bypass real gates; existing Brand/Internal memberships remain usable, and the demo can be disabled without deleting records. |

## 11. Pilot, rollout, and rollback gates

### Isolated synthetic demonstration and controlled pilot

- First demonstrate with the owner-selected synthetic retailer **urbanXtracts Store** and **Demo Store #1** / **Demo Store #2**. Keep synthetic identities and records isolated, ordering disabled until the demonstration gate is intentionally opened, and all Canix, QuickBooks, Monday, and outbound email effects suppressed.
- Initial demonstration entry is Internal Administrators only with explicit demo authority; no external Store invitation or implied live Store membership. Later real-role/cohort activation needs its own accepted access scope.
- Treat synthetic demonstration evidence as UI/workflow/isolation evidence only. It cannot prove real licenses, accounting mappings, inventory authority, production ordering, or live-retailer acceptance.
- A later controlled live-retailer pilot requires one named real retailer organization with one or two verified licensed locations.
- For the later live-retailer pilot, name Store Owner, Buyer, and Budtender users; Store Manager remains disabled. A kiosk capability is included only if its education content is approved.
- A limited, explicitly listed catalog with verified Marketplace/Canix mappings, price source, case policy, and current compliance/availability evidence.
- Read-only QuickBooks visibility limited to pre-approved fields and verified customer/location mappings.
- Named IT release owner and support contact; Operations, Quality, Finance, and Sales acceptance owners.
- A defined monitoring window and daily review of scope denials, license/source freshness, price mismatches, duplicate/idempotency events, failed transitions, outbox backlog, scan failures, and notification delivery.
- Synthetic demonstration records remain clearly identified and are never described as licensed stores, live financials, or general availability.

### Rollout gates

1. Gate 0 conflicts that affect authority or release scope are closed or the affected feature is removed.
2. All `SW-AC` criteria pass and evidence is attached to Release Readiness.
3. No open severity-one or severity-two security, tenancy, pricing, ordering, compliance, or financial defect exists.
4. Connector freshness/failure drills and document scanner paths pass.
5. Pilot owner, support/runbook, alert ownership, business hours, and escalation contacts are recorded.
6. Rollback is rehearsed on the release candidate; accepted orders and evidence remain recoverable.
7. Brand and Internal critical-path regression suites pass.
8. The release record names scope, time, limits, checks, and the existing conditional owner instruction for the accepted demo/gated deployment. A later broad live-retailer rollout requires its named real cohort and activation decision.

Expand one retailer cohort at a time. Each cohort repeats mapping, role, license, accounting, catalog, acceptance, and rollback evidence. Do not treat a successful pilot as blanket authorization for every retailer or location.

### Rollback triggers

- any cross-retailer, cross-location, Store-to-Brand/Internal, document, export, notification, or financial data leak;
- unauthorized price, catalog, order, approval, user-management, financial, or download action;
- wrong price/eligibility accepted, stale/unknown inventory represented as current, or compliance/license gate bypassed;
- duplicate accepted order, commitment, notification, or existing-bridge item that cannot be reconciled promptly;
- loss of required audit evidence, widespread connector divergence, or inability to determine authoritative state; or
- Store activation materially regresses a Brand or Internal critical path.

### Rollback actions

1. Disable Store activation, order submit, financial projection, or the affected slice server-side using the narrowest safe release control.
2. Stop new outbox claims for the affected operation while preserving queued records and idempotency keys.
3. Preserve accepted orders, source snapshots, comments, evidence, audit history, Monday history, and reconciliation identifiers. Delete nothing.
4. Restore the last compatible application/database version through additive forward repair where required; never rewrite applied migration history.
5. Reconcile each accepted/in-flight order against UX OS, Canix, QuickBooks, and any approved bridge. Do not automatically reverse Canix or QuickBooks.
6. Notify named Internal responders and only affected Store recipients through an approved template; do not expose another tenant.
7. Keep the workspace disabled until the cause, affected records, repair evidence, regression tests, and renewed release approval are recorded.

## 12. Conflicts for OS Portal Arch

These are planning flags, not permission to choose a broad interpretation. Until disposition, use the safe default.

| ID | Conflict | Decision required from OS Portal Arch | Safe default / blocked scope |
| --- | --- | --- | --- |
| OSPA-01 | Existing `Buyer / Manager` role combines purchase authority, while the proposed Store Manager is operational. | Architecture excludes Manager activation from the first pilot; Store Roles and Sales/Operations own a future distinct matrix and compatibility migration. | Manager remains disabled; existing Buyers are not converted automatically. |
| OSPA-02 | DEP-07 reports Store orders already use `portal` mode and onboarding remains `hold`, despite older bridge documentation. | Verify portal-native acceptance, server-side onboarding hold, retained historical IDs, and the approved onboarding cutover. | Do not send portal-mode orders back to Monday or bypass a hold; preserve history and add no dependency. |
| OSPA-03 | “One QuickBooks account for all stores”/parent relationships can conflict with strict location financial isolation. | Verified customer/location mapping and Finance-approved allocation/withholding rules. | Withhold aggregate rows spanning unauthorized locations; no inferred allocation. |
| OSPA-04 | Marketplace publication supplies product/default price while Canix supplies compliance/availability; legacy docs mention other wholesale crosswalks. | One deployed identity, price precedence, freshness, and failure contract. | Exact approved mapping only; Store override then valid Marketplace default; no legacy/fuzzy fallback. |
| OSPA-05 | Store document/license classes and retention/reviewer rules are not fully released. | Approved class list, visibility, reviewer, expiry, retention, export, and scanner policy. | Release only explicitly approved classes; quarantine/withhold all others. |
| OSPA-06 | Owner selected Finance terms/credit review before enabling ordering and a past-due block until Finance clearance. | Implement structured review, scoped authority, due-date/source freshness assessment, explicit hold/clearance evidence, and SW-AC-20. | No review means no ordering; verified past due blocks until Finance clears; unknown/stale evidence cannot clear a hold. Ordinary nonzero balance alone is not past due. |
| OSPA-07 | Owner confirmed Buyers cannot approve another Buyer's order; representative authority and SLA/escalation expansion remain unresolved. | Keep qualifying Buyer-order approval with Owner; record thresholds, authorized actors, and any future escalation policy. | Buyer self/peer approval denied; no representative-held approval or timeout auto-approval. |
| OSPA-08 | Draft inventory reservation semantics are unresolved. | Operations/Canix reservation and concurrency policy. | Drafts reserve nothing; submit rechecks and fails closed on change. |
| OSPA-09 | Announcement/notification audience ownership and quota/escalation may overlap shared services. | Audience owners, event/template matrix, priority, and quota behavior. | Transactional approved templates only; suppress rather than widen recipients. |
| OSPA-10 | Product images and controlled assets have Quality/publication dependencies. | Approved image source, scan/moderation/publication/archive policy. | Show only already approved published assets; no Store upload/publication expansion. |
| OSPA-11 | Multi-license retailer hierarchy and maximum-location behavior require tested mappings. | Organization/location model, owner-approved 25-store cap, merge/split, and historical continuity rules. | Update database, API, UI, and concurrency controls together; ambiguous grouping remains separate and non-orderable. |
| OSPA-12 | Shared identity deactivation currently risks global profile/Auth effects. | Membership-scoped revocation design and global suspension authority. | Store Owner cannot deactivate global identity; use IT-reviewed membership revocation. |

OS Portal Arch dispositions, accountable owners, architecture contract links, and required acceptance evidence are recorded in [Store activation architecture](store-workspace-activation-architecture.md#reconciled-store-workstream-dispositions). Deferred optional capabilities are excluded from pilot; assigned mandatory policy/evidence gates are still open. Neither the table nor its mapping claims tests have passed.

## 13. Build artifact map

Portal Build should begin with an impact map, then create isolated tasks for:

- schema/RLS: retailer organizations, licensed locations, membership/action/field scope, mappings, documents, orders/events, source snapshots, readiness evidence;
- Store UI: dashboard, catalog/availability labels, order creation/status, organization/location account, documents/licenses, approved financials, shared requests/comments/evidence/notifications/announcements/support;
- server services: Store-scoped retailer/account, catalog/pricing, order intake/status, financial projection, document/evidence, workflow, notification, reporting/export, audit, connector health;
- verification: permission/RLS negative tests, source/freshness and fail-closed tests, idempotency/concurrency, files/exports/notifications, pilot walkthroughs, shared Brand/Internal regressions, rollback rehearsal; and
- operations: mapping/reconciliation queue, support/runbook, alert ownership, pilot roster, rollout cohort record, separate release decision.

Reuse the existing shared identity, permissions, workflow, document, notification, reporting, and audit services. A task that proposes a second engine, a broad cross-workspace model, a Canix/QuickBooks mutation, or a new Monday dependency is out of contract and must return to OS Portal Arch.

## 14. Held and deferred items

The following remain held or outside the first release even though activation planning is approved:

| Item | Status | Resume condition |
| --- | --- | --- |
| Demo/gated deployment and broad retailer rollout | Conditional deployment instruction; readiness pending | Complete dependencies, scope-specific acceptance, Release Readiness, and rollback checks for accepted demo/gated scope. Later broad live activation needs a real cohort and its decision |
| Promotions, discounts, stacking, and automatic offers | Held | Sales, Finance, and Operations approve ownership, eligibility, dates, stacking, retirement, and price precedence |
| Payment collection and QuickBooks writes | Out of first release | Separate accounting/security design and explicit Finance approval |
| Canix writes, inventory adjustments, reservations, and compliance decisions | Out of first release | Separate Canix-authority design and Operations/Quality approval; drafts currently reserve nothing |
| Representative-held Owner approval and automatic approval escalation | Held | Legal, Sales, and Store Roles approve authority, duration, revocation, SLA, and evidence |
| Multi-location cart/order splitting | Deferred | Operations and Store Roles approve fulfillment, approval, delivery, and reconciliation behavior; first release uses one location per order |
| New Store document/media classes and Store-originated publication | Held by class | Quality/IT approve scanner, reviewer, visibility, retention, export, moderation, archive, and rollback controls |
| Package-level or internal inventory detail | Excluded | Owner/Buyer may receive approved scoped sellable-item quantities only; internal package, ownership, cost, bulk/material, reservation, and unrelated-facility details remain withheld |
| Public COA/recall publication, customer Store API, and AI buying assistant | Out of scope/held | Separate owner decisions and their own safety, privacy, evaluation, and release contracts |
| New Monday board, automation, write path, or dependency | Not approved | Explicit owner approval plus OS Portal Arch source-mode, reconciliation, idempotency, history, and exit-plan decision |

## 15. Remaining owner decisions

These decisions are still required; activation-planning approval does not answer them.

| Decision | Accountable owner | Required evidence | Safe default until decided |
| --- | --- | --- | --- |
| Demo participants/window and later live-retailer cohort | Owner with IT, Operations, Quality, Finance, and Sales | Demo tenant/locations are chosen; still name authorized users, support/window, suppression tests, and rollback evidence. Later real cohort needs real license/account mappings | Demo remains gated until SW-AC-21 and other applicable dependencies pass; no real cohort is inferred |
| Production rollout cohort and activation time | Owner | Passed Release Readiness, pilot report, rollback rehearsal, open-risk acceptance | Not live |
| Final Store role/action/quantity matrix | Store Roles with Owner/Sales/IT | Endpoint/field matrix, Owner/Buyer quantity tests, deferred Manager compatibility plan | Owner approves qualifying Buyer orders; Buyers cannot approve self or other Buyers; Manager remains disabled |
| QuickBooks financial fields, Buyer visibility, shared-customer handling, and stale snapshot behavior | Finance | Field/export matrix, mapping evidence, cross-location denial tests, freshness policy | Read-only; withhold ambiguous/shared scope |
| Finance review values, authority, and assessment freshness | Finance with Systems Integrations | Policy chosen: Finance review before enablement, past-due block until Finance clearance. Supply actual terms/credit values, reviewer permissions, source freshness, safe messages, and SW-AC-20 evidence | No review/clearance from unknown or stale evidence; no inferred past due from ordinary balance; no invented credit arithmetic |
| Catalog identity, price precedence, case/minimum/increment, and freshness thresholds | Sales, Operations, Quality, Systems Integrations | Exact mapping, source contract, stale/partial/failure tests | Exact mapping; Store override then valid Marketplace default; fail closed |
| License/document class list, reviewers, expiry, retention, and exports | Quality, Operations, IT/Compliance | Approved class policy and scanner/download/export tests | Only already approved classes; quarantine/withhold others |
| Existing Monday order/onboarding bridge source mode and retirement path | Owner with OS Portal Arch and Systems Integrations | Current dependency inventory, stable IDs, reconciliation, duplicate prevention, history/attachment treatment, cutover/rollback plan | Preserve history; do not expand or create a dependency |
| Membership-scoped revocation and last-Owner administration | IT/Identity/Security | Multi-membership, deactivation, recovery, invitation, and audit tests | IT-reviewed membership changes; Store Owner cannot suspend a global identity |
| Draft reservation and multi-location expansion | Operations, Quality, Sales | Concurrency, availability, fulfillment, and reconciliation tests | Drafts reserve nothing; one location per order |
| Announcement/notification owners, audiences, templates, and quota behavior | Shared Workflow Services with business owners | Event/recipient matrix, cross-tenant denial, delivery/suppression evidence | Approved transactional templates only; suppress rather than widen audience |

Every decision is recorded in Release Readiness with the approver, date, accepted carveouts, source reference, and affected acceptance criteria. Any item left undecided is removed from the release or remains fail-closed; it does not inherit approval from this handoff.
