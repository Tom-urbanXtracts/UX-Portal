-- Structured agreement economics and the second-generation six-section SKU
-- intake. Browser roles retain no direct access: the two protected Edge
-- Functions remain the only read/write boundary.

alter table public.portal_brand_agreement
  add column if not exists payment_terms text,
  add column if not exists settlement_frequency text,
  add column if not exists currency_code text not null default 'USD'
    check (currency_code ~ '^[A-Z]{3}$'),
  add column if not exists responsible_internal_owner text,
  add column if not exists finance_approver text,
  add column if not exists legal_approver text,
  add column if not exists source_clause_reference text,
  add column if not exists commercial_terms_note text,
  add column if not exists commercial_terms_state text not null default 'not_applicable'
    check (commercial_terms_state in (
      'not_applicable', 'draft', 'pending_finance', 'pending_legal', 'approved', 'superseded'
    )),
  add column if not exists finance_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists finance_approved_by_email text,
  add column if not exists finance_approved_at timestamptz,
  add column if not exists legal_confirmed_by uuid references auth.users(id) on delete set null,
  add column if not exists legal_confirmed_by_email text,
  add column if not exists legal_confirmed_at timestamptz;

create table if not exists public.portal_brand_agreement_fee_line (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.portal_brand_agreement(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  fee_name text not null check (length(btrim(fee_name)) between 1 and 200),
  fee_category text not null check (fee_category in (
    'onboarding_setup', 'manufacturing_processing', 'toll', 'packaging',
    'ingredient_component', 'lab', 'storage', 'distribution', 'sales_commission',
    'revenue_share', 'licensing_royalty', 'monthly_minimum', 'pass_through',
    'credit_rebate', 'other'
  )),
  calculation_method text not null check (calculation_method in (
    'fixed', 'per_unit', 'per_case', 'per_pound', 'per_gram', 'percentage_gross',
    'percentage_net', 'percentage_collected', 'tiered', 'cost_plus',
    'pass_through', 'custom_manual'
  )),
  rate_amount numeric,
  percentage_rate numeric check (percentage_rate is null or percentage_rate between 0 and 100),
  uom_code text,
  calculation_basis text,
  payer text,
  recipient text,
  scope_summary text,
  effective_on date,
  ends_on date,
  billing_frequency text,
  minimum_amount numeric check (minimum_amount is null or minimum_amount >= 0),
  maximum_amount numeric check (maximum_amount is null or maximum_amount >= 0),
  quickbooks_mapping text,
  brand_visibility text not null default 'summary'
    check (brand_visibility in ('hidden', 'summary', 'full')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'inactive', 'superseded')),
  conditional_detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(conditional_detail) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, line_number),
  check (ends_on is null or effective_on is null or ends_on >= effective_on),
  check (maximum_amount is null or minimum_amount is null or maximum_amount >= minimum_amount),
  check (
    calculation_method not like 'percentage_%'
    or (percentage_rate is not null and nullif(btrim(calculation_basis), '') is not null)
  ),
  check (
    calculation_method not in ('per_unit', 'per_case', 'per_pound', 'per_gram')
    or nullif(btrim(uom_code), '') is not null
  )
);

create index if not exists portal_brand_agreement_fee_line_agreement_idx
  on public.portal_brand_agreement_fee_line (agreement_id, line_number);

alter table public.portal_brand_agreement_fee_line enable row level security;
revoke all on table public.portal_brand_agreement_fee_line from public, anon, authenticated;
grant all on table public.portal_brand_agreement_fee_line to service_role;

create or replace function public.portal_enforce_commercial_terms_activation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.visibility = 'published' and new.status in ('active', 'expiring')
     and (new.commercial_terms_state <> 'not_applicable'
          or exists (select 1 from public.portal_brand_agreement_fee_line where agreement_id = new.id))
     and new.commercial_terms_state <> 'approved' then
    raise exception 'Commercial terms require Finance approval and Legal confirmation before publication';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_brand_agreement_commercial_activation_gate
  on public.portal_brand_agreement;
