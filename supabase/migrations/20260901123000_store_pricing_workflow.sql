-- Store-scoped pricing is proposed by retailer owners and buyers, but becomes
-- orderable only after an urbanXtracts Administrator, Operations, or Sales
-- user approves it. Browsers never receive direct table access.

create table if not exists public.portal_store (
  license_number text primary key,
  organization text not null,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists portal_store_org_name_idx
  on public.portal_store (organization, display_name);

create table if not exists public.portal_profile_store (
  profile_id uuid not null references auth.users(id) on delete cascade,
  license_number text not null references public.portal_store(license_number) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, license_number)
);

create table if not exists public.portal_price_proposal (
  id uuid primary key default gen_random_uuid(),
  organization text not null,
  location_license text not null references public.portal_store(license_number),
  product_id text not null,
  product_name text not null,
  sku text,
  current_price_cents integer check (current_price_cents is null or current_price_cents >= 0),
  proposed_price_cents integer not null check (proposed_price_cents > 0 and proposed_price_cents <= 10000000),
  note text,
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'withdrawn')),
  proposed_by uuid not null references auth.users(id),
  proposed_by_email text,
  proposed_by_role text not null check (proposed_by_role in ('owner', 'buyer')),
  decided_by uuid references auth.users(id),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create unique index if not exists portal_price_proposal_one_pending_idx
  on public.portal_price_proposal (organization, location_license, product_id)
  where state = 'pending';

create index if not exists portal_price_proposal_queue_idx
  on public.portal_price_proposal (state, created_at desc);

create table if not exists public.portal_store_price (
  organization text not null,
  location_license text not null references public.portal_store(license_number),
  product_id text not null,
  product_name text not null,
  sku text,
  price_cents integer not null check (price_cents > 0 and price_cents <= 10000000),
  source_proposal_id uuid references public.portal_price_proposal(id),
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(),
  primary key (location_license, product_id)
);

insert into public.portal_store (license_number, organization, display_name)
values
  ('OCM-RETL-24-000412', 'Downtown Provisions', 'Downtown'),
  ('OCM-RETL-24-000518', 'Downtown Provisions', 'Riverside'),
  ('OCM-RETL-24-000633', 'Downtown Provisions', 'Northgate')
on conflict (license_number) do update
set organization = excluded.organization,
    display_name = excluded.display_name,
    updated_at = now();

-- Preserve existing textual store assignments while moving authorization to a
-- normalized server-owned relationship. Owners are organization-wide and do
-- not require rows here; buyers receive only explicit matches (or all stores
-- when an administrator previously assigned an "All ... locations" scope).
insert into public.portal_profile_store (profile_id, license_number)
select profile.id, store.license_number
from public.portal_profile as profile
join public.portal_store as store
  on store.organization = profile.org
where profile.role = 'buyer'
  and (
    lower(coalesce(profile.locations, '')) = lower(store.display_name)
    or lower(coalesce(profile.locations, '')) like '%all%location%'
    or position(lower(store.display_name) in lower(coalesce(profile.locations, ''))) > 0
    or position(lower(store.license_number) in lower(coalesce(profile.locations, ''))) > 0
  )
on conflict do nothing;

alter table public.portal_store enable row level security;
alter table public.portal_profile_store enable row level security;
alter table public.portal_price_proposal enable row level security;
alter table public.portal_store_price enable row level security;

revoke all on table public.portal_store from anon, authenticated;
revoke all on table public.portal_profile_store from anon, authenticated;
revoke all on table public.portal_price_proposal from anon, authenticated;
revoke all on table public.portal_store_price from anon, authenticated;
grant all on table public.portal_store to service_role;
grant all on table public.portal_profile_store to service_role;
grant all on table public.portal_price_proposal to service_role;
grant all on table public.portal_store_price to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;

alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check
  check (permission in (
    'inventory.read',
    'inventory.sync',
    'orders.manage',
    'accounts.manage',
    'pricing.manage',
    'quality.manage',
    'lineage.read',
    'users.manage',
    'audit.read',
    'readiness.read'
  )) not valid;

