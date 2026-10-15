# Store staging release candidate — 15 October 2026

## Release state

**Not approved for production deployment.** Production is unchanged. Store access is disabled, Store ordering is held, and the synthetic demonstration remains available only to Internal Administrators.

## Passed staging evidence

Recorded at verified commit `d14683e` on PR #2. Commits after that commit are not covered by this evidence; see [Release head and re-verification](#release-head-and-re-verification).

- 578 release contracts, 138 Node tests and 54 Deno tests pass.
- 24 grouped disposable-database Store scenarios pass.
- Eight real-authentication access groups pass.
- Nine full-schema order, approval, freshness, outage, preorder, claim and direct-access groups pass.
- Six exposure/private-asset groups pass. Private files require server authorization; issued links expire after five minutes.
- Three positive scanner groups pass: a clean Brand PDF is accepted, an EICAR-bearing PDF is rejected with no durable infected record, and the clean evidence is archived.
- Three coordinated rollback groups pass without deleting durable history.
- A real Google Workspace sign-in provisions Viewer access and receives 403 from the Administrator-only Store demo.
- Store access is disabled and Store ordering is held after each remote rehearsal.

## Migration baseline

The [baseline reconciliation artifact](../artifacts/store-demo-release-2026-10-15/migration-baseline-reconciliation.json) compares the repository, production migration history and staging history.

- 138 repository migration files were inventoried.
- 134 production history rows were inventoried.
- 116 match by name and timestamp.
- 17 have the same migration name with a different applied timestamp; each alias is enumerated.
- The single production-only history entry is byte-identical to the repository's passwordless Supply Order migration, so no SQL source is missing.
- Five repository-only entries are the Store activation planning/candidate migrations.

The staging database was intentionally created from a schema-only production baseline and reviewed candidate migrations. Historical migrations must not be replayed against it. Production rollout must use an explicit reviewed candidate list, not an automatic database push.

