# UX OS Combined Workstream Register

Last reconciled: 10/08/2026

This register consolidates the current recommendations and unresolved items from the UX OS architecture, Internal, Brand, Store, department, role, integration, security, audit, and shared-workflow planning tasks. It separates accepted live foundations from work that still requires implementation or leadership review. Designed intent is not represented as live functionality.

## Current platform baseline

- Supabase / UX OS owns portal workflows, permissions, evidence, documents, notifications, audit history, and workflow state.
- Canix remains authoritative for cannabis inventory and compliance facts.
- QuickBooks remains authoritative for accounting records.
- Google Workspace is the preferred employee identity provider.
- Monday.com history is preserved; new workflows are portal-native unless specifically approved otherwise.
- Server-side authorization, source/freshness labels, append-only decisions, evidence, and audit history are shared controls.

## P0 release completion

| Item | Status | Remaining action |
| --- | --- | --- |
| Browser workflow acceptance | Complete | `REQ-C16914A6E4` passed submission, self-approval denial, second-Administrator approval, completion evidence, notification, and audit-state checks on 10/08/2026. |
| Source-control preservation | Complete | Build and verification passed; the Internal workflow, notification, suppression, identity compatibility, documentation, migration-history, and QuickBooks recovery changes were committed and pushed in `7d1801c`. |
| QuickBooks production verification | Complete | Production realm is authorized. A forced recovery sync succeeded on 10/08/2026 after removing the stale `connection_status` retry deadlock; the snapshot is source-labelled and read-only. |
| Supabase breached-password protection | Plan-gated | The organization remains on Free. Enable immediately after the organization upgrades to Pro; retain the active advisor until then. |

## Shared platform work

| Capability | First-release position | Source tasks |
| --- | --- | --- |
| My Work and request intake | Build shared employee request, assignment, status, and queue services | Internal Workspace; Employee and Viewer; Shared Workflow Services |
| Tasks and approvals | Reusable assignment, review, return, denial, completion, delegation, and escalation | Shared Workflow Services; Department Manager Roles |
| Documents and evidence | Private, scanned, versioned, classified, permissioned, and audited | Security/Audit/Retention; QC; Brand Workspace |
| Notifications | Durable outbox, approved templates, deduplicated recipients, quota control, delivery evidence | Shared Workflow Services; Systems Integrations |
| Calendar | Shared calendar model, but Google Calendar synchronization is held for the first release | Internal Workspace; HR; Marketing |
| Reporting and exports | Source-labelled metrics; permission-checked and logged exports | Executive; Sales; Finance; Security/Audit/Retention |
| Access management | Administrator-managed membership, sensitive tiers, access requests, immediate UX OS deactivation | IT; Identity/Roles/Permissions; Administrator Role |
| Retention and legal hold | Seven-year planning default for audit/Finance/Quality evidence; archive instead of automatic deletion | Security/Audit/Retention; Finance; QC |

## Department first-release backlog

| Department | Recommended first release | Important hold or dependency |
| --- | --- | --- |
| IT/Admin | Help desk, access requests, offboarding, device/application inventory, incidents, changes, reviews, integration health, Release Readiness | Automatic cross-system deactivation, MDM, automated reviews, and portal MFA remain held |
| Finance | Reconciliation, monthly close, AR/AP read views, purchase/AP intake, expense/reimbursement, vendor controls, journal requests, audit evidence | No automatic QuickBooks mutation; Finance owner, budget source, margin, settlement, and payment policy decisions remain |
| Operations | Supply catalog and requests, purchase/receiving, claims, facilities, maintenance, equipment, incidents, checklists, inventory exceptions | Canix remains authoritative; automated reorder, capacity planning, and inventory mutation remain held |
| Marketing | Request intake, creative briefs, calendar, draft/version review, approved asset library, launch readiness, compliance routing | Product-image intake and public publishing require Quality/IT release controls |
| Sales/Commercial | Account assignments, opportunities, follow-ups, pricing/discount requests, order exceptions, samples, renewals, visits, approved reports | Retailer identity to Brands, POS sell-through, automated forecasting, margin, and promotion engine remain held |
| Quality/Compliance | Licenses, controlled documents, training/attestations, suppliers, deviations, CAPA, changes, audits, complaints, inspection evidence, calibration | No automated release decision, direct Canix mutation, public COA, or public recall publishing |
| HR | Roster mirror, PTO routing, policy acknowledgments, training, offboarding coordination | Sensitive case files, PTO calculation, schedules, compensation/medical/accommodation/investigation records remain held |
| Executive | Approved KPI and exception summary, high-risk approvals, legal holds, export oversight | No unrestricted sensitive-record drilldown; metric definitions and source approval required |

## External workspace backlog

### Brand

- Brand Admin, Brand Member, and Brand Viewer with explicit Brand membership.
- Brand-scoped onboarding, contacts, agreements, documents, products, purchase orders, finished-goods inventory, tasks, issues, and approved read-only financial views.
- Keep retailer/store identity, cost, margin, Economic Owner, settlement data, unrestricted package data, and internal notes hidden.
- Internal approval remains required for onboarding, documents, order processing, access activation, finance access, and exceptions.

