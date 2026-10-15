-- Portal-native Supply Orders. Monday history remains read-only and is not mutated.

alter table public.portal_purchase_request
  add column if not exists recipient_name text,
  add column if not exists delivery_location text,
  add column if not exists merchandise_subtotal numeric(12,2) not null default 0,
  add column if not exists estimated_shipping numeric(12,2) not null default 0,
  add column if not exists estimated_tax numeric(12,2) not null default 0,
  add column if not exists estimated_discount numeric(12,2) not null default 0,
  add column if not exists actual_order_total numeric(12,2),
  add column if not exists vendor_order_number text,
  add column if not exists expected_delivery_on date,
  add column if not exists ordered_by_id uuid references public.portal_profile(id) on delete set null,
  add column if not exists ordered_by_email text,
  add column if not exists ordering_note text;

update public.portal_purchase_request
set merchandise_subtotal = amount
where merchandise_subtotal = 0 and amount > 0;

alter table public.portal_purchase_request
  drop constraint if exists portal_purchase_request_status_check;
alter table public.portal_purchase_request
  add constraint portal_purchase_request_status_check check (status in (
    'submitted','under_review','returned','approved','awaiting_order','ordered',
    'partially_received','received','denied','completed','cancelled'
  ));
alter table public.portal_purchase_request
  drop constraint if exists portal_purchase_request_checkout_amounts_check;
alter table public.portal_purchase_request
  add constraint portal_purchase_request_checkout_amounts_check check (
    merchandise_subtotal >= 0 and estimated_shipping >= 0 and estimated_tax >= 0
    and estimated_discount >= 0 and estimated_discount <= merchandise_subtotal + estimated_shipping + estimated_tax
    and (actual_order_total is null or actual_order_total > 0)
  );

alter table public.portal_purchase_request_line
  add column if not exists selected_options text,
  add column if not exists substitution_policy text not null default 'contact_requester',
  add column if not exists image_url text,
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb;
alter table public.portal_purchase_request_line
  drop constraint if exists portal_purchase_request_line_substitution_policy_check;
alter table public.portal_purchase_request_line
  add constraint portal_purchase_request_line_substitution_policy_check check (
    substitution_policy in ('no_substitutions','comparable_within_approved_total','contact_requester')
  );

