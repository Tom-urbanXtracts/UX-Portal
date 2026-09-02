-- Retarget the Canix Item Master mirror to the UX Inbound Lot Register board.
-- The previous board has been restored before this migration is applied. Keep
-- the schedule stopped until the retargeted Edge function is deployed, and
-- discard only the private idempotency ledger from the former target.

do $$
declare
  existing_job bigint;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'monday-item-master-sync-5m'
  loop
    perform cron.unschedule(existing_job);
  end loop;
end;
$$;

delete from public.monday_item_master_link;

update public.monday_item_master_sync_state
set status = 'never_run',
    active_run_id = null,
    last_started_at = null,
    last_completed_at = null,
    last_successful_at = null,
    source_item_count = 0,
    board_item_count = 0,
    processed_count = 0,
    created_count = 0,
    updated_count = 0,
    unchanged_count = 0,
    pending_count = 0,
    conflict_count = 0,
    last_error = null,
    updated_at = now()
where id = 1;

comment on table public.monday_item_master_link is
  'Private idempotency ledger for Canix Item Master rows on Monday board 18429359264.';
comment on table public.monday_item_master_sync_state is
  'Operational state for the Canix Item Master mirror on Monday board 18429359264.';

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
        body := jsonb_build_object('source', 'supabase-cron', 'limit', 100),
        timeout_milliseconds := 5000
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

revoke all on function public.portal_enable_monday_item_master_schedule()
  from public, anon, authenticated;
grant execute on function public.portal_enable_monday_item_master_schedule()
  to service_role;
