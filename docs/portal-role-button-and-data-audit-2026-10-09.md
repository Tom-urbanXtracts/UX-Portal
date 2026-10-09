# UX OS Portal — Role, Button, and Data Audit

**Audit date:** October 9, 2026  
**Environment reviewed:** `https://portal.urbanxtracts.com/`  
**Method:** Authenticated BrowserSkill walkthrough in the approved browser profile, supported by the local release-contract suite and source inspection.  
**Change boundary:** This was a read-only/non-destructive review. No live users, orders, prices, approvals, mappings, or source records were changed.

## Remediation update — October 9, 2026

The first eight approved corrections from this audit are implemented in the release source and verified locally:

1. Internal and Brand navigation groups now use controlled expand/collapse buttons and retain the active group.
2. Synthetic Store/product/order/financial data is limited to explicit Demo Store sessions; Internal and Brand production views no longer fall back to demo catalog or account records.
3. Brand role controls retain and display the current server membership role, including Brand Owner, instead of visually falling back to Manager.
4. The Monday supply-order receiver remains a server-to-server webhook and is verified against its shared secret or signed token; it is no longer incorrectly evaluated as a browser-session endpoint.
5. The obsolete Portal Build, IT Governance, Communications and Controls, and Release Readiness entries are removed from the Internal sidebar while protected tools remain reachable from authorized administration pages.
6. Portal-rendered dates now use `MM/DD/YYYY`; database and API values remain machine-safe.
7. Internal Catalog now presents catalog authoring/readiness rather than a Store shopping catalog.
8. A COA action is rendered only for a valid HTTPS document URL; otherwise the product shows `DOCUMENT NOT AVAILABLE`.

The post-change verification result is 524 of 524 local release contracts, eight Node service tests, twelve Deno security tests, and 560 of 560 remote release contracts passing. Browser verification passed for Internal navigation and Catalog separation, Brand navigation and Owner labelling, Store demo isolation, date formatting, Budtender price restrictions, and the missing-COA state.

## Executive summary

The portal has meaningful role separation and several working end-to-end read paths, but it is not yet ready to be represented as fully production-backed.

The strongest areas are authentication, the Internal Canix inventory read, Store role separation, Brand onboarding section review, catalog content review controls, and basic product-detail navigation. The largest gaps are:

1. Production pages still contain synthetic executive-demo products, prices, orders, stores, and financial scenarios.
2. Internal and Brand grouped sidebar sections could not be expanded during the walkthrough, which can trap a user in the currently open section.
3. Canix inventory is loading, but ownership, Lot ID, cost-object, and catalog-content coverage is incomplete.
4. The Brand workspace is not fully mapped to Canix Owner, QuickBooks, agreements, approved documents, or transaction history.
5. Two release contracts fail for the unfinished Monday supply-order webhook.

## Role comparison

| Role | Confirmed visible areas | Confirmed restrictions | Review result |
|---|---|---|---|
| Internal Administrator | Operations dashboard, work, inventory, catalog, kiosk, SKU intake, pricing, Brand applications, Brand purchase orders, work queues, financials, Brand administration, users, audit, and administrative controls | Server-protected administrative actions remain separate from public/Store/Brand views | Broad access is present. The live sidebar still contains items already removed in the local build, so the cleanup has not yet reached production. |
| Brand account | Company onboarding, agreements, users, products, SKU intake, vendors/components, marketing, quality/operations documents, orders, inventory, sales/distribution, financials, tasks, and support | Brand-scoped records; other organizations and Internal economics are not rendered | Scope is directionally correct, but navigation between grouped sections is unreliable and source mappings are incomplete. |
| Store Owner | Three assigned demo locations, store performance, catalog, pricing proposals, comparison, draft order, approvals, financials, account/delivery, approval authority, users, documents, records, and training | Limited to its retailer organization and assigned stores | Matches the intended Owner model. All displayed Store data is still explicitly synthetic/demo data. |
| Store Buyer | Two assigned demo locations, catalog, pricing proposals, comparison, draft order, own orders, financials, documents, records, and training | No Store user administration or approval-authority configuration; no authority to approve another Buyer’s order | Matches the current decision set. |
| Store Budtender | One-store product lookup, product browsing, comparison, and training | No prices, financials, ordering, user administration, or other stores | Price restriction works. The UI describes a shared device with no personal login even though the view was reached through a named Budtender account. |
| Store Manager | Not available as a test account in this walkthrough | Intended: no purchasing or wholesale pricing, unless later approved | Needs a dedicated test user before the role can be accepted. |

