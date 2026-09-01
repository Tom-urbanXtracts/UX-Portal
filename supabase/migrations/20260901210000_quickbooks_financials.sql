-- Read-only QuickBooks financial snapshots. QuickBooks remains authoritative;
-- the portal stores only the fields required to show balances, invoices,
-- payments, and store performance. Banking and remittance data are excluded.

create table if not exists public.quickbooks_invoice_cache (
  quickbooks_invoice_id text not null,
  sync_run_id uuid not null,
  quickbooks_customer_id text not null,
  doc_number text,
  txn_date date,
  due_date date,
  total_amount numeric not null default 0,
  balance numeric not null default 0,
  currency text,
  email_status text,
  print_status text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (quickbooks_invoice_id, sync_run_id)
);

create index if not exists quickbooks_invoice_customer_run_idx
  on public.quickbooks_invoice_cache (quickbooks_customer_id, sync_run_id, txn_date desc);
create index if not exists quickbooks_invoice_open_run_idx
  on public.quickbooks_invoice_cache (sync_run_id, due_date)
  where balance > 0;

create table if not exists public.quickbooks_payment_cache (
  quickbooks_payment_id text not null,
  sync_run_id uuid not null,
  quickbooks_customer_id text not null,
  txn_date date,
  total_amount numeric not null default 0,
  unapplied_amount numeric not null default 0,
  currency text,
  payment_method_name text,
  invoice_allocations jsonb not null default '[]'::jsonb,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (quickbooks_payment_id, sync_run_id),
  check (jsonb_typeof(invoice_allocations) = 'array')
);

create index if not exists quickbooks_payment_customer_run_idx
  on public.quickbooks_payment_cache (quickbooks_customer_id, sync_run_id, txn_date desc);

alter table public.quickbooks_sync_state
  add column if not exists last_financial_run_id uuid,
  add column if not exists financial_last_successful_at timestamptz,
  add column if not exists invoice_count integer,
  add column if not exists payment_count integer;

alter table public.quickbooks_invoice_cache enable row level security;
alter table public.quickbooks_payment_cache enable row level security;

revoke all on table public.quickbooks_invoice_cache from anon, authenticated;
revoke all on table public.quickbooks_payment_cache from anon, authenticated;
grant all on table public.quickbooks_invoice_cache to service_role;
grant all on table public.quickbooks_payment_cache to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;

alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check
  check (permission in (
    'inventory.read',
    'inventory.sync',
    'orders.manage',
    'accounts.manage',
    'pricing.manage',
    'catalog.manage',
    'financials.read',
    'quality.manage',
    'lineage.read',
    'users.manage',
    'audit.read',
    'readiness.read'
  )) not valid;

alter table public.portal_role_permission
  validate constraint portal_role_permission_permission_check;

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'financials.read'),
  ('operations', 'financials.read'),
  ('sales', 'financials.read')
on conflict do nothing;

comment on table public.quickbooks_invoice_cache is
  'Server-only normalized QuickBooks invoice snapshots. No line detail, banking data, or raw source payload is retained.';
comment on table public.quickbooks_payment_cache is
  'Server-only normalized QuickBooks payment snapshots. Only customer, totals, method label, and invoice allocations are retained.';
comment on column public.quickbooks_sync_state.last_financial_run_id is
  'The last fully successful invoice/payment snapshot. Failed or partial runs never replace it.';
