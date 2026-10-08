-- Retire the original Downtown Provisions prototype fixtures without deleting
-- order, price, or audit history. The isolated Cannabis Store (DEMO)
-- acceptance-test organization is intentionally unaffected.

with target_account as (
  select id, portal_status
  from public.portal_retailer_account
  where organization_name = 'Downtown Provisions'
)
insert into public.portal_retailer_event (
  retailer_account_id, event_type, from_value, to_value, note, metadata
)
select id, 'account_status_changed', portal_status, 'inactive',
  'Legacy prototype retailer retired from active portal use on 09/29/2026.',
  jsonb_build_object(
    'reason', 'legacy_demo_fixture_retired',
    'preserve_history', true,
    'named_stores', jsonb_build_array('Downtown', 'Riverside', 'Northgate')
  )
from target_account;

with target_stores as (
  select retailer_account_id, license_number, display_name, ordering_status
  from public.portal_store
  where organization = 'Downtown Provisions'
    and (license_number, display_name) in (
      ('OCM-RETL-24-000412', 'Downtown'),
      ('OCM-RETL-24-000518', 'Riverside'),
      ('OCM-RETL-24-000633', 'Northgate')
    )
)
insert into public.portal_retailer_event (
  retailer_account_id, store_license, event_type, from_value, to_value,
  note, metadata
)
select retailer_account_id, license_number, 'store_status_changed',
  ordering_status, 'paused',
  'Legacy prototype store retired from active portal use on 09/29/2026.',
  jsonb_build_object(
    'reason', 'legacy_demo_fixture_retired',
    'store_name', display_name,
    'preserve_history', true
  )
from target_stores
where retailer_account_id is not null;

update public.portal_price_proposal
set state = 'withdrawn',
    decision_note = coalesce(
      nullif(decision_note, ''),
      'Withdrawn because the legacy prototype store was retired.'
    ),
    decided_at = coalesce(decided_at, now())
where organization = 'Downtown Provisions'
  and location_license in (
    'OCM-RETL-24-000412',
    'OCM-RETL-24-000518',
    'OCM-RETL-24-000633'
  )
  and state = 'pending';

delete from public.portal_profile_store
where license_number in (
  'OCM-RETL-24-000412',
  'OCM-RETL-24-000518',
  'OCM-RETL-24-000633'
);

update public.portal_store
set active = false,
    license_status = 'suspended',
    ordering_status = 'paused',
    ordering_hold_reason = 'Legacy prototype store retired from active portal use.',
    closed_at = coalesce(closed_at, now()),
    updated_at = now()
where organization = 'Downtown Provisions'
  and (license_number, display_name) in (
    ('OCM-RETL-24-000412', 'Downtown'),
    ('OCM-RETL-24-000518', 'Riverside'),
    ('OCM-RETL-24-000633', 'Northgate')
  );

update public.portal_retailer_account
set portal_status = 'inactive',
    status_note = 'Legacy prototype retailer retired from active portal use; historical orders and audit evidence retained.',
    updated_at = now()
where organization_name = 'Downtown Provisions';

update public.portal_organization
set status = 'inactive',
    updated_at = now()
where kind = 'retailer'
  and legal_name = 'Downtown Provisions';

-- Configure the company-owned urbanXtracts Brand pilot from the approved
-- identity register. QuickBooks party IDs remain null by design: this Brand is
-- the company itself, not an external customer or vendor settlement party.
update public.portal_brand_account as account
set canix_brand_id = '2202',
    canix_brand_name = 'urbanXtracts',
    canix_owner_id = null,
    canix_owner_name = null,
    monday_account_item_id = '12782809204',
    quickbooks_entity_type = null,
    quickbooks_customer_id = null,
    quickbooks_vendor_id = null,
    scope_status = 'verified',
    scope_note = 'Company-owned Brand. Canix Brand ID 2202 and Monday Brand item 12782809204 are the approved scope. No external QuickBooks accounting party; Brand settlements, statements, and external balances are not applicable. Exact quantity visibility remains a separate approval decision.',
    updated_at = now()
from public.portal_organization as organization
where organization.id = account.organization_id
  and organization.kind = 'brand'
  and organization.legal_name = 'urbanXtracts';

create index if not exists canix_package_current_run_brand_idx
  on public.canix_package_current (sync_run_id, brand_id);

create index if not exists canix_package_current_run_owner_idx
  on public.canix_package_current (sync_run_id, owner_id);

comment on index public.canix_package_current_run_brand_idx is
  'Supports server-scoped Brand inventory reads without returning the full Canix package cache.';

comment on index public.canix_package_current_run_owner_idx is
  'Supports server-scoped economic-owner inventory reads when an approved Owner mapping is configured.';
