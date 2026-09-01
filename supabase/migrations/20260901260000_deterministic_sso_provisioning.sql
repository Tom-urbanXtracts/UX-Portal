-- Use one deterministic auth-user provisioning path. The original external
-- retailer trigger ran before the later workforce trigger, so a first-time
-- @urbanxtracts.com SSO user could be inserted as an external budtender and
-- the least-privilege workforce insert would then lose its ON CONFLICT race.

drop trigger if exists portal_provision_workforce_viewer on auth.users;
drop function if exists public.portal_provision_workforce_viewer();

create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending public.portal_pending_profile;
  is_workforce boolean := lower(coalesce(new.email, '')) like '%@urbanxtracts.com';
begin
  if is_workforce then
    insert into public.portal_profile (
      id, full_name, org, role, locations, active, staff_role
    ) values (
      new.id,
      coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
        split_part(new.email, '@', 1)
      ),
      'urbanXtracts',
      'internal',
      'Assigned accounts',
      true,
      'viewer'
    )
    on conflict (id) do nothing;
  else
    select * into pending
    from public.portal_pending_profile
    where email = lower(new.email)
    limit 1;

    insert into public.portal_profile (
      id, full_name, org, role, locations, active, staff_role
    ) values (
      new.id,
      coalesce(
        pending.full_name,
        nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
        split_part(new.email, '@', 1)
      ),
      coalesce(pending.org, new.raw_user_meta_data ->> 'org', 'Unassigned'),
      coalesce(
        pending.role,
        case
          when coalesce(new.raw_user_meta_data ->> 'role', '') in (
            'owner', 'buyer', 'budtender'
          ) then new.raw_user_meta_data ->> 'role'
          else 'budtender'
        end
      ),
      coalesce(pending.locations, new.raw_user_meta_data ->> 'locations'),
      true,
      null
    )
    on conflict (id) do nothing;

    if pending.email is not null then
      delete from public.portal_pending_profile where email = pending.email;
    end if;
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

-- Repair employees created under the older trigger without overriding an
-- existing workforce preset or reactivating a deliberately disabled account.
update public.portal_profile as profile
set org = 'urbanXtracts',
    role = 'internal',
    locations = coalesce(nullif(trim(profile.locations), ''), 'Assigned accounts'),
    staff_role = coalesce(profile.staff_role, 'viewer'),
    updated_at = now()
from auth.users as auth_user
where auth_user.id = profile.id
  and lower(coalesce(auth_user.email, '')) like '%@urbanxtracts.com'
  and (
    profile.org <> 'urbanXtracts'
    or profile.role <> 'internal'
    or profile.staff_role is null
  );

-- RLS remains the row boundary; these grants also remove unnecessary table
-- operations from browser roles so policies are not the only line of defence.
revoke all on table public.portal_profile from anon, authenticated;
grant select on table public.portal_profile to authenticated;
grant update (full_name) on table public.portal_profile to authenticated;
grant all on table public.portal_profile to service_role;

revoke all on table public.portal_pending_profile from anon, authenticated;
grant select, insert, delete on table public.portal_pending_profile to authenticated;
grant all on table public.portal_pending_profile to service_role;

comment on function public.handle_new_portal_user() is
  'Provisions @urbanxtracts.com SSO users as active internal Viewers and external users from a one-time pending retailer profile.';

