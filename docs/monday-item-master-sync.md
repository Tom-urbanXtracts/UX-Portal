# Monday Item Master mirror

The complete Canix Item Master is mirrored into the `UX Inbound Lot Register`
board (`18429359264`) with one row per Canix Item ID. Canix remains the source
of truth. The protected writer updates only the columns prefixed `Canix` and
never reads or changes the ownership, agreement, approval, or other inbound-lot
fields.

## Physical groups

The existing `topics` group remains the authoritative inbound-lot register.
The lot-integrity service reads and stages rows only in that group. Item Master
rows are isolated in these physical groups:

- `Item Master — Completed`
- `Item Master — Missing Brand`
- `Item Master — Missing SKU`
- `Item Master — Missing Type / Category`
- `Item Master — Missing Quantity Type`
- `Item Master — Missing Facility`
- `Item Master — Missing Multiple`
- `Item Master — Inactive / Reference`
- `Item Master — Sandbox / Test`

Universal requirements are Name, Facility, Quantity Type, and at least one
source Type or Category. Brand and SKU are required only for Catalog records;
they are not false-positive requirements for Bulk or Propagation inventory.
Images are not included in completeness while the image program is on hold.

The inventory classification preserves the portal rules: an item name
containing Clone, Biomass, Seed, or Seeds is `Propagation`; Bulk identity is
`Bulk`; all remaining items are `Catalog`.

## Identity and safety

- Item Master rows are identified only by the stable Canix Item ID on this
  board. Inbound-lot rows without that ID are ignored, not classified as
  incomplete Item Master rows.
- Missing Canix items are created directly in their physical completeness
  group. Existing Item Master rows are moved when their classification changes.
- Ambiguous or duplicate Canix Item IDs are counted as conflicts and are not
  overwritten.
- No product-name or Brand matching is used on the shared lot-register board.
- Canix standard cost and the raw source payload remain excluded because the
  board does not enforce the portal's economics permission boundary.

`monday_item_master_link` is the private idempotency ledger. Each Edge run
checkpoints up to 100 changed or missing items. While the initial backlog
exists, a successful run starts a fresh continuation; once caught up, the
five-minute Vault-backed schedule handles incremental changes. The standing
schedule runs two minutes after the Canix Item Master job. Successfully-created
Monday items remain deduplicated even if a prior response is lost.