create trigger portal_brand_agreement_commercial_activation_gate
before update of status, visibility on public.portal_brand_agreement
for each row execute function public.portal_enforce_commercial_terms_activation();

revoke all on function public.portal_enforce_commercial_terms_activation()
  from public, anon, authenticated;
grant execute on function public.portal_enforce_commercial_terms_activation()
  to service_role;

-- Convert existing ten-section SKU packets into the approved six-section
-- structure while retaining documents, events, and immutable revision rows.
alter table public.portal_sku_intake
  add column if not exists workflow_version integer not null default 2
    check (workflow_version in (1, 2));

alter table public.portal_sku_intake_section
  drop constraint if exists portal_sku_intake_section_section_key_check;
alter table public.portal_sku_intake_section
  drop constraint if exists portal_sku_intake_section_position_check;

-- Merge legacy section data into the six durable anchor rows.
update public.portal_sku_intake_section as target
set data = target.data || coalesce(source.merged, '{}'::jsonb),
    completion_percent = least(target.completion_percent, 99),
    status = case when target.status = 'approved' then 'reopened' else target.status end,
    approved_at = null,
    review_note = case when target.status = 'approved'
      then 'Reopened automatically when the SKU packet moved to the six-section format.'
      else target.review_note end,
    updated_at = now()
from (
  select intake_id, jsonb_object_agg(entry.key, entry.value) as merged
  from public.portal_sku_intake_section as section
  cross join lateral jsonb_each(section.data) as entry
  where section.section_key in ('ingredients', 'suppliers', 'allergens')
  group by intake_id
) as source
where target.intake_id = source.intake_id and target.section_key = 'formulation';

update public.portal_sku_intake_section as target
set data = target.data || source.data,
    completion_percent = least(target.completion_percent, 99),
    status = case when target.status = 'approved' then 'reopened' else target.status end,
    approved_at = null,
    updated_at = now()
from public.portal_sku_intake_section as source
where target.intake_id = source.intake_id and target.section_key = 'packaging'
  and source.section_key = 'label';

update public.portal_sku_intake_section as target
set data = target.data || source.data,
    completion_percent = least(target.completion_percent, 99),
    status = case when target.status = 'approved' then 'reopened' else target.status end,
    approved_at = null,
    updated_at = now()
from public.portal_sku_intake_section as source
where target.intake_id = source.intake_id and target.section_key = 'marketing'
  and source.section_key = 'claims';

-- Preserve stored evidence under the new parent section with collision-safe keys.
update public.portal_sku_intake_document as document
set field_key = source.section_key || '_' || document.field_key,
    section_id = target.id
from public.portal_sku_intake_section as source,
     public.portal_sku_intake_section as target
where document.section_id = source.id
  and source.intake_id = target.intake_id
  and (
    (source.section_key in ('ingredients', 'suppliers', 'allergens') and target.section_key = 'formulation')
    or (source.section_key = 'label' and target.section_key = 'packaging')
    or (source.section_key = 'claims' and target.section_key = 'marketing')
  );

update public.portal_sku_intake_event as event
set section_id = target.id
from public.portal_sku_intake_section as source,
     public.portal_sku_intake_section as target
where event.section_id = source.id
  and source.intake_id = target.intake_id
  and (
    (source.section_key in ('ingredients', 'suppliers', 'allergens') and target.section_key = 'formulation')
    or (source.section_key = 'label' and target.section_key = 'packaging')
    or (source.section_key = 'claims' and target.section_key = 'marketing')
  );

-- Revision snapshots remain immutable evidence; move them to the anchor and
-- resequence without overwriting their original data or actor details.
update public.portal_sku_intake_section_revision
set revision = 1000000 + id::integer;

update public.portal_sku_intake_section_revision as revision
set section_id = target.id,
    data = revision.data || jsonb_build_object('_migrated_from_section', source.section_key)
