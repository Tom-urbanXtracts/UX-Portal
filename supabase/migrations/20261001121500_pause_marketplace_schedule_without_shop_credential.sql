-- The general Canix Reporting API key cannot read the Canix Shop GraphQL
-- surface. Keep the verified snapshot available, but do not run a failing
-- five-minute job until a distinct durable Marketplace service credential is
-- approved and stored in both Supabase Vault and the Edge runtime.

create or replace function public.portal_canix_marketplace_scheduler_state()
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
      select 1
      from vault.decrypted_secrets
      where name = 'canix_cron_secret'
        and length(coalesce(decrypted_secret, '')) >= 32
    ) and exists (
      select 1
      from vault.decrypted_secrets
      where name = 'canix_marketplace_token'
        and length(coalesce(decrypted_secret, '')) >= 32
    ),
    exists (
      select 1
      from cron.job
      where jobname = 'canix-marketplace-sync-5m'
        and active
        and command like '%vault.decrypted_secrets%'
        and command not like '%"x-canix-cron-secret":"%'
    );
$$;

create or replace function public.portal_enable_canix_marketplace_sync_schedule()
returns boolean
language plpgsql
security definer
set search_path = public, vault, cron, net
as $$
declare
  existing_job bigint;
  credentials_ready boolean;
begin
  select jobid
  into existing_job
  from cron.job
  where jobname = 'canix-marketplace-sync-5m';

  select
    exists (
      select 1 from vault.decrypted_secrets
      where name = 'canix_cron_secret'
        and length(coalesce(decrypted_secret, '')) >= 32
    ) and exists (
      select 1 from vault.decrypted_secrets
      where name = 'canix_marketplace_token'
        and length(coalesce(decrypted_secret, '')) >= 32
    )
  into credentials_ready;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  if not credentials_ready then return false; end if;

  perform cron.schedule(
    'canix-marketplace-sync-5m',
    '3-59/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/canix-marketplace-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-canix-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'canix_cron_secret'
            limit 1
          )
        ),
        body := jsonb_build_object('source', 'supabase-cron'),
        timeout_milliseconds := 55000
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

do $$
begin
  if not public.portal_enable_canix_marketplace_sync_schedule() then
    update public.canix_marketplace_sync_state
    set status = 'error',
        last_error = 'Automatic refresh is paused until Canix provides a durable Marketplace Shop service credential.',
        updated_at = now()
    where id = 1;
    raise notice 'Canix Marketplace schedule paused pending a durable Shop service credential.';
  end if;
end;
$$;

comment on function public.portal_canix_marketplace_scheduler_state() is
  'Reports whether both the scheduler secret and a durable Marketplace credential are configured and the job is active.';
comment on function public.portal_enable_canix_marketplace_sync_schedule() is
  'Enables the Vault-backed Marketplace refresh only after a distinct Marketplace Shop credential is approved.';
