# Portal-Native Data Controls

## Approved operating decisions

- Owner and Lot ID corrections are Supabase overlays. They are never written back to Canix.
- Operations may approve ownership decisions without a second approver.
- Finance, Operations, and Administrators may approve Cost Object decisions.
- A new approved mapping becomes the current mapping. Prior versions remain in immutable history.
- A `Not required` decision remains effective until an authorized user replaces it.
- Catalog publication requires one authorized approver.

## Monday import rule

Use a conservative import boundary:

Automatically approve a historical Monday lot only when all of the following are true:

1. The record has a stable Monday item ID.
2. Monday marks the record approved.
3. The Lot ID is present, valid, and unique.
4. Required ownership data is complete.
5. The record has not changed since its last approval.

Every other record enters `Pending review`, including duplicates, missing or malformed Lot IDs, incomplete ownership, unapproved rows, and rows changed after approval. The original Monday item ID and import evidence are retained. Monday is preserved as historical evidence; the Portal becomes the current authority after review.

## Sources of record

| Data | Current authority |
|---|---|
| Physical inventory and compliance package data | Canix |
| Owner classification and package-to-Lot correction | Supabase Portal overlay |
| Canix Item to UX OS SKU mapping | Supabase Portal |
| Lot Register and Cost Object decision | Supabase Portal |
| Catalog content and publication | Supabase Portal catalog controls |
| Historical imported records | Monday, retained as source evidence |

## Control behavior

- Browser roles have no direct access to the control tables.
- Every read or write passes through an authenticated Edge Function with server-side authorization.
- Every replacement decision creates immutable event history.
- Canix inventory responses reapply approved overlays after every source refresh.
- `Not required` is durable but may be replaced by a later authorized decision; it does not silently expire.
