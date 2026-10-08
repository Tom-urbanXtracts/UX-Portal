# UX OS controlled-hold approval packets

Updated 8 October 2026.

Use these packets to move a controlled hold forward. Each packet has three valid outcomes:

1. **Approve**: record approver, date, scope, evidence, and any carveouts.
2. **Keep held**: record what is still missing and the next review date.
3. **Reject**: record that the capability should be removed from roadmap language.

No packet changes production behavior by itself. An approval still needs implementation, authorization tests, audit coverage, and a readiness-register update before a held capability can become live.

## 1. Canix Package Owner reporting bridge

Owner: IT / Data / Canix

Decision needed: Canix-supported source access for package owner assignments.

Approval request:

> UX OS is ready to import Canix Package Owner as an operational user field, separate from Brand and Economic Owner. The portal already has the service-only snapshot table, replacement function, trigger reconciliation, UI filters, Brand inventory scoping, readiness warning, and release tests. We need Canix to confirm either a supported server-side Reporting route/credential for `package_inventory_facts_current.owner_id` and `owner_name`, or a documented REST Package property that returns the same assignment. Please approve pursuing that connection and confirm the permitted access method.

Required evidence:

- Canix response naming the supported route or REST property.
- Credential scope and storage approval.
- Complete snapshot import result.
- Package-ID coverage test.
- Removal/unassignment behavior test.
- Confirmation that Canix Owner remains operational-only and never becomes Economic Owner.

## 2. Metric glossary and reporting policy

Owner: Finance / Sales Operations / Data

Decision needed: approve `docs/metric-glossary-reporting-policy.md`.

Approval request:

> Please review the UX OS metric glossary and reporting policy. The policy defines source/freshness rules, Brand sales units, sales-dollar gating, outstanding balance, account statement, reorder interval, export logging/redaction, QuickBooks read-only boundaries, Finance approval routing, preparer/reviewer separation, and archive-not-delete retention stance. Approval allows UX OS to use these definitions as the controlled reporting baseline. Sales dollars, receivables risk, opportunity, and any future QuickBooks write path still require their specific approval gates.

Approval checklist:

- Finance approves or edits the sales-dollar definition.
- Operations approves or edits unit, fulfillment, inventory, and reorder definitions.
- Sales Operations approves or edits Brand/Store reporting visibility.
- Export redaction list is accepted.
- QuickBooks remains read-only unless a future write approval is recorded.
- Approver names and date are retained.

## 3. Document retention and legal holds

Owner: Compliance / Finance / Operations / Executive Members

Decision needed: retain archive-only stance or approve future disposition.

Approval request:

> UX OS currently archives records and keeps automatic deletion disabled. Please confirm whether UX OS should remain archive-only for this release, or whether Legal/Compliance wants to start a future deletion/disposition policy project. Any deletion worker would require approved record classes, retention start events, legal-hold behavior, hold/release authority, reviewer separation, disposition evidence, and recovery/appeal handling.

Recommended decision:

Keep archive-only for this release. Legal holds may be placed by Executive Members. Do not build deletion automation until Legal/Compliance approves the full disposition policy.

## 4. Brand account opportunity model

Owner: Sales Operations / Data / Legal

Decision needed: whether UX OS may score account or product opportunities.

Approval request:

> UX OS currently shows aggregate Brand-scoped order and fulfillment facts only. Retailer/store identity and POS sell-through are withheld. Please decide whether UX OS may build a Brand opportunity model using approved portal order history, and whether outputs may include retailer identity, anonymized account groups, or aggregate-only recommendations.

Required approvals:

- Input data sources.
- Minimum history required before showing a recommendation.
- Retailer identity boundary.
- Scoring logic owner.
- Explanation text visible to users.
- Disable path.
- Export policy.

## 5. Store buying desk reactivation

Owner: Sales / Operations / Product

Decision needed: whether to restart Store workspace build.

Approval request:

> The current staged plan is Brand first, then Internal and Store. Store expansion remains preserved but held. Please decide whether to reactivate the Store buying desk, and if so, approve the first release scope: catalog, saved lists, reorder actions, cart, order history, billing visibility, product media, multi-location purchasing, and role-scoped permissions.

Required approvals:

- Launch timing.
- Store roles: Owner, Buyer/Manager, Budtender.
- Account-statement visibility.
- Ordering and approval rules.
- Pricing and availability boundaries.
- Confidentiality rules.
- Store export policy.

## 6. Promotions and commercial offers

Owner: Sales / Finance / Operations

Decision needed: whether UX OS may manage promotions.

Approval request:

> UX OS does not currently support promotions, discounts, stacking, or automatic offer overrides. Please decide whether promotions should enter the roadmap and approve the governance model before any implementation begins.

Required approvals:

- Who may create a promotion.
- Who approves it.
- Eligible accounts, stores, products, and Brands.
- Start/end dates and retirement behavior.
- Stacking rules.
- Pricing precedence against contract, store, retailer, and default prices.
- Finance treatment and reporting.

## 7. Supply and production planning

Owner: Operations / Production / Quality / Data

Decision needed: whether UX OS owns production planning or only shows milestones.

Approval request:

> UX OS has Brand purchase orders, production milestones, comments, and evidence, but it is not yet a production planning engine. Please decide whether UX OS should own planning, reservations, materials/BOM visibility, SOP links, and production-demand signals, or whether it should continue showing only controlled workflow and milestone evidence.

Required approvals:

- System of record for recipes/BOMs.
- Inventory reservation behavior.
- Production milestone authority.
- Write path back to Canix, if any.
- Department ownership.
- Quality release/hold boundary.
- Acceptance tests.

## 8. Decision-support forecasts

Owner: Finance / Operations / Sales Operations / Data

Decision needed: whether UX OS may show predictive signals.

Approval request:

> UX OS currently shows source-labelled facts, not predictive decisions. Please decide whether UX OS may develop forecasts for reorder risk, inventory pressure, cash collection, assortment gaps, or production demand.

Required approvals:

- Model owner.
- Source contract.
- Minimum data rule.
- Refresh cadence.
- Validation evidence.
- Confidence threshold.
- User-facing explanation.
- Disable path.
- Export boundary.

## 9. AI buying assistant

Owner: Product / Security / Legal / Sales

Decision needed: whether to explore a constrained assistant.

Approval request:

> UX OS does not have a live AI buying assistant. Please decide whether Product, Security, Legal, and Sales want to begin a constrained assistant discovery project. The assistant must not place orders, expose cross-account data, reveal hidden prices or inventory, or make recommendations without approved sources and human confirmation.

Required approvals:

- Allowed actions.
- Prohibited actions.
- Grounding sources.
- Privacy assessment.
- Human-confirmation requirements.
- Evaluation set.
- Audit records.
- Cost limit.
- Disable path.

## Approval record format

Use this record when a packet is reviewed:

| Field | Value |
| --- | --- |
| Packet |  |
| Decision | Approve / Keep held / Reject |
| Approver(s) |  |
| Decision date |  |
| Scope approved |  |
| Carveouts |  |
| Evidence retained |  |
| Next review date |  |
