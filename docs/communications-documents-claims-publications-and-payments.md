# Communications, documents, claims, publications, and payments

Updated 14 September 2026. This document records the implemented foundation and the release gates that remain deliberately closed. The customer Store API is excluded from the product.

## Malware scanning

The selected scanner is [ClamAV](https://www.clamav.net/), a free, open-source malware engine. UX OS wraps it in `services/document-scanner` and calls only the HTTPS wrapper; the ClamAV daemon socket is never exposed to the Internet. The wrapper requires a 32-character-or-longer bearer secret, accepts at most 20 MiB, verifies the caller's SHA-256 digest, times out, and returns only `clean` or `infected`. Any timeout, configuration problem, engine error, digest mismatch, or unexpected response fails closed.

Clean onboarding documents may be archived privately and transferred to the exact Monday onboarding item. Infected documents are never stored by UX OS or sent to Monday. Product images and portal-managed COAs require both a clean scan and approval by a different authorized user. Only active, scan-cleared assets receive a short-lived signed URL.

ClamAV software is free. Hosting is not guaranteed to be free: the production container needs at least 2 GiB memory and incurs the hosting provider's normal usage charges beyond any free allowance. Signature updates are included when the image is rebuilt; Operations should rebuild on a regular schedule and immediately for an urgent signature release.

Production variables:

- `DOCUMENT_SCANNER_URL`
- `DOCUMENT_SCANNER_SHARED_SECRET`
- `PORTAL_ASSET_UPLOADS_ENABLED` remains `false` while product images are on hold

Acceptance requires a clean PDF/image test, an EICAR test-file rejection, an unavailable-engine test, a too-large-file rejection, and confirmation that no unscanned active asset is returned.

## Notification sender and channel policy

Resend is the selected transactional email provider. Its free plan can support initial controlled use, but current limits and pricing must be checked before production volume is approved. A dedicated sending subdomain such as `updates.urbanxtracts.com` must pass SPF and DKIM verification. UX OS stores the API key and signed-webhook secret only in Supabase.

Every message first creates a durable outbox record. The provider call uses the outbox ID as its idempotency key. Signed Resend events change the record from sent to delivered, bounced, or failed. The exact template version, recipient, payload, timestamps, provider message ID, and failure summary are retained as delivery evidence.

Channel policy:

| Message class | In portal | Email | User may mute | Release rule |
| --- | --- | --- | --- | --- |
| Account, onboarding, license, order-state, payment receipt, receiving-claim, COA amendment, recall | Yes | Yes | No | Approved template; recall additionally requires Compliance-approved trigger and exact copy |
| How-to guides and welcome education | Yes | On one-click request | Yes | Approved template |
| Integration failure | Internal only | IT/Operations | No | Never disclose secrets or raw provider responses |
| Marketing or promotional messaging | No | No | Not applicable | Outside UX OS v1 |

The approved library contains store welcome, Kiosk Mode guide, order guide, user-management guide, onboarding received, onboarding needs information, store ready, license expiry, order received, order-state change, invoice notice, payment receipt, receiving claim received, internal claim review, amended COA, held recall copy, Canix sync failure, and generic integration failure templates. The invoice action selects the latest open QuickBooks invoice and sends only to active Owners and assigned Buyers for the mapped retailer.

Production variables:

- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `PORTAL_EMAIL_FROM`, recommended `urbanXtracts Portal <portal@updates.urbanxtracts.com>`
- webhook: `https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/portal-notifications?webhook=resend`

## Receiving claims

Owners and assigned Buyers may create a claim only against a delivered order line within their accessible store scope. Supported types are short, damaged, wrong item, refused, and other. The database locks the line and prevents cumulative non-denied claims from exceeding the delivered quantity. Sales, Operations, and Administrators may review and decide claims.

No claim automatically creates a QuickBooks credit, refund, replacement, payment change, or Canix adjustment. The claim window and evidence requirement remain blank while Operations decides them. This lets UX OS record the exception without inventing a service promise. Evidence upload will use the same scan-cleared private document path before it becomes required.

## Document retention and legal holds

The policy register records a five-year floor for applicable distribution books, records, invoices, COAs, lot traceability, and recall evidence. Other five-year values are proposals pending Compliance/Finance approval. Ninety-day quarantine and 365-day superseded-asset periods are technical proposals. Automatic deletion is disabled for every class.

A legal hold overrides any retention date. Before automated disposition exists, Compliance must approve the class, start event, period, wind-down procedure, reviewer, deletion evidence, and backup treatment. Active assets and open matters never receive an automatic purge decision.

## Public COA and recall publishing

Authorized Quality or Administrators may create a durable COA or recall draft. A different authorized user must approve it. Publication requires a separate production flag and security secret. Published codes are random, non-sequential, stored only as hashes, rate-limited, and resolved through a route that gives the same response for unknown and unpublished records. Revocation is immediate.

Only an approved display payload and an optional short-lived URL to an active, scan-cleared COA can be returned publicly. Retailer identity, pricing, quantities, ownership, source-system links, and internal notes are excluded. Recall publication and recall email remain disabled until the CCO approves the trigger, exact wording, affected audience, acknowledgement rule, and retention treatment.

Production variables, intentionally unset until approval:

- `PUBLICATION_RELEASE_ENABLED=true`
- `PUBLIC_RESOLVER_RATE_SECRET`

## Payment collection

The prepared payment flow uses Stripe-hosted Checkout so card data never enters UX OS. An Owner, or a Buyer uniquely assigned to the invoice's store, may start payment only for the exact open balance in the latest production QuickBooks snapshot. The payment attempt ledger records creation, hosted-session state, signed completion, expiry, and later reconciliation.

The webhook never marks an invoice paid in QuickBooks and never changes ordering status. Finance must reconcile the provider receipt to QuickBooks and approve refunds, disputes, partial payments, convenience fees, and accounting treatment before production enablement.

Production variables, intentionally unset until approval:

- `PAYMENT_COLLECTION_ENABLED=true`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- webhook: `https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/portal-payments?webhook=stripe`

## Explicit exclusion

UX OS does not issue a customer Store API credential and exposes no customer Store API. A future API would be a separate product and security review, not an extension of this release.
