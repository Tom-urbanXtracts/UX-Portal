-- Additive organization and membership foundation for the Internal, Brand,
-- and Store workspaces. Existing portal_profile, retailer, connector, and
-- order tables remain authoritative during the compatibility period.

-- Brand collaborators use the same proven Auth profile path as existing users.
-- Workspace membership, not this compatibility role, is the organization scope.
alter table public.portal_profile
  drop constraint if exists portal_profile_role_check;
alter table public.portal_profile
  add constraint portal_profile_role_check
  check (role in ('owner', 'buyer', 'budtender', 'internal', 'brand')) not valid;
alter table public.portal_profile
  validate constraint portal_profile_role_check;

alter table public.portal_pending_profile
  drop constraint if exists portal_pending_profile_role_check;
alter table public.portal_pending_profile
  add constraint portal_pending_profile_role_check
  check (role in ('owner', 'buyer', 'budtender', 'internal', 'brand')) not valid;
alter table public.portal_pending_profile
  validate constraint portal_pending_profile_role_check;

create table if not exists public.portal_organization (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('internal', 'brand', 'retailer')),
  legal_name text not null,
  display_name text not null,
  status text not null default 'active' check (status in ('onboarding', 'active', 'inactive')),
  legacy_retailer_account_id uuid unique references public.portal_retailer_account(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, legal_name)
);

create table if not exists public.portal_organization_membership (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.portal_profile(id) on delete cascade,
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  workspace text not null check (workspace in ('internal', 'brand', 'store')),
  member_role text not null check (member_role in (
    'administrator', 'operations', 'sales', 'quality', 'viewer',
    'brand_owner', 'brand_manager', 'brand_contributor', 'brand_viewer',
    'store_owner', 'store_buyer', 'store_staff'
  )),
  status text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, organization_id, workspace)
);

create unique index if not exists portal_organization_membership_one_default_idx
  on public.portal_organization_membership (profile_id)
  where is_default and status = 'active';

create index if not exists portal_organization_membership_scope_idx
  on public.portal_organization_membership (organization_id, workspace, status);

create table if not exists public.portal_brand_account (
  organization_id uuid primary key references public.portal_organization(id) on delete cascade,
  canix_brand_id text,
  canix_brand_name text,
  canix_owner_id text,
  canix_owner_name text,
  monday_account_item_id text,
  quickbooks_entity_type text check (quickbooks_entity_type in ('customer', 'vendor', 'both')),
  quickbooks_customer_id text,
  quickbooks_vendor_id text,
  scope_status text not null default 'pending' check (scope_status in ('pending', 'verified', 'blocked')),
  scope_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_status <> 'verified')
    or nullif(btrim(coalesce(canix_brand_id, canix_owner_id, '')), '') is not null
  )
);

alter table public.portal_organization enable row level security;
alter table public.portal_organization_membership enable row level security;
alter table public.portal_brand_account enable row level security;

revoke all on table public.portal_organization from public, anon, authenticated;
revoke all on table public.portal_organization_membership from public, anon, authenticated;
revoke all on table public.portal_brand_account from public, anon, authenticated;

grant select on table public.portal_organization to authenticated;
grant select on table public.portal_organization_membership to authenticated;
grant select on table public.portal_brand_account to authenticated;
grant all on table public.portal_organization to service_role;
grant all on table public.portal_organization_membership to service_role;
grant all on table public.portal_brand_account to service_role;

create policy portal_organization_member_select
on public.portal_organization
for select
to authenticated
using (
  (select auth.jwt()->>'aal') = 'aal2'
  and (
    public.portal_role() = 'internal'
    or exists (
    select 1
    from public.portal_organization_membership as membership
    where membership.organization_id = portal_organization.id
      and membership.profile_id = (select auth.uid())
      and membership.status = 'active'
    )
  )
);

create policy portal_organization_membership_self_select
on public.portal_organization_membership
for select
to authenticated
using (
  (select auth.jwt()->>'aal') = 'aal2'
  and (
    profile_id = (select auth.uid())
    or public.portal_role() = 'internal'
  )
);

create policy portal_brand_account_member_select
on public.portal_brand_account
for select
to authenticated
using (
  (select auth.jwt()->>'aal') = 'aal2'
  and (
    public.portal_role() = 'internal'
    or exists (
    select 1
    from public.portal_organization_membership as membership
    where membership.organization_id = portal_brand_account.organization_id
      and membership.profile_id = (select auth.uid())
      and membership.workspace = 'brand'
      and membership.status = 'active'
    )
  )
);

-- Establish compatibility organizations for current users without changing
-- any legacy role, retailer, store, pricing, order, or connector record.
insert into public.portal_organization (kind, legal_name, display_name, status)
values ('internal', 'urbanXtracts', 'urbanXtracts', 'active')
on conflict (kind, legal_name) do update
set display_name = excluded.display_name,
    status = 'active',
    updated_at = now();

insert into public.portal_organization (
  kind, legal_name, display_name, status, legacy_retailer_account_id
)
select 'retailer', account.organization_name, account.display_name,
  case when account.portal_status = 'inactive' then 'inactive' else 'active' end,
  account.id
