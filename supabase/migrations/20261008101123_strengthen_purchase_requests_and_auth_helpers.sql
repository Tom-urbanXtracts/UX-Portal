-- Strengthen the Portal-owned purchase workflow from the approved Monday form
-- pattern while keeping business approval separate from Administrator processing.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter function public.portal_role() set schema private;
alter function public.portal_org() set schema private;
alter function public.portal_my_permissions() set schema private;

revoke all on function private.portal_role() from public, anon;
revoke all on function private.portal_org() from public, anon;
revoke all on function private.portal_my_permissions() from public, anon;
grant execute on function private.portal_role() to authenticated, service_role;
grant execute on function private.portal_org() to authenticated, service_role;
grant execute on function private.portal_my_permissions() to authenticated, service_role;

create table if not exists public.portal_purchase_approver (
  id uuid primary key default gen_random_uuid(),
  approval_tier text not null check (approval_tier in ('eric_500','leadership_2999','eran_3000')),
  display_name text not null check (length(btrim(display_name)) between 2 and 160),
  approver_email text not null check (approver_email = lower(btrim(approver_email)) and position('@' in approver_email) > 1),
  is_backup boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_tier, approver_email)
);

alter table public.portal_purchase_approver enable row level security;
revoke all on table public.portal_purchase_approver from public, anon, authenticated;
grant all on table public.portal_purchase_approver to service_role;

insert into public.portal_purchase_approver
  (approval_tier, display_name, approver_email, is_backup)
values
  ('eric_500', 'Eric Stewart', 'eric@urbanxtracts.com', false),
  ('eric_500', 'Omeed Turan', 'omeed@urbanxtracts.com', true),
  ('eric_500', 'Jonathan DeMart', 'jonathan@urbanxtracts.com', true),
  ('eric_500', 'Drew Walsh', 'drew@urbanxtracts.com', true),
  ('leadership_2999', 'Omeed Turan', 'omeed@urbanxtracts.com', false),
  ('leadership_2999', 'Jonathan DeMart', 'jonathan@urbanxtracts.com', false),
  ('leadership_2999', 'Drew Walsh', 'drew@urbanxtracts.com', false),
  ('eran_3000', 'Eran Sherin', 'eran@urbanxtracts.com', false)
on conflict (approval_tier, approver_email) do update set
  display_name = excluded.display_name,
  is_backup = excluded.is_backup,
  active = true,
  updated_at = now();

alter table public.portal_purchase_request
  add column if not exists priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  add column if not exists delivery_start_on date,
  add column if not exists delivery_end_on date,
  add column if not exists recurring_purchase boolean not null default false,
  add column if not exists payment_method text,
  add column if not exists business_approval_status text not null default 'pending'
    check (business_approval_status in ('pending','approved','returned','denied')),
  add column if not exists business_approver_id uuid references public.portal_profile(id) on delete set null,
  add column if not exists business_approver_email text,
  add column if not exists business_approval_note text,
  add column if not exists business_decided_at timestamptz,
  add column if not exists ordered_at timestamptz,
  add column if not exists delivered_at timestamptz;

alter table public.portal_purchase_request drop constraint if exists portal_purchase_request_delivery_range_check;
alter table public.portal_purchase_request add constraint portal_purchase_request_delivery_range_check
  check (delivery_start_on is null or delivery_end_on is null or delivery_end_on >= delivery_start_on);

