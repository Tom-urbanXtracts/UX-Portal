# Security hardening evidence context

## Source identity

- Source root: `/Users/Apple/Documents/GitHub/UX-Portal`
- Base Git revision: `ccbfac5df3ed143f8cfa7a40b897f3d08fbaa343`
- Source drift: present. The reviewed working tree contains the SSO, workforce-access, inventory-boundary, and product-experience changes prepared in this task.
- Evidence collection SHA-256: `39c55e637ddfc12390a42ae08d01da5499a69a7494eec4f527bccbf72186522e`
- Evidence mode: ordinary source review; no Codex Security scan or sealed scan manifest was supplied.

## Evidence inventory

| Evidence | Reader-facing title | Path | SHA-256 | Labels |
| --- | --- | --- | --- | --- |
| `E001` | Portal authentication, route gating, and browser-side administration | `ux-portal-prototype.dc.html` | `ec160d7cb35c06622422a5c8105d92f568a7ec0c336d3fd9164c9feb7698c9a1` | source, authentication, authorization, admin |
| `E002` | Sites build and response security boundary | `scripts/build-sites.mjs` | `01100d111dd093162cf1e8858ab9c805a96bc071577805966f286f3695bc2931` | source, deployment, headers |
| `E003` | Canix inventory Edge Function authorization | `supabase/functions/canix-inventory/index.ts` | `dbc09451e0452372abfbc00b1853f5fbf03119fa38ad542ffe9e7acdd2a76e90` | source, endpoint, authorization |
| `E004` | Private Canix cache and service-role boundary | `supabase/migrations/20260901062000_canix_inventory_sync.sql` | `fd778db8cc484719d909d9e2bcfb6b83b2c96cec9f84c5a0c533c70594048005` | source, database, RLS |
| `E005` | Workforce staff-role and capability mapping | `supabase/migrations/20260901090000_portal_staff_access.sql` | `70c114ea339c79c40b498fecec87189d1aca45855f898e02d648e2b61171fd34` | source, database, RBAC |
| `E006` | Deployment and cutover checklist | `docs/deployment-readiness.md` | `8365d79f31fc69b137a98e45c6cf053d417d4e1fcf495223ce0436f903f0faa9` | document, operations |
| `E007` | Google Workspace SSO setup and acceptance checks | `docs/google-workspace-sso-setup.md` | `695efdb1d4a1c58a9e154103e9f146715cf90a6aa0551a10723190ac9f7ecbe1` | document, SSO, rollout |

## Observed evidence

- `E001` loads the signed-in profile from Supabase, requires an explicit staff preset, and fails closed if the server-owned permission list is unavailable.
- `E001` still models most privileged administration, role changes, and its audit history in browser state. Those actions demonstrate the intended experience but are not a durable authorization or audit boundary.
- `E003` checks `inventory.read` for reads and `inventory.sync` for user-triggered refreshes. Scheduled sync retains its separate server-side secret.
- `E004` removes direct `anon` and `authenticated` access to the Canix cache tables.
- `E005` defines five workforce presets and a server-owned mapping to capabilities. It does not yet define transactional administration RPCs or a durable security-audit table.
- `E002` no longer publishes a browser-readable `/api/inventory` snapshot and sends defense-in-depth headers. Its packaged runtime still requires inline script and `unsafe-eval`, which limits CSP strength.

## Evidence limitations

- The Supabase project schema for the pre-existing `portal_profile`, pending-profile provisioning trigger, and remote `portal-intake` function is not fully represented in this repository.
- The Google OAuth client and Supabase provider are not yet enabled. Google Cloud is currently blocked on a user-completed passkey step.
- No production latency, memory, audit-retention, or administration-volume budget was supplied. Tradeoffs use source-derived or hypothetical bases and include validation plans.
- The working tree was already dirty and contains user work outside this hardening analysis. No claim is made that the base revision alone represents the reviewed portal.