from public.portal_retailer_account as account
on conflict (kind, legal_name) do update
set display_name = excluded.display_name,
    status = excluded.status,
    legacy_retailer_account_id = excluded.legacy_retailer_account_id,
    updated_at = now();

insert into public.portal_organization_membership (
  profile_id, organization_id, workspace, member_role, status, is_default
)
select profile.id, organization.id, 'internal',
  coalesce(profile.staff_role, 'viewer'),
  case when profile.active then 'active' else 'disabled' end,
  true
from public.portal_profile as profile
join public.portal_organization as organization
  on organization.kind = 'internal'
 and organization.legal_name = 'urbanXtracts'
where profile.role = 'internal'
on conflict (profile_id, organization_id, workspace) do update
set member_role = excluded.member_role,
    status = excluded.status,
    is_default = excluded.is_default,
    updated_at = now();

-- urbanXtracts is the controlled Brand-workspace pilot. It remains pending
-- source verification until Canix and Monday stable IDs are explicitly mapped.
insert into public.portal_organization (kind, legal_name, display_name, status)
values ('brand', 'urbanXtracts', 'urbanXtracts', 'active')
on conflict (kind, legal_name) do update
set display_name = excluded.display_name,
    status = 'active',
    updated_at = now();

insert into public.portal_brand_account (organization_id, scope_status, scope_note)
select organization.id, 'pending',
  'Pilot shell only. Verify Canix Brand/Owner and Monday account identities before connected Brand data is enabled.'
from public.portal_organization as organization
where organization.kind = 'brand'
  and organization.legal_name = 'urbanXtracts'
on conflict (organization_id) do nothing;

insert into public.portal_organization_membership (
  profile_id, organization_id, workspace, member_role, status, is_default
)
select profile.id, organization.id, 'brand', 'brand_manager',
  case when profile.active then 'active' else 'disabled' end,
  false
from public.portal_profile as profile
join public.portal_organization as organization
  on organization.kind = 'brand'
 and organization.legal_name = 'urbanXtracts'
where profile.role = 'internal'
  and profile.staff_role = 'administrator'
on conflict (profile_id, organization_id, workspace) do update
set member_role = excluded.member_role,
    status = excluded.status,
    is_default = false,
    updated_at = now();

insert into public.portal_organization_membership (
  profile_id, organization_id, workspace, member_role, status, is_default
)
select profile.id, organization.id, 'store',
  case profile.role
    when 'owner' then 'store_owner'
    when 'buyer' then 'store_buyer'
    else 'store_staff'
  end,
  case when profile.active then 'active' else 'disabled' end,
  true
from public.portal_profile as profile
join public.portal_organization as organization
  on organization.kind = 'retailer'
 and lower(organization.legal_name) = lower(profile.org)
where profile.role in ('owner', 'buyer', 'budtender')
on conflict (profile_id, organization_id, workspace) do update
set member_role = excluded.member_role,
    status = excluded.status,
    is_default = excluded.is_default,
    updated_at = now();

insert into public.portal_organization_membership (
  profile_id, organization_id, workspace, member_role, status, is_default
)
select profile.id, organization.id, 'brand', 'brand_viewer',
  case when profile.active then 'active' else 'disabled' end,
  true
from public.portal_profile as profile
join public.portal_organization as organization
  on organization.kind = 'brand'
 and lower(organization.legal_name) = lower(profile.org)
where profile.role = 'brand'
on conflict (profile_id, organization_id, workspace) do update
set member_role = excluded.member_role,
    status = excluded.status,
    is_default = excluded.is_default,
    updated_at = now();

create or replace function public.portal_my_workspaces()
returns table (
  membership_id uuid,
  organization_id uuid,
  organization_kind text,
  organization_name text,
  workspace text,
  member_role text,
  is_default boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select membership.id,
    organization.id,
    organization.kind,
    organization.display_name,
    membership.workspace,
    membership.member_role,
    membership.is_default
  from public.portal_organization_membership as membership
  join public.portal_organization as organization
    on organization.id = membership.organization_id
  join public.portal_profile as profile
    on profile.id = membership.profile_id
  where membership.profile_id = (select auth.uid())
    and (select auth.jwt()->>'aal') = 'aal2'
    and membership.status = 'active'
    and organization.status = 'active'
    and profile.active is true
  order by membership.is_default desc,
    case membership.workspace when 'internal' then 1 when 'brand' then 2 else 3 end,
    organization.display_name;
$$;

revoke all on function public.portal_my_workspaces() from public, anon;
grant execute on function public.portal_my_workspaces() to authenticated, service_role;

comment on table public.portal_organization is
  'Shared organization identity for the Internal, Brand, and Store workspaces. It does not replace source-system identities.';
comment on table public.portal_organization_membership is
  'Server-authoritative workspace membership. Navigation is a projection of this scope, never the access-control boundary.';
comment on table public.portal_brand_account is
  'Verified links between a Brand portal organization and its Canix, Monday, and optional QuickBooks identities.';
comment on function public.portal_my_workspaces() is
  'Returns only the active signed-in user workspaces and organization scopes.';
