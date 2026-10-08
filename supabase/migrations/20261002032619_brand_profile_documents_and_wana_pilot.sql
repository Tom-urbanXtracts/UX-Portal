-- Brand profile document register, the first Wana pilot packet, and the
-- Company-field additions approved after the Brand workspace review.

create table if not exists public.portal_brand_document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  category text not null check (category in (
    'company', 'license', 'tax', 'insurance', 'quality', 'commercial',
    'operations', 'other'
  )),
  title text not null check (length(btrim(title)) between 1 and 240),
  document_date date,
  expires_on date,
  visibility text not null default 'brand_and_internal'
    check (visibility in ('brand_and_internal', 'internal_only')),
  status text not null default 'current' check (status in ('current', 'archived')),
  notes text,
  object_path text not null unique,
  original_name text not null,
  content_type text not null
    check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null check (scan_state = 'clean'),
  scan_provider text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_email text,
  archived_by uuid references auth.users(id) on delete set null,
  archived_by_email text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, category, sha256),
  check (expires_on is null or document_date is null or expires_on >= document_date),
  check (
    (status = 'current' and archived_at is null)
    or (status = 'archived' and archived_at is not null)
  )
);

create index if not exists portal_brand_document_register_idx
  on public.portal_brand_document (organization_id, status, category, created_at desc);
create index if not exists portal_brand_document_expiry_idx
  on public.portal_brand_document (organization_id, expires_on)
  where status = 'current' and expires_on is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-brand-documents', 'portal-brand-documents', false, 62914560,
  array['application/pdf', 'image/png', 'image/jpeg', 'application/zip']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_brand_document enable row level security;
revoke all on table public.portal_brand_document from public, anon, authenticated;
grant all on table public.portal_brand_document to service_role;

comment on table public.portal_brand_document is
  'Organization-scoped Brand profile document register. Files are private, malware-scanned, auditable, and archived rather than deleted.';
comment on column public.portal_brand_document.visibility is
  'Brand members can read brand_and_internal documents; internal_only documents never leave the Internal workspace boundary.';

-- QuickBooks Customer 50 was confirmed for Wana. This approves identity only;
-- settlement treatment and Brand-visible dollar reporting remain separate
-- Finance decisions.
update public.portal_brand_financial_policy as policy
set quickbooks_classification = 'customer',
    identity_status = 'verified',
    ar_visibility = 'quickbooks_read_only',
    updated_at = now()
from public.portal_organization as organization
where policy.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'Wana';

update public.portal_brand_reporting_exception as exception
set status = 'resolved',
    resolved_at = coalesce(exception.resolved_at, now()),
    resolution_note = coalesce(
      nullif(btrim(exception.resolution_note), ''),
      'QuickBooks Customer 50 identity was approved. Settlement and dollar-reporting policy remain pending Finance review.'
    ),
    updated_at = now()
from public.portal_organization as organization
where exception.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'Wana'
  and exception.exception_code = 'quickbooks_identity_review_required';

-- Create the Wana onboarding shell without inventing contacts, addresses,
-- licenses, EIN, or the missing Canix Owner ID.
insert into public.portal_brand_onboarding (organization_id, status)
select organization.id, 'in_progress'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (organization_id) do nothing;

with definitions(section_key, position, title) as (
  values
    ('company', 1, 'Company profile'),
    ('contacts', 2, 'Contacts and authorized users'),
    ('billing', 3, 'Billing and remittance'),
    ('qualified_vendor', 4, 'Qualified-vendor information'),
    ('identifiers', 5, 'Operating identifiers'),
    ('documents', 6, 'Documents and attestations')
)
insert into public.portal_brand_onboarding_section (
  onboarding_id, section_key, position, title, status, data, completion_percent,
  updated_by_email
)
select onboarding.id, definition.section_key, definition.position,
  definition.title,
  case when definition.section_key = 'company' then 'in_progress' else 'not_started' end,
  case
    when definition.section_key = 'company' then jsonb_build_object(
      'legal_name', 'Wana', 'dba_name', 'Wana'
    )
    when definition.section_key = 'identifiers' then jsonb_build_object(
      'canix_brand_name', 'Wana'
    )
    else '{}'::jsonb
  end,
  case when definition.section_key = 'company' then 17 else 0 end,
  'system@urbanxtracts.com'
