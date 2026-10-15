# Controlled Store demo release — 10/14/2026

Release scope: the isolated **urbanXtracts Store** demonstration, with **Demo Store #1** and **Demo Store #2**. This is not activation of real retailers or acceptance of the complete Store Workspace architecture.

Status: **Deployed and production-smoke-tested**, 10/14/2026, 4:54 PM America/New_York. Site version **172**, source `5f3f5de659beb4a5ebf8697b451269f84db6d3c8`, deployment `appgdep_6acfebec79708191a4a8972eb15f57e5`. The custom domain returned HTTP 200 and the existing Internal Administrator session opened the demo, recovered its saved draft and passed the production second-location and education-only view checks. No external demo users were enabled.

## Access and walkthrough

Sign in to [the portal](https://portal.urbanxtracts.com/) as an existing active **Internal Administrator**. Open **Overview → Store Demo**. The entry and every server request require the Administrator profile, an active Internal Administrator membership and the explicit `store.demo` grant. No Store demo accounts, invitations or email recipients are created.

Each Administrator has a separate saved sandbox. The view selector simulates Store Owner, Store Buyer, Budtender and Internal Review; it does not grant those roles or switch a live tenant membership. Store Manager is not available.

1. In **Store Owner → Company & Onboarding**, review the synthetic example fields. Save a partial section, then submit it. Submitted sections lock.
2. In **Internal Review → Company & Onboarding**, return a section with a correction note, then switch to Owner to correct/resubmit it. Approve all six sections in Internal Review.
3. In **Internal Review → Account & License**, the account shows the global Net 30 default unless one account-level override is saved; it applies to both locations. Enter a reason and evidence reference, then **Place Manual Hold** to demonstrate the only financial order block, and **Release Manual Hold** to resume. **Overdue Invoice**, **Stale (24h)** and **Unknown Sync** simulate synthetic accounting warnings; they never block ordering or change a hold. Each accepted terms/hold/license decision appears once in the append-only Control Audit. (Approving the license section requires verification evidence; an Owner-recorded renewal stays paused until Internal Review verifies it.)
4. In **Store Buyer → Catalog & Cart**, filter by Brand, add multiple products, adjust quantities and Save Draft. Refresh and return to Store Demo to verify server-saved recovery. Buyer is limited to Demo Store #1. Owner can select either location.
5. Submit the saved order. Demo Buyer orders above the illustrative **$500** threshold require Owner approval; this amount is a synthetic example, not a live Store threshold decision. Buyer cannot approve its own or another Buyer's order.
6. In **Store Owner → Orders**, approve the Buyer order. In **Internal Review → Orders**, advance Ordered → Approved → Shipped → Delivered. The synthetic pre-order can be approved but cannot ship.
7. Confirm **Store Buyer** has no Account & License tab and receives ordering status only: no invoices, balances, terms or hold reasons. Owner sees own-account terms, hold state, warnings and the labelled synthetic invoice, but not internal reasons or evidence. Unknown accounting is withheld rather than shown as zero.
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

## Catalog source update — staging function deployed, production site unchanged

The four fabricated `demo-` products are replaced by the 120-listing browser-verified **Shop UrbanXtracts** snapshot captured 10/14/2026 (`data/canix-marketplace-listings-2026-10-14.json`). Commit `7a7da2434480e5eaefc72bce4301cfd2fe02d1ab` was deployed on 10/15/2026 only to `portal-store-demo` v3 in isolated **UX OS Staging** (`nqnmgxnxwllstowavjjt`). An authenticated post-deploy probe returned 120 unique products, 13 canonical brands, 6 Cannaprint rows, 98 source images and 22 missing-image records; a quantity of 7 for product `18780` (minimum 8) returned 400 without changing the session revision. A Viewer returned 403, the demo remained enabled, external Store access remained disabled and Store ordering remained on `hold`.

The production Sites project remains on version 172 and was not republished. Its coordinated production runbook gates remain open, so the new search/category/placeholder frontend is still available only in the verified local preview. No database migration, production function, permission, credential, Store-access switch or notification setting changed in this staging deployment. `scripts/verify-store-demo-ui.mjs` now uses source product names.

- `scripts/generate-store-demo-catalog.mjs` produces `supabase/functions/_shared/store-demo-catalog.ts` from the snapshot. `npm run verify` fails if that file drifts from the snapshot. Edit the snapshot, never the generated file.
- Identity is the Marketplace Product ID only. Product names are display text.
- Brand display: the source lists the same brand as both `Cannaprint` (4 listings) and `Cannaprints` (2). The demo displays `Cannaprint` for all 6, so filters show 13 brands. The generated fixture keeps the raw value as `sourceBrandName` (14 raw brands), and source validation compares against it. Product IDs are unchanged.
- Price, displayed availability, sale unit (`each`) and minimum order quantity come from the snapshot. Quantities must be whole numbers, at or above the exact minimum and no more than displayed availability. The minimum is not treated as an order multiple. Aggregate demo allocation still applies.
- Add to Draft refuses a quantity below the exact source minimum (and any non-whole quantity) before it reaches the draft. The product card shows an alert tied to its quantity input, e.g. `Minimum 8 each for <product>. Nothing was added.`, and the draft is left unchanged. The shared synthetic draft save rejects the same line on its own, so a direct request cannot store it. A below-minimum draft saved before this guard is loaded unchanged and still blocked at submission with the existing minimum message. Quantities edited on the Review draft order screen are not checked until the draft is saved or submitted, where the server rejects them.
- The source has no SKU, pack/case size or release status, so the demo shows none. New demo lines carry no pre-order flag. Pre-order lines saved under the retired fixtures are still held from shipping.
- 22 listings have no image in the source and show a "No image in source" placeholder. Images load from the Canix asset host shown in the snapshot.
- Every projection includes source provenance and a notice: snapshot, capture date, not live inventory. Budtender gets name, brand, category and image only, and now sees all 120 listings because the source has no release status to filter on.
- Live Store gates, the five-minute freshness/identity/availability/price revalidation, the no-credit-cap policy and the Finance hold/past-due gates are unchanged.

The rebuilt candidate was exercised in Chrome through a localhost-only preview using isolated staging authentication and in-memory demo state; no Edge Function, database, permission or production state changed. The walkthrough verified 120 rendered listings, all 14 raw source brand spellings (subsequently displayed as 13 canonical brands by the Cannaprint alias) and 10 categories, search/filter behavior, 98 source images and 22 honest placeholders, source minimums in product and cart inputs, draft preservation behind onboarding/Finance gates, six-section Owner submission and Internal approval, Finance clearance, Owner ordering, Buyer approval routing above $500, Owner approval, Internal delivery transitions, and the Budtender education-only projection. A 390 × 844 viewport had no horizontal overflow. Browser execution also exposed and fixed a pre-existing component-logic parse error and an image-handler incompatibility; release verification now parses the component logic and pins the supported image binding.

## Policy update — 10/15/2026 (local code only; not deployed)

The approved Portal checklist of 10/15/2026 supersedes the earlier demo finance behavior recorded above, including "Simulate Past Due" blocking and "Finance clearance" before ordering. Those rows remain as the historical record of what was tested at the time. The local change makes overdue invoices, balances and stale/unknown QuickBooks data warning-only. Only an explicit, audited manual hold placed by Finance or an Internal portal Administrator blocks an order for financial reasons, and Buyers receive no financial information. The demo commit allowlist changes only through the new migration `20261015120000_store_financial_hold_and_license_lifecycle.sql`. That migration is not applied, so the deployed demo is unchanged until a reviewed release.

## Workspace redesign and Billing — 10/15/2026 (local code only; not deployed, not browser-tested)

The Store Demo now opens as one workspace: a context bar (Demo view, location, and a summary of the role's scope and the synthetic account), a status panel and the section navigation sit in a single bordered block above the active panel.

1. In **Store Owner** on a fresh or reset demo, the status reads **Ordering paused** with two cards tagged **COMPLIANCE PAUSE · AUTOMATIC** (onboarding not yet approved; license not verified). Each states that the draft is preserved and gives a next step; **Open Company & Onboarding** jumps to the section. Nothing is sent.
2. After Internal Review approves onboarding, **Place Manual Hold** produces a single **MANUAL FINANCIAL HOLD** card for Owner and Internal. The Buyer sees **ACCOUNT HOLD** and "Contact your Account Owner", with no financial category. **Overdue Invoice**, **Stale (24h)** and **Unknown Sync** add a **WARNING · NEVER BLOCKS ORDERING** list and never a pause.
3. In **Catalog & Cart**, the toolbar holds search, Brand and Category with **Clear filters**; ordering roles see the current draft's line count and total with **Review draft order**. Cards keep the source text, images or the honest **NO IMAGE IN SOURCE** placeholder, price, minimum, snapshot availability and Product ID unchanged. While ordering is paused, the draft panel explains that Submit will be refused and Save Draft keeps the lines.
4. In **Billing**, the location control is replaced by an account-wide summary (both synthetic stores) and the only section is **Account Financials**: payment terms, manual-hold status, synthetic QuickBooks sync state and open balance (withheld, not zero, when the sync time is unknown), the synthetic invoice table and the license status. There is no catalog, order, onboarding, license-document or audit control.
5. At 820px or narrower, the context and status stack, the section navigation becomes a two-column grid, toolbars and draft lines reflow, the invoice table stacks with labels, and buttons and inputs are at least 44px tall.

In **Users** (Internal Administrator), **Add a user** offers Store owner, Buyer, Billing and Budtender as *synthetic demo* roles. They require a reserved `.invalid` address, exist only in the browser session, and are never invited, emailed or written to the live directory. Synthetic rows can be managed (role and the two synthetic locations; Owner and Billing receive both, Buyer at least one, Budtender exactly one), deactivated and reactivated locally. **View as** on a Billing row opens the read-only Financials workspace, not the Owner or Buyer view, and does not load live QuickBooks data under the Administrator session. `scripts/verify-store-demo-ui.mjs` gains a `pause-guidance` mode and updated `finance-warning`, `billing` and `order-workflow` expectations for the separate browser pass.

## Still outside this accepted release

The live Store package still requires the shared membership/location resolver across all endpoints, bounded Owner user administration and last-Owner recovery, scoped active-session revocation across every legacy service, structured real Finance terms/credit decisions and freshness policy, Store document/financial/export allowlists, real item case/minimum/increment data, and a named live retailer cohort with full SW-AC-01–21 acceptance. These are tracked in the dependency review, not silently passed by synthetic tests.

Unapproved document uploads, Store Manager, Store API, payment collection, automatic source-system deactivation and automatic retention deletion remain excluded. Source writes and new Monday dependencies remain prohibited.
