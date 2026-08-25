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
| UX Portal - Prototype.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md, plugins/urbanxtracts/skills/urbanxtracts-design-public-coa-lookup/SKILL.md |
| UX Portal - Phase 1 Architecture.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md |
| UX Portal - Build Plan.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md |

## Publishing this prototype

This project is not the agents repo. To publish it, create a new repository
(for example `ux-portal-prototype`) and commit the project root as-is.
`dist/portal.html` works standalone and can be served by GitHub Pages directly.
