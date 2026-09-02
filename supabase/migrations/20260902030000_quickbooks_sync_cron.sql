-- Refresh the complete QuickBooks read snapshot every five minutes after the
-- production connection and its database Vault credential are ready. The
-- scheduler never embeds a credential in source control or cron.job.command.

create or replace function public.portal_quickbooks_scheduler_state()
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
      where name = 'qbo_cron_secret'
        and length(coalesce(decrypted_secret, '')) >= 32
    ),
    exists (
      select 1
      from cron.job
      where jobname = 'portal-quickbooks-sync-5m'
        and active
    );
$$;

create or replace function public.portal_enable_quickbooks_sync_schedule()
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
  where jobname = 'portal-quickbooks-sync-5m';

  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'qbo_cron_secret'
      and length(coalesce(decrypted_secret, '')) >= 32
  ) into has_secret;

  if not has_secret then
    if existing_job is not null then
      perform cron.unschedule(existing_job);
    end if;
    return false;
  end if;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'portal-quickbooks-sync-5m',
    '*/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/quickbooks-retailers',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'qbo_cron_secret'
            limit 1
          )
        ),
        body := '{}'::jsonb
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

revoke all on function public.portal_quickbooks_scheduler_state()
  from public, anon, authenticated;
revoke all on function public.portal_enable_quickbooks_sync_schedule()
  from public, anon, authenticated;

grant execute on function public.portal_quickbooks_scheduler_state()
  to service_role;
grant execute on function public.portal_enable_quickbooks_sync_schedule()
  to service_role;

do $$
begin
  if public.portal_enable_quickbooks_sync_schedule() then
    raise notice 'QuickBooks five-minute sync schedule enabled.';
  else
    raise notice 'QuickBooks schedule remains disabled: Vault secret qbo_cron_secret is not configured.';
  end if;
end;
$$;

comment on function public.portal_quickbooks_scheduler_state() is
  'Reports credential and schedule presence without returning the scheduler secret.';
comment on function public.portal_enable_quickbooks_sync_schedule() is
  'Creates the five-minute QuickBooks read-sync job only when its Vault credential is present.';
