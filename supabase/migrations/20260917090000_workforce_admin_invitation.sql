-- A workforce Administrator may grant another urbanXtracts account the
-- Administrator preset. The profile change and audit entry are one transaction.
-- The Edge Function authenticates the caller with an AAL2 session; this RPC
-- independently rechecks the caller and the target's Auth email.

create or replace function public.portal_grant_workforce_administrator(
  p_actor_id uuid,
  p_target_id uuid,
  p_full_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.portal_profile%rowtype;
  target public.portal_profile%rowtype;
  target_email text;
begin
  select * into actor
  from public.portal_profile
  where id = p_actor_id;

  if not found or actor.active is not true or actor.role <> 'internal'
    or actor.staff_role <> 'administrator' then
    raise exception 'Only an active workforce Administrator may grant Administrator access';
  end if;

  select lower(email) into target_email
  from auth.users
  where id = p_target_id;

  if target_email is null
    or target_email !~ '^[^@[:space:]]+@urbanxtracts[.]com$' then
    raise exception 'Administrator access requires an urbanxtracts.com account';
  end if;

  select * into target
  from public.portal_profile
  where id = p_target_id
  for update;

  if found then
    if target.active is not true or target.role <> 'internal'
      or coalesce(lower(target.org), '') <> 'urbanxtracts' then
      raise exception 'An existing retailer or deactivated account cannot become a workforce Administrator';
    end if;
    if target.staff_role = 'administrator' then
      raise exception 'This account already has Administrator access';
    end if;
    update public.portal_profile
    set staff_role = 'administrator'
    where id = p_target_id;
  else
    insert into public.portal_profile (
      id, full_name, org, role, locations, active, staff_role
    ) values (
      p_target_id,
      coalesce(nullif(left(trim(p_full_name), 160), ''), split_part(target_email, '@', 1)),
      'urbanXtracts', 'internal', 'Assigned accounts', true, 'administrator'
    );
  end if;

  insert into public.portal_admin_audit (
    actor_id, actor_org, action, target_id, target_email, target_org, detail
  ) values (
    p_actor_id, actor.org, 'grant-workforce-administrator',
    p_target_id, target_email, 'urbanXtracts',
    jsonb_build_object('staffRole', 'administrator', 'source', 'Users and access')
  );
end;
$$;

revoke all on function public.portal_grant_workforce_administrator(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_grant_workforce_administrator(uuid, uuid, text)
  to service_role;

comment on function public.portal_grant_workforce_administrator(uuid, uuid, text) is
  'Atomically grants the workforce Administrator preset and records the actor; callable only by the server service role.';