from public.portal_brand_onboarding as onboarding
join public.portal_organization as organization on organization.id = onboarding.organization_id
cross join definitions as definition
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (onboarding_id, section_key) do nothing;

-- Seed one reviewable Wana SKU packet from the confirmed Canix item identity.
-- Only the known Brand and product name are populated; every manufacturing,
-- formula, packaging, and compliance answer remains blank for Brand review.
insert into public.portal_sku_intake (
  organization_id, brand_name, product_name, status, created_by_email
)
select organization.id, 'Wana', 'Wana Mango Classic Gummies', 'in_progress',
  'system@urbanxtracts.com'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
  and not exists (
    select 1 from public.portal_sku_intake as intake
    where intake.organization_id = organization.id
      and lower(btrim(intake.product_name)) = lower('Wana Mango Classic Gummies')
      and intake.status <> 'archived'
  );

with definitions(section_key, position, title) as (
  values
    ('basics', 1, 'Agreement & SKU basics'),
    ('formulation', 2, 'Formulation'),
    ('ingredients', 3, 'Non-cannabinoid ingredients'),
    ('suppliers', 4, 'Suppliers'),
    ('allergens', 5, 'Allergens'),
    ('packaging', 6, 'Packaging specification'),
    ('label', 7, 'Label compliance worksheet'),
    ('claims', 8, 'Claims register'),
    ('marketing', 9, 'Marketing & accompanying material'),
    ('notes', 10, 'Notes & prior experience')
)
insert into public.portal_sku_intake_section (
  intake_id, section_key, position, title, status, data, completion_percent,
  updated_by_email
)
select intake.id, definition.section_key, definition.position, definition.title,
  case when definition.section_key = 'basics' then 'in_progress' else 'not_started' end,
  case when definition.section_key = 'basics' then jsonb_build_object(
    'brand', 'Wana', 'product', 'Wana Mango Classic Gummies'
  ) else '{}'::jsonb end,
  case when definition.section_key = 'basics' then 17 else 0 end,
  'system@urbanxtracts.com'
from public.portal_sku_intake as intake
join public.portal_organization as organization on organization.id = intake.organization_id
cross join definitions as definition
where organization.kind = 'brand' and organization.legal_name = 'Wana'
  and lower(btrim(intake.product_name)) = lower('Wana Mango Classic Gummies')
  and intake.status <> 'archived'
on conflict (intake_id, section_key) do nothing;

-- Existing submitted Company sections are deliberately reopened when the new
-- required fields are absent, so the portal never presents incomplete data as
-- approved or silently fills it with assumptions.
update public.portal_brand_onboarding_section as section
set status = 'changes_requested',
    completion_percent = least(section.completion_percent, 50),
    review_note = 'Complete the newly added shipping contact fields before resubmitting this section.',
    approved_at = null,
    revision = section.revision + 1,
    updated_by_email = 'system@urbanxtracts.com',
    updated_at = now()
where section.section_key = 'contacts'
  and section.status in ('submitted', 'approved')
  and (
    nullif(btrim(section.data->>'shipping_name'), '') is null
    or nullif(btrim(section.data->>'shipping_email'), '') is null
    or nullif(btrim(section.data->>'shipping_phone'), '') is null
  );

update public.portal_brand_onboarding_section as section
set status = 'changes_requested',
    completion_percent = least(section.completion_percent, 45),
    review_note = 'Complete the billing contact, billing address, and EIN before resubmitting this section. Do not enter bank account or routing numbers.',
    approved_at = null,
    revision = section.revision + 1,
    updated_by_email = 'system@urbanxtracts.com',
    updated_at = now()
where section.section_key = 'billing'
  and section.status in ('submitted', 'approved')
  and (
    nullif(btrim(section.data->>'billing_contact_name'), '') is null
    or nullif(btrim(section.data->>'billing_address_line_1'), '') is null
    or nullif(btrim(section.data->>'billing_city'), '') is null
    or nullif(btrim(section.data->>'billing_state'), '') is null
    or nullif(btrim(section.data->>'billing_postal_code'), '') is null
    or nullif(btrim(section.data->>'ein'), '') is null
  );

update public.portal_brand_onboarding as onboarding
set status = 'changes_requested',
    approved_by = null,
    approved_by_email = null,
    approved_at = null,
    updated_at = now()
where exists (
  select 1 from public.portal_brand_onboarding_section as section
  where section.onboarding_id = onboarding.id
    and section.status = 'changes_requested'
);
