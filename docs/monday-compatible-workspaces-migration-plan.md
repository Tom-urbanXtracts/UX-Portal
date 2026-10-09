# Monday-compatible UX OS workspaces migration plan

Status: Planning blueprint; not implemented.
Prepared: 8 October 2026
Audience: Executive Leadership, Operations, Finance, HR, Quality/Compliance, IT/Administration, Sales/Commercial, Marketing, implementation teams

## 1. Intent

urbanXtracts does not want to delete Monday.com data. The migration goal is to copy Monday's useful operating model into the UX OS Portal while preserving Monday as historical evidence.

The target is not a pixel-for-pixel clone of Monday.com. The target is a Monday-compatible work-management layer inside UX OS that can represent the boards, items, fields, files, comments, updates, automations, dashboards, permissions, and historical context that urbanXtracts actually uses.

New operational workflows should become Portal-native unless an exception is approved. Existing Monday boards remain intact and can continue to be used during discovery, mirror, parallel-run, and hold periods.

## 2. Guiding Principles

- Do not delete records, files, comments, updates, activity history, or source links from Monday as part of migration.
- Copy Monday data into UX OS with durable source identifiers and import evidence.
- Keep Monday item IDs, board IDs, column IDs, file IDs, update IDs, and source timestamps forever.
- Treat copied Monday records as historical source evidence unless a workflow owner explicitly approves them for live UX OS operation.
- Do not use hidden navigation, saved views, or UI filtering as access control.
- Enforce UX OS permissions server-side by role, department, organization scope, record scope, and permitted action.
- Keep Canix authoritative for cannabis inventory, packages, items, facilities, compliance, lab/testing, quantities, and production/compliance records.
- Keep QuickBooks authoritative for customers, vendors, invoices, payments, balances, receivables, and general ledger activity.
- Do not replace unknown connected-system values with zero.
- Show source, freshness, and import context for every migrated metric and connected-system projection.
- Archive, supersede, close, or revoke records in UX OS; automatic deletion remains disabled unless separately approved later.

## 3. Product Concept: UX OS Boards

UX OS Boards should be the Portal-native replacement for the parts of Monday.com that urbanXtracts depends on.

UX OS Boards should provide:

- Board/table view.
- Kanban/status view.
- Item detail page or drawer.
- Subitems and checklist items.
- Typed custom fields.
- Assignees, owners, reviewers, approvers, and watchers.
- Due dates, planned dates, started dates, completed dates, and SLA dates.
- Comments, updates, and immutable activity history.
- Files and evidence with private storage, malware scanning, hashes, retention class, and legal hold support.
- Saved views, filters, sorts, search, and export controls.
- Workflow transitions and approval routing.
- Notification and escalation rules.
- Dashboard/report widgets with source and freshness labels.
- Monday source provenance on every migrated object.

The first usable version should favor faithful data preservation, familiar board navigation, and controlled workflow ownership over advanced Monday-style customization.

## 4. Monday-to-UX OS Object Model

| Monday concept | UX OS equivalent | Notes |
| --- | --- | --- |
| Workspace | Portal workspace, department area, Brand area, Store area, or historical source collection | Workspace membership does not automatically grant sensitive record access. |
| Folder | Board collection or navigation grouping | Used for organization only. |
| Board | UX OS board, register, workflow, or source archive | Retain Monday board ID and board URL. |
| Group | Board section, status lane, lifecycle phase, category, or historical grouping | Some groups become workflow states; others remain display groupings. |
| Item | Work record, request, task, approval package, order, document, issue, product-content record, or historical item | Retain Monday item ID and original item URL. |
| Subitem | Child task, checklist item, line item, shipment, evidence requirement, or nested historical item | Retain parent-child relationship. |
| Column | Typed field definition | Preserve column ID, title, type, and settings. |
| Status column | Controlled enum or workflow state | Map labels carefully; do not infer authority from color alone. |
| People column | Assignee, owner, reviewer, approver, requester, watcher, or subscriber | Resolve to UX OS profile where possible; retain unresolved identity as source contact. |
| Date/timeline column | Due date, requested date, planned date, start/end window, SLA date, completion date | Preserve timezone assumptions. |
| Formula column | Calculated display metric or reporting candidate | Recreate only after formula and source authority are approved. |
| Mirror column | Source-labelled projection from related record | Do not copy mirror values as authoritative facts without source review. |
| Connected board column | Relationship table | Preserve source board/item relationships. |
| Files column | Evidence or document record | Scan before exposing through Portal. |
| Updates/comments | Immutable timeline events | Preserve author, timestamp, body, attachments, and source update ID. |
| Activity log | Audit source evidence | Retain for import validation and historical review where available. |
| Forms | Portal intake forms | Use server-side validation and source-specific permission checks. |
| Automations | UX OS workflow rules, scheduled jobs, notification rules, and integration events | Rebuild as explicit auditable rules. |
| Dashboards | UX OS reports and widgets | Require metric definitions, source labels, freshness, and export logging. |

