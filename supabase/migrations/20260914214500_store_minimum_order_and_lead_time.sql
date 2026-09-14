-- Optional store-level commercial terms. Null keeps the capability disabled
-- and preserves today's ordering behavior until an authorized user opts in.

alter table public.portal_store
  add column if not exists minimum_order_cents integer,
  add column if not exists lead_time_days integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_store'::regclass
      and conname = 'portal_store_minimum_order_check'
  ) then
    alter table public.portal_store
      add constraint portal_store_minimum_order_check
      check (minimum_order_cents is null or
        (minimum_order_cents > 0 and minimum_order_cents <= 100000000))
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_store'::regclass
      and conname = 'portal_store_lead_time_check'
  ) then
    alter table public.portal_store
      add constraint portal_store_lead_time_check
      check (lead_time_days is null or
        (lead_time_days >= 0 and lead_time_days <= 365))
      not valid;
  end if;
end $$;

alter table public.portal_store
  validate constraint portal_store_minimum_order_check;
alter table public.portal_store
  validate constraint portal_store_lead_time_check;

comment on column public.portal_store.minimum_order_cents is
  'Optional licensed-store minimum accepted order value. Null means no minimum.';
comment on column public.portal_store.lead_time_days is
  'Optional informational fulfillment lead time in calendar days. Null means not published.';

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label,
   evidence_summary, source_reference, completion_check, sort_order)
values
  (
    'store-order-commercial-terms',
    'Optional store minimum and lead time',
    'Ordering',
    'Allow authorized staff to set or clear a licensed-store minimum order value and an informational fulfillment lead time without inventing defaults.',
    'completed',
    'Sales Operations',
    'Null-safe store fields, protected policy API, audited updates, server-side minimum-order enforcement, and order-builder guidance are deployed. Existing stores remain unchanged until a policy is deliberately set.',
    'Portal store policy and order intake',
    'store_order_commercial_terms',
    65
  )
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  status = 'completed',
  owner_label = excluded.owner_label,
  evidence_summary = excluded.evidence_summary,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();

