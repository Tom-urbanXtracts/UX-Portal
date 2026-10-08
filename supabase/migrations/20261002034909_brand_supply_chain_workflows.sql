-- Organization-scoped Brand supply-chain workspace. These records remain
-- server-only; authenticated callers reach them through the scoped
-- portal-brand-supply-chain Edge Function.

create table if not exists public.portal_brand_vendor (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  legal_business_name text not null check (length(btrim(legal_business_name)) between 1 and 240),
  dba_name text,
  main_contact_name text,
  main_contact_email text,
  main_contact_phone text,
  business_address text,
  shipping_address text,
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'approved', 'changes_requested', 'archived'
  )),
  review_note text,
  revision integer not null default 0 check (revision >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_email text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, legal_business_name)
);

create table if not exists public.portal_brand_component (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  sku_intake_id uuid not null references public.portal_sku_intake(id) on delete cascade,
  vendor_id uuid references public.portal_brand_vendor(id) on delete set null,
  component_type text not null check (component_type in ('ingredient', 'packaging', 'hardware')),
  name text not null check (length(btrim(name)) between 1 and 240),
  manufacturer_name text,
  item_code text,
  amount_per_unit numeric check (amount_per_unit is null or amount_per_unit > 0),
  amount_uom text,
  specification text,
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'approved', 'changes_requested', 'archived'
  )),
  review_note text,
  revision integer not null default 0 check (revision >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_email text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku_intake_id, component_type, name)
);

create table if not exists public.portal_brand_supply_document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  entity_type text not null check (entity_type in ('sku', 'vendor', 'component')),
  entity_id uuid not null,
  document_type text not null,
  title text not null check (length(btrim(title)) between 1 and 240),
  visibility text not null default 'brand_and_internal'
    check (visibility in ('brand_and_internal', 'internal_only')),
  status text not null default 'current' check (status in ('current', 'archived')),
  notes text,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
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
  unique (organization_id, entity_type, entity_id, document_type, sha256),
  check (
    (status = 'current' and archived_at is null)
    or (status = 'archived' and archived_at is not null)
  )
);

create index if not exists portal_brand_vendor_org_idx
  on public.portal_brand_vendor (organization_id, status, updated_at desc);
create index if not exists portal_brand_component_org_idx
  on public.portal_brand_component (organization_id, sku_intake_id, component_type, status);
create index if not exists portal_brand_supply_document_entity_idx
  on public.portal_brand_supply_document (organization_id, entity_type, entity_id, status, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-brand-supply-documents', 'portal-brand-supply-documents', false, 62914560,
  array['application/pdf', 'image/png', 'image/jpeg', 'application/zip']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_brand_vendor enable row level security;
alter table public.portal_brand_component enable row level security;
alter table public.portal_brand_supply_document enable row level security;

revoke all on table public.portal_brand_vendor, public.portal_brand_component,
  public.portal_brand_supply_document from public, anon, authenticated;
grant all on table public.portal_brand_vendor, public.portal_brand_component,
  public.portal_brand_supply_document to service_role;

comment on table public.portal_brand_vendor is
  'Brand-scoped component-manufacturer register with partial drafts and explicit Internal review.';
comment on table public.portal_brand_component is
  'Ingredient, packaging, and hardware bill-of-material records linked to one Brand SKU packet.';
comment on table public.portal_brand_supply_document is
  'Private malware-scanned SKU, vendor, and component evidence. Files are optional and archived rather than deleted.';
