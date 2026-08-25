# urbanXtracts Wholesale Portal — design prototype

Role-based ordering, lot verification and COA access for licensed retail
partners, with an internal operations layer behind the same sign-in.

**This is a design prototype, not a product build.** All product, price, cost,
order and COA values are synthetic. Catalog structure, release states, order
states, unit types and date ranges were read from live Canix reporting on
2026-08-24 and are real; everything else is either labelled sample data or shown
as an explicit pending state.

## What is in here

| Path | What it is |
|---|---|
| `dist/portal.html` | Self-contained prototype. Open it in a browser — no build, no server, no dependencies. |
| `UX Portal - Prototype.dc.html` | Prototype source (streaming design component). |
| `UX Portal - Phase 1 Architecture.dc.html` | Sitemap, role and permission matrix, gates, flows, source map, audit events, open items, acceptance. |
| `UX Portal - Build Plan.dc.html` | What remains, sequenced by dependency: 9 blockers, 22 build tasks, 3 waves. |
| `brand/` | The uX mark, trimmed, plus a reversed version generated for dark surfaces. |
| `_ds/` | The design system the visual language builds on. |
| `support.js` | Runtime for the `.dc.html` sources. Not needed by `dist/portal.html`. |

## Walking the prototype

Open `dist/portal.html` and switch role in the top bar.

- **Buyer** — catalog → product → pick a lot → add → draft → send for approval.
- **Owner** — approve or decline it; compare locations; manage your own users.
- **Internal** — confirm, ship, view cost and margin, release queue, integrity
  exceptions, lineage, audit history, required tests.
- **Budtender** — kiosk lookup by compliance tag. No price appears anywhere.

Paths worth walking because they refuse rather than proceed:

- **Northgate** — expired license blocks submission at that location only.
- **Riverside** — past-due balance blocks submission at order entry, not at shipping.
- **Reorder SO-24020** — a line is no longer stocked; the draft offers swaps.
- **A partial compliance tag** in kiosk lookup — never resolves to one lot.
- **View as** a store user from Users and roles — read-only, cost withheld, audited.

## The rules the design enforces

- One internal wall: any internal user sees cost; no external view renders it,
  including margin, discount depth, rate cards and ownership code.
- Restricted routes are **not rendered** — never disabled, never empty. Interface
  hiding is not the control; server-side authorization is required.
- Orderable means package status *available* **and** lab result *passed*. Both.
- The compliance tag is the lot identity. Batch and lot references are
  enrichment, absent on most inventory today.
- Grams, millilitres and each are never blended into one figure.
- Four external order states; ten internal, kept as the subledger holds them.
- Two signal colours only: green for released, passed and primary action; clay
  for blocked and exception. Everything pending is monochrome.

## Before this can ship

Three blockers gate the ordering flow: there is no per-account rate card record
(price is derived from the last qualifying order line), case quantity and
minimum order are not confirmed readable per item, and potency and terpene
values have no source. Six further decisions and three connections are listed
in the build plan. Nothing publishes publicly while the compliance sign-offs
on COA display and recall wording are open.
