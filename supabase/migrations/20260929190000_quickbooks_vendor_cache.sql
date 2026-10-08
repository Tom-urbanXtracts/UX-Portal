-- Read-only QuickBooks Vendor identity cache used for controlled brand and
-- counterparty reconciliation. QuickBooks remains authoritative. The portal
-- intentionally excludes tax identifiers, account numbers, payment details,
-- street addresses, and raw Vendor payloads.

create table if not exists public.quickbooks_vendor_cache (
  quickbooks_vendor_id text primary key,
  display_name text not null,
  company_name text,
  active boolean not null default true,
  balance numeric,
  vendor_1099 boolean not null default false,
  email text,
  billing_city text,
  billing_region text,
  billing_postal_code text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists quickbooks_vendor_display_name_idx
  on public.quickbooks_vendor_cache (display_name);

alter table public.quickbooks_vendor_cache enable row level security;
revoke all on table public.quickbooks_vendor_cache from public, anon, authenticated;
grant all on table public.quickbooks_vendor_cache to service_role;

alter table public.quickbooks_sync_state
  add column if not exists vendor_count integer;

comment on table public.quickbooks_vendor_cache is
  'Server-only normalized QuickBooks Vendor identities for internal reconciliation. Sensitive accounting fields and raw source payloads are not retained.';
comment on column public.quickbooks_sync_state.vendor_count is
  'Number of normalized Vendor identities in the last successful combined QuickBooks sync.';

-- Keep Vendor identities isolated with the same environment boundary as the
-- Customer, Invoice, and Payment caches.
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
  from public.quickbooks_sync_state
  where id = 1
  for update;

  if prior_environment is distinct from p_environment then
    delete from public.quickbooks_invoice_cache where true;
    delete from public.quickbooks_payment_cache where true;
    delete from public.quickbooks_customer_cache where true;
    delete from public.quickbooks_vendor_cache where true;
  end if;

  update public.quickbooks_sync_state
  set realm_id = p_realm_id,
      encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      refresh_token = null,
      refresh_token_expires_at = p_refresh_token_expires_at,
      connection_environment = p_environment,
      connection_status = 'connected',
      connected_at = now(),
      connected_by = p_actor,
      last_financial_run_id = case
        when prior_environment is distinct from p_environment then null
        else last_financial_run_id
      end,
      financial_last_successful_at = case
        when prior_environment is distinct from p_environment then null
        else financial_last_successful_at
      end,
      last_successful_at = case
        when prior_environment is distinct from p_environment then null
        else last_successful_at
      end,
      customer_count = case
        when prior_environment is distinct from p_environment then null
        else customer_count
      end,
      vendor_count = case
        when prior_environment is distinct from p_environment then null
        else vendor_count
      end,
      invoice_count = case
        when prior_environment is distinct from p_environment then null
        else invoice_count
      end,
      payment_count = case
        when prior_environment is distinct from p_environment then null
        else payment_count
      end,
      status = case
        when prior_environment is distinct from p_environment then 'never'
        else status
      end,
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

revoke all on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  to service_role;

comment on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text) is
  'Stores an environment-bound encrypted QuickBooks connection and explicitly clears every prior-environment cache row, including Vendor identities, inside the same transaction.';
