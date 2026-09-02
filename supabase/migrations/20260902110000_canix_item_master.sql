-- Maintain the complete Canix Item Master independently from package inventory.
-- The browser receives a protected normalized projection; the complete source
-- object remains server-only for audit and future field mapping.

create table if not exists public.canix_item_sync_state (
  id smallint primary key default 1 check (id = 1),
  status text not null default 'never_run'
    check (status in ('never_run', 'running', 'success', 'error')),
  active_run_id uuid,
  last_successful_run_id uuid,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_at timestamptz,
  latest_source_updated_at timestamptz,
  item_count integer not null default 0,
  item_pages integer not null default 0,
  last_error text,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.canix_item_sync_state (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.canix_item_current (
  item_id bigint primary key,
  name text,
  is_active boolean,
  item_type text,
  item_type_id bigint,
  item_type_name text,
  item_category_name text,
  item_sub_type_id bigint,
  item_sub_type_name text,
  brand_id bigint,
  brand_name text,
  product_id bigint,
  product_brand_id bigint,
  product_brand_name text,
  quantity_type text,
  sku text,
  accounting_inventory_type text,
  notes text,
  facility_id bigint,
  facility_name text,
  facility_license text,
  strain_id bigint,
  strain_name text,
  strain_type text,
  weight_unit text,
  unit_weight numeric,
  unit_weight_unit text,
  case_quantity text,
  case_quantity_unit text,
  unit_cbd_weight numeric,
  unit_cbd_weight_unit text,
  unit_thc_weight numeric,
  unit_thc_weight_unit text,
  unit_cbd_percent numeric,
  unit_thc_percent numeric,
  description text,
  serving_size numeric,
  number_of_doses numeric,
  public_ingredients text,
  supply_duration_days numeric,
  administration_method text,
  allergens text,
  transfer_source_license text,
  phenotype text,
  bills_of_materials jsonb not null default '[]'::jsonb,
  sage_item_external_id text,
  sage_item_name text,
  leaflink_item_external_id text,
  leaflink_item_name text,
  dutchie_product_external_id text,
  dutchie_product_name text,
  total_for_sale numeric,
  ordered numeric,
  backordered numeric,
  unordered numeric,
  current_standard_cost_amount numeric,
  current_standard_cost_currency text,
  current_standard_cost_start_date date,
  current_standard_cost_end_date date,
  source_updated_at timestamptz,
  sync_run_id uuid not null,
  synced_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists canix_item_current_facility_idx
  on public.canix_item_current (facility_id);
create index if not exists canix_item_current_active_idx
  on public.canix_item_current (is_active);
create index if not exists canix_item_current_brand_idx
  on public.canix_item_current (brand_id);
create index if not exists canix_item_current_name_idx
  on public.canix_item_current (lower(name));
create index if not exists canix_item_current_source_updated_idx
  on public.canix_item_current (source_updated_at desc);

create table if not exists public.canix_item_sync_stage
  (like public.canix_item_current including defaults including constraints);

alter table public.canix_item_sync_stage
  add constraint canix_item_sync_stage_pkey primary key (sync_run_id, item_id);

alter table public.canix_item_sync_state enable row level security;
alter table public.canix_item_current enable row level security;
alter table public.canix_item_sync_stage enable row level security;

revoke all on table public.canix_item_sync_state from public, anon, authenticated;
revoke all on table public.canix_item_current from public, anon, authenticated;
revoke all on table public.canix_item_sync_stage from public, anon, authenticated;
grant all on table public.canix_item_sync_state to service_role;
grant all on table public.canix_item_current to service_role;
grant all on table public.canix_item_sync_stage to service_role;

create or replace function public.canix_claim_item_sync_run(
  p_run_id uuid,
  p_force boolean default false,
  p_fresh_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state public.canix_item_sync_state%rowtype;
  started_at timestamptz := now();
begin
  if p_run_id is null then raise exception 'An item synchronization run ID is required'; end if;
  if p_fresh_seconds < 0 or p_fresh_seconds > 3600 then raise exception 'Invalid freshness window'; end if;

  select * into current_state
  from public.canix_item_sync_state
  where id = 1
  for update;

  if current_state.status = 'running' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'already_running',
      'lastStartedAt', current_state.last_started_at,
      'activeRunId', current_state.active_run_id
    );
  end if;
  if not p_force and current_state.last_successful_at is not null
    and current_state.last_successful_at > started_at - make_interval(secs => p_fresh_seconds) then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'fresh',
      'lastSuccessfulAt', current_state.last_successful_at
    );
  end if;

  update public.canix_item_sync_state
  set status = 'running',
      active_run_id = p_run_id,
      last_started_at = started_at,
      last_error = null,
      updated_at = started_at
  where id = 1;

  return jsonb_build_object('claimed', true, 'runId', p_run_id, 'startedAt', started_at);
end;
$$;

create or replace function public.canix_publish_item_sync_run(
  p_run_id uuid,
  p_item_count integer,
  p_item_pages integer,
  p_latest_source_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state public.canix_item_sync_state%rowtype;
  staged_count integer;
  column_list text;
  update_list text;
  completed_at timestamptz := now();
begin
  if p_run_id is null then raise exception 'An item synchronization run ID is required'; end if;
  if p_item_count < 0 or p_item_pages < 0 then
    raise exception 'Item synchronization counters must be non-negative';
  end if;

  select * into current_state
  from public.canix_item_sync_state
  where id = 1
  for update;

  if current_state.status <> 'running' or current_state.active_run_id is distinct from p_run_id then
    raise exception 'Canix item sync ownership was lost before snapshot publication';
  end if;

  select count(*) into staged_count
  from public.canix_item_sync_stage
  where sync_run_id = p_run_id;
  if staged_count <> p_item_count then
    raise exception 'The staged Canix item count does not match the completed fetch';
  end if;

  select
    string_agg(format('%I', column_name), ', ' order by ordinal_position),
    string_agg(format('%1$I = excluded.%1$I', column_name), ', ' order by ordinal_position)
      filter (where column_name <> 'item_id')
  into column_list, update_list
  from information_schema.columns
  where table_schema = 'public' and table_name = 'canix_item_current';

  execute format(
    'insert into public.canix_item_current (%1$s)
       select %1$s from public.canix_item_sync_stage where sync_run_id = $1
     on conflict (item_id) do update set %2$s',
    column_list,
    update_list
  ) using p_run_id;

  delete from public.canix_item_current where sync_run_id <> p_run_id;

  update public.canix_item_sync_state
  set status = 'success',
      active_run_id = null,
      last_successful_run_id = p_run_id,
      last_completed_at = completed_at,
      last_successful_at = completed_at,
      latest_source_updated_at = p_latest_source_updated_at,
      item_count = p_item_count,
      item_pages = p_item_pages,
      last_error = null,
      updated_at = completed_at
  where id = 1;

  delete from public.canix_item_sync_stage where true;

  return jsonb_build_object(
    'published', true,
    'runId', p_run_id,
    'items', p_item_count,
    'pages', p_item_pages,
    'completedAt', completed_at
  );
end;
$$;

revoke all on function public.canix_claim_item_sync_run(uuid, boolean, integer)
  from public, anon, authenticated;
revoke all on function public.canix_publish_item_sync_run(uuid, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.canix_claim_item_sync_run(uuid, boolean, integer)
  to service_role;
grant execute on function public.canix_publish_item_sync_run(uuid, integer, integer, timestamptz)
  to service_role;

comment on table public.canix_item_current is
  'Complete server-side Canix Item Master snapshot, including active and inactive items whether or not they have a current package.';
comment on column public.canix_item_current.source_payload is
  'Private original Canix Item object. Never returned to browsers.';
comment on function public.canix_publish_item_sync_run(uuid, integer, integer, timestamptz) is
  'Atomically publishes a complete staged Canix Item Master snapshot and retires items no longer returned by Canix.';
