-- Mirror the complete normalized Canix Item Master into the existing Monday
-- product board without treating Monday as the inventory system of record.
-- The ledger makes the incremental writer idempotent and the state row exposes
-- bounded operational evidence without publishing item data to browsers.

create table if not exists public.monday_item_master_sync_state (
  id smallint primary key default 1 check (id = 1),
  status text not null default 'never_run'
    check (status in ('never_run', 'running', 'success', 'error')),
  active_run_id uuid,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_at timestamptz,
  source_item_count integer not null default 0,
  board_item_count integer not null default 0,
  processed_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  pending_count integer not null default 0,
  conflict_count integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

insert into public.monday_item_master_sync_state (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.monday_item_master_link (
  canix_item_id bigint primary key,
  monday_item_id bigint not null unique,
  source_hash text not null check (length(source_hash) = 64),
  completeness_status text not null,
  inventory_class text not null,
  mapping_origin text not null
    check (mapping_origin in ('existing_id', 'exact_name_brand', 'created')),
  last_monday_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists monday_item_master_link_synced_idx
  on public.monday_item_master_link (last_synced_at desc);

alter table public.monday_item_master_sync_state enable row level security;
alter table public.monday_item_master_link enable row level security;

revoke all on table public.monday_item_master_sync_state
  from public, anon, authenticated;
revoke all on table public.monday_item_master_link
  from public, anon, authenticated;
grant all on table public.monday_item_master_sync_state to service_role;
grant all on table public.monday_item_master_link to service_role;

create or replace function public.portal_claim_monday_item_master_sync(
  p_run_id uuid,
  p_stale_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.monday_item_master_sync_state%rowtype;
  started_at timestamptz := now();
begin
  if p_run_id is null then raise exception 'A Monday Item Master run ID is required'; end if;
  if p_stale_seconds < 300 or p_stale_seconds > 3600 then
    raise exception 'Invalid Monday Item Master stale-run window';
  end if;

  select * into target
  from public.monday_item_master_sync_state
  where id = 1
  for update;

  if target.status = 'running'
    and target.last_started_at > started_at - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'already_running',
      'activeRunId', target.active_run_id,
      'lastStartedAt', target.last_started_at
    );
  end if;

  update public.monday_item_master_sync_state
  set status = 'running',
      active_run_id = p_run_id,
      last_started_at = started_at,
      last_error = null,
      updated_at = started_at
  where id = 1;

  return jsonb_build_object('claimed', true, 'runId', p_run_id);
end;
$$;

create or replace function public.portal_finish_monday_item_master_sync(
  p_run_id uuid,
  p_source_item_count integer,
  p_board_item_count integer,
  p_processed_count integer,
  p_created_count integer,
  p_updated_count integer,
  p_unchanged_count integer,
  p_pending_count integer,
  p_conflict_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if least(
    p_source_item_count, p_board_item_count, p_processed_count,
    p_created_count, p_updated_count, p_unchanged_count,
    p_pending_count, p_conflict_count
  ) < 0 then raise exception 'Monday Item Master counters cannot be negative'; end if;

  update public.monday_item_master_sync_state
  set status = 'success',
      active_run_id = null,
      last_completed_at = now(),
      last_successful_at = now(),
      source_item_count = p_source_item_count,
      board_item_count = p_board_item_count,
      processed_count = p_processed_count,
      created_count = p_created_count,
      updated_count = p_updated_count,
      unchanged_count = p_unchanged_count,
      pending_count = p_pending_count,
      conflict_count = p_conflict_count,
      last_error = null,
      updated_at = now()
  where id = 1 and status = 'running' and active_run_id = p_run_id;

  return found;
end;
$$;

revoke all on function public.portal_claim_monday_item_master_sync(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.portal_finish_monday_item_master_sync(
  uuid, integer, integer, integer, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.portal_claim_monday_item_master_sync(uuid, integer)
  to service_role;
grant execute on function public.portal_finish_monday_item_master_sync(
  uuid, integer, integer, integer, integer, integer, integer, integer, integer
) to service_role;

create or replace function public.portal_monday_item_master_scheduler_state()
returns table (
  secret_configured boolean,
  job_scheduled boolean
)
language sql
security definer
set search_path = public, vault, cron
as $$
  select
    exists (
      select 1 from vault.decrypted_secrets
      where name = 'canix_cron_secret'
        and length(coalesce(decrypted_secret, '')) >= 32
    ),
    exists (
      select 1 from cron.job
      where jobname = 'monday-item-master-sync-5m'
        and active
        and command like '%vault.decrypted_secrets%'
        and command not like '%"x-cron-secret":"%'
    );
$$;

create or replace function public.portal_enable_monday_item_master_schedule()
returns boolean
language plpgsql
security definer
set search_path = public, vault, cron, net
as $$
declare
  existing_job bigint;
  has_secret boolean;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'monday-item-master-sync-5m';

  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'canix_cron_secret'
      and length(coalesce(decrypted_secret, '')) >= 32
  ) into has_secret;

  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  if not has_secret then return false; end if;

  perform cron.schedule(
    'monday-item-master-sync-5m',
    '3-59/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/monday-item-master-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'canix_cron_secret'
            limit 1
          )
        ),
        body := jsonb_build_object('source', 'supabase-cron', 'limit', 500),
        timeout_milliseconds := 5000
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

revoke all on function public.portal_monday_item_master_scheduler_state()
  from public, anon, authenticated;
revoke all on function public.portal_enable_monday_item_master_schedule()
  from public, anon, authenticated;
grant execute on function public.portal_monday_item_master_scheduler_state()
  to service_role;
grant execute on function public.portal_enable_monday_item_master_schedule()
  to service_role;

do $$
begin
  if public.portal_enable_monday_item_master_schedule() then
    raise notice 'Vault-backed Monday Item Master five-minute schedule enabled.';
  else
    raise notice 'Monday Item Master schedule disabled until Vault secret canix_cron_secret is configured.';
  end if;
end;
$$;

comment on table public.monday_item_master_link is
  'Private idempotency ledger joining each Canix Item ID to one Monday item.';
comment on function public.portal_monday_item_master_scheduler_state() is
  'Reports Monday Item Master scheduler readiness without returning its credential.';