## Confirmed defects and inconsistencies

### P0 — fix before broader user testing

1. **Grouped sidebar navigation is unreliable.** In both Internal and Brand views, clicking a closed group header did not expose its child links. Hidden child controls remained in the accessibility tree without visible geometry. This can prevent users from moving to another workspace group.
2. **Demo data is mixed into production views.** The Store Catalog openly states that it is a stable synthetic snapshot. Internal Catalog and Kiosk pages also contain synthetic products, brands, prices, packages, and COA data. Demo data must be isolated behind an explicit Demo mode and never appear as ordinary production content.
3. **Brand role labelling conflicts with stored membership.** The test session was presented as `BRAND · OWNER`, while the user list showed the same account’s stored role as `brand_manager`. The rendered role, permission checks, and membership record must agree.
4. **Release verification is not clean.** `npm run verify` reported 522 of 524 release contracts passing. The two failures are:
   - `monday-supply-order-webhook permits the production portal origin`
   - `monday-supply-order-webhook requires a validated authenticated user session`

### P1 — resolve before production sign-off

1. Dates are not consistently formatted as `MM/DD/YYYY`. A Catalog preview rendered `2026-07-29`, while other pages use mixed formats such as `Aug 31, 2026` and `13 Aug 2026`.
2. Internal Catalog combines content authoring/readiness with a Store shopping experience. These are different jobs and should be separate routes.
3. Budtender product details include a “Performance at your stores” section even though the view is for product education and receives no retailer POS sell-through data.
4. The Budtender header says “shared floor device · no personal login,” but a named personal test user is signed in. Choose one operating model and label it accurately.
5. Product imagery is still represented by an `IMAGE` placeholder on the Store Catalog.
6. `Open COA` can be shown even when Canix reports only COA presence and no secure document URL. The button should be disabled or replaced with a clear unavailable state until a valid URL exists.
7. The Brand Agreements page shows all 12 gates as `NOT REQUIRED` with zero versions. For an external Brand, this conflicts with the agreed policy that an MSA and activity-dependent agreements must be evaluated and controlled.

## Button and interaction results

### Passed in the live walkthrough

| Area | Interaction | Result |
|---|---|---|
| Authentication | Password sign-in and sign-out | Passed for Internal, Brand, Store Owner, Store Buyer, and Store Budtender test users. |
| Internal Inventory | `Try again` / refresh Canix inventory | Passed. Returned 1,376 packages from the live cache in about five seconds. |
| Internal Catalog | `Preview` | Passed after readiness data finished loading. |
| Internal Catalog | `Open review` | Passed. It selected the correct Canix item in the authoring form. |
| Brand Onboarding | Section navigation buttons | Passed. Sections opened with status, content, review note, and supporting-document controls. |
| Brand Agreements | Agreement accordion | Passed. The NDA section expanded and displayed its empty-version state. |
| Brand Users | Refresh and list rendering | Passed. Existing Brand members and role controls loaded. |
| Store navigation | Flat sidebar page buttons | Passed for the sampled Dashboard, Catalog, and Store pricing pages. |
| Store Catalog | Product details | Passed. The selected product opened its product, package, lab, and profile information. |
| Budtender | Product lookup list to product detail | Passed. No price was rendered. |
| Store Catalog | Search, category, grid/list, quantity, save, and add controls | Controls rendered with valid accessible targets; destructive/order-changing submission was not performed. |

### Confirmed broken or inconsistent

| Area | Interaction | Result |
|---|---|---|
| Internal grouped sidebar | Expand another navigation group | Failed in the controlled browser session. |
| Brand grouped sidebar | Expand `Products`, `Commerce`, or `Work` | Failed in the controlled browser session. |
| Brand role display | Compare header role with stored membership | Inconsistent: Owner presentation versus Manager membership. |
| COA | `Open COA` without a returned HTTPS URL | Not actionable; UI says the source did not return a document URL. |

### Requires a controlled test rather than a live click-through

The following controls can change durable records, send messages, create orders, or affect access. They were not executed in this audit:

- Invite, deactivate, or change a user role.
- Submit or approve a Brand onboarding section.
- Create, submit, approve, return, deny, cancel, ship, deliver, or complete an order.
- Submit or publish Store pricing.
- Create a task, support issue, access request, department request, or offboarding case.
- Upload, replace, approve, archive, or download a protected document bundle.
- Change a Canix Owner, Brand mapping, Lot ID, cost object, QuickBooks identity, agreement policy, or financial control.
- Reconnect Canix, QuickBooks, Monday, Resend, Google Workspace, or another privileged system.

These need seeded test records in a non-production or explicit Demo tenant, with expected database and audit-log assertions for each transition.

## Live data findings

### Canix inventory

The production inventory read is working and was fresh during the review:

- 1,376 packages loaded.
- 1,135 packaged/each records.
- 69 clone/biomass/seed records.
- 172 bulk records.
- 2,370,277.983 grams across 763 weight-based packages.
- 158,027 units across 613 count-based packages.
- Cache freshness was approximately three minutes, within the five-minute maximum.

The data is readable and filterable, but not yet control-complete:

| Gap | Current evidence | Consequence |
|---|---:|---|
| Canix Owner blank | 988 packages | Owner-scoped Brand inventory cannot be safely attributed. |
| Owner unclassified | 1,122 packages | Brand and operational-owner reporting remain incomplete. |
| Missing Lot ID pointer | 805 packages | Ownership/cost-object resolution cannot reach a valid lot. |
| Valid package-to-lot rows | 0 | No package currently passes the active lot-control chain. |
| Package exceptions | 1,376 | Every package needs a resolved or explicitly exempted control state. |
| Approved Monday lot-register rows | 0 of 65 | The register cannot yet validate package pointers. |
| Cost object unresolved | 1,135 packaged/each records | Financial/operating allocation is not ready. |
| Missing item mapping | 1,135 packaged/each records | Catalog and reporting identity remain incomplete. |
| Zero on hand | 18 packages | Requires disposition or exclusion review. |
| Aged 90+ days | 396 packages | Requires Operations review, not automatic disposal. |
| Allocated | 284 packages | Must remain visible internally and excluded from available-to-order quantities. |

### Catalog content

- 33 catalog-readiness records loaded.
- 33 were incomplete.
- 1 was in review.
- 0 were approved/scheduled.
- 0 were published.
- Visible records were missing short description, selling points, ingredients, usage information, and product profile; optional imagery was absent.

### Brand workspace

- Brand onboarding showed five of six sections approved; Company Profile was reopened with the review note “Wrong Info.”
- Agreements showed 12 policy gates, zero uploaded versions, and every gate as not required.
- Brand home showed two of six readiness areas ready/live.
- QuickBooks statements remained in review pending Brand identity mapping.
- Canix inventory remained in review pending a verified Canix Owner ID.
- No approved Brand documents, wholesale history, SKU performance, or active SKU metrics were available.
- Brand source warning reported 534 package records missing Canix Owner; 304 records were safely included under Owner 23335 and 283 also carried the mapped Brand.

### Store workspace

The role experience works, but its data is explicitly synthetic:

- Demo Downtown, Demo Riverside, and Demo Northgate are still the active Store records.
- Catalog, prices, packages, COA values, order history, receivables, approvals, and license gates are demo scenarios.
- No live retailer acceptance can rely on these values.

## Data-completion plan

### P0 — establish trustworthy source boundaries

1. **Isolate Demo mode.** Move every synthetic Store, product, price, order, invoice, package, and COA record behind an explicit Demo tenant or feature flag. Production roles must default to production data or an honest empty state.
2. **Repair grouped navigation.** Add a browser regression test that opens every navigation group, follows every visible child, and verifies that the expected page heading is rendered.
3. **Resolve the Brand-role mismatch.** Make the session banner, navigation, API authorization, user list, and audit log derive from the same membership role.
4. **Finish or disable the Monday supply-order webhook.** Do not release a route that lacks an accepted production origin and validated session contract.

### P0 — complete Canix control data

1. **Approve the lot register.** Operations and Finance must review the 65 existing lot rows on Monday board `18429359264`; migrate the approved register into the portal-native source when that replacement is ready.
2. **Populate Lot ID pointers.** Start with the 805 packages with no Lot ID. Match each package to a valid inbound lot; do not invent or infer a lot from Brand.
3. **Populate Canix Owner.** Assign the new Canix Owner field to the 988 blank packages. Use the verified Owner ID for Brand inventory boundaries; never substitute Brand or Economic Owner.
4. **Classify remaining ownership exceptions.** Review the 1,122 unclassified packages and record an approved classification or explicit exception.
5. **Assign cost objects only after a valid lot exists.** Finance/Operations decides `Assigned`, `Pending Finance/Ops assignment`, or `Not required`, with evidence. Do not use blank as a business status.
6. **Re-run reconciliation.** The portal should produce package totals for valid, missing Lot ID, unknown Lot ID, Owner missing, mapping missing, cost object pending, and explicitly exempted records.

