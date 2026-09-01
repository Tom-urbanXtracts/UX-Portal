-- Durable retailer accounts and multi-store onboarding. QuickBooks owns the
-- accounting customer identity and balance; the portal owns qualification,
-- licensed-store readiness, access scope, and ordering gates.

create table if not exists public.portal_retailer_account (
  id uuid primary key default gen_random_uuid(),
  quickbooks_customer_id text unique references public.quickbooks_customer_cache(quickbooks_customer_id) on delete set null,
  organization_name text not null unique,
  display_name text not null,
  portal_status text not null default 'not_qualified' check (portal_status in (
    'not_qualified', 'qualification', 'terms_pending', 'setup_pending',
    'ready_to_order', 'ordering_paused', 'inactive', 'rejected'
  )),
  status_note text,
  account_owner_email text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portal_retailer_account_status_idx
  on public.portal_retailer_account (portal_status, updated_at desc);

alter table public.portal_store
  add column if not exists retailer_account_id uuid references public.portal_retailer_account(id),
  add column if not exists quickbooks_customer_id text references public.quickbooks_customer_cache(quickbooks_customer_id) on delete set null,
  add column if not exists address text,
  add column if not exists license_status text not null default 'pending_qualification',
  add column if not exists ordering_status text not null default 'pending',
  add column if not exists ordering_hold_reason text,
  add column if not exists license_expires_on date,
  add column if not exists qualified_by uuid references auth.users(id) on delete set null,
  add column if not exists qualified_at timestamptz,
  add column if not exists closed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_store'::regclass
      and conname = 'portal_store_license_status_check'
  ) then
    alter table public.portal_store add constraint portal_store_license_status_check
      check (license_status in ('pending_qualification', 'active', 'expired', 'suspended', 'rejected')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_store'::regclass
      and conname = 'portal_store_ordering_status_check'
  ) then
    alter table public.portal_store add constraint portal_store_ordering_status_check
      check (ordering_status in ('pending', 'ready', 'paused')) not valid;
  end if;
end
$$;

alter table public.portal_store validate constraint portal_store_license_status_check;
alter table public.portal_store validate constraint portal_store_ordering_status_check;

-- Preserve the three existing portal stores as ready records. They already
-- supported pricing and ordering before this normalized account layer existed.
insert into public.portal_retailer_account (
  organization_name, display_name, portal_status, status_note
)
select distinct store.organization, store.organization, 'ready_to_order',
  'Backfilled from an existing portal store during retailer-account normalization.'
from public.portal_store as store
on conflict (organization_name) do nothing;

update public.portal_store as store
set retailer_account_id = account.id,
    license_status = case when store.active then 'active' else 'suspended' end,
    ordering_status = case when store.active then 'ready' else 'paused' end,
    qualified_at = case when store.active then coalesce(store.qualified_at, now()) else store.qualified_at end,
    updated_at = now()
from public.portal_retailer_account as account
where account.organization_name = store.organization
  and store.retailer_account_id is null;

create or replace function public.portal_enforce_retailer_store_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  open_store_count integer;
begin
  if new.retailer_account_id is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.retailer_account_id is not distinct from new.retailer_account_id then return new; end if;
  end if;

  -- Serialize changes within one retailer account so concurrent requests cannot
  -- both observe nine stores and create an eleventh location together.
  perform pg_advisory_xact_lock(hashtextextended(new.retailer_account_id::text, 0));
  select count(*) into open_store_count
  from public.portal_store
  where retailer_account_id = new.retailer_account_id
    and closed_at is null;
  if open_store_count >= 10 then
    raise exception 'A retailer account may contain no more than ten stores';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_store_limit_trigger on public.portal_store;
create trigger portal_store_limit_trigger
before insert or update of retailer_account_id on public.portal_store
for each row execute function public.portal_enforce_retailer_store_limit();

-- Normalize legacy Budtender text scope to one store. Buyer rows were already
-- backfilled by the pricing migration; Owners intentionally remain org-wide.
with ranked_budtender_stores as (
  select assignment.profile_id, assignment.license_number,
    row_number() over (
      partition by assignment.profile_id
      order by assignment.created_at, assignment.license_number
    ) as position
  from public.portal_profile_store as assignment
  join public.portal_profile as profile on profile.id = assignment.profile_id
  where profile.role = 'budtender'
)
delete from public.portal_profile_store as assignment
using ranked_budtender_stores as ranked
where assignment.profile_id = ranked.profile_id
  and assignment.license_number = ranked.license_number
  and ranked.position > 1;

