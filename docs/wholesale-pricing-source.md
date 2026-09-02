# Wholesale pricing source

The current wholesale source is the Google Sheet **Order Sheet (urbanXtracts + Brands Live Menu) 08.27.26**, tab `ACTIVE CART` (`gid=1220163199`). UX OS treats this sheet as an operator-maintained price source, not as the catalog product master. Canix `item_id` remains the product identity used by inventory, catalog, and ordering.

## Read-only audit · 2 September 2026

- The price table begins on row 8 and contains 118 populated price rows through row 140.
- Fields available per row are product name, optional profile/strain, terpene value, THC value, case size, per-unit wholesale price, and per-case wholesale price.
- Brand is represented by visual section headings rather than a value on every product row. Sections include urbanXtracts, Jerry Garcia, CannaDots, HoneyPot, Cannatela, Leilala & Watson, Joke n Toke, Satori, Rosa Reta, Moondust, Royal Genetics, Wana, Made in Xiaolin, and Flash.
- The source has no immutable Canix item or package identifier.
- Against the current 559-item Canix catalog snapshot, only 8 rows produced a unique normalized product-name + Brand match. Three additional rows matched a product name without a verified Brand; 107 rows require a reviewed crosswalk.
- Product images remain out of scope and are not imported from this sheet.

## Staged portal workflow

All 118 `ACTIVE CART` price rows are now copied into the protected `portal_wholesale_price_source` staging table with their source document, tab, row number, section-derived Brand, product details, case values, and unit price. The portal's internal **Wholesale list to Canix review queue** derives exact, normalized, collision, Brand-conflict, and no-match states against the latest CountBased Canix snapshot. The source spreadsheet remains unchanged.

Administrator, Operations, and Sales users can verify an exception only by supplying a current unused Canix Item ID and a review note. The server rechecks the latest Canix snapshot and records the reviewer. Verification does not publish a price. A separate publication action creates the active default wholesale price; an approved store-specific price still takes precedence in Catalog and order intake.

## Publication rule

1. Stage every source row with its sheet row number, section-derived Brand, case size, unit price, and case price.
2. Automatically associate only a unique exact product-name + Brand match to a current `canix:item:<item_id>` record.
3. Treat normalized-name candidates, name-only matches, duplicate Canix names, Brand conflicts, and missing Brand as review-required.
4. Publish the per-unit value as the default wholesale list price only after the Canix identity is verified. Preserve case size and per-case value as separate fields; never infer one by dividing or multiplying when the source values disagree.
5. Store-specific approved prices continue to override the default list price. Retailer Owner or Buyer proposals remain store-scoped and require internal approval.
6. Record source document ID, sheet tab, row number, import timestamp, reviewer, and publication event so every price is auditable and reversible.

The source is staged. Bulk publication remains intentionally blocked for every unverified row until it receives a reviewed Canix Item ID or the source sheet adds an immutable Canix Item ID column. Only unique exact product-name + Brand pairs may use the protected batch-verification action; every other row requires an explicit reviewer note.
