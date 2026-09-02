# QuickBooks financial visibility

The portal reads QuickBooks Customers, Invoices, and Payments through one server-side OAuth connection. QuickBooks remains authoritative. This release displays financial history only; it does not collect payments, retain bank details, or create accounting transactions.

## Deploy

1. Apply `20260901210000_quickbooks_financials.sql`, `20260901290000_quickbooks_oauth_broker.sql`, `20260902020000_quickbooks_intuit_trace_ids.sql`, and `20260902030000_quickbooks_sync_cron.sql`.
2. Deploy `quickbooks-oauth`, the updated `quickbooks-retailers`, `quickbooks-financials`, and `portal-readiness` Edge Functions.
3. Register this exact Intuit redirect URI:
   - `https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/quickbooks-oauth/callback`
4. Keep these values server-side:
   - QBO_CLIENT_ID
   - QBO_CLIENT_SECRET
   - QBO_TOKEN_ENCRYPTION_KEY (at least 32 random characters; keep it stable)
   - QBO_CRON_SECRET
   - QBO_REDIRECT_URI (optional when using the exact default above)
   - QBO_PORTAL_RETURN_URL (optional until the production domain is approved)
5. Keep JWT gateway verification disabled only if the function is configured to self-authenticate exactly as implemented. Portal start/status routes require a valid Administrator token, the callback consumes a one-time OAuth state, and the sync POST additionally accepts the scheduler-only secret.
6. Sign in as a portal Administrator, open Release readiness, and choose **Connect QuickBooks**. The callback stores the realm and encrypted refresh token server-side. Do not copy a refresh token manually.
7. Store the same strong random value as the Edge Function secret `QBO_CRON_SECRET` and the database Vault secret `qbo_cron_secret`, then call `portal_enable_quickbooks_sync_schedule()` as the database owner. The function creates the five-minute POST schedule only when the Vault value exists. A successful sync refreshes Customers, Invoices, and Payments together.

The OAuth state is stored only as a ten-minute SHA-256 hash and is consumed atomically. The refresh token is encrypted with the Edge-Function-only encryption key. The sync persists every rotated Intuit refresh token before querying data. It writes Invoice and Payment rows under a new run ID and changes last_financial_run_id only after the complete run succeeds. A failed or partial refresh therefore leaves the prior complete snapshot readable.

OAuth and Accounting API failures retain the sanitized `intuit_tid` response header in the protected QuickBooks sync state so an administrator can give Intuit Support the correlation ID. The portal does not persist or log the raw Intuit response body, access token, or refresh token as diagnostic data. A successful authorization or complete sync clears the prior support ID.

The OAuth broker resolves the current authorization and bearer-token endpoints from Intuit's production discovery document, rejects non-HTTPS or unexpected endpoint hosts, and fails closed when discovery is unavailable. Read-only Accounting API `GET` queries retry transient network, 429, and 5xx failures at most three times with a short bounded backoff. Authorization-code and rotating refresh-token exchanges are not automatically replayed because those POST operations can consume one-time or rotating credentials; the portal records the failure and requires a fresh connection attempt when needed.

The Intuit accounting scope is broader than the portal's feature set. UX OS enforces read-only behavior in application code: the connector issues only query `GET` operations for Customer, Invoice, and Payment. It exposes no create, update, delete, payment-collection, or invoice-generation route.

## Intuit production-key handoff

The dedicated Intuit app is registered on the no-charge Builder tier. Its development credentials and redirect URI are configured. Payments permission is not enabled, accepted connections are limited to the United States, and `portal.urbanxtracts.com` is now the approved launch/connect/disconnect return host. The portal remains disconnected and no successful financial snapshot exists.

Production credentials remain intentionally locked until two owner decisions are complete:

- Choose hosting with a truthful, stable US IP address or range for Intuit's geolocation declaration. The current distributed preview/Supabase path does not provide a verified static address, so no guessed IP was submitted.
- Have an authorized urbanXtracts representative complete the Intuit app-assessment answers concerning complaints or investigations, legal counsel, sanctions, and acceptance of Intuit security requirements. Technical answers may be prepared by Engineering, but those organizational attestations must come from the company.

After those items, add the production callback URI, replace the development client credentials in Supabase with the production pair, and use **Connect QuickBooks** from Release readiness to authorize `URBANXTRACTS INC`. Do not authorize the live company with development credentials; those are sandbox-only.

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
- Force an Intuit API error and confirm its `intuit_tid` appears only in internal Release readiness, then clears after the next successful connection or sync.