insert into public.portal_profile_store (profile_id, license_number)
select profile.id, matched_store.license_number
from public.portal_profile as profile
join lateral (
  select store.license_number
  from public.portal_store as store
  where store.organization = profile.org
    and store.active = true
    and (
      lower(coalesce(profile.locations, '')) = lower(store.display_name)
      or position(lower(store.display_name) in lower(coalesce(profile.locations, ''))) > 0
      or position(lower(store.license_number) in lower(coalesce(profile.locations, ''))) > 0
      or lower(coalesce(profile.locations, '')) like '%all%location%'
    )
  order by
    (lower(coalesce(profile.locations, '')) = lower(store.display_name)) desc,
    store.display_name
  limit 1
) as matched_store on true
where profile.role = 'budtender'
  and profile.active = true
on conflict do nothing;

alter table public.quickbooks_customer_link
  add column if not exists retailer_account_id uuid references public.portal_retailer_account(id) on delete set null;

create table if not exists public.portal_retailer_event (
  id uuid primary key default gen_random_uuid(),
  retailer_account_id uuid not null references public.portal_retailer_account(id),
  store_license text references public.portal_store(license_number),
  event_type text not null check (event_type in (
    'account_created', 'quickbooks_linked', 'account_status_changed',
    'store_added', 'store_status_changed', 'note_changed'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  from_value text,
  to_value text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_retailer_event_account_idx
  on public.portal_retailer_event (retailer_account_id, created_at desc);

create table if not exists public.portal_onboarding_request (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  retailer_account_id uuid references public.portal_retailer_account(id),
  quickbooks_customer_id text references public.quickbooks_customer_cache(quickbooks_customer_id) on delete set null,
  submission_type text not null check (submission_type in (
    'new_store', 'people_change', 'new_location'
  )),
  legal_entity text not null,
  dba text,
  stage text not null default 'intake' check (stage in (
    'intake', 'qualification', 'terms', 'account_creation', 'access', 'ready', 'rejected', 'closed'
  )),
  workflow_state text not null default 'pending' check (workflow_state in (
    'pending', 'accepted', 'needs_reconciliation', 'rejected'
  )),
  workflow_error text,
  monday_item_id text,
  monday_board_id text,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_by_email text,
  owner_name text,
  owner_email text,
  owner_phone text,
  metadata jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  accepted_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists portal_onboarding_request_queue_idx
  on public.portal_onboarding_request (stage, workflow_state, submitted_at desc);

create table if not exists public.portal_onboarding_store (
  id bigint generated by default as identity primary key,
  onboarding_request_id uuid not null references public.portal_onboarding_request(id) on delete cascade,
  store_number integer not null check (store_number between 1 and 10),
  store_name text not null,
  license_number text not null,
  address text,
  qualification_status text not null default 'pending' check (qualification_status in ('pending', 'qualified', 'rejected')),
  qualification_note text,
  created_at timestamptz not null default now(),
  unique (onboarding_request_id, store_number),
  unique (onboarding_request_id, license_number)
);

create table if not exists public.portal_onboarding_person (
  id bigint generated by default as identity primary key,
  onboarding_request_id uuid not null references public.portal_onboarding_request(id) on delete cascade,
  person_role text not null check (person_role in ('owner', 'buyer', 'budtender')),
  full_name text not null,
  email text not null,
  phone text,
  store_license text,
  portal_profile_id uuid references auth.users(id) on delete set null,
  access_status text not null default 'pending' check (access_status in ('pending', 'invited', 'active', 'rejected')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_onboarding_event (
  id uuid primary key default gen_random_uuid(),
  onboarding_request_id uuid not null references public.portal_onboarding_request(id) on delete cascade,
  source text not null check (source in ('portal-intake', 'internal', 'monday', 'system')),
  from_stage text,
  to_stage text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_onboarding_event_request_idx
  on public.portal_onboarding_event (onboarding_request_id, created_at asc);

alter table public.portal_retailer_account enable row level security;
alter table public.portal_retailer_event enable row level security;
alter table public.portal_onboarding_request enable row level security;
alter table public.portal_onboarding_store enable row level security;
alter table public.portal_onboarding_person enable row level security;
alter table public.portal_onboarding_event enable row level security;

revoke all on table public.portal_retailer_account from anon, authenticated;
revoke all on table public.portal_retailer_event from anon, authenticated;
revoke all on table public.portal_onboarding_request from anon, authenticated;
revoke all on table public.portal_onboarding_store from anon, authenticated;
revoke all on table public.portal_onboarding_person from anon, authenticated;
revoke all on table public.portal_onboarding_event from anon, authenticated;
grant all on table public.portal_retailer_account to service_role;
grant select, insert on table public.portal_retailer_event to service_role;
grant all on table public.portal_onboarding_request to service_role;
grant all on table public.portal_onboarding_store to service_role;
grant all on table public.portal_onboarding_person to service_role;
grant select, insert on table public.portal_onboarding_event to service_role;

create or replace function public.portal_create_or_link_retailer_account(
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
  customer public.quickbooks_customer_cache%rowtype;
  account public.portal_retailer_account%rowtype;
  account_name text;
  was_linked boolean := false;
begin
  select * into customer
  from public.quickbooks_customer_cache
  where quickbooks_customer_id = trim(p_quickbooks_customer_id);
  if not found then raise exception 'QuickBooks customer not found'; end if;

  account_name := coalesce(nullif(trim(customer.company_name), ''), trim(customer.display_name));
  select * into account
  from public.portal_retailer_account
  where quickbooks_customer_id = customer.quickbooks_customer_id
     or lower(organization_name) = lower(account_name)
  order by (quickbooks_customer_id = customer.quickbooks_customer_id) desc
  limit 1
  for update;

  if found then
    was_linked := account.quickbooks_customer_id = customer.quickbooks_customer_id;
    if account.quickbooks_customer_id is not null
      and account.quickbooks_customer_id <> customer.quickbooks_customer_id then
      raise exception 'That organization is already linked to another QuickBooks customer';
    end if;
    update public.portal_retailer_account
    set quickbooks_customer_id = customer.quickbooks_customer_id,
        display_name = customer.display_name,
        portal_status = case when account.portal_status = 'not_qualified' then 'qualification' else account.portal_status end,
        updated_by = p_actor_id,
        updated_at = now()
    where id = account.id
    returning * into account;
  else
    insert into public.portal_retailer_account (
      quickbooks_customer_id, organization_name, display_name, portal_status,
      created_by, updated_by
    ) values (
      customer.quickbooks_customer_id, account_name, customer.display_name,
      'qualification', p_actor_id, p_actor_id
    ) returning * into account;
    insert into public.portal_retailer_event (
      retailer_account_id, event_type, actor_id, actor_email, to_value, note
    ) values (
      account.id, 'account_created', p_actor_id,
      nullif(trim(coalesce(p_actor_email, '')), ''), 'qualification',
      'Portal qualification started from a QuickBooks customer.'
    );
  end if;

  update public.quickbooks_customer_link
  set retailer_account_id = account.id,
      portal_status = upper(replace(account.portal_status, '_', ' ')),
      updated_at = now()
  where quickbooks_customer_id = customer.quickbooks_customer_id;
  if not found then
    insert into public.quickbooks_customer_link (
      quickbooks_customer_id, retailer_account_id, portal_status, location_count
    ) values (
      customer.quickbooks_customer_id, account.id,
      upper(replace(account.portal_status, '_', ' ')), 0
    );
  end if;

  if not was_linked then
    insert into public.portal_retailer_event (
      retailer_account_id, event_type, actor_id, actor_email, to_value, note
    ) values (
      account.id, 'quickbooks_linked', p_actor_id,
      nullif(trim(coalesce(p_actor_email, '')), ''), customer.quickbooks_customer_id,
      'QuickBooks customer linked to the portal retailer account.'
    );
  end if;

  return jsonb_build_object('id', account.id, 'portalStatus', account.portal_status);
end;
$$;

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
    if account.quickbooks_customer_id is not null and coalesce(customer_active, false) is not true then
      raise exception 'An inactive QuickBooks customer cannot be ready to order';
    end if;
    select count(*) into ready_store_count
    from public.portal_store
    where retailer_account_id = account.id
      and active = true
      and license_status = 'active'
      and ordering_status = 'ready';
    if ready_store_count < 1 then
      raise exception 'At least one qualified store must be ready before the account can order';
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
  existing_store public.portal_store%rowtype;
  store_count integer;
  normalized_license text;
  store_created boolean := false;
begin
  normalized_license := upper(trim(p_license_number));
  if normalized_license = '' or trim(coalesce(p_display_name, '')) = '' then
    raise exception 'Store name and license number are required';
  end if;

  select * into account
  from public.portal_retailer_account
  where id = p_account_id
  for update;
  if not found then raise exception 'Retailer account not found'; end if;

  select * into existing_store
  from public.portal_store
  where license_number = normalized_license
  for update;
  if found and existing_store.retailer_account_id is distinct from account.id then
    raise exception 'That license is already attached to another retailer account';
  end if;
  if not found then
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
      account.id, nullif(trim(coalesce(p_quickbooks_customer_id, '')), ''),
      nullif(trim(coalesce(p_address, '')), ''),
      'pending_qualification', 'pending', now()
    );
    store_created := true;
  else
    update public.portal_store
    set display_name = trim(p_display_name),
        address = nullif(trim(coalesce(p_address, '')), ''),
        quickbooks_customer_id = coalesce(
          nullif(trim(coalesce(p_quickbooks_customer_id, '')), ''),
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
    account.id, normalized_license, case when store_created then 'store_added' else 'note_changed' end, p_actor_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    case when store_created then 'pending_qualification' else 'store_details_updated' end,
    case when store_created
      then 'Store added; license qualification and ordering readiness remain pending.'
      else 'Store name, address, or QuickBooks child-customer link updated.'
    end
  );

  return jsonb_build_object('accountId', account.id, 'licenseNumber', normalized_license, 'created', store_created);
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

  update public.portal_store
  set license_status = p_license_status,
      ordering_status = normalized_ordering_status,
      ordering_hold_reason = nullif(trim(coalesce(p_hold_reason, '')), ''),
      license_expires_on = p_license_expires_on,
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
    'orderingStatus', normalized_ordering_status
  );
end;
$$;

create or replace function public.portal_create_onboarding_request(
  p_client_request_id uuid,
  p_retailer_account_id uuid,
  p_quickbooks_customer_id text,
  p_submission_type text,
  p_legal_entity text,
  p_dba text,
  p_submitted_by uuid,
  p_submitted_by_email text,
  p_owner jsonb,
  p_stores jsonb,
  p_people jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_id uuid;
  existing_request public.portal_onboarding_request%rowtype;
  request_fingerprint text;
begin
  if p_submission_type not in ('new_store', 'people_change', 'new_location') then
    raise exception 'Unsupported onboarding submission type';
  end if;
  if jsonb_typeof(p_stores) <> 'array' or jsonb_array_length(p_stores) < 1 or jsonb_array_length(p_stores) > 10 then
    raise exception 'An onboarding request must contain between one and ten stores';
  end if;
  if jsonb_typeof(coalesce(p_people, '[]'::jsonb)) <> 'array' then
    raise exception 'Onboarding people must be an array';
  end if;
  if trim(coalesce(p_legal_entity, '')) = '' then
    raise exception 'Legal entity is required';
  end if;
  if p_submission_type in ('new_store', 'new_location')
    and (
      trim(coalesce(p_owner ->> 'name', '')) = ''
      or trim(coalesce(p_owner ->> 'email', '')) = ''
    ) then
    raise exception 'Owner contact is required for a new store or location';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_stores) as store(value)
    where trim(coalesce(store.value ->> 'name', '')) = ''
       or trim(coalesce(store.value ->> 'license', '')) = ''
  ) then
    raise exception 'Every store requires a name and license number';
  end if;
  if exists (
    select 1
    from (
      select upper(trim(store.value ->> 'license')) as license_number, count(*)
      from jsonb_array_elements(p_stores) as store(value)
      group by upper(trim(store.value ->> 'license'))
      having count(*) > 1
    ) as duplicate_store
  ) then
    raise exception 'An onboarding request cannot repeat a store license';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) as person(value)
    where trim(coalesce(person.value ->> 'role', '')) not in ('owner', 'buyer', 'budtender')
       or trim(coalesce(person.value ->> 'name', '')) = ''
       or trim(coalesce(person.value ->> 'email', '')) = ''
       or (
         trim(person.value ->> 'role') = 'budtender'
         and (
           trim(coalesce(person.value ->> 'storeLicense', '')) = ''
           or not exists (
             select 1 from jsonb_array_elements(p_stores) as store(value)
             where upper(trim(store.value ->> 'license')) = upper(trim(person.value ->> 'storeLicense'))
           )
         )
       )
  ) then
    raise exception 'Every onboarding person requires a supported role, name, email, and one valid store for each budtender';
  end if;

  request_fingerprint := md5(jsonb_build_object(
    'retailerAccountId', p_retailer_account_id,
    'quickbooksCustomerId', p_quickbooks_customer_id,
    'submissionType', p_submission_type,
    'legalEntity', trim(p_legal_entity),
    'dba', trim(coalesce(p_dba, '')),
    'submittedBy', p_submitted_by,
    'owner', p_owner,
    'stores', p_stores,
    'people', p_people
  )::text);

  insert into public.portal_onboarding_request (
    client_request_id, retailer_account_id, quickbooks_customer_id,
    submission_type, legal_entity, dba, submitted_by,
    submitted_by_email, owner_name, owner_email, owner_phone, metadata
  ) values (
    p_client_request_id, p_retailer_account_id,
    nullif(trim(coalesce(p_quickbooks_customer_id, '')), ''),
    p_submission_type, trim(p_legal_entity),
    nullif(trim(coalesce(p_dba, '')), ''), p_submitted_by,
    nullif(trim(coalesce(p_submitted_by_email, '')), ''),
    nullif(trim(coalesce(p_owner ->> 'name', '')), ''),
    nullif(lower(trim(coalesce(p_owner ->> 'email', ''))), ''),
    nullif(trim(coalesce(p_owner ->> 'phone', '')), ''),
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('_requestFingerprint', request_fingerprint)
  )
  on conflict (client_request_id) do nothing
  returning id into request_id;

  if request_id is null then
    select * into existing_request
    from public.portal_onboarding_request
    where client_request_id = p_client_request_id;
    if existing_request.metadata ->> '_requestFingerprint' is distinct from request_fingerprint then
      raise exception 'The idempotency identifier belongs to a different onboarding request';
    end if;
    return jsonb_build_object(
      'id', existing_request.id,
      'created', false,
      'workflowState', existing_request.workflow_state,
      'stage', existing_request.stage,
      'mondayItemId', existing_request.monday_item_id
    );
  end if;

  insert into public.portal_onboarding_store (
    onboarding_request_id, store_number, store_name, license_number, address
  )
  select request_id, store.ordinality::integer,
    trim(store.value ->> 'name'), upper(trim(store.value ->> 'license')),
    nullif(trim(coalesce(store.value ->> 'address', '')), '')
  from jsonb_array_elements(p_stores) with ordinality as store(value, ordinality);

  insert into public.portal_onboarding_person (
    onboarding_request_id, person_role, full_name, email, phone, store_license
  )
  select request_id, trim(person.value ->> 'role'),
    trim(person.value ->> 'name'), lower(trim(person.value ->> 'email')),
    nullif(trim(coalesce(person.value ->> 'phone', '')), ''),
    nullif(upper(trim(coalesce(person.value ->> 'storeLicense', ''))), '')
  from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) as person(value)
  where trim(coalesce(person.value ->> 'name', '')) <> ''
    and trim(coalesce(person.value ->> 'email', '')) <> '';

  insert into public.portal_onboarding_event (
    onboarding_request_id, source, from_stage, to_stage,
    actor_id, actor_email, note
  ) values (
    request_id, 'portal-intake', null, 'intake', p_submitted_by,
    nullif(trim(coalesce(p_submitted_by_email, '')), ''),
    'Onboarding request verified and recorded before workflow forwarding.'
  );

  return jsonb_build_object(
    'id', request_id, 'created', true,
    'workflowState', 'pending', 'stage', 'intake'
  );
end;
$$;

create or replace function public.portal_mark_onboarding_workflow(
  p_request_id uuid,
  p_workflow_state text,
  p_monday_item_id text default null,
  p_monday_board_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed public.portal_onboarding_request%rowtype;
begin
  if p_workflow_state not in ('pending', 'accepted', 'needs_reconciliation', 'rejected') then
    raise exception 'Unsupported onboarding workflow state';
  end if;
  update public.portal_onboarding_request
  set workflow_state = p_workflow_state,
      monday_item_id = coalesce(nullif(trim(coalesce(p_monday_item_id, '')), ''), monday_item_id),
      monday_board_id = coalesce(nullif(trim(coalesce(p_monday_board_id, '')), ''), monday_board_id),
      workflow_error = nullif(trim(coalesce(p_error, '')), ''),
      accepted_at = case when p_workflow_state = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
      updated_at = now()
  where id = p_request_id
  returning * into changed;
  if not found then raise exception 'Onboarding request not found'; end if;
  return jsonb_build_object(
    'id', changed.id, 'workflowState', changed.workflow_state,
    'mondayItemId', changed.monday_item_id, 'stage', changed.stage
  );
end;
$$;

create or replace function public.portal_link_onboarding_account(
  p_request_id uuid,
  p_account_id uuid,
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
begin
  select * into onboarding
  from public.portal_onboarding_request
  where id = p_request_id
  for update;
  if not found then raise exception 'Onboarding request not found'; end if;
  if onboarding.stage in ('access', 'ready', 'rejected', 'closed') then
    raise exception 'An onboarding request cannot be relinked after store creation';
  end if;

  select * into account
  from public.portal_retailer_account
  where id = p_account_id
  for update;
  if not found then raise exception 'Retailer account not found'; end if;
  if account.quickbooks_customer_id is null then
    raise exception 'The retailer account must be linked to QuickBooks first';
  end if;

  update public.portal_onboarding_request
  set retailer_account_id = account.id,
      quickbooks_customer_id = account.quickbooks_customer_id,
      updated_at = now()
  where id = onboarding.id;

  insert into public.portal_onboarding_event (
    onboarding_request_id, source, from_stage, to_stage,
    actor_id, actor_email, note, metadata
  ) values (
    onboarding.id, 'internal', onboarding.stage, onboarding.stage,
    p_actor_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    'Onboarding request linked to a QuickBooks-backed portal retailer account.',
    jsonb_build_object('retailerAccountId', account.id, 'quickbooksCustomerId', account.quickbooks_customer_id)
  );

  return jsonb_build_object(
    'id', onboarding.id,
    'retailerAccountId', account.id,
    'quickbooksCustomerId', account.quickbooks_customer_id,
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
      'toQualificationStatus', p_status
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
      for store_record in
        select * from public.portal_onboarding_store
        where onboarding_request_id = onboarding.id
          and qualification_status = 'qualified'
        order by store_number
      loop
        perform public.portal_add_retailer_store(
          account.id, store_record.license_number, store_record.store_name,
          store_record.address, null, p_actor_id, p_actor_email
        );
        select * into portal_store_record
        from public.portal_store
        where license_number = store_record.license_number;
        if portal_store_record.license_status <> 'active' then
          perform public.portal_set_retailer_store_status(
            account.id, store_record.license_number, 'active', 'pending',
            'Qualified through onboarding; ordering remains pending until explicitly enabled.',
            null, p_actor_id, p_actor_email
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
      where onboarding_location.onboarding_request_id = onboarding.id
        and onboarding_location.qualification_status = 'qualified'
        and portal_location.license_number is null;
      if missing_store_count > 0 then
        raise exception 'Every qualified license must exist as an active portal store before completion';
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

revoke all on function public.portal_create_or_link_retailer_account(text, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_enforce_retailer_store_limit() from public, anon, authenticated;
revoke all on function public.portal_set_retailer_status(uuid, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_add_retailer_store(uuid, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_set_retailer_store_status(uuid, text, text, text, text, date, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_create_onboarding_request(uuid, uuid, text, text, text, text, uuid, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.portal_mark_onboarding_workflow(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_link_onboarding_account(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_set_onboarding_store_qualification(uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_advance_onboarding_request(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.portal_create_or_link_retailer_account(text, uuid, text) to service_role;
grant execute on function public.portal_set_retailer_status(uuid, text, text, uuid, text) to service_role;
grant execute on function public.portal_add_retailer_store(uuid, text, text, text, text, uuid, text) to service_role;
grant execute on function public.portal_set_retailer_store_status(uuid, text, text, text, text, date, uuid, text) to service_role;
grant execute on function public.portal_create_onboarding_request(uuid, uuid, text, text, text, text, uuid, text, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.portal_mark_onboarding_workflow(uuid, text, text, text, text) to service_role;
grant execute on function public.portal_link_onboarding_account(uuid, uuid, uuid, text) to service_role;
grant execute on function public.portal_set_onboarding_store_qualification(uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.portal_advance_onboarding_request(uuid, text, text, uuid, text) to service_role;

comment on table public.portal_retailer_account is
  'Portal-owned retailer organization linked to, but operationally distinct from, the QuickBooks customer.';
comment on table public.portal_store is
  'Licensed retailer store. License and ordering readiness are independent gates; at most ten open stores belong to one retailer account.';
comment on table public.portal_onboarding_request is
  'Durable intake record for a new retailer, people change, or added store. Submission never qualifies a license by itself.';