### Store

- Store expansion remains held until the Brand and Internal foundations are accepted.
- Preserve the approved future boundaries: Owner across assigned organization stores; Buyer by assigned store; Budtender limited to one store; kiosk as a revocable education-only public capability.
- No Store or kiosk user may mutate Canix or QuickBooks or access internal package, financial-control, role-administration, or compliance data.

## Integration backlog

| Integration | Current boundary | Remaining work |
| --- | --- | --- |
| Canix | Inventory/compliance authority | Owner-field coverage, near-real-time freshness acceptance, Lot/Cost Object policy, lineage inputs, and exception resolution |
| QuickBooks | Accounting authority; portal read/workflow/evidence only | Production authorization and scheduled refresh are working. Complete reconciliation views, remaining identity mapping, freshness/fallback acceptance, and controlled reconnect-role evidence. |
| Google Workspace | Employee SSO | Named approver first sign-in, group/role administration decisions, and later Calendar synchronization |
| Monday.com | Historical records retained and copied into UX OS where approved | Use `docs/monday-compatible-workspaces-migration-plan.md` as the migration blueprint. Recreate Monday-compatible boards, records, comments, files, automations, and dashboards inside UX OS by controlled copy/import; remove dependencies from new workflows only after portal replacement acceptance; do not delete historical records from Monday. |
| Resend | Controlled outbound email | Current limits are adequate; upgrade only when measured usage requires it; keep suppression for non-mailbox test identities |
| Malware scanner | Required before accepted private uploads | Keep production health evidence and add each newly approved document class to scan/release policy |

## Flagged for leadership review

These items are not implementation defects; they need an owner or policy decision before the affected capability is released.

1. Name the permanent business owner and backup owner for every department.
2. Confirm department shared inboxes and which events each inbox should receive.
3. Confirm the final Finance role assignments: Requester, Preparer, Reviewer, Controller, Vendor Control Reviewer, Viewer, and Admin.
4. Define what constitutes an approved sales figure: shipment, delivery, invoice, payment, or another event.
5. Approve metric definitions for Executive, Sales, Finance, Operations, Marketing, Quality, and HR dashboards.
6. Decide whether Brand Admins may directly invite/deactivate users or only request internal action.
7. Decide which Brand roles may see QuickBooks-backed financial projections and download documents or reports.
8. Confirm whether retailer/store identity will remain permanently hidden from Brands.
9. Decide the permitted Brand-safe and Store-safe export datasets and formats.
10. Approve the Brand fee, tolling, revenue-share, settlement, and commercial-term calculation model.
11. Name the approved budget source and determine which purchases always require Finance review.
12. Define close blockers versus carried Finance exceptions.
13. Approve vendor setup/change verification and first-payment controls.
14. Approve incident sensitivity tiers and who may access restricted Operations incidents.
15. Approve product-image quarantine, Quality review, moderation, publication, archive, and retention rules.
16. Approve Quality document approvers, training owners, CAPA/change-control authority, and renewal cadences.
17. Confirm the HR/payroll sources for roster, PTO balances, schedules, and retention periods.
18. Approve delegation limits, duration, evidence, and non-delegable authorities.
19. Approve escalation timing, overdue thresholds, and notification recipients by workflow.
20. Confirm the Supabase upgrade timing for breached-password protection.

## Data and policy review queue

- Canix Owner coverage and supported API/reporting property.
- Lot ID and Cost Object assignment rules.
- Wholesale price identity review and immutable Canix Item IDs.
- Finance cost components, coverage threshold, and margin formula.
- Payment terms and credit-limit hard-stop versus exception policy.
- Multi-license retailer organization mapping.
- Draft inventory reservation policy.
- Store document classes and release controls.
- QuickBooks customer/vendor/Brand identity exceptions.
- Brand sales and distribution event definitions.
- Seven-year retention baseline, Brand indefinite retention, HR-specific schedules, legal hold, and eventual disposition evidence.

## Explicit controlled holds

- Store onboarding and Store workspace expansion.
- Google Calendar synchronization for the first release.
- Restricted HR case files and PTO balance calculation.
- Automatic cross-system deactivation, MDM, automated access reviews, and portal MFA.
- Automatic retention deletion.
- QuickBooks write-back, automatic invoices/bills/payments/journals/vendors, and bank/routing storage.
- Payment collection.
- Public COA and recall publishing.
- Store API.
- Department self-administration.
- Product images until release controls are approved.
- Brand fee and settlement schedules.
- Margin reporting.
- Automated forecasting, production planning, and AI-generated regulated or financial decisions.

## Acceptance principles

- Every capability must be labelled Live, In Development, Designed Intent, On Hold, or Out of Scope.
- Missing or stale source data must never be presented as zero.
- Hidden navigation is not authorization.
- Every sensitive read, write, approval, export, role change, and deactivation must be server-authorized and auditable.
- A requester cannot approve their own controlled work.
- A Finance preparer cannot review the same controlled reconciliation.
- Connected-system writes remain manual unless a later approval explicitly authorizes a controlled write-back.
