-- Production migration version: 20261008164743.
-- Restore the authenticated identity RPC surface used by the browser portal.
-- The underlying helper functions were moved to the private schema for
-- hardening, but PostgREST only exposes the public API schema. These functions
-- reveal only the signed-in user's own role, organisation and permissions.

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

comment on function public.portal_my_permissions() is
  'PostgREST-compatible authenticated RPC returning only the active signed-in workforce user permissions.';
