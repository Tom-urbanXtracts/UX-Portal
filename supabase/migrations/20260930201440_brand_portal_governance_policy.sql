-- Configurable Brand-portal governance approved on 2026-09-30.
-- These records are server-owned. Browser clients reach them only through the
-- scoped portal-brand-operations function so contract, sales, distribution,
-- and Finance decisions share one audited policy boundary.

alter table public.portal_brand_agreement
  add column if not exists requirement_code text,
  add column if not exists visibility text not null default 'internal'
    check (visibility in ('internal', 'published', 'archived')),
  add column if not exists version_label text,
  add column if not exists renewal_owner text,
  add column if not exists renewal_notice_days integer[] not null default array[90, 60, 30, 0],
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid references auth.users(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists supersedes_agreement_id uuid references public.portal_brand_agreement(id) on delete set null,
  add column if not exists terms_mode text not null default 'metadata_only'
    check (terms_mode in ('metadata_only', 'approved_structured_terms'));

alter table public.portal_brand_agreement
  drop constraint if exists portal_brand_agreement_status_check;
alter table public.portal_brand_agreement
  add constraint portal_brand_agreement_status_check
  check (status in (
    'draft', 'in_review', 'awaiting_signature', 'active', 'expiring',
    'expired', 'superseded', 'terminated'
  ));

update public.portal_brand_agreement
set renewal_owner = coalesce(nullif(btrim(renewal_owner), ''), 'Operations'),
    updated_at = now();

create table if not exists public.portal_brand_governance_policy (
  organization_id uuid primary key references public.portal_organization(id) on delete cascade,
  policy_version integer not null default 1 check (policy_version > 0),
  effective_on date not null default current_date,
  contract_publish_mode text not null default 'internal_approval'
    check (contract_publish_mode in ('internal_approval')),
  archive_visibility text not null default 'published_executed_history'
    check (archive_visibility in ('published_executed_history', 'current_only')),
  contract_terms_mode text not null default 'metadata_only'
    check (contract_terms_mode in ('metadata_only', 'approved_structured_terms')),
  renewal_default_owner text not null default 'Operations',
  renewal_reminder_days integer[] not null default array[90, 60, 30, 0],
  sales_units_visibility text not null default 'enabled'
    check (sales_units_visibility in ('enabled', 'withheld')),
  sales_dollars_visibility text not null default 'finance_approved'
    check (sales_dollars_visibility in ('withheld', 'finance_approved')),
  retailer_identity_visibility text not null default 'withheld'
    check (retailer_identity_visibility in ('withheld')),
  sales_download_enabled boolean not null default true,
  sales_reporting_dimensions text[] not null default array['sku', 'month', 'order', 'territory'],
  allocated_inventory_visibility text not null default 'status_only'
    check (allocated_inventory_visibility in ('hidden', 'status_only', 'approved_quantity')),
  destination_visibility text not null default 'territory_only'
    check (destination_visibility in ('hidden', 'territory_only')),
  manifest_visibility text not null default 'approved_documents'
    check (manifest_visibility in ('hidden', 'approved_documents')),
  delivery_authority text not null default 'milestone_sources'
    check (delivery_authority in ('milestone_sources', 'monday_with_evidence')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(renewal_reminder_days) > 0),
  check (cardinality(sales_reporting_dimensions) > 0)
);

create table if not exists public.portal_brand_agreement_requirement (
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  requirement_code text not null,
  agreement_name text not null,
  applicability text not null default 'conditional'
    check (applicability in ('required', 'conditional', 'not_required', 'pending_review')),
  condition_summary text not null,
  gate_code text not null,
  sort_order integer not null check (sort_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, requirement_code)
);

alter table public.portal_brand_agreement
  drop constraint if exists portal_brand_agreement_requirement_fkey;
alter table public.portal_brand_agreement
  add constraint portal_brand_agreement_requirement_fkey
  foreign key (organization_id, requirement_code)
  references public.portal_brand_agreement_requirement(organization_id, requirement_code)
  on delete restrict;

create table if not exists public.portal_brand_financial_policy (
  organization_id uuid primary key references public.portal_organization(id) on delete cascade,
  quickbooks_classification text not null default 'pending_finance_review'
    check (quickbooks_classification in (
      'customer', 'vendor', 'both', 'company_owned_not_applicable', 'pending_finance_review'
    )),
  identity_status text not null default 'pending_finance_review'
    check (identity_status in ('pending_finance_review', 'verified', 'blocked')),
  ar_visibility text not null default 'quickbooks_read_only'
    check (ar_visibility in ('not_applicable', 'quickbooks_read_only', 'withheld')),
  statement_state text not null default 'pending_finance_approval'
    check (statement_state in ('not_required', 'pending_finance_approval', 'enabled')),
  sales_dollars_state text not null default 'withheld_pending_finance_approval'
    check (sales_dollars_state in ('internal_only', 'withheld_pending_finance_approval', 'approved')),
  settlement_state text not null default 'pending_agreement'
    check (settlement_state in ('not_required', 'pending_agreement', 'configured', 'approved')),
  banking_setup_state text not null default 'pending'
    check (banking_setup_state in ('not_required', 'pending', 'verified')),
  bank_name text,
  account_holder_name text,
  account_last_four text check (account_last_four is null or account_last_four ~ '^[0-9]{4}$'),
  banking_verified_at timestamptz,
  secure_provider_reference text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_email text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_brand_settlement_rule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  agreement_id uuid references public.portal_brand_agreement(id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'expired', 'superseded')),
  calculation_basis text not null
    check (calculation_basis in ('ordered', 'shipped', 'delivered', 'invoiced', 'collected')),
  settlement_frequency text not null
    check (settlement_frequency in ('weekly', 'biweekly', 'monthly', 'quarterly', 'manual')),
  percentage_bps integer check (percentage_bps is null or percentage_bps between 0 and 10000),
  fixed_fee_cents bigint check (fixed_fee_cents is null or fixed_fee_cents >= 0),
  allowed_deductions text[] not null default array[]::text[],
  effective_on date not null,
  expires_on date,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, version),
  check (expires_on is null or expires_on >= effective_on),
  check (status <> 'approved' or approved_at is not null)
);

