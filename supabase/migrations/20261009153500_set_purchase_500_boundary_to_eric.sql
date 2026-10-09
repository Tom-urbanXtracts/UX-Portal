create or replace function public.portal_submit_purchase_request(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_vendor_name text,
  p_expense_category text, p_purpose text, p_amount numeric, p_needed_by date
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; department_row public.portal_department;
  request_row public.portal_purchase_request; route_tier text; route_authority text;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department where department_key = p_department_key and status = 'active';
  if department_row.department_key is null then raise exception 'Choose an active department'; end if;
  if length(btrim(coalesce(p_vendor_name,''))) < 2 or length(btrim(coalesce(p_purpose,''))) < 12
    or p_expense_category not in ('supplies','services','inventory','equipment','travel','other')
    or p_amount is null or p_amount <= 0 then raise exception 'Complete the purchase request'; end if;
  if p_amount <= 500 then route_tier := 'eric_500'; route_authority := 'Eric Stewart';
  elsif p_amount <= 3000 then route_tier := 'leadership_2999'; route_authority := 'Omeed, Drew or Jonathan';
  else route_tier := 'eran_3000'; route_authority := 'Eran'; end if;
  insert into public.portal_purchase_request (
    requester_id, requested_for_department_key, vendor_name, expense_category,
    purpose, amount, needed_by, approval_tier, approval_authority
  ) values (
    p_actor_id, p_department_key, btrim(p_vendor_name), p_expense_category,
    btrim(p_purpose), round(p_amount, 2), p_needed_by, route_tier, route_authority
  ) returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'submitted', p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''), 'Submitted through the Internal portal.');
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_submitted', request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'approvalTier', route_tier, 'approvalAuthority', route_authority,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

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
  elsif total_amount <= 3000 then route_tier := 'leadership_2999'; route_authority := 'Omeed, Drew or Jonathan';
  else route_tier := 'eran_3000'; route_authority := 'Eran'; end if;

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
