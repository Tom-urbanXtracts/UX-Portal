# Canix Item Master

## Purpose

Package inventory is not an Item Master. An item can be active or inactive and can exist without any current package. UX OS therefore maintains an independent, read-only snapshot of the records returned by Canix `GET /items` for the approved distribution facility.

The portal continues to treat Canix as the source of truth. It does not create, update, deactivate, or delete Canix items.

## Source and refresh

- Source: Canix REST API `GET /api/v1/items`, filtered by the resolved numeric facility ID.
- Grain: one row per authoritative Canix Item ID.
- Scope: active and inactive items for the exact Canix facility name `OCM-DIST-24-000069` only.
- Pagination: 2,000 rows per request with stable Item ID ordering and a 100-page safety limit.
- Refresh target: every 15 minutes from 6:00 AM through 6:00 PM America/New_York, Monday through Friday, through an independent Vault-backed scheduler.
- Failure behavior: the prior complete snapshot remains available. Partial fetches never replace it.

At the start of each run, the sync resolves the exact facility name through `GET /facilities`, requires one and only one match, and passes that facility's numeric ID as the `facility_id` query parameter to `GET /items`. The run fails closed if Canix returns an item assigned to any other facility. This prevents an accidental all-facility snapshot if the upstream filter is ignored or changes behavior.

The Item Master sync is fault-isolated from package inventory. Failure of `GET /items` does not prevent the package cache from continuing its own five-minute refresh.

Each successful Item Master refresh reconciles the source evidence in the Portal Item Mapping Center. New Canix Item IDs enter **To Be Mapped**. Existing Portal decisions remain durable and are never replaced by a source refresh.

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

## Production verification history

The first complete production refresh on 2 September 2026 established the all-facility baseline. On 14 October 2026, the source contract was narrowed to `OCM-DIST-24-000069`. The first facility-scoped production run resolved facility ID `4467` and license `OCM-DIST-24-000069-DX2`, then atomically published 400 distinct Item IDs in one API page. All 400 rows carry that one facility ID and name, no staged rows remain, and the run completed without error. The independent scheduler remains Vault-backed, and a failed facility lookup or out-of-scope API response preserves the prior complete snapshot.

## Authoritative references

- <https://api.canix.com/api-docs-swagger/index.html>
- <https://help.canix.com/hc/en-us/articles/40887688340756-Canix-API-Guide>
- <https://help.canix.com/hc/en-us/articles/360057569371-Facility-Data-Locations-Items-and-Strains>
