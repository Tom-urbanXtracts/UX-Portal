# QuickBooks financial visibility

The portal reads QuickBooks Customers, Invoices, and Payments through one server-side OAuth connection. QuickBooks remains authoritative. This release displays financial history only; it does not collect payments, retain bank details, or create accounting transactions.

## Deploy

1. Apply 20260901210000_quickbooks_financials.sql.
2. Deploy the updated quickbooks-retailers Edge Function.
3. Deploy quickbooks-financials.
4. Keep these values server-side:
   - QBO_CLIENT_ID
   - QBO_CLIENT_SECRET
   - QBO_REALM_ID
   - QBO_REFRESH_TOKEN
   - QBO_CRON_SECRET
5. Keep JWT gateway verification disabled only if the function is configured to self-authenticate exactly as implemented. Both portal functions still require a valid Supabase user token; the sync POST additionally accepts the scheduler-only secret.
6. Schedule a POST to quickbooks-retailers at the accounting-approved cadence. A successful sync refreshes Customers, Invoices, and Payments together.

The sync persists a rotated Intuit refresh token before querying data. It writes Invoice and Payment rows under a new run ID and changes last_financial_run_id only after the complete run succeeds. A failed or partial refresh therefore leaves the prior complete snapshot readable.

## Data retained

The normalized cache keeps:

- Customer identity, display name, active state, balance, parent reference, currency, email, billing city, and source timestamps.
- Invoice customer, document number, transaction/due dates, original amount, balance, delivery statuses, currency, and source timestamps.
- Payment customer, date, total, unapplied amount, non-sensitive payment-method label, invoice allocations, currency, and source timestamps.

The financial cache does not retain invoice line items, bank or deposit accounts, card/check details, remittance instructions, tax identifiers, or full raw Invoice/Payment payloads. The updated Customer sync also empties the legacy raw-payload column.

## Access policy

- Administrator, Operations, and Sales receive financials.read.
- Store Owners see the organization-level QuickBooks customer and all directly mapped stores in their organization.
- Buyers see only directly mapped QuickBooks customers for stores assigned in portal_profile_store.
- If a Buyer-assigned store has no direct QuickBooks customer, its financial values remain blank.
- If a QuickBooks customer is shared with a store outside the Buyer's assignment, or a parent organization customer covers an unassigned store, that customer is withheld rather than risking organization-wide leakage.
- Budtenders, Quality, and Viewer workforce presets receive no financial endpoint access.

Browser navigation is not the authorization boundary. quickbooks-financials re-resolves the signed-in profile, role, organization, assignments, retailer account, store mappings, and workforce permission before reading the server-only cache.

## Ordering boundary

Invoice state is derived for display:

- paid: balance is zero.
- past_due: balance is non-zero and the due date is earlier than today.
- open: balance is non-zero and is not past due.

These labels never create or clear an ordering hold. Order intake continues to read the portal-owned portal_store.ordering_status and explicit hold reason. A non-zero QuickBooks balance is not treated as an ordering decision.

## Verification

- Sync a QuickBooks sandbox containing at least two customers, an open invoice, a past-due invoice, a paid invoice, and two payments.
- Confirm the state row changes to one new last_financial_run_id only after all three entity queries complete.
- Force the Payment query to fail and confirm the prior invoices and payments remain visible with a stale warning.
- Confirm an Owner sees all mapped stores in their organization and no other retailer.
- Confirm a Buyer sees only assigned, directly mapped stores.
- Map one QuickBooks customer to two stores, assign the Buyer to only one, and confirm the shared financial rows are withheld. Repeat with the parent organization customer mapped to the assigned store while another organization store remains unassigned.
- Confirm a Budtender receives 403.
- Confirm Sales, Operations, and Administrator receive data; Quality and Viewer receive 403.
- Confirm filters and sorting do not change the server-authorized customer scope.
- Confirm the page offers no payment action and no API call writes to QuickBooks.
- Confirm a past-due display state does not change portal_store.ordering_status or block an order unless an explicit portal hold already exists.
