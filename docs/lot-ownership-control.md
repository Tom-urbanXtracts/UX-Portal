# Economic ownership through the inbound-lot register

## Decision

Canix Brand remains Brand. It is not reused for economic ownership.

Economic ownership is held in the private Monday board [UX Inbound Lot Register](https://urban915991.monday.com/boards/18429359264). A Canix package carries only its non-disclosing `lot_id` pointer. UX OS joins that pointer to the approved Monday lot record and derives the economic control without exposing ownership in a printable Canix Brand field.

This implements the recommended compensating control for B3 / Intake Form C. It does not claim that Canix enforces non-editable inheritance. Acceptance test AT-1.6 therefore remains **partial** until Canix offers a native immutable field or equivalent control.

## Protected register

- Monday board ID: `18429359264`
- Board visibility: Private
- System owner: urbanXtracts IT / Operations
- Portal source: server-side Monday OAuth with `boards:read`
- Portal mirror: `portal_inbound_lot`
- Package decision: `portal_package_lot_control`
- Rollout state: `portal_lot_integrity_state`
- Default enforcement mode: `monitor`

The explicit **Lot ID** column is authoritative. The default Monday item name is a human-readable reference only. Required control fields are Lot ID, Ownership Code, Economic Partner, Agreement Reference, Deal Type, UOM Code, Approval Status, Approved By, Effective Date, and Approval Date. Optional operational fields retain blanks rather than inventing data.

Ownership Code accepts only:

- `UX`
- `TOLL`
- `SPLIT`
- `TEST`

UOM Code accepts only:

- `G_IN`
- `G_OUT`
- `G_DRY`
- `G_WET`

## Integrity contract

A package is valid only when all of these conditions hold:

1. The Canix package contains exactly one nonblank `lot_id`.
2. The value matches `^[A-Z0-9-]{1,20}$`.
3. Exactly one active Monday register row has that Lot ID.
4. The register row is Approved.
5. The approved Lot ID has not changed after the portal first locked it.

Every other package receives one explicit status: `missing_pointer`, `multiple_lots`, `format_error`, `unknown_lot`, `duplicate_register_lot`, `register_lock_violation`, or `unapproved_lot`.

Approved Lot IDs lock in the protected portal mirror on the first successful synchronization. A later Monday edit is recorded as a lock violation while the previously approved pointer remains protected. This detects but cannot prevent the source edit.

## Rollout and allocation

The system starts in monitor mode because the 2 September 2026 audit found a large historical backlog: 1,175 of 1,350 active Canix packages had no `lot_id`; 42 had comma-separated values. Turning the gate on immediately would unexpectedly freeze legitimate inventory.

Monitor mode:

- shows register and package exceptions to authorized internal users;
- leaves catalog quantities, order commitments, and pre-order release unchanged;
- runs reconciliation after every successful Canix snapshot;
- supports a daily protected Monday-register synchronization and an administrator-triggered sync.

Block mode applies the same `allocation_eligible` decision in all three paths:

- count-based catalog availability;
- atomic order inventory commitments;
- pre-order release calculations.

Do not activate block mode until Operations and Quality confirm:

1. all available and allocated production packages have one valid pointer;
2. all referenced lots exist once in Monday and are approved;
3. there are zero lock, format, duplicate, and approval exceptions;
4. the allocation-exception count remains zero through two consecutive Canix refreshes;
5. the reconciliation export and physical custody review agree.

After sign-off, a service-role operator may call `portal_set_lot_integrity_mode('block')`. The portal does not expose this switch to the browser.

## Operating procedure

1. Create the inbound lot in Monday before receiving or allocating packages.
2. Record the agreement and economic-party facts. Do not put them in Canix Brand.
3. Approve the lot only after required evidence is complete.
4. Assign the approved Lot ID to each related Canix package through the supported Canix interface.
5. Select **Sync lot register** in UX OS Inventory or wait for the daily job.
6. Resolve every exception shown in **Package ownership integrity**.
7. Treat missing, malformed, unknown, duplicated, unapproved, or changed pointers as allocation exceptions once block mode is active.

The portal never writes package Lot ID back to Canix because the documented Canix reporting API currently exposes package reads but no package-update operation.

## Test evidence

The isolated Monday control row `UX-TEST-0001` (item `12957902449`) exercises the schema with Ownership Code `TEST`, UOM `G_IN`, and Approved status. It is not a production lot, is not associated with a Canix package, and must not be used for allocation.

Required acceptance evidence:

- an approved unchanged lot resolves to `valid`;
- a blank Canix pointer resolves to `missing_pointer`;
- a comma-separated pointer resolves to `multiple_lots`;
- an absent register pointer resolves to `unknown_lot`;
- a non-approved register row resolves to `unapproved_lot`;
- changing an approved Monday Lot ID preserves the locked value and raises `register_lock_violation`;
- monitor mode does not change orderability;
- block mode rejects or excludes every non-valid package consistently in catalog, commitment, and release flows.
