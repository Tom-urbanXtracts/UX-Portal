# Portal order workflow setup

The portal owns the durable customer-facing order and its append-only event history. Monday remains the operations work board. QuickBooks is not written automatically in this release; accounting staff create the record after the store data has been reviewed.

> Live status, 1 September 2026: the portal and Supabase order layer are deployed, but Make scenario `6043707` is not production-ready. The Make organization is paused, the existing webhook is detached, and the scenario does not yet implement the deduplication, complete response, callback, and retry contracts below. Keep live ordering gated until those items pass an end-to-end test.

## Data flow

1. The browser assigns a UUID to the draft and keeps it through every retry.
2. `portal-intake` authenticates the caller and verifies store scope, the published store price, current Canix availability after explicit reservations, optional whole-case policy, release state, and the store's Owner-approval threshold.
3. One `portal_order`, its verified `portal_order_line` rows, and per-item `portal_inventory_commitment` rows are created in one transaction. Product-scoped database locks ensure two request IDs cannot consume the same available units. Reusing the UUID returns the existing order and never commits or sends it twice.
4. Make creates or finds the Monday item and returns its identifiers. The portal marks the workflow accepted only after that response.
5. Portal state changes append `portal_order_event` rows and queue an outbox message. A Monday outage cannot roll back or erase the portal change.
6. Monday changes return through the secret-authenticated callback. Both the Edge Function and PostgreSQL enforce the one-step transition graph; Store Owner approval, release holds, and terminal states cannot be skipped.

Active commitments remain through approval and processing. They are released only when the order is declined, canceled, delivered, enters the legacy terminal `exception` state, or is definitively rejected by the downstream intake workflow. Drafts never hold inventory. After operations creates the state-required Canix sales order, the Monday callback links its numeric ID one-to-one to the portal order; only allocations on that exact Canix sales order cover the matching portal commitment.

## Required Edge Function secrets

- `MAKE_WEBHOOK_URL`: existing order-intake Make scenario.
- `MAKE_ORDER_STATUS_WEBHOOK_URL`: portal-to-Monday status scenario; falls back to `MAKE_WEBHOOK_URL` when not set.
- `MAKE_INTAKE_SECRET`: shared secret included inside the server-to-Make payload.
- `MONDAY_STATUS_SECRET`: high-entropy secret used in the `x-ux-monday-secret` callback header.
- `ORDER_SYNC_CRON_SECRET`: independent high-entropy secret used in the `x-ux-cron-secret` retry header.

Do not expose any of these values in the browser configuration.

## Monday intake response

The Make intake scenario must deduplicate on `payload.clientRequestId` and return JSON like:

```json
{
  "orderNumber": "UX-1042",
  "mondayItemId": "9876543210",
  "mondayBoardId": "1234567890",
  "status": "accepted"
}
```

If the same client request reaches the scenario again, return the identifiers already assigned to it.

## Monday status callback

Send a `POST` request to the deployed `portal-orders` function with `x-ux-monday-secret` and a body such as:

```json
{
  "action": "monday-status",
  "portalOrderId": "00000000-0000-4000-8000-000000000000",
  "mondayItemId": "9876543210",
  "mondayBoardId": "1234567890",
  "canixSalesOrderId": 456789,
  "status": "Processing",
  "note": "Moved by the fulfillment workflow"
}
```

The callback also accepts `orderNumber`, `portalReference`, or `mondayItemId` as the lookup key. `canixSalesOrderId` is optional until the Canix record exists, then required operationally so an allocation covers only its own portal commitment. It must be a positive numeric Canix sales-order ID and can link to only one portal order.

Status mapping is an exact allowlist after case/punctuation normalization. Supported labels include `Ordered`, `Submitted`, `Approved`, `Confirmed`, `Processing`, `Processed`, `Shipped`, `Ready for delivery`, `Delivered`, `Received`, `Canceled`, `Declined`, `Rejected`, and `Exception`. Unknown or compound failure/negation labels such as `Delivery failed` and `Not approved` fail closed.

## Retry job

Call `portal-orders` on a schedule with:

```json
{ "action": "flush-outbox" }
```

Authenticate it with `x-ux-cron-secret`. The function processes up to 25 pending or failed messages per run. A signed-in internal user with `orders.manage` may also trigger the same action for support diagnostics.

## Reconciliation rule

An order whose initial Make response is missing, timed out, or incomplete remains in `needs_reconciliation`. The portal intentionally does not resend it automatically because Monday may already have created the item. Internal users with `orders.manage` see it in the Orders queue as **RECONCILIATION**. They search Monday by `clientRequestId` or `portalReference`, open the order, and use the internal-only reconciliation panel to attach the existing order number and item ID. This is the safe side of the duplicate-order tradeoff.
