-- Keep first-time Google Workspace provisioning aligned with the selected-
-- workspace authorization model. A workforce identity is usable only after
-- both its least-privilege profile and its Internal workspace membership exist.

create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending public.portal_pending_profile;
  internal_organization_id uuid;
  is_workforce boolean := lower(coalesce(new.email, '')) like '%@urbanxtracts.com';
begin
  if is_workforce then
    select organization.id
    into internal_organization_id
    from public.portal_organization as organization
    where organization.kind = 'internal'
      and organization.legal_name = 'urbanXtracts'
      and organization.status = 'active'
    order by organization.created_at
    limit 1;

    if internal_organization_id is null then
      raise exception 'Active urbanXtracts Internal organization is not configured';
    end if;

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

    insert into public.portal_organization_membership (
      profile_id, organization_id, workspace, member_role, status, is_default
    ) values (
      new.id,
      internal_organization_id,
      'internal',
      'viewer',
      'active',
      not exists (
        select 1
        from public.portal_organization_membership as existing_default
        where existing_default.profile_id = new.id
          and existing_default.status = 'active'
          and existing_default.is_default
      )
    )
    on conflict (profile_id, organization_id, workspace) do nothing;
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

-- Repair previously created workforce identities without changing an existing
-- role, reactivating a disabled profile, or replacing a chosen default. Resolve
-- the required organization before either write so a missing organization
-- fails the whole repair instead of leaving an orphaned profile behind.
create or replace function public.portal_repair_workforce_workspace_memberships()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  internal_organization_id uuid;
  repaired_memberships integer := 0;
begin
  select organization.id
  into internal_organization_id
  from public.portal_organization as organization
  where organization.kind = 'internal'
    and organization.legal_name = 'urbanXtracts'
    and organization.status = 'active'
  order by organization.created_at
  limit 1;

  if internal_organization_id is null then
    raise exception 'Active urbanXtracts Internal organization is not configured';
  end if;

  insert into public.portal_profile (
    id, full_name, org, role, locations, active, staff_role
  )
  select auth_user.id,
    coalesce(
      nullif(trim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
      split_part(auth_user.email, '@', 1)
    ),
    'urbanXtracts',
    'internal',
    'Assigned accounts',
    true,
    'viewer'
  from auth.users as auth_user
  where lower(coalesce(auth_user.email, '')) like '%@urbanxtracts.com'
  on conflict (id) do nothing;

  insert into public.portal_organization_membership (
    profile_id, organization_id, workspace, member_role, status, is_default
  )
  select profile.id,
    internal_organization_id,
    'internal',
    coalesce(profile.staff_role, 'viewer'),
    case when profile.active then 'active' else 'disabled' end,
    not exists (
      select 1
      from public.portal_organization_membership as existing_default
      where existing_default.profile_id = profile.id
        and existing_default.status = 'active'
        and existing_default.is_default
    )
  from public.portal_profile as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where lower(coalesce(auth_user.email, '')) like '%@urbanxtracts.com'
    and profile.role = 'internal'
  on conflict (profile_id, organization_id, workspace) do nothing;

  get diagnostics repaired_memberships = row_count;
  return repaired_memberships;
end;
$$;

revoke all on function public.portal_repair_workforce_workspace_memberships()
  from public, anon, authenticated;
grant execute on function public.portal_repair_workforce_workspace_memberships()
  to service_role;

select public.portal_repair_workforce_workspace_memberships();

comment on function public.handle_new_portal_user() is
  'Provision one least-privilege profile for every Auth user and an Internal Viewer workspace membership for urbanXtracts workforce identities.';

comment on function public.portal_repair_workforce_workspace_memberships() is
  'Repair missing workforce profiles and Internal memberships atomically; fail closed when the active Internal organization is unavailable.';
