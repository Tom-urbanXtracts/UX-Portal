begin;

-- Source-evidence saves have emitted this event since the retailer accounting
-- controls were introduced. Keep the audit enum in sync with that workflow so
-- the store update and its audit record can commit atomically.
alter table public.portal_retailer_event
  drop constraint if exists portal_retailer_event_event_type_check;

alter table public.portal_retailer_event
  add constraint portal_retailer_event_event_type_check check (event_type in (
    'account_created',
    'quickbooks_linked',
    'account_status_changed',
    'store_added',
    'store_status_changed',
    'store_source_evidence_changed',
    'note_changed'
  ));

commit;
