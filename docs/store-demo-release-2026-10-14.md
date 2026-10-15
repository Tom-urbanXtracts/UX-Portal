# Controlled Store demo release — 10/14/2026

Release scope: the isolated **urbanXtracts Store** demonstration, with **Demo Store #1** and **Demo Store #2**. This is not activation of real retailers or acceptance of the complete Store Workspace architecture.

Status: **Deployed and production-smoke-tested**, 10/14/2026, 4:54 PM America/New_York. Site version **172**, source `5f3f5de659beb4a5ebf8697b451269f84db6d3c8`, deployment `appgdep_6acfebec79708191a4a8972eb15f57e5`. The custom domain returned HTTP 200 and the existing Internal Administrator session opened the demo, recovered its saved draft and passed the production second-location and education-only view checks. No external demo users were enabled.

## Access and walkthrough

Sign in to [the portal](https://portal.urbanxtracts.com/) as an existing active **Internal Administrator**. Open **Overview → Store Demo**. The entry and every server request require the Administrator profile, an active Internal Administrator membership and the explicit `store.demo` grant. No Store demo accounts, invitations or email recipients are created.

Each Administrator has a separate saved sandbox. The view selector simulates Store Owner, Store Buyer, Budtender and Internal Review; it does not grant those roles or switch a live tenant membership. Store Manager is not available.

1. In **Store Owner → Company & Onboarding**, review the synthetic example fields. Save a partial section, then submit it. Submitted sections lock.
2. In **Internal Review → Company & Onboarding**, return a section with a correction note, then switch to Owner to correct/resubmit it. Approve all six sections in Internal Review.
3. In **Internal Review → Financials**, enter a decision note and clear the synthetic payment terms/credit limit for ordering. Place Hold and Simulate Past Due demonstrate blocking; explicit clearance is required to resume.
4. In **Store Buyer → Catalog & Cart**, filter by Brand, add multiple products, adjust quantities and Save Draft. Refresh and return to Store Demo to verify server-saved recovery. Buyer is limited to Demo Store #1. Owner can select either location.
5. Submit the saved order. Demo Buyer orders above the illustrative **$500** threshold require Owner approval; this amount is a synthetic example, not a live Store threshold decision. Buyer cannot approve its own or another Buyer's order.
6. In **Store Owner → Orders**, approve the Buyer order. In **Internal Review → Orders**, advance Ordered → Approved → Shipped → Delivered. The synthetic pre-order can be approved but cannot ship.
7. In **Store Buyer → Financials**, confirm the organization-wide statement is withheld because the shared accounting account covers an unassigned location. Owner/Internal can inspect the labelled synthetic invoice. Internal Finance notes are not returned to external role simulations.
8. In **Budtender**, confirm education-only products, one location, and no quantities, prices, cart, orders, financials or administration.
9. In **Internal Review → Activity & Reset**, inspect who performed each action. Reset My Demo resets only that Administrator's sandbox; the restricted audit history remains.

No demo action writes a live order, commitment, Canix/QB/Monday object or notification. Fixture product IDs start with `demo-`; location IDs start with `DEMO-`. Do not attach real license numbers or accounting identities to these fixtures. Actual live Store scaffold records remain paused and unqualified.

## Verification record

- Automated release, service, security, freshness and demo-behavior tests: recorded by `npm run verify`.
- `store_demo_database_test.sql`: executes and rolls back fixtures; verifies pause, Administrator-only access, revoked membership, revision conflicts, 25-location insertion/reopening and direct authenticated/anonymous denial.
- Browser walkthrough, desktop/mobile, no-outbound counts, rollback rehearsal and exact deployed versions: append the final execution evidence below before declaring release complete.
- Existing Brand and Internal contracts remain in the full release suite. Passing this suite is not a claim that every existing portal button has a new end-to-end test.

Pre-publication execution completed:

| Check | Result |
| --- | --- |
| Automated suite | 575 release contracts; 13 service/financial projection tests; 32 security/freshness/demo behavior tests passed |
| Type checks | Demo, intake, retailer administration and QuickBooks financial functions passed |
| SQL acceptance | All non-Administrator profiles denied by the service-only demo commit boundary; direct anonymous/authenticated reads and RPC calls denied; revision conflict, pause and 25-store insert/reopening checks passed; fixtures rolled back |
| Browser Company workflow | Six sections submitted; Company Profile returned with a note, partially saved and resubmitted; all six approved |
| Browser ordering | Two-item Owner draft saved; Buyer draft blocked by a simulated past-due hold, restored after explicit clearance, submitted, Owner-approved, then Approved → Shipped → Delivered |
| Second location | Demo Store #2 Wana-filtered draft saved and recovered by Refresh independently of Demo Store #1 |
| Budtender | Desktop and mobile demo-region checks passed: education only, one location, no prices/quantities/cart/orders/financials/admin controls |
| Active-session denial | Temporarily revoked only the dedicated Internal Administrator test membership; next API request denied and cached demo projection cleared. Original membership restored; global profile stayed active |
| Rollback rehearsal | Server pause denied reads; re-enable restored saved state without deleting anything |
| Source/outbound isolation | Before and after workflow: 2 live orders, 2 inventory commitments, 443 cached QB invoices, 80 notification outbox records, 12 memberships, 8 stores. Demo-only session/order/audit records changed |
| Brand/Internal regression | Brand Role Test home, approved Company profile summary and source attention projection loaded; Store Demo not displayed. Internal Administrator dashboard and membership/permission resolution loaded. Existing full contract suite passed |
| Mobile layout | iPhone 14, 390 px viewport; document width 390 px, no page overflow. Existing horizontal Internal navigation remains separately scrollable |
| Negative HTTP | Anonymous and forged-JWT demo calls: 401. Onboarding held: 409 before durable intake/Monday. Anonymous order submission: 401 |

The quantity-entry regression was reproduced twice: clearing a numeric field restored its `1` default before typing. A DOM probe confirmed the original node remained connected and was not replaced. Preserving empty draft values fixed it; entering `12`, adding the product and saving a 12-unit line passed. Temporary DOM instrumentation was cleared by navigation. The mobile Budtender test was correctly scoped to the demo region; the real Administrator's navigation is not a simulated Budtender's permission grant.

Backend versions: `portal-store-demo` v3 (gateway JWT plus current server checks), `portal-intake` v55, `portal-retailers` v37, `quickbooks-financials` v38. Prior sources/settings are in `artifacts/store-demo-release-2026-10-14/*-before.json`. Existing QuickBooks sync repair remains v48; the five-minute inventory guard remains in intake v55.

UI rollback target: Site version **171**, saved ID `appgprj_6a96130b93d881918a8b2fc2f4fecd93~appgver_e7822ac257ac819187d3d0860437be41`, source `2ff63f38e66ccc7c6bc40a66d530da296569f58d`. Published version 172 ID: `appgprj_6a96130b93d881918a8b2fc2f4fecd93~appgver_762cb60a5cb88191bf9775228db8c03a`. The verified publishing checkout was clean after packaging. The original shared checkout and its pre-existing work were preserved.

Security advisor: no new ERROR finding. The new service-only tables have RLS enabled and no public policies, intentionally denying direct client access. Existing authenticated-definer and leaked-password-protection advisories remain separate review items; no broad access policy was added to silence them.

## Related repairs in this release

- Database functions, cap trigger, draft restoration and UI now use **25 stores**; reopening a closed location also rechecks the cap. Account-scoped advisory locking remains in the trigger.
- Missing/unreadable Store source-mode controls fail closed; the onboarding `hold` blocks intake before durable records or Monday calls. No live onboarding activation is performed.
- QuickBooks financial projections check cross-retailer customer collisions for Owners as well as Buyers, including parent-level rows. Ambiguous aggregate data remains withheld.
- Sign-in no longer reconstructs a revoked workspace through legacy fallback when membership resolution fails. Workspace-bound responses are discarded after a context/identity change; sign-out clears the synthetic sandbox projection.
- The previously deployed five-minute Canix checkout guard and repaired QuickBooks scheduler remain in place.

## Rollback and monitoring

Emergency pause: an authorized IT operator sets `portal_store_demo_control.enabled=false`. Both reads and writes stop server-side; saved state and audits remain. Restore `true` only after verification. Do not delete demo sessions, orders, source caches or Monday history as a rollback.

The previous Site saved version remains the UI rollback target. The prior Edge sources/settings are retained in the release evidence. If restoring intake v54, keep onboarding held; do not restore a version older than v54 without also disabling live Store submission because it would remove the five-minute freshness control.

IT owns controlled-demo acceptance and monitoring. Review demo API errors, conflict/denial events and the restricted audit trail after deployment and before expanding access. Existing integration-health/outbox monitoring continues unchanged. No new email alert policy or supply-order sending is enabled.

## Still outside this accepted release

The live Store package still requires the shared membership/location resolver across all endpoints, bounded Owner user administration and last-Owner recovery, scoped active-session revocation across every legacy service, structured real Finance terms/credit decisions and freshness policy, Store document/financial/export allowlists, real item case/minimum/increment data, and a named live retailer cohort with full SW-AC-01–21 acceptance. These are tracked in the dependency review, not silently passed by synthetic tests.

Unapproved document uploads, Store Manager, Store API, payment collection, automatic source-system deactivation and automatic retention deletion remain excluded. Source writes and new Monday dependencies remain prohibited.
