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
