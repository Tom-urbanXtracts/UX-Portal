repo: Tom-urbanXtracts/ux-os-agents
branch: main

## Last sync

date: 2026-08-24T23:59:00Z

### Updated in this project

- Built the wholesale portal prototype: role-based ordering, lot and COA access, internal operations layer.
- Wrote the Phase 1 architecture document and the dependency-sequenced build plan.
- Branded against the supplied uX mark; ink sampled from the logo file.
- Source repo carries no UI code, so nothing was recreated from it — its conventions and portal skills informed the vocabulary, gates and segregation rules.

## Screen map

| Project screen | Repo files |
|---|---|
| ux-portal-prototype.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md, plugins/urbanxtracts/skills/urbanxtracts-design-public-coa-lookup/SKILL.md |
| ux-portal-phase-1-architecture.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md |
| ux-portal-build-plan.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md |

## Publishing this prototype

This project is not the agents repo. It lives in its own repository,
`Tom-urbanXtracts/UX-Portal`, and is served by GitHub Pages from `main` at the
repository root: https://tom-urbanxtracts.github.io/UX-Portal/

Both the repository and the Pages site are public. Pages requires `.nojekyll`
at the root — without it Jekyll drops every path beginning with `_`, which
removes `_ds/` and leaves the `.dc.html` documents unstyled.

## Supabase Auth settings that live outside this repository

Password reset is built into the portal, but the emailed link only lands on it
once these are set in Supabase → Authentication → URL Configuration. Until then
the link goes wherever **Site URL** points, which is what sent it to `localhost`.

| Setting | Value |
|---|---|
| Site URL | `https://tom-urbanxtracts.github.io/UX-Portal/dist/portal.html` |
| Redirect URLs | `https://tom-urbanxtracts.github.io/UX-Portal/**` plus any local origin used for development |

Supabase answers `200` to a reset request whether or not `redirect_to` is
allow-listed — it falls back to Site URL silently rather than failing — so a
successful request is not evidence the link will land in the right place.
Verified by sending one with `redirect_to=https://evil.example.com/x`, which
was also accepted.

Custom SMTP is live through SendGrid, sender `tom@urbanxtracts.com`, DKIM and
SPF passing. **SendGrid click tracking rewrites the reset link**, which puts a
one-time recovery token through a third-party redirector and exposes it to link
scanners that pre-fetch URLs; turning click tracking off for this traffic is
recommended and has not been done.

## Each created user gets their own profile

Adding a user writes a row to `public.portal_pending_profile`, keyed on their
address. When that account first appears, `handle_new_portal_user()` provisions
`portal_profile` from that row and then **deletes it**, so the record applies to
exactly one account and can never be inherited by a second. With no pending row
the old defaults still apply (`budtender` / `Unassigned`).

Nothing is shared: sign-in builds the identity only from the account's own
profile row. It no longer matches the address against the sample directory,
which previously let a matching address take that sample record's role and
locations instead of its own.

Who may add whom is enforced in the database, not the interface:

| Acting as | Adding | Result |
|---|---|---|
| Owner | buyer/budtender in its own organisation | allowed |
| Owner | an internal account | denied |
| Owner | anyone in another organisation | denied |
| Budtender | anyone | denied |
| Internal | any role, any organisation | allowed |
| Not signed in | anyone | denied (`42501`) |

Verified by executing each case under that account's own JWT claims. Note that
RLS decides which rows; the table `GRANT` decides whether the role may ask at
all — the first version of this table had policies but no grant, so every write
failed on permission before a policy was consulted.
