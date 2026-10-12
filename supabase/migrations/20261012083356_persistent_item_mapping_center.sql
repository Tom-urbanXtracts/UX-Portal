-- Persistent cross-system item identity. Source snapshots remain read-only;
-- Portal decisions survive every Canix and QuickBooks refresh.

create table if not exists public.quickbooks_item_cache (
  quickbooks_item_id text primary key,
  name text not null,
  fully_qualified_name text,
  sku text,
  item_type text,
  active boolean not null default true,
  description text,
  parent_item_id text,
  income_account_id text,
  expense_account_id text,
  asset_account_id text,
  purchase_cost numeric,
  unit_price numeric,
  track_quantity boolean not null default false,
  quantity_on_hand numeric,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create table if not exists public.portal_item_source_mapping (
  source_system text not null check (source_system in ('canix','quickbooks')),
  source_item_id text not null,
  source_name text,
  source_brand_name text,
  source_sku text,
  source_item_type text,
  source_active boolean,
  source_present boolean not null default true,
  source_updated_at timestamptz,
  last_seen_at timestamptz not null default now(),
  portal_sku_reference text,
  portal_sku_id uuid references public.portal_sku_intake(id) on delete set null,
  decision_status text not null default 'to_be_mapped'
    check (decision_status in ('to_be_mapped','pending_review','approved','conflict','not_required','archived','source_missing')),
  match_method text,
  match_confidence numeric check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  decision_note text not null default '',
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_system, source_item_id),
  check (nullif(btrim(source_item_id), '') is not null),
  check (decision_status <> 'approved' or nullif(btrim(portal_sku_reference), '') is not null)
);

create index if not exists quickbooks_item_cache_name_idx
  on public.quickbooks_item_cache (lower(name));
create index if not exists quickbooks_item_cache_sku_idx
  on public.quickbooks_item_cache (lower(sku)) where sku is not null;
create index if not exists portal_item_source_mapping_queue_idx
  on public.portal_item_source_mapping (decision_status, source_system, updated_at desc);
create index if not exists portal_item_source_mapping_portal_sku_idx
  on public.portal_item_source_mapping (portal_sku_id, source_system)
  where portal_sku_id is not null;

alter table public.quickbooks_sync_state
  add column if not exists item_count integer;

alter table public.quickbooks_item_cache enable row level security;
alter table public.portal_item_source_mapping enable row level security;
revoke all on table public.quickbooks_item_cache, public.portal_item_source_mapping
  from public, anon, authenticated;
grant all on table public.quickbooks_item_cache, public.portal_item_source_mapping
  to service_role;

-- Seed the durable source register without replacing any existing decisions.
insert into public.portal_item_source_mapping (
  source_system, source_item_id, source_name, source_brand_name, source_sku,
  source_item_type, source_active, source_present, source_updated_at,
  last_seen_at, decision_status
)
select 'canix', item_id::text, name,
  coalesce(product_brand_name, brand_name), sku,
  coalesce(item_type_name, item_category_name), is_active, true,
  source_updated_at, synced_at, 'to_be_mapped'
from public.canix_item_current
on conflict (source_system, source_item_id) do update set
  source_name = excluded.source_name,
  source_brand_name = excluded.source_brand_name,
  source_sku = excluded.source_sku,
  source_item_type = excluded.source_item_type,
  source_active = excluded.source_active,
  source_present = true,
  source_updated_at = excluded.source_updated_at,
  last_seen_at = excluded.last_seen_at,
  updated_at = now();

insert into public.portal_item_source_mapping (
  source_system, source_item_id, source_name, source_brand_name,
  portal_sku_reference, portal_sku_id, decision_status, decision_note,
  match_method, match_confidence, approved_by, approved_by_email, approved_at,
  source_present, last_seen_at, created_at, updated_at
)
select 'canix', mapping.canix_item_id::text, mapping.canix_item_name,
  mapping.canix_brand_name, mapping.portal_sku_reference,
  mapping.portal_sku_id,
  case when mapping.decision_status = 'pending_review' then 'to_be_mapped'
    else mapping.decision_status end,
  mapping.decision_note, 'legacy_canix_mapping',
  case when mapping.decision_status = 'approved' then 1 else null end,
  mapping.approved_by, mapping.approved_by_email, mapping.approved_at,
  current_item.item_id is not null, coalesce(current_item.synced_at, mapping.updated_at),
  mapping.created_at, mapping.updated_at
from public.portal_item_identity_mapping mapping
left join public.canix_item_current current_item
  on current_item.item_id = mapping.canix_item_id
