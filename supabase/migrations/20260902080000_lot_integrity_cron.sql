-- Pull the private Monday inbound-lot register and recompute package integrity
-- once each day. The job is installed only after its matching Edge Function
-- secret is also stored in Vault, so no credential is embedded in cron source.

create or replace function public.portal_lot_integrity_scheduler_state()
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
      where name = 'lot_integrity_cron_secret'
        and length(coalesce(decrypted_secret, '')) >= 32
    ),
    exists (
      select 1
      from cron.job
      where jobname = 'portal-lot-integrity-daily'
        and active
    );
$$;

create or replace function public.portal_enable_lot_integrity_schedule()
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
  where jobname = 'portal-lot-integrity-daily';

  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'lot_integrity_cron_secret'
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
    'portal-lot-integrity-daily',
    '15 11 * * *',
    $cron$
      select net.http_post(
        url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/portal-lot-integrity',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'lot_integrity_cron_secret'
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

revoke all on function public.portal_lot_integrity_scheduler_state()
  from public, anon, authenticated;
revoke all on function public.portal_enable_lot_integrity_schedule()
  from public, anon, authenticated;

grant execute on function public.portal_lot_integrity_scheduler_state()
  to service_role;
grant execute on function public.portal_enable_lot_integrity_schedule()
  to service_role;

do $$
begin
  if public.portal_enable_lot_integrity_schedule() then
    raise notice 'Daily lot-integrity schedule enabled.';
  else
    raise notice 'Lot-integrity schedule remains disabled: Vault secret lot_integrity_cron_secret is not configured.';
  end if;
end;
$$;

comment on function public.portal_lot_integrity_scheduler_state() is
  'Reports daily lot-register scheduler readiness without returning its secret.';
comment on function public.portal_enable_lot_integrity_schedule() is
  'Creates the daily Monday lot-register sync only when its Vault credential is present.';
