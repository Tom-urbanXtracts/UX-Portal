# UX OS Internal Employee Portal review package

Status: Approved build baseline. Shared foundation implementation began 8 October 2026; capability status must still be read per section.
Prepared: 7 October 2026
Audience: Executive Leadership, department heads, Finance, Operations, HR, Quality/Compliance, IT/Administration, Sales/Commercial, Marketing

## 1. Internal Portal vision

UX OS should become one controlled operating layer for urbanXtracts employees, Brand partners, and future Store users. The Internal Employee Portal is the employee-facing workspace inside that operating layer.

The Internal workspace should give employees a single place to see assigned work, submit requests, complete approvals, find documents, acknowledge policies, review schedules, and manage department operations. It should not replace Canix, QuickBooks, Google Workspace, or other approved systems of record. Instead, it should organize the work around those systems, preserve evidence, route approvals, and show source-labelled projections with freshness timestamps.

The recommended model is one employee portal with department workspaces, not separate department applications. Shared services should be built once and reused across HR, Operations, Finance, Marketing, Sales and Commercial, Quality and Compliance, IT and Administration, and Executive Leadership.

### Desired employee experience

- Employees land on **My Work** and see the tasks, approvals, schedules, training, PTO requests, documents, announcements, and department shortcuts they are permitted to use.
- Department heads see their department queue, approvals, risks, calendar, open requests, aging work, and decisions awaiting ownership.
- Executives see approved company-level summaries and exceptions without automatically receiving unrestricted record-level access to sensitive HR, Finance, Quality, or compliance files.
- Administrators manage users, department membership, release readiness, integration health, access requests, and audit history.

### Explicit non-goals for this build

- Do not treat an untested or undeployed capability as live.
- Do not modify the current Brand, Store, Canix, QuickBooks, or Monday production workflows as part of this package.
- Do not represent planned capabilities as live controls.
- Do not move accounting authority out of QuickBooks or cannabis inventory authority out of Canix.
- Do not reintroduce portal MFA after the owner decision to remove it. Employee MFA should be handled through Google Workspace if approved later.

### Build status — first vertical slice

The first shared Internal workflow slice is implemented and published to production:

- **My Work** is available to active Internal profiles and shows only the user's own/assigned work, except that Administrators receive the Administrator queue.
- Workforce users can submit a role and department access request with a business reason and optional expiration date.
- Administrators may approve, return, or deny requests. Requesters cannot approve their own access.
- Approval atomically applies the workforce role and active department membership; every decision and resulting role change is audited.
- Access-request decisions are append-only, open duplicates are blocked, work-item updates retain optimistic version checks, and direct browser table access remains denied.
- HR-specific workflows remain a controlled hold in this slice. Portal offboarding now disables the selected UX OS profile immediately and creates an evidenced manual checklist. Quarterly workforce and vendor access reviews are now scheduled and evidenced manually in IT governance; automatic review execution, automatic cross-system account deactivation, portal MFA, and automatic retention deletion remain held.
- The database migrations, Edge Function, and browser interface are deployed at the production hostname. Signed-in Administrator acceptance confirmed My Work and IT governance can read production records; build contracts, service tests, security tests, and remote anonymous-denial checks pass.
- Emergency production changes are Portal-owned: recording one creates a P0 retrospective task due within one business day, and a different Administrator must approve or return it with evidence.
- Shared department requests are Portal-owned and available from My Work. Active workforce users may route a categorized request to an active department; Administrators review the common queue, decisions require evidence, self-approval is blocked, and no Monday handoff is created.
- Shared department request receipts and status updates are delivered through approved Resend templates and a durable Supabase outbox. A notification failure is retained for operational follow-up and does not discard or roll back the underlying request. Every active Administrator and each Administrator-configured department owner or shared inbox receives the department-queue notices; recipient addresses are deduplicated. Tom Jalallar is the temporary owner for all active departments until the department heads approve durable owners and inboxes.
- Production acceptance on 8 October 2026 verified the Resend sending domain, enabled signed webhook, requester receipt, separate-Administrator completion, and delivered status callback. Controlled request `REQ-5157316E91` is closed and retained as evidence.
- Finance purchase requests use a Portal-native header and multi-line item model patterned after the retained Monday Supply Order Form 2026. The header records vendor, department, requester, priority, required date range, recurrence, payment method, business approval, Administrator status, ordered/delivered dates, and evidence. Each line records item, URL, SKU, quantity, unit cost, expense category/subcategory, chart of accounts, required date, and server-calculated subtotal. Optional PDF, PNG, and JPEG evidence is malware-scanned and can be downloaded only through a short-lived authorized link.
- Business approvers act directly inside the Portal only after their urbanXtracts Google account has created an active Internal profile. Their approval authority does not grant Administrator access. An Administrator remains responsible for the final Portal control decision.
- Controlled production request `PUR-289F52052C` verified two line items, the `$3,000+` route to Eran, named business approval, a separate Administrator decision by Tom, version checks, and final completion. It is labelled **CONTROLLED TEST — NO PURCHASE** and authorizes no purchase or payment.

## Current approved build direction

These decisions update the build intake after the 7 October 2026 review call and follow-up owner decisions.

