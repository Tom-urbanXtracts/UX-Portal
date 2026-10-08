-- Apply the Brand governance decisions approved on 2026-09-30.
-- External Brand activation is gated by six Administrator-approved readiness
-- items. Canix Owner is the only inventory boundary; Brand remains descriptive
-- product identity. Manufacturing milestones use the approved external flow.

alter table public.portal_brand_profile_detail
  add column if not exists w9_state text not null default 'pending'
    check (w9_state in ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  add column if not exists insurance_state text not null default 'pending'
    check (insurance_state in ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  add column if not exists payment_terms_state text not null default 'pending'
    check (payment_terms_state in ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  add column if not exists contacts_state text not null default 'pending'
    check (contacts_state in ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  add column if not exists product_approval_state text not null default 'pending'
    check (product_approval_state in ('pending', 'in_review', 'approved', 'rejected', 'expired')),
  add column if not exists readiness_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists readiness_reviewed_at timestamptz;

-- Company-owned Brands do not need external counterparty documents.
update public.portal_brand_profile_detail
set w9_state = 'approved',
    insurance_state = 'approved',
    payment_terms_state = 'approved',
    contacts_state = 'approved',
    product_approval_state = 'approved',
    updated_at = now()
where classification = 'company_owned';

-- A verified Brand-only mapping is no longer a valid inventory boundary.
-- Keep the descriptive Brand identity but fail closed until one Owner ID is
-- reviewed and published by an Administrator.
update public.portal_brand_account
set scope_status = 'pending',
    scope_note = concat_ws(
      ' ',
      nullif(btrim(scope_note), ''),
      'Owner ID required: Canix Owner is the approved inventory scope.'
    ),
    updated_at = now()
where scope_status = 'verified'
  and canix_owner_id is null;

create unique index if not exists portal_brand_account_canix_owner_unique_idx
  on public.portal_brand_account (canix_owner_id)
  where canix_owner_id is not null;

update public.portal_brand_manufacturing_projection
set status = case status
  when 'planned' then 'submitted'
  when 'quality_hold' then 'quality_review'
  when 'closed' then 'shipped'
  else status
end,
updated_at = now()
where status in ('planned', 'quality_hold', 'closed');

alter table public.portal_brand_manufacturing_projection
  drop constraint if exists portal_brand_manufacturing_projection_status_check;
alter table public.portal_brand_manufacturing_projection
  alter column status set default 'submitted';
alter table public.portal_brand_manufacturing_projection
  add constraint portal_brand_manufacturing_projection_status_check
  check (status in (
    'submitted', 'approved', 'scheduled', 'in_production',
    'quality_review', 'complete', 'shipped', 'exception'
  ));

comment on column public.portal_brand_account.canix_owner_id is
  'Authoritative one-to-one Canix Owner scope for Brand inventory visibility. Canix Brand is descriptive product identity only.';
comment on column public.portal_brand_profile_detail.activation_state is
  'Administrators and Operations may change activation, but an external Brand can become active only after all six Administrator-approved readiness gates pass.';
comment on column public.portal_brand_manufacturing_projection.status is
  'Approved Brand-visible milestones: Submitted, Approved, Scheduled, In Production, Quality Review, Complete, Shipped; Exception is an internal attention state.';
