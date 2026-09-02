# Catalog, product content, and COA setup

## Source boundaries

- Canix owns item/package identity, compliance tags, availability, allocation, lab state, original COA pointers, and any structured cannabinoid or terpene values it returns.
- Monday owns descriptive product content: descriptions, selling points, ingredients, usage information, product profile, images, and search keywords.
- The portal owns the protected projection, access rules, store pricing, ordering workflow, accepted-order commitments, and an audit trail. Canix remains the source inventory ledger; portal commitments only prevent accepted portal demand from consuming the same snapshot units twice.
- Product grouping is one catalog product per Canix `item_id` (`canix_item_id_v1`). This is the approved v1 contract: the 1 Sep 2026 live audit found `product_id` missing on 958 of 1,359 active non-sample packages, while `item_id` preserves SKU and format identity. Name-based fallback grouping is prohibited.

## Deployment order

1. Apply `20260901190000_catalog_content_and_coa.sql`, then `20260901240000_canix_availability_contract.sql`, then `20260901250000_security_and_inventory_commitments.sql`.
2. Deploy the updated `canix-inventory` function so the next successful snapshot normalizes COA, lab, and explicit source-package fields.
3. Deploy `portal-product-content` with JWT gateway verification disabled, set `MONDAY_PRODUCT_SECRET` to a high-entropy server-only value for push compatibility, and set `PORTAL_EXTERNAL_ASSET_HOSTS` to the comma-separated exact hostnames approved for COAs and product images. The function performs its own dual authentication because Monday has no Supabase user JWT; browser requests still require and validate a Supabase bearer token. The dedicated Monday OAuth app is the primary pull path and uses the pinned product board plus automatically rotated server-custodied tokens.
4. Deploy the updated `canix-catalog` function.
5. Deploy the rebuilt portal.

The migration adds `catalog.manage` to Administrator, Operations, and Sales. Product content tables, COA tables, and COA revision history have RLS enabled and grant no direct browser access.

## Live Monday source

The selected source is board `9620649212`, **SKUs - Final Product Specification Matrix**. On 1 September 2026 the following portal columns and a dedicated **Portal Catalog Content** table view were added without changing existing specification, cost, or approval values:

| Portal contract field | Monday column | Column ID |
| --- | --- | --- |
| `canixItemId` | Canix Item ID | `text_mm6shxmd` |
| `publicationState` | Portal Publication | `color_mm6sxyjd` |
| `shortDescription` | Portal Short Description | `long_text_mm6srkee` |
| `longDescription` | Portal Long Description | `long_text_mm6s9nke` |
| `sellingPoints` | Portal Selling Points | `long_text_mm6sf7mn` |
| `ingredients` | Portal Ingredients | `long_text_mm6sj45t` |
| `usageInformation` | Portal Usage Information | `long_text_mm6snz4t` |
| `productProfile` | Portal Product Profile | `long_text_mm6s7859` |
| `imageUrl` | Portal Image URL | `link_mm6scxse` |
| `keywords` | Portal Search Keywords | `long_text_mm6svyb9` |

The view ID is `278640861`. All new fields begin blank and the publication state begins unset, which is treated as non-published. No record may be synced by name: each publishable row first needs a positive Canix Item ID present in the latest successful Canix snapshot.

An Administrator can run **Sync catalog content** from Release readiness. The scan reads all pages from board `9620649212`, rejects duplicate or invalid Canix IDs, skips rows without an explicit publication state, verifies every remaining ID against the current Canix snapshot, and records a count-only administrative audit. It never derives a link from the product name. Monday OAuth access tokens renew automatically within five minutes of expiry and the rotated refresh token replaces the prior encrypted token.

The board's existing file links use Monday's `protected_static` host and redirect an unauthenticated request to Monday sign-in. They are not valid retailer-facing catalog assets and must not be added to `PORTAL_EXTERNAL_ASSET_HOSTS`. **Portal Image URL** must point to an IT-approved public CDN or a portal-controlled signed/proxied asset URL after redirect, MIME, malware-scanning, and retention behavior are approved. Until then, images and document links remain blank in the external catalog.

## Monday product-content contract

Send a `POST` request to `portal-product-content` with `x-ux-monday-secret: <MONDAY_PRODUCT_SECRET>`. The Canix item must be present in the latest successful Canix snapshot. A request may contain one record or an `items` array of up to 100 records.