create table if not exists public.portal_brand_distribution_milestone (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  purchase_order_id uuid references public.portal_brand_purchase_order(id) on delete cascade,
  status text not null check (status in (
    'draft', 'ordered', 'approved', 'production', 'preparing_for_shipment',
    'shipped', 'delivered', 'completed', 'on_hold', 'delayed',
    'partially_shipped', 'action_required', 'rejected', 'cancelled'
  )),
  source_system text not null check (source_system in ('Portal', 'Monday', 'Canix', 'Carrier')),
  brand_visible boolean not null default true,
  external_note text,
  evidence_reference text,
  occurred_at timestamptz not null,
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists portal_brand_requirement_org_idx
  on public.portal_brand_agreement_requirement (organization_id, sort_order);
create index if not exists portal_brand_settlement_org_idx
  on public.portal_brand_settlement_rule (organization_id, status, effective_on desc);
create index if not exists portal_brand_distribution_org_idx
  on public.portal_brand_distribution_milestone (organization_id, occurred_at desc);
create index if not exists portal_brand_distribution_po_idx
  on public.portal_brand_distribution_milestone (purchase_order_id, occurred_at);

alter table public.portal_brand_governance_policy enable row level security;
alter table public.portal_brand_agreement_requirement enable row level security;
alter table public.portal_brand_financial_policy enable row level security;
alter table public.portal_brand_settlement_rule enable row level security;
alter table public.portal_brand_distribution_milestone enable row level security;

revoke all on table public.portal_brand_governance_policy,
  public.portal_brand_agreement_requirement,
  public.portal_brand_financial_policy,
  public.portal_brand_settlement_rule,
  public.portal_brand_distribution_milestone
from public, anon, authenticated;

grant all on table public.portal_brand_governance_policy,
  public.portal_brand_agreement_requirement,
  public.portal_brand_financial_policy,
  public.portal_brand_settlement_rule,
  public.portal_brand_distribution_milestone
to service_role;

insert into public.portal_brand_governance_policy (organization_id)
select id from public.portal_organization where kind = 'brand'
on conflict (organization_id) do nothing;

insert into public.portal_brand_financial_policy (
  organization_id, quickbooks_classification, identity_status, ar_visibility,
  statement_state, sales_dollars_state, settlement_state, banking_setup_state
)
select organization.id,
  case
    when detail.classification = 'company_owned' then 'company_owned_not_applicable'
    when account.quickbooks_entity_type in ('customer', 'vendor', 'both') then account.quickbooks_entity_type
    else 'pending_finance_review'
  end,
  case when detail.classification = 'company_owned' then 'verified' else 'pending_finance_review' end,
  case when detail.classification = 'company_owned' then 'not_applicable' else 'quickbooks_read_only' end,
  case when detail.classification = 'company_owned' then 'not_required' else 'pending_finance_approval' end,
  case when detail.classification = 'company_owned' then 'internal_only' else 'withheld_pending_finance_approval' end,
  case when detail.classification = 'company_owned' then 'not_required' else 'pending_agreement' end,
  case when detail.classification = 'company_owned' then 'not_required' else 'pending' end
from public.portal_organization as organization
left join public.portal_brand_profile_detail as detail on detail.organization_id = organization.id
left join public.portal_brand_account as account on account.organization_id = organization.id
where organization.kind = 'brand'
on conflict (organization_id) do nothing;

with requirements(requirement_code, agreement_name, condition_summary, gate_code, sort_order) as (
  values
    ('nda', 'NDA', 'Required before onboarding unless the MSA contains equivalent confidentiality language.', 'onboarding', 10),
    ('msa', 'Master Service Agreement', 'Required for every external Brand.', 'onboarding', 20),
    ('manufacturing', 'Manufacturing / Processing Agreement', 'Required before urbanXtracts begins production or processing.', 'production', 30),
    ('sales', 'Sales Agreement', 'Required before products are offered for sale.', 'sale', 40),
    ('distribution', 'Distribution Agreement', 'Required before distribution begins.', 'distribution', 50),
    ('quality', 'Quality Agreement', 'Required before production begins.', 'production', 60),
    ('brand_ip', 'Brand / IP License', 'Required when trademark rights are not already covered by the MSA.', 'brand_use', 70),
    ('tolling', 'Tolling Agreement', 'Required for TOLL ownership arrangements.', 'toll', 80),
    ('consignment', 'Consignment Agreement', 'Required for consigned inventory.', 'consignment', 90),
    ('revenue_share', 'Revenue Share Agreement', 'Required before settlement calculations begin.', 'settlement', 100),
    ('pricing_fee', 'Pricing / Fee Schedule', 'Attach as a controlled exhibit to the governing agreement.', 'commercial', 110),
    ('ach', 'ACH / Payment Authorization', 'Required only when electronic payments are implemented.', 'electronic_payments', 120)
)
insert into public.portal_brand_agreement_requirement (
  organization_id, requirement_code, agreement_name, applicability,
  condition_summary, gate_code, sort_order
)
select organization.id, requirement.requirement_code, requirement.agreement_name,
  case
    when detail.classification = 'company_owned' then 'not_required'
    when requirement.requirement_code = 'msa' then 'required'
    else 'conditional'
  end,
  requirement.condition_summary, requirement.gate_code, requirement.sort_order
from public.portal_organization as organization
join public.portal_brand_profile_detail as detail on detail.organization_id = organization.id
cross join requirements as requirement
where organization.kind = 'brand'
on conflict (organization_id, requirement_code) do update set
  agreement_name = excluded.agreement_name,
  condition_summary = excluded.condition_summary,
  gate_code = excluded.gate_code,
  sort_order = excluded.sort_order,
  updated_at = now();

comment on table public.portal_brand_governance_policy is
  'Versioned Brand-facing visibility and document-governance defaults. Every write is server-side and audited.';
comment on table public.portal_brand_agreement_requirement is
  'Per-Brand agreement applicability. Required versus conditional is explicit and never inferred from an uploaded contract.';
comment on table public.portal_brand_financial_policy is
  'Finance-approved QuickBooks relationship and Brand-visible AR, statement, settlement, and masked banking states.';
comment on table public.portal_brand_settlement_rule is
  'Versioned settlement configuration entered from an approved agreement. Contract text is never parsed into a live formula automatically.';
comment on table public.portal_brand_distribution_milestone is
  'Brand-safe order and shipment timeline. Each milestone retains its authoritative source and optional approved evidence reference.';
comment on column public.portal_brand_financial_policy.account_last_four is
  'Only the final four account digits may be retained. Full account and routing numbers are prohibited from portal storage.';