from public.portal_sku_intake_section as source,
     public.portal_sku_intake_section as target
where revision.section_id = source.id
  and source.intake_id = target.intake_id
  and (
    (source.section_key in ('ingredients', 'suppliers', 'allergens') and target.section_key = 'formulation')
    or (source.section_key = 'label' and target.section_key = 'packaging')
    or (source.section_key = 'claims' and target.section_key = 'marketing')
  );

with ordered as (
  select id, row_number() over (partition by section_id order by created_at, id)::integer as next_revision
  from public.portal_sku_intake_section_revision
)
update public.portal_sku_intake_section_revision as revision
set revision = ordered.next_revision
from ordered where ordered.id = revision.id;

update public.portal_sku_intake_section as section
set revision = coalesce(source.max_revision, section.revision)
from (
  select section_id, max(revision) as max_revision
  from public.portal_sku_intake_section_revision group by section_id
) as source
where section.id = source.section_id;

delete from public.portal_sku_intake_section
where section_key in ('ingredients', 'allergens', 'label', 'claims');

update public.portal_sku_intake_section_invite as invite
set active = false, revoked_at = coalesce(revoked_at, now())
from public.portal_sku_intake_section as section
where invite.section_id = section.id
  and section.section_key = 'suppliers'
  and invite.active = true;

-- The legacy supplier anchor becomes Commercial & Ordering after its data has
-- been merged into Formulation & BOM.
update public.portal_sku_intake_section set position = position + 100;
update public.portal_sku_intake_section
set section_key = case section_key
      when 'basics' then 'product_identity'
      when 'suppliers' then 'commercial_ordering'
      when 'formulation' then 'formulation_bom'
      when 'packaging' then 'packaging_labeling'
      when 'notes' then 'quality_compliance'
      when 'marketing' then 'marketing_launch'
      else section_key end,
    title = case section_key
      when 'basics' then 'Product Identity & Ownership'
      when 'suppliers' then 'Commercial & Ordering'
      when 'formulation' then 'Formulation & Bill of Materials'
      when 'packaging' then 'Packaging & Labeling'
      when 'notes' then 'Manufacturing, Quality & Compliance'
      when 'marketing' then 'Marketing, Integrations & Launch'
      else title end,
    position = case section_key
      when 'basics' then 1 when 'suppliers' then 2 when 'formulation' then 3
      when 'packaging' then 4 when 'notes' then 5 when 'marketing' then 6
      else position end,
    data = case when section_key = 'suppliers' then '{}'::jsonb else data end,
    completion_percent = case when section_key = 'suppliers' then 0 else least(completion_percent, 99) end,
    revision = case when section_key = 'suppliers' then 0 else revision end,
    status = case when section_key = 'suppliers' then 'not_started'
      when status = 'approved' then 'reopened' else status end,
    approved_at = null,
    updated_at = now();

alter table public.portal_sku_intake_section
  add constraint portal_sku_intake_section_section_key_check check (section_key in (
    'product_identity', 'commercial_ordering', 'formulation_bom',
    'packaging_labeling', 'quality_compliance', 'marketing_launch'
  ));
alter table public.portal_sku_intake_section
  add constraint portal_sku_intake_section_position_check check (position between 1 and 6);

update public.portal_sku_intake
set workflow_version = 2,
    status = case when status in ('approved', 'changes_requested') then 'in_review' else status end,
    approved_by = null,
    approved_by_email = null,
    approved_at = null,
    updated_at = now();

comment on table public.portal_brand_agreement_fee_line is
  'Version-bound commercial fee lines. Signed agreements remain legal authority; these rows are controlled reporting summaries.';
comment on column public.portal_brand_agreement.commercial_terms_state is
  'Finance approval and Legal confirmation gate for structured terms before an agreement can be published.';
comment on column public.portal_sku_intake.workflow_version is
  'Version 2 uses six separately assigned, submitted, reviewed, and reopened sections.';