| Area | Current decision |
| --- | --- |
| Release priority | Use a staged combination, with high focus on a working Brand Portal demo first, then Internal Employee Portal foundation, then Dispensary/Store expansion. |
| Brand demo account | Use urbanxtracts / Urban Extracts as the first Brand account. Moondust remains the next named Brand target by year-end. |
| Brand purchase orders | Brand users should be able to submit purchase orders from the Brand workspace in the first demo. The Portal owns order request, notes, fulfillment status, comments, and evidence; QuickBooks is not updated automatically. |
| Brand financials | Map Brand financials to QuickBooks where approved. Show source-labelled account statements, invoice references, credits, payments, balances, aging, and refresh state. Use scheduled refresh plus an on-page refresh action where available. |
| Public Brand applications | Public Brand applications should not remain closed only to selected partners; keep anti-abuse controls and internal review before workspace creation. |
| Store role baseline | Store Owner can view, request, order, approve, export, and manage. Buyer / Manager can view, request, order, approve where delegated or policy allows, and export scoped reports, but cannot manage users or account settings. Budtender can access product education only. |
| Buyer account statements | Buyer / Manager may see full account statements with invoice references inside assigned scope. |
| Employee login | Work Google account is not required. Personal email/password and IT-created portal credentials are allowed. Google Workspace remains preferred where available. |
| Contractor access | Contractors require IT and Executive Team approval, a required expiration date, and no default sensitive access. |
| Administrator access | IT approval only for the current baseline. |
| Immediate deactivation | HR, IT, and Executive-role users may trigger immediate deactivation. Multiple roles may be assigned; Executive roles are assigned to C-suite members. |
| Employee roster | Mirror the current Monday.com roster for now. UX OS may become authoritative later. |
| PTO | UX OS routes PTO requests only. PTO balance calculation remains with the payroll processor. |
| Schedules | UX OS schedule ownership is planned, not first release. Google Calendar sync is later. |
| HR restricted records | Medical, accommodation, compensation, investigations, employee relations, and performance records all require restricted HR access. |
| Exports | Executive, Sales, Finance, and Operations may export approved internal reports. Brands are limited to their Brand scope. Every export must be logged. |
| Legal hold | Executive Members may place legal holds. Automatic deletion remains disabled; archive instead of delete. |
| Canix freshness | Use the proposed freshness thresholds as a reviewable planning baseline: target under 15 minutes, warning after 30 minutes, stale after 60 minutes, and block current-inventory decisions after 4 hours or a relevant sync failure. |
| Workspace owners | IT is the temporary owner for all workspaces. Executive Member is the backup owner. Final department leads remain held; list Tom Jalallar as temporary department head for now. |
| Department inboxes | Keep Administrators on every queue. Use Tom Jalallar as the temporary owner recipient; add shared inboxes only after an Administrator confirms their real addresses. Do not infer addresses. |
| Purchase evidence | Permit optional supporting PDFs and images on a request. Scan every upload, keep it private, and expose it only through an authorized short-lived download. |
| Password breach screening | Keep the control on the Release Readiness hold list until the Supabase organization is upgraded to Pro; Supabase does not permit leaked-password protection on the current Free plan. |
| Demo email delivery | Keep demo and role-test logins active, but hold their outbound messages before Resend. Retain the held message and reason in the notification history; never consume provider quota for a known non-mailbox identity. |
| Merchandise e-commerce | Hold for now. |

## Cross-workstream build coordination

The department chats should work from one staged build order and one shared service model so they do not overwrite each other's assumptions.

### Current build order

| Stage | Focus | Included first | Guardrail |
| --- | --- | --- | --- |
| 1 | Brand Portal demo | urbanXtracts Brand account, Brand home, company/onboarding, products/SKUs, catalog and PO submit, inventory views, read-only QuickBooks financials, documents, users, support/issues | Do not expose retailer identity, internal cost/margin/settlement, bulk/material records, or unapproved internal categories to Brand users. |
| 2 | Internal Employee Portal foundation | My Work, shared requests/tasks/approvals, access requests, offboarding checklist, controlled documents, audit history, export logging, department views | Use shared workflow, permission, evidence, notification, reporting, and audit services rather than department-specific engines. |
| 3 | Store/Dispensary expansion | Owner, Buyer/Manager, Budtender, and kiosk role model; reusable ordering/account/education patterns | Store expansion remains held until Brand demo and Internal foundation are stable or the release priority changes. |

### Shared services all chats should reuse

- Identity and permissions: account, workspace, role, department, scope, action, export permission, expiration, and deactivation.
- Workflow: request, task, approval, comment, evidence, status, escalation, completion, and audit event.
- Documents: private storage, document classes, versioning, visibility, review dates, legal hold, archive-not-delete, scanning, and release controls.
- Integrations: Canix, QuickBooks, Google Workspace, Monday.com, Wurk, Resend, PistilData, and future services with source, freshness, stale, and error states.
- Reporting: scheduled refresh plus approved on-page refresh; all connected reports require source and as-of timestamps.
- Audit and exports: every export, permission change, deactivation, approval, evidence action, integration action, and legal hold is logged.

### Internal Employee foundation controls

| Area | Baseline |
| --- | --- |
| Employee roster | Mirror Monday.com first. UX OS may become authoritative later after HR and IT accept the migration. |
| PTO | UX OS routes requests only. PTO balances stay with the payroll processor. |
| Schedules | UX OS schedule ownership is planned for a later internal release, not the first Brand demo. |
| Wurk | Wurk is the named HR platform. Integration scope remains discovery work. |
| Google Calendar | Calendar sync is desirable but later, unless explicitly approved as low-effort first-release work. |
| HR restricted records | Medical, accommodation, compensation, investigations, employee relations, and performance records require a separate HR restricted tier. |
| Contractor accounts | IT/Admin creates portal-only contractor accounts, Executive approval is required, expiration date is required, and default access should be least-privilege with no sensitive HR, Finance, Quality, or Executive records unless separately approved. |

### HR restricted record model

