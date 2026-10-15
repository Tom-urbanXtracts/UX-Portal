# Portal-native P0 cutover

Status date: October 1, 2026

## Released

- Brand company onboarding is owned by the Portal. Section review, corrections, approval, and audit history are retained in Supabase. Existing Monday records remain read-only history.
- Brand purchase orders are owned by the Portal. A Brand Owner, Brand Manager, or Brand Contributor can save and submit a request. Administrators control review, status, priority, due date, shared notes, and evidence.
- The Brand purchase-order page is now a catalog and shopping cart. It exposes only approved prices, uses item-resolved units, supports approved cases, saves durable drafts, and freezes price/case snapshots on each submitted line.
- Administrators process Brand orders from the dedicated Internal **Brand purchase orders** page. Shipment, receipt, damage, rejection, refusal, manifest, tracking, and proof-of-delivery evidence stay attached to the order line; database controls prevent cumulative fulfillment from exceeding ordered or shipped quantities.
- Store orders and fulfillment are owned by the Portal for new orders. Existing Monday-linked orders retain their source identity and history.
- The Administrator Work queues page combines Brand onboarding, Brand purchase orders, and Store orders. Every work item has an immutable event history and optimistic version checks.
- Work-queue evidence is private, malware-scanned, limited to approved file types, and never treated as approved merely because it was uploaded.
- QuickBooks does not receive automatic invoices or other financial records from a Brand purchase order.
- Monday data was not deleted. Each workflow has an explicit Portal, Monday, Parallel, or Hold source mode and a separate Monday-retention rule.

## On hold

- Store Onboarding migration. Existing production behavior and Monday history are preserved.
- Lots and ownership enforcement, pending the Canix Owner and Lot ID / Cost Object decisions.
- Brand catalog data readiness: Canix item identity, order unit, applicable units per case, and approved wholesale pricing for launch products.
- The formal end-to-end Brand purchase-order production acceptance test.
- Expansion of Brand order notifications beyond the existing controlled submission and status notices.
- Brand reporting expansion, pending approved financial definitions, dimensions, downloads, and confidentiality boundaries.

## Released P1

- Manufacturing is no longer a separate Brand navigation tab. The production and fulfillment states that a Brand needs are shown on its purchase-order timeline; historical Monday manufacturing records remain retained and unchanged.
- Catalog content is Portal-owned. Internal users author drafts in the Portal, and the Portal controls review, approval, scheduling, and publication. Canix remains authoritative for item identity and inventory.
- Administrator remains the owner of every operational queue until department permissions are approved.
- Brand purchase-order notifications are active through the durable notification outbox. Submission sends the Brand confirmation and Administrator alert; later status changes notify the Brand contacts in scope.
- Receiving claims use an approved five-calendar-day submission window, mandatory scan-cleared evidence for shortage, damage, and wrong-item claims, a two-business-day Administrator response target, controlled state transitions, Administrator-only late overrides with reasons, and seven-year post-closure retention. Claims never make automatic accounting changes.

## Additional holds

- Brand Finance rules for sales dollars, statements, settlements, and Brand QuickBooks classification.

## Production verification

- Production database migration applied.
- Nine updated protected functions deployed across the P0 and P1 releases.
- Local release suite passed the current release contracts, eight service tests, and seven security tests.
- Remote anonymous-denial suite passed 409 contracts.
- The production Site version is recorded in the deployment evidence for this release at `portal.urbanxtracts.com`.
- Browser verification covers Administrator workflow controls, Portal catalog authoring, the Brand catalog/cart, the Internal Brand purchase-order queue, and fulfillment evidence.
