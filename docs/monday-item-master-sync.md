# Monday Item Master mirror

The complete Canix Item Master is mirrored into the existing Monday product
specification board with one row per Canix Item ID. Canix remains the source of
truth; the scheduled writer refreshes only the columns prefixed `Canix` and
leaves curated catalog fields intact.

## Completeness view

The `Canix Data Completeness` table view groups records by its UX OS-managed
status:

- `Completed`
- `Missing Brand`
- `Missing SKU`
- `Missing Type / Category`
- `Missing Quantity Type`
- `Missing Facility`
- `Missing Canix ID`
- `Missing Multiple`
- `Inactive / Reference`
- `Sandbox / Test`

Universal requirements are Name, Facility, Quantity Type, and at least one
source Type or Category. Brand and SKU are required only for Catalog records;
they are not false-positive requirements for Bulk or Propagation inventory.
Images are not included in completeness while the image program is on hold.

The inventory classification preserves the portal rules: an item name
containing Clone, Biomass, Seed, or Seeds is `Propagation`; Bulk identity is
`Bulk`; all remaining items are `Catalog`.

## Identity and safety

- Existing Monday rows are reused by Canix Item ID.
- An unlinked row is reused automatically only when product name plus Brand is
  an exact, unique one-to-one match.
- Ambiguous or duplicate Canix Item IDs are counted as conflicts and are not
  overwritten.
- Missing items are created in `Submitted for Review/Needs Re-Approval`.
- Legacy Monday-only products that remain unlinked after the complete Canix
  pass are grouped as `Missing Canix ID`; they are never mislabeled as Canix
  sandbox inventory.
- Source-specific columns do not overwrite curated sale-facing brand,
  descriptions, publishing status, pricing, or files.
- Canix standard cost and the raw source payload remain excluded because the
  board does not enforce the portal's economics permission boundary.

`monday_item_master_link` is the private idempotency ledger. Each Edge run
checkpoints up to 100 changed or missing items. While the initial backlog
exists, a successful run starts a fresh continuation; once caught up, the
five-minute Vault-backed schedule handles incremental changes. The standing
schedule runs two minutes after the Canix Item Master job. Successfully-created
Monday items remain deduplicated even if a prior response is lost.