create table if not exists public.portal_purchase_request_line (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.portal_purchase_request(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  item_description text not null check (length(btrim(item_description)) between 2 and 500),
  sku text,
  purchase_url text,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  subtotal numeric(12,2) generated always as (round(quantity * unit_cost, 2)) stored,
  expense_category text not null check (expense_category in ('supplies','services','inventory','equipment','travel','other')),
  expense_subcategory text,
  chart_of_accounts text,
  required_delivery_on date,
  created_at timestamptz not null default now(),
  unique (purchase_request_id, line_number)
);

create index if not exists portal_purchase_request_line_request_idx
  on public.portal_purchase_request_line (purchase_request_id, line_number);
alter table public.portal_purchase_request_line enable row level security;
revoke all on table public.portal_purchase_request_line from public, anon, authenticated;
grant all on table public.portal_purchase_request_line to service_role;

update public.portal_department
set business_owner = 'Tom Jalallar (temporary)', updated_at = now()
where status = 'active' and business_owner is null;

insert into public.portal_department_notification_recipient (
  department_key, recipient_type, display_name, recipient_email, active, created_by
)
select department_key, 'owner', 'Tom Jalallar · temporary department head',
  'tom@urbanxtracts.com', true,
  '83bfa688-b91d-4afb-8739-88316a1116a5'::uuid
from public.portal_department
where status = 'active'
on conflict (department_key, recipient_type, recipient_email) do update set
  display_name = excluded.display_name, active = true, updated_at = now();

create or replace function public.portal_submit_purchase_request_v2(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_vendor_name text,
  p_purpose text, p_priority text, p_needed_by date, p_delivery_start_on date,
  p_delivery_end_on date, p_recurring_purchase boolean, p_payment_method text,
  p_lines jsonb
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare
  actor_row public.portal_profile;
  department_row public.portal_department;
  request_row public.portal_purchase_request;
  line_row jsonb;
  line_no integer := 0;
  route_tier text;
  route_authority text;
  total_amount numeric(12,2) := 0;
  quantity_value numeric;
  unit_cost_value numeric;
  category_value text;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department
    where department_key = p_department_key and status = 'active';
  if department_row.department_key is null then raise exception 'Choose an active department'; end if;
  if length(btrim(coalesce(p_vendor_name,''))) < 2
    or length(btrim(coalesce(p_purpose,''))) < 12
    or p_priority not in ('low','normal','high','urgent')
    or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1
    or jsonb_array_length(p_lines) > 50 then
    raise exception 'Complete the purchase request and add at least one line item';
  end if;
  if p_delivery_start_on is not null and p_delivery_end_on is not null
    and p_delivery_end_on < p_delivery_start_on then
    raise exception 'Delivery end date cannot be before the start date';
  end if;
  for line_row in select value from jsonb_array_elements(p_lines) loop
    quantity_value := nullif(line_row->>'quantity','')::numeric;
    unit_cost_value := nullif(line_row->>'unitCost','')::numeric;
    category_value := lower(btrim(coalesce(line_row->>'expenseCategory','')));
    if length(btrim(coalesce(line_row->>'itemDescription',''))) < 2
      or quantity_value is null or quantity_value <= 0
      or unit_cost_value is null or unit_cost_value < 0
      or category_value not in ('supplies','services','inventory','equipment','travel','other') then
      raise exception 'Every purchase line needs an item, quantity, unit cost, and category';
    end if;
    total_amount := total_amount + round(quantity_value * unit_cost_value, 2);
  end loop;
  if total_amount <= 0 or total_amount > 9999999999.99 then
    raise exception 'Calculated purchase total must be greater than zero';
  end if;
  if total_amount <= 500 then route_tier := 'eric_500'; route_authority := 'Eric Stewart';
  elsif total_amount < 3000 then route_tier := 'leadership_2999'; route_authority := 'Omeed / Jonathan / Drew';
  else route_tier := 'eran_3000'; route_authority := 'Eran Sherin'; end if;

  insert into public.portal_purchase_request (
    requester_id, requested_for_department_key, vendor_name, expense_category,
    purpose, amount, needed_by, approval_tier, approval_authority, priority,
    delivery_start_on, delivery_end_on, recurring_purchase, payment_method
  ) values (
    p_actor_id, p_department_key, btrim(p_vendor_name),
    lower(btrim(coalesce(p_lines->0->>'expenseCategory','other'))),
    btrim(p_purpose), total_amount, p_needed_by, route_tier, route_authority,
    p_priority, p_delivery_start_on, p_delivery_end_on,
    coalesce(p_recurring_purchase,false), nullif(btrim(coalesce(p_payment_method,'')), '')
  ) returning * into request_row;

  for line_row in select value from jsonb_array_elements(p_lines) loop
    line_no := line_no + 1;
    insert into public.portal_purchase_request_line (
      purchase_request_id, line_number, item_description, sku, purchase_url,
      quantity, unit_cost, expense_category, expense_subcategory,
      chart_of_accounts, required_delivery_on
    ) values (
      request_row.id, line_no, btrim(line_row->>'itemDescription'),
      nullif(btrim(coalesce(line_row->>'sku','')), ''),
      nullif(btrim(coalesce(line_row->>'purchaseUrl','')), ''),
      (line_row->>'quantity')::numeric, (line_row->>'unitCost')::numeric,
      lower(btrim(line_row->>'expenseCategory')),
      nullif(btrim(coalesce(line_row->>'expenseSubcategory','')), ''),
      nullif(btrim(coalesce(line_row->>'chartOfAccounts','')), ''),
      nullif(line_row->>'requiredDeliveryOn','')::date
    );
  end loop;

  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'submitted', p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    'Submitted through the Internal portal with ' || line_no || ' line item(s).');
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_submitted', request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'lineCount', line_no, 'approvalTier', route_tier,
    'approvalAuthority', route_authority,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

create or replace function public.portal_record_purchase_business_decision(
  p_actor_id uuid, p_actor_email text, p_request_id uuid,
  p_expected_version integer, p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; request_row public.portal_purchase_request;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into request_row from public.portal_purchase_request where id = p_request_id for update;
  if request_row.id is null then raise exception 'Purchase request not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Purchase request changed'; end if;
  if request_row.status not in ('submitted','under_review','returned') then
    raise exception 'Purchase request is not awaiting business approval';
  end if;
  if p_decision not in ('approved','returned','denied') then
    raise exception 'Invalid business approval decision';
  end if;
  if length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Business decision evidence required'; end if;
  if request_row.requester_id = p_actor_id then raise exception 'You cannot approve your own purchase request'; end if;
  if not exists (
    select 1 from public.portal_purchase_approver a
    where a.approval_tier = request_row.approval_tier and a.active
      and a.approver_email = lower(btrim(coalesce(p_actor_email,'')))
  ) then raise exception 'You are not an assigned business approver for this request'; end if;
  update public.portal_purchase_request set
    business_approval_status = p_decision,
    business_approver_id = p_actor_id,
    business_approver_email = lower(btrim(p_actor_email)),
    business_approval_note = btrim(p_note), business_decided_at = now(),
    status = case when p_decision = 'approved' then 'under_review' else p_decision end
  where id = p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'under_review', p_actor_id, lower(btrim(p_actor_email)),
    'Business decision ' || p_decision || ': ' || btrim(p_note));
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_business_' || p_decision, request_row.id,
    jsonb_build_object('reference',request_row.reference,'approvalTier',request_row.approval_tier,
      'actorEmail',lower(btrim(p_actor_email)),'evidence',btrim(p_note)));
  return request_row;