| Record area | Access tier | Baseline |
| --- | --- | --- |
| Directory and employee profile basics | Ordinary HR or department access | Name, role, department, work contact, manager, status, and assigned work may appear in ordinary employee views when permitted. |
| PTO requests | Workflow access | UX OS routes PTO requests and approvals only. Payroll remains authoritative for balances and calculations. |
| Schedules | Planned later | UX OS schedule ownership is planned later. Google Calendar sync is later unless separately approved. |
| Medical and accommodation | HR restricted | Separate restricted permission, limited exports, no ordinary department access, and no Executive blanket access by default. |
| Compensation | HR / Finance restricted | Explicit HR or Finance-sensitive permission required; compensation is redacted from general exports. |
| Investigations and employee relations | HR restricted plus legal-hold support | Case notes, evidence, interviews, outcomes, and related comments require restricted access, legal-hold awareness, and full audit history. |
| Performance records | HR restricted | Requires explicit scope and retention policy before storage; do not treat informal manager notes as formal performance files without policy. |

### Store / Dispensary role baseline for later expansion

Store expansion remains held, but the approved role boundaries should be preserved for later build planning.

| Role | Scope | Can | Cannot |
| --- | --- | --- | --- |
| Owner | All assigned organization stores | View, request, order, approve, export, manage users/settings, and see full account statements with invoice references | Bypass server permissions, compliance holds, explicit account holds, or source freshness gates |
| Buyer / Manager | Assigned stores | View, request, order, approve where delegated or policy allows, export scoped reports, and see full account statements with invoice references | Manage users, account settings, legal identity, or organization-wide access |
| Budtender | Assigned store or shared product-education device | Product education, training, COA lookup, and approved resources | Prices, cart, orders, invoices, account statements, exports, exact inventory, or admin controls |
| Public kiosk visitor | Store-specific public education link | Approved product education only | Sign-in data, prices, orders, inventory quantities, account information, exports, or administration |

### Operations and Quality purchase-order controls

| Area | Owner | Baseline |
| --- | --- | --- |
| Receiving confirmation | Stores and Sales Managers | Stores and Sales Managers may confirm receiving with evidence, quantity, date, receiver, and shipment reference. |
| Delivery lifecycle | Operations | Operations reviews start-to-finish delivery: pick, ship, in transit, delivered, refused, short, damaged, and exception states. |
| Inventory exceptions | Operations and Quality | Operations and Quality jointly own inventory exceptions. Finance and IT support only where cost, source, or integration control is involved. |
| Inventory authority | Canix | Canix remains authoritative for cannabis inventory, packages, items, facilities, compliance, lab/testing, quantities, and production records. |
| Portal PO workflow | UX OS | UX OS owns request, purchase-order status, notes, evidence, comments, approval history, and Brand-visible progress without writing to QuickBooks or Canix. |

### Marketing asset controls

| Area | Baseline |
| --- | --- |
| Brand logos and guidelines | Brand members may contribute files. urbanXtracts reviews, publishes, archives superseded versions, and controls visibility. |
| Sell sheets, menus, and social assets | Allowed with internal Marketing review. Quality joins review when content includes product claims, compliance language, COA, warning, recall, potency, ingredient, or testing statements. |
| Product images | Product-image upload and publication remains held until Quality and IT approve scanner, quarantine, moderation, approved-host, and release controls. |
| Catalog image URLs | Catalog images must use HTTPS on approved asset hosts and must not bypass scanner or publication review controls. |
| Archive and retention | Superseded assets are archived rather than deleted and retain actor, timestamp, version, source, and review history. |

### Held until later approval

- QuickBooks write-back or mutation from Portal workflows.
- Automated cross-system deactivation for Google Workspace, Monday.com, Canix, PistilData, or QuickBooks.
- Portal MFA, automatic access-review execution, MDM, endpoint enforcement, and automatic retention deletion. Manual scheduled workforce and vendor reviews are active in IT governance.
- Google Calendar sync, schedule ownership implementation, merchandise ecommerce, department lead finalization, public COA/recall expansion, and unrestricted Store launch.

### Security, audit, export, and retention baseline

| Control | Current baseline |
| --- | --- |
| Legal hold | Executive Members may place or release legal holds. Records under legal hold cannot be archived out of normal access or deleted. |
| Deletion | Automatic deletion remains disabled. Records should be archived, superseded, revoked, or closed rather than deleted. |
| Export logging | Every export should record actor, timestamp, workspace, scope, purpose, record count, file type, and field/redaction profile. |
| Export redaction | Redact bank/routing details, credentials/tokens, scanner/security metadata, internal admin notes, cost/margin, settlement formulas, GL detail, unrelated organizations, HR restricted records, internal comments, package-level compliance details, and unapproved Quality/COA/recall material unless explicitly approved for that export scope. |
| Audit event retention | Retain audit, permission, export, legal hold, deactivation, approval, and integration-action logs for at least seven years, and longer while legal hold applies. |
| Finance records | Retain Finance workflow evidence, reconciliation packages, close packages, audit packages, vendor setup/change evidence, expense support, and QuickBooks reference evidence for at least seven years or the accounting requirement in force. |
| Quality and compliance records | Retain SOPs, CAPA, deviations, training, lot records, COA, release/hold evidence, and compliance records for at least seven years or the cannabis/compliance requirement in force, whichever is longer. |
| HR restricted records | Medical, accommodation, compensation, investigations, employee relations, and performance records require a separate restricted access tier and should follow HR/legal retention schedules. |

## 2. Department capability matrix

Use this matrix to confirm which functions belong in the first Internal Portal release, which should wait, and which department owns the final operating policy.