alter table public.portal_role_permission
  validate constraint portal_role_permission_permission_check;

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'pricing.manage'),
  ('operations', 'pricing.manage'),
  ('sales', 'pricing.manage')
on conflict do nothing;

create or replace function public.portal_decide_price_proposal(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  proposal public.portal_price_proposal%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Unsupported pricing decision';
  end if;

  select * into proposal
  from public.portal_price_proposal
  where id = p_proposal_id
  for update;

  if not found then
    raise exception 'Pricing proposal not found';
  end if;
  if proposal.state <> 'pending' then
    raise exception 'Pricing proposal has already been decided';
  end if;

  if p_decision = 'approved' then
    insert into public.portal_store_price (
      organization, location_license, product_id, product_name, sku,
      price_cents, source_proposal_id, published_by, published_at
    ) values (
      proposal.organization, proposal.location_license, proposal.product_id,
      proposal.product_name, proposal.sku, proposal.proposed_price_cents,
      proposal.id, p_actor_id, now()
    )
    on conflict (location_license, product_id) do update
    set organization = excluded.organization,
        product_name = excluded.product_name,
        sku = excluded.sku,
        price_cents = excluded.price_cents,
        source_proposal_id = excluded.source_proposal_id,
        published_by = excluded.published_by,
        published_at = excluded.published_at;
  end if;

  update public.portal_price_proposal
  set state = p_decision,
      decided_by = p_actor_id,
      decision_note = nullif(trim(coalesce(p_note, '')), ''),
      decided_at = now()
  where id = p_proposal_id;

  return jsonb_build_object(
    'id', proposal.id,
    'state', p_decision,
    'locationLicense', proposal.location_license,
    'productId', proposal.product_id,
    'priceCents', proposal.proposed_price_cents
  );
end;
$$;

revoke all on function public.portal_decide_price_proposal(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.portal_decide_price_proposal(uuid, uuid, text, text) to service_role;

comment on table public.portal_price_proposal is
  'Store-scoped retailer price proposals. A proposal never changes an orderable price until internally approved.';
comment on table public.portal_store_price is
  'Current published store rate card. Every row is traceable to an approved proposal and internal publisher.';
comment on table public.portal_profile_store is
  'Server-owned store assignments for retailer buyers. Owners receive all active stores in their organization.';

-- Workforce SSO is self-provisioning at the least-privileged Viewer preset.
-- The email domain identifies an employee; elevated capabilities still require
-- a later administrator action and remain server-authorized.
create or replace function public.portal_provision_workforce_viewer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if lower(coalesce(new.email, '')) like '%@urbanxtracts.com' then
    insert into public.portal_profile (id, full_name, org, role, locations, active, staff_role)
    values (
      new.id,
      coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
      'urbanXtracts',
      'internal',
      'Assigned accounts',
      true,
      'viewer'
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists portal_provision_workforce_viewer on auth.users;
create trigger portal_provision_workforce_viewer
after insert on auth.users
for each row execute function public.portal_provision_workforce_viewer();

insert into public.portal_profile (id, full_name, org, role, locations, active, staff_role)
select
  users.id,
  coalesce(nullif(trim(users.raw_user_meta_data ->> 'full_name'), ''), split_part(users.email, '@', 1)),
  'urbanXtracts',
  'internal',
  'Assigned accounts',
  true,
  'viewer'
from auth.users as users
left join public.portal_profile as profile on profile.id = users.id
where profile.id is null
  and lower(coalesce(users.email, '')) like '%@urbanxtracts.com'
on conflict (id) do nothing;

revoke all on function public.portal_provision_workforce_viewer() from public, anon, authenticated;

comment on function public.portal_provision_workforce_viewer() is
  'Creates first-time @urbanxtracts.com SSO users as active internal Viewers; elevated workforce presets remain administrator-controlled.';
