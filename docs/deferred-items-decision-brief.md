# UX OS deferred-items decision brief

Updated 2 September 2026 after the signed Monday order integration test.

These items do not block the current inventory, retailer onboarding, catalog, pricing, ordering, access, kiosk, COA/lineage, financial-display, or executive-demo scope. Each related capability stays off or blank until the named owner records a decision.

## Decisions now closed

| Topic | V1 decision | Evidence |
| --- | --- | --- |
| Sellable package | Active Canix package with `status_category = 'available'`; never use the free-form status label as the decision field | Connected Canix inventory schema explicitly documents this rule |
| Reserved quantity | Subtract an explicit reservation from count-based orderable units; preserve unknown coverage as unknown | Live production data outside facility `4546` had 180 available count packages, 167,172 units, and no reservations; the one fully reserved available package was confined to the sandbox |
| Catalog grouping | One catalog product per Canix `item_id` (`canix_item_id_v1`) | 958 of 1,359 active non-sample packages had no `product_id`; only two product IDs spanned multiple item IDs |
| Quantity domains | Keep WeightBased and CountBased separate; exclude VolumeBased | Canix reporting contract and urbanXtracts policy |
| Case quantities | Normalize positive Canix `case_quantity` when supplied. Per-store enforcement defaults off and fails closed when enabled without one unambiguous value | Implemented in the protected order policy and intake contract |
| Economic owner | Portal item default with package override; may be blank; never inherit Brand | Implemented effective-dated ownership model |
| Economic partner | Automatically associate every nonblank Canix Brand with a separate partner party; never use as Economic Owner fallback | Implemented Brand-to-Partner registry and sync |
| Accepted-order inventory commitment | Commit submitted orders immediately; hold through approval/processing; release on decline, cancellation, delivery, legacy exception, or definitive downstream rejection; count only the portion not covered by the explicitly linked Canix sales order | Implemented transaction-scoped per-item commitments and one-to-one Canix sales-order reconciliation; drafts still hold nothing |
| Canix snapshot publication | Stage each full fetch privately and publish packages, COAs, and the successful-run pointer in one PostgreSQL transaction | A failed or partial run cannot mutate the last successful inventory snapshot |
| Lab release quantity | Only exact `TestPassed` package units count as released; a mixed line exceeding passing units is entirely pre-order | Connected Canix snapshot status domain and fail-closed order workflow |
| Workforce SSO provider | Google Workspace through a dedicated Google Web OAuth client brokered by Supabase; first-time `@urbanxtracts.com` users receive Viewer | Google and email providers are enabled, the current callback/redirect flow was completed with Tom's Workspace account, and the deterministic provisioning trigger is deployed |
| Monday order delivery and status return | Use the dedicated Monday app for idempotent, board-pinned order creation and status writes. Receive status changes through one app-signed webhook; retain Make only as a compatibility path | The TEST order was reconciled to Monday, `Ordered` and `Approved` callbacks each processed once with HTTP 200, eight obsolete subscriptions were removed, and one signed webhook remained active on 2 September 2026 |
| Monday catalog-content ingestion | Pull only from pinned board `9620649212`; automatically bootstrap only unique exact product-name + Brand pairs as Draft; require an explicit current Canix Item ID and Draft, Published, or Archived state for every other row | On 2 September 2026, the controlled exact-match pass verified 17 new pairs as Draft and synchronized all 33 currently linked rows. No update failed, conflicted, duplicated a Canix ID, or referenced a missing Canix item; the immediate repeat applied zero additional mappings, confirming idempotence. Nothing was published |
| Production portal access | Expose the application sign-in screen at `portal.urbanxtracts.com`; use Supabase authentication and server-side portal permissions instead of a ChatGPT/Sites viewer gate | The production origin is the Supabase Site URL and an allowed redirect. Email/password remains available for retailer users, Google Workspace remains available for employees, and first-time workforce users receive Viewer access |
| Public onboarding anti-abuse | Require a hostname-restricted production Turnstile token plus an atomic HMAC-scoped daily limit of 3 for signed-out requests | The rotated secret is stored only in Supabase; the public site key is supplied by Sites; validation requires the exact `retailer_onboarding` action and `portal.urbanxtracts.com` hostname |