| Department | Core first-release candidates | Later or controlled scope | Approval owner needed |
| --- | --- | --- | --- |
| Executive Leadership | Exception summary, approved KPI dashboard, major operational risks, expiring agreements/licenses, cross-department approvals, leadership report download | Forecasting, AI decision support, unrestricted drilldown into sensitive records | CEO / Executive sponsor |
| Human Resources | Employee directory, employee profile basics, PTO requests, PTO approval routing, schedules, onboarding/offboarding checklist, policy acknowledgments, training/certification tracker, HR request intake | Compensation, medical/accommodation, investigations, employee relations, performance files, HR-restricted document vault | HR / People Operations |
| Finance and Accounting | QuickBooks connection health, reconciliation queue, account reconciliation workflow, AR aging view, AP/request intake, expense/reimbursement requests, purchase approval routing, monthly close checklist, journal entry request evidence | Bank/routing storage, automated QuickBooks mutation, settlement calculations, margin reporting, automated invoice creation | Controller / Finance lead |
| Operations | Daily operating dashboard, supply requests, department supply catalog, purchase request workflow, receiving confirmation, inventory exceptions, production/fulfillment schedule, facilities and maintenance requests, incident reporting, checklists | Production planning, purchasing forecasts, automated inventory reservation policy, expanded vendor quoting | Operations lead |
| Marketing | Marketing request intake, campaign calendar, launch calendar, asset library, creative brief workflow, content approval, photography requests, product-content readiness, asset archive | Product-image uploads, promotion governance, campaign performance automation | Marketing lead |
| Sales and Commercial | Brand/store account summaries, account assignments, opportunities, follow-up tasks, pricing and discount requests, commercial-term approvals, order exceptions, samples, forecasts, agreement renewals | Retailer identity visibility to Brands, promotion stacking rules, direct Brand-to-store transaction model | Sales / Commercial lead |
| Quality and Compliance | License and permit register, renewal workflow, controlled SOPs/policies, document revision workflow, training requirements, supplier qualification, deviations, CAPA, audit findings, complaint intake, inspection evidence | Public COA publishing, public recall publishing, automated product release decisions | Quality / Compliance lead |
| IT and Administration | User onboarding/offboarding, access requests, role and department assignments, immediate deactivation, SSO administration, help desk, integration health, change management, Release Readiness, backup evidence, vendor access reviews, user access reviews | Department self-administration, automated access reviews, device management integrations | IT / Administration |

## 3. Proposed system architecture

The Internal Portal should reuse the existing UX OS pattern:

1. **Supabase and UX OS application layer**
   - Own authentication state, memberships, department permissions, requests, tasks, approvals, comments, evidence, portal documents, notifications, workflow state, and audit history.
   - Enforce all access server-side through role, department, organizational scope, and permitted action.
   - Store internal documents in private storage with malware scanning and version control.

2. **Canix projection layer**
   - Canix remains authoritative for physical cannabis inventory, packages, items, facilities, compliance status, lab/testing information, package quantities, and production/compliance records.
   - UX OS may show authorized inventory exceptions, availability snapshots, package status, and operational queues.
   - Connected inventory screens must show source and last successful update time.
   - When Canix is unavailable, UX OS should show the last successful Canix snapshot and mark it as stale rather than replacing unknown data with zero.

3. **QuickBooks projection and evidence layer**
   - QuickBooks remains authoritative for customers, vendors, accounts, invoices, credits, payments, receivables, balances, and general ledger activity.
   - UX OS may organize reconciliations, approvals, explanations, close tasks, supporting evidence, and review history around QuickBooks records.
   - UX OS should not silently mutate QuickBooks records or create unverified invoices.

4. **Google Workspace identity layer**
   - Employees should use Google SSO.
   - MFA, if required for employees, should be enforced through Google Workspace rather than a separate UX OS prompt.
   - External Brand and Store users may continue to use email/password accounts.

5. **Monday.com history and migration layer**
   - Existing Monday records should be preserved.
   - New portal-native workflows should stay in UX OS.
   - Monday data may remain as read-only history during migration.
   - Store onboarding dependencies remain on hold until Store strategy is reactivated.

6. **Notification layer**
   - Resend remains the controlled email notification path.
   - Current free-account guardrails are 100 messages per UTC day and 3,000 messages per month.
   - Shared department requests now have approved receipt and status-update templates, durable outbox records, stable idempotency keys, and provider delivery-state capture.
   - Confirm the planned Resend plan upgrade and approve replacement Portal caps before changing the current guardrails.
   - Additional escalation policies require business approval before enablement.

## 4. Permission model

Access should be determined by four dimensions:

| Dimension | Examples | Approval question |
| --- | --- | --- |
| Workforce role | Administrator, Executive, Department Head, Manager, Employee, Viewer, Finance Preparer, Finance Reviewer, HR Restricted, Quality Reviewer | Use as the first planning set; department-specific roles remain configurable. |
| Department | HR, Marketing, Operations, Finance, Sales, Quality, IT/Admin, Executive | IT is temporary platform owner; Executive Member is backup; Tom Jalallar is temporary department head until leads are finalized. |
| Organizational scope | Internal company, department, assigned team, assigned Brand, assigned account, assigned facility | Scope every record to the narrowest matching business owner, workspace, account, facility, or department. |
| Permitted action | Read, create request, comment, upload evidence, prepare, review, approve, return, administer, export | Enforce segregation for Finance prepare/review, Quality release, Administrator access, legal hold, and sensitive HR access. |

### Baseline controls

