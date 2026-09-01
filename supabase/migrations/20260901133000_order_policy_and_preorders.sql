-- Buyer approval policy is owned per licensed store. NULL disables the
-- value-based owner approval gate; zero requires approval for every buyer
-- order; a positive value requires approval only above that amount.

alter table public.portal_store
  add column if not exists approval_threshold_cents integer,
  add column if not exists approval_policy_updated_by uuid references auth.users(id),
  add column if not exists approval_policy_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_store'::regclass
      and conname = 'portal_store_approval_threshold_check'
  ) then
    alter table public.portal_store
      add constraint portal_store_approval_threshold_check
      check (approval_threshold_cents is null or (approval_threshold_cents >= 0 and approval_threshold_cents <= 100000000))
      not valid;
  end if;
end
$$;

alter table public.portal_store
  validate constraint portal_store_approval_threshold_check;

-- Demonstration policies for the known pre-production retailer records.
-- These can be changed from the portal after deployment.
update public.portal_store
set approval_threshold_cents = case license_number
  when 'OCM-RETL-24-000412' then 50000
  when 'OCM-RETL-24-000518' then 0
  else null
end,
approval_policy_updated_at = now()
where license_number in (
  'OCM-RETL-24-000412',
  'OCM-RETL-24-000518',
  'OCM-RETL-24-000633'
)
and approval_policy_updated_at is null;

comment on column public.portal_store.approval_threshold_cents is
  'Buyer-order owner approval threshold in cents. NULL disables the value gate; zero requires every buyer order to be approved; positive values require approval only when the verified order value is greater than the threshold.';
comment on column public.portal_store.approval_policy_updated_by is
  'Internal Administrator, Operations, or Sales user who last changed the store approval policy.';
