# Make order automation remediation

Audit date: 1 September 2026

This is the production-readiness plan for Make scenario `6043707`, **UX Portal intake to monday**. It records no webhook addresses or shared secrets.

## Current state

- The Make organization is paused.
- The free plan has consumed 1,004 of 1,000 operations and reports its next reset on 14 September 2026. It cannot execute another production validation unless the plan is upgraded or the allowance resets.
- The scenario is marked active, but its custom webhook reports `attached: false`.
- The existing router handles order, license, and onboarding payloads and writes to the existing Monday boards.
- The order route creates a Monday item but does not deduplicate by `payload.clientRequestId`.
- Its response supplies an order reference but not the full `orderNumber`, `mondayItemId`, and `mondayBoardId` contract.
- There is no verified `order-status` route, Monday-to-portal status callback, or five-minute portal-outbox flush.
- Portal order persistence is already durable and fail-closed. These Make gaps block live forwarding, not the Canix inventory reader or executive demo.

## Safe repair sequence

1. Export and retain the complete current blueprint outside the source repository. Do not place shared secrets in Git.
2. Deactivate scenario `6043707` before changing its blueprint. Keep the unrelated finance sandbox scenario unchanged.
3. Use the columns already added to Monday order board `18428025898`: **Portal request ID** (`text_mm6shj0q`) for `clientRequestId` and **Portal order ID** (`text_mm6sphg5`) for the authoritative portal UUID. The dedicated **Portal Integration** view is `278640935`.
4. On the `kind = order` route, search that column before creation:
   - when found, return the existing order and Monday identifiers;
   - when absent, create exactly one item, store `payload.clientRequestId`, `payload.portalOrderId`, and `payload.portalReference`, then return its identifiers.
5. Return JSON for both the found and created branches:

   ```json
   {
     "orderNumber": "UX-1042",
     "mondayItemId": "9876543210",
     "mondayBoardId": "18428025898",
     "status": "accepted"
   }
   ```

6. Add a `kind = order-status` route to the same scenario so the current two-scenario plan limit is not exceeded. It must update the identified Monday item from the portal outbox payload and return HTTP 2xx only after the update succeeds.
7. Add a Monday status-change automation that calls the Supabase `portal-orders` endpoint with `action = monday-status`, one stable order identifier, the exact status label, and the numeric Canix sales-order ID once operations creates it. Authenticate using the server-only callback header.
8. Configure an independent five-minute scheduler to call `portal-orders` with `action = flush-outbox`. Do not reuse the callback secret for this scheduler.
9. Validate the complete scenario blueprint, run the test matrix below while it remains inactive for general traffic, and activate it only as a separate deliberate release action.

## Required server-only configuration

- Existing intake: `MAKE_WEBHOOK_URL`, `MAKE_INTAKE_SECRET`.
- Portal-to-Monday outbox: `MAKE_ORDER_STATUS_WEBHOOK_URL` or the existing webhook fallback.
- Monday-to-portal callback: `MONDAY_STATUS_SECRET`.
- Five-minute retry job: `ORDER_SYNC_CRON_SECRET`.

The values themselves belong in Supabase/Make secret storage and must never be copied into browser configuration, documentation, execution notes, or Git.

## Acceptance matrix

| Test | Expected result |
| --- | --- |
| First valid order | One portal order, one inventory commitment set, one Monday item, complete identifier response |
| Repeat identical `clientRequestId` | Existing identifiers returned; no second Monday item |
| Same request after response timeout | Portal flags reconciliation; operator finds the item by client request ID and attaches it without resending |
| Invalid shared secret | No Monday write and non-2xx response |
| Portal transition while Monday is unavailable | Portal state/event persists and outbox is pending or failed |
| Retry after Monday recovery | Existing outbox row becomes sent; no duplicate portal event |
| Monday status callback | Only the exact one-step Ordered → Approved → Processed → Delivered graph advances |
| Failed/negated or skipped status | Callback is rejected or ignored; portal state does not advance |
| Canix sales-order link | Positive numeric ID links to one portal order only and prevents double inventory subtraction |
| Onboarding route | One-to-ten stores stay durable and the response includes the Monday item identifier |

Live ordering is ready only when every row passes with execution IDs retained in the deployment record and the scenario finishes attached, unpaused, and deliberately active.
