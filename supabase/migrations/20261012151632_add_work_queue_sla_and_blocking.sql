-- Add durable blocker and service-level targets to Administrator work items.
-- These fields are portal-owned and do not alter connected source systems.

alter table public.portal_work_item
  add column if not exists blocked_reason text,
  add column if not exists sla_due_at timestamptz;

alter table public.portal_work_item
  drop constraint if exists portal_work_item_blocked_reason_length,
  add constraint portal_work_item_blocked_reason_length
    check (blocked_reason is null or length(btrim(blocked_reason)) between 1 and 1000);

create index if not exists portal_work_item_sla_queue_idx
  on public.portal_work_item (status, sla_due_at nulls last)
  where status not in ('completed', 'cancelled');

comment on column public.portal_work_item.blocked_reason is
  'Administrator-recorded reason that a waiting work item cannot move forward.';

comment on column public.portal_work_item.sla_due_at is
  'Portal-owned service-level response target, separate from the operational due date.';
