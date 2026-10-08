-- Complete the first two Brand workspaces without inventing unresolved source
-- values. urbanXtracts is company-owned and operates across manufacturing,
-- sales, and distribution; those activities do not create self-contract gates.
-- Wana's activity model is declared, while Owner and Finance verification stay
-- visibly pending until the source systems contain approved values.

update public.portal_brand_governance_policy as policy
set relationship_template = 'company_owned',
    manufacturing_enabled = true,
    sales_enabled = true,
    distribution_enabled = true,
    ownership_model = 'ux',
    manufacturing_contact = coalesce(
      nullif(btrim(policy.manufacturing_contact), ''),
      nullif(btrim(detail.operations_contact_email), ''),
      nullif(btrim(detail.primary_contact_email), '')
    ),
    shipping_contact = coalesce(
      nullif(btrim(policy.shipping_contact), ''),
      nullif(btrim(detail.operations_contact_email), ''),
      nullif(btrim(detail.primary_contact_email), '')
    ),
    delivery_terms = coalesce(
      nullif(btrim(policy.delivery_terms), ''),
      'Internal company-owned distribution; Monday milestones remain authoritative.'
    ),
    updated_at = now()
from public.portal_organization as organization
join public.portal_brand_profile_detail as detail
  on detail.organization_id = organization.id
where policy.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'urbanXtracts';

update public.portal_brand_agreement_requirement as requirement
set applicability = 'not_required',
    decision_reason = 'Company-owned activity does not require an external agreement with itself.',
    review_owner = null,
    target_review_on = null,
    decision_by_email = coalesce(
      nullif(btrim(requirement.decision_by_email), ''),
      'system@urbanxtracts.com'
    ),
    decision_at = coalesce(requirement.decision_at, now()),
    updated_at = now()
from public.portal_organization as organization
where requirement.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'urbanXtracts';

update public.portal_brand_governance_policy as policy
set relationship_template = 'manufacturing_sales_distribution',
    manufacturing_enabled = true,
    sales_enabled = true,
    distribution_enabled = true,
    ownership_model = 'not_set',
    updated_at = now()
from public.portal_organization as organization
where policy.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'Wana';

update public.portal_brand_agreement_requirement as requirement
set applicability = case
      when requirement.requirement_code in (
        'nda', 'msa', 'manufacturing', 'sales', 'distribution', 'quality',
        'pricing_fee'
      ) then 'required'
      else 'not_required'
    end,
    decision_reason = case
      when requirement.requirement_code in (
        'nda', 'msa', 'manufacturing', 'sales', 'distribution', 'quality',
        'pricing_fee'
      ) then null
      else 'Not applicable to the currently declared Wana relationship activities.'
    end,
    review_owner = null,
    target_review_on = null,
    decision_by_email = case
      when requirement.requirement_code in (
        'nda', 'msa', 'manufacturing', 'sales', 'distribution', 'quality',
        'pricing_fee'
      ) then null
      else coalesce(
        nullif(btrim(requirement.decision_by_email), ''),
        'system@urbanxtracts.com'
      )
    end,
    decision_at = case
      when requirement.requirement_code in (
        'nda', 'msa', 'manufacturing', 'sales', 'distribution', 'quality',
        'pricing_fee'
      ) then null
      else coalesce(requirement.decision_at, now())
    end,
    updated_at = now()
from public.portal_organization as organization
where requirement.organization_id = organization.id
  and organization.kind = 'brand'
  and organization.legal_name = 'Wana';

create table if not exists public.portal_brand_reporting_exception (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  exception_code text not null,
  source_system text not null check (source_system in ('Canix', 'Monday', 'QuickBooks', 'Portal')),
  severity text not null default 'warning' check (severity in ('info', 'warning', 'blocking')),
  record_key text not null default 'organization',
  summary text not null,
  detail text,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, exception_code, record_key)
);

create index if not exists portal_brand_reporting_exception_open_idx
  on public.portal_brand_reporting_exception (organization_id, severity, last_seen_at desc)
  where status <> 'resolved';

alter table public.portal_brand_reporting_exception enable row level security;
revoke all on table public.portal_brand_reporting_exception from public, anon, authenticated;
grant all on table public.portal_brand_reporting_exception to service_role;

comment on table public.portal_brand_reporting_exception is
  'Server-owned cross-system data-quality and connector exceptions shown inside the scoped Brand workspace.';

create table if not exists public.quickbooks_credit_memo_cache (
  quickbooks_credit_memo_id text not null,
  sync_run_id uuid not null,
  quickbooks_customer_id text not null,
  doc_number text,
  txn_date date,
  total_amount numeric not null default 0,
  remaining_credit numeric not null default 0,
  currency text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (quickbooks_credit_memo_id, sync_run_id)
);

create index if not exists quickbooks_credit_memo_customer_run_idx
  on public.quickbooks_credit_memo_cache (
    quickbooks_customer_id, sync_run_id, txn_date desc
  );

