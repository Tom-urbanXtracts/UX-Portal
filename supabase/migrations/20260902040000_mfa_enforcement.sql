-- Require a Supabase Auth aal2 session everywhere the browser can obtain a
-- portal profile or capability. UI checks are intentionally not trusted.

create or replace function public.portal_mfa_verified()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

revoke all on function public.portal_mfa_verified() from public, anon;
grant execute on function public.portal_mfa_verified() to authenticated, service_role;

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
    and active
    and public.portal_mfa_verified();
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
    and active
    and public.portal_mfa_verified();
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
    and profile.role = 'internal'
    and public.portal_mfa_verified();
$$;

revoke all on function public.portal_role() from public, anon;
revoke all on function public.portal_org() from public, anon;
revoke all on function public.portal_my_permissions() from public, anon;
grant execute on function public.portal_role() to authenticated, service_role;
grant execute on function public.portal_org() to authenticated, service_role;
grant execute on function public.portal_my_permissions() to authenticated, service_role;

drop policy if exists portal_profile_mfa_required on public.portal_profile;
create policy portal_profile_mfa_required
on public.portal_profile
as restrictive
for all
to authenticated
using (public.portal_mfa_verified())
with check (public.portal_mfa_verified());

drop policy if exists portal_pending_profile_mfa_required on public.portal_pending_profile;
create policy portal_pending_profile_mfa_required
on public.portal_pending_profile
as restrictive
for all
to authenticated
using (public.portal_mfa_verified())
with check (public.portal_mfa_verified());

comment on function public.portal_mfa_verified() is
  'True only for Auth sessions verified at aal2 (or the server-only service role).';
comment on policy portal_profile_mfa_required on public.portal_profile is
  'Restrictive MFA boundary applied in addition to the existing self and organization policies.';
comment on policy portal_pending_profile_mfa_required on public.portal_pending_profile is
  'Restrictive MFA boundary for direct pending-profile access.';
