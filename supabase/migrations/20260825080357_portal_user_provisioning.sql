create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pending public.portal_pending_profile;
begin
  select * into pending
  from public.portal_pending_profile
  where email = lower(new.email)
  limit 1;

  insert into public.portal_profile (id, full_name, org, role, locations)
  values (
    new.id,
    coalesce(
      pending.full_name,
      new.raw_user_meta_data ->> 'full_name',
      split_part(new.email, '@', 1)
    ),
    coalesce(pending.org, new.raw_user_meta_data ->> 'org', 'Unassigned'),
    coalesce(
      pending.role,
      case
        when coalesce(new.raw_user_meta_data ->> 'role', '') in (
          'owner', 'buyer', 'budtender', 'internal'
        ) then new.raw_user_meta_data ->> 'role'
        else 'budtender'
      end
    ),
    coalesce(pending.locations, new.raw_user_meta_data ->> 'locations')
  )
  on conflict (id) do nothing;

  if pending.email is not null then
    delete from public.portal_pending_profile where email = pending.email;
  end if;

  return new;
end;
$$;

revoke all on function public.handle_new_portal_user() from public, anon, authenticated;
grant execute on function public.handle_new_portal_user() to service_role;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_portal_user();

