# Canix and QuickBooks field map

Reviewed 2026-09-17. This maps fields needed for UX OS inventory, retailer accounts, store orders, billing, payment visibility, and cost accounting. It is not a claim that every field exposed by either API should be copied. “Mapped” means the current portal persists a verified key or relationship; “proposed” means the September field specification describes an intended relationship, not a live integration.

## Current working mappings

| Business concept | Canix source | QuickBooks source | UX OS bridge | Current status |
| --- | --- | --- | --- | --- |
| Retailer accounting identity | No verified Canix customer crosswalk | `Customer.Id`, `DisplayName`, `Active` | `quickbooks_customer_cache.quickbooks_customer_id` links to `portal_retailer_account.quickbooks_customer_id` | Mapped between QuickBooks and portal, not Canix |
| Store accounting identity | Sales `customer_id`, `customer_name`, `customer_license_number` exist in Canix Reporting | `Customer.Id`, `ParentRef` | `portal_store.quickbooks_customer_id` links a store to its parent or direct QuickBooks customer; store license is separate | QuickBooks-to-portal mapping exists; Canix-to-QuickBooks ID mapping absent |
| Invoice customer | Canix sales `customer_id` is a different identifier | `Invoice.CustomerRef.value` | Invoice cache joins to QuickBooks customer cache by QuickBooks ID | Mapped inside QuickBooks only |
| Payment customer | Canix `order_payment_facts.customer_id` is a different identifier | `Payment.CustomerRef.value` | Payment cache joins to QuickBooks customer cache by QuickBooks ID | Mapped inside QuickBooks only |
| Payment-to-invoice allocation | Canix payments are associated with a Canix sales order | `Payment.Line.LinkedTxn` | Portal retains `invoice_allocations` by QuickBooks invoice ID | Mapped inside QuickBooks only |
| Customer balance | Canix sales `balance_cents` is order-derived | `Customer.Balance`, `BalanceWithJobs` | Portal caches QuickBooks balances | Mapped as QuickBooks financial display; not reconciled with Canix |
| Invoice amount and status | Canix sales has `net_revenue_cents`, tax fields, `paid_cents`, `balance_cents` | `Invoice.TotalAmt`, `Balance`, `TxnDate`, `DueDate` | Portal caches QuickBooks invoice totals and derives open, paid, or past-due display state | QuickBooks display mapped; no Canix invoice match |
| Payment amount | Canix `order_payment_facts.amount_cents` | `Payment.TotalAmt`, `UnappliedAmt`, `TxnDate` | Portal caches QuickBooks payment values | QuickBooks display mapped; no Canix payment match |

The QuickBooks connector currently queries **Customer, Invoice, and Payment** only. It does not query QuickBooks Item, Class, Account, or invoice line details, and it has no QuickBooks write route. The Canix portal connector reads packages, items, and sales-order allocations; its customer identity is not crosswalked to the QuickBooks customer ID.

## September 17 meeting decisions and live comparison

- Monday remains the workflow and approval layer; it is not the master for Canix inventory facts or QuickBooks accounting facts.
- Supabase/UX OS should hold the reviewed crosswalk and resolved party identity. It must preserve the original Canix and QuickBooks IDs and the approval evidence.
- Retailer/store, brand, owner/economic partner, and vendor are distinct party roles. A shared or similar name does not mean the records represent the same role or legal entity.
- A live comparison on 09/18/2026 found **524 Canix sales customers** and **32 QuickBooks names in the available Sales by Customer Summary**. The QuickBooks report contains many apparent brands and partners, so it is not a safe substitute for the complete QuickBooks Customer master.
- The expanded 09/18/2026 QuickBooks customer export produced 10 exact normalized-name candidates and 2 high-similarity candidates. Tom confirmed all 12 identities on 09/18/2026, creating approved Canix-to-QuickBooks crosswalks that preserve both source IDs. Party-role classification remains pending and must be completed before any record is treated as a retailer organization or licensed store.
- The next required source is the complete QuickBooks Customer master with Customer.Id, DisplayName, parent/sub-customer relationships, active status, and billing identity. Steven's meeting action is to obtain that source from Yanvi.
- The working terminology should say **METRC tag / Canix tag** and **Supabase**. The meeting transcript phrases “metric tag” and “Superbase” are transcription errors.
- OCM license type may classify a party only when the OCM legal entity or DBA matches that party. In the 12 approved crosswalks, the 09/18/2026 OCM export verifies Hemp Hunter Labs and Stop 30 LLC as Adult-Use Processors and Mrs. C Botanicals LLC as a Processor Type 3 Branding licensee. Tom confirmed that all nine counterparties using urbanXtracts' processor license in this review are urbanXtracts-exclusive brands, including records that did not contain the `BRAND` designation. Brand role, processor-license context, and economic ownership remain separate fields; none should be inferred from another.