end;
$$;

create or replace function public.portal_decide_purchase_request(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; request_row public.portal_purchase_request;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal' and staff_role = 'administrator';
  if actor_row.id is null then raise exception 'Administrator access required'; end if;
  select * into request_row from public.portal_purchase_request where id = p_request_id for update;
  if request_row.id is null then raise exception 'Purchase request not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Purchase request changed'; end if;
  if request_row.status not in ('submitted','under_review','returned','approved') then
    raise exception 'Purchase request is not reviewable'; end if;
  if p_decision not in ('under_review','returned','approved','denied','completed') then
    raise exception 'Invalid purchase request decision'; end if;
  if p_decision in ('returned','approved','denied','completed')
    and length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Decision evidence required'; end if;
  if p_decision = 'approved' and request_row.requester_id = p_actor_id then
    raise exception 'You cannot approve your own purchase request'; end if;
  if p_decision = 'approved' and request_row.business_approval_status <> 'approved' then
    raise exception 'Required business approval has not been recorded'; end if;
  if p_decision = 'completed' and request_row.status <> 'approved' then
    raise exception 'Only an approved purchase request can be completed'; end if;
  update public.portal_purchase_request set status = p_decision,
    reviewer_id = p_actor_id, reviewer_email = nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    decision_note = nullif(btrim(coalesce(p_note,'')), ''),
    ordered_at = case when p_decision = 'completed' then coalesce(ordered_at,now()) else ordered_at end
  where id = p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, p_decision, p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''), nullif(btrim(coalesce(p_note,'')), ''));
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_' || p_decision, request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'approvalAuthority', request_row.approval_authority, 'evidence', request_row.decision_note,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

revoke all on function public.portal_submit_purchase_request_v2(uuid,text,text,text,text,text,date,date,date,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function public.portal_submit_purchase_request_v2(uuid,text,text,text,text,text,date,date,date,boolean,text,jsonb) to service_role;
revoke all on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) to service_role;

comment on table public.portal_purchase_approver is
  'Named business approval authorities. Email assignments activate only for an active Internal profile and never grant broader portal access.';
comment on table public.portal_purchase_request_line is
  'Purchase request line items patterned after the retained Monday supply-order form. Header amount is calculated from these lines.';

update public.portal_notification_template set
  text_template = E'Hello {{recipientName}},\n\n{{requestReference}} for {{vendorName}} totals {{amount}} and requires {{approvalAuthority}} as the business authority. Assigned business approvers record the business decision; Administrators retain queue processing and final workflow control.\n\nOpen My Work: {{portalUrl}}',
  version = version + 1,
  updated_at = now()
where template_key = 'purchase_request_approval_required';
