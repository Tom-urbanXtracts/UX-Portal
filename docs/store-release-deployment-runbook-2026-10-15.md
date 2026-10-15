# Store release deployment runbook — 15 October 2026

Status: **prepared, not authorized.** Every step below is written to be executed by a person after the approval gates in section 1 are recorded. Nothing in this document authorizes a deployment, and no step here was executed in preparing it.

Release artifact: [pull request #2](https://github.com/Tom-urbanXtracts/UX-Portal/pull/2), branch `codex/three-workspace-restructure`. Read the current head from the PR; the approved SHA is recorded in the PR #2 approval and IT release acceptance, not in this file. Evidence: [staging release candidate](store-staging-release-candidate-2026-10-15.md). Migration list: [deployment readiness](deployment-readiness.md#store-release-candidate-migrations--15-october-2026).

## 1. Gates that must be closed first

Do not begin section 3 until all of these are recorded. None of them is a technical task and none can be closed from inside the repository.

| Gate | Owner | Current state |
| --- | --- | --- |
| Coordinated review and approval of PR #2, recording the approved head SHA | OS Portal Arch with IT | Open — no review decision on PR #2 |
| CI and `npm run verify` green at that exact approved head | IT | Open — staging evidence is anchored to `d14683e`; later commits changed executable code ([details](store-staging-release-candidate-2026-10-15.md#release-head-and-re-verification)) |
| Approval of the candidate migration list | IT with OS Portal Arch | Open — `approvedBy` and `approvedAt` are null in `production-candidate-migrations.json` |
| Finance payment terms, hold-release authority, freshness policy (no credit cap applies) | Finance with Systems Integrations | Open — DEP-08, OSPA-06 |
| QuickBooks financial field and export allowlists | Finance | Open — DEP-06 |
| Catalog case/minimum/increment values and price precedence | Sales, Operations, Quality, Systems Integrations | Open — DEP-04, OSPA-04 |
| Mandatory retailer document class list | Quality, Operations, IT/Compliance | Open — OSPA-05 |
| Announcement/notification audiences and templates | Shared Workflow Services | Open — DEP-09, OSPA-09 |
| Named pilot users for external Store acceptance | Owner with IT, Operations, Quality, Finance, Sales | Open |
| IT release acceptance recorded | IT release owner | Open |

Store access stays disabled and Store ordering stays held through this entire runbook. Releasing either is a separate decision with its own evidence.

## 2. What this release actually deploys

The deployable unit is the whole three-workspace restructure, not the Store slice alone. Store surfaces remain switched off; Brand and Internal surfaces change materially.

- 16 new edge functions: `canix-marketplace-sync`, `monday-brand-webhook`, `monday-supply-order-webhook`, `portal-brand-application`, `portal-brand-documents`, `portal-brand-onboarding`, `portal-brand-operations`, `portal-brand-profile`, `portal-brand-supply-chain`, `portal-brand-support`, `portal-data-controls`, `portal-internal-work`, `portal-purchase-approval`, `portal-sku-intake`, `portal-store-demo`, `portal-work-queue`.
- 22 changed edge functions, including all 21 that import `_shared/request-workspace.ts`.
- One frontend bundle: `dist/portal.html` and `dist/server/index.js`, published through the Sites project.
- Five database migrations, listed in deployment readiness.

The production schema is otherwise current. Of 139 repository migrations, 133 are already applied to production (116 exact matches plus 17 timestamp aliases) and one production-only entry is byte-identical to its repository source. Only the six candidates are outstanding; candidate 6 (`20261015120000_store_financial_hold_and_license_lifecycle.sql`, local code only) carries a rollout prerequisite recorded in [deployment readiness](deployment-readiness.md#store-release-candidate-migrations--15-october-2026).

## 3. Ordered sequence

### 3.1 Capture the pre-release baseline

Record, from production, before changing anything: live `portal_order` count, notification outbox row count, demo Store membership count, current Sites version, the deployed function versions for every name in section 2, and the current Store access switch and Store ordering hold states. The prior readback was two live orders, 80 notification rows, zero demo Store memberships, demo enabled, both candidate tables absent. Store the capture beside the release record. Rollback decisions depend on it.

### 3.2 Apply the five migrations

Apply in the listed order, one at a time, each in its own transaction, confirming success before the next. Use the explicit reviewed list — never `supabase db push`.

1. `20261014213000_approve_store_workspace_activation_planning.sql` — re-run safe; restates values production already carries and adds the missing ledger row.
2. `20261014215429_store_membership_access_foundation.sql` — **not** re-run safe.
3. `20261014220938_store_endpoint_access_commands.sql` — **not** re-run safe. Revokes `public`/`anon`/`authenticated` on ten tables; `service_role` is unaffected.
4. `20261014223749_store_membership_administration.sql` — **not** re-run safe.
5. `20261015003000_provision_workforce_workspace_membership.sql` — re-run safe; calls `portal_repair_workforce_workspace_memberships()` itself and fails closed if the active Internal organization is missing.

After step 5, confirm the repair reported a row count and that an existing workforce identity still resolves an active Internal membership. A workforce identity without that row receives 403 from every handler in section 2.

If any step fails, stop. Do not attempt the next migration and do not deploy functions. Steps 2, 3 and 4 need an explicit repair review before any second attempt.

### 3.3 Deploy the edge functions

Deploy all 38 together, after the migrations. `portal-admin` additionally requires candidate 4.

Deploying handlers before the migrations degrades closed, not open: `resolveStoreContext` and `storeCommand` return 503 or 403 when their database functions are absent, and `requestWorkspace` returns on the Internal and Brand branches before either is reached. That is a safety property, not a licence to reorder.

### 3.4 Publish the site bundle

Publish `dist/server/index.js` from the approved head through the Sites project, producing the version after 172. CI already verifies the committed `dist` matches source (`git diff --exit-code -- dist`), so publish the committed artifact rather than a local rebuild.

## 4. Post-deployment verification

Run, and record the output with the release record:

- `npm run verify` — all release contracts, Node tests and Deno tests pass. Record the counts with the release record. They must equal the CI run at the approved head. For reference, `d14683e` recorded 578/138/54.
- `npm run verify:migration-baseline` — now also asserts the candidate list matches the reconciliation and the files on disk.
- `npm run verify:remote` — probes every deployed production function anonymously and asserts each denies. This uses only the public Supabase URL and anon key already embedded in the portal source; it sends no credentials and writes nothing.
- Confirm the Store access switch is still disabled, Store ordering still held, notifications still off, and the Internal Administrator demo still reachable only by active Internal Administrators with `store.demo` authority.
- Confirm a Brand identity and an Internal identity each complete one authorized read on the new bundle.

A failure in any of these is a rollback trigger, not a follow-up ticket.

## 5. Rollback

Rollback is forward-repair and preservation, never a destructive down migration. The rehearsed coordinated rollback passed in staging without deleting durable history.

1. Set Store access disabled and Store ordering `hold` server-side first, using the narrowest control.
2. Republish the previous Sites version (172) if the frontend is implicated.
3. Redeploy the previous function versions captured in 3.1 for the implicated functions only.
4. Leave the applied migrations in place. The schema is additive; candidates 2, 3 and 4 create new objects and revoke browser grants that no deployed path uses. Reversing the revoke would re-expose ten tables to `authenticated` and must not be done as a reflex.
5. Preserve accepted orders, snapshots, comments, evidence, audit history, Monday history and reconciliation identifiers. Delete nothing.
6. Keep the workspace disabled until cause, affected records, repair evidence, regression tests and renewed approval are recorded.

## 6. Out of scope for this runbook

Enabling Store access, releasing the Store ordering hold, inviting external Store users, qualifying a synthetic licence, enabling notifications, any Canix or QuickBooks write, any new Monday board or automation, and broad live-retailer activation. Each needs its own decision and evidence.