## 5. Data-Copy Architecture

The copy should have four layers.

### 5.1 Source snapshot layer

This layer stores the raw imported representation of Monday structures and records.

It should retain:

- Workspace, board, group, view, form, dashboard, automation, and column metadata.
- Item and subitem payloads.
- Column values exactly as returned by Monday.
- Updates, comments, replies, and activity events where available.
- File metadata, download evidence, content hash, scan status, and storage pointer.
- Import batch ID, source query time, import time, importer actor/service, and validation result.

This layer is evidence. It should be append-only except for explicitly marked re-import supersession.

### 5.2 Normalized board layer

This layer powers the familiar Portal board experience.

It should normalize:

- Board definitions.
- Field definitions.
- Board groups.
- Records.
- Subrecords.
- Record-field values.
- Record relationships.
- Record watchers/subscribers.
- Saved views.
- Board-level and field-level visibility rules.

This layer makes copied Monday boards browsable and searchable in UX OS.

### 5.3 Workflow layer

This layer turns selected boards into live Portal-native operations.

It should support:

- Request intake.
- Task assignment.
- Status transitions.
- Approval/return/deny/complete decisions.
- Evidence requirements.
- SLA and escalation.
- Comments and internal notes.
- Notification outbox events.
- Audit events.
- Optimistic version checks.
- Self-approval prevention where required.

Only approved boards enter the workflow layer.

### 5.4 Reporting layer

This layer powers dashboards and exports.

It should support:

- Source-labelled widgets.
- Freshness timestamps.
- Metric definition registry.
- Permission-checked drilldowns.
- Export logging.
- Redaction profiles.
- Unknown/stale/error states.

No report should present migrated Monday data as current authoritative Canix, QuickBooks, HR, or compliance facts unless the source boundary has been approved.

## 6. Board Source Modes

Every copied Monday board should have one explicit source mode.

| Mode | Meaning | Monday behavior | UX OS behavior |
| --- | --- | --- | --- |
| Historical copy | Board is copied for search, audit, and reference only | Monday remains intact | UX OS displays read-only copied history |
| Mirror | Monday temporarily remains operational source | Monday continues current use | UX OS shows source-labelled projection with freshness |
| Parallel | UX OS replacement is being tested against Monday | Monday remains fallback | UX OS runs matching workflow and validates differences |
| Live replacement | New work is Portal-native | Monday retained as historical source | UX OS owns new records, workflow state, comments, evidence, and audit |
| Hold | Scope, authority, or risk is unresolved | Monday remains current | UX OS does not claim replacement capability |

Source mode changes require owner approval and should write an audit event.

## 7. Known Initial Board Classifications

These classifications are planning baselines from the existing repository documents. They are not a complete Monday inventory.

| Board or area | Current understanding | Initial source mode |
| --- | --- | --- |
| `SKUs - Final Product Specification Matrix` board `9620649212` | Source for descriptive product content fields while Canix remains product/item authority | Mirror, then parallel or live replacement after product-content governance is accepted |
| `UX OS Brand Production Milestones` board `18433592669` | Signed milestone callbacks can update a Brand manufacturing projection | Mirror or parallel until Portal-native milestone workflow is approved |
| `UX Inbound Lot Register` board `18429359264` | Existing lot register plus Canix Item Master mirror groups | Mirror or hold; Canix remains authoritative |
| Historical Portal Orders board | Prior order workflow and handoff history | Historical copy for old records; live replacement only for approved new Portal order workflows |
| Licensed Retailers / account lookup boards | Historical account lookup and mirrored license/AR fields | Mirror temporarily until retailer/store identity and QuickBooks mapping are accepted |
| Store onboarding boards | Store onboarding migration is explicitly held | Hold |
| Employee roster board | Current Monday roster is mirrored for now | Mirror until HR and IT approve UX OS authority |
| Monday Supply Order Form 2026 | Pattern retained for Finance purchase request workflow | Historical copy for old records; Portal-native for new Finance purchase requests |
| Marketing/product asset boards | Asset and product-image controls still require approvals | Hold or mirror until scanner, Quality review, publication, archive, and retention controls are approved |

