# Canix Shop automatic refresh: supported access needed

Reviewed October 14, 2026. Research only: no account access, credential collection, support message, source write, or deployment performed.

## Documented facts

- Canix's ordinary API uses an `X-API-KEY` header. Keys inherit the generating user's permission group, including inventory brand restrictions. The guide documents offset pagination, up to 2,000 objects per call, and facility filtering. These are ordinary API rules, not confirmed Shop GraphQL rules. [Canix API Guide](https://help.canix.com/hc/en-us/articles/40887688340756-Canix-API-Guide-old-user-interface)
- A Shop Product can link multiple Canix Items. The Shop guide distinguishes sale unit, units per case, minimum quantity, price, images, and listing activation. Product availability reflects available-to-sell inventory minus ordered quantities; requested Shop orders affect availability. It documents a manual PDF menu, not an unattended machine-readable export. [Canix Shop Guide](https://help.canix.com/hc/en-us/articles/37428001852180-Canix-Shop-Guide-old-user-interface)
- Canix's API guide points to [official Swagger documentation](https://api.canix.com/api-docs-swagger/index.html). The browser-readable page did not expose an endpoint schema during this review.

## Not established by these public sources

The reviewed documentation does not establish a supported server-to-server Shop login, a password grant, token refresh contract, Shop API scope, Shop GraphQL authentication, Shop pagination/rate limits, image-link lifetime, or a freshness guarantee. Absence in these reviewed sources is not proof that Canix cannot supply them.

Normal email/password Shop access is human access, not sufficient evidence of a supported unattended integration. Do not extract browser session tokens or automate the user's normal login as the production connector.

## What to request from Canix

1. The supported read-only endpoint or scheduled machine-readable export for the urbanXtracts Shop: `https://app.canix.com/marketplace/urbanXtracts`, distribution facility `4467`, license `OCM-DIST-24-000069`.
2. The approved unattended authentication method: service account/API key/OAuth or equivalent; exact required headers, scopes, facility restrictions, expiration, refresh, rotation, revocation, and secure issuance. Specifically confirm whether ordinary `X-API-KEY` works on `https://api.canix.com/shop/graphql`; do not assume the browser endpoint is a supported integration API.
3. Stable Shop Product IDs and every linked Canix Item ID, Brand ID, facility ID, active/deleted state, update timestamp, product names/categories, image references, prices/currency, sale unit, case quantity, minimum/maximum/increment rules, and available-to-order quantity. Clarify price-per-each versus price-per-case, reservations/order deductions, and image URL expiry.
4. Full and incremental pagination, deleted/unpublished records, quotas, retry/backoff guidance, and webhook/export availability. Confirm the permitted 15-minute catalog refresh, Monday–Friday 6 a.m.–6 p.m. America/New_York, separately from the approved checkout requirement of inventory no older than five minutes.
5. Any integration fee, plan restriction, service-user charge, or required approval. No upgrade is authorized.

## Existing draft review

[Existing service-access request](canix-shop-service-access-request.md) covers endpoint/authentication, read-only access, credential lifecycle, pagination/rates, and unit/case semantics. Add explicit Product-to-all-Item IDs, incremental/deletion handling, pricing currency/basis, image expiry, the business-hours cadence versus checkout freshness distinction, and cost confirmation before sending. Its 120-product count is an earlier observed snapshot, not a permanent expected count.

## Acceptance path after Canix responds

Secure credential entry directly into isolated staging, read-only connectivity validation, complete-page reconciliation, stable ID joins, unit/price validation, stale/outage preservation, and expiry/rotation tests. Keep scheduled refresh off until those tests pass. Production deployment and source writes remain outside this research task.
