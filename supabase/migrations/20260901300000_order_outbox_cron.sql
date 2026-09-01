-- Retry portal-to-Monday order events every five minutes. The scheduler reads
-- its credential from Supabase Vault at execution time; no secret is stored in
-- source control or in cron.job.command.

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'portal-order-outbox-flush-5m';

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end;
$$;

select cron.schedule(
  'portal-order-outbox-flush-5m',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/portal-orders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ux-cron-secret', coalesce(
          (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'order_sync_cron_secret'
             limit 1
          ),
          ''
        )
      ),
      body := '{"action":"flush-outbox"}'::jsonb
    ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Schedules private connector refresh and retry jobs; credentials are read from Supabase Vault.';
