create or replace function public.portal_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.portal_profile
  where id = auth.uid() and active;
$$;

create or replace function public.portal_org()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select org
  from public.portal_profile
  where id = auth.uid() and active;
$$;

revoke all on function public.portal_role() from public, anon;
revoke all on function public.portal_org() from public, anon;
grant execute on function public.portal_role() to authenticated, service_role;
grant execute on function public.portal_org() to authenticated, service_role;

grant select on table public.portal_profile to authenticated;
grant update (full_name) on table public.portal_profile to authenticated;
grant all on table public.portal_profile to service_role;

create policy portal_profile_self_select
on public.portal_profile
for select
to authenticated
using (id = auth.uid());

create policy portal_profile_org_select
on public.portal_profile
for select
to authenticated
using (
  public.portal_role() = 'internal'
  or (public.portal_role() = 'owner' and org = public.portal_org())
);

create policy portal_profile_self_name_update
on public.portal_profile
for update
to authenticated
using (id = auth.uid())
with check (
  id = auth.uid()
  and role = public.portal_role()
  and org = public.portal_org()
);

