# Security Hardening Proposal: Centralize Privileged Administration And Audit

## Decision

We need to choose the server boundary that will authorize privileged portal mutations and produce their durable security-audit records. The decision covers staff-role assignment, user activation and deactivation, organization and location access, impersonation controls, privileged inventory refreshes, and future administrative commands. It does not change the product's customer-facing role model.

## Executive Recommendation

We recommend Option 2, a central Supabase policy and RPC boundary, while Supabase remains the portal's identity and operational data platform. One resource-aware policy function should evaluate the authenticated user, capability, organization, location, and final resource identity. A typed RPC should then perform each permitted mutation and append its audit record within the same database transaction.

This gives us a materially smaller omission surface than per-feature checks without paying the operational cost of a new administration service and queue. We should reconsider Option 3 only if measured command volume, cross-system workflow, independence requirements, or fault-isolation needs outgrow a single Supabase transaction boundary.

## Evidence

- **E001 — Portal authentication, route gating, and browser-side administration.** [`ux-portal-prototype.dc.html`](../../ux-portal-prototype.dc.html) obtains server-returned capabilities and filters internal routes, but multiple administration, role, impersonation, and audit interactions still use browser state. Route visibility is helpful UX; it is not an authorization boundary.
- **E003 — Canix inventory Edge Function authorization.** [`supabase/functions/canix-inventory/index.ts`](../../supabase/functions/canix-inventory/index.ts) checks `inventory.read` and `inventory.sync` on the server. This is a strong local pattern, but its decision logic is owned by this endpoint.
- **E004 — Private Canix cache and service-role boundary.** [`supabase/migrations/20260901062000_canix_inventory_sync.sql`](../../supabase/migrations/20260901062000_canix_inventory_sync.sql) denies browser roles direct access to private operational tables, demonstrating that browser clients can work through an owned server boundary.
- **E005 — Workforce staff-role and capability mapping.** [`supabase/migrations/20260901090000_portal_staff_access.sql`](../../supabase/migrations/20260901090000_portal_staff_access.sql) establishes five staff presets and a server-owned role-to-permission mapping. It does not yet provide a resource-aware authorization function, durable audit table, or transactional administration RPCs.

Evidence identifiers, hashes, drift, and limitations are recorded in [`../context.md`](../context.md). We have not treated absent remote source or an unactivated OAuth provider as verified behavior.

## Current Design And Failure Mode

The prepared portal separates authentication from route discovery and now enforces Canix inventory read and sync capabilities inside the Edge Function. That is a meaningful improvement. The remaining problem is that no single server-owned contract governs all privileged actions.

Today, a new feature can correctly hide its UI and still omit a server resource-scope check, write an inconsistent audit event, or authorize against a caller-supplied organization or location. Browser-managed administration can also look successful without creating a durable server record. A removed grant may disappear from navigation after refresh while a separate endpoint still evaluates an older or incomplete rule. These are design-level drift paths, not evidence that a specific unauthorized production mutation has occurred.

## Desired Invariants

1. Every privileged mutation is authorized on the server against the final user, capability, organization, location, and resource identity.
2. The mutation and its security-audit event commit together or both fail.
3. Deactivation or grant removal takes effect on the next server request, independent of browser navigation state.
4. The browser cannot widen organization or location scope through request fields.
5. Route discovery, endpoint enforcement, administration, and audit reporting use the same capability vocabulary.
6. Denials have stable codes and enough correlation data for operations without exposing sensitive policy details to the browser.

## Constraints And Non-Goals

Canix credentials and package rows cannot enter the browser bundle. Google Workspace provides authentication only; portal profile state and grants provide authorization. External organization and location scope must stay server-owned. Existing internal users cannot be accidentally locked out or silently promoted during the first migration.

We assume Supabase remains the near-term platform. We are not selecting an enterprise policy language, replacing Supabase Auth, redesigning customer roles, or defining a full security information and event management program in this proposal. We also have no measured performance budget, so all latency and capacity acceptance thresholds must be set before rollout.

## Before Architecture

[`../diagrams/centralize-privileged-administration-before.mmd`](../diagrams/centralize-privileged-administration-before.mmd)

The browser currently consumes the staff profile and capability vocabulary, feature endpoints make local decisions, and prototype administration uses local state. This fragments policy and audit ownership.

## Options

### Option 1: Complete Per-Feature Enforcement

We would keep each Edge Function or RPC responsible for its own authentication, capability, resource scope, mutation, and audit write. All callers would share the existing role-permission table and common naming conventions, but each feature would implement the enforcement sequence locally. This is the smallest migration because actions can move one family at a time.

This option removes browser-only privileged success paths and adds durable records, but it leaves omission and semantic drift as recurring engineering risks. A future endpoint may check the capability but trust a caller-supplied organization, or it may commit the mutation before an audit failure. Reviews and incident queries also need to understand multiple implementations.