- Hidden navigation is not access control. All permissions must be enforced server-side.
- Department membership changes must be audited.
- Approval actions must retain actor, timestamp, prior state, new state, and evidence.
- Users should not approve their own work when segregation of duties is required.
- Finance preparer and reviewer should be separate where a review control exists.
- HR restricted records need a separate permission tier from ordinary HR directory data.
- Executives should receive approved summaries and exception views, not unrestricted sensitive record access by default.
- Immediate deactivation must disable access during offboarding.

## 5. Proposed rollout phases

### Phase 1 - Shared foundation

Recommended release goal: create the common internal operating foundation without deep department automation.

- My Work
- Department memberships
- Requests and forms
- Tasks and assignments
- Approval routing
- Calendar
- Private documents
- Policy acknowledgments
- Comments and evidence
- Audit history
- Executive exception summary

### Phase 2 - Department essentials

Recommended release goal: prove value for the most repeated cross-department workflows.

- HR PTO and scheduling
- Operations supply requests
- Finance reconciliation workflow
- Finance close checklist
- Marketing request and asset approval
- IT service desk and access requests
- Department owner dashboards

### Phase 3 - Connected operations

Recommended release goal: attach department workflows to controlled projections from approved systems of record.

- QuickBooks reconciliation data
- Canix inventory exceptions
- Purchase and receiving workflow
- Department budgets
- Training and compliance
- Executive reporting
- Integration health summaries

### Phase 4 - Advanced planning

Recommended release goal: add planning and decision support only after source data, ownership, confidence rules, and approval controls are accepted.

- Workforce capacity planning
- Inventory forecasts
- Purchasing forecasts
- Cash and collection prioritization
- Cross-department planning
- Controlled AI assistance

## 6. Systems-of-record boundaries

| System | Remains authoritative for | UX OS may own or display |
| --- | --- | --- |
| UX OS / Supabase | Portal authentication state, memberships, department permissions, requests, tasks, approvals, schedules, comments, evidence, portal documents, notifications, workflow state, audit history, user-facing projections | Employee portal workflows, department queues, internal documents, approval records, decision register |
| Canix | Physical cannabis inventory, packages, items, facilities, compliance status, lab/testing information, package quantities, production/compliance records | Source-labelled inventory projections, exceptions, freshness labels, authorized operational views |
| QuickBooks | Customers, vendors, accounts, invoices, credits, payments, receivables, accounting balances, GL activity | Reconciliation workflow, review evidence, close checklist, approved financial projections |
| Google Workspace | Employee identity provider and employee MFA if approved | SSO entry, employee identity matching, workforce access provisioning |
| Monday.com | Historical workflow records that already exist | Read-only history and migration reference; no new active workflow dependency unless specifically approved |
| Resend | Email delivery path and delivery feedback | Portal-controlled notification templates, outbox, caps, audit history |

## 7. Decision register

These decisions now have a planning baseline. Items marked held should not be built as live functionality until explicitly reopened.

| # | Decision | Current baseline | Status |
| --- | --- | --- | --- |
| 1 | First Internal Portal departments | Shared foundation first: IT/Admin, Finance, Operations, Quality/Compliance, Sales/Commercial, Marketing requests/assets, HR routing, and Executive summaries. | Baseline approved |
| 2 | Employee records source | Mirror Monday.com first; UX OS may become authoritative later after HR and IT acceptance. | Baseline approved |
| 3 | PTO balances source | Payroll processor owns PTO balances. | Baseline approved |
| 4 | PTO calculation | UX OS routes PTO requests only; it does not calculate balances. | Baseline approved |
| 5 | Schedules | UX OS schedule ownership is planned later; first release may capture requests/status only. | Planned later |
| 6 | Google Calendar | Later unless separately approved as low-effort. | Held |
| 7 | Finance reconciliation separation | Finance Preparer prepares; Finance Reviewer or Controller reviews; same user cannot prepare and approve the same controlled reconciliation. | Baseline approved |
| 8 | Spending thresholds | $0-$500 Eric Stewart, backup Omeed/Jonathan/Drew; $501-$2,999 Jonathan/Drew/Omeed; $3,000+ Eran Sherin; approved items route to Amrit Kharas for processing. | Approved |
| 9 | Supplies without Finance review | Ordinary low-risk supplies may use Operations approval unless spend threshold or always-Finance-review category applies. | Reviewable baseline |
| 10 | HR restricted records | Medical, accommodation, compensation, investigations, employee relations, and performance require HR restricted tier. | Approved |
| 11 | Executive metrics | Use source-labelled approved KPIs only; no unrestricted drilldown by default. | Reviewable baseline |
| 12 | Retention periods | Seven-year default for audit, Finance, Quality/compliance, and workflow evidence; HR follows HR/legal schedule; archive instead of delete. | Reviewable baseline |
| 13 | Approval delegation | Allowed only when role, scope, segregation-of-duties, and audit controls remain intact. Legal hold and Administrator access do not delegate by default. | Reviewable baseline |
| 14 | Monday workflows | Preserve historical records; new workflows should be portal-native unless approved. | Approved |
| 15 | Contractors | Supported with IT/Admin-created portal accounts, IT and Executive approval, required expiration, and least-privilege default access. | Approved |
| 16 | Mobile-friendly functions | Receiving, access/deactivation, approvals, exceptions, task comments, evidence capture, and executive summaries should be mobile-friendly. | Reviewable baseline |
| 17 | Workspace owners | IT is temporary platform owner; Executive Member is backup; Tom Jalallar is temporary department head until leads are finalized. | Approved temporary baseline |
| 18 | Department membership administration | Administrators manage membership first; department self-administration remains held. | Held |
| 19 | Executive approval requests | Legal holds, high-risk access, $3,000+ spend, blocked escalations, sensitive policy exceptions, and cross-workspace exceptions. | Reviewable baseline |
| 20 | Overdue escalation | Owning department first, then Executive Member for blocked or high-risk overdue work. | Reviewable baseline |
| 21 | Export policy | Executive, Sales, Finance, and Operations may export approved internal reports; Brands only their Brand scope; every export logged and redacted. | Approved |
| 22 | Finance platform/business ownership | IT owns platform administration; Finance business owner remains to be named, with Executive backup until assigned. | Reviewable baseline |
| 23 | Non-Finance Finance visibility | Sales sees assigned-customer AR/invoice/payment status only; Operations sees purchase/AP/receiving status tied to work; IT sees integration metadata; Executives see summaries and permitted exceptions. | Approved |
| 24 | Brand fee and settlement schedules | Controlled cross-workstream item across Finance, Brand, agreements, and QuickBooks; held for first release unless OS Portal Arch reopens. | Held |
| 25 | Shared export and retention controls | Audit/export/legal hold/document retention are shared services reused across departments. | Approved |

