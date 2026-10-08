-- Close the visual-system readiness task using existing Brand workspace design
-- QA and release-contract evidence. This records evidence only; it does not
-- enable any held Store, promotion, forecasting, planning, or AI feature.

update public.portal_readiness_task
set
  status = 'completed',
  evidence_summary = 'Brand workspace design QA passed in design-qa.md with implementation captures for the company/onboarding workspace and Brand performance home. Release contracts verify grouped Internal/Brand navigation, responsive Brand performance grid, responsive onboarding workspace, and reporting copy that excludes retailer/store identity and sell-through claims.',
  source_reference = 'design-qa.md, ux-portal-prototype.dc.html, scripts/verify-release-contracts.mjs',
  completion_check = 'role_specific_visual_system',
  updated_at = now()
where task_key = 'role-specific-visual-system';
