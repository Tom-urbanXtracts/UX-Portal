-- Exact Supply Order department taxonomy and optional Brand scope.
-- Existing shared-request departments remain intact; this adds the department
-- keys needed by the dedicated Supply Orders workflow.

insert into public.portal_department (
  department_key, display_name, status, platform_owner, business_owner,
  backup_owner, sensitive_tier
) values
  ('maintenance', 'Maintenance', 'active', 'IT', null, 'Executive Member', false),
  ('administration', 'Administration', 'active', 'IT', null, 'Executive Member', true),
  ('compliance', 'Compliance', 'active', 'IT', null, 'Executive Member', true),
  ('distribution', 'Distribution', 'active', 'IT', null, 'Executive Member', false),
  ('human_resources', 'Human Resources — Supply Orders', 'active', 'IT', null, 'Executive Member', true),
  ('grow', 'Grow', 'active', 'IT', null, 'Executive Member', false),
  ('marketing', 'Marketing', 'active', 'IT', null, 'Executive Member', false),
  ('process', 'Process', 'active', 'IT', null, 'Executive Member', false),
  ('develop', 'Develop', 'active', 'IT', null, 'Executive Member', false),
  ('brand', 'Brand', 'active', 'IT', null, 'Executive Member', true)
on conflict (department_key) do update set
  status = 'active', updated_at = now();

alter table public.portal_purchase_request
  add column if not exists brand_organization_id uuid
    references public.portal_organization(id) on delete restrict;

alter table public.portal_purchase_request
  drop constraint if exists portal_purchase_request_brand_scope_check;
alter table public.portal_purchase_request
  add constraint portal_purchase_request_brand_scope_check check (
    (requested_for_department_key = 'brand' and brand_organization_id is not null)
    or (requested_for_department_key <> 'brand' and brand_organization_id is null)
  ) not valid;
alter table public.portal_purchase_request
  validate constraint portal_purchase_request_brand_scope_check;

create index if not exists portal_purchase_request_brand_idx
  on public.portal_purchase_request (brand_organization_id, created_at desc)
  where brand_organization_id is not null;

create or replace function public.portal_submit_purchase_request_v4(
  p_actor_id uuid, p_actor_email text, p_department_key text,
  p_brand_organization_id uuid, p_vendor_name text, p_purpose text,
  p_priority text, p_needed_by date, p_delivery_start_on date,
  p_delivery_end_on date, p_recurring_purchase boolean, p_payment_method text,
  p_recipient_name text, p_delivery_location text,
  p_estimated_shipping numeric, p_estimated_tax numeric,
  p_estimated_discount numeric, p_lines jsonb
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare
  request_row public.portal_purchase_request;
  base_department_key text;
begin
  if p_department_key not in (
    'maintenance','administration','compliance','distribution',
    'human_resources','grow','marketing','process','develop','brand'
  ) then
    raise exception 'Choose an approved Supply Order department';
  end if;

  if p_department_key = 'brand' then
    if p_brand_organization_id is null or not exists (
      select 1
      from public.portal_organization as organization
      join public.portal_brand_profile_detail as detail
        on detail.organization_id = organization.id
      where organization.id = p_brand_organization_id
        and organization.kind = 'brand'
        and organization.status = 'active'
        and detail.activation_state = 'active'
    ) then
      raise exception 'Choose an active Brand for this Supply Order';
    end if;
  elsif p_brand_organization_id is not null then
    raise exception 'A Brand may only be assigned to the Brand department';
  end if;

  -- v3 predates Brand scope and therefore inserts the department before the
  -- Brand foreign key is available. Use a valid temporary department inside
  -- this same transaction, then atomically apply the requested Brand scope.
  base_department_key := case when p_department_key = 'brand'
    then 'maintenance' else p_department_key end;

  select * into request_row
  from public.portal_submit_purchase_request_v3(
    p_actor_id, p_actor_email, base_department_key, p_vendor_name, p_purpose,
    p_priority, p_needed_by, p_delivery_start_on, p_delivery_end_on,
    p_recurring_purchase, p_payment_method, p_recipient_name,
    p_delivery_location, p_estimated_shipping, p_estimated_tax,
    p_estimated_discount, p_lines
  );

  update public.portal_purchase_request
  set requested_for_department_key = p_department_key,
      brand_organization_id = p_brand_organization_id
  where id = request_row.id
  returning * into request_row;

  update public.portal_admin_audit
  set detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object(
    'departmentKey', p_department_key,
    'brandOrganizationId', p_brand_organization_id
  )
  where action = 'supply_order_submitted' and target_id = request_row.id;

  return request_row;
end;
$$;

revoke all on function public.portal_submit_purchase_request_v4(
  uuid,text,text,uuid,text,text,text,date,date,date,boolean,text,text,text,
  numeric,numeric,numeric,jsonb
) from public, anon, authenticated;
grant execute on function public.portal_submit_purchase_request_v4(
  uuid,text,text,uuid,text,text,text,date,date,date,boolean,text,text,text,
  numeric,numeric,numeric,jsonb
) to service_role;

-- pgcrypto is installed in the extensions schema in production. Keep the
-- existing ordered-item history function able to resolve digest() without
-- exposing any additional browser access.
alter function public.portal_mark_supply_order_ordered(
  uuid,text,uuid,integer,numeric,text,date,text
) set search_path = public, extensions, pg_temp;

comment on column public.portal_purchase_request.brand_organization_id is
  'Required only when the Supply Order department is Brand; references the active Brand profile selected by the requester.';