### Controlled review queue

These items stay visible in Portal Build, but they do not block the Brand demo unless their underlying workflow is moved into release scope.

| Item | Owner | Why it waits | Current guardrail |
| --- | --- | --- | --- |
| Lot and batch identifier rule | Operations | Active packages do not consistently carry lot or batch identifiers. | Compliance tag remains sufficient identity; deeper lineage waits for a go-forward identifier rule. |
| Wholesale sheet to Canix item mapping | Sales Operations and Data | The active wholesale sheet has priced rows without immutable Canix Item IDs. | Only unique exact product-name plus Brand matches can be verified automatically; all other matches remain review-only. |
| Store visit reports as account notes | Sales Operations | The source board structure has not been confirmed. | Account notes stay labelled as sourced but unverified until the board columns are read. |
| Canix Package Owner bridge | IT/Data and Canix | The current REST-backed snapshot does not provide supported owner assignment coverage. | Canix Owner remains blank where unsupported and never becomes Economic Owner by inference. |
| QuickBooks production verification | Finance and IT | Production authorization and scheduled read-only snapshots are working as of 10/08/2026. Reconciliation views, remaining identity mappings, freshness/fallback acceptance, and reconnect-role evidence remain. | QuickBooks remains authoritative; the Portal remains read/workflow/evidence only and does not create or modify accounting records. |
| Multi-license organization mapping | Administration | Chains with multiple licenses need a tested organization mapping. | License number remains the account key until a multi-license test proves the grouping rule. |
| Finance cost and margin treatment | Finance | Cost component inclusion, coverage threshold, and margin formula need Finance approval. | Margin stays out of navigation; blank cost object is not substituted from lot, Brand, potency, or sales-order data. |
| Payment terms and credit limit account gate | Finance | Finance must choose whether missing terms are a hard stop or a controlled soft path. | Onboarding keeps Stage 03 explicitly waiting on payment terms, credit limit, and rate-card policy. |
| Rep-held ordering approval | Sales Leadership and Legal | Written authority is required before an urbanXtracts rep can hold a Store Owner approval. | Rep-held approval is disabled; Store Owner approval remains the supported retailer approval path. |
| Draft inventory hold policy | Operations and Sales Operations | The business has not approved whether drafts reserve inventory. | Drafts hold nothing; final submission rechecks inventory and raises the inventory-changed gate. |
| Store document upload classes | Operations, Quality, and IT/Admin | Store expansion and document-class release controls remain held. | No new Store document class goes live without storage, scan, review owner, retention, export logging, and archive controls. |

### Finance and Accounting preliminary decisions

These are planning recommendations for Portal Build intake. They are not live functionality.

| Decision | Current recommendation |
| --- | --- |
| Workspace owner | IT owns platform workspace administration. Add a Finance business owner before build planning; recommended owner is Controller / Finance Lead, or an Executive Member until that role is named. |
| Approved Finance roles | Executive Members approve Finance access and high-level Finance policy. Portal Build should still model workflow roles for Finance Requester, Finance Preparer, Finance Reviewer, Controller / Finance Lead, Vendor Control Reviewer, Finance Viewer, and Finance Admin. |
| First-release workflows | QuickBooks connection health, reconciliation queues, read-only AR aging, AP intake, expense and reimbursement requests, purchase approvals, vendor setup and vendor-change controls, monthly close checklist, journal-entry request and evidence, audit evidence workspace, and unreconciled-item queue. |
| Purchase approval thresholds | Approved planning baseline: $0-$500 requires Eric Stewart approval, with Omeed Turan, Jonathan DeMart, or Drew Walsh as backup; $501-$2,999 requires approval from Jonathan DeMart, Drew Walsh, or Omeed Turan; $3,000+ requires Eran Sherin approval. Approved requests are sent to Amrit Kharas for processing. |
| Always-Finance-review categories | New vendors, vendor changes, software and subscriptions, legal and professional services, capex and equipment, loans and financing, tax and compliance fees, inventory-adjacent purchases, emergency spend, recurring commitments, over-budget spend, and payment or remittance changes. |
| Reconciliation preparer and reviewer | Finance Preparer prepares bank, credit card, AR, AP, balance sheet, and unreconciled-item reconciliations. Finance Reviewer or Controller reviews. The same user should not prepare and approve the same controlled reconciliation. Amrit Kharas may process an approved item, but processing is not the same as approving the underlying spend or reconciliation. |
| Evidence required | Require source snapshot, support document, explanation, owner, approval, and final QuickBooks reference where applicable. Vendor changes require independent verification. Journal entries require business reason and support. Audit responses require request, responsive files, reviewer, and export log. |
| Close blocker versus exception | A blocker prevents reliable close or materially affects statements, compliance, cash, AR/AP, bank/card reconciliation, or required approvals. An exception is documented, assigned, and carried forward without preventing close. |
| Non-Finance visibility | Sales should see assigned-customer AR status and invoice/payment status only. Operations should see purchase, AP, and receiving status tied to their work. IT should see integration health and support metadata by default, not financial details. Executive Members should see approved summaries and permitted exception drilldowns. |
| Budget source | Hold budget-versus-actual until the approved source is named. Interim candidate: Finance-approved budget workbook or QuickBooks budget, if maintained and approved. |
| Brand fee and settlement schedules | Hold for first release and review through OS Portal Arch because this overlaps Finance, Brand, agreements, and QuickBooks visibility. |
| Exports | Allow PDF evidence packets and CSV summaries only for Executive Members, Controller / Finance Lead, approved Finance Reviewers, and audit owners. Every export should be permission-checked and logged. |
| Retention | Planning default is seven years for Finance workflow evidence, reconciliation packages, close packages, audit packages, vendor setup/change evidence, and expense support, subject to legal/accounting confirmation before automation. |
| QuickBooks write-back | Not approved for first release. UX OS remains read, workflow, approval, and evidence only unless a future approval explicitly authorizes controlled write-back. No silent mutations. |