## Unmapped or only proposed relationships

| Priority | Concept | Canix field or source | Proposed QuickBooks target | Gap / decision needed |
| --- | --- | --- | --- | --- |
| P0 | Retailer/store identity | Sales `customer_id` plus `customer_license_number`; package `customer_id` only when allocated | `Customer.Id` and, where applicable, `ParentRef` | Create a reviewed crosswalk keyed by Canix customer ID and license to the correct QuickBooks customer and portal store. Do not join on display name alone. Validate one-to-many parent/child cases. |
| P0 | Sales order to invoice | `sales_order_id`; `sales_order_name` is only unique per facility | `Invoice.Id` plus an agreed source-order reference | No deterministic bridge. Decide where the Canix order ID, facility ID/license, and portal order ID are recorded when the invoice is entered manually, then capture that reference in the portal's read-only QuickBooks sync. Do not match on amount/date/name alone. |
| P0 | Item/SKU to invoice line | `item_id`, `sku`, `sellable_type`, `sellable_id` | `Invoice.Line.SalesItemLineDetail.ItemRef` and QuickBooks `Item.Id` | QuickBooks Item and invoice lines are not synced. Approve a Canix-item-to-QuickBooks-item crosswalk, including many-to-one cases, before product-level revenue or margin reconciliation. |
| P0 | Cost object | Monday-approved `cost_object_id`, currently resolved in UX OS from the lot decision; not Canix `order_item_id` | Approved QuickBooks Class and Item combination | The September specification proposes `qb_class` and `qb_item` on the Cost Object Master. Current connector does not read or verify QuickBooks Class/Item or a chart-of-accounts export. Finance must approve exact IDs/codes and posting rules. |
| P0 | Economic ownership and accounting treatment | Monday/UX OS `ownership_code` and economic owner; Canix `owner_id`/`owner_name` means an assigned Canix user, and `brand_name` means market brand | Inventory asset, cost of services, recovery, or liability account according to approved treatment | No direct field map. Never use Canix Brand or package Owner as economic owner. Finance must approve account treatment for UX/TOLL/SPLIT/TEST and test it against actual postings. |
| P1 | Brand dimension | Canix `brand_id`/`brand_name` | September design proposes a brand QuickBooks Customer | The live portal uses QuickBooks Customer for **retailers/stores**. A brand customer is a different party role. Define separate brand-vs-retailer identities and transaction rules before using a Customer field for both. |
| P1 | Quantity and UOM | Inventory `quantity_type`; `weight` is count for CountBased packages, `c_weight_g` for WeightBased. Sales `c_quantity_ea`, `c_weight_g`, `c_volume_ml` vary by line. | Invoice line quantity and Item unit | No invoice-line quantity sync or approved unit crosswalk. Never add grams, eaches, and volume, or equate a package count with a sellable-unit count without the item conversion. UX OS excludes volume from its inventory display by policy. |
| P1 | Price, discounts, tax | Sales `price_cents`, `discount_cents`, `net_revenue_cents`, tax fields | Invoice line amount, discount and tax fields | Not retained at QuickBooks line grain. Differences in price timing, manual invoicing, discounts, and tax treatment need an explicit reconciliation rule. Canix sales values are not automatically QuickBooks revenue. |
| P1 | Payments and credit | `order_payment_facts.payment_id`, `sales_order_id`, `reference_number`, `amount_cents` | `Payment.Id`, `Payment.Line.LinkedTxn`, credit memos if used | No Canix-payment-to-QuickBooks-payment crosswalk or duplicate-payment detection. Reference number is free text and cannot be the sole key. QuickBooks remains the receivable authority. |
| P1 | Order status and invoice status | Canix `sales_order_status`, `is_shipped`, `is_completed`, `is_voided` | Invoice open/paid/void state | Different lifecycles. Establish event rules for invoicing, cancellation, returns, and credits; do not copy one status into the other. |
| P1 | Inventory cost to ledger | Canix package cost measures and package quantity | QuickBooks inventory asset and COGS accounts | Current portal does not read QuickBooks Account/JournalEntry/Item cost or reconcile value. Cost Object and ownership rules must precede a safe value bridge. |
| P2 | Lot, package, and compliance trace | `package_id`, `tag` (not `metrc_tag`), `lot_id`, `production_batch_number` | No required one-to-one QuickBooks master field | Keep traceability in Canix/Monday/Supabase. If invoice trace is needed, define a controlled line-level reference or supporting schedule; don't overload QuickBooks Customer/Item IDs. |
| P2 | Lab and release state | `lab_test_status`, `test_result_status`, `status_category` | Usually no direct accounting field | Operational fulfillment gate, not a QuickBooks field. Any accounting release/recognition event needs a separately approved rule. |
| P2 | Source timestamps | Canix `updated_at` and portal sync time | QuickBooks `MetaData.LastUpdatedTime` and portal sync time | Both sides are cached separately. A reconciliation must compare like-for-like as-of times and identify stale snapshots. |