### P1 — complete product and commercial data

1. Match Canix items to the approved portal item/SKU identity.
2. Complete short description, selling points, ingredients, usage, product profile, case quantity, units per case, minimum/order increment, and category.
3. Add approved product images through the controlled asset/document workflow.
4. Provide either a secure COA URL or an explicit “document unavailable” state; parse approved lab fields only when the source and units are known.
5. Approve and publish catalog content through a separate Internal authoring route.
6. Connect Store catalog availability to released finished goods rather than demo packages.

### P1 — complete Brand and QuickBooks data

1. Verify one Canix Owner ID for each Brand organization.
2. Approve the Brand’s QuickBooks customer/vendor identity and record whether the Brand is a customer, vendor, or both.
3. Complete the agreement-requirement decision for each of the 12 agreement types and upload controlled versions where required.
4. Correct and resubmit the reopened Company Profile.
5. Add approved documents and product/SKU records.
6. Map sales, AR, credit, payment, and settlement reporting to QuickBooks without exposing internal collection notes or allowing Brand edits.

### P1 — complete Store data

1. Reopen Store onboarding using the pending Monday partner-onboarding board as the field-discovery source.
2. Create real retailer organizations and stores, using one QuickBooks account for all stores per the current decision.
3. Record each Store’s license, address, contacts, operating hours, delivery instructions, credit state, payment terms, and ordering state.
4. Implement the dedicated Store Manager role and test account: no purchasing and no wholesale pricing.
5. Define item-level case quantities, minimums, and increments from approved SKU Intake.
6. Replace synthetic order and finance data with portal-native orders plus QuickBooks-backed invoices, credits, balances, aging, and payment history.

## Recommended cross-workspace links

1. Inventory package → mapped Item/SKU → published catalog product → order line.
2. Package → Lot ID → inbound lot → Economic Owner → approved cost object.
3. Brand profile → Canix Owner mapping → Brand inventory and sales.
4. Brand profile → QuickBooks customer/vendor mapping → Brand financials.
5. Store organization → QuickBooks account → Stores → assigned Store users.
6. SKU Intake → case quantity/order rules → Store Catalog and Brand purchase orders.
7. Agreement terms/fees → controlled financial rule → calculated Brand statement, with QuickBooks remaining authoritative for accounting entries.
8. Every exception → named owner, due date, evidence, audit event, and source/freshness label.

## Acceptance criteria for the next audit

1. Every sidebar group expands and every visible link reaches the expected page for all six target roles: Internal Administrator, Brand Owner, Store Owner, Store Buyer, Store Manager, and Store Budtender.
2. Production mode contains no demo organizations, synthetic products, prices, orders, invoices, packages, lab values, or account statuses.
3. The role label shown in the header equals the server-authorized membership role.
4. All release contracts and automated tests pass.
5. Canix sync is no more than five minutes old and stale-state behavior displays the last successful snapshot with an IT alert.
6. Canix reconciliation totals account for every package exactly once.
7. Catalog content has an approved source, required fields, correct UOM, and controlled publication status.
8. QuickBooks-backed values show source and freshness and remain read-only outside authorized Internal workflows.
9. Dates display consistently as `MM/DD/YYYY` while APIs and the database retain machine-safe ISO values.
10. Each mutating button has a controlled test proving authorization, valid state transition, audit event, notification behavior, retry/idempotency behavior, and failure-state copy.

## Evidence

- Inventory request/debug capture: `ux-os-audit-2026-10-09-inventory.json`
- Live UI screenshots: `ux-os-audit-2026-10-09-kiosk.png`, `ux-os-audit-2026-10-09-nav.png`, `ux-os-audit-2026-10-09-nav-top.png`
- Local release command: `npm run verify`
- Original audit result: 522 of 524 contracts passed; verification stopped at the two supply-order-webhook contract failures.
- Post-remediation result: 524 of 524 local contracts, eight Node service tests, twelve Deno security tests, and 560 of 560 remote contracts passed.