## 8. Department owner and approval baseline

This replaces the earlier worksheet. It is the current planning baseline until department leads are finalized.

| Department | Workspace owner | Backup owner | First-release functions approved | Sensitive data tier | Approval delegation | Mobile required | Key metrics baseline | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Executive Leadership | IT for platform administration | Executive Member | Exception summary, approved KPI dashboard, legal holds, executive approvals, export oversight | Executive-restricted summaries; record-level access requires explicit permission | Operational follow-up may be delegated; legal hold authority stays Executive-only | Helpful, not required for first demo | Approved source-labelled KPIs only | No blanket access to HR, Finance, Quality, or compliance records. |
| Human Resources | IT for platform administration; HR business owner pending | Executive Member | Roster mirror, PTO routing, offboarding trigger support, restricted record model, policy acknowledgments | HR restricted tier required | HR and Executive approval required for restricted records | Helpful for approvals, not required for first demo | Roster, PTO request status, offboarding, acknowledgments | PTO balances stay with payroll. Schedules are planned later. |
| Finance and Accounting | IT for platform administration; Finance business owner pending | Executive Member | Purchase approvals, reconciliation, monthly close, read-only QuickBooks views, export evidence | Finance-restricted evidence tier required | Allowed only when preparer/reviewer separation remains intact | Helpful, not required for first demo | AR/AP, close status, approval exceptions, QuickBooks snapshot freshness | Executive Members approve Finance access and high-level policy. |
| Operations | IT for platform administration; Operations business owner pending | Executive Member | Delivery lifecycle, receiving confirmations, inventory exceptions, supply requests, checklists | Operations records plus Quality-controlled exceptions where needed | Allowed for operational review without changing Canix authority | Useful for receiving and exceptions | Delivery, receiving, exceptions, fulfillment readiness, Canix freshness | Canix remains authoritative for inventory facts. |
| Marketing | IT for platform administration; Marketing business owner pending | Executive Member | Marketing requests, asset library, creative briefs, content approval, Brand marketing materials | Claim/compliance content routes to Quality | Allowed for content review; product-image release remains held | Helpful, not required for first demo | Request status, asset readiness, campaign calendar when approved | Product-image uploads stay held until Quality and IT approve release controls. |
| Sales and Commercial | IT for platform administration; Sales business owner pending | Executive Member | Brand/store context, POs, receiving support, account status, scoped exports | Assigned-customer financial status only | Allowed for follow-up tasks and receiving where policy permits | Useful for field work | Assigned account activity, order exceptions, rollout readiness | Sales cannot expose retailer identity to Brands or override inventory authority. |
| Quality and Compliance | IT for platform administration; Quality business owner pending | Executive Member | Controlled docs, SOP/training, release/hold evidence, deviations, CAPA, complaints | Quality/Compliance-controlled tier required | Quality reviewer approval required for controlled releases | Useful for inspection evidence | Release holds, SOP status, CAPA/deviation aging, training completion | Public COA/recall expansion remains held. |
| IT and Administration | IT for platform administration | Executive Member | Users, roles, access requests, offboarding, integration health, vendor/access reviews | Admin/security metadata restricted | Administrator access remains IT approval only | Helpful, not required for first demo | Access reviews, deactivations, integrations, incidents | Tom Jalallar is the temporary department head until department leads are finalized. |

### Workflow approval worksheet

