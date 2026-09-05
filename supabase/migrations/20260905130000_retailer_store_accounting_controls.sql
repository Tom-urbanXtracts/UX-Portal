-- Bind every onboarded store to an explicit, compatible QuickBooks customer
-- identity and retain the license-expiration evidence used at qualification.

alter table public.portal_onboarding_store
  add column if not exists quickbooks_customer_id text
    references public.quickbooks_customer_cache(quickbooks_customer_id) on delete set null,
  add column if not exists license_expires_on date;

create index if not exists portal_onboarding_store_qbo_idx
  on public.portal_onboarding_store (quickbooks_customer_id)
  where quickbooks_customer_id is not null;

comment on column public.portal_onboarding_store.quickbooks_customer_id is
  'Explicit QuickBooks customer or direct child-customer selected by staff for this store; never inferred by name.';
comment on column public.portal_onboarding_store.license_expires_on is
  'Expiration date observed during the internal license qualification review.';

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

create or replace function public.portal_add_retailer_store(
  p_account_id uuid,
  p_license_number text,
  p_display_name text,
  p_address text,
  p_quickbooks_customer_id text,
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
  accounting_customer public.quickbooks_customer_cache%rowtype;
  existing_store public.portal_store%rowtype;
  store_count integer;
  normalized_license text;
  normalized_customer_id text;
  store_created boolean := false;
begin
  normalized_license := upper(trim(p_license_number));
  normalized_customer_id := nullif(trim(coalesce(p_quickbooks_customer_id, '')), '');
  if normalized_license = '' or trim(coalesce(p_display_name, '')) = '' then
    raise exception 'Store name and license number are required';
  end if;

  select * into account
  from public.portal_retailer_account
  where id = p_account_id
  for update;
  if not found then raise exception 'Retailer account not found'; end if;

  if normalized_customer_id is not null then
    select * into accounting_customer
    from public.quickbooks_customer_cache
    where quickbooks_customer_id = normalized_customer_id;
    if not found then raise exception 'Store QuickBooks customer not found'; end if;
    if account.quickbooks_customer_id is null then
      raise exception 'Link the retailer account to QuickBooks before mapping a store';
    end if;
    if accounting_customer.quickbooks_customer_id <> account.quickbooks_customer_id
      and accounting_customer.parent_customer_id is distinct from account.quickbooks_customer_id then
      raise exception 'Store QuickBooks customer must be the retailer account or its direct child';
    end if;
  end if;

  select * into existing_store
  from public.portal_store
  where license_number = normalized_license
  for update;
  if found and existing_store.retailer_account_id is distinct from account.id then
    raise exception 'That license is already attached to another retailer account';
  end if;
  if not found then
    if normalized_customer_id is null then
      raise exception 'Choose a QuickBooks customer for this store';
    end if;
    select count(*) into store_count
    from public.portal_store
    where retailer_account_id = account.id and closed_at is null;
    if store_count >= 10 then raise exception 'A retailer account may contain no more than ten stores'; end if;
    insert into public.portal_store (
      license_number, organization, display_name, active,
      retailer_account_id, quickbooks_customer_id, address,
      license_status, ordering_status, updated_at
    ) values (
      normalized_license, account.organization_name, trim(p_display_name), true,
      account.id, normalized_customer_id,
      nullif(trim(coalesce(p_address, '')), ''),
      'pending_qualification', 'pending', now()
    );
    store_created := true;
  else
    update public.portal_store
    set display_name = trim(p_display_name),
        address = nullif(trim(coalesce(p_address, '')), ''),
        quickbooks_customer_id = coalesce(
          normalized_customer_id,
          existing_store.quickbooks_customer_id
        ),
        updated_at = now()
    where license_number = normalized_license;
  end if;

  update public.quickbooks_customer_link
  set location_count = (
        select count(*) from public.portal_store
        where retailer_account_id = account.id and closed_at is null
      ),
      updated_at = now()
  where retailer_account_id = account.id;

  insert into public.portal_retailer_event (
    retailer_account_id, store_license, event_type, actor_id,
    actor_email, to_value, note
  ) values (
    account.id, normalized_license,
    case when store_created then 'store_added' else 'note_changed' end,
    p_actor_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    case when store_created then 'pending_qualification' else 'store_details_updated' end,
    case when store_created
      then 'Store added; license qualification and ordering readiness remain pending.'
      else 'Store name, address, or QuickBooks child-customer link updated.'
    end
  );

  return jsonb_build_object(
    'accountId', account.id,
    'licenseNumber', normalized_license,
    'quickbooksCustomerId', normalized_customer_id,
    'created', store_created
  );
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

create or replace function public.portal_set_onboarding_store_details(
  p_request_id uuid,
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
  onboarding public.portal_onboarding_request%rowtype;
  account public.portal_retailer_account%rowtype;
  accounting_customer public.quickbooks_customer_cache%rowtype;
  onboarding_store public.portal_onboarding_store%rowtype;
  normalized_license text := upper(trim(p_license_number));
  normalized_customer_id text := nullif(trim(coalesce(p_quickbooks_customer_id, '')), '');
begin
  select * into onboarding
  from public.portal_onboarding_request
  where id = p_request_id
  for update;
  if not found then raise exception 'Onboarding request not found'; end if;
  if onboarding.workflow_state <> 'accepted' then
    raise exception 'Monday must accept the onboarding request before store setup';
  end if;
  if onboarding.stage not in ('qualification', 'terms', 'account_creation') then
    raise exception 'Store accounting setup is closed after access creation';
  end if;
  if onboarding.retailer_account_id is null then
    raise exception 'Link a QuickBooks-backed retailer account before store setup';
  end if;

  select * into account
  from public.portal_retailer_account
  where id = onboarding.retailer_account_id;
  if not found or account.quickbooks_customer_id is null then
    raise exception 'The linked retailer account is not ready for store setup';
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

  select * into onboarding_store
  from public.portal_onboarding_store
  where onboarding_request_id = onboarding.id
    and license_number = normalized_license
  for update;
  if not found then raise exception 'Onboarding store not found'; end if;

  update public.portal_onboarding_store
  set quickbooks_customer_id = accounting_customer.quickbooks_customer_id,
      license_expires_on = p_license_expires_on
  where id = onboarding_store.id;

  insert into public.portal_onboarding_event (
    onboarding_request_id, source, from_stage, to_stage,
    actor_id, actor_email, note, metadata
  ) values (
    onboarding.id, 'internal', onboarding.stage, onboarding.stage,
    p_actor_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    'Store QuickBooks identity and license expiration recorded.',
    jsonb_build_object(
      'licenseNumber', onboarding_store.license_number,
      'quickbooksCustomerId', accounting_customer.quickbooks_customer_id,
      'licenseExpiresOn', p_license_expires_on
    )
  );

  return jsonb_build_object(
    'id', onboarding.id,
    'licenseNumber', onboarding_store.license_number,
    'quickbooksCustomerId', accounting_customer.quickbooks_customer_id,
    'licenseExpiresOn', p_license_expires_on,
    'stage', onboarding.stage
  );
end;
$$;

create or replace function public.portal_set_onboarding_store_qualification(
  p_request_id uuid,
  p_license_number text,
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
  onboarding public.portal_onboarding_request%rowtype;
  onboarding_store public.portal_onboarding_store%rowtype;
  normalized_license text;
begin
  if p_status not in ('pending', 'qualified', 'rejected') then
    raise exception 'Unsupported onboarding store qualification status';
  end if;
  if p_status in ('qualified', 'rejected') and trim(coalesce(p_note, '')) = '' then
    raise exception 'A license review note is required';
  end if;
  normalized_license := upper(trim(p_license_number));

  select * into onboarding
  from public.portal_onboarding_request
  where id = p_request_id
  for update;
  if not found then raise exception 'Onboarding request not found'; end if;
  if onboarding.workflow_state <> 'accepted' then
    raise exception 'Monday must accept the onboarding request before license review';
  end if;
  if onboarding.stage <> 'qualification' then
    raise exception 'License review is available only during the qualification stage';
  end if;

  select * into onboarding_store
  from public.portal_onboarding_store
  where onboarding_request_id = onboarding.id
    and license_number = normalized_license
  for update;
  if not found then raise exception 'Onboarding store not found'; end if;
  if p_status = 'qualified' and (
    onboarding_store.quickbooks_customer_id is null
    or onboarding_store.license_expires_on is null
    or onboarding_store.license_expires_on <= current_date
  ) then
    raise exception 'Record the store QuickBooks customer and current license expiration before qualification';
  end if;

  update public.portal_onboarding_store
  set qualification_status = p_status,
      qualification_note = nullif(trim(coalesce(p_note, '')), '')
  where id = onboarding_store.id;
  update public.portal_onboarding_request set updated_at = now() where id = onboarding.id;

  insert into public.portal_onboarding_event (
    onboarding_request_id, source, from_stage, to_stage,
    actor_id, actor_email, note, metadata
  ) values (
    onboarding.id, 'internal', onboarding.stage, onboarding.stage,
    p_actor_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    nullif(trim(coalesce(p_note, '')), ''),
    jsonb_build_object(
      'licenseNumber', onboarding_store.license_number,
      'storeName', onboarding_store.store_name,
      'fromQualificationStatus', onboarding_store.qualification_status,
      'toQualificationStatus', p_status,
      'licenseExpiresOn', onboarding_store.license_expires_on
    )
  );

  return jsonb_build_object(
    'id', onboarding.id,
    'licenseNumber', onboarding_store.license_number,
    'qualificationStatus', p_status,
    'stage', onboarding.stage
  );
end;
$$;

create or replace function public.portal_advance_onboarding_request(
  p_request_id uuid,
  p_target_stage text,
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
  onboarding public.portal_onboarding_request%rowtype;
  account public.portal_retailer_account%rowtype;
  store_record record;
  portal_store_record public.portal_store%rowtype;
  stages text[] := array['intake', 'qualification', 'terms', 'account_creation', 'access', 'ready'];
  current_position integer;
  target_position integer;
  pending_store_count integer;
  qualified_store_count integer;
  missing_store_count integer;
  incomplete_store_count integer;
  owner_count integer;
  pending_person_count integer;
begin
  if p_target_stage not in ('qualification', 'terms', 'account_creation', 'access', 'ready', 'rejected', 'closed') then
    raise exception 'Unsupported onboarding stage';
  end if;

  select * into onboarding
  from public.portal_onboarding_request
  where id = p_request_id
  for update;
  if not found then raise exception 'Onboarding request not found'; end if;
  if onboarding.stage in ('ready', 'rejected', 'closed') then
    raise exception 'The onboarding request is already complete';
  end if;
  if onboarding.workflow_state <> 'accepted' then
    raise exception 'Monday must accept the onboarding request before it can advance';
  end if;

  if p_target_stage = 'rejected' then
    if trim(coalesce(p_note, '')) = '' then raise exception 'A rejection note is required'; end if;
    update public.portal_onboarding_request
    set stage = 'rejected', workflow_state = 'rejected', updated_at = now()
    where id = onboarding.id;
  elsif p_target_stage = 'closed' then
    raise exception 'Open onboarding requests may be rejected; completed requests close through retention policy';
  else
    current_position := array_position(stages, onboarding.stage);
    target_position := array_position(stages, p_target_stage);
    if current_position is null or target_position <> current_position + 1 then
      raise exception 'Onboarding stages must advance one step at a time';
    end if;

    if p_target_stage = 'terms' then
      select
        count(*) filter (where qualification_status = 'pending'),
        count(*) filter (where qualification_status = 'qualified')
      into pending_store_count, qualified_store_count
      from public.portal_onboarding_store
      where onboarding_request_id = onboarding.id;
      if pending_store_count > 0 then raise exception 'Every store license must be reviewed before commercial terms'; end if;
      if qualified_store_count < 1 then raise exception 'At least one store license must qualify before commercial terms'; end if;
    end if;
    if p_target_stage = 'account_creation' and trim(coalesce(p_note, '')) = '' then
      raise exception 'A commercial terms decision note is required before account creation';
    end if;

    if p_target_stage in ('access', 'ready') then
      if onboarding.retailer_account_id is null then
        raise exception 'Link a QuickBooks-backed retailer account before access setup';
      end if;
      select * into account
      from public.portal_retailer_account
      where id = onboarding.retailer_account_id
      for update;
      if not found or account.quickbooks_customer_id is null then
        raise exception 'The linked retailer account is not ready for access setup';
      end if;
    end if;

    if p_target_stage = 'access' then
      select count(*) into incomplete_store_count
      from public.portal_onboarding_store
      where onboarding_request_id = onboarding.id
        and qualification_status = 'qualified'
        and (
          quickbooks_customer_id is null
          or license_expires_on is null
          or license_expires_on <= current_date
        );
      if incomplete_store_count > 0 then
        raise exception 'Every qualified store needs a compatible QuickBooks customer and current license expiration before access setup';
      end if;
      for store_record in
        select * from public.portal_onboarding_store
        where onboarding_request_id = onboarding.id
          and qualification_status = 'qualified'
        order by store_number
      loop
        perform public.portal_add_retailer_store(
          account.id, store_record.license_number, store_record.store_name,
          store_record.address, store_record.quickbooks_customer_id,
          p_actor_id, p_actor_email
        );
        select * into portal_store_record
        from public.portal_store
        where license_number = store_record.license_number;
        if portal_store_record.license_status <> 'active' then
          perform public.portal_set_retailer_store_status(
            account.id, store_record.license_number, 'active', 'pending',
            'Qualified through onboarding; ordering remains pending until explicitly enabled.',
            store_record.license_expires_on, p_actor_id, p_actor_email
          );
        end if;
      end loop;
    end if;

    if p_target_stage = 'ready' then
      if account.portal_status <> 'ready_to_order' then
        raise exception 'Set the linked retailer account to ready to order before completing onboarding';
      end if;
      select count(*) into missing_store_count
      from public.portal_onboarding_store as onboarding_location
      left join public.portal_store as portal_location
        on portal_location.license_number = onboarding_location.license_number
       and portal_location.retailer_account_id = account.id
       and portal_location.active = true
       and portal_location.license_status = 'active'
       and portal_location.license_expires_on > current_date
      where onboarding_location.onboarding_request_id = onboarding.id
        and onboarding_location.qualification_status = 'qualified'
        and portal_location.license_number is null;
      if missing_store_count > 0 then
        raise exception 'Every qualified license must exist as a current active portal store before completion';
      end if;
      select count(*) into pending_person_count
      from public.portal_onboarding_person
      where onboarding_request_id = onboarding.id
        and access_status not in ('invited', 'active');
      if pending_person_count > 0 then
        raise exception 'Every requested user must be invited or resolved before onboarding can complete';
      end if;
      select count(*) into owner_count
      from public.portal_profile
      where role = 'owner' and active = true and org = account.organization_name;
      if owner_count < 1 then
        raise exception 'At least one active Store Owner is required before onboarding can complete';
      end if;
    end if;

    update public.portal_onboarding_request
    set stage = p_target_stage, updated_at = now()
    where id = onboarding.id;
  end if;

  insert into public.portal_onboarding_event (
    onboarding_request_id, source, from_stage, to_stage,
    actor_id, actor_email, note
  ) values (
    onboarding.id, 'internal', onboarding.stage, p_target_stage,
    p_actor_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    nullif(trim(coalesce(p_note, '')), '')
  );

  return jsonb_build_object(
    'id', onboarding.id,
    'stage', p_target_stage,
    'retailerAccountId', onboarding.retailer_account_id
  );
end;
$$;

revoke all on function public.portal_set_onboarding_store_details(uuid, text, text, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_set_onboarding_store_details(uuid, text, text, date, uuid, text)
  to service_role;
revoke all on function public.portal_set_retailer_store_details(uuid, text, text, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_set_retailer_store_details(uuid, text, text, date, uuid, text)
  to service_role;
