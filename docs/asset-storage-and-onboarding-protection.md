# Private assets and public-onboarding protection

## Product images and COAs

The portal uses the private Supabase Storage bucket `portal-assets`. It accepts only JPEG, PNG, WebP, and PDF files, has a 20 MiB bucket limit, and has no browser-readable Storage policy.

`portal-assets` is the only asset-management endpoint:

1. An active internal user with `catalog.manage` creates a signed product-image upload for a current Canix item. A user with `quality.manage` may create a PDF COA upload for a current Canix package.
2. The upload is recorded as `pending_upload`. Completing it verifies that the stored object exists and that its observed size and MIME metadata match the declaration. A mismatch is quarantined.
3. A separate review action changes a valid upload from `pending_review` to `active` or `quarantined`. Activation, prior-version archival, and the product/COA link occur in one database transaction under an advisory lock.
4. Only active assets receive five-minute signed read URLs from `canix-catalog`. Pending, quarantined, and archived files never appear in catalog responses.

The current Monday `protected_static` host remains prohibited. Monday should populate product copy and the positive Canix Item ID; an authorized portal workflow uploads and approves the durable image separately.

Before production use, Quality and IT still need to decide whether manual review is sufficient or an automated malware/content scanner is mandatory, who may approve an upload they created, and retention for quarantined and archived versions.

## Public onboarding

The portal renders an explicit Turnstile widget for signed-out onboarding when the hosting worker receives `UX_TURNSTILE_SITE_KEY`. The server fails closed for those public requests when production sets:

- `TURNSTILE_REQUIRED=true`
- `TURNSTILE_SECRET_KEY` as a server secret
- `TURNSTILE_ALLOWED_HOSTS` as an exact comma-separated hostname list
- `PUBLIC_INTAKE_RATE_SECRET` as a distinct high-entropy server secret
- `PUBLIC_ONBOARDING_DAILY_LIMIT` between 1 and 20; default 3

The hosting worker must also set `UX_TURNSTILE_REQUIRED=true` when the server flag is enabled. The browser sends the single-use token with action `retailer_onboarding`; the server verifies that action and the exact Siteverify hostname. The production widget should authorize only `portal.urbanxtracts.com`. Use Cloudflare's published test keys for local automation rather than adding localhost to the production widget.

For an unauthenticated onboarding request, the server verifies the Turnstile token without storing or forwarding the visitor IP address. It then HMACs the normalized owner email and atomically claims a UTC-day submission slot. The database never stores the raw rate-limit identifier. The Turnstile token is removed before the request is persisted or sent to Monday.

Enable `TURNSTILE_REQUIRED` and `UX_TURNSTILE_REQUIRED` together only after the production site key, secret, and exact hostname are installed and the public form passes an end-to-end submission test. Authenticated Owners and internal users do not receive the public challenge; their normal portal identity and authorization continue to apply.
