-- Prepared foundation only. No endpoint or legacy assignment is migrated here.
-- Keep disabled until all Store consumers and transaction boundaries use it.
create table public.portal_store_access_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.portal_store_access_control(id, enabled) values (true, false);

create table public.portal_membership_store (
  membership_id uuid not null references public.portal_organization_membership(id),
  license_number text not null references public.portal_store(license_number),
  created_at timestamptz not null default now(),
  primary key (membership_id, license_number)
);
alter table public.portal_store_access_control enable row level security;
alter table public.portal_membership_store enable row level security;
revoke all on public.portal_store_access_control, public.portal_membership_store from public, anon, authenticated;
grant select, insert, update on public.portal_store_access_control to service_role;
grant select, insert, update, delete on public.portal_membership_store to service_role;

create function public.portal_check_membership_store()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare m portal_organization_membership; account_id uuid; store_account uuid;
begin
  select * into m from portal_organization_membership where id=new.membership_id for update;
  select legacy_retailer_account_id into account_id from portal_organization
    where id=m.organization_id and kind='retailer';
  select retailer_account_id into store_account from portal_store where license_number=new.license_number;
  if m.workspace is distinct from 'store' or m.member_role not in ('store_owner','store_buyer','store_staff')
    or account_id is null or account_id is distinct from store_account then
    raise exception 'Store assignment is outside the membership organization' using errcode='42501';
  end if;
  if m.member_role='store_staff' and exists(select 1 from portal_membership_store
    where membership_id=new.membership_id and license_number<>new.license_number) then
    raise exception 'Budtender membership may have only one Store' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.portal_check_membership_store() from public, anon, authenticated;
create trigger portal_membership_store_scope before insert or update on public.portal_membership_store
  for each row execute function public.portal_check_membership_store();

-- Caller ID must come from server-validated Auth, never from request JSON.
-- Auth expiration is checked by store-context.ts from the Auth service response;
-- do not grant this service role direct auth.users access to implement it.
-- One database statement supplies the current membership and assignment snapshot.
create function public.portal_resolve_store_context(p_actor_id uuid, p_membership_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare m portal_organization_membership; o portal_organization; licenses jsonb;
begin
  if not exists(select 1 from portal_store_access_control where id and enabled) then
    raise exception 'Live Store access remains held' using errcode='42501';
  end if;
  if not exists(select 1 from portal_profile where id=p_actor_id and active) then
    raise exception 'Active identity required' using errcode='42501';
  end if;
  select * into m from portal_organization_membership where id=p_membership_id
    and profile_id=p_actor_id and workspace='store' and status='active';
  if not found or m.member_role not in ('store_owner','store_buyer','store_staff') then
    raise exception 'Active Store membership required' using errcode='42501';
  end if;
  select * into o from portal_organization where id=m.organization_id and kind='retailer' and status='active';
  if not found or o.legacy_retailer_account_id is null then
    raise exception 'Verified retailer organization required' using errcode='42501';
  end if;
  if exists(select 1 from portal_membership_store a join portal_store s using(license_number)
    where a.membership_id=m.id and s.retailer_account_id is distinct from o.legacy_retailer_account_id) then
    raise exception 'Store assignments require reconciliation' using errcode='42501';
  end if;
  if m.member_role='store_staff' and (select count(*) from portal_membership_store where membership_id=m.id)<>1 then
    raise exception 'Budtender requires exactly one Store assignment' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(s.license_number order by s.license_number),'[]') into licenses
  from portal_store s where s.retailer_account_id=o.legacy_retailer_account_id and s.active and s.closed_at is null
    and (m.member_role='store_owner' or exists(select 1 from portal_membership_store a
      where a.membership_id=m.id and a.license_number=s.license_number));
  return jsonb_build_object('actorId',p_actor_id,'membershipId',m.id,'organizationId',o.id,
    'retailerAccountId',o.legacy_retailer_account_id,'memberRole',m.member_role,'licenses',licenses);
end $$;
revoke all on function public.portal_resolve_store_context(uuid,uuid) from public, anon, authenticated;
grant execute on function public.portal_resolve_store_context(uuid,uuid) to service_role;

-- Atomic membership-only revocation. This deliberately never changes Auth,
-- global profile state, other workspaces, legacy assignments, or sends email.
create function public.portal_revoke_store_membership(p_actor_id uuid, p_actor_membership_id uuid, p_target_membership_id uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare target portal_organization_membership; actor portal_organization_membership; context jsonb; previous_status text;
begin
  if not exists(select 1 from portal_store_access_control where id and enabled) then
    raise exception 'Live Store access remains held' using errcode='42501';
  end if;
  if nullif(btrim(p_reason),'') is null or length(p_reason)>1000 then
    raise exception 'A reason of 1 through 1000 characters is required' using errcode='22023';
  end if;
  select * into target from portal_organization_membership where id=p_target_membership_id and workspace='store';
  if not found then raise exception 'Store membership unavailable' using errcode='42501'; end if;
  -- Serialize removals of different Owners of the same retailer.
  perform pg_advisory_xact_lock(hashtextextended('store-membership:'||target.organization_id,0));
  select * into target from portal_organization_membership where id=p_target_membership_id for update;
  if target.profile_id=p_actor_id then raise exception 'Self-deactivation is not permitted' using errcode='42501'; end if;
  select m.* into actor from portal_organization_membership m
    join portal_profile p on p.id=m.profile_id join portal_organization o on o.id=m.organization_id
    where m.id=p_actor_membership_id and m.profile_id=p_actor_id and m.status='active' and p.active and o.status='active'
      and ((m.workspace='internal' and o.kind='internal') or (m.workspace='store' and o.kind='retailer'))
    for share of m,p,o;
  if not found then raise exception 'Active actor membership required' using errcode='42501'; end if;
  if actor.workspace='internal' and actor.member_role='administrator' then
    if not exists(select 1 from portal_profile where id=p_actor_id and role='internal' and staff_role='administrator') then
      raise exception 'Internal Administrator required' using errcode='42501';
    end if;
    perform 1 from portal_role_permission where staff_role='administrator' and permission='users.manage' for share;
    if not found then raise exception 'User administration authority required' using errcode='42501'; end if;
  elsif actor.workspace='store' and actor.member_role='store_owner' and actor.organization_id=target.organization_id
    and target.member_role in ('store_buyer','store_staff') then
    context:=portal_resolve_store_context(p_actor_id,p_actor_membership_id);
  else
    raise exception 'Membership administration is outside your scope' using errcode='42501';
  end if;
  if target.member_role='store_owner' and target.status='active' and not exists(
    select 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
    where m.organization_id=target.organization_id and m.workspace='store' and m.member_role='store_owner'
      and m.status='active' and p.active and m.id<>target.id
  ) then raise exception 'The last active Store Owner cannot be removed' using errcode='23514'; end if;
  previous_status:=target.status;
  if previous_status<>'disabled' then
    update portal_organization_membership set status='disabled',is_default=false,updated_at=now() where id=target.id;
    insert into portal_admin_audit(actor_id,action,target_id,detail) values(p_actor_id,'revoke-store-membership',target.profile_id,
      jsonb_build_object('membershipId',target.id,'organizationId',target.organization_id,
        'actorMembershipId',actor.id,'previousStatus',previous_status,'reason',btrim(p_reason),'globalAccountChanged',false));
  end if;
  return jsonb_build_object('membershipId',target.id,'status','disabled','changed',previous_status<>'disabled');
end $$;
revoke all on function public.portal_revoke_store_membership(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.portal_revoke_store_membership(uuid,uuid,uuid,text) to service_role;