## 8. Permission Model

Monday permissions should be copied for evidence but reinterpreted through UX OS authorization.

| Monday permission signal | UX OS authorization treatment |
| --- | --- |
| Workspace admin | Candidate for Administrator or workspace owner; not automatic sensitive data access |
| Board owner | Candidate workflow owner or department owner |
| Board subscriber/member | Candidate reader, contributor, or watcher |
| Guest | External Brand/Store user, contractor, or scoped temporary viewer |
| Item subscriber | Watcher/follower, not permission by itself |
| People column assignment | Assignee, owner, reviewer, approver, requester, or watcher depending on field mapping |
| Private board | Restricted UX OS board scope |
| Column restriction | Field-level permission, restricted evidence class, or redaction rule |
| Saved/hidden view | Display preference only; not access control |

UX OS must enforce access at the server for:

- Board read.
- Record read.
- Field read.
- Comment read.
- File download.
- Export.
- Create/update.
- Status transition.
- Approval/return/deny/complete.
- Role/membership change.
- Legal hold.
- Source-mode change.

## 9. File, Attachment, Comment, and Update Preservation

Copied files should be treated as evidence.

Required preservation fields:

- Monday board ID.
- Monday item ID.
- Monday update ID or file column ID.
- Monday file ID.
- Original filename.
- MIME type.
- File size.
- Uploader identity.
- Source created/updated timestamp.
- Download timestamp.
- SHA-256 hash.
- Malware scan result.
- Storage bucket/object key.
- Document class.
- Visibility scope.
- Retention rule.
- Legal hold state.
- Import batch ID.

Rules:

- Do not expose Monday `protected_static` URLs as external catalog or Brand assets.
- Do not treat upload as approval.
- Do not store infected files as usable evidence.
- Keep unavailable or failed-download files as exception records with source metadata.
- Preserve comments and updates as immutable timeline events.
- Preserve source formatting as much as practical, but do not allow imported HTML or rich text to bypass Portal sanitization.

## 10. Automation Replacement Model

Monday automations should be inventoried and rebuilt, not blindly copied.

| Monday automation pattern | UX OS replacement |
| --- | --- |
| When status changes, assign person | Server-side workflow transition rule |
| When item is created, notify users | Durable notification outbox with approved template |
| When date arrives, remind assignee | Scheduled escalation job |
| When form submitted, create item | Portal intake form with server validation |
| When item moves group, update status | Explicit state transition with audit event |
| When connected board changes, mirror value | Source-labelled relationship projection |
| When approval status changes, notify requester | Approval decision event plus notification |
| Integration webhook | Signed/idempotent integration action |

Every rebuilt automation should have:

- Owner.
- Trigger.
- Conditions.
- Action.
- Recipient scope.
- Permission check.
- Idempotency key.
- Failure behavior.
- Audit event.
- Test case.
- Cutover date.

## 11. Dashboard and Report Recreation

Monday dashboards should be recreated only after metric ownership is approved.

Dashboard migration checklist:

1. Capture dashboard owner, viewers, source boards, filters, widgets, formulas, and exports.
2. Classify each widget as operational, financial, compliance, HR, executive, Brand-facing, Store-facing, or internal-only.
3. Identify source authority: UX OS, Monday history, Canix, QuickBooks, Wurk/payroll, or approved blend.
4. Define freshness threshold and stale/error display.
5. Define drilldown permission.
6. Define export permission and redaction profile.
7. Validate against Monday for at least two reporting cycles before retiring the Monday dashboard.

Dashboard values copied from Monday should show source context. If a dashboard value relies on Canix or QuickBooks data, UX OS should prefer direct approved projections from those systems rather than stale Monday mirror values.

## 12. Implementation Phases

### Phase 0: Discovery and inventory

- Build the complete Monday dependency register.
- Identify every board, view, form, dashboard, automation, integration, file dependency, and owner.
- Classify boards into historical copy, mirror, parallel, live replacement, or hold.
- Approve retention and legal hold review steps.

### Phase 1: Read-only source copy

- Copy board schemas, items, subitems, column values, files, updates, comments, and activity history where available.
- Store provenance and import batch records.
- Validate counts, hashes, and source IDs.
- Make copied records visible only to controlled internal administrators at first.

