-- Follow-up for the production database: these stricter account/store controls
-- were finalized after the base onboarding migration had already been applied.

create or replace function public.portal_set_retailer_status(
  p_account_id uuid,
  p_status text,
  p_note text,
  p_actor_id uuid,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account public.portal_retailer_account%rowtype;
  customer_active boolean;
  ready_store_count integer;
begin
  if p_status not in (
    'not_qualified', 'qualification', 'terms_pending', 'setup_pending',
    'ready_to_order', 'ordering_paused', 'inactive', 'rejected'
  ) then raise exception 'Unsupported retailer status'; end if;

  select * into account
  from public.portal_retailer_account
  where id = p_account_id
  for update;
  if not found then raise exception 'Retailer account not found'; end if;

  if p_status = 'ready_to_order' then
    select coalesce(customer.active, true) into customer_active
    from public.quickbooks_customer_cache as customer
    where customer.quickbooks_customer_id = account.quickbooks_customer_id;
    if account.quickbooks_customer_id is null or coalesce(customer_active, false) is not true then
      raise exception 'An active QuickBooks customer is required before the retailer can order';
    end if;
    select count(*) into ready_store_count
    from public.portal_store
    where retailer_account_id = account.id
      and active = true
      and license_status = 'active'
      and ordering_status = 'ready'
      and quickbooks_customer_id is not null
      and license_expires_on > current_date;
    if ready_store_count < 1 then
      raise exception 'At least one current, QuickBooks-mapped store must be ready before the account can order';
    end if;
  end if;

  update public.portal_retailer_account
  set portal_status = p_status,
      status_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_by = p_actor_id,
      updated_at = now()
  where id = account.id;

  update public.quickbooks_customer_link
  set portal_status = upper(replace(p_status, '_', ' ')),
      updated_at = now()
  where retailer_account_id = account.id;

  insert into public.portal_retailer_event (
    retailer_account_id, event_type, actor_id, actor_email,
    from_value, to_value, note
  ) values (
    account.id, 'account_status_changed', p_actor_id,
    nullif(trim(coalesce(p_actor_email, '')), ''), account.portal_status,
    p_status, nullif(trim(coalesce(p_note, '')), '')
  );

  return jsonb_build_object('id', account.id, 'portalStatus', p_status);
end;
$$;

create or replace function public.portal_set_retailer_store_details(
  p_account_id uuid,
  p_license_number text,
  p_quickbooks_customer_id text,
  p_license_expires_on date,
  p_actor_id uuid,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account public.portal_retailer_account%rowtype;
  store public.portal_store%rowtype;
  accounting_customer public.quickbooks_customer_cache%rowtype;
  normalized_customer_id text := nullif(trim(coalesce(p_quickbooks_customer_id, '')), '');
begin
  select * into account
  from public.portal_retailer_account
  where id = p_account_id
  for update;
  if not found then raise exception 'Retailer account not found'; end if;
  if account.quickbooks_customer_id is null then
    raise exception 'Link the retailer account to QuickBooks before mapping a store';
  end if;
  if normalized_customer_id is null then
    raise exception 'Choose a QuickBooks customer for this store';
  end if;

  select * into accounting_customer
  from public.quickbooks_customer_cache
  where quickbooks_customer_id = normalized_customer_id;
  if not found then raise exception 'Store QuickBooks customer not found'; end if;
  if accounting_customer.quickbooks_customer_id <> account.quickbooks_customer_id
    and accounting_customer.parent_customer_id is distinct from account.quickbooks_customer_id then
    raise exception 'Store QuickBooks customer must be the retailer account or its direct child';
  end if;
  if p_license_expires_on is null or p_license_expires_on <= current_date then
    raise exception 'A current license expiration date is required before qualification';
  end if;

  select * into store
  from public.portal_store
  where retailer_account_id = account.id
    and license_number = upper(trim(p_license_number))
  for update;
  if not found then raise exception 'Retailer store not found'; end if;

  update public.portal_store
  set quickbooks_customer_id = accounting_customer.quickbooks_customer_id,
      license_expires_on = p_license_expires_on,
      updated_at = now()
  where license_number = store.license_number;

  insert into public.portal_retailer_event (
    retailer_account_id, store_license, event_type, actor_id,
    actor_email, from_value, to_value, note
  ) values (
    account.id, store.license_number, 'store_source_evidence_changed', p_actor_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    coalesce(store.quickbooks_customer_id, 'unmapped') || '/' || coalesce(store.license_expires_on::text, 'no-expiration'),
    accounting_customer.quickbooks_customer_id || '/' || p_license_expires_on::text,
    'Explicit QuickBooks identity and license expiration recorded.'
  );

  return jsonb_build_object(
    'accountId', account.id,
    'licenseNumber', store.license_number,
    'quickbooksCustomerId', accounting_customer.quickbooks_customer_id,
    'licenseExpiresOn', p_license_expires_on
  );
end;
$$;

create or replace function public.portal_set_retailer_store_status(
  p_account_id uuid,
  p_license_number text,
  p_license_status text,
  p_ordering_status text,
  p_hold_reason text,
  p_license_expires_on date,
  p_actor_id uuid,
  p_actor_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  store public.portal_store%rowtype;
  normalized_ordering_status text;
begin
  if p_license_status not in ('pending_qualification', 'active', 'expired', 'suspended', 'rejected') then
    raise exception 'Unsupported license status';
  end if;
  if p_ordering_status not in ('pending', 'ready', 'paused') then
    raise exception 'Unsupported ordering status';
  end if;
  normalized_ordering_status := p_ordering_status;
  if p_license_status <> 'active' and normalized_ordering_status = 'ready' then
    raise exception 'Ordering cannot be ready until the license is active';
  end if;

  select * into store
  from public.portal_store
  where retailer_account_id = p_account_id
    and license_number = upper(trim(p_license_number))
  for update;
  if not found then raise exception 'Retailer store not found'; end if;
  if p_license_status = 'active' and store.quickbooks_customer_id is null then
    raise exception 'Store QuickBooks customer is required before qualification';
  end if;
  if p_license_status = 'active' and (
    coalesce(p_license_expires_on, store.license_expires_on) is null
    or coalesce(p_license_expires_on, store.license_expires_on) <= current_date
  ) then
    raise exception 'A current license expiration date is required before qualification';
  end if;

  update public.portal_store
  set license_status = p_license_status,
      ordering_status = normalized_ordering_status,
      ordering_hold_reason = nullif(trim(coalesce(p_hold_reason, '')), ''),
      license_expires_on = coalesce(p_license_expires_on, license_expires_on),
      qualified_by = case when p_license_status = 'active' then p_actor_id else qualified_by end,
      qualified_at = case when p_license_status = 'active' then coalesce(qualified_at, now()) else qualified_at end,
      active = p_license_status <> 'rejected',
      updated_at = now()
  where license_number = store.license_number;

  insert into public.portal_retailer_event (
    retailer_account_id, store_license, event_type, actor_id,
    actor_email, from_value, to_value, note
  ) values (
    p_account_id, store.license_number, 'store_status_changed', p_actor_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    store.license_status || '/' || store.ordering_status,
    p_license_status || '/' || normalized_ordering_status,
    nullif(trim(coalesce(p_hold_reason, '')), '')
  );

  return jsonb_build_object(
    'accountId', p_account_id,
    'licenseNumber', store.license_number,
    'licenseStatus', p_license_status,
    'orderingStatus', normalized_ordering_status,
    'licenseExpiresOn', coalesce(p_license_expires_on, store.license_expires_on)
  );
end;
$$;

revoke all on function public.portal_set_retailer_status(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_set_retailer_status(uuid, text, text, uuid, text)
  to service_role;
revoke all on function public.portal_set_retailer_store_details(uuid, text, text, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_set_retailer_store_details(uuid, text, text, date, uuid, text)
  to service_role;
revoke all on function public.portal_set_retailer_store_status(uuid, text, text, text, text, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_set_retailer_store_status(uuid, text, text, text, text, date, uuid, text)
  to service_role;
