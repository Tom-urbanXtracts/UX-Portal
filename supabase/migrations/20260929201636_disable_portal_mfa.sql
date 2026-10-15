-- Remove the portal-wide TOTP/AAL2 requirement. Authentication remains
-- mandatory, and all existing active-profile, role, organization, workspace,
-- capability, and row-level data boundaries remain in force.

begin;

drop policy if exists portal_profile_mfa_required on public.portal_profile;
drop policy if exists portal_pending_profile_mfa_required on public.portal_pending_profile;

create or replace function public.portal_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role
  from public.portal_profile
  where id = auth.uid()
    and active;
$$;

create or replace function public.portal_org()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select org
  from public.portal_profile
  where id = auth.uid()
    and active;
$$;

create or replace function public.portal_my_permissions()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(rp.permission order by rp.permission), array[]::text[])
  from public.portal_profile as profile
  join public.portal_role_permission as rp
    on rp.staff_role = profile.staff_role
  where profile.id = auth.uid()
    and profile.active is true
    and profile.role = 'internal';
$$;

revoke all on function public.portal_role() from public, anon;
revoke all on function public.portal_org() from public, anon;
revoke all on function public.portal_my_permissions() from public, anon;
grant execute on function public.portal_role() to authenticated, service_role;
grant execute on function public.portal_org() to authenticated, service_role;
grant execute on function public.portal_my_permissions() to authenticated, service_role;

drop policy if exists portal_organization_member_select on public.portal_organization;
create policy portal_organization_member_select
on public.portal_organization
for select
to authenticated
using (
  (select public.portal_role()) = 'internal'
  or exists (
    select 1
    from public.portal_organization_membership as membership
    where membership.organization_id = portal_organization.id
      and membership.profile_id = (select auth.uid())
      and membership.status = 'active'
  )
);

drop policy if exists portal_organization_membership_self_select
  on public.portal_organization_membership;
create policy portal_organization_membership_self_select
on public.portal_organization_membership
for select
to authenticated
using (
  profile_id = (select auth.uid())
  or (select public.portal_role()) = 'internal'
);

drop policy if exists portal_brand_account_member_select on public.portal_brand_account;
create policy portal_brand_account_member_select
on public.portal_brand_account
for select
to authenticated
using (
  (select public.portal_role()) = 'internal'
  or exists (
    select 1
    from public.portal_organization_membership as membership
    where membership.organization_id = portal_brand_account.organization_id
      and membership.profile_id = (select auth.uid())
      and membership.workspace = 'brand'
      and membership.status = 'active'
  )
);

drop policy if exists portal_workspace_role_permission_member_select
  on public.portal_workspace_role_permission;
create policy portal_workspace_role_permission_member_select
on public.portal_workspace_role_permission
for select
to authenticated
using (
  exists (
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
    and membership.status = 'active'
    and organization.status = 'active'
    and profile.active is true
  order by membership.is_default desc,
    case membership.workspace when 'internal' then 1 when 'brand' then 2 else 3 end,
    organization.display_name;
$$;

revoke all on function public.portal_my_workspaces() from public, anon;
grant execute on function public.portal_my_workspaces() to authenticated, service_role;

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
    and profile.active is true;
$$;

revoke all on function public.portal_my_workspace_permissions(uuid)
  from public, anon;
grant execute on function public.portal_my_workspace_permissions(uuid)
  to authenticated, service_role;

comment on function public.portal_my_workspaces() is
  'Returns active workspaces for the authenticated user; role and organization scope remain server-authoritative.';
comment on function public.portal_my_workspace_permissions(uuid) is
  'Returns permissions for one active Brand membership owned by the authenticated user; cross-organization requests return an empty array.';

drop function if exists public.portal_mfa_verified();

commit;
