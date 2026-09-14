# Communications, documents, and claims

Updated 14 September 2026. This document records the implemented foundation and the release gates that remain deliberately closed. Customer Store API access, public COA/recall publishing, and payment collection are excluded from the portal.

## Malware scanning

The selected scanner is [ClamAV](https://www.clamav.net/), a free, open-source malware engine. UX OS wraps it in `services/document-scanner` and calls only the HTTPS wrapper; the ClamAV daemon socket is never exposed to the Internet. The wrapper requires a 32-character-or-longer bearer secret, accepts at most 20 MiB, verifies the caller's SHA-256 digest, times out, and returns only `clean` or `infected`. Any timeout, configuration problem, engine error, digest mismatch, or unexpected response fails closed.

Clean onboarding documents may be archived privately and transferred to the exact Monday onboarding item. Infected documents are never stored by UX OS or sent to Monday. Product images require both a clean scan and approval by a different authorized user. Only active, scan-cleared images receive a short-lived signed URL. COA administration and uploads stay off-portal.

ClamAV software is free. Hosting is not guaranteed to be free: the production container needs at least 2 GiB memory and incurs the hosting provider's normal usage charges beyond any free allowance. Signature updates are included when the image is rebuilt; Operations should rebuild on a regular schedule and immediately for an urgent signature release.

Production deployment completed on 14 September 2026. Cloud Run service `ux-portal-document-scanner` runs in `us-west1` with a dedicated service account, one-request concurrency, zero minimum instances, two maximum instances, and its bearer credential supplied from Secret Manager. The portal URL and matching credential are stored only as Supabase function secrets. Acceptance returned the required results: health `200`, clean file `200`, EICAR `422`, invalid credential `401`, digest mismatch `409`, and oversized body `413`.

Production variables:

- `DOCUMENT_SCANNER_URL`
- `DOCUMENT_SCANNER_SHARED_SECRET`
- `PORTAL_ASSET_UPLOADS_ENABLED` remains `false` while product images are on hold

The direct production service acceptance is complete. Portal behavior remains fail-closed when the scanner is unavailable, and the asset query returns only active, scan-cleared records. Product-image uploads remain disabled by the separate release flag. COA administration and uploads are not a portal capability.

## Notification sender and channel policy

Resend Free is the selected transactional email provider. As checked on 14 September 2026, the plan is $0 for up to 100 emails per day and 3,000 emails per month, with paid overage unavailable on the free plan. UX OS enforces both ceilings atomically and holds additional messages instead of attempting delivery. A dedicated sending subdomain such as `updates.urbanxtracts.com` must pass SPF and DKIM verification. UX OS stores the API key and signed-webhook secret only in Supabase.

Every message first creates a durable outbox record. The provider call uses the outbox ID as its idempotency key. Signed Resend events change the record from sent to delivered, bounced, or failed. The exact template version, recipient, payload, timestamps, provider message ID, and failure summary are retained as delivery evidence.

Channel policy:

| Message class | In portal | Email | User may mute | Release rule |
| --- | --- | --- | --- | --- |
| Account, onboarding, license, order-state, and receiving-claim | Yes | Yes | No | Approved template and verified recipient scope |
| How-to guides and welcome education | Yes | On one-click request | Yes | Approved template |
| Inventory, Monday, QuickBooks, access, pricing, and other integration failures | Internal only | IT/Operations | No | Never disclose secrets or raw provider responses |
| Marketing or promotional messaging | No | No | Not applicable | Outside UX OS v1 |

The approved store library contains welcome and first steps, Kiosk Mode instructions, order instructions, user-management instructions, onboarding received, onboarding needs information, store ready, license expiry, order received, Store Owner approval required, order-state change, invoice notice, QuickBooks payment recorded, receiving claim received, and receiving-claim status change. The internal library contains new-onboarding review, receiving-claim review, workforce access request, license review due, Canix failure, Monday order-delivery failure, QuickBooks failure, pricing identity review, approval aging, general integration failure, and a daily operations digest. Public COA, recall, and portal-collected payment templates are retired. The invoice action selects the latest open QuickBooks invoice and sends only to active Owners and assigned Buyers for the mapped retailer.

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

## Explicit exclusion

UX OS does not issue a customer Store API credential, publish public COA or recall records, send recall notices, or collect payments. Financials remain a read-only QuickBooks projection, and payments occur through the separately approved cannabis-banking process. Reconsidering any excluded capability requires a separate product, compliance, finance, and security review.