## Controlled deferrals

| Priority | Item | Current safe behavior | Decision owner | Decision needed |
| --- | --- | --- | --- | --- |
| P0 before production deployment | Product-image and COA review policy | Private portal storage, MIME/size validation, approval states, atomic activation, and five-minute signed catalog URLs are implemented. Monday's `protected_static` links remain prohibited | IT / Quality | Decide automated scanner requirement, reviewer separation, quarantine/archive retention, and then begin controlled uploads |
| P0 before live pricing | Wholesale price-to-Canix crosswalk | The 118-row `ACTIVE CART` price source is readable, but it has no Canix Item ID and Brand is encoded as section headings. Only 8 rows uniquely match the current catalog by product name + Brand; 107 require review | Sales Operations / Data | Add or approve the immutable Canix Item ID for each review-required row, then stage and publish the default list prices without touching store-specific approvals |
| P0 before live QuickBooks views | QuickBooks portal OAuth and customer identity mapping | The portal OAuth broker, encrypted token store, functions, development client credentials, and correct `URBANXTRACTS INC` operator connection exist, but the portal OAuth connection is still disconnected and no successful financial snapshot exists. Production Intuit credentials remain locked behind the company attestations and stable-US-IP response documented in the QuickBooks runbook | Finance / IT / Sales Operations | Complete the Intuit production review, authorize the portal read-only connection, resolve duplicate licenses, populate verified Customer IDs, approve refresh cadence, and mark reviewed rows Ready to Sync |
| P1 | Minimum order and lead time | Fields remain blank; no fabricated enforcement | Sales operations | Identify authoritative source and policy |
| P1 | Margin formula and component-coverage threshold | Cost/margin stays out of navigation | Finance | Define included cost components and minimum coverage |
| P1 | Exception ownership and service levels | Status is visible; no unsupported clock is promised | Operations | Name owner and response target by exception type |
| P1 | Approval aging and escalation | Store Owner remains the sole approval holder with no automatic delegation | Sales leadership | Define escalation time and backup path |
| P1 | License review evidence and cadence | Portal records explicit qualification; it does not claim independent validity | Quality / Compliance | Name reviewer, retained evidence, and recheck cycle |
| P2 | Monday store-visit notes | Account notes remain source-labelled and unverified | Sales operations | Map board columns and retention |
| P2 | Reorder interval definition | Uses only urbanXtracts order history; no retailer sell-through is inferred | Sales leadership | Choose average interval or days-since-last-order |
| P2 | MFA policy | No portal-specific MFA promise; shared kiosk mode carries no personal account data | Administration | Set workforce and retailer MFA requirements |
| P2 | Rep-held order approval | Disabled | Legal / CCO / Sales leadership | Approve written authority model or reject feature |
| P2 | Draft inventory holds | Drafts hold nothing; submit rechecks availability | Operations / Sales operations | Decide whether reservations ever occur before acceptance |
| P2 | Receiving claims | Retailer self-service claim workflow is not a production connector | Operations | Set time window, evidence, and disposition process |
| P2 | Notification channels and mandatory notices | No unapproved external notice is sent | Sales leadership / CCO | Choose channels, consent, and non-optional events |
| P2 | Document types and retention | Upload surfaces are not treated as a final records system | Operations / CCO | Define types, retention, and wind-down handling |
| P2 | Store API | No customer API credential is issued | Administration / Security | Define scope, credential lifecycle, and rate limits |
| P2 | Public COA resolver | Disabled; COAs remain authenticated | CCO / Security | Approve fields, retention, retest history, opaque codes, rate limit, and non-enumeration behavior |
| P2 | Public recall notice | Disabled; internal lot-impact analysis remains read-only | CCO | Approve trigger, wording, publication deadline, and acknowledgement model |
| Later | Payment collection | Balances, invoices, and payments are display-only | Finance / Legal / Security | Select processor and approve payment, refund, PCI, and dispute model |

## Release rule

A controlled deferral does not become a release blocker while its capability is absent from production navigation, cannot be triggered by an external user, and has a documented fail-closed or blank state. Enabling one requires its named decision, server-side implementation, authorization tests, audit coverage, and an update to the live readiness diagnostics.
