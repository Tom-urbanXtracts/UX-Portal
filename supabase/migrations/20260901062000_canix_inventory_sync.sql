create table if not exists public.canix_sync_state (
  id smallint primary key default 1 check (id = 1),
  status text not null default 'never_run' check (status in ('never_run', 'running', 'success', 'error')),
  active_run_id uuid,
  last_successful_run_id uuid,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_at timestamptz,
  latest_source_updated_at timestamptz,
  package_count integer not null default 0,
  package_pages integer not null default 0,
  sales_order_pages integer not null default 0,
  last_error text,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.canix_sync_state (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.canix_package_current (
  package_id bigint primary key,
  tag text,
  item_id bigint,
  item_name text,
  sku text,
  item_category_name text,
  item_sub_category_name text,
  product_name text,
  brand_id bigint,
  brand_name text,
  owner_id bigint,
  owner_name text,
  strain_name text,
  strain_type text,
  quantity_type text not null check (quantity_type in ('WeightBased', 'CountBased')),
  weight numeric,
  weight_unit_name text,
  c_weight_g numeric,
  c_reserved_weight numeric,
  uom_code text check (uom_code is null or uom_code in ('G_IN', 'G_OUT', 'G_DRY', 'G_WET')),
  facility_id bigint,
  facility_name text,
  facility_license text,
  room_id bigint,
  room_name text,
  status text,
  status_category text not null check (status_category in ('available', 'in_progress', 'allocated')),
  compliance_submitted boolean,
  lab_test_status text,
  test_result_status text,
  has_coa boolean,
  marked_available boolean,
  is_finished_good boolean,
  packaged_date date,
  expiration_date date,
  use_by_date date,
  age_days integer,
  order_item_id bigint,
  cost_object_id bigint,
  sales_order_id bigint,
  sales_order_name text,
  sales_order_status text,
  sales_order_delivery_date timestamptz,
  source_updated_at timestamptz,
  sync_run_id uuid not null,
  synced_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists canix_package_current_run_idx
  on public.canix_package_current (sync_run_id);
create index if not exists canix_package_current_facility_idx
  on public.canix_package_current (facility_id);
create index if not exists canix_package_current_status_idx
  on public.canix_package_current (status_category);
create index if not exists canix_package_current_owner_idx
  on public.canix_package_current (owner_id);
create index if not exists canix_package_current_uom_idx
  on public.canix_package_current (uom_code);
create index if not exists canix_package_current_cost_object_idx
  on public.canix_package_current (cost_object_id);
create index if not exists canix_package_current_source_updated_idx
  on public.canix_package_current (source_updated_at desc);

alter table public.canix_sync_state enable row level security;
alter table public.canix_package_current enable row level security;

revoke all on table public.canix_sync_state from anon, authenticated;
revoke all on table public.canix_package_current from anon, authenticated;
grant all on table public.canix_sync_state to service_role;
grant all on table public.canix_package_current to service_role;

comment on table public.canix_package_current is
  'Server-side Canix package cache. Browser roles have no direct table access; the Edge Function applies authentication and field filtering.';
comment on column public.canix_package_current.owner_name is
  'Legacy nullable placeholder. Brand must never be treated as legal or economic ownership; a later migration adds explicit fields.';
comment on column public.canix_package_current.uom_code is
  'urbanXtracts-approved nullable alias of the free-form Canix package status, restricted to G_IN/G_OUT/G_DRY/G_WET.';
comment on column public.canix_package_current.cost_object_id is
  'urbanXtracts-approved nullable alias of the Canix sales order line id.';
