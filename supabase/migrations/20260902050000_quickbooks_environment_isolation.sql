-- Keep Intuit sandbox and production OAuth material and snapshots mutually
-- exclusive. Switching environments clears the prior environment's cache so
-- sandbox accounting data can never be presented as a production snapshot.

alter table public.quickbooks_sync_state
  add column if not exists connection_environment text,
  add column if not exists oauth_environment text;

alter table public.quickbooks_sync_state
  drop constraint if exists quickbooks_sync_state_connection_environment_check,
  drop constraint if exists quickbooks_sync_state_oauth_environment_check;

alter table public.quickbooks_sync_state
  add constraint quickbooks_sync_state_connection_environment_check
    check (connection_environment in ('sandbox', 'production')),
  add constraint quickbooks_sync_state_oauth_environment_check
    check (oauth_environment in ('sandbox', 'production'));

create or replace function public.portal_begin_quickbooks_oauth(
  p_state_hash text,
  p_actor uuid,
  p_environment text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_actor is null or length(coalesce(p_state_hash, '')) <> 64
    or p_environment not in ('sandbox', 'production') then
    raise exception 'Invalid QuickBooks authorization state';
  end if;

  update public.quickbooks_sync_state
  set oauth_state_hash = p_state_hash,
      oauth_state_expires_at = now() + interval '10 minutes',
      oauth_state_actor = p_actor,
      oauth_environment = p_environment,
      connection_status = 'authorizing',
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_consume_quickbooks_oauth_state_v2(
  p_state_hash text,
  p_environment text
)
returns table (actor_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  claimed_actor uuid;
begin
  if p_environment not in ('sandbox', 'production') then
    return;
  end if;

  select oauth_state_actor
  into claimed_actor
  from public.quickbooks_sync_state
  where id = 1
    and oauth_state_hash = p_state_hash
    and oauth_environment = p_environment
    and oauth_state_expires_at > now()
  for update;

  if claimed_actor is null then
    return;
  end if;

  update public.quickbooks_sync_state
  set oauth_state_hash = null,
      oauth_state_expires_at = null,
      oauth_state_actor = null,
      oauth_environment = null,
      updated_at = now()
  where id = 1;

  actor_id := claimed_actor;
  return next;
end;
$$;

create or replace function public.portal_store_quickbooks_connection_v2(
  p_realm_id text,
  p_refresh_token text,
  p_encryption_key text,
  p_refresh_token_expires_at timestamptz,
  p_actor uuid,
  p_environment text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  prior_environment text;
begin
  if length(coalesce(p_realm_id, '')) = 0
    or length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32
    or p_actor is null
    or p_environment not in ('sandbox', 'production') then
    raise exception 'Invalid QuickBooks connection material';
  end if;

  select connection_environment into prior_environment
  from public.quickbooks_sync_state
  where id = 1
  for update;

  if prior_environment is distinct from p_environment then
    delete from public.quickbooks_invoice_cache;
    delete from public.quickbooks_payment_cache;
    delete from public.quickbooks_customer_cache;
  end if;

  update public.quickbooks_sync_state
  set realm_id = p_realm_id,
      encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      refresh_token = null,
      refresh_token_expires_at = p_refresh_token_expires_at,
      connection_environment = p_environment,
      connection_status = 'connected',
      connected_at = now(),
      connected_by = p_actor,
      last_financial_run_id = case
        when prior_environment is distinct from p_environment then null
        else last_financial_run_id
      end,
      financial_last_successful_at = case
        when prior_environment is distinct from p_environment then null
        else financial_last_successful_at
      end,
      last_successful_at = case
        when prior_environment is distinct from p_environment then null
        else last_successful_at
      end,
      customer_count = case
        when prior_environment is distinct from p_environment then null
        else customer_count
      end,
      invoice_count = case
        when prior_environment is distinct from p_environment then null
        else invoice_count
      end,
      payment_count = case
        when prior_environment is distinct from p_environment then null
        else payment_count
      end,
      status = case
        when prior_environment is distinct from p_environment then 'never'
        else status
      end,
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_get_quickbooks_connection_v2(
  p_encryption_key text,
  p_environment text
)
returns table (
  realm_id text,
  refresh_token text,
  connection_status text,
  refresh_token_expires_at timestamptz,
  connection_environment text
)
language sql
security definer
set search_path = public, extensions
as $$
  select q.realm_id,
         case
           when q.encrypted_refresh_token is null then null
           else extensions.pgp_sym_decrypt(q.encrypted_refresh_token, p_encryption_key)
         end,
         q.connection_status,
         q.refresh_token_expires_at,
         q.connection_environment
  from public.quickbooks_sync_state q
  where q.id = 1
    and p_environment in ('sandbox', 'production')
    and q.connection_environment = p_environment;
$$;

create or replace function public.portal_rotate_quickbooks_refresh_token_v2(
  p_refresh_token text,
  p_encryption_key text,
  p_refresh_token_expires_at timestamptz,
  p_environment text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32
    or p_environment not in ('sandbox', 'production') then
    raise exception 'Invalid QuickBooks refresh token rotation';
  end if;

  update public.quickbooks_sync_state
  set encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      refresh_token = null,
      refresh_token_expires_at = coalesce(
        p_refresh_token_expires_at,
        refresh_token_expires_at
      ),
      connection_status = 'connected',
      last_error = null,
      updated_at = now()
  where id = 1 and connection_environment = p_environment;

  if not found then
    raise exception 'QuickBooks connection environment changed';
  end if;
end;
$$;

revoke all on function public.portal_begin_quickbooks_oauth(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.portal_consume_quickbooks_oauth_state_v2(text, text)
  from public, anon, authenticated;
revoke all on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  from public, anon, authenticated;
revoke all on function public.portal_get_quickbooks_connection_v2(text, text)
  from public, anon, authenticated;
revoke all on function public.portal_rotate_quickbooks_refresh_token_v2(text, text, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.portal_begin_quickbooks_oauth(text, uuid, text)
  to service_role;
grant execute on function public.portal_consume_quickbooks_oauth_state_v2(text, text)
  to service_role;
grant execute on function public.portal_store_quickbooks_connection_v2(text, text, text, timestamptz, uuid, text)
  to service_role;
grant execute on function public.portal_get_quickbooks_connection_v2(text, text)
  to service_role;
grant execute on function public.portal_rotate_quickbooks_refresh_token_v2(text, text, timestamptz, text)
  to service_role;

comment on column public.quickbooks_sync_state.connection_environment is
  'Exact Intuit Accounting environment for the encrypted realm and current complete snapshot.';
comment on column public.quickbooks_sync_state.oauth_environment is
  'Environment bound to the one-time OAuth state; prevents a callback from crossing environments.';
