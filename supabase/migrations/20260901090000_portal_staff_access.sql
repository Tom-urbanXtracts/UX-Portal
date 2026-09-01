-- Workforce access is separate from the external owner/buyer/budtender roles.
-- Existing internal users become viewers so this migration does not
-- unexpectedly lock out the team or silently grant administrative access.
-- The first administrator must be assigned explicitly during the controlled
-- deployment, and new internal profiles require an explicit staff role.

alter table public.portal_profile
  add column if not exists staff_role text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.portal_profile'::regclass
      and conname = 'portal_profile_staff_role_check'
  ) then
    alter table public.portal_profile
      add constraint portal_profile_staff_role_check
      check (
        (role = 'internal' and staff_role in ('administrator', 'operations', 'sales', 'quality', 'viewer'))
        or (role <> 'internal' and staff_role is null)
      ) not valid;
  end if;
end
$$;

update public.portal_profile
set staff_role = 'viewer'
where role = 'internal'
  and staff_role is null;

update public.portal_profile
set staff_role = null
where role <> 'internal'
  and staff_role is not null;

alter table public.portal_profile
  validate constraint portal_profile_staff_role_check;

create table if not exists public.portal_role_permission (
  staff_role text not null check (staff_role in ('administrator', 'operations', 'sales', 'quality', 'viewer')),
  permission text not null check (permission in (
    'inventory.read',
    'inventory.sync',
    'orders.manage',
    'accounts.manage',
    'quality.manage',
    'lineage.read',
    'users.manage',
    'audit.read',
    'readiness.read'
  )),
  primary key (staff_role, permission)
);

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'inventory.read'),
  ('administrator', 'inventory.sync'),
  ('administrator', 'orders.manage'),
  ('administrator', 'accounts.manage'),
  ('administrator', 'quality.manage'),
  ('administrator', 'lineage.read'),
  ('administrator', 'users.manage'),
  ('administrator', 'audit.read'),
  ('administrator', 'readiness.read'),
  ('operations', 'inventory.read'),
  ('operations', 'inventory.sync'),
  ('operations', 'orders.manage'),
  ('operations', 'accounts.manage'),
  ('operations', 'lineage.read'),
  ('operations', 'readiness.read'),
  ('sales', 'inventory.read'),
  ('sales', 'orders.manage'),
  ('sales', 'accounts.manage'),
  ('sales', 'lineage.read'),
  ('quality', 'inventory.read'),
  ('quality', 'quality.manage'),
  ('quality', 'lineage.read'),
  ('quality', 'audit.read'),
  ('quality', 'readiness.read'),
  ('viewer', 'inventory.read'),
  ('viewer', 'lineage.read')
on conflict (staff_role, permission) do nothing;

alter table public.portal_role_permission enable row level security;

revoke all on table public.portal_role_permission from anon, authenticated;
grant all on table public.portal_role_permission to service_role;

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

revoke all on function public.portal_my_permissions() from public, anon;
grant execute on function public.portal_my_permissions() to authenticated, service_role;

comment on column public.portal_profile.staff_role is
  'Internal workforce preset. External owner/buyer/budtender authorization remains in role, org, and locations.';
comment on table public.portal_role_permission is
  'Server-owned mapping from workforce presets to portal capabilities.';
comment on function public.portal_my_permissions() is
  'Returns only the active signed-in workforce user permissions used by the portal UI and server endpoints.';