alter table public.quickbooks_credit_memo_cache enable row level security;
revoke all on table public.quickbooks_credit_memo_cache from public, anon, authenticated;
grant all on table public.quickbooks_credit_memo_cache to service_role;

alter table public.quickbooks_sync_state
  add column if not exists credit_memo_count integer;

comment on table public.quickbooks_credit_memo_cache is
  'Server-only normalized QuickBooks credit memo snapshots. Line detail and raw source payloads are not retained.';

-- Extend the environment-bound connection transaction so credit memos can
-- never survive a sandbox/production switch.
create or replace function public.portal_store_quickbooks_connection_v2(
  p_realm_id text,
  p_refresh_token text,
  p_encryption_key text,
  p_refresh_token_expires_at timestamptz,
  p_actor uuid,
  p_environment text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  prior_environment text;
begin
  if length(coalesce(p_realm_id, '')) = 0
    or length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32
    or p_actor is null
    or p_environment not in ('sandbox', 'production') then
    raise exception 'Invalid QuickBooks connection material';
  end if;

  select connection_environment into prior_environment
  from public.quickbooks_sync_state where id = 1 for update;

  if prior_environment is distinct from p_environment then
    delete from public.quickbooks_invoice_cache where true;
    delete from public.quickbooks_payment_cache where true;
    delete from public.quickbooks_credit_memo_cache where true;
    delete from public.quickbooks_customer_cache where true;
    delete from public.quickbooks_vendor_cache where true;
  end if;

  update public.quickbooks_sync_state
  set realm_id = p_realm_id,
      encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token, p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      refresh_token = null,
      refresh_token_expires_at = p_refresh_token_expires_at,
      connection_environment = p_environment,
      connection_status = 'connected',
      connected_at = now(),
      connected_by = p_actor,
      last_financial_run_id = case when prior_environment is distinct from p_environment then null else last_financial_run_id end,
      financial_last_successful_at = case when prior_environment is distinct from p_environment then null else financial_last_successful_at end,
      last_successful_at = case when prior_environment is distinct from p_environment then null else last_successful_at end,
      customer_count = case when prior_environment is distinct from p_environment then null else customer_count end,
      vendor_count = case when prior_environment is distinct from p_environment then null else vendor_count end,
      invoice_count = case when prior_environment is distinct from p_environment then null else invoice_count end,
      payment_count = case when prior_environment is distinct from p_environment then null else payment_count end,
      credit_memo_count = case when prior_environment is distinct from p_environment then null else credit_memo_count end,
      status = case when prior_environment is distinct from p_environment then 'never' else status end,
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

revoke all on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  to service_role;

insert into public.portal_brand_reporting_exception (
  organization_id, exception_code, source_system, severity, summary, detail
)
select organization.id, 'canix_owner_coverage_incomplete', 'Canix', 'warning',
  'Some urbanXtracts Canix packages do not yet carry the new Owner field.',
  'The portal includes only packages explicitly assigned to Owner ID 23335. Older unowned packages remain excluded until Canix data is corrected.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'urbanXtracts'
on conflict (organization_id, exception_code, record_key) do update set
  status = 'open', last_seen_at = now(), updated_at = now(),
  summary = excluded.summary, detail = excluded.detail;

insert into public.portal_brand_reporting_exception (
  organization_id, exception_code, source_system, severity, summary, detail
)
select organization.id, 'monday_brand_milestone_callback_pending', 'Monday', 'warning',
  'The Brand milestone receiver is ready, but the approved Monday board and column mapping is still required.',
  'Until that mapping is configured, authenticated Internal users may publish milestones; the portal will not infer them from unrelated Monday statuses.'
from public.portal_organization as organization
where organization.kind = 'brand'
  and organization.legal_name in ('urbanXtracts', 'Wana')
on conflict (organization_id, exception_code, record_key) do update set
  status = 'open', last_seen_at = now(), updated_at = now(),
  summary = excluded.summary, detail = excluded.detail;

insert into public.portal_brand_reporting_exception (
  organization_id, exception_code, source_system, severity, summary, detail
)
select organization.id, 'canix_owner_mapping_required', 'Canix', 'blocking',
  'Wana inventory is blocked until an approved Canix Owner ID exists.',
  'Brand identity is descriptive and is not used as the inventory access boundary.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (organization_id, exception_code, record_key) do update set
  status = 'open', last_seen_at = now(), updated_at = now(),
  summary = excluded.summary, detail = excluded.detail;

insert into public.portal_brand_reporting_exception (
  organization_id, exception_code, source_system, severity, summary, detail
)
select organization.id, 'quickbooks_identity_review_required', 'QuickBooks', 'blocking',
  'Wana financial amounts remain withheld pending Finance identity review.',
  'QuickBooks customer 50 is mapped, but the Brand financial policy remains pending Finance verification.'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Wana'
on conflict (organization_id, exception_code, record_key) do update set
  status = 'open', last_seen_at = now(), updated_at = now(),
  summary = excluded.summary, detail = excluded.detail;