That candidate list is now recorded as [production-candidate-migrations.json](../artifacts/store-demo-release-2026-10-15/production-candidate-migrations.json), with its apply order, re-run safety and gating in [deployment readiness](deployment-readiness.md#store-release-candidate-migrations--15-october-2026) and the execution sequence in the [deployment runbook](store-release-deployment-runbook-2026-10-15.md). `npm run verify:migration-baseline` fails if the list drifts. The list is drafted for review and carries no approver or date.

## Source and automation boundary

- Canix Shop uses a controlled supervised refresh. No Canix Support request will be sent, and unattended Shop refresh is outside this release plan.
- Canix remains authoritative for physical inventory/compliance and the five-minute order-submission freshness rule remains unchanged.
- QuickBooks remains authoritative and read-only for Store accounting in this scope.
- No notification, Monday, source-write, or production credential is enabled in staging.
- The GitHub workflow builds, verifies committed output, runs release/service tests, verifies the migration baseline, runs Store concurrency tests, and checks patch whitespace. It does not deploy.

## Release head and re-verification

This document deliberately records no current PR head. Writing the head into a committed file goes stale on that same commit. The current head is whatever [pull request #2](https://github.com/Tom-urbanXtracts/UX-Portal/pull/2) shows on branch `codex/three-workspace-restructure`. The exact SHA belongs in the PR #2 review approval and the IT release-acceptance record, not here.

- Commits after `d14683e` are not all documentation. They add the reviewed migration candidate list (`artifacts/store-demo-release-2026-10-15/production-candidate-migrations.json`) and its `verify:migration-baseline` check. They also remove the Store/Brand credit cap from the synthetic Store demo, the QuickBooks financial summary and the portal UI, and add one release contract and one Deno regression for that removal. Focused checks for these changes are not the full staging evidence above.
- Before PR #2 approval, CI and `npm run verify` must pass at the exact head being approved. That head is then the one IT records in release acceptance. A later commit that changes executable code, migrations or `dist` voids the approval for that head.

## Approval checklist

This is the single list of open approvals and inputs. Each row links the detailed record; **the linked record is authoritative** and this list only summarizes it. No production deployment may begin until every row applicable to the release is closed and IT records release acceptance. Store access and Store ordering stay off until their own separate decisions. Synthetic demonstration evidence cannot close any row in section B.

Status labels: **Decided** — recorded owner decision or closed V1 rule. **Proposed/default** — documented baseline or fail-closed safe default that applies until the owner decides; it is not an approval. **Unanswered** — no value is documented; nothing is inferred.

**Demo tester (Decided, 10/14/2026):** the existing synthetic Store demo, reached from the Internal Administrator account, is the only tester for the current demo phase. External retailer pilots and named external Store users are deferred to production-only acceptance ([decision register](deferred-items-decision-brief.md#already-decided--do-not-reopen-as-unanswered)). This grants no new access, users, data, notifications or Store access/ordering.

**Already decided:** Stores and Brands have no credit cap (owner decision, 10/14/2026). This is not an open item.

### A. Internal-only synthetic demo/review and PR packaging

Nothing in this section requires a business value. The named external pilot selection (SW-IN-09) is no longer a demo blocker; see section B.

- [ ] **Tom:** authorize committing and pushing the current uncommitted change set to PR #2. The change set covers the credit-cap removal, the release contract and Deno regression, and these documents.
- [ ] **IT:** CI and `npm run verify` pass at the resulting PR #2 head ([re-verification](#release-head-and-re-verification)).
- [ ] **OS Portal Arch with IT:** coordinated review of [PR #2](https://github.com/Tom-urbanXtracts/UX-Portal/pull/2) ([runbook §1](store-release-deployment-runbook-2026-10-15.md#1-gates-that-must-be-closed-first)).

### B. Production-only or external-pilot decisions

None of these is needed for the Internal-only synthetic demo. All are required before production deployment or any external pilot, as applicable.

**Questions for Tom.** This is the only part of the list that needs his input.

| # | Question | Current status |
| --- | --- | --- |
| T1 | Approve PR #2 for production and record the approved head SHA (with OS Portal Arch and IT). | Unanswered |
| T2 | When production acceptance begins, name the first real retailer, Store locations, Owner/Buyer/Budtender testers and Omeed-side acceptance participants (with Omeed and Operations). | **Deferred** to production-only acceptance (10/14/2026); [SW-IN-09](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026) |
| T3 | Name the pilot users for external Store acceptance (with IT, Operations, Quality, Finance, Sales). | **Deferred** to production-only acceptance (10/14/2026); [runbook §1](store-release-deployment-runbook-2026-10-15.md#1-gates-that-must-be-closed-first) |

**Owned by others.** Each value is extracted from the linked spec.

**Finance** — [SW-IN-04/05](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026), DEP-08, OSPA-06

| Item | Value | Status |
| --- | --- | --- |
| Ordering gate | Superseded 10/15/2026: no financial review gate. Only an explicit, audited manual hold placed by Finance or an Internal portal Administrator blocks ordering for financial reasons. Onboarding, license and other gates remain independent. | Decided (Portal checklist 10/15/2026) |
| Payment terms | Global default Net 30; at most one retailer-account override, inherited by every location; no location override. Finance or an Internal portal Administrator changes terms with reason and evidence. | Decided; implemented locally, not deployed |
| Migrate existing Finance-approved terms as account overrides | Not decided | Decision pending |
| Past-due assessment | Superseded 10/15/2026: overdue invoices and nonzero balances are warning-only and never create, clear or substitute for a hold. | Decided (Portal checklist 10/15/2026) |
| Hold-release / exception authority | Finance or any Internal portal Administrator. Retailer/Store administrators cannot place or release their own hold. | Decided; two-person release review pending |
| Hold evidence | Actor, internal role, retailer account, prior/new state, reason, evidence and timestamp, append-only. Payment or QuickBooks refresh never places or clears a hold. | Decided; implemented locally, not deployed |
| Maximum QuickBooks data age | Stale exactly 24 hours after the last successful sync. Warning only; never displayed as zero and never blocks ordering. | Decided; implemented locally, not deployed |

**Finance with Operations and Compliance; IT implements** — QuickBooks field/export allowlists — [SW-IN-03](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026), DEP-06, OSPA-03, SW-TECH-04

| Item | Value | Status |
| --- | --- | --- |
| Source mode | QuickBooks is read-only and authoritative. No payment collection in UX OS. | Decided |
| Shared customer / parent totals | Withhold rows and totals that span unauthorized stores or retailers. No guessed allocation. | Proposed/default (architecture baseline) |
| Per-Store-role financial and document field visibility | None documented | Unanswered |
| Approved report/statement export allowlist | None documented. Unapproved exports stay unavailable and Store email delivery stays held. | Unanswered; fail-closed default |

**Sales with Operations and Quality** — catalog — [SW-IN-06/07](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026), DEP-04, OSPA-04, OSPA-10

| Item | Value | Status |
| --- | --- | --- |
| Product source | The 120 Marketplace listings in Shop UrbanXtracts, with exact Marketplace-to-Canix identity and no fuzzy fallback. | Decided (source); exact-ID deployment proof outstanding |
| Case quantities | Normalize a positive Canix `case_quantity` when one is supplied. Per-store enforcement defaults off and fails closed when enabled without one unambiguous value. An imported minimum-order quantity is not a case size. | Decided (rule) |
| Per-item case quantities | None documented | Unanswered |
| Minimum orders | A per-store minimum may be set or cleared by Admin/Operations/Sales. Existing stores default to no minimum. | Decided (store-level) |
| Per-item minimums | None documented; not inferred from the imported field. | Unanswered |
| Ordering increments | None documented; not invented. | Unanswered |
| Release / pre-order eligibility | Only exact `TestPassed` package units count as released. A line that exceeds passing units is entirely pre-order. | Decided (rule) |
| Per-item release/pre-order verification | None documented | Unanswered |
| Image placeholders for the 22 listings without images | Show only approved published assets, with honest empty states. Product image uploads stay on hold. | Proposed/default (OSPA-10); approved placeholders unanswered |
| Price precedence | Approved Store-specific price first, then a valid Marketplace default. | Proposed/default (architecture baseline); runbook gate still open |
| Initial Buyer-order approval threshold per Store (with Operations, Admin) | The demo's $500 is illustrative only. | Unanswered |

**Quality with Operations and IT/Compliance** — retailer documents — [SW-IN-02](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026), OSPA-05

| Item | Value | Status |
| --- | --- | --- |
| Always-required vs relationship-dependent document classes | None documented. Only already approved classes are released; all others are quarantined or withheld. | Unanswered; fail-closed default |
| Reviewers | None documented | Unanswered |
| Expiry (and retention, export, archive for any new class) | None documented | Unanswered |

**Shared Workflow Services with business owners** — notifications — DEP-09, OSPA-09 in the [activation architecture](store-workspace-activation-architecture.md)

| Item | Value | Status |
| --- | --- | --- |
| Delivery behavior | Approved transactional templates only. Scope is rechecked at send time, and recipients are suppressed rather than widened. Budtenders receive only approved education/support notices. | Proposed/default (shared-service contract) |
| Store audiences, event/template matrix, priority and quota behavior | None documented. Store email stays held. | Unanswered |

**Operations with IT** — pilot support and rollback — [SW-IN-10](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026)

| Item | Value | Status |
| --- | --- | --- |
| Operational support contact | None named | Unanswered (before external pilot) |
| Person who pauses ordering and coordinates rollback | None named. The rollback procedure is rehearsed in staging. | Unanswered (before external pilot) |

**Operations** — other open inputs (unchanged): the current Monday Dispensary onboarding form and field crosswalk, with Omeed ([SW-IN-01](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026)); missing Owners, Lot records/package links, and Cost Object assignment or evidenced Not Required, with Finance ([SW-IN-08](deferred-items-decision-brief.md#store-activation--remaining-inputs-10142026)).

**IT and OS Portal Arch** — technical release approvals — [runbook §1](store-release-deployment-runbook-2026-10-15.md#1-gates-that-must-be-closed-first), [deployment readiness](deployment-readiness.md#store-release-candidate-migrations--15-october-2026), [technical gates](deferred-items-decision-brief.md#store-technical-release-gates)

| Item | Value | Status |
| --- | --- | --- |
| Candidate migration list approval | `approvedBy`/`approvedAt` are null | Unanswered (IT with OS Portal Arch) |
| CI and `npm run verify` at the approved head | Evidence is anchored to `d14683e` | Open |
| IT release acceptance | Not recorded | Open |
| New-account invitations and recipient policy (SW-TECH-02) | Existing-account tests pass; invitations are held. | Open before invitations |
| Catalog quantity connection (SW-TECH-03) | Quantities show as unknown, not zero. | Open before quantity display |
| Checkout-freshness refresh (SW-TECH-05) | The 15-minute cadence is longer than the 5-minute checkout limit. The checkout limit is not weakened. | Open before sustained ordering |

## Resume handoff

- Pull request [#2](https://github.com/Tom-urbanXtracts/UX-Portal/pull/2) is the release artifact on branch `codex/three-workspace-restructure`. Read its current head from the PR rather than this file. Staging evidence is anchored to verified commit `d14683e`; later commits need the re-verification described in [Release head and re-verification](#release-head-and-re-verification).
- All release checks recorded in this document were complete and green at `d14683e`: local verification, isolated staging, authenticated browser journeys, malware-scanner acceptance, migration reconciliation, concurrency coverage and rollback rehearsal.
- Production is unchanged. Store access remains disabled, Store ordering remains held and notifications remain off.
- The remaining approvals are listed once in the [approval checklist](#approval-checklist), split into Internal-only demo/PR packaging (A) and production-only or external-pilot decisions (B). The Internal Administrator synthetic demo is the only tester for the current demo phase. IT must record release acceptance before any production deployment.

### Bounded future Claude Team review

If an additional review is later authorized, use only the authenticated Claude Team subscription and do not use API credits. The review must remain read-only. Do not transmit source, data or evidence without explicit permission beyond the previously approved scope: `portal-kiosk`, `portal-sku-intake`, `portal-work-queue`, `_shared/request-workspace`, the Store endpoint/scanner/rollback verification scripts and tests named in PR #2, workforce migration `20261015003000_provision_workforce_workspace_membership.sql`, and `docs/store-access-technical-preparation-2026-10-14.md` plus this staging specification. The latest bounded Claude implementation is complete, and no Claude task is currently running.
