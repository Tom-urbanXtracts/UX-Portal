# urbanXtracts Wholesale Portal — design prototype

Role-based ordering, lot verification and COA access for licensed retail
partners, with an internal operations layer behind the same sign-in.

**This is a design prototype, not a product build.** All product, price, cost,
order and COA values are synthetic. Catalog structure, release states, order
states, unit types and date ranges were read from live Canix reporting on
2026-08-24 and are real; everything else is either labelled sample data or shown
as an explicit pending state.

## Where it is hosted

Served by GitHub Pages from `main` at the repository root:
**https://tom-urbanxtracts.github.io/UX-Portal/**

The repository and the Pages site are both **public**. `robots.txt` and a
page-level `noindex` ask crawlers to stay out, but that is a request, not access
control — anyone with the link can read everything here.

## What is in here

| Path | What it is |
|---|---|
| `index.html` | Landing page for the hosted site. Links to the prototype and every document. |
| `dist/portal.html` | Self-contained prototype. Open it in a browser — no build, no server, no dependencies. |
| `ux-portal-prototype.dc.html` | Prototype source (streaming design component). |
| `ux-portal-phase-1-architecture.dc.html` | **Rev 2.1.** Sitemap, matrix, gates, flows, source map, audit events, open items, acceptance — plus recall and lot impact, life after submission, approval delegation, store account and records, store data access, measurement, document exchange, and internal store onboarding. |
| `ux-portal-build-plan.dc.html` | **Rev 2.1.** What remains, sequenced by dependency: 10 blockers, 48 items still open, 4 waves. |
| `Sitemap-A-*`, `Sitemap-B-*` | Two sitemap treatments. |
| `Doc-Format-A-*`, `Doc-Format-B-*` | Two document treatments. |
| `brand/` | The uX mark, trimmed, plus a reversed version generated for dark surfaces. |
| `_ds/` | The design system the visual language builds on. |
| `support.js` | Runtime for the `.dc.html` sources. Not needed by `dist/portal.html`. |
| `.nojekyll` | Required. Without it GitHub Pages runs Jekyll, which drops any path starting with `_` — including all of `_ds/`, which every `.dc.html` page needs. |
| `robots.txt` | Asks crawlers not to index an unreleased prototype. |

## Walking the prototype

