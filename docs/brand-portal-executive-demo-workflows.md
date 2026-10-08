# Brand portal executive demo workflows

## Live Monday milestone connection

The production milestone destination is the IT workspace board [UX OS Brand Production Milestones](https://urban915991.monday.com/boards/18433592669).

The portal stores the stable Monday column IDs for:

- Milestone
- Brand Organization ID
- Reference
- Product Name
- Purchase Order ID
- Planned Date
- Started Date
- Completed Date
- Exception Owner
- Exception Note

Only a signed status change from that board's exact Milestone column can update a Brand manufacturing projection. Duplicate callbacks are ignored. The test item `TEST · urbanXtracts · Executive milestone flow` reached `Approved` and returned HTTP 200 through the signed receiver.

## Suggested executive demonstration

### 1. Home

1. Sign in as the Brand-role test user, or use Administrator **View as Brand**.
2. Select urbanXtracts.
3. Point out the Brand-scoped summary, source health, open work, and items needing attention.
4. Explain that the same portal presents different sections and data boundaries for Internal, Brand, Store Owner, Store Buyer, and Budtender users.

Executive point: one identity can see only its approved organization and role-specific work.

### 2. Company and onboarding

1. Open the company profile and review legal name, DBA, license, contacts, addresses, and business documents.
2. Show that sections can be saved independently.
3. Assign a section to the Brand when outside input is needed.
4. Submit the section for Internal review.
5. Approve it or return it with a requested change.
6. When every required section is approved, send the controlled handoff to Monday.

Executive point: onboarding is resumable, reviewable, and audited instead of being a single all-or-nothing form.

### 3. Agreements

1. Review the agreement checklist derived from the relationship activities.
2. Show that an agreement can be required, conditional, not applicable, draft, in review, current, or archived.
3. Submit agreement metadata and an optional PDF.
4. Internal Operations or Administration reviews and publishes the official version.
5. Publishing a replacement archives the former current version.
6. Review the renewal owner and renewal dates.

Executive point: Brands may contribute documents, but only urbanXtracts publishes the official contract record.

### 4. Products and SKUs

1. Start a SKU intake or resume a partial draft.
2. Complete the assigned sections for product identity, formulation/BOM, packaging, quality, labels, and marketing.
3. Send only the needed section to the external contributor.
4. Submit completed sections for Internal review.
5. If an approved section changes, reopen that section and require approval again.
6. Reconcile the approved product to Canix by Product ID or the approved exact product-name-plus-Brand rule.
7. Show Marketplace publication, price, image state, and publication exceptions without treating Marketplace availability as physical inventory.

Executive point: product creation is collaborative, but identity and publication remain controlled.

### 5. Purchase orders

1. Search the Brand-scoped catalog or filter it by Brand.
2. Review the approved image, availability band, unit price, units per case, and case price on each product card. Exact internal inventory quantities remain hidden.
3. Choose cases or units where an approved case size exists, select the quantity, and add as many items as needed to one shopping cart.
4. Enter the needed-by date, shipping destination, optional Brand reference, and order-level notes. Draft changes are saved in the Portal and can be resumed after a later sign-in.
5. Submit the full purchase order for Internal review. The Portal freezes the approved unit price, case size, and line total used at submission.
6. In the Internal **Brand purchase orders** page, an Administrator reviews and advances the order through approval, scheduling, production, quality review, ready to ship, shipped, delivered, and completed.
7. Record each shipment and receipt against a specific order line. Partial shipments, multiple shipment references, carrier/tracking details, manifests, proof of delivery, damages, rejections, and refusals remain attached to the order timeline.

Executive point: the Portal owns the catalog-to-fulfillment history and preserves the commercial terms used for the order; it does not create an uncontrolled QuickBooks transaction.

### 6. Inventory

1. Open the Brand inventory view.
2. Show final units, bulk inventory, and plant material as separate lanes.
3. Filter by the verified Canix Owner boundary.
4. Explain available versus allocated status.
5. Confirm that another Brand's inventory and Internal-only economics are absent.

Executive point: Canix remains the physical inventory source, while Owner—not Brand name—defines the organization boundary.

### 7. Sales and distribution

1. Review unit totals by product.
2. Change the reporting period to show monthly totals.
3. Review the order and shipment milestone sequence.
4. Demonstrate source labels: Portal for ordering, Monday for operations, Canix for compliance manifests, and QuickBooks for approved financial figures.
5. Show that retailer and store identities are withheld from Brands.
6. Download the approved aggregated report when the role permits it.

Executive point: Brands receive useful performance reporting without exposing urbanXtracts' customer relationships.

### 9. Financials

1. Review the approved QuickBooks relationship for the Brand.
2. Show invoices, credits, balances, aging, and payment history when Finance has verified the mapping.
3. Show the Finance gate when the relationship or reporting period is not approved.
4. Explain that financial records are read-only.
5. Show masked banking setup status only; never enter full account or routing numbers.

Executive point: QuickBooks remains authoritative, and Finance controls when Brand-visible dollars are approved.

### 10. Marketing materials

1. Review approved product descriptions, claims, sell sheets, and publication requests.
2. Show the Monday approval state for each content item.
3. Explain that only approved assets are published from the protected document store.
4. Note that product-image work is currently on hold and will resume without changing the product identity model.

Executive point: commercial content has an approval path separate from Canix inventory identity.

### 11. Documents and procedures

1. Open the current controlled documents.
2. Show items requiring acknowledgement.
3. Open a recently updated document and its version evidence.
4. Review archived versions rather than deleting history.
5. Explain that supplied files are malware-scanned and remain private.

Executive point: the portal preserves controlled evidence and version history while sensitive quality publishing remains off-portal.

### 12. Users

1. Invite a Brand user to the selected Brand organization.
2. Assign Brand Owner, Manager, Contributor, or Viewer.
3. Show how the navigation changes with the role.
4. Change or deactivate access and confirm the effect is immediate.
5. Review the access history.

Executive point: authentication proves identity; organization membership and role determine what the user can actually see and do.

## Closing the demonstration

1. Return to Internal **Release readiness**.
2. Open **Completed → Orders and Monday**.
3. Show **Brand production milestone return — PASS**.
4. Point out the board ID, signed verification item, latest callback HTTP 200, and single active webhook.
5. Close by distinguishing live controls from held decisions: held items stay visible in the decision register and are not represented as complete.
