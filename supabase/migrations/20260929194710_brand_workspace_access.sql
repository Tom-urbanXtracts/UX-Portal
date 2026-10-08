-- Brand-workspace authorization is membership-scoped and deliberately kept
-- outside mutable Auth user metadata. The browser may use these permissions
-- to shape navigation, but every protected write still re-checks the current
-- membership and permission on the server.

create table if not exists public.portal_workspace_role_permission (
  workspace text not null check (workspace in ('brand')),
  member_role text not null check (member_role in (
    'brand_owner', 'brand_manager', 'brand_contributor', 'brand_viewer'
  )),
  permission text not null check (permission in (
    'brand.company.read',
    'brand.company.manage',
    'brand.agreements.read',
    'brand.agreements.manage',
    'brand.products.read',
    'brand.products.contribute',
    'brand.purchase_orders.read',
    'brand.purchase_orders.acknowledge',
    'brand.manufacturing.read',
    'brand.manufacturing.contribute',
    'brand.inventory.read',
    'brand.sales.read',
    'brand.financials.read',
    'brand.marketing.read',
    'brand.marketing.contribute',
    'brand.documents.read',
    'brand.documents.contribute',
    'brand.users.read',
    'brand.users.manage'
  )),
  primary key (workspace, member_role, permission)
);

insert into public.portal_workspace_role_permission (
  workspace, member_role, permission
)
select 'brand', role_name, permission_name
from unnest(array[
  'brand_owner', 'brand_manager'
]::text[]) as roles(role_name)
cross join unnest(array[
  'brand.company.read', 'brand.company.manage',
  'brand.agreements.read', 'brand.agreements.manage',
  'brand.products.read', 'brand.products.contribute',
  'brand.purchase_orders.read', 'brand.purchase_orders.acknowledge',
  'brand.manufacturing.read', 'brand.manufacturing.contribute',
  'brand.inventory.read', 'brand.sales.read', 'brand.financials.read',
  'brand.marketing.read', 'brand.marketing.contribute',
  'brand.documents.read', 'brand.documents.contribute',
  'brand.users.read', 'brand.users.manage'
]::text[]) as permissions(permission_name)
on conflict (workspace, member_role, permission) do nothing;

insert into public.portal_workspace_role_permission (
  workspace, member_role, permission
)
select 'brand', 'brand_contributor', permission_name
from unnest(array[
  'brand.company.read',
  'brand.products.read', 'brand.products.contribute',
  'brand.purchase_orders.read', 'brand.purchase_orders.acknowledge',
  'brand.manufacturing.read', 'brand.manufacturing.contribute',
  'brand.inventory.read', 'brand.sales.read',
  'brand.marketing.read', 'brand.marketing.contribute',
  'brand.documents.read', 'brand.documents.contribute'
]::text[]) as permissions(permission_name)
on conflict (workspace, member_role, permission) do nothing;

insert into public.portal_workspace_role_permission (
  workspace, member_role, permission
)
select 'brand', 'brand_viewer', permission_name
from unnest(array[
  'brand.company.read', 'brand.products.read',
  'brand.purchase_orders.read', 'brand.manufacturing.read',
  'brand.inventory.read', 'brand.sales.read',
  'brand.marketing.read', 'brand.documents.read'
]::text[]) as permissions(permission_name)
on conflict (workspace, member_role, permission) do nothing;

alter table public.portal_workspace_role_permission enable row level security;

revoke all on table public.portal_workspace_role_permission
  from public, anon, authenticated;
grant select on table public.portal_workspace_role_permission to authenticated;
grant all on table public.portal_workspace_role_permission to service_role;

create policy portal_workspace_role_permission_member_select
on public.portal_workspace_role_permission
for select
to authenticated
using (
  (select auth.jwt()->>'aal') = 'aal2'
  and exists (
    select 1
    from public.portal_organization_membership as membership
    join public.portal_profile as profile
      on profile.id = membership.profile_id
    where membership.profile_id = (select auth.uid())
      and membership.workspace = portal_workspace_role_permission.workspace
      and membership.status = 'active'
      and profile.active is true
  )
);

create or replace function public.portal_my_workspace_permissions(
  p_organization_id uuid
)
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    array_agg(permission.permission order by permission.permission),
    array[]::text[]
  )
  from public.portal_organization_membership as membership
  join public.portal_profile as profile
    on profile.id = membership.profile_id
  join public.portal_workspace_role_permission as permission
    on permission.workspace = membership.workspace
   and permission.member_role = membership.member_role
  where membership.profile_id = (select auth.uid())
    and membership.organization_id = p_organization_id
    and membership.workspace = 'brand'
    and membership.status = 'active'
    and profile.active is true
    and (select auth.jwt()->>'aal') = 'aal2';
$$;

revoke all on function public.portal_my_workspace_permissions(uuid)
  from public, anon;
grant execute on function public.portal_my_workspace_permissions(uuid)
  to authenticated, service_role;

comment on table public.portal_workspace_role_permission is
  'Server-owned Brand role matrix. Role labels never grant access without an active organization membership.';
comment on function public.portal_my_workspace_permissions(uuid) is
  'Returns the current aal2 user permissions for one active Brand membership; cross-organization requests return an empty array.';
