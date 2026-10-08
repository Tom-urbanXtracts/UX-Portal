-- Attach the approval-packet source to every remaining controlled hold. This
-- does not approve or enable any held capability; it only records the
-- review-ready request path and evidence requirements.

update public.portal_readiness_task
set
  evidence_summary = evidence_summary || ' Approval packet prepared in docs/ux-os-controlled-hold-approval-packets.md.',
  source_reference = case
    when source_reference is null or btrim(source_reference) = '' then
      'docs/ux-os-controlled-hold-approval-packets.md'
    when source_reference like '%docs/ux-os-controlled-hold-approval-packets.md%' then
      source_reference
    else
      source_reference || '; docs/ux-os-controlled-hold-approval-packets.md'
  end,
  updated_at = now()
where active
  and status = 'controlled_hold'
  and task_key in (
    'canix-owner-reporting-bridge',
    'document-retention',
    'metric-glossary-reporting-policy',
    'brand-account-opportunity-model',
    'retailer-buying-desk',
    'promotions-commercial-offers',
    'supply-production-planning',
    'decision-support-forecasts',
    'ai-buying-assistant'
  )
  and coalesce(evidence_summary, '') not like
    '%docs/ux-os-controlled-hold-approval-packets.md%';
