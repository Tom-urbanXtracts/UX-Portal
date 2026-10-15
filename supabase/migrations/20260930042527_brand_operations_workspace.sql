-- Durable Brand administration and operations records. These tables are
-- intentionally server-only: browser clients reach them through the scoped
-- portal-brand-operations function, never through the Data API directly.

create table if not exists public.portal_brand_profile_detail (
  organization_id uuid primary key references public.portal_organization(id) on delete cascade,
  classification text not null default 'external_partner'
    check (classification in ('company_owned', 'external_partner')),
  activation_state text not null default 'onboarding'
    check (activation_state in ('onboarding', 'active', 'suspended', 'closed')),
  legal_name text,
  dba_name text,
  website text,
  primary_contact_name text,
  primary_contact_email text,
  primary_contact_phone text,
  operations_contact_email text,
  finance_contact_email text,
  quality_contact_email text,
  agreement_state text not null default 'pending'
    check (agreement_state in ('pending', 'in_review', 'active', 'expired', 'not_required')),
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_brand_contact (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  contact_type text not null check (contact_type in ('primary', 'operations', 'finance', 'quality', 'commercial', 'other')),
  full_name text not null,
  email text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_brand_agreement (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  agreement_type text not null,
  reference text not null,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'active', 'expired', 'terminated')),
  effective_on date,
  expires_on date,
  monday_item_id text,
  document_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, reference),
  check (expires_on is null or effective_on is null or expires_on >= effective_on)
);

create table if not exists public.portal_brand_purchase_order (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  reference text not null unique default ('BPO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  request_type text not null default 'manufacturing_request'
    check (request_type in ('manufacturing_request', 'raw_material_supply', 'finished_goods_purchase')),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'acknowledged', 'scheduled', 'in_production', 'complete', 'cancelled', 'exception')),
  requested_on date not null default current_date,
  needed_by date,
  notes text,
  currency text,
  total_amount numeric,
  monday_item_id text,
  handoff_state text not null default 'not_ready'
    check (handoff_state in ('not_ready', 'pending', 'accepted', 'needs_reconciliation', 'not_configured')),
  handoff_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (needed_by is null or needed_by >= requested_on),
  check (total_amount is null or total_amount >= 0)
);

create table if not exists public.portal_brand_purchase_order_line (
  id bigint generated always as identity primary key,
  purchase_order_id uuid not null references public.portal_brand_purchase_order(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  canix_item_id bigint,
  product_name text not null,
  sku text,
  requested_quantity numeric not null check (requested_quantity > 0),
  uom_code text not null check (uom_code in ('UNIT', 'G_IN', 'G_OUT', 'G_DRY', 'G_WET')),
  created_at timestamptz not null default now(),
  unique (purchase_order_id, line_number)
);

create table if not exists public.portal_brand_manufacturing_projection (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  purchase_order_id uuid references public.portal_brand_purchase_order(id) on delete set null,
  monday_item_id text not null,
  reference text not null,
  product_name text,
  status text not null default 'planned'
    check (status in ('planned', 'approved', 'scheduled', 'in_production', 'quality_hold', 'complete', 'closed', 'exception')),
  planned_on date,
  started_on date,
  completed_on date,
  exception_owner text,
  exception_note text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, monday_item_id),
  check (completed_on is null or started_on is null or completed_on >= started_on)
);

