# Canix field decision: Brand, Package Owner, and Economic Owner

Decision date: 2026-09-01

## Decision

Brand and Economic Owner are separate fields in UX OS.

- **Brand** is the product's customer-facing market identity. Its source is the Canix Item/Package Brand.
- **Canix Package Owner** is the Canix user assigned for operational organization and reporting. It is not a company, title holder, risk bearer, or settlement party.
- **Economic Owner** is the organization carrying production economic risk. It is internal, may be blank, and never inherits Brand.
- **Commercial Model** explains the arrangement. For a backend deal where urbanXtracts funds production and collects the sale proceeds, the model is `backend_revenue_share`, Economic Owner is `urbanXtracts`, and the brand partner may be recorded separately as Settlement Counterparty.

An item-level Economic Owner is the default. A package-level classification overrides the item default. Every change is effective-dated and audited.

## Administrative workflow

Administrator, Operations, and Sales users have `economics.manage`.

1. In Inventory, add the organization to **Economic parties** as a Brand Partner, Contract Manufacturer, or Other party. The party code is permanent after creation.
2. Inspect a Canix package.
3. Choose **Item default** for the normal economic arrangement or **This package only** for an exception.
4. Select Economic Owner, Commercial Model, and an optional Settlement Counterparty.
5. Save the classification. The server records the actor, effective date, source, scope, and audit event.

Parties may be made inactive for future assignments without removing them from historical classifications. The seeded urbanXtracts party cannot be renamed, retyped, or deactivated.

## Economic risk reporting

Inventory includes an internal Economic Risk Coverage view with:

- classified and unclassified package counts;
- backend revenue-share package count;
- package-override count;
- packages, grams, and units by Economic Owner; and
- packages, grams, and units by Commercial Model.

Weight and count are always shown separately. The portal does not calculate dollar exposure until Finance approves a cost basis and its authoritative source. Summary rows drill into the package workbench using the corresponding Economic Owner or Commercial Model filter.

Authorized staff also receive an item-level classification queue. It groups unclassified packages by Canix item, keeps grams and units separate, and applies one audited item default to all packages without a package-specific override. Explicit package overrides remain unchanged and are called out before saving.

## What Canix currently documents

Canix documents Brand as an Item field and exposes `brand` on Item and Package API objects. It also has a separate Assign Package Owners feature, but the owner must be a Canix user and is described as the person working on the package. The public API schema does not document an organization-valued package or item field for economic ownership.

The connected Canix Reporting `inventory` schema was also checked on 2026-09-01. `package_inventory_facts_current` includes `brand_id`, `brand_name`, and `company_id`. Canix defines `company_id` as the company owning the Canix record for row-level access control; it is automatically filtered and must not be repurposed as the deal-level Economic Owner. No Economic Owner or organization-valued Package Owner column is exposed in that reporting table.

References:

- <https://help.canix.com/hc/en-us/articles/360057569371-Facility-Data-Locations-Items-and-Strains>
- <https://help.canix.com/hc/en-us/articles/29065568674836-Assign-Package-Owners>
- <https://help.canix.com/hc/en-us/articles/40887688340756-Canix-API-Guide>
- <https://api.canix.com/api-docs-swagger/index.html>

## UX OS representation

| Concept | UX OS field | Source | May be blank? | Exposure |
|---|---|---|---:|---|
| Market identity | `brand_name` | Canix Item/Package Brand | Yes | Internal and catalog |
| Operational user | `canix_package_owner_name` | Canix Package Owner, only if returned by API | Yes | Internal only |
| Production risk bearer | `economic_owner_name` | Protected UX OS mapping; future Canix custom field if approved | Yes | Internal only |
| Commercial arrangement | `commercial_model` | Protected UX OS mapping | Yes | Internal only |
| Revenue/payment participant | `settlement_counterparty_name` | Protected UX OS mapping | Yes | Internal only |

Supported commercial models are:

- `urbanxtracts_risk`
- `partner_owned`
- `backend_revenue_share`
- `toll_processing`
- `shared_risk`
- `unclassified`

## Recommended Canix Support inquiry

Subject: Separate organization-valued Economic Owner field on Items or Packages

> We use Canix Brand for the product's market identity and Canix Package Owner for the Canix user operationally responsible for a package. We also need a separate organization-valued field called Economic Owner: the entity carrying production economic risk. In a backend revenue-share arrangement, urbanXtracts is the Economic Owner even when another Brand receives a settlement share.
>
> Does Canix support an Item- or Package-level custom field that can hold an organization/account rather than a Canix user? If so, please confirm:
>
> 1. the exact field and API property name;
> 2. whether it is returned by `GET /items` and/or `GET /packages`;
> 3. whether it appears in custom reporting and supports bulk updates;
> 4. whether it carries through package creation, split, combine, conversion, and manufacturing outputs;
> 5. whether package-level values can override an item default;
> 6. whether changes retain history and actor information; and
> 7. whether the field can be required through Item Templates.
>
> If a custom organization-valued field is not available, is there a documented co-manufacturing, title-owner, risk-owner, or ownership-code field designed for this purpose? We do not want to overload Brand, Package Owner, SKU, Sub Type, or Notes.

Until Canix confirms an appropriate API field, `source_system` remains `portal` and `source_field` remains blank. If Canix later exposes a supported field, the mapping can move to `canix_custom_field` without changing the portal's meaning or historical classifications.
