-- Move the last non-completed readiness rows into explicit controlled holds.
-- The Brand-first buildable surface is complete; these items require external
-- Canix support or named business approvals before they may resume.

update public.portal_readiness_task
set
  status = 'controlled_hold',
  evidence_summary = 'Technical bridge is prepared: canix_package_owner_snapshot, service-only complete-snapshot replacement, trigger reconciliation into canix_package_current, UI filters, Brand inventory scoping, readiness warning, and release contracts are in place. Hold remains until Canix provides a supported server-side Reporting route/credential or a documented REST Package Owner property, followed by complete snapshot import, package-ID coverage/removal tests, and confirmation that Canix Owner never becomes Economic Owner.',
  source_reference = 'docs/ux-os-final-completion-blockers.md; supabase/migrations/20260930152000_canix_owner_reporting_bridge.sql',
  completion_check = 'canix_owner_reporting_bridge_external_source',
  updated_at = now()
where task_key = 'canix-owner-reporting-bridge';

update public.portal_readiness_task
set
  status = 'controlled_hold',
  evidence_summary = 'Metric glossary and reporting policy is approval-ready in docs/metric-glossary-reporting-policy.md. It defines source/freshness rules, core metric meanings, export logging/redaction, QuickBooks read-only boundary, Finance approval routing, preparer/reviewer separation, and archive-not-delete retention stance. Hold remains until Finance and Operations approve the policy version and any carveouts.',
  source_reference = 'docs/metric-glossary-reporting-policy.md; docs/ux-os-final-completion-blockers.md',
  completion_check = 'metric_glossary_reporting_policy_approval',
  updated_at = now()
where task_key = 'metric-glossary-reporting-policy';

update public.portal_readiness_task
set
  evidence_summary = 'Automatic deletion remains disabled by current archive-not-delete policy. Retention disposition requires legal/compliance approval for record classes, retention start events, legal hold behavior, reviewer separation, and retained deletion evidence before any worker exists.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  completion_check = 'retention_policy_approval',
  updated_at = now()
where task_key = 'document-retention';

update public.portal_readiness_task
set
  evidence_summary = 'Current Brand reporting remains aggregate and source-labelled; retailer/store identity and POS sell-through are withheld. Opportunity scoring stays held until Sales Operations, Data, and Legal approve the data boundary, scoring inputs, explanation text, confidence rules, and disable path.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'brand-account-opportunity-model';

update public.portal_readiness_task
set
  evidence_summary = 'Store expansion remains held under the Brand-first staged plan. Reactivation requires approved Store strategy, role/account-statement/order/approval rules, pricing and availability boundaries, and confidentiality controls.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'retailer-buying-desk';

update public.portal_readiness_task
set
  evidence_summary = 'Promotion stacking and commercial-offer overrides remain absent from production. Resume only after Sales, Finance, and Operations approve ownership, eligibility, dates, stacking, retirement, and pricing precedence.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'promotions-commercial-offers';

update public.portal_readiness_task
set
  evidence_summary = 'Brand purchase orders, production milestones, and evidence exist, but full supply and production planning remains held. Resume only after Operations, Production, Quality, and Data approve authority, write path, reservation behavior, ownership, and acceptance tests.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'supply-production-planning';

update public.portal_readiness_task
set
  evidence_summary = 'Current dashboards show source-labelled facts, not predictive decisions. Forecasts remain held until Finance, Operations, Sales Operations, and Data approve model definitions, validation evidence, confidence thresholds, explanations, and disable path.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'decision-support-forecasts';

update public.portal_readiness_task
set
  evidence_summary = 'No AI ordering assistant is live. Resume only after Product, Security, Legal, and Sales approve action boundaries, grounding sources, privacy assessment, human confirmation, evaluation set, audit requirements, and cost ceiling.',
  source_reference = 'docs/ux-os-final-completion-blockers.md',
  updated_at = now()
where task_key = 'ai-buying-assistant';
