-- Record implemented operational-expansion work as complete and keep the
-- remaining Canix Package Owner source gap visible in the durable register.

update public.portal_readiness_task
set status = 'completed',
    evidence_summary = case task_key
      when 'monday-direct-onboarding' then
        'Direct, board-pinned portal-intake path is deployed. The Make fallback and obsolete Supabase secrets were removed; commit 2b267c5 and release contracts verify the boundary.'
      when 'kiosk-lifecycle' then
        'Opaque hashed capabilities, expiration, rotation/revocation, device labels, optional restrictions, QR output, de-identified usage, and audited administration are deployed and contract-tested.'
      when 'store-access-reconciliation' then
        'The database trigger/backfill grants Owners all qualified stores, queues Buyer assignments for Administrator review, and preserves the one-store Budtender rule.'
      when 'durable-readiness-register' then
        'Protected task, comment, evidence, owner, due-date, and status records are deployed with readiness.manage authorization and three collapsible status groups.'
      when 'catalog-publishing-workflow' then
        'Required-content completeness and Draft, Review, Approved, Scheduled, Published, and Archived states are deployed; incomplete or unapproved new publication requests fail closed.'
    end,
    updated_at = now()
where task_key in (
  'monday-direct-onboarding',
  'kiosk-lifecycle',
  'store-access-reconciliation',
  'durable-readiness-register',
  'catalog-publishing-workflow'
);

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label,
   evidence_summary, source_reference, completion_check, sort_order)
values
  (
    'canix-owner-reporting-bridge',
    'Canix Package Owner reporting bridge',
    'Canix inventory',
    'Bring Canix owner_id and owner_name into the runtime package snapshot without treating either as Economic Owner. The current public REST Package schema does not expose those Reporting columns.',
    'in_progress',
    'IT / Data',
    '14 Sep 2026 comparison: Canix Reporting contained 474 assignments across 1,409 active non-sample non-volume packages; the fresh REST-backed portal snapshot contained zero assignments across 1,023 usable packaged/each packages.',
    'Canix Reporting inventory schema and REST API schema 1.3.11',
    'canix_owner_reporting_bridge',
    15
  )
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  status = case
    when public.portal_readiness_task.status = 'completed' then 'completed'
    else excluded.status
  end,
  owner_label = excluded.owner_label,
  evidence_summary = excluded.evidence_summary,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();

insert into public.portal_readiness_evidence (task_id, label, note)
select task.id,
       'Production source comparison — 14 Sep 2026',
       'Canix Reporting query: 474 rows with owner_id/owner_name out of 1,409 active non-sample non-volume packages. Fresh portal REST sync: zero Canix Owner assignments. Public Canix REST Package schema 1.3.11 contains no Owner property.'
from public.portal_readiness_task as task
where task.task_key = 'canix-owner-reporting-bridge'
  and not exists (
    select 1
    from public.portal_readiness_evidence as evidence
    where evidence.task_id = task.id
      and evidence.label = 'Production source comparison — 14 Sep 2026'
  );
