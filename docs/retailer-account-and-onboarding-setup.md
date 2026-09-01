# Retailer accounts and multi-store onboarding

QuickBooks remains authoritative for customer identity, active/inactive state, balance, and accounting history. UX OS owns retailer qualification, licensed stores, portal readiness, user scope, and whether a store may place an order.

## Deploy in this order

1. Apply `supabase/migrations/20260901170000_retailer_accounts_and_onboarding.sql`.
2. Deploy `quickbooks-retailers`, `portal-retailers`, `portal-admin`, and the updated `portal-intake` Edge Functions.
3. Deploy the rebuilt portal only after those functions are healthy.
4. Run one authenticated QuickBooks customer refresh and confirm every returned customer has a namespaced `qbo:customer:<id>` portal identifier.

The migration backfills existing `portal_store` rows into ready retailer accounts so the stricter order gate does not disable stores that were already configured. New stores always begin with license qualification and ordering pending.

## Live source audit — 1 September 2026

QuickBooks connectivity was verified against **URBANXTRACTS INC**. The Monday source is board `6217203913`, **Licensed Retailers**, with 628 records. A dedicated **Portal / QuickBooks Readiness** view (`278640991`) now surfaces the store license, account owner, QuickBooks name/ID, UX customer ID, billing parent, A/R match state, refresh date, and aging balances.

The audit found:

- 583 records have a license number.
- Zero records currently have a QuickBooks Customer ID, QuickBooks Customer Name, UX Customer ID, billing parent, A/R Match Status, or A/R Last Updated value.
- Two license values are duplicated across more than one Monday retailer record.
- QuickBooks has live customer receivables, but no authoritative immutable customer IDs have been mapped into Monday yet.

Therefore customer names and balances must not be copied into the portal by fuzzy name matching. Staff must resolve the duplicated licenses and populate immutable QuickBooks Customer IDs before marking each row **Ready to Sync**. The portal continues to fail closed on unmapped or shared identities.

## Readiness model

Retailer account statuses are portal-owned:

| Status | Meaning |
| --- | --- |
| `not_qualified` | QuickBooks customer exists but no portal qualification has started. |
| `qualification` | Staff is validating organization and licensed-store records. |
| `terms_pending` | Qualification may proceed, but commercial terms are incomplete. |
| `setup_pending` | Terms are known; portal store/access setup is incomplete. |
| `ready_to_order` | At least one active, qualified store is enabled for ordering. |
| `ordering_paused` | Account-wide operational hold. |
| `inactive` | Portal account is inactive. |
| `rejected` | Qualification was rejected. |

Each store has an independent `license_status` and `ordering_status`. A license must be `active` before ordering can become `ready`. The database rejects an eleventh open store, including concurrent attempts from separate administrators.

Order intake accepts a request only when all of these are true:

- QuickBooks-backed retailer account status is `ready_to_order`.
- Store record is active.
- Store license status is `active`.
- Store ordering status is `ready`.
- The signed-in user is authorized for the organization and store.
- Published pricing and Canix availability/release checks still pass.

A QuickBooks balance does not automatically pause ordering or imply that an invoice is past due.

## Staff workflow

Administrator, Operations, and Sales presets have `accounts.manage` and can:

1. Open a QuickBooks customer under **Retailer accounts**.
2. Start portal qualification, which links but does not modify the QuickBooks customer.
3. Add up to ten licensed stores.
4. Qualify each license, then separately enable its ordering status.
5. Move the retailer account to `ready_to_order` after at least one store is ready.

Every account/status/store mutation is performed by the server and writes a retailer event. Browser roles cannot write the underlying tables directly.

## Onboarding durability

The request-access form sends a stable `clientRequestId`. `portal-intake` atomically stores the organization, one to ten stores, owner, optional buyer, and budtenders before forwarding to Monday. The request ID is included in the Monday payload as `portalOnboardingRequestId`.

The Monday scenario must return JSON containing `mondayItemId` (or `itemId`/`id`) and preferably `mondayBoardId`. If Monday times out, rejects the request, or omits an item identifier, the portal record becomes `needs_reconciliation`; the requester receives its portal reference and must not resubmit it. A repeated accepted client request returns the existing record without creating a second Monday item.

Public onboarding intake never chooses a QuickBooks customer or retailer-account link. Staff makes that association after source identity and licenses are verified.

## Six-stage operator workflow

The internal **Store onboarding** queue is operational, not just a report:

1. **Intake → Qualification** only after Monday has accepted the durable request.
2. **Qualification → Commercial terms** only after every submitted license has been reviewed and at least one has qualified.
3. **Commercial terms → Account creation** records the internal commercial decision and cannot skip a stage.
4. Link the request to a QuickBooks-backed portal retailer account before leaving Account creation.
5. **Account creation → Access** materializes qualified locations as portal stores. Their licenses become active, but ordering remains pending until staff explicitly enables it on the retailer account.
6. During **Access**, invite each requested person from the onboarding record. Owners receive every qualified store, Buyers receive their requested store or the qualified group, and Budtenders receive exactly one qualified store.
7. **Access → Ready to order** requires every requested user to be invited, at least one active Store Owner, every qualified location to exist as an active portal store, and the linked retailer account to be explicitly ready to order.

Requests cannot skip or move backward through stages. Rejection requires a note. Once store creation begins, the request cannot be relinked to a different retailer account.

## Verification

- Link an active QuickBooks customer and confirm the customer record itself is unchanged.
- Add ten stores and confirm the eleventh is rejected; edit an existing store at the cap and confirm the edit succeeds.
- Confirm a new store cannot order while either its license or ordering gate is pending.
- Confirm an account cannot become `ready_to_order` until at least one store is active and ready.
- Confirm an inactive QuickBooks customer cannot become `ready_to_order`.
- Submit a three-store onboarding request and confirm one portal request, three child-store rows, the people rows, and one Monday item exist.
- Repeat the same `clientRequestId` and confirm no duplicate portal or Monday record is created.
- Simulate a Monday timeout and confirm the request appears in the internal onboarding queue as needing reconciliation.
- Attempt to skip each onboarding stage and confirm the server rejects it.
- Reject one license and qualify another; confirm only the qualified location becomes a portal store when the request enters Access.
- Invite the requested Owner, Buyer, and Budtender from the Access stage. Confirm the Owner receives all qualified stores, the Buyer receives the intended scope, and the Budtender receives exactly one store.
- Verify Owner access spans all stores, Buyer access includes only assigned stores, and each Budtender is assigned to exactly one store before invitation.
