# Canix Item Master

## Purpose

Package inventory is not an Item Master. An item can be active or inactive and can exist without any current package. UX OS therefore maintains an independent, read-only snapshot of every record returned by Canix `GET /items`.

The portal continues to treat Canix as the source of truth. It does not create, update, deactivate, or delete Canix items.

## Source and refresh

- Source: Canix REST API `GET /api/v1/items`.
- Grain: one row per authoritative Canix Item ID.
- Scope: active and inactive items across every facility available to the server-side Canix API key.
- Pagination: 2,000 rows per request with stable Item ID ordering and a 100-page safety limit.
- Refresh target: every five minutes through an independent Vault-backed scheduler.
- Failure behavior: the prior complete snapshot remains available. Partial fetches never replace it.

The Item Master sync is fault-isolated from package inventory. Failure of `GET /items` does not prevent the package cache from continuing its own five-minute refresh.

## Data control

The normalized master includes Canix identity, active state, facility, type and subtype, category, Brand, Product Brand, strain, SKU, quantity and case definitions, serving and ingredient fields, integrations, permitted Canix availability totals, and timestamps. Every Item definition is retained, but UX OS publishes availability totals only for WeightBased and CountBased items; it does not measure or publish volume quantities. The complete source object is retained in a private server-only field for future mapping and audit.

Current standard cost is stored privately and is returned only when the signed-in staff role has `economics.manage`. It is never returned to general inventory viewers, and UX OS does not infer a currency when Canix omits one. Canix credentials and raw source objects are never sent to the browser.

Current package coverage is joined by exact Canix Item ID for context. It is not used to decide whether an item exists in the master.

## Portal behavior

Internal inventory users can:

- browse active and inactive items, including items with no current package;
- search by Item ID, name, SKU, Brand, type, strain, description, integration name, or facility;
- filter by active state, facility, quantity type, and package coverage;
- sort every primary table column;
- inspect normalized Item details;
- export the filtered result to a spreadsheet-safe CSV.

Staff with `inventory.sync` can request an immediate complete refresh. Scheduled and administrator-triggered calls remain server-authenticated and never expose the Canix API key.

## Initial production verification

The first complete production refresh on 2 September 2026 published 2,756 distinct Item IDs in two API pages across four facilities. It contains 1,263 active items and 1,493 inactive items. Six hundred ten Item IDs have at least one current package; 2,146 are retained despite having no current package. The sandbox facility contributes 42 item definitions. The independent scheduler is active and Vault-backed, and the completed run left no staged rows or error.

## Authoritative references

- <https://api.canix.com/api-docs-swagger/index.html>
- <https://help.canix.com/hc/en-us/articles/40887688340756-Canix-API-Guide>
- <https://help.canix.com/hc/en-us/articles/360057569371-Facility-Data-Locations-Items-and-Strains>
