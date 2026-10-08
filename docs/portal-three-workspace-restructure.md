# UX Portal three-workspace restructure

Status: Phase 1 production foundation released; authenticated Tom-profile acceptance test pending
Source: UX OS meeting notes, 2026-09-29
Working principle: preserve the Canix, QuickBooks, Monday.com, and Supabase connections while replacing the store-first information architecture.

## 1. Product direction

The portal becomes one operating system with three scoped workspaces:

1. **Internal** — urbanXtracts staff operate, approve, reconcile, administer, and monitor the system.
2. **Brand** — brand partners manage their relationship with urbanXtracts, place manufacturing purchase orders, track production and inventory, and review commercial records.
3. **Store** — licensed retailers browse the sellable catalog, order product, review their account, and manage their stores and users.

The immediate delivery priority is the **Brand workspace**, tested first with urbanXtracts as the pilot brand. Store features remain available behind their existing access boundaries, but store-only navigation should not dominate the product while the Brand workspace is being validated.

## 2. Entry and workspace routing

After sign-in, the server resolves the user's memberships and permitted workspaces.

| User | Default landing | Scope |
| --- | --- | --- |
| urbanXtracts employee | Internal | Permission-based access across authorized operations |
| Brand partner | Brand | Only assigned brand organizations and approved records |
| Store owner or buyer | Store | Only their retailer organization and assigned stores |
| Public kiosk visitor | Public product education | Published product information only; no account, price, or inventory access |

A person with more than one permitted workspace receives a workspace switcher. Switching changes the route and data scope; it does not create a second account or weaken server-side authorization.

## 3. Brand workspace — Phase 1 priority

### Home

- Current manufacturing orders and production status
- Active inventory summary
- Open actions, expiring documents, and missing onboarding information
- Accounts receivable summary when the approved QuickBooks relationship exists
- Recent uploads and notices

### Company and onboarding

- Legal company and DBA information
- Contacts and authorized users
- Billing and remittance details
- Qualified-vendor information
- NCI and other approved operating identifiers
- Partial-save onboarding sections
- Internal review state, correction request, resubmission, and approval history

The portal form replaces the customer-facing Monday onboarding form. Monday remains the internal workflow destination, while Supabase holds the durable portal submission and current review state.

### Agreements

- Non-disclosure agreements
- Master service agreements
- Sales agreements
- Quality agreements
- Contract exhibits and price sheets
- Effective dates, status, and controlled download

Signed agreements are view-only to Brand users. Amendments and replacements use a reviewed upload workflow rather than editing the signed document in place.

### Products and SKUs

- Brand-scoped SKU register
- SKU intake drafts and section assignments
- Product identity, format, UOM, case quantity, and approved commercial attributes
- Change request, re-review, and approval history
- Monday item/SKU workflow linkage
- Canix item identity linkage

### Purchase orders

- Browse a Brand-scoped catalog and add multiple products to one cart
- Show approved image, price, units per case, order basis, and availability band
- Save a durable draft, submit, review exceptions, and track status
- Preserve submitted price and case-size snapshots instead of silently repricing history
- Record partial shipment, receipt, damage, rejection, refusal, manifest, tracking, and proof-of-delivery evidence
- Never create a QuickBooks invoice automatically from an incomplete or unverified customer/account relationship

Production and fulfillment milestones are part of the purchase-order timeline rather than a separate Brand navigation section. Historical Monday manufacturing records remain retained and unchanged.

### Inventory

- Active inventory filtered to the signed-in Brand scope
- Product, lot/package, status, facility, UOM lane, and last-source-update time
- Exact quantities only when the Brand contract and internal access policy allow them
- Clear stale-data banner using the last successful Canix snapshot
- No cross-brand inventory leakage

### Sales and distribution

- Brand-scoped sales records and distribution history
- Customer/store visibility only where contracts and policy permit it
- Order status, quantity, dates, and product mix
- No inference of retailer POS sell-through

### Financials

- Accounts receivable and payment history sourced from QuickBooks
- Billing-account status and commercial terms
- No payment collection in the current release
- No automatic invoice creation from portal orders

### Marketing materials

- Upload approved product and campaign materials
- Malware scan before availability
- Review, approval, replacement, and retention state
- Monday handoff where the business workflow requires it

### Documents and procedures

- Approved SOPs, specifications, onboarding documents, and reference files
- Brand-scoped access, immutable versions, and download audit

## 4. Store workspace

### Home

- Order status, account alerts, receivables summary, and frequently reordered products

### Catalog and shopping

- Store-specific published catalog and price
- Availability state without internal exact quantities
- Draft order, approval, submission, and reorder
- Contract, store, promotion, and default pricing precedence

### Orders

- Ordered, Approved, Processed, and Delivered customer-facing states
- Owner approval above the configured store threshold
- Buyer access only to assigned stores

### Account

