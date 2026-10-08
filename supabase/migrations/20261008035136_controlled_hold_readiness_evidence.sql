-- Attach the formal approval-packet document to every remaining controlled
-- hold so release reviewers can inspect the exit criteria from the durable
-- readiness register, not just from the repository docs.

insert into public.portal_readiness_evidence (task_id, label, note)
select task.id,
       'Controlled-hold approval packet',
       'Approval request, evidence requirements, and decision-record format are documented in docs/ux-os-controlled-hold-approval-packets.md. Keep this item in controlled_hold until its packet is approved and the required evidence is attached.'
from public.portal_readiness_task as task
where task.active
  and task.status = 'controlled_hold'
  and task.task_key in (
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
  and not exists (
    select 1
    from public.portal_readiness_evidence as evidence
    where evidence.task_id = task.id
      and evidence.label = 'Controlled-hold approval packet'
  );
