# UX OS metric glossary and reporting policy

Updated 8 October 2026 for the Brand-first staged build.

Every connected metric in UX OS must show its source, last successful refresh or as-of timestamp, stale or unavailable state, and calculation boundary. Unknown values stay unknown; they are never replaced with zero.

## Refresh policy

| Source | Intended cadence | On-page refresh | Stale handling |
| --- | --- | --- | --- |
| Canix inventory and item data | Scheduled, target near real time | Authorized refresh where supported | Warn after freshness threshold, preserve the last successful snapshot, and block current-inventory decisions after a prolonged sync failure. |
| QuickBooks financial snapshots | Scheduled refresh approved by Finance | Authorized refresh for scoped views | Show last successful snapshot, mark stale or disconnected state, and never mutate QuickBooks from a portal read. |
| Portal orders, purchase orders, claims, onboarding, documents, and work items | Transactional Portal records | Immediate after save or refresh | Portal is authoritative for workflow state, comments, evidence, and audit history. |
| Monday historical records | Read-only historical reference unless a specific callback remains approved | Limited to approved app-owned workflows | New workflows should remain portal-native unless explicitly approved. |
| Brand shop or marketplace snapshots | Scheduled when a credential is approved | Authorized reconciliation only | Missing credential or failed sync must show as unavailable and cannot invent catalog readiness. |

## Metric definitions

| Metric | Approved meaning | Source of truth | Current visibility |
| --- | --- | --- | --- |
| Approved Brand sale | A non-draft Brand purchase order or order line that has reached an approved workflow state in UX OS. | Portal Brand purchase-order records | Brand-scoped units can be shown; dollar reporting remains gated by Finance. |
| Units ordered | Sum of Brand purchase-order line quantities in the selected reporting period. | Portal Brand purchase-order lines | Brand users may see aggregate Brand-scoped totals. |
| Units fulfilled | Sum of shipment, receipt, delivery, or completed fulfillment evidence for Brand purchase-order lines. | Portal fulfillment events | Brand users may see aggregate Brand-scoped totals. |
| Sales dollars | Finance-approved dollars from posted, non-voided QuickBooks lines mapped to the correct Brand and SKU, adjusted for approved credits and returns, inside a Finance-closed period. | QuickBooks, after Finance-approved mapping | Withheld until Finance approval and stable line mapping are complete. |
| Outstanding balance | Open QuickBooks balance for the scoped customer, vendor, or retailer account relationship. | QuickBooks snapshot | Read-only; does not automatically create an ordering hold. |
| Account statement | Invoice and payment references for the mapped account relationship. | QuickBooks snapshot | Read-only; full statements may be shown to approved Brand or Store roles only within scope. |
| Reorder interval | Average interval between portal order dates for the same scoped account, store, Brand, or product, with insufficient history explicitly labelled. | Portal order history | May be displayed where the source scope is clear. |
| Inventory availability | Current Canix-backed availability for the approved item, Owner, or store-ordering scope, respecting release state and explicit reservations. | Canix snapshot plus Portal policy | No exact quantity should be exposed where policy withholds it. |
| Inventory pressure | A future decision-support signal comparing approved demand to available supply. | Not approved | On hold; do not display as live. |
| Opportunity | A future account or product recommendation based on approved portal order history, not POS sell-through. | Not approved | On hold pending retailer-identity and scoring approval. |
| Receivables risk | Finance-approved view of overdue or open balances. | QuickBooks snapshot | Internal/Finance only until role policy is approved. |

## Export and redaction policy

- Export attempts must be logged every time.
- Executive, Sales, Finance, and Operations may export approved internal reports.
- Brand users may export only their own Brand-scoped approved reports when export is enabled.
- Store users may export only their scoped account/order/statement records when that Store workspace scope is active.
- Redact retailer/store identity from Brand reports unless a specific Finance, Sales Operations, and legal policy approves disclosure.
- Redact margin, cost, Economic Owner, Canix Package Owner, internal notes, bank details, access-control data, malware-scan internals, and cross-Brand records from external exports.
- Include report name, workspace, scope, user, timestamp, source system, as-of timestamp, and filter set in the export audit event.

## QuickBooks write boundary

QuickBooks is read-only in the current portal release. UX OS may route requests, preserve approval evidence, and prepare a processing handoff, but it must not silently create invoices, credits, payments, vendors, customers, or GL activity. Any future write action needs a deliberate human confirmation, idempotency key, reviewer separation, audit event, and Finance-owned acceptance test.

## Finance approval policy

Purchase approval routing follows the current business decision:

| Amount | Approval |
| --- | --- |
| $0-$500 | Eric Stewart, with Omeed Turan, Jonathan DeMart, or Drew Walsh as backup |
| $501-$2,999 | Jonathan DeMart, Drew Walsh, or Omeed Turan |
| $3,000+ | Eran Sherin |
| Emergency purchase | Jonathan DeMart, Drew Walsh, or Omeed Turan |

After approval, route the request to Amrit Kharas for processing.

Preparer/reviewer separation rule: the requester or preparer cannot be the sole approver, processor, or final reviewer of the same financial transaction. Exceptions require Executive approval and an audit note.

## Retention stance

Automatic deletion remains disabled. Records should be archived, not deleted, unless a future legal/compliance policy approves a disposition worker with legal-hold checks, reviewer separation, and retained deletion evidence.