- Organization, up to ten stores, licenses, users, delivery details, and account history
- QuickBooks-backed customer identity and receivables
- Future payment action remains deferred

### Public kiosk

- Store-specific public link
- Brand selector and published product education
- No sign-in, price, exact inventory, ordering, financial, or administrative access

## 5. Internal workspace

### Operations

- Cross-workspace dashboard
- Inventory and item master
- Brand accounts and store accounts
- Manufacturing orders and store orders
- Store onboarding and brand onboarding queues
- SKU intake and product publication queues
- Receiving claims and operational exceptions

### Commercial and finance

- Contract and price-sheet controls
- Brand and store rate cards
- QuickBooks customer/account reconciliation
- Receivables and payment display
- Approval thresholds and commercial terms

### Quality and traceability

- Lots, lineage, package status, test state, and COA source data
- Internal release controls and exception queues
- Public COA/recall publishing remains outside this portal unless a later decision reverses that scope

### Administration

- Users, memberships, roles, workspace assignments, and immediate deactivation
- Administrator-only, read-only **View as Brand** sessions with explicit start/end audit records; the preview never grants Brand write authority or exposes cached Internal data
- Connection health for Canix, Monday, QuickBooks, email, and document scanning
- Audit history and release readiness

### Future staff services

Time, attendance, pay, options, and training were raised as a future staff interface. They are not part of the Brand-first restructure and should not be mixed into the operational release until their systems of record and owners are approved.

## 6. Preserved integration boundaries

| System | Preserved authority | Portal use |
| --- | --- | --- |
| Canix | Physical/compliance inventory, packages, items, facilities, status, testing, and reporting fields | Read and normalize inventory, item identity, ownership/brand fields, and traceability. Keep the five-minute fallback and last-good snapshot behavior. |
| Monday.com | Internal workflow, review, approval, operational handoff, item master content, and manufacturing/order work | Receive portal submissions through protected outboxes; return stable item IDs and approved workflow states; retry and reconcile failures. |
| QuickBooks | Customer/account identity, receivables, invoices, payments, and financial account status | Read verified records and map them to portal organizations. Do not create rogue invoices or infer commercial approval from a balance. |
| Supabase | Portal identity, authorization, memberships, durable submissions, normalized snapshots, outboxes, audit, and customer-facing projections | Enforce organization/workspace scope server-side. Never rely on hidden navigation as an access control. |

Existing connector functions, OAuth custody, signed callbacks, retry behavior, malware scanning, authenticated-session checks, role and organization scoping, and audit contracts remain in place. The restructure changes presentation, membership, and workflow composition—not integration trust boundaries.

## 7. Recommended data model additions

Do not force Brands into retailer organizations or encode Brand access in a free-text profile organization.

- `portal_organization`
  - `id`, `kind` (`internal`, `brand`, `retailer`), legal name, display name, status
- `portal_organization_membership`
  - user, organization, workspace, role, status, created/disabled timestamps
- `portal_brand_account`
  - portal organization, Canix brand/owner identifiers, Monday account identity, QuickBooks customer/vendor identity where applicable
- `portal_agreement`
  - organization, agreement type, effective dates, status, immutable file version
- `portal_brand_purchase_order`
  - brand organization, status, contract/rate-card reference, Monday workflow identity
- `portal_manufacturing_order_projection`
  - stable Monday identity, brand organization, current approved status, source timestamp

Keep existing retailer and store tables during migration. Add compatibility views rather than rewriting historical migrations or disconnecting production functions.

## 8. Navigation for the first Brand pilot

### Brand

1. Home
2. Company and onboarding
3. Agreements
4. Products and SKUs
5. Catalog and orders
6. Inventory
7. Sales and distribution
8. Financials
9. Marketing materials
10. Documents and procedures
11. Users

### Internal

1. Home
2. Work queues
3. Inventory
4. Products and SKUs
5. Store orders
6. Brand purchase orders
7. Work queues
8. Brands
9. Stores
10. Commercial and financials
11. Quality and traceability
12. Communications
13. Administration
14. Audit and readiness

### Store

1. Home
2. Catalog
3. Draft order
4. Orders
5. Financials
6. Stores and delivery
7. Users
8. Documents

## 9. Migration sequence

### Phase 0 — Preserve and isolate

- Keep the dated repository and document backups.
- Create a restructure branch from the verified baseline.
- Freeze destructive schema changes and preserve all current connectors.

### Phase 1 — Three-workspace shell

