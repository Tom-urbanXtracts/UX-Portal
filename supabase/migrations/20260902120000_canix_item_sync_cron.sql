-- Refresh the independent Canix Item Master every five minutes using the same
-- Vault-custodied Canix scheduler credential as package inventory.

create or replace function public.portal_canix_item_scheduler_state()
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
    ),
    exists (
      select 1
      from cron.job
      where jobname = 'canix-item-master-sync-5m'
        and active
        and command like '%vault.decrypted_secrets%'
        and command not like '%"x-cron-secret":"%'
    );
$$;

create or replace function public.portal_enable_canix_item_sync_schedule()
returns boolean
language plpgsql
security definer
set search_path = public, vault, cron, net
as $$
declare
  existing_job bigint;
  has_secret boolean;
begin
  select jobid
  into existing_job
  from cron.job
  where jobname = 'canix-item-master-sync-5m';

  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'canix_cron_secret'
      and length(coalesce(decrypted_secret, '')) >= 32
  ) into has_secret;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  if not has_secret then return false; end if;

  perform cron.schedule(
    'canix-item-master-sync-5m',
    '1-59/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/canix-item-master',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'canix_cron_secret'
            limit 1
          )
        ),
        body := jsonb_build_object('source', 'supabase-cron'),
        timeout_milliseconds := 5000
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

revoke all on function public.portal_canix_item_scheduler_state()
  from public, anon, authenticated;
revoke all on function public.portal_enable_canix_item_sync_schedule()
  from public, anon, authenticated;
grant execute on function public.portal_canix_item_scheduler_state()
  to service_role;
grant execute on function public.portal_enable_canix_item_sync_schedule()
  to service_role;

do $$
begin
  if public.portal_enable_canix_item_sync_schedule() then
    raise notice 'Vault-backed Canix Item Master five-minute schedule enabled.';
  else
    raise notice 'Canix Item Master schedule disabled until Vault secret canix_cron_secret is configured.';
  end if;
end;
$$;

comment on function public.portal_canix_item_scheduler_state() is
  'Reports whether the independent Canix Item Master scheduler is Vault-backed and active without returning its credential.';
comment on function public.portal_enable_canix_item_sync_schedule() is
  'Creates the Vault-backed Canix Item Master five-minute schedule without embedding a credential.';
