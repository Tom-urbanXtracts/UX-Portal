-- Owner-approved synthetic Store tenant, 14 October 2026.
-- Staging only: no memberships, QuickBooks identities, qualified licenses,
-- commercial readiness, notifications, or integration writes are created.
begin;
do $$
declare
  demo_account_id uuid;
  created_store record;
begin
  perform pg_advisory_xact_lock(hashtextextended('stage-urbanxtracts-store-demo',0));
  if exists (
    select 1 from public.portal_retailer_account
    where organization_name='urbanXtracts Store' and quickbooks_customer_id is not null
  ) then
    raise exception 'The requested demo name belongs to an accounting-linked retailer; review before staging';
  end if;

  with created_account as (
    insert into public.portal_retailer_account
      (organization_name,display_name,portal_status,status_note)
    values ('urbanXtracts Store','urbanXtracts Store','setup_pending',
      'SYNTHETIC DEMO ONLY. Owner requested Demo Store #1 and Demo Store #2 on 10/14/2026. No real license or QuickBooks relationship. Ordering remains disabled until an isolated demo path passes acceptance.')
    on conflict (organization_name) do nothing
    returning id
  )
  insert into public.portal_retailer_event
    (retailer_account_id,event_type,to_value,note,metadata)
  select id,'account_created','setup_pending',
    'Owner-approved synthetic Store demonstration scaffold.',
    jsonb_build_object('environment','demo','source','Portal Build owner decision 2026-10-14','activation_enabled',false)
  from created_account;

  select id into strict demo_account_id from public.portal_retailer_account
  where organization_name='urbanXtracts Store';

  insert into public.portal_organization
    (kind,legal_name,display_name,status,legacy_retailer_account_id)
  values ('retailer','urbanXtracts Store','urbanXtracts Store','onboarding',demo_account_id)
  on conflict (kind,legal_name) do nothing;

  if not exists (
    select 1 from public.portal_organization
    where kind='retailer' and legal_name='urbanXtracts Store'
      and legacy_retailer_account_id=demo_account_id
  ) then
    raise exception 'Demo organization mapping conflicts with an existing record';
  end if;

  if exists (
    select 1 from public.portal_store
    where license_number in ('DEMO-UX-STORE-001','DEMO-UX-STORE-002')
      and (retailer_account_id is distinct from demo_account_id or organization <> 'urbanXtracts Store')
  ) then
    raise exception 'Demo location identifier conflicts with another retailer';
  end if;

  for created_store in
    insert into public.portal_store
      (license_number,organization,display_name,retailer_account_id,active,
       license_status,ordering_status,ordering_hold_reason)
    values
      ('DEMO-UX-STORE-001','urbanXtracts Store','Demo Store #1',demo_account_id,false,
       'pending_qualification','paused','Synthetic demo only; live ordering is disabled.'),
      ('DEMO-UX-STORE-002','urbanXtracts Store','Demo Store #2',demo_account_id,false,
       'pending_qualification','paused','Synthetic demo only; live ordering is disabled.')
    on conflict (license_number) do nothing
    returning license_number,display_name
  loop
    insert into public.portal_retailer_event
      (retailer_account_id,store_license,event_type,to_value,note,metadata)
    values (demo_account_id,created_store.license_number,'store_added','paused',
      'Owner-approved synthetic location scaffold; no real license qualification.',
      jsonb_build_object('environment','demo','store_name',created_store.display_name,
        'source','Portal Build owner decision 2026-10-14','activation_enabled',false));
  end loop;
end;
$$;
commit;
