# ChatGPT handoff — Store release site publish

Date: 15 October 2026. Written for the ChatGPT/Sites session that maintains and publishes `portal.urbanxtracts.com`. It assumes no prior conversation context.

## Status in one line

A coordinated release candidate is staged, tested and waiting on human approvals. **Do not publish anything yet.** This handoff explains what will be published, what must be true first, and what must not change.

## What is currently live

- Sites version **172** at `https://portal.urbanxtracts.com/`.
- The outer Sites/ChatGPT viewer gate is removed by design. The portal shows its own sign-in screen and all protection comes from Supabase authentication plus server-side permissions.
- Store access is **disabled**. Store ordering is **held**. Notifications are **off**. The only Store-shaped surface in production is a synthetic demonstration restricted server-side to active Internal Administrators holding `store.demo` authority.

## What the pending release changes

Pull request #2 on `Tom-urbanXtracts/UX-Portal`, branch `codex/three-workspace-restructure`. Publish only from the head SHA recorded in the PR #2 approval and IT release acceptance. Do not take a head from this file. The deployable unit is the whole three-workspace restructure, not a Store-only slice:

- five database migrations;
- 16 new and 22 changed Supabase edge functions;
- one frontend bundle — `dist/portal.html` and `dist/server/index.js`.

Store surfaces stay switched off through the release. Brand and Internal surfaces change materially.

## Your part, precisely

Publish the committed `dist/server/index.js` as the Sites version after 172 — **and only after** a person confirms all of the following, in this order:

1. PR #2 has a recorded review approval.
2. The five candidate migrations have been applied to production in their listed order. The list is `artifacts/store-demo-release-2026-10-15/production-candidate-migrations.json`; it is approved only when `approvedBy` and `approvedAt` are populated.
3. The 38 edge functions have been deployed.
4. IT has recorded release acceptance.

Publish the **committed** artifact. Do not rebuild locally and publish the result. CI already asserts the committed `dist` matches source via `git diff --exit-code -- dist`, and a local rebuild breaks that guarantee.

The ordered sequence, verification steps and rollback are in `docs/store-release-deployment-runbook-2026-10-15.md`. Treat that runbook as authoritative over this summary.

## Hosting configuration

The worker reads four values. None is a secret and none should be placed in source:

| Value | Setting |
| --- | --- |
| `UX_SSO_PROVIDER` | `google` |
| `UX_SSO_DOMAIN` | `urbanxtracts.com` unless the approved workforce domain changes |
| `UX_TURNSTILE_REQUIRED` | `true` when the server flag is enabled |
| `UX_TURNSTILE_SITE_KEY` | the public Turnstile site key authorized for `portal.urbanxtracts.com` |

Keep `portal.urbanxtracts.com` in the Supabase Auth redirect allow-list and keep the Supabase Site URL set to `https://portal.urbanxtracts.com/`.

## Do not

- Do not publish before the four confirmations above.
- Do not re-add an outer Sites or ChatGPT viewer gate. Its removal was a recorded decision; protection is server-side.
- Do not enable Store access, release the Store ordering hold, invite external Store users, or turn notifications on. Each is a separate decision with its own evidence.
- Do not apply, reorder or re-run database migrations. Candidates 2, 3 and 4 are not re-run safe and a second apply fails.
- Do not use `supabase db push` against production or staging.
- Do not change or remove the `noindex` directive on the published page.
- Do not alter the Store demo's Internal Administrator restriction.

## Data boundaries that apply to anything you draft or publish

- A brand sees only material it owns or has tolled; a store only its own orders, AR and menu. Never produce output showing one counterparty another's data.
- Never expose economic owner, cost, partner terms, settlement calculations, rate cards, unit economics, or which brands toll through UX in anything brand-, store- or public-facing.
- Public COA pages show lab result, batch and dates only. Never interpret a COA result.
- Never supply a regulatory citation from memory, and never state that a control is compliant or sufficient. Those belong to the CCO against current published rules.
- Canix remains authoritative for physical inventory and compliance; Metrc is the state record of authority; QuickBooks is authoritative and read-only for Store accounting in this scope.

## Gates still open on the business side

Finance payment terms and hold-release authority (no credit cap applies); QuickBooks field and export allowlists; catalog case/minimum/increment values and price precedence; the mandatory retailer document class list; notification audiences and templates; named pilot users; and a named real retailer cohort before any live-retailer activation. Synthetic demonstration evidence cannot satisfy real licence or accounting readiness, and none of these is closed by publishing the site.

## Where to read more

| Topic | File |
| --- | --- |
| Release evidence and remaining blockers | `docs/store-staging-release-candidate-2026-10-15.md` |
| Apply order and per-migration review | `docs/deployment-readiness.md` |
| Execution sequence, verification, rollback | `docs/store-release-deployment-runbook-2026-10-15.md` |
| Machine-checkable candidate list | `artifacts/store-demo-release-2026-10-15/production-candidate-migrations.json` |
| Build contract, roles, acceptance criteria | `docs/store-workspace-first-release-activation-handoff.md` |
| Dependency findings DEP-01 to DEP-12 | `docs/store-workspace-dependency-review-2026-10-14.md` |