Before: [`../diagrams/centralize-privileged-administration-before.mmd`](../diagrams/centralize-privileged-administration-before.mmd)  
After: [`../diagrams/centralize-privileged-administration-local-enforcement-after.mmd`](../diagrams/centralize-privileged-administration-local-enforcement-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Privileged mutations | Browser state or feature-specific paths | Durable feature endpoints/RPCs | Removes browser-only authority | Every feature needs its own implementation |
| Authorization | UI and per-endpoint checks | Per-feature server capability and scope checks | Improves enforcement but retains omission risk | Repeated review and test work |
| Audit | Browser/inconsistent feature history | Durable audit writes per feature | Creates server evidence but may not be atomic everywhere | Repeated schema and failure handling |
| Operations | Fragmented | Still feature-owned | Denial semantics can drift | Multiple dashboards and runbooks |

### Option 2: Central Supabase Policy And RPC Boundary

We would add a reviewed `portal_authorize` function that resolves the authenticated profile and validates capability plus resource scope. Typed administration RPCs would call it, execute the mutation, and append an audit event in the same transaction. Edge Functions such as Canix inventory would keep token validation and their service responsibilities but delegate the portal policy decision to the same function.

The browser would continue to use the returned permissions for navigation and helpful disabled states, while treating every server denial as authoritative. Private operational tables would remain unavailable to `anon` and `authenticated`; only narrowly granted functions could cross the boundary. We would standardize resource identity, denial codes, audit fields, and correlation identifiers.

This concentrates risk in a security-critical security-definer function, so ownership, code review, fixed `search_path`, least-privilege grants, deny-matrix testing, and database change control become release requirements. It also creates contract migration work for existing actions. In return, it substantially reduces authorization and audit drift without another network service.

Before: [`../diagrams/centralize-privileged-administration-before.mmd`](../diagrams/centralize-privileged-administration-before.mmd)  
After: [`../diagrams/centralize-privileged-administration-policy-rpc-after.mmd`](../diagrams/centralize-privileged-administration-policy-rpc-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Policy | Caller-owned and partially duplicated | One resource-aware decision function | Reduces missing and inconsistent checks | Central function becomes security-critical |
| Mutation | Browser or feature-owned | Typed transactional RPC | Server owns final inputs and authorization | Existing flows need contracts |
| Audit | Local or non-atomic | Append-only event in mutation transaction | Prevents successful mutation without its audit record | Retention and export policy required |
| Revocation | May depend on refreshed client state | Evaluated on every request | Grant removal is promptly effective | Adds a database policy lookup |
| Operations | Feature-specific denials | Stable denial taxonomy and query surface | Improves access review and incident response | Requires owners, alerts, and change control |

### Option 3: Dedicated Administration Service

We would create a separately deployed command API and policy engine. Privileged requests would be authorized by the service, assigned an idempotency key, placed on an audited queue, and applied by domain workers. An immutable audit stream could be exported independently from the operational database, and the portal would become an unprivileged command client.

This option offers the clearest isolation if administration grows into high-volume or multi-system orchestration. It also introduces service credentials, queue tenancy, network policy, retries, poison commands, eventual consistency, new telemetry, and another on-call surface. Those additions are security and reliability responsibilities rather than free isolation.

Without evidence that present volume or independence requirements exceed Supabase, the service would be premature. It should remain an architectural escape hatch with explicit triggers rather than the immediate build target.

Before: [`../diagrams/centralize-privileged-administration-before.mmd`](../diagrams/centralize-privileged-administration-before.mmd)  
After: [`../diagrams/centralize-privileged-administration-admin-service-after.mmd`](../diagrams/centralize-privileged-administration-admin-service-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Trust boundary | Browser, Supabase, feature endpoints | Dedicated command service and workers | Isolates privileged commands | Adds service and queue credentials |
| Execution | Mostly synchronous feature paths | Idempotent queued commands | Can contain failures and retries | Creates eventual-consistency states |
| Audit | Local or database-bound | Independent audit stream | Improves separation and export | Needs retention, integrity, and replay operations |
| Availability | Supabase-centered | Multi-component | Can isolate outages | Adds partial failures and backlog recovery |
| Operations | Existing platform | Service, queue, workers, dashboards | Clear ownership if staffed | Highest ongoing cost |

## Comparison

| Dimension | Option 1: Per-feature | Option 2: Central policy/RPC | Option 3: Admin service |
| --- | --- | --- | --- |
| Security | Improves; drift remains | Strongest fit for current architecture | Strong isolation, new credential and queue surface |
| Performance | No new service hop | One in-platform transaction path | Network and queue overhead |
| Memory/capacity | Small bounded change | Small request-memory change; audit storage grows | Separate runtime and queue capacity |
| Reliability | Better durability, possible non-atomic paths | Atomic policy, mutation, and audit | Isolation plus complex retries and partial failures |
| Operability | Repeated feature ownership | One policy and audit surface | Additional platform and on-call burden |
| Migration | Easiest incremental path | Moderate typed-contract migration | Largest command-protocol migration |
| Best fit | Short tactical bridge | Current portal platform | Future high-scale/cross-system administration |

## Recommendation

We recommend Option 2. It addresses the observed split between browser state, local endpoint policy, and role-permission data while building on the existing private-table and security-definer model. It also supports an incremental rollout: migrate a low-risk action, operate it beside read-only legacy presentation, then move each action family after its denial and rollback tests pass.

The recommendation changes if either of two conditions emerges. If the team cannot establish clear ownership and review for the central function, Option 1 is safer as an explicit, well-tested bridge. If administration becomes a high-volume, multi-system command plane with independent availability or audit-export requirements, Option 3 should be reconsidered using measured traffic and operational capacity.

## Evidence Coverage And Residual Risk

Option 2 directly addresses E001 and E005 by moving privileged authority behind server RPCs and using the capability model as a shared policy input. It extends the private-data pattern in E004. It mitigates E003 because Canix can delegate capability evaluation while retaining its existing authentication and cache controls.

Residual risk remains. A defect in the central policy function can affect all callers. Security-definer ownership and grants require careful review. Audit history still needs retention, independent export, and tamper-monitoring decisions. The remote `portal-intake` implementation is outside the reviewed source. The portal now fails closed when a staff preset or permission response is missing, so the access migration must assign every current internal user before this build is released.

## Migration And Rollout

1. Inventory every privileged browser action and remote profile mutation; obtain the `portal-intake` source.
2. Define canonical resource types and identifiers for user, organization, location, order, inventory sync, quality, and audit access.
3. Add the append-only security-audit schema, stable event fields, correlation ID, actor, target, decision, and redaction rules.
4. Implement and review `portal_authorize` with fixed `search_path`, least-privilege execution, and no caller-controlled scope widening.
5. Migrate user deactivation and staff-role assignment first because they exercise revocation and elevation semantics without involving Canix data.
6. Adopt the shared decision in Canix inventory and remaining Edge Functions while preserving their service-specific controls.
7. Initialize existing internal profiles as viewers, explicitly bootstrap the first administrator, and verify every staff preset before releasing the fail-closed portal build.
8. Enable access-review reports, denial telemetry, retention, and independent audit export before broad administrator rollout.

At every stage, a failed migration leaves the affected action read-only rather than falling back to browser-managed mutation. Existing permission data and audit history are retained during rollback.

## Validation Plan

- Run a deny matrix covering every preset, missing capability, inactive profile, cross-organization ID, cross-location ID, aliased resource ID, and external-role request.
- Verify that removing a grant or deactivating a user is effective on the next request and does not rely on client refresh.
- Force policy, mutation, and audit failures; confirm the transaction rolls back and returns stable, non-sensitive error codes.
- Attempt direct table access as `anon` and `authenticated`; confirm private operational and audit tables remain unavailable.
- Test duplicate and replayed administrative requests with idempotency expectations defined per action.
- Measure p50 and p95 RPC latency, payload size, audit storage growth, and Edge Function memory before choosing release thresholds.
- Review security-definer ownership, grants, `search_path`, dynamic SQL use, and input normalization in every migration.
- Execute staged rollout with administrator, operations, sales, quality, viewer, owner, buyer, and budtender test accounts.

## Implementation Work Packages

1. **Policy contract:** canonical capabilities, resource types, scope rules, stable allow/deny result, and ownership documentation.
2. **Audit foundation:** append-only table, redaction rules, transactional write helper, retention, export, and access-review queries.
3. **Identity administration RPCs:** staff preset assignment, activation/deactivation, external organization and location grants, and elevation safeguards.
4. **Endpoint adoption:** Canix sync, quality, orders, accounts, and future privileged functions use the common decision.
5. **Portal integration:** browser calls typed RPCs, handles authoritative denials, removes prototype-only success claims, and never infers access from visible navigation.
6. **Migration safety:** seed and review current staff presets, monitor denials, and keep a read-only rollback mode.
7. **Verification and operations:** automated deny matrix, atomicity tests, denial telemetry, quarterly review procedure, and incident runbook.

No implementation files are included with this proposal. We should create them only after the option and open policy decisions are approved.

## Open Questions

1. What retention period and independent export destination should apply to privileged security-audit events?
2. Who may assign the `administrator` preset, and does that elevation require two-person approval?
3. Which remote `portal-intake` operations currently mutate profiles or operational data, and can their source be added to this repository?
4. What measured p95 response target should privileged synchronous actions meet?