create table if not exists public.portal_brand_operation_event (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_brand_contact_org_idx
  on public.portal_brand_contact (organization_id, active, contact_type);
create index if not exists portal_brand_agreement_org_idx
  on public.portal_brand_agreement (organization_id, status, expires_on);
create index if not exists portal_brand_po_org_idx
  on public.portal_brand_purchase_order (organization_id, status, updated_at desc);
create index if not exists portal_brand_po_line_po_idx
  on public.portal_brand_purchase_order_line (purchase_order_id, line_number);
create index if not exists portal_brand_mfg_org_idx
  on public.portal_brand_manufacturing_projection (organization_id, status, updated_at desc);
create index if not exists portal_brand_event_org_idx
  on public.portal_brand_operation_event (organization_id, created_at desc);

alter table public.portal_brand_profile_detail enable row level security;
alter table public.portal_brand_contact enable row level security;
alter table public.portal_brand_agreement enable row level security;
alter table public.portal_brand_purchase_order enable row level security;
alter table public.portal_brand_purchase_order_line enable row level security;
alter table public.portal_brand_manufacturing_projection enable row level security;
alter table public.portal_brand_operation_event enable row level security;

revoke all on table public.portal_brand_profile_detail, public.portal_brand_contact,
  public.portal_brand_agreement, public.portal_brand_purchase_order,
  public.portal_brand_purchase_order_line, public.portal_brand_manufacturing_projection,
  public.portal_brand_operation_event from public, anon, authenticated;
grant all on table public.portal_brand_profile_detail, public.portal_brand_contact,
  public.portal_brand_agreement, public.portal_brand_purchase_order,
  public.portal_brand_purchase_order_line, public.portal_brand_manufacturing_projection,
  public.portal_brand_operation_event to service_role;
grant usage, select on sequence public.portal_brand_purchase_order_line_id_seq,
  public.portal_brand_operation_event_id_seq to service_role;

-- SKU intake records gain an optional organization anchor. Existing records
-- remain valid and can be reconciled without destructive name matching.
alter table public.portal_sku_intake
  add column if not exists organization_id uuid references public.portal_organization(id) on delete set null;
create index if not exists portal_sku_intake_organization_idx
  on public.portal_sku_intake (organization_id, status, updated_at desc);

-- Seed only identities already confirmed in the controlled mapping register.
insert into public.portal_brand_profile_detail (
  organization_id, classification, activation_state, legal_name, dba_name,
  agreement_state, internal_note
)
select organization.id, 'company_owned', 'active', 'urbanXtracts', 'urbanXtracts',
  'not_required', 'Company-owned Brand profile; external settlement does not apply.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'urbanXtracts'
on conflict (organization_id) do update set
  classification = excluded.classification,
  activation_state = excluded.activation_state,
  legal_name = excluded.legal_name,
  dba_name = excluded.dba_name,
  agreement_state = excluded.agreement_state,
  internal_note = excluded.internal_note,
  updated_at = now();

insert into public.portal_organization (kind, legal_name, display_name, status)
values ('brand', 'Wana', 'Wana', 'active')
on conflict (kind, legal_name) do update set
  display_name = excluded.display_name,
  status = 'active',
  updated_at = now();

insert into public.portal_brand_account (
  organization_id, canix_brand_id, canix_brand_name, monday_account_item_id,
  quickbooks_entity_type, quickbooks_customer_id, scope_status, scope_note
)
select organization.id, '2210', 'Wana', '12782809207', 'customer', '50',
  'verified',
  'Canix Brand and Monday identity are exact-name matches. QuickBooks Customer 50 is confirmed; vendor/settlement classification remains a Finance decision.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (organization_id) do update set
  canix_brand_id = excluded.canix_brand_id,
  canix_brand_name = excluded.canix_brand_name,
  monday_account_item_id = excluded.monday_account_item_id,
  quickbooks_entity_type = excluded.quickbooks_entity_type,
  quickbooks_customer_id = excluded.quickbooks_customer_id,
  scope_status = excluded.scope_status,
  scope_note = excluded.scope_note,
  updated_at = now();

insert into public.portal_brand_profile_detail (
  organization_id, classification, activation_state, legal_name, dba_name,
  agreement_state, internal_note
)
select organization.id, 'external_partner', 'onboarding', 'Wana', 'Wana',
  'pending',
  'External Brand pilot. Customer identity is confirmed; agreement, contacts, and settlement treatment remain pending.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (organization_id) do nothing;

update public.portal_sku_intake as intake
set organization_id = organization.id
from public.portal_organization as organization
where intake.organization_id is null
  and organization.kind = 'brand'
  and lower(btrim(intake.brand_name)) = lower(btrim(organization.display_name));

comment on table public.portal_brand_profile_detail is
  'Server-owned Brand classification and activation record. Source-system mappings remain in portal_brand_account.';
comment on table public.portal_brand_purchase_order is
  'Durable Brand request record. Monday handoff is explicit and never inferred from a browser-only state.';
comment on table public.portal_brand_manufacturing_projection is
  'Read model for approved Monday manufacturing milestones; Canix remains the physical inventory source.';
comment on table public.portal_brand_operation_event is
  'Immutable audit evidence for Brand administration and operations changes.';
