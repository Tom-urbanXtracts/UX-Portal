# UX OS final completion blockers

Updated 8 October 2026 after the Brand-first portal release evidence pass.

UX OS buildable work for the Brand-first foundation is complete. The remaining items are not unfinished portal plumbing; they are controlled holds that require a named business approval, external system access, or a reactivation decision before work may safely resume.

## Active external or approval blockers

| Item | Current portal state | Why it is held | Exit criteria |
| --- | --- | --- | --- |
| Canix Package Owner reporting bridge | UX OS already has the database table, service-only replacement function, trigger, UI filters, Brand inventory scoping, readiness warning, and release contracts. | The REST-backed Canix package snapshot still provides zero owner assignments. Canix Reporting has `owner_id` and `owner_name`, but UX OS needs a supported server-side Reporting route/credential or a documented REST Package property before importing it automatically. | Obtain the supported route or documented property, connect the sync, import a complete owner snapshot, verify package-ID coverage and removal behavior, and confirm Canix Owner never becomes Economic Owner. |
| Metric glossary and reporting policy | `docs/metric-glossary-reporting-policy.md` defines source/freshness rules, metric meanings, export logging/redaction, QuickBooks read-only boundary, Finance approval routing, preparer/reviewer separation, and archive-not-delete retention stance. | Finance and Operations still need to approve the policy before UX OS can treat sales dollars, revenue, opportunity, receivables risk, or future write boundaries as approved business definitions. | Finance and Operations approve the policy version, name approvers, date the approval, and accept any remaining carveouts. |
| Document retention deletion | UX OS supports archive-oriented records, legal-hold-aware policy planning, private storage, scanning, versioning, and evidence. Automatic deletion is disabled. | The user decision is archive, not delete. Deletion/disposition needs legal/compliance policy, reviewer separation, legal-hold checks, and retained deletion evidence before any worker exists. | Legal/compliance approves record classes, retention start events, hold/release authority, disposition review, deletion evidence, and the exact records eligible for automated deletion. |
| Brand account opportunity model | Current Brand reporting stays aggregated and source-labelled. Retailer/store identity and POS sell-through are withheld. | Opportunity scoring would require Sales Operations, Data, and Legal approval for retailer-identity boundaries, minimum data, explanation text, and scoring rules. | Approve scoring inputs, privacy boundary, explanation text, confidence rules, disable path, and acceptance tests. |
| Store buying desk | Store expansion remains on hold. Existing Store/demo surfaces are preserved but not the current launch priority. | The current staged plan prioritizes Brand Portal first, then Internal and Store. | Reactivate Store strategy and approve pricing, availability, role, account-statement, ordering, approval, and confidentiality rules. |
| Promotions and commercial offers | No promotion stacking or automatic commercial-offer override is live. | Promotions can affect contracts, store terms, pricing precedence, and Finance treatment. | Sales, Finance, and Operations approve ownership, eligibility, dates, stacking, retirement, and pricing precedence. |
| Supply and production planning | Brand POs, production milestones, and evidence exist; full planning remains held. | Planning would need system-of-record authority, reservation behavior, BOM/recipe source, and department ownership. | Operations, Production, Quality, and Data approve authority, write path, reservation behavior, ownership, and acceptance tests. |
| Decision-support forecasts | Current dashboards show source-labelled facts, not predictive decisions. | Forecasts need owners, source contracts, minimum-data rules, validation, explanations, and a disable path. | Finance, Operations, Sales Operations, and Data approve model definitions, validation evidence, confidence thresholds, and disable path. |
| AI buying assistant | No AI ordering assistant is live. | Assistant actions require catalog reliability, permissions, privacy review, grounding, evaluation, audit, and cost limits. | Product, Security, Legal, and Sales approve action boundaries, sources, privacy assessment, human confirmation, evaluation set, and cost ceiling. |

## Completion rule

A held item should not appear in production navigation, trigger external writes, or be described as live. It may remain in the readiness register as a controlled hold when the current safe behavior is documented, the named owner is clear, and the release surface fails closed or stays blank.

Approval-ready request packets are maintained in `docs/ux-os-controlled-hold-approval-packets.md`.

## Buildable scope now complete

The completed Brand-first foundation includes Supabase identity and workspace membership, Brand applications, Brand onboarding, Brand purchase orders, Brand product/SKU qualification, Brand documents and support, Internal Brand review queues, shared work queue, release readiness, source/freshness labels, notification delivery, and the public production Site deployment.
