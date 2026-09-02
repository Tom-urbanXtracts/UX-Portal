-- Keep each Monday write run below the Edge background-runtime boundary. A
-- successful run self-continues while a backlog remains; the standing cron
-- remains the five-minute safety net and steady-state incremental refresh.

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

do $$
begin
  if public.portal_enable_monday_item_master_schedule() then
    raise notice 'Monday Item Master schedule tuned to 100-row checkpoint batches.';
  else
    raise notice 'Monday Item Master schedule remains disabled until its Vault credential is configured.';
  end if;
end;
$$;