- **Released:** organization and membership foundations, authenticated workspace resolution, accessible workspace switching, and Brand navigation shell.
- **Released:** Store and Internal compatibility routes remain intact.
- **Released:** the urbanXtracts pilot Brand organization is active with verified Canix Brand ID `2202` and Monday Brand item `12782809204`; active administrators retain Internal as their default and also receive Brand Manager membership.
- **Released:** Administrators can start an audited, read-only **View as Brand** session from Users and Access and return to Internal without changing their account or memberships.
- **Verified:** production migration, protected Administrator service, public entry point, anonymous-denial contracts, local service tests, and database security contracts.
- **Pending acceptance:** bind the external browser extension explicitly to the Tom (urbanxtracts.com) profile and complete the signed-in workspace/Brand-preview click-through.
- **Released:** the Brand Inventory view reads only the latest successful Canix snapshot within the verified urbanXtracts Brand scope. It reports product and package-record status counts while exact weight and unit quantities remain withheld pending a recorded decision.
- **Released:** Brand Financials classifies urbanXtracts as company-owned. No external QuickBooks customer/vendor identity, settlement, Brand statement, or external balance is invented; company-level books remain Internal-only.
- **Released:** the original `Downtown`, `Riverside`, and `Northgate` prototype stores and their `Downtown Provisions` account are retired from active use. Historical orders, published prices, and audit evidence remain preserved. The separate `Demo Downtown`, `Demo Riverside`, and `Demo Northgate` acceptance-test organization remains available for role testing.

### Phase 2 — Brand source of truth

- **Released:** Brand onboarding is a durable, sectioned portal workflow with six independently assigned sections, partial saves, completion checks, submission locks, internal approval or correction requests, approved-section reopening, and immutable revision history.
- **Released:** Brand onboarding documents use a private bucket, restricted file types and size, fail-closed malware scanning, and server-only metadata access.
- **Released:** final approval creates a retryable, idempotent Monday outbox record; internal reviewers can retry reconciliation without resubmitting Brand data.
- **Pending operations:** set the approved `MONDAY_BRAND_ONBOARDING_BOARD_ID` before the first completed Brand onboarding is handed to Monday. Until then, approved records remain safely queued.
- **Released:** connected Brand profile, Inventory, Financials, Company onboarding, and Brand Users areas.
- Add agreements and remaining SKU capabilities.

### Phase 3 — Brand operations

- Add purchase orders and manufacturing-order projections.
- **Released:** add Canix-scoped Brand inventory without exposing cross-Brand rows or undecided exact quantities.
- Add Monday outbox/write-back and reconciliation.

### Phase 4 — Commercial visibility

- Add brand-scoped sales/distribution views.
- Add verified QuickBooks receivables and billing identity only for external Brands that receive an approved accounting relationship. The company-owned urbanXtracts pilot is intentionally not mapped to an external QuickBooks party.
- Add contract price-sheet rules, minimums, and terms.

### Phase 5 — Store simplification

- Recompose the existing store functions into the reduced Store navigation.
- Keep public kiosk separate from authenticated Store operations.

## 10. Acceptance criteria for the first pilot

- A Brand user signs in and lands in Brand, never Store.
- The Brand user can only read records linked to their Brand organization.
- UrbanXtracts can be configured as the pilot Brand without changing Canix, Monday, or QuickBooks credentials.
- Brand onboarding supports partial saves and internal correction requests.
- A submitted Brand purchase order is durable before the Monday handoff begins.
- Monday returns a stable record identity and status to the portal.
- Canix inventory is filtered server-side by approved Brand/Owner identifiers.
- QuickBooks financials appear only after an approved accounting identity mapping.
- Connector failure shows the last successful snapshot and an actionable internal alert.
- Deactivating a membership removes workspace access immediately.
- The existing baseline release and security tests remain green throughout the migration.

## 11. Decisions still required

- Confirm whether Brand purchase orders represent raw-material supply, manufacturing requests, finished-goods purchases, or more than one typed order.
- Confirm the authoritative Canix field(s) used to scope a Brand: Brand, Owner, or an approved relationship table.
- Confirm which sales/distribution counterparties a Brand may see.
- Confirm whether Brand financials map to a QuickBooks customer, vendor, or both.
- Provide Andrew's final Brand outline and the missing requirements from Omid and JD.
- Confirm whether NCI is a document, identifier, checklist, status, or a combined record.
- Confirm contract-controlled pricing precedence and minimum-order behavior for Brand purchase orders.
- Confirm document retention and which Brand uploads require internal approval before visibility.
- Decide whether Brand users may see exact inventory weight and unit quantities, and whether the rule varies by Brand agreement or inventory state. Until approved, only record/status summaries are shown.
- Select the approved Monday Brand Onboarding destination board, group, stable columns, and reconciliation owner. Until approved, completed onboarding submissions remain safely queued.

## 12. Current-state audit note

The public sign-in screen is visually clean and exposes both email/password and Google Workspace access. The main structural risk is not on the sign-in screen; it is that the application currently resolves most non-internal users into store-oriented roles and navigation. The redesign must therefore start with server-side organization membership and workspace resolution, not by merely relabeling the existing sidebar.

Audit evidence: `/.codex-audit/restructure-2026-09-29/01-sign-in.png`. Authenticated navigation could not be visually audited in this run because no signed-in browser session was available; the internal/store information architecture above was inspected from the verified source instead.
