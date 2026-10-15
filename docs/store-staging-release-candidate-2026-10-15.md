# Store staging release candidate — 15 October 2026

## Release state

**Not approved for production deployment.** Production is unchanged. Store access is disabled, Store ordering is held, and the synthetic demonstration remains available only to Internal Administrators.

## Passed staging evidence

- 578 release contracts, 138 Node tests and 54 Deno tests pass.
- 24 grouped disposable-database Store scenarios pass.
- Eight real-authentication access groups pass.
- Nine full-schema order, approval, freshness, outage, preorder, claim and direct-access groups pass.
- Six exposure/private-asset groups pass. Private files require server authorization; issued links expire after five minutes.
- Three positive scanner groups pass: a clean Brand PDF is accepted, an EICAR-bearing PDF is rejected with no durable infected record, and the clean evidence is archived.
- Three coordinated rollback groups pass without deleting durable history.
- A real Google Workspace sign-in provisions Viewer access and receives 403 from the Administrator-only Store demo.
- Store access is disabled and Store ordering is held after each remote rehearsal.

## Migration baseline

The [baseline reconciliation artifact](../artifacts/store-demo-release-2026-10-15/migration-baseline-reconciliation.json) compares the repository, production migration history and staging history.

- 138 repository migration files were inventoried.
- 134 production history rows were inventoried.
- 116 match by name and timestamp.
- 17 have the same migration name with a different applied timestamp; each alias is enumerated.
- The single production-only history entry is byte-identical to the repository's passwordless Supply Order migration, so no SQL source is missing.
- Five repository-only entries are the Store activation planning/candidate migrations.

The staging database was intentionally created from a schema-only production baseline and reviewed candidate migrations. Historical migrations must not be replayed against it. Production rollout must use an explicit reviewed candidate list, not an automatic database push.

## Source and automation boundary

- Canix Shop uses a controlled supervised refresh. No Canix Support request will be sent, and unattended Shop refresh is outside this release plan.
- Canix remains authoritative for physical inventory/compliance and the five-minute order-submission freshness rule remains unchanged.
- QuickBooks remains authoritative and read-only for Store accounting in this scope.
- No notification, Monday, source-write, or production credential is enabled in staging.
- The GitHub workflow builds, verifies committed output, runs release/service tests, verifies the migration baseline, runs Store concurrency tests, and checks patch whitespace. It does not deploy.

## Remaining release blockers

1. [Pull request #2](https://github.com/Tom-urbanXtracts/UX-Portal/pull/2) now contains the coordinated migration, function, frontend, staging, and verification release artifact. It still requires coordinated review and approval before merge or any production deployment.
2. Required Finance, Operations, catalog-rule, recipient/export and real-pilot inputs remain held in the decision register.
3. External Store acceptance remains held until pilot users are named. The current demonstration stays Internal Administrator-only.

No production deployment may begin until every applicable blocker is closed and IT records release acceptance.
