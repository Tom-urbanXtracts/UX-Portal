drop policy if exists portal_profile_self_select on public.portal_profile;
drop policy if exists portal_profile_org_select on public.portal_profile;
drop policy if exists portal_profile_self_name_update on public.portal_profile;

-- One read policy avoids evaluating two permissive policies for every row.
-- SELECT wrappers let Postgres initialize the identity helpers once per query.
create policy portal_profile_read
on public.portal_profile
for select
to authenticated
using (
  id = (select auth.uid())
  or (select public.portal_role()) = 'internal'
  or (
    (select public.portal_role()) = 'owner'
    and org = (select public.portal_org())
  )
);

create policy portal_profile_self_name_update
on public.portal_profile
for update
to authenticated
using (id = (select auth.uid()))
with check (
  id = (select auth.uid())
  and role = (select public.portal_role())
  and org = (select public.portal_org())
);
