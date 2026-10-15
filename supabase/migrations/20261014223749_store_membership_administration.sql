-- Prepared, service-only administration. No Auth/profile updates or mail.
create table public.portal_store_membership_change (
  id uuid primary key,
  actor_id uuid not null references public.portal_profile(id),
  organization_id uuid not null references public.portal_organization(id),
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.portal_store_membership_change enable row level security;
revoke all on public.portal_store_membership_change from public,anon,authenticated;
grant select,insert on public.portal_store_membership_change to service_role;

create function public.portal_manage_store_membership(
  p_actor_id uuid,p_actor_membership_id uuid,p_organization_id uuid,p_profile_id uuid,
  p_membership_id uuid,p_member_role text,p_licenses text[],p_status text,
  p_expected_updated_at timestamptz,p_reason text,p_request_id uuid,
  p_verified_identities jsonb,p_verified_at timestamptz
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare target portal_organization_membership; account_id uuid; before_value jsonb;
  licenses text[]; fingerprint text; prior portal_store_membership_change; response jsonb; member_id uuid;
begin
  perform 1 from portal_store_access_control where id and enabled for share;
  if not found then raise exception 'Live Store access remains held' using errcode='42501'; end if;
  perform 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
    join portal_organization o on o.id=m.organization_id
    where m.id=p_actor_membership_id and m.profile_id=p_actor_id and m.workspace='internal'
      and m.member_role='administrator' and m.status='active' and p.active and o.kind='internal' and o.status='active'
    for share of m,p,o;
  if not found then raise exception 'Current Internal Administrator membership required' using errcode='42501'; end if;
  perform 1 from portal_role_permission where staff_role='administrator' and permission='users.manage' for share;
  if not found then raise exception 'User administration authority required' using errcode='42501'; end if;
  if p_actor_id=p_profile_id or p_request_id is null or nullif(btrim(p_reason),'') is null or length(p_reason)>1000
    or p_status is null or p_status not in ('active','disabled')
    or p_member_role is null or p_member_role not in ('store_owner','store_buyer','store_staff') then
    raise exception 'An explicit role, status, reason and non-self target are required' using errcode='22023';
  end if;
  -- One person cannot gain concurrent membership of two retailer organizations.
  perform pg_advisory_xact_lock(hashtextextended('store-person:'||p_profile_id,0));
  perform pg_advisory_xact_lock(hashtextextended('store-membership:'||p_organization_id,0));
  select legacy_retailer_account_id into account_id from portal_organization
    where id=p_organization_id and kind='retailer' and status='active' for share;
  if account_id is null then raise exception 'Verified active retailer required' using errcode='42501'; end if;
  perform 1 from portal_profile where id=p_profile_id and active for share;
  if not found then raise exception 'An active existing portal identity is required' using errcode='42501'; end if;
  select coalesce(array_agg(distinct v order by v),'{}'::text[]) into licenses from unnest(coalesce(p_licenses,'{}')) v;
  if cardinality(licenses)<>cardinality(coalesce(p_licenses,'{}')) then
    raise exception 'Duplicate location assignments are not allowed' using errcode='22023'; end if;
  fingerprint:=md5(jsonb_build_object('actor',p_actor_id,'org',p_organization_id,'profile',p_profile_id,
    'membership',p_membership_id,'role',p_member_role,'licenses',licenses,'status',p_status,
    'expected',p_expected_updated_at,'reason',btrim(p_reason))::text);
  select * into prior from portal_store_membership_change where id=p_request_id;
  if found then
    if prior.actor_id<>p_actor_id or prior.organization_id<>p_organization_id or prior.fingerprint<>fingerprint then
      raise exception 'Request identifier reused with different access changes' using errcode='40001'; end if;
    return prior.result||jsonb_build_object('idempotent',true);
  end if;
  if p_verified_at is null or p_verified_at>clock_timestamp()+interval '2 seconds'
    or p_verified_at<clock_timestamp()-interval '30 seconds' or jsonb_typeof(p_verified_identities) is distinct from 'array' then
    raise exception 'Fresh server identity verification required' using errcode='40001'; end if;
  if p_status='active' and not exists(select 1 from jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date)
    where v.id=p_profile_id and v.eligible and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Target identity is expired or unavailable' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date)
    where v.id=p_actor_id and v.eligible and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Administrator identity is expired or unavailable' using errcode='42501'; end if;
  select * into target from portal_organization_membership where profile_id=p_profile_id and organization_id=p_organization_id and workspace='store' for update;
  if found then
    if p_membership_id is distinct from target.id or p_expected_updated_at is distinct from target.updated_at then
      raise exception 'Membership changed; reload before saving' using errcode='40001'; end if;
  elsif p_membership_id is not null or p_expected_updated_at is not null or p_status<>'active' then
    raise exception 'Membership target requires review' using errcode='40001';
  end if;
  if p_status='active' and exists(select 1 from portal_organization_membership where profile_id=p_profile_id
    and workspace='store' and status in ('active','invited') and organization_id<>p_organization_id) then
    raise exception 'This person already belongs to another retailer' using errcode='23514'; end if;
  if p_status='active' and ((p_member_role='store_owner' and cardinality(licenses)<>0)
    or (p_member_role='store_buyer' and cardinality(licenses) not between 1 and 25)
    or (p_member_role='store_staff' and cardinality(licenses)<>1)) then
    raise exception 'Owner uses all stores; Buyer needs assignments; Budtender needs exactly one' using errcode='23514'; end if;
  perform 1 from portal_store where license_number=any(licenses) for share;
  if exists(select 1 from unnest(licenses) v where not exists(select 1 from portal_store s
    where s.license_number=v and s.retailer_account_id=account_id and s.active and s.closed_at is null)) then
    raise exception 'Location is outside the active retailer scope' using errcode='42501'; end if;
  -- Serialize Owner changes and consider current Auth eligibility, not merely
  -- a still-active profile belonging to an expired contractor.
  perform 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
    where m.organization_id=p_organization_id and m.workspace='store' and m.member_role='store_owner' and m.status='active'
    for share of m,p;
  if target.member_role='store_owner' and target.status='active' and (p_member_role<>'store_owner' or p_status<>'active')
    and not exists(select 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
      join jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date) on v.id=m.profile_id
      where m.organization_id=p_organization_id and m.workspace='store' and m.member_role='store_owner' and m.status='active'
        and p.active and m.id<>target.id and v.eligible
        and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Add an eligible replacement Owner before removing or demoting this Owner' using errcode='23514'; end if;
  before_value:=case when target.id is null then null else to_jsonb(target)||jsonb_build_object('licenses',
    (select coalesce(jsonb_agg(license_number order by license_number),'[]') from portal_membership_store where membership_id=target.id)) end;
  member_id:=coalesce(target.id,gen_random_uuid());
  -- Remove old assignments before a role change; none are inferred from names.
  delete from portal_membership_store where membership_id=member_id;
  if target.id is null then
    insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status,is_default)
      values(member_id,p_profile_id,p_organization_id,'store',p_member_role,p_status,false);
  else
    update portal_organization_membership set member_role=p_member_role,status=p_status,
      is_default=case when p_status='disabled' then false else is_default end,updated_at=clock_timestamp() where id=member_id;
  end if;
  if p_status='active' then
    insert into portal_membership_store(membership_id,license_number) select member_id,v from unnest(licenses) v;
  end if;
  response:=jsonb_build_object('membershipId',member_id,'organizationId',p_organization_id,'profileId',p_profile_id,
    'memberRole',p_member_role,'status',p_status,'licenses',case when p_status='active' then to_jsonb(licenses) else '[]'::jsonb end,
    'globalAccountChanged',false,'emailSent',false);
  insert into portal_admin_audit(actor_id,action,target_id,detail) values(p_actor_id,'manage-store-membership',p_profile_id,
    jsonb_build_object('actorMembershipId',p_actor_membership_id,'organizationId',p_organization_id,'membershipId',member_id,
      'before',before_value,'after',response,'reason',btrim(p_reason),'requestId',p_request_id));
  insert into portal_store_membership_change(id,actor_id,organization_id,fingerprint,result)
    values(p_request_id,p_actor_id,p_organization_id,fingerprint,response);
  return response;
end $$;
revoke all on function public.portal_manage_store_membership(uuid,uuid,uuid,uuid,uuid,text,text[],text,timestamptz,text,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.portal_manage_store_membership(uuid,uuid,uuid,uuid,uuid,text,text[],text,timestamptz,text,uuid,jsonb,timestamptz) to service_role;
