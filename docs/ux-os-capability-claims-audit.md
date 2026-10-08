# UX OS capability and claims audit

Updated 8 October 2026 for the Brand-first staged build.

The investor-deck material is product direction, not proof that a workflow is live. This audit is the working source for release language: anything described to an external user must match the status below and keep its source boundary visible in the product.

## Status key

| Status | Meaning | External wording rule |
| --- | --- | --- |
| Live | Implemented behind server-side authorization and covered by release contracts or production evidence | May be described as available for the named role and workspace |
| In development | Built or partially built, but missing acceptance evidence, source approval, or rollout decision | Describe as planned or in review |
| Designed intent | Product direction with no released user path | Describe as future vision only |
| On hold | Deliberately paused by business, compliance, finance, or data-source decision | Do not promise a launch date |
| Out of scope | Removed from UX OS scope | Do not include in portal capability claims |

## Capability matrix

| Capability | Workspace | Status | Production evidence or boundary |
| --- | --- | --- | --- |
| Supabase identity, memberships, roles, and workspace switching | Shared | Live | Portal sign-in uses Supabase authentication. Internal, Brand, and Store contexts are represented as separate memberships; hidden navigation is not relied on for access control. |
| Brand workspace home | Brand | Live | The Brand home presents performance cards, demo-readiness gates, onboarding progress, source exceptions, and action links scoped to the active Brand membership. |
| Brand company onboarding | Brand / Internal | Live | Six-section onboarding supports draft save, section submission, Internal review, assignment, document evidence, and approved workspace creation. |
| Public Brand application | Brand / Internal | Live | Prospective Brands can start or resume an application through private links; Internal Administrators review sections before workspace creation. |
| Brand purchase orders | Brand / Internal | Live | Brand users with order-create permission can build carts, submit purchase orders, and follow Portal-owned review, fulfillment, receipt, exception, and comment history. |
| Brand product and SKU qualification | Brand / Internal | Live | SKU, component, vendor, qualification-document, catalog-link, and Marketplace reconciliation records are organization-scoped and reviewed server-side. |
| Brand document and marketing asset register | Brand / Internal | Live | Private, malware-scanned, versioned documents support Brand/Internal visibility, Internal review, approved downloads, and archive-oriented lifecycle. |
| Brand performance reporting | Brand | Live with limits | Reports use approved Brand-scoped order and fulfillment data. Retailer/store identity is withheld, POS sell-through is not claimed, and dollar visibility stays gated by Finance policy. |
| Brand financial statements | Brand / Finance | In development | QuickBooks remains authoritative. The portal shows mapped, read-only statement projections only after Finance-approved mapping; scheduled refresh and on-page refresh are both allowed. |
| Internal Brand application queue | Internal | Live | Administrators can review submitted Brand application sections and approve the Brand workspace only when all sections are approved. |
| Internal Brand purchase-order command queue | Internal | Live | Administrators review Brand POs, move allowed statuses, and record fulfillment events with line-level evidence. |
| Internal shared work queue | Internal | Live | Portal-owned work items expose status, priority, due date, comments, evidence, source mode, and audit events in one administrative view. |
| Release readiness register | Internal | Live | Readiness tasks are stored in Supabase with status, owner, evidence, source reference, and completion checks. |
| Connected source and freshness labels | Shared | Live | Canix, QuickBooks, Monday, Portal, and shop-source states are displayed with last-successful timestamps, stale or unavailable state, and no replacement of unknown values with zero. |
| Store buying desk | Store | On hold | Store expansion remains paused. Existing Store order, catalog, account, kiosk, and demo surfaces must not be described as the active launch priority. |
| Promotions and commercial offers | Commerce | On hold | No promotion stacking, eligibility, or automatic price override is enabled until Sales, Finance, and Operations approve the model. |
| Internal supply and production planning | Internal | On hold | Production planning is not yet a full UX OS planning engine; Canix remains authoritative for physical and compliance inventory. |
| Forecasts and decision support | Shared | On hold | Reorder-risk, cash-collection, production-demand, and assortment-gap models require named owners, source contracts, validation, explanations, and a disable path. |
| AI buying assistant | Store | On hold | No AI ordering assistant should be represented as live until privacy, action boundary, grounding, evaluation, and cost controls are approved. |
| Public COA/recall publishing | Quality | Out of scope | Public COA and recall execution were removed from UX OS scope. Authorized product and lineage views may display source data only. |
| Payment collection | Finance | Out of scope | UX OS does not collect payments or create automatic QuickBooks accounting mutations. |
| Customer Store API | Store | Out of scope | No public customer API surface or credential is issued. |

## Release-language rules

- Use "Brand-first staged build" for the current priority.
- Use "Store expansion on hold" until the Store strategy is reactivated.
- Do not call QuickBooks or Canix projections live unless the screen shows the source system and last successful refresh.
- Do not describe Brand sales dollars as live unless Finance approves the definition and QuickBooks line mapping.
- Do not imply retailer POS sell-through, retailer identity, margin, ownership, payment collection, or public COA/recall publishing from current Brand views.
- Do not describe a capability as complete if it depends on the unresolved Canix Package Owner Reporting bridge.

## Remaining approval dependencies

The remaining non-code dependencies are the Canix Package Owner reporting route or documented REST property, Finance approval for Brand dollar definitions, Finance and Operations approval of the metric glossary, legal/compliance approval for retention disposition, and reactivation decisions for Store, promotions, planning, forecasts, and AI.

The controlled-hold exit criteria are maintained in `docs/ux-os-final-completion-blockers.md`, and copy-ready approval packets are maintained in `docs/ux-os-controlled-hold-approval-packets.md`.