on conflict (source_system, source_item_id) do update set
  portal_sku_reference = excluded.portal_sku_reference,
  portal_sku_id = excluded.portal_sku_id,
  decision_status = excluded.decision_status,
  decision_note = excluded.decision_note,
  match_method = excluded.match_method,
  match_confidence = excluded.match_confidence,
  approved_by = excluded.approved_by,
  approved_by_email = excluded.approved_by_email,
  approved_at = excluded.approved_at,
  updated_at = excluded.updated_at;

alter table public.portal_data_control_event
  drop constraint if exists portal_data_control_event_control_type_check;
alter table public.portal_data_control_event
  add constraint portal_data_control_event_control_type_check
  check (control_type in ('owner_mapping','package_lot','item_mapping','source_item_mapping','lot_register','cost_object','catalog_record'));

-- DST-safe business window. cron runs in UTC, but this predicate evaluates
-- the requested America/New_York schedule: weekdays from 06:00 through 18:00.
create or replace function public.portal_item_sync_window_open(p_at timestamptz default now())
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select extract(isodow from (p_at at time zone 'America/New_York')) between 1 and 5
    and (p_at at time zone 'America/New_York')::time >= time '06:00'
    and (p_at at time zone 'America/New_York')::time <= time '18:00';
$$;

create or replace function public.portal_item_refresh_scheduler_state()
returns table (
  window_open boolean,
  canix_job_scheduled boolean,
  quickbooks_job_scheduled boolean,
  timezone_name text,
  cadence_minutes integer
)
language sql
security definer
set search_path = public, cron, pg_temp
as $$
  select public.portal_item_sync_window_open(),
    exists (select 1 from cron.job where jobname = 'canix-item-master-business-15m' and active),
    exists (select 1 from cron.job where jobname = 'quickbooks-items-business-15m' and active),
    'America/New_York'::text, 15;
$$;

create or replace function public.portal_enable_item_refresh_schedules()
returns boolean
language plpgsql
security definer
set search_path = public, vault, cron, net, pg_temp
as $$
declare
  job record;
  has_canix_secret boolean;
  has_qbo_secret boolean;
begin
  for job in select jobid from cron.job where jobname in (
    'canix-item-master-sync-5m', 'portal-quickbooks-sync-5m',
    'canix-item-master-business-15m', 'quickbooks-items-business-15m'
  ) loop
    perform cron.unschedule(job.jobid);
  end loop;

  select exists (select 1 from vault.decrypted_secrets
    where name = 'canix_cron_secret' and length(coalesce(decrypted_secret, '')) >= 32)
    into has_canix_secret;
  select exists (select 1 from vault.decrypted_secrets
    where name = 'qbo_cron_secret' and length(coalesce(decrypted_secret, '')) >= 32)
    into has_qbo_secret;

  if has_canix_secret then
    perform cron.schedule(
      'canix-item-master-business-15m', '*/15 * * * 1-5',
      $cron$select case when public.portal_item_sync_window_open() then net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/canix-item-master',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(
          select decrypted_secret from vault.decrypted_secrets where name = 'canix_cron_secret' limit 1)),
        body := jsonb_build_object('source','business-hours-cron'), timeout_milliseconds := 30000
      ) end as request_id;$cron$
    );
  end if;

  if has_qbo_secret then
    perform cron.schedule(
      'quickbooks-items-business-15m', '*/15 * * * 1-5',
      $cron$select case when public.portal_item_sync_window_open() then net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/quickbooks-retailers',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(
          select decrypted_secret from vault.decrypted_secrets where name = 'qbo_cron_secret' limit 1)),
        body := '{}'::jsonb, timeout_milliseconds := 30000
      ) end as request_id;$cron$
    );
  end if;
  return has_canix_secret and has_qbo_secret;
end;
$$;

revoke all on function public.portal_item_sync_window_open(timestamptz),
  public.portal_item_refresh_scheduler_state(),
  public.portal_enable_item_refresh_schedules()
  from public, anon, authenticated;
grant execute on function public.portal_item_sync_window_open(timestamptz),
  public.portal_item_refresh_scheduler_state(),
  public.portal_enable_item_refresh_schedules()
  to service_role;

do $$ begin
  perform public.portal_enable_item_refresh_schedules();
end $$;

comment on table public.quickbooks_item_cache is
  'Read-only cache of QuickBooks Products and Services used for Portal identity mapping.';
comment on table public.portal_item_source_mapping is
  'Durable Canix and QuickBooks item-to-Portal-SKU decisions. Refreshes update source evidence but never replace approved mappings.';
comment on function public.portal_item_sync_window_open(timestamptz) is
  'True during the approved 06:00-18:00 America/New_York weekday item-refresh window.';
