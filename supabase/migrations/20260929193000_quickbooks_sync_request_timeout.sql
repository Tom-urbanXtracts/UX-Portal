-- The combined Customer, Vendor, Invoice, and Payment read can legitimately
-- run longer than pg_net's five-second default request timeout. Keep the
-- schedule at five-minute cadence but allow the protected Edge Function up to
-- 30 seconds to return its completion response.

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
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      ) as request_id;
    $cron$
  );
  return true;
end;
$$;

revoke all on function public.portal_enable_quickbooks_sync_schedule()
  from public, anon, authenticated;
grant execute on function public.portal_enable_quickbooks_sync_schedule()
  to service_role;

do $$
begin
  if public.portal_enable_quickbooks_sync_schedule() then
    raise notice 'QuickBooks five-minute sync schedule updated with a 30-second request timeout.';
  else
    raise notice 'QuickBooks schedule remains disabled: Vault secret qbo_cron_secret is not configured.';
  end if;
end;
$$;

comment on function public.portal_enable_quickbooks_sync_schedule() is
  'Creates the five-minute QuickBooks read-sync job with a Vault-held credential and a bounded 30-second HTTP timeout.';
