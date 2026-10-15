-- Run in ONE transaction AFTER the prepared migration, then roll back both.
-- All identities, memberships, schema objects and audit rows are temporary.
do $$
declare
  owner_id uuid:=gen_random_uuid(); buyer_id uuid:=gen_random_uuid(); staff_id uuid:=gen_random_uuid(); second_owner uuid:=gen_random_uuid();
  account_a uuid:=gen_random_uuid(); account_b uuid:=gen_random_uuid(); org_a uuid:=gen_random_uuid(); org_b uuid:=gen_random_uuid(); brand_org uuid:=gen_random_uuid();
  owner_m uuid:=gen_random_uuid(); buyer_m uuid:=gen_random_uuid(); staff_m uuid:=gen_random_uuid(); second_m uuid:=gen_random_uuid(); brand_m uuid:=gen_random_uuid(); foreign_m uuid:=gen_random_uuid();
  admin_id uuid; admin_m uuid; result jsonb; license_a text:='ACCESS-'||gen_random_uuid(); license_a2 text:='ACCESS-'||gen_random_uuid(); license_b text:='ACCESS-'||gen_random_uuid();
  identity uuid; before_audit bigint; after_audit bigint;
begin
  select m.profile_id,m.id into strict admin_id,admin_m from portal_organization_membership m
    join portal_profile p on p.id=m.profile_id join portal_organization o on o.id=m.organization_id
    where m.workspace='internal' and m.member_role='administrator' and m.status='active' and p.active and p.staff_role='administrator' and o.status='active' limit 1;
  foreach identity in array array[owner_id,buyer_id,staff_id,second_owner] loop
    insert into auth.users(id,aud,role,email,raw_app_meta_data) values(identity,'authenticated','authenticated',identity||'@example.invalid','{}');
    insert into portal_profile(id,full_name,org,role,active) values(identity,'Rollback-only access fixture','Rollback fixture','brand',true)
      on conflict(id) do update set full_name=excluded.full_name,org=excluded.org,role=excluded.role,active=true;
  end loop;
  insert into portal_retailer_account(id,organization_name,display_name,portal_status) values
    (account_a,'Access A '||account_a,'Access A','qualification'),(account_b,'Access B '||account_b,'Access B','qualification');
  insert into portal_organization(id,kind,legal_name,display_name,status,legacy_retailer_account_id) values
    (org_a,'retailer','Access A '||org_a,'Access A','active',account_a),(org_b,'retailer','Access B '||org_b,'Access B','active',account_b),
    (brand_org,'brand','Access Brand '||brand_org,'Access Brand','active',null);
  insert into portal_store(license_number,organization,display_name,retailer_account_id,active) values
    (license_a,'Access A '||account_a,'A1',account_a,true),(license_a2,'Access A '||account_a,'A2',account_a,true),(license_b,'Access B '||account_b,'B1',account_b,true);
  insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values
    (owner_m,owner_id,org_a,'store','store_owner','active'),(buyer_m,buyer_id,org_a,'store','store_buyer','active'),
    (staff_m,staff_id,org_a,'store','store_staff','active'),(second_m,second_owner,org_a,'store','store_owner','active'),
    (brand_m,buyer_id,brand_org,'brand','brand_owner','active'),(foreign_m,second_owner,org_b,'store','store_owner','active');
  -- Legacy assignments are intentionally broader and MUST NOT be used.
  insert into portal_profile_store(profile_id,license_number) values(buyer_id,license_a2);
  insert into portal_membership_store(membership_id,license_number) values(buyer_m,license_a),(staff_m,license_a);
  begin
    perform portal_resolve_store_context(buyer_id,buyer_m); raise exception 'TEST FAILURE: disabled foundation allowed access';
  exception when insufficient_privilege then null; end;
  update portal_store_access_control set enabled=true where id;
  result:=portal_resolve_store_context(buyer_id,buyer_m);
  if result->'licenses'<>jsonb_build_array(license_a) then raise exception 'TEST FAILURE: legacy assignments leaked'; end if;
  result:=portal_resolve_store_context(owner_id,owner_m);
  if jsonb_array_length(result->'licenses')<>2 then raise exception 'TEST FAILURE: Owner location scope'; end if;
  begin perform portal_resolve_store_context(owner_id,buyer_m); raise exception 'TEST FAILURE: forged membership'; exception when insufficient_privilege then null; end;
  begin perform portal_resolve_store_context(buyer_id,brand_m); raise exception 'TEST FAILURE: Brand membership accepted'; exception when insufficient_privilege then null; end;
  begin
    insert into portal_membership_store(membership_id,license_number) values(buyer_m,license_b);
    raise exception 'TEST FAILURE: foreign assignment';
  exception when insufficient_privilege then null; end;
  begin
    insert into portal_membership_store(membership_id,license_number) values(staff_m,license_a2);
    raise exception 'TEST FAILURE: Budtender two locations';
  exception when check_violation then null; end;
  -- Changing a role cannot bypass the one-location check.
  insert into portal_membership_store(membership_id,license_number) values(buyer_m,license_a2);
  update portal_organization_membership set member_role='store_staff' where id=buyer_m;
  begin perform portal_resolve_store_context(buyer_id,buyer_m); raise exception 'TEST FAILURE: role-change assignment bypass'; exception when insufficient_privilege then null; end;
  update portal_organization_membership set member_role='store_buyer' where id=buyer_m;
  delete from portal_membership_store where membership_id=buyer_m and license_number=license_a2;
  update portal_store set active=false where license_number=license_a;
  result:=portal_resolve_store_context(buyer_id,buyer_m);
  if result->'licenses'<>'[]'::jsonb then raise exception 'TEST FAILURE: inactive Store'; end if;
  update portal_store set active=true where license_number=license_a;
  update portal_profile set active=false where id=buyer_id;
  begin perform portal_resolve_store_context(buyer_id,buyer_m); raise exception 'TEST FAILURE: inactive profile'; exception when insufficient_privilege then null; end;
  update portal_profile set active=true where id=buyer_id;
  update portal_organization set status='inactive' where id=org_a;
  begin perform portal_resolve_store_context(buyer_id,buyer_m); raise exception 'TEST FAILURE: inactive retailer'; exception when insufficient_privilege then null; end;
  update portal_organization set status='active' where id=org_a;
  -- Forbidden administration and last-Owner protection.
  begin perform portal_revoke_store_membership(buyer_id,buyer_m,staff_m,'Denied'); raise exception 'TEST FAILURE: Buyer administration'; exception when insufficient_privilege then null; end;
  begin perform portal_revoke_store_membership(owner_id,owner_m,owner_m,'Denied'); raise exception 'TEST FAILURE: self-deactivation'; exception when insufficient_privilege then null; end;
  begin perform portal_revoke_store_membership(owner_id,owner_m,foreign_m,'Denied'); raise exception 'TEST FAILURE: foreign administration'; exception when insufficient_privilege then null; end;
  begin perform portal_revoke_store_membership(admin_id,admin_m,buyer_m,' '); raise exception 'TEST FAILURE: missing reason'; exception when invalid_parameter_value then null; end;
  perform portal_revoke_store_membership(admin_id,admin_m,second_m,'Rollback-only second Owner removal');
  begin perform portal_revoke_store_membership(admin_id,admin_m,owner_m,'Denied'); raise exception 'TEST FAILURE: last Owner'; exception when check_violation then null; end;
  select count(*) into before_audit from portal_admin_audit where action='revoke-store-membership' and target_id=buyer_id;
  perform portal_revoke_store_membership(owner_id,owner_m,buyer_m,'Rollback-only scoped removal');
  result:=portal_revoke_store_membership(owner_id,owner_m,buyer_m,'Idempotent retry');
  if (result->>'changed')::boolean then raise exception 'TEST FAILURE: duplicate revocation'; end if;
  select count(*) into after_audit from portal_admin_audit where action='revoke-store-membership' and target_id=buyer_id;
  if after_audit<>before_audit+1 then raise exception 'TEST FAILURE: audit count'; end if;
  begin perform portal_resolve_store_context(buyer_id,buyer_m); raise exception 'TEST FAILURE: revoked membership'; exception when insufficient_privilege then null; end;
  if not exists(select 1 from portal_organization_membership where id=brand_m and status='active')
    or not exists(select 1 from portal_profile where id=buyer_id and active)
    or not exists(select 1 from auth.users where id=buyer_id and banned_until is null) then
    raise exception 'TEST FAILURE: independent Brand/global identity modified';
  end if;
  -- Also exercise the intended service role, not just the SQL owner.
  perform set_config('test.store_actor',owner_id::text,true);
  perform set_config('test.store_membership',owner_m::text,true);
