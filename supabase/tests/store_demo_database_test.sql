-- Executes against the target schema; every fixture and state change rolls back.
begin;
do $$
declare admin_id uuid; denied_id uuid; account_id uuid:=gen_random_uuid(); result jsonb; i integer; org_name text:='Store cap acceptance '||gen_random_uuid();
begin
  select p.id into strict admin_id from portal_profile p where p.active and p.role='internal' and p.staff_role='administrator' and exists(
    select 1 from portal_organization_membership m join portal_organization o on o.id=m.organization_id
    where m.profile_id=p.id and m.workspace='internal' and m.member_role='administrator' and m.status='active' and o.status='active') limit 1;
  -- Pause denies mutation even for an authenticated Administrator.
  update portal_store_demo_control set enabled=false where id;
  begin
    perform portal_commit_store_demo(admin_id,0,'{}','reset');
    raise exception 'TEST FAILURE: pause allowed commit';
  exception when insufficient_privilege then null; end;
  update portal_store_demo_control set enabled=true where id;
  for denied_id in select id from portal_profile where not (active and role='internal' and staff_role='administrator') or staff_role is null loop
    begin
      perform portal_commit_store_demo(denied_id,0,'{}','reset');
      raise exception 'TEST FAILURE: non-Administrator allowed';
    exception when insufficient_privilege then null; end;
  end loop;
  -- Preserve existing demo revision if acceptance is rerun after use.
  select coalesce((select revision from portal_store_demo_session where actor_id=admin_id),0) into i;
  result:=portal_commit_store_demo(admin_id,i,'{"acceptanceFixture":true}','reset');
  if (result->>'revision')::integer<>i+1 then raise exception 'TEST FAILURE: revision'; end if;
  begin
    perform portal_commit_store_demo(admin_id,i,'{}','reset');
    raise exception 'TEST FAILURE: stale revision allowed';
  exception when serialization_failure then null; end;
  -- Membership-only revocation blocks a still-active profile at the write boundary.
  update portal_organization_membership set status='disabled' where profile_id=admin_id and workspace='internal';
  begin
    perform portal_commit_store_demo(admin_id,i+1,'{}','reset');
    raise exception 'TEST FAILURE: revoked membership allowed';
  exception when insufficient_privilege then null; end;
  if not exists(select 1 from portal_profile where id=admin_id and active) then raise exception 'TEST FAILURE: global profile changed'; end if;
  -- Enforce the cap on insert and reopening a closed store.
  insert into portal_retailer_account(id,organization_name,display_name,portal_status) values(account_id,org_name,org_name,'qualification');
  for i in 1..25 loop
    insert into portal_store(license_number,organization,display_name,retailer_account_id,active,license_status,ordering_status)
    values('ACCEPTANCE-'||account_id||'-'||i,org_name,'Acceptance '||i,account_id,false,'pending_qualification','paused');
  end loop;
  begin
    insert into portal_store(license_number,organization,display_name,retailer_account_id,active)
      values('ACCEPTANCE-'||account_id||'-26',org_name,'Overflow',account_id,false);
    raise exception 'TEST FAILURE: location 26 allowed';
  exception when raise_exception then
    if sqlerrm not like '%no more than 25 stores%' then raise; end if;
  end;
  update portal_store set closed_at=now() where license_number='ACCEPTANCE-'||account_id||'-1';
  insert into portal_store(license_number,organization,display_name,retailer_account_id,active)
    values('ACCEPTANCE-'||account_id||'-26',org_name,'Replacement',account_id,false);
  begin
    update portal_store set closed_at=null where license_number='ACCEPTANCE-'||account_id||'-1';
    raise exception 'TEST FAILURE: reopening bypassed cap';
  exception when raise_exception then
    if sqlerrm not like '%no more than 25 stores%' then raise; end if;
  end;
end $$;
set local role authenticated;
do $$
begin
  begin perform * from public.portal_store_demo_session; raise exception 'TEST FAILURE: direct session read allowed';
    exception when insufficient_privilege then null; end;
  begin perform * from public.portal_store_demo_control; raise exception 'TEST FAILURE: direct control read allowed';
    exception when insufficient_privilege then null; end;
  begin perform public.portal_commit_store_demo(gen_random_uuid(),0,'{}','reset'); raise exception 'TEST FAILURE: direct RPC allowed';
    exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$
begin
  begin perform * from public.portal_store_demo_session; raise exception 'TEST FAILURE: anonymous read allowed';
    exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'PASS: pause, Administrator-only authorization, revoked membership, optimistic revision, 25-store insert/reopen cap, authenticated/anonymous direct denial; all fixtures rolled back' as acceptance;