create table if not exists public.portal_supply_item_history (
  id uuid primary key default gen_random_uuid(),
  normalized_key text not null unique,
  vendor_name text not null,
  item_description text not null,
  sku text,
  purchase_url text,
  selected_options text,
  image_url text,
  expense_category text,
  expense_subcategory text,
  last_unit_cost numeric(12,2) not null check (last_unit_cost >= 0),
  order_count integer not null default 1 check (order_count > 0),
  last_ordered_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.portal_supply_item_history enable row level security;
revoke all on table public.portal_supply_item_history from public, anon, authenticated;
grant all on table public.portal_supply_item_history to service_role;

create or replace function public.portal_submit_purchase_request_v3(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_vendor_name text,
  p_purpose text, p_priority text, p_needed_by date, p_delivery_start_on date,
  p_delivery_end_on date, p_recurring_purchase boolean, p_payment_method text,
  p_recipient_name text, p_delivery_location text,
  p_estimated_shipping numeric, p_estimated_tax numeric, p_estimated_discount numeric,
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
  merchandise_total numeric(12,2) := 0;
  total_amount numeric(12,2) := 0;
  quantity_value numeric;
  unit_cost_value numeric;
  category_value text;
  shipping_value numeric(12,2) := round(coalesce(p_estimated_shipping,0),2);
  tax_value numeric(12,2) := round(coalesce(p_estimated_tax,0),2);
  discount_value numeric(12,2) := round(coalesce(p_estimated_discount,0),2);
  substitution_value text;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department
    where department_key = p_department_key and status = 'active';
  if department_row.department_key is null then raise exception 'Choose an active department'; end if;
  if length(btrim(coalesce(p_vendor_name,''))) < 2
    or length(btrim(coalesce(p_purpose,''))) < 12
    or length(btrim(coalesce(p_recipient_name,''))) < 2
    or length(btrim(coalesce(p_delivery_location,''))) < 4
    or p_priority not in ('low','normal','high','urgent')
    or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1
    or jsonb_array_length(p_lines) > 50 then
    raise exception 'Complete the supply order header and add at least one item';
  end if;
  if shipping_value < 0 or tax_value < 0 or discount_value < 0 then
    raise exception 'Shipping, tax, and discount values cannot be negative';
  end if;
  if p_delivery_start_on is not null and p_delivery_end_on is not null
    and p_delivery_end_on < p_delivery_start_on then
    raise exception 'Delivery end date cannot be before the start date';
  end if;
  for line_row in select value from jsonb_array_elements(p_lines) loop
    quantity_value := nullif(line_row->>'quantity','')::numeric;
    unit_cost_value := nullif(line_row->>'unitCost','')::numeric;
    category_value := lower(btrim(coalesce(line_row->>'expenseCategory','')));
    substitution_value := lower(btrim(coalesce(line_row->>'substitutionPolicy','contact_requester')));
    if length(btrim(coalesce(line_row->>'itemDescription',''))) < 2
      or quantity_value is null or quantity_value <= 0
      or unit_cost_value is null or unit_cost_value < 0
      or category_value not in ('supplies','services','inventory','equipment','travel','other')
      or substitution_value not in ('no_substitutions','comparable_within_approved_total','contact_requester')
      or (coalesce(line_row->>'purchaseUrl','') <> '' and line_row->>'purchaseUrl' !~ '^https://')
      or (coalesce(line_row->>'imageUrl','') <> '' and line_row->>'imageUrl' !~ '^https://') then
      raise exception 'Every supply-order line needs a valid item, quantity, price, category, substitution rule, and HTTPS links';
    end if;
    merchandise_total := merchandise_total + round(quantity_value * unit_cost_value, 2);
  end loop;
  total_amount := round(merchandise_total + shipping_value + tax_value - discount_value, 2);
  if total_amount <= 0 or total_amount > 9999999999.99 or discount_value > merchandise_total + shipping_value + tax_value then
    raise exception 'Calculated checkout total must be greater than zero';
  end if;
  if total_amount <= 500 then route_tier := 'eric_500'; route_authority := 'Eric Stewart';
  elsif total_amount < 3000 then route_tier := 'leadership_2999'; route_authority := 'Omeed / Jonathan / Drew';
  else route_tier := 'eran_3000'; route_authority := 'Eran Sherin'; end if;

  insert into public.portal_purchase_request (
    requester_id, requested_for_department_key, vendor_name, expense_category,
    purpose, amount, needed_by, approval_tier, approval_authority, priority,
    delivery_start_on, delivery_end_on, recurring_purchase, payment_method,
    recipient_name, delivery_location, merchandise_subtotal,
    estimated_shipping, estimated_tax, estimated_discount
  ) values (
    p_actor_id, p_department_key, btrim(p_vendor_name),
    lower(btrim(coalesce(p_lines->0->>'expenseCategory','other'))),
    btrim(p_purpose), total_amount, p_needed_by, route_tier, route_authority,
    p_priority, p_delivery_start_on, p_delivery_end_on,
    coalesce(p_recurring_purchase,false), nullif(btrim(coalesce(p_payment_method,'')), ''),
    btrim(p_recipient_name), btrim(p_delivery_location), merchandise_total,
    shipping_value, tax_value, discount_value
  ) returning * into request_row;

  for line_row in select value from jsonb_array_elements(p_lines) loop
    line_no := line_no + 1;
    insert into public.portal_purchase_request_line (
      purchase_request_id, line_number, item_description, sku, purchase_url,
      quantity, unit_cost, expense_category, expense_subcategory,
      chart_of_accounts, required_delivery_on, selected_options,
      substitution_policy, image_url, source_snapshot
    ) values (
      request_row.id, line_no, btrim(line_row->>'itemDescription'),
      nullif(btrim(coalesce(line_row->>'sku','')), ''),
      nullif(btrim(coalesce(line_row->>'purchaseUrl','')), ''),
      (line_row->>'quantity')::numeric, (line_row->>'unitCost')::numeric,
      lower(btrim(line_row->>'expenseCategory')),
      nullif(btrim(coalesce(line_row->>'expenseSubcategory','')), ''),
      nullif(btrim(coalesce(line_row->>'chartOfAccounts','')), ''),
      nullif(line_row->>'requiredDeliveryOn','')::date,
      nullif(btrim(coalesce(line_row->>'selectedOptions','')), ''),
      lower(btrim(coalesce(line_row->>'substitutionPolicy','contact_requester'))),
      nullif(btrim(coalesce(line_row->>'imageUrl','')), ''),
      jsonb_build_object(
        'itemDescription', btrim(line_row->>'itemDescription'),
        'sku', nullif(btrim(coalesce(line_row->>'sku','')), ''),
        'purchaseUrl', nullif(btrim(coalesce(line_row->>'purchaseUrl','')), ''),
        'selectedOptions', nullif(btrim(coalesce(line_row->>'selectedOptions','')), ''),
        'imageUrl', nullif(btrim(coalesce(line_row->>'imageUrl','')), ''),
        'quantity', (line_row->>'quantity')::numeric,
        'unitCost', (line_row->>'unitCost')::numeric,
        'capturedAt', now()
      )
    );
  end loop;

  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'submitted', p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    'Submitted through Supply Orders with ' || line_no || ' item(s) and a checkout total of ' || total_amount || '.');
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'supply_order_submitted', request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'merchandiseSubtotal', merchandise_total, 'shipping', shipping_value,
    'tax', tax_value, 'discount', discount_value, 'lineCount', line_no,
    'approvalTier', route_tier, 'approvalAuthority', route_authority,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

create or replace function public.portal_record_purchase_business_decision(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare current_version integer; current_status text; requester uuid; route_tier text;
  request_row public.portal_purchase_request;
begin
  if not exists (select 1 from public.portal_profile where id=p_actor_id and active and role='internal') then
    raise exception 'Active workforce account required';
  end if;
  select version,status,requester_id,approval_tier into current_version,current_status,requester,route_tier
  from public.portal_purchase_request where id=p_request_id for update;
  if current_version is null then raise exception 'Purchase request not found'; end if;
  if current_version <> p_expected_version then raise exception 'Purchase request changed'; end if;
  if current_status not in ('submitted','under_review','returned') then raise exception 'Purchase request is not awaiting business approval'; end if;
  if p_decision not in ('approved','returned','denied') then raise exception 'Invalid business approval decision'; end if;
  if length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Business decision evidence required'; end if;
  if requester = p_actor_id then raise exception 'You cannot approve your own purchase request'; end if;
  if not exists (select 1 from public.portal_purchase_approver where approval_tier=route_tier and active and approver_email=lower(btrim(coalesce(p_actor_email,'')))) then
    raise exception 'You are not an assigned business approver for this request';
  end if;
  update public.portal_purchase_request set
    business_approval_status=p_decision, business_approver_id=p_actor_id,
    business_approver_email=lower(btrim(p_actor_email)), business_approval_note=btrim(p_note),
    business_decided_at=now(), status=case when p_decision='approved' then 'awaiting_order' else p_decision end
  where id=p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision(purchase_request_id,decision,actor_id,actor_email,evidence_note)
  values(request_row.id,case when p_decision='approved' then 'awaiting_order' else p_decision end,p_actor_id,lower(btrim(p_actor_email)),'Business decision '||p_decision||': '||btrim(p_note));
  insert into public.portal_admin_audit(actor_id,action,target_id,detail)
  values(p_actor_id,'supply_order_business_'||p_decision,request_row.id,jsonb_build_object('reference',request_row.reference,'approvalTier',request_row.approval_tier,'actorEmail',lower(btrim(p_actor_email)),'evidence',btrim(p_note)));
  select * into request_row from public.portal_purchase_request where id=p_request_id;
  return request_row;
end;
$$;

create or replace function public.portal_mark_supply_order_ordered(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_actual_total numeric, p_vendor_order_number text, p_expected_delivery_on date, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare request_row public.portal_purchase_request; current_route text; actual_route text;
  reapproval_required boolean := false; allowed_variance numeric(12,2);
begin
  if not exists (select 1 from public.portal_profile where id=p_actor_id and active and role='internal'
    and (staff_role='administrator' or lower(btrim(coalesce(p_actor_email,'')))='amrit@urbanxtracts.com')) then
    raise exception 'Amrit or an Administrator must record ordering';
  end if;
  select * into request_row from public.portal_purchase_request where id=p_request_id for update;
  if request_row.id is null then raise exception 'Supply order not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Supply order changed'; end if;
  if request_row.status <> 'awaiting_order' or request_row.business_approval_status <> 'approved' then raise exception 'Supply order is not ready for ordering'; end if;
  if p_actual_total is null or p_actual_total <= 0 or length(btrim(coalesce(p_vendor_order_number,''))) < 2 or length(btrim(coalesce(p_note,''))) < 8 then
    raise exception 'Enter the checkout total, vendor order number, expected delivery date, and ordering evidence';
  end if;
  current_route := request_row.approval_tier;
  actual_route := case when p_actual_total <= 500 then 'eric_500' when p_actual_total < 3000 then 'leadership_2999' else 'eran_3000' end;
  allowed_variance := least(50::numeric, round(request_row.amount * .10,2));
  reapproval_required := actual_route <> current_route or p_actual_total > request_row.amount + allowed_variance;
  update public.portal_purchase_request set
    actual_order_total=round(p_actual_total,2), vendor_order_number=nullif(btrim(p_vendor_order_number),''),
    expected_delivery_on=p_expected_delivery_on, ordering_note=btrim(p_note),
    ordered_by_id=case when reapproval_required then ordered_by_id else p_actor_id end,
    ordered_by_email=case when reapproval_required then ordered_by_email else lower(btrim(p_actor_email)) end,
    ordered_at=case when reapproval_required then ordered_at else now() end,
    status=case when reapproval_required then 'returned' else 'ordered' end,
    business_approval_status=case when reapproval_required then 'returned' else business_approval_status end,
    decision_note=case when reapproval_required then 'Checkout total requires renewed approval: '||btrim(p_note) else btrim(p_note) end
  where id=p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision(purchase_request_id,decision,actor_id,actor_email,evidence_note)
  values(request_row.id,case when reapproval_required then 'returned' else 'ordered' end,p_actor_id,lower(btrim(p_actor_email)),
    case when reapproval_required then 'Returned because the checkout total exceeded the approved tolerance or crossed an approval tier. ' else 'Ordered. ' end||btrim(p_note));
  insert into public.portal_admin_audit(actor_id,action,target_id,detail)
  values(p_actor_id,case when reapproval_required then 'supply_order_reapproval_required' else 'supply_order_ordered' end,request_row.id,
    jsonb_build_object('reference',request_row.reference,'approvedTotal',request_row.amount,'actualTotal',round(p_actual_total,2),'vendorOrderNumber',btrim(p_vendor_order_number),'actorEmail',lower(btrim(p_actor_email))));
  if not reapproval_required then
    insert into public.portal_supply_item_history(normalized_key,vendor_name,item_description,sku,purchase_url,selected_options,image_url,expense_category,expense_subcategory,last_unit_cost,order_count,last_ordered_at,updated_at)
    select encode(digest(lower(btrim(request_row.vendor_name))||'|'||lower(btrim(line.item_description))||'|'||coalesce(lower(btrim(line.sku)),''),'sha256'),'hex'),
      request_row.vendor_name,line.item_description,line.sku,line.purchase_url,line.selected_options,line.image_url,line.expense_category,line.expense_subcategory,line.unit_cost,1,now(),now()
    from public.portal_purchase_request_line line where line.purchase_request_id=request_row.id
    on conflict(normalized_key) do update set last_unit_cost=excluded.last_unit_cost,purchase_url=excluded.purchase_url,
      selected_options=excluded.selected_options,image_url=excluded.image_url,order_count=public.portal_supply_item_history.order_count+1,last_ordered_at=now(),updated_at=now(),active=true;
  end if;
  select * into request_row from public.portal_purchase_request where id=p_request_id;
  return request_row;
end;
$$;

revoke all on function public.portal_submit_purchase_request_v3(uuid,text,text,text,text,text,date,date,date,boolean,text,text,text,numeric,numeric,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.portal_submit_purchase_request_v3(uuid,text,text,text,text,text,date,date,date,boolean,text,text,text,numeric,numeric,numeric,jsonb) to service_role;
revoke all on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) to service_role;
revoke all on function public.portal_mark_supply_order_ordered(uuid,text,uuid,integer,numeric,text,date,text) from public,anon,authenticated;
grant execute on function public.portal_mark_supply_order_ordered(uuid,text,uuid,integer,numeric,text,date,text) to service_role;

insert into public.portal_notification_template(template_key,title,audience,category,mandatory,default_channels,subject_template,text_template,allowed_variables,approval_state,version)
values
('purchase_request_ready_to_order','Supply order ready to place','internal','account',true,array['in_portal','email'],
 'Ready to order: {{requestReference}}',E'Hello {{recipientName}},\n\n{{requestReference}} for {{vendorName}} was approved for {{amount}} and is ready for you to place. Record the vendor order number, actual checkout total, expected delivery date, and evidence in Supply Orders.\n\nOpen Supply Orders: {{portalUrl}}',
 array['recipientName','requestReference','vendorName','amount','portalUrl'],'approved',1),
('purchase_request_ordered','Supply order placed','internal','account',true,array['in_portal','email'],
 'Ordered: {{requestReference}}',E'Hello {{recipientName}},\n\n{{requestReference}} was ordered from {{vendorName}}. Vendor order: {{vendorOrderNumber}}. Actual total: {{actualTotal}}. Expected delivery: {{expectedDelivery}}.\n\nOpen Supply Orders: {{portalUrl}}',
 array['recipientName','requestReference','vendorName','vendorOrderNumber','actualTotal','expectedDelivery','portalUrl'],'approved',1),
('purchase_request_reapproval_required','Supply order needs renewed approval','internal','account',true,array['in_portal','email'],
 'Renewed approval required: {{requestReference}}',E'Hello {{recipientName}},\n\nThe checkout total for {{requestReference}} changed from {{approvedTotal}} to {{actualTotal}} and exceeds the approved tolerance or crosses an approval tier. The request was returned for a new decision.\n\nOpen Supply Orders: {{portalUrl}}',
 array['recipientName','requestReference','approvedTotal','actualTotal','portalUrl'],'approved',1)
on conflict(template_key) do update set
 title=excluded.title,audience=excluded.audience,category=excluded.category,mandatory=excluded.mandatory,
 default_channels=excluded.default_channels,subject_template=excluded.subject_template,text_template=excluded.text_template,
 allowed_variables=excluded.allowed_variables,approval_state='approved',version=public.portal_notification_template.version+1,updated_at=now();

comment on table public.portal_supply_item_history is
  'Reusable, server-only item history created from successfully ordered Supply Orders. No unit-of-measure field is used.';