| Workflow | Department owner | Preparer/requester | Reviewer/approver | Escalation owner | Evidence required | Export allowed? | First release? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PTO request | HR | Employee | Manager / HR | HR, then Executive Member | Request, dates, manager decision, payroll reference if applicable | HR-approved summary only | First internal foundation |
| Schedule change | HR / Operations | Employee / Manager | Manager / HR | Operations or HR, then Executive Member | Requested change, coverage impact, approval note | Internal summary only | Planned later |
| Supply request | Operations | Employee | Department head / Operations; Finance if spend threshold applies | Operations, then Executive Member | Business need, item detail, quote or receipt where applicable | Operations/Finance summary | First internal foundation |
| Purchase approval | Finance / Executive policy; shared workflow service | Employee / Department head | Up to and including $500: Eric Stewart; above $500 and below $3,000: Omeed / Jonathan / Drew; $3,000 and above: Eran | Executive Member | Business purpose and Administrator-recorded business-authority evidence; supporting documents remain optional in the first release | CSV summary / PDF packet by approved roles only | Live first-release foundation |
| Account reconciliation | Finance | Finance preparer | Finance reviewer / Controller | Controller | Source snapshot, support, explanation, owner, approval, and exceptions | PDF packet by approved roles only | Yes |
| Monthly close task | Finance | Finance | Controller | Executive sponsor | Checklist evidence, reconciliation status, blockers, exceptions, and signoff | PDF packet by approved roles only | Yes |
| Marketing request | Marketing | Employee / Sales / Brand team | Marketing lead; Quality when claims or compliance content appears | Executive Member for blocked launches | Creative brief, assets, approval notes, compliance review when required | Approved asset/request summary | First internal foundation |
| Access request | IT/Admin | Employee / Manager | IT; owning department for sensitive Finance, HR, Quality, Executive access | Administrator, then Executive Member | Business justification, approver, role/scope, expiration where needed | Access review packet | Yes |
| Policy acknowledgment | HR / Department owner | Employee | Department owner / HR | HR, then Executive Member | Policy version, acknowledgment timestamp, employee identity | HR-approved summary | First internal foundation |
| Quality document revision | Quality and Compliance | Quality / Operations | Quality reviewer | Quality lead, then Executive Member | Revision, rationale, review notes, effective date, training impact | Quality-controlled packet | First internal foundation |

## 9. Recommended first-release scope

The safest first release is a shared foundation plus a narrow set of high-frequency department workflows. This avoids building many department-specific tools before ownership, record retention, sensitive-data boundaries, and approval thresholds are approved.

### Recommended include

- My Work
- Department membership and department home pages
- Request intake framework
- Task and approval framework
- Comments and evidence
- Private document storage with scanning
- Policy acknowledgments
- Calendar view
- Executive exception summary
- HR PTO request routing without PTO calculation unless HR confirms UX OS should own the formula
- Operations supply request workflow
- Finance reconciliation workflow with preparer/reviewer separation
- Finance close checklist
- Marketing request and asset approval
- IT service desk and access request workflow
- Release Readiness and integration health views for administrators

### Recommended hold

- PTO balance calculation until the current HR/payroll system of record is confirmed
- Restricted HR case files until the separate HR-restricted tier is approved
- Bank account/routing storage
- Automatic QuickBooks mutation or unverified invoice creation
- Public COA or public recall publishing
- Production planning, forecasts, and AI assistance
- Department self-administration of membership until IT and executives approve the model
- Automatic deletion under retention policy until legal-hold and disposition evidence rules are approved

## 10. Risks and controls

| Risk | Why it matters | Recommended control |
| --- | --- | --- |
| Sensitive HR overexposure | Ordinary employee records and restricted HR case material have different confidentiality requirements | Create a separate HR restricted permission tier before storing sensitive case, medical, accommodation, compensation, or investigation records |
| Accounting mutation without review | Finance records require auditability and segregation of duties | Keep QuickBooks authoritative; use UX OS for review evidence, approvals, and reconciliation state |
| Inventory freshness confusion | Cannabis inventory cannot be guessed or replaced with zero | Show Canix source and last-successful update time; target under 15 minutes, warn after 30 minutes, mark stale after 60 minutes, and block current-inventory decisions after 4 hours or a sync failure |
| Executive over-access | Executive summary needs differ from record-level access | Provide approved aggregate views and exception links, with record-level access granted only by explicit permission |
| Self-approval | Some workflows require separation of preparer and reviewer | Block self-approval where segregation applies and retain approval history |
| Notification overrun | Resend capacity can be exceeded by broad escalation rules even after a plan upgrade | Keep approved daily/monthly Portal caps and require approval for new mandatory templates, recipients, or escalation timing |
| Monday dependency creep | The long-term direction is portal-native workflow | Preserve Monday history, but require explicit approval for any new active Monday dependency |
| Document retention mistakes | Cannabis, finance, HR, and legal records can have different retention duties | Approve record classes, retention start events, legal-hold behavior, and deletion evidence before automated disposition |
| Mobile usability gaps | Some employee workflows may happen away from a desk | Identify mobile-required functions during department review |
| Designed intent presented as live | Investors and executives need accurate release claims | Label every capability as Live, In Development, Designed Intent, On Hold, or Out of Scope until accepted |

## Proposed review agenda

1. Confirm the Internal Portal vision and non-goals.
2. Review systems-of-record boundaries and agree that Canix and QuickBooks remain authoritative.
3. Review the department capability matrix and mark first-release candidates.
4. Approve or revise the permission model.
5. Validate the temporary department owner and workflow approval baselines.
6. Confirm which reviewable baselines become approved policy and which remain held.
7. Confirm recommended first-release scope and controlled holds.
8. Assign owners for implementation planning and Release Readiness task creation.

## Acceptance output from the review

The executive and department-head review should produce:

- Approved first-release department list.
- Confirmation or replacement of the temporary IT owner / Executive backup model.
- Approved first-release workflows.
- Permission roles and sensitive-data tiers.
- Systems of record for employee data, PTO, schedules, accounting, and inventory.
- Approval thresholds and escalation policy.
- Export policy.
- Retention-policy owners and outstanding legal/compliance decisions.
- A clear list of held capabilities that must not be built or represented as live.

After those outputs are approved, the next step is to translate decisions into a detailed implementation plan and Release Readiness tasks.
