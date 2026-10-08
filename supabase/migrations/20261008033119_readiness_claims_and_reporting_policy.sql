-- Record the Brand-first portal evidence pass without enabling held roadmap work.
-- These updates only move readiness-task status and evidence. They do not
-- create permissions, expose new data, or change integration behavior.

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Capability matrix published in docs/ux-os-capability-claims-audit.md. The matrix classifies Live, In Development, Designed Intent, On Hold, and Out of Scope claims and preserves release-language rules for Brand, Internal, Store, reporting, AI, payments, and public publication.',
  source_reference = 'docs/ux-os-capability-claims-audit.md',
  completion_check = 'deck_capability_claims_audit',
  updated_at = now()
where task_key = 'deck-capability-claims-audit';

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Brand home is action-oriented around Brand-scoped performance, demo readiness, onboarding progress, source exceptions, and next actions. Internal Administrators have dedicated Brand application, Brand purchase-order, readiness, and shared work-queue command pages. Store expansion remains held.',
  source_reference = 'ux-portal-prototype.dc.html and scripts/verify-release-contracts.mjs',
  completion_check = 'role_specific_home_pages',
  updated_at = now()
where task_key = 'role-specific-home-pages';

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Internal command views now surface Brand applications, Brand purchase orders, shared work items, release readiness, source-quality exceptions, comments, evidence, and permitted status actions. Each queue opens the relevant portal-owned or connector-scoped record rather than a generic dashboard tile.',
  source_reference = 'ux-portal-prototype.dc.html, portal-brand-application, portal-brand-operations, portal-work-queue, portal-readiness',
  completion_check = 'internal_exception_command_center',
  updated_at = now()
where task_key = 'internal-exception-command-center';

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Release contracts verify source and freshness labels for Canix, QuickBooks, Portal, Monday, and shop snapshots. Connected screens show last-successful timestamps, stale or unavailable state, and preserve unknown values instead of substituting zero.',
  source_reference = 'scripts/verify-release-contracts.mjs',
  completion_check = 'connected_metric_source_freshness',
  updated_at = now()
where task_key = 'connected-metric-source-freshness';

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Brand home presents aggregate Brand-scoped ordered and fulfilled units, SKU trends, open actions, onboarding state, source exceptions, and demo-readiness gates. Retailer/store identity remains withheld and sales-dollar reporting remains gated by Finance approval and stable QuickBooks line mapping.',
  source_reference = 'ux-portal-prototype.dc.html and portal-brand-operations',
  completion_check = 'brand_performance_home',
  updated_at = now()
where task_key = 'brand-performance-home';

update public.portal_readiness_task
set
  status = 'in_progress',
  evidence_summary = 'Draft glossary and reporting policy published in docs/metric-glossary-reporting-policy.md. It defines source/freshness rules, core metric meanings, export logging/redaction, QuickBooks read-only boundary, Finance approval routing, preparer/reviewer separation, and archive-not-delete retention stance. Finance and Operations approval is still required before marking complete.',
  source_reference = 'docs/metric-glossary-reporting-policy.md',
  completion_check = 'metric_glossary_reporting_policy',
  updated_at = now()
where task_key = 'metric-glossary-reporting-policy';

update public.portal_readiness_task
set
  status = case when status = 'completed' then status else 'in_progress' end,
  evidence_summary = 'Brand-first dashboard and commerce surfaces now use the restrained portal visual system with grouped navigation, dense action queues, readable tables, source chips, and role-aware workspace context. Formal design/accessibility review remains required before completion.',
  source_reference = 'ux-portal-prototype.dc.html',
  completion_check = 'role_specific_visual_system',
  updated_at = now()
where task_key = 'role-specific-visual-system';
