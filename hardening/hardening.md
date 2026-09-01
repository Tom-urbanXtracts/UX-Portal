# Security Hardening Review: urbanXtracts UX OS Portal

## Evidence Basis

We reviewed the current working tree at base revision `ccbfac5df3ed143f8cfa7a40b897f3d08fbaa343`. The evidence set covers the portal client, Sites build boundary, Canix Edge Function, private inventory-cache migration, staff access migration, deployment checklist, and Google Workspace SSO runbook. The reviewed source has uncommitted drift; evidence identities and limitations are recorded in [context.md](context.md), and the machine-readable portfolio is in [hardening.json](hardening.json).

This is a source-based hardening review, not a claim that the remote Supabase project or the undeployed Google OAuth configuration has been tested in production. In particular, the remote `portal-intake` implementation and the complete historical `portal_profile` schema are not present locally.

## Constraints

- Canix credentials and package rows must remain outside the browser bundle.
- Authentication and authorization must be separate: a successful Google sign-in does not itself grant portal access.
- External users must remain constrained by organization and location on the server, regardless of request fields.
- Existing internal users need a migration path that avoids accidental lockout.
- Supabase is assumed to remain the identity, policy-data, and serverless platform for the next deployment phase.
- No measured latency, audit-retention, memory, or administrator-volume budget was supplied.

## Opportunity Portfolio

| Priority | Opportunity | Current exposure | Options | Recommended direction |
| --- | --- | --- | --- | --- |
| 1 | [Centralize privileged administration and audit](proposals/centralize-privileged-administration.md) | Capability-aware navigation and inventory checks exist, but several administrative mutations and their audit trail are still represented in browser state or separate feature paths. | Complete per-feature enforcement; central Supabase policy/RPC boundary; dedicated administration service | Central Supabase policy/RPC boundary while Supabase remains the portal platform |

The portal already has a useful capability vocabulary and a private Canix cache boundary. The next material reduction in risk comes from making one server-owned decision authorize the final actor, capability, organization, location, and resource, then committing the mutation and security-audit event together.

## Recommendation Summary

We recommend the central Supabase policy and RPC boundary. It reuses the platform and private-table model already present, keeps authorization close to the data, and can make privileged mutations and audit records atomic. It is a stronger structural control than duplicating checks per endpoint and materially simpler to operate than introducing a dedicated service and queue today.

This recommendation is conditional on three controls: the security-definer policy function receives focused review and denial tests, every internal profile receives an explicit staff preset before the fail-closed portal is released, and audit retention plus administrator-elevation rules are explicitly approved.

## Next Decisions

1. Select the central Supabase policy/RPC boundary or request a refinement of its assumptions.
2. Decide who may grant the `administrator` preset and whether that elevation needs two-person approval.
3. Set a retention and independent export policy for privileged security-audit events.
4. Bring the remote `portal-intake` source into the same review boundary before privileged profile mutations are migrated.
5. Verify every existing internal profile has an explicit staff preset before the fail-closed portal build is released.