```json
{
  "canixItemId": 123456,
  "mondayItemId": "9876543210",
  "mondayBoardId": "1234567890",
  "publicationState": "published",
  "shortDescription": "Concise factual product description.",
  "longDescription": "Optional extended product description.",
  "sellingPoints": ["Factual point one", "Factual point two"],
  "ingredients": "Regulated ingredient copy from the product record.",
  "usageInformation": "Approved usage information.",
  "productProfile": "Factual product profile without effects or medical claims.",
  "imageUrl": "https://example.invalid/product-image.jpg",
  "keywords": ["search term", "format"],
  "sourceUpdatedAt": "2026-09-01T20:00:00Z"
}
```

Supported publication states are `draft`, `published`, and `archived`. Only `published` content is joined into the catalog. Updates are patch-like: omitted fields retain their prior value, while explicit empty values clear a field. Image URLs must use HTTPS on an exact host in `PORTAL_EXTERNAL_ASSET_HOSTS`. Each accepted change writes a `portal_product_content_event` row.

For the Monday mapping, split **Portal Selling Points** on non-empty lines and split **Portal Search Keywords** on commas or non-empty lines. Map the Monday status labels `Draft`, `Published`, and `Archived` to the lowercase API values. Do not send a row whose Canix Item ID is blank or invalid.

An authenticated internal user with `catalog.manage` may use the same endpoint without the Monday secret. `GET portal-product-content` returns all states to catalog managers and only published records to other active users.

## Canix normalization

The inventory sync preserves the raw package payload and normalizes only fields that Canix explicitly supplies. It recognizes direct package COA fields and common nested lab-result shapes for:

- original HTTPS COA URL and source document ID;
- lab name, batch number, and test timestamp;
- cannabinoid name, supplied value, and supplied unit;
- terpene name, supplied value, and supplied unit;
- shallow factual lab-profile fields;
- explicit parent/source package IDs.

No value is calculated, copied from another lot, or interpreted. When a normalized COA changes, the previous version is retained in `canix_package_coa_history` and the current version increments. A missing field stays blank.

## Catalog privacy and release rules

- External catalog users receive available, count-based packages only.
- Sellable means an active package with Canix `status_category = 'available'`. The free-form display status is never the decision field.
- When Canix explicitly supplies a reservation amount, it is subtracted from count-based orderable units. Unknown reservation data stays marked unknown rather than being written as zero.
- Failed lab packages are excluded.
- Only `TestPassed` package units count as released. Mixed items are labelled as having limited released inventory rather than implying the entire item is released.
- When requested quantity exceeds passing units but remains within total nonfailed orderable units, the complete line is a pre-order and is held from processing/delivery until passing units cover active commitments.
- Allocated packages are returned only to internal users and are labelled unavailable to order.
- The catalog response does not contain exact on-hand quantity, cost, sales-order allocation, Cost Object, or owner-only accounting fields.
- Weight-based cultivation and processing material remains in Inventory, not the retailer catalog.
- Order intake rechecks the requested total against current available Canix units, and the database atomically subtracts active portal commitments before accepting each line. Errors do not disclose the available total.
- Whole-case enforcement is a per-store policy and defaults off. When enabled, intake requires one positive, unambiguous Canix `case_quantity` per item and rejects non-multiples. Minimum order and lead time stay blank because they are not in the connected reporting contract.
- Retail users may inspect package-specific COAs but cannot choose a fulfillment lot. The submitted compliance tag is blank until urbanXtracts allocates the package through the fulfillment workflow.

## Verification

- Search Catalog and Kiosk by product, SKU, strain, keyword, cannabinoid, terpene, or supplied lab value.
- Open a product and confirm Monday content is attributed, lot selection changes the COA fields, and missing data stays blank.
- Confirm an original COA link appears only when Canix returned HTTPS on an approved exact host; unapproved and deceptive-suffix hosts must stay blank.
- Confirm a Monday `protected_static` URL is rejected rather than exposed to a retailer, and confirm the approved replacement host is exact-matched before any asset is displayed.
- In Lineage, search by tag or lab field and filter by COA presence. Confirm parent/source IDs appear only when Canix supplied them.
- Compare an external and internal catalog response. External responses must contain no allocated lots or exact quantities.
- Submit more units than Canix currently reports orderable and confirm the server rejects the request without returning the available total. Confirm a normal order reaches Monday without a retailer-selected tag.
- Test a store with case enforcement off, then on. With enforcement on, confirm a valid whole-case line passes, a non-multiple fails, and a missing/ambiguous Canix case quantity fails closed.
- Change a Canix COA record, run a new sync, and confirm the prior normalized version is retained.
- Archive a Monday product record and confirm its merchandising content disappears while the Canix product identity remains available.
