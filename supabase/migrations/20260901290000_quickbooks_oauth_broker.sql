-- Dedicated OAuth custody for the portal's read-only QuickBooks connection.
-- Browsers never receive an Intuit token. OAuth state is one-time and hashed;
-- refresh tokens are encrypted with a key held only by Edge Functions.

create extension if not exists pgcrypto with schema extensions;

alter table public.quickbooks_sync_state
  add column if not exists encrypted_refresh_token bytea,
  add column if not exists connection_status text not null default 'disconnected',
  add column if not exists connected_at timestamptz,
  add column if not exists connected_by uuid,
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists oauth_state_hash text,
  add column if not exists oauth_state_expires_at timestamptz,
  add column if not exists oauth_state_actor uuid;

alter table public.quickbooks_sync_state
  drop constraint if exists quickbooks_sync_state_connection_status_check;

alter table public.quickbooks_sync_state
  add constraint quickbooks_sync_state_connection_status_check
  check (connection_status in ('disconnected', 'authorizing', 'connected', 'error'));

create unique index if not exists quickbooks_sync_state_oauth_state_hash_idx
  on public.quickbooks_sync_state (oauth_state_hash)
  where oauth_state_hash is not null;

create or replace function public.portal_begin_quickbooks_oauth(
  p_state_hash text,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_actor is null or length(coalesce(p_state_hash, '')) <> 64 then
    raise exception 'Invalid QuickBooks authorization state';
  end if;

  update public.quickbooks_sync_state
  set oauth_state_hash = p_state_hash,
      oauth_state_expires_at = now() + interval '10 minutes',
      oauth_state_actor = p_actor,
      connection_status = 'authorizing',
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_consume_quickbooks_oauth_state(
  p_state_hash text
)
returns table (actor_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  claimed_actor uuid;
begin
  select oauth_state_actor
  into claimed_actor
  from public.quickbooks_sync_state
  where id = 1
    and oauth_state_hash = p_state_hash
    and oauth_state_expires_at > now()
  for update;

  if claimed_actor is null then
    return;
  end if;

  update public.quickbooks_sync_state
  set oauth_state_hash = null,
      oauth_state_expires_at = null,
      oauth_state_actor = null,
      updated_at = now()
  where id = 1;

  actor_id := claimed_actor;
  return next;
end;
$$;

create or replace function public.portal_store_quickbooks_connection(
  p_realm_id text,
  p_refresh_token text,
  p_encryption_key text,
  p_refresh_token_expires_at timestamptz,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_realm_id, '')) = 0
    or length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32
    or p_actor is null then
    raise exception 'Invalid QuickBooks connection material';
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
      connection_status = 'connected',
      connected_at = now(),
      connected_by = p_actor,
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_get_quickbooks_connection(
  p_encryption_key text
)
returns table (
  realm_id text,
  refresh_token text,
  connection_status text,
  refresh_token_expires_at timestamptz
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
         q.refresh_token_expires_at
  from public.quickbooks_sync_state q
  where q.id = 1;
$$;

create or replace function public.portal_rotate_quickbooks_refresh_token(
  p_refresh_token text,
  p_encryption_key text,
  p_refresh_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32 then
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
  where id = 1;
end;
$$;

revoke all on function public.portal_begin_quickbooks_oauth(text, uuid)
  from public, anon, authenticated;
revoke all on function public.portal_consume_quickbooks_oauth_state(text)
  from public, anon, authenticated;
revoke all on function public.portal_store_quickbooks_connection(text, text, text, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.portal_get_quickbooks_connection(text)
  from public, anon, authenticated;
revoke all on function public.portal_rotate_quickbooks_refresh_token(text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.portal_begin_quickbooks_oauth(text, uuid)
  to service_role;
grant execute on function public.portal_consume_quickbooks_oauth_state(text)
  to service_role;
grant execute on function public.portal_store_quickbooks_connection(text, text, text, timestamptz, uuid)
  to service_role;
grant execute on function public.portal_get_quickbooks_connection(text)
  to service_role;
grant execute on function public.portal_rotate_quickbooks_refresh_token(text, text, timestamptz)
  to service_role;

comment on column public.quickbooks_sync_state.encrypted_refresh_token is
  'Intuit refresh token encrypted with an Edge-Function-only key; never browser-readable.';
comment on function public.portal_consume_quickbooks_oauth_state(text) is
  'Atomically consumes the short-lived hashed OAuth state so callbacks cannot be replayed.';