## Mapping rules and cautions

- **Identifiers are system-specific.** Canix `customer_id`, `item_id`, `sales_order_id`, `order_item_id`, and `payment_id` do not equal QuickBooks `Customer.Id`, `Item.Id`, `Invoice.Id`, line IDs, or `Payment.Id` merely because names or numbers look similar.
- **The sales-order number needs its facility.** Canix Reporting says `sales_order_name` is unique only per facility. Prefer the Canix numeric sales-order ID; retain facility ID/license with a displayed name.
- **No automatic invoicing is approved.** Portal orders go to Monday; accounting enters them in QuickBooks manually after store data is verified. This map proposes references and reconciliation, not a QuickBooks write-back.
- **The newer field specification is designed intent.** Its Section 13 proposes QuickBooks Class = department, Customer = brand, and Item = cost-object line. That clashes with the current retailer Customer usage unless party roles and transaction types are separated. The specification also says the same cost-object ID should appear across systems, but the current connector does not validate that ledger dimension.
- **The old simplified Canix workbook is not authority for Owner or Cost Object.** Brand is not economic ownership; a Canix sales-order line is not a Cost Object. The Canix Reporting compliance field is `tag`, not `metrc_tag`.
- **A field's existence is not a completed map.** The Canix Reporting schema confirms source fields; the live portal's REST-backed sync and QuickBooks read-only sync do not ingest every reporting field. This review establishes structural coverage, not a row-level match rate or an assertion that the production QuickBooks connection is healthy today.

## Evidence reviewed

- UX Field Specification v2.1, Sections 1, 7, 8, 12, 13, and 14 (design draft dated September 2026).
- UX OS Field Inventory by System v0.2, QuickBooks, Cross-System Map, and Gap List (earlier draft; explicitly says QuickBooks targets were uninspected at the time).
- Canix connected Reporting schemas: inventory `package_inventory_facts_current`, sales `sales_order_item_facts`, and `order_payment_facts` (reviewed 2026-09-17).
- Portal implementation: `supabase/functions/canix-inventory/index.ts`, `supabase/functions/quickbooks-retailers/index.ts`, `supabase/functions/quickbooks-financials/index.ts`, and retailer/store accounting migrations.
- Intuit Accounting API entity documentation for Customer, Invoice, Item, and Payment. The target QuickBooks company configuration and accounting dimensions still require a company-specific export and Finance approval.