### Phase 2: Familiar board browsing

- Add UX OS board/table views for copied Monday boards.
- Support search, filters, saved views, item detail, timeline, files, and source links.
- Keep records read-only unless the board is explicitly approved for live Portal operation.

### Phase 3: Workflow conversion

- Convert selected boards to Portal-native workflows.
- Add typed forms, transitions, approvals, comments, evidence, notifications, and audit events.
- Run in parallel with Monday where risk requires.

### Phase 4: Dashboard conversion

- Recreate approved Monday dashboards as UX OS reports.
- Replace mirror metrics with direct Canix, QuickBooks, or UX OS source projections where appropriate.
- Add export logging and redaction controls.

### Phase 5: Cutover and stewardship

- Freeze new Monday intake for approved replacement workflows.
- Keep Monday data untouched.
- Make UX OS the owner for new records.
- Monitor exceptions.
- Keep Monday read-only or retained under the business's chosen license/access plan.

## 13. Validation Requirements

Each copied board should pass:

- Board count validation.
- Group count validation.
- Column count and type validation.
- Item and subitem count validation.
- Required source ID validation.
- File count, hash, and scan validation.
- Update/comment count validation where Monday APIs allow it.
- Permission sampling.
- Status mapping review.
- Relationship mapping review.
- Dashboard/report sample comparison where applicable.
- Owner signoff.

Validation exceptions should remain visible in UX OS until closed or explicitly accepted.

## 14. Cutover Criteria

A board or workflow can move to Portal-native operation only when:

- Historical copy is complete or exceptions are accepted.
- Workflow owner approves field mappings and state mappings.
- Permissions are enforced server-side.
- Required files and comments are preserved or exception-listed.
- Replacement automations are tested.
- Dashboard impact is understood.
- Users know where to submit new work.
- Rollback owner and fallback path are named.
- Legal hold and retention treatment is approved.

## 15. Rollback Approach

Rollback should not delete UX OS records.

If a Portal-native workflow fails after cutover:

1. Pause new UX OS intake for the affected workflow.
2. Mark the workflow as rollback/fallback in source-mode history.
3. Reopen Monday intake for that workflow if the owner approves.
4. Preserve UX OS records, comments, evidence, and audit events.
5. Reconcile any records created during the failed cutover with a controlled source-labelled import/export.
6. Record the rollback as an operational incident.
7. Require owner approval before another cutover attempt.

## 16. Proposed Build Backlog

### Data model

- Monday source connection registry.
- Monday board snapshot tables.
- Monday column/field definition tables.
- Monday item and subitem source tables.
- Monday file/update/comment source tables.
- UX OS board definition tables.
- UX OS board record and field value tables.
- Board source-mode history.
- Import batch and validation exception tables.

### Services

- Monday discovery/export service.
- File downloader, hasher, scanner, and private-storage writer.
- Field mapper.
- Identity mapper.
- Permission mapper.
- Source-mode manager.
- Validation runner.
- Workflow conversion helper.
- Dashboard conversion helper.

### UX

- Internal Monday migration console.
- Board inventory and classification view.
- Import batch status view.
- Validation exception queue.
- Copied board browser.
- Item detail timeline.
- File/evidence panel.
- Source provenance panel.
- Source-mode controls.
- Cutover checklist.

### Controls

- Server-side authorization for all board, record, field, file, export, and source-mode actions.
- Export logging.
- Legal hold support.
- Retention class assignment.
- Audit events for imports, source-mode changes, workflow conversions, permission changes, and exports.

## 17. Open Decisions

- Which Monday workspace is the first discovery target?
- Who owns the complete Monday board inventory?
- Which boards must be copied first for business continuity?
- Which boards contain HR restricted, Finance restricted, Quality/compliance, or legal-hold-sensitive material?
- How long should Monday licenses remain active after copied records are validated?
- Which dashboards are executive-critical?
- Which automations are business-critical versus convenience-only?
- Which boards should remain Monday-operated temporarily?
- Whether external Brand or Store users should ever see copied Monday history, or only Portal-native records derived from it.

## 18. Non-Goals for the First Build

- Deleting Monday records.
- Replacing Canix or QuickBooks authority.
- Blindly copying Monday permissions as effective Portal permissions.
- Supporting every Monday feature before proving core migration safety.
- Recreating advanced formula/dashboard behavior without approved metric definitions.
- Exposing copied files externally before scanning, classification, and permission review.
- Presenting migrated capabilities as live before production acceptance.