Open the [hosted site](https://tom-urbanxtracts.github.io/UX-Portal/), or
`dist/portal.html` locally, and switch role in the top bar.

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

## The prototype, updated

`dist/portal.html` and its source now carry a first pass at part of wave 4:

- **Sample data is highlighted** wherever it appears — names, prices and
  quantities. Highlighting rather than red font, because clay already means
  *blocked* in the two-signal system and a second red would collide with it.
- **Recall and lot impact** — a new internal screen: resolve a compliance tag
  (a partial never resolves), see every account and location that received it
  computed from the order data, what is still stoppable in transit, custody and
  open drafts, then issue the notice and record acknowledgement per account.
  Issuing it puts a notice on the affected store's order — the wording stays the
  CCO's and the portal never composes it.
- **Your records** — everything urbanXtracts holds about the account in one
  place: orders, lots received with the COA version current at receipt,
  licenses, claims, documents, notices, and the org's own audit history —
  including an administrator viewing their screen. Scoped to the organisation
  for an owner and to one location for a buyer. Export writes its own audit
  entry, which then appears in the history on the same screen.
- **Receivables** — owner only; the route is not rendered for a buyer at all.
  Balance, past due and terms by location, invoices with age, and a plain
  statement of what the gate reads. Every figure is a labelled placeholder
  because the ledger connector is not attached, and the threshold behind the
  gate is still an open blocking decision. How to pay is deliberately absent —
  remittance details stay in the onboarding record.
- **API access** — owner only. Credentials with masked keys, scope, last use,
  rotate and revoke; eight read-only endpoints each mapped to the records
  section it mirrors; an explicit *no writes* row; the withheld-field list that
  applies inside errors and pagination too; and rate limits stated as still
  unset. Revoking writes an audit entry that appears under Your records.
- **Approval authority** — owner only. Delegate inside the organisation with an
  expiry and one-click withdrawal; delegating to a buyer warns that it becomes
  self-approval. The rep option is present and **deliberately refuses** — it is
  not a decided capability. The three gates a delegate can never lift are named,
  and the clock is stated as unset. An order awaiting approval names who holds
  authority and until when.
- **Receiving claim** — on a received order: pick the line, pick short, damaged
  or refused, set a quantity capped at what was ordered, say what happened in
  your own words, optionally attach a photo. It lands on the order, in Your
  records, and in the audit trail. The store sees state only; the same claim
  viewed internally carries the owner and the clock.
- **Amended COA** — publish version 2 from Release and quality: it reuses the
  same reverse query as the recall view to find who holds the lot, notifies
  them unmutably, marks the COA `AMENDED` while version 1 stays resolvable,
  records acknowledgement per account, and appears in the store's notices and
  audit history. The notice never states what changed or what it means.
- **Public COA resolver** — a working lookup on the public COA page with the
  hardening controls live: non-sequential codes, full-code-or-nothing, no
  listing or search, a per-source rate limit, and — the one that matters — an
  unknown code and a real-but-unpublished code returning the identical
  response, so the resolver never confirms that something exists.
- **Account and delivery** — owner only; in the sitemap since rev 1 and never
  built. Per-location delivery window, receiving contact and receiving
  instructions, editable and saved with an audit entry. Paired with a plain
  list of what cannot be changed here and where it lives instead — the licence
  number, expiry, adding a location, banking, and payment terms.
- **Field view** — internal, built at phone width and kept there on a desktop.
  Assigned accounts only, each with order interval, what they dropped, the gate
  holding them, and visit notes a rep can add from a car park. Closes with what
  a rep cannot do: set a price, approve an order, lift a gate, or see an account
  off their book.
- **Documents** — a new screen for owner and buyer: typed uploads, expiry,
  review state, and the rule that an upload never lifts a gate.
- **Store onboarding** — a new internal screen: six stages, with each in-flight
  account showing which stage is holding it and why.
- **Order actions match the status vocabulary** — edit and cancel on a placed
  order, request a change after approval, report a problem on receipt.
- **User lifecycle** — invite and deactivate, not just change role.
- **Validation queue reconciled** — ten blocking items, matching both documents,
  with sell-through shown as decided rather than open.

The source `.dc.html` and the bundled `dist/portal.html` are edited in lockstep
and verified to render identically. Everything not listed above is still
specified rather than built.

## What changed in rev 2.1

One blocking convention across both documents — *blocking* now means the item
stops a screen, a gate or a publication from being correct, and both documents
count the same ten. Rev 2 had the architecture flagging eight and the build plan
counting fifteen, and `case quantity` was blocking in one and not the other.

**Store sell-through is decided out of scope.** The portal stays semi-internal
and does not connect to a retailer's point-of-sale. That answers a standing
blocking question the prototype still carries — *a data source, or a decision to
ship without one* — with the second. Performance panels report the account's own
ordering with urbanXtracts, permanently, and no velocity claim is made anywhere.

Two capabilities added: **document exchange** (owner and buyer upload against a
typed list, with expiry, review state and versions — the license gate has said
"upload the renewal" since rev 1 with nowhere to upload it) and **internal store
onboarding** (six stages from intake to ready-to-order).

## What changed in rev 2

The 24 Aug review of the built prototype against its own architecture produced
wave 4 — fourteen items, of which three close contradictions inside rev 1 rather
than adding anything: lineage that could not answer *who has this lot*, an
amended-COA notification promised in one section and absent from another, and
`Placed` promising edit and cancel that no screen offered. It also added the two
capabilities asked for — a store records surface and a read-only store API — and
rep-held ordering approval, which is the only genuinely new requirement and the
only one that needs Legal as well as the CCO.

*(Rev 2.1 superseded this — see below. The prototype now carries a first pass at
five of the wave 4 items.)*

## Before this can ship

Three blockers gate the ordering flow: there is no per-account rate card record
(price is derived from the last qualifying order line), case quantity and
minimum order are not confirmed readable per item, and potency and terpene
values have no source. Six further decisions and three connections are listed
in the build plan. Nothing publishes publicly while the compliance sign-offs
on COA display and recall wording are open.