end $$;
set local role service_role;
do $$ begin
  perform public.portal_resolve_store_context(current_setting('test.store_actor')::uuid,current_setting('test.store_membership')::uuid);
end $$;
set local role authenticated;
do $$ begin
  begin perform * from public.portal_membership_store; raise exception 'TEST FAILURE: authenticated assignment read'; exception when insufficient_privilege then null; end;
  begin perform public.portal_resolve_store_context(gen_random_uuid(),gen_random_uuid()); raise exception 'TEST FAILURE: direct resolver'; exception when insufficient_privilege then null; end;
  begin perform public.portal_revoke_store_membership(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'Denied'); raise exception 'TEST FAILURE: direct revoker'; exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
  begin perform * from public.portal_store_access_control; raise exception 'TEST FAILURE: anonymous control read'; exception when insufficient_privilege then null; end;
  begin perform public.portal_resolve_store_context(gen_random_uuid(),gen_random_uuid()); raise exception 'TEST FAILURE: anonymous resolver'; exception when insufficient_privilege then null; end;
end $$;
set local role postgres;
-- The repair path must resolve the active Internal organization before it
-- inserts a profile. Exercise the real repair function with no eligible
-- organization and prove the attempted repair leaves no partial records.
do $$
declare
  repair_user_id uuid := gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,raw_app_meta_data)
  values(repair_user_id,'authenticated','authenticated',repair_user_id||'@example.invalid','{}');
  delete from public.portal_profile where id=repair_user_id;
  update auth.users
  set email='repair-'||repair_user_id||'@urbanxtracts.com'
  where id=repair_user_id;
  update public.portal_organization
  set status='inactive'
  where kind='internal' and legal_name='urbanXtracts' and status='active';

  begin
    perform public.portal_repair_workforce_workspace_memberships();
    raise exception 'TEST FAILURE: workforce repair succeeded without an active Internal organization';
  exception
    when raise_exception then
      if sqlerrm not like 'Active urbanXtracts Internal organization is not configured%' then
        raise;
      end if;
  end;

  if exists(select 1 from public.portal_profile where id=repair_user_id)
    or exists(select 1 from public.portal_organization_membership where profile_id=repair_user_id) then
    raise exception 'TEST FAILURE: workforce repair left partial profile or membership data';
  end if;
end $$;
rollback;
select 'PASS: temporary Store foundation, scope, revocation, independent Brand access, audit, last Owner, service-only authorization, fail-closed workforce repair; schema and fixtures rolled back' as acceptance;
