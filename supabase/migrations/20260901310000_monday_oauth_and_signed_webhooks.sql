-- Dedicated monday.com OAuth custody and signed board-webhook replay control.
-- Browser code never receives provider tokens. OAuth state is one-time and
-- PKCE-bound; access and refresh tokens are encrypted with an Edge-only key.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.monday_connection_state (
  id smallint primary key default 1 check (id = 1),
  connection_status text not null default 'disconnected'
    check (connection_status in ('disconnected', 'authorizing', 'connected', 'error')),
  encrypted_access_token bytea,
  encrypted_refresh_token bytea,
  access_token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  account_id text,
  account_name text,
  user_id text,
  user_name text,
  connected_at timestamptz,
  connected_by uuid,
  oauth_state_hash text,
  oauth_state_expires_at timestamptz,
  oauth_state_actor uuid,
  encrypted_pkce_verifier bytea,
  webhook_id text,
  webhook_board_id text,
  webhook_column_id text,
  webhook_url text,
  webhook_status text not null default 'not_configured'
    check (webhook_status in ('not_configured', 'active', 'error')),
  webhook_created_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

insert into public.monday_connection_state (id)
values (1)
on conflict (id) do nothing;

create unique index if not exists monday_connection_state_oauth_hash_idx
  on public.monday_connection_state (oauth_state_hash)
  where oauth_state_hash is not null;

alter table public.monday_connection_state enable row level security;
revoke all on table public.monday_connection_state
  from public, anon, authenticated;

create table if not exists public.monday_webhook_event (
  event_key text primary key,
  subscription_id text not null,
  board_id text not null,
  item_id text not null,
  status_label text not null,
  payload_sha256 text not null,
  processing_state text not null default 'processing'
    check (processing_state in ('processing', 'processed', 'rejected', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  response_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists monday_webhook_event_received_idx
  on public.monday_webhook_event (received_at desc);

alter table public.monday_webhook_event enable row level security;
revoke all on table public.monday_webhook_event
  from public, anon, authenticated;

create or replace function public.portal_begin_monday_oauth(
  p_state_hash text,
  p_pkce_verifier text,
  p_encryption_key text,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_actor is null
    or length(coalesce(p_state_hash, '')) <> 64
    or length(coalesce(p_pkce_verifier, '')) < 43
    or length(coalesce(p_pkce_verifier, '')) > 128
    or length(coalesce(p_encryption_key, '')) < 32 then
    raise exception 'Invalid Monday authorization state';
  end if;

  update public.monday_connection_state
  set oauth_state_hash = p_state_hash,
      oauth_state_expires_at = now() + interval '10 minutes',
      oauth_state_actor = p_actor,
      encrypted_pkce_verifier = extensions.pgp_sym_encrypt(
        p_pkce_verifier,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      connection_status = 'authorizing',
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_consume_monday_oauth_state(
  p_state_hash text,
  p_encryption_key text
)
returns table (actor_id uuid, pkce_verifier text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  claimed_actor uuid;
  claimed_verifier text;
begin
  select oauth_state_actor,
         case
           when encrypted_pkce_verifier is null then null
           else extensions.pgp_sym_decrypt(
             encrypted_pkce_verifier,
             p_encryption_key
           )
         end
  into claimed_actor, claimed_verifier
  from public.monday_connection_state
  where id = 1
    and oauth_state_hash = p_state_hash
    and oauth_state_expires_at > now()
  for update;

  if claimed_actor is null or claimed_verifier is null then
    return;
  end if;

  update public.monday_connection_state
  set oauth_state_hash = null,
      oauth_state_expires_at = null,
      oauth_state_actor = null,
      encrypted_pkce_verifier = null,
      updated_at = now()
  where id = 1;

  actor_id := claimed_actor;
  pkce_verifier := claimed_verifier;
  return next;
end;
$$;

create or replace function public.portal_store_monday_connection(
  p_access_token text,
  p_refresh_token text,
  p_encryption_key text,
  p_access_token_expires_at timestamptz,
  p_granted_scopes text[],
  p_account_id text,
  p_account_name text,
  p_user_id text,
  p_user_name text,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_access_token, '')) < 20
    or length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32
    or length(coalesce(p_account_id, '')) = 0
    or p_actor is null then
    raise exception 'Invalid Monday connection material';
  end if;

  update public.monday_connection_state
  set encrypted_access_token = extensions.pgp_sym_encrypt(
        p_access_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      access_token_expires_at = p_access_token_expires_at,
      granted_scopes = coalesce(p_granted_scopes, '{}'),
      account_id = p_account_id,
      account_name = nullif(p_account_name, ''),
      user_id = nullif(p_user_id, ''),
      user_name = nullif(p_user_name, ''),
      connection_status = 'connected',
      connected_at = now(),
      connected_by = p_actor,
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_get_monday_connection(
  p_encryption_key text
)
returns table (
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  account_id text,
  connection_status text,
  webhook_id text,
  webhook_status text
)
language sql
security definer
set search_path = public, extensions
as $$
  select case
           when m.encrypted_access_token is null then null
           else extensions.pgp_sym_decrypt(
             m.encrypted_access_token,
             p_encryption_key
           )
         end,
         case
           when m.encrypted_refresh_token is null then null
           else extensions.pgp_sym_decrypt(
             m.encrypted_refresh_token,
             p_encryption_key
           )
         end,
         m.access_token_expires_at,
         m.account_id,
         m.connection_status,
         m.webhook_id,
         m.webhook_status
  from public.monday_connection_state m
  where m.id = 1;
$$;

create or replace function public.portal_rotate_monday_tokens(
  p_access_token text,
  p_refresh_token text,
  p_encryption_key text,
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_access_token, '')) < 20
    or length(coalesce(p_refresh_token, '')) < 20
    or length(coalesce(p_encryption_key, '')) < 32 then
    raise exception 'Invalid Monday token rotation';
  end if;

  update public.monday_connection_state
  set encrypted_access_token = extensions.pgp_sym_encrypt(
        p_access_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      encrypted_refresh_token = extensions.pgp_sym_encrypt(
        p_refresh_token,
        p_encryption_key,
        'cipher-algo=aes256,compress-algo=0'
      ),
      access_token_expires_at = p_access_token_expires_at,
      connection_status = 'connected',
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_store_monday_webhook(
  p_webhook_id text,
  p_board_id text,
  p_column_id text,
  p_webhook_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(coalesce(p_webhook_id, '')) = 0
    or length(coalesce(p_board_id, '')) = 0
    or length(coalesce(p_column_id, '')) = 0
    or p_webhook_url !~ '^https://[^[:space:]]+$' then
    raise exception 'Invalid Monday webhook configuration';
  end if;

  update public.monday_connection_state
  set webhook_id = p_webhook_id,
      webhook_board_id = p_board_id,
      webhook_column_id = p_column_id,
      webhook_url = p_webhook_url,
      webhook_status = 'active',
      webhook_created_at = now(),
      last_error = null,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_mark_monday_connection_error(
  p_error text,
  p_webhook_error boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.monday_connection_state
  set connection_status = case
        when p_webhook_error then connection_status
        else 'error'
      end,
      webhook_status = case
        when p_webhook_error then 'error'
        else webhook_status
      end,
      last_error = left(coalesce(nullif(p_error, ''), 'Monday connection failed'), 500),
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function public.portal_claim_monday_webhook_event(
  p_event_key text,
  p_subscription_id text,
  p_board_id text,
  p_item_id text,
  p_status_label text,
  p_payload_sha256 text
)
returns table (claimed boolean, prior_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_state text;
begin
  if length(coalesce(p_event_key, '')) = 0
    or length(coalesce(p_subscription_id, '')) = 0
    or length(coalesce(p_board_id, '')) = 0
    or length(coalesce(p_item_id, '')) = 0
    or length(coalesce(p_status_label, '')) = 0
    or length(coalesce(p_payload_sha256, '')) <> 64 then
    raise exception 'Invalid Monday webhook event';
  end if;

  insert into public.monday_webhook_event (
    event_key, subscription_id, board_id, item_id, status_label,
    payload_sha256, processing_state
  ) values (
    p_event_key, p_subscription_id, p_board_id, p_item_id, p_status_label,
    p_payload_sha256, 'processing'
  )
  on conflict (event_key) do nothing;

  if found then
    claimed := true;
    prior_state := null;
    return next;
    return;
  end if;

  select processing_state
  into existing_state
  from public.monday_webhook_event
  where event_key = p_event_key
  for update;

  if existing_state = 'failed' then
    update public.monday_webhook_event
    set processing_state = 'processing',
        attempt_count = attempt_count + 1,
        received_at = now(),
        processed_at = null,
        response_status = null,
        last_error = null,
        updated_at = now()
    where event_key = p_event_key;
    claimed := true;
  else
    claimed := false;
  end if;
  prior_state := existing_state;
  return next;
end;
$$;

create or replace function public.portal_finish_monday_webhook_event(
  p_event_key text,
  p_state text,
  p_response_status integer,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_state not in ('processed', 'rejected', 'failed') then
    raise exception 'Invalid Monday webhook completion state';
  end if;
  update public.monday_webhook_event
  set processing_state = p_state,
      processed_at = case when p_state in ('processed', 'rejected') then now() else null end,
      response_status = p_response_status,
      last_error = left(nullif(p_error, ''), 500),
      updated_at = now()
  where event_key = p_event_key;
end;
$$;

revoke all on function public.portal_begin_monday_oauth(text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.portal_consume_monday_oauth_state(text, text)
  from public, anon, authenticated;
revoke all on function public.portal_store_monday_connection(text, text, text, timestamptz, text[], text, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.portal_get_monday_connection(text)
  from public, anon, authenticated;
revoke all on function public.portal_rotate_monday_tokens(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.portal_store_monday_webhook(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.portal_mark_monday_connection_error(text, boolean)
  from public, anon, authenticated;
revoke all on function public.portal_claim_monday_webhook_event(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.portal_finish_monday_webhook_event(text, text, integer, text)
  from public, anon, authenticated;

grant execute on function public.portal_begin_monday_oauth(text, text, text, uuid)
  to service_role;
grant execute on function public.portal_consume_monday_oauth_state(text, text)
  to service_role;
grant execute on function public.portal_store_monday_connection(text, text, text, timestamptz, text[], text, text, text, text, uuid)
  to service_role;
grant execute on function public.portal_get_monday_connection(text)
  to service_role;
grant execute on function public.portal_rotate_monday_tokens(text, text, text, timestamptz)
  to service_role;
grant execute on function public.portal_store_monday_webhook(text, text, text, text)
  to service_role;
grant execute on function public.portal_mark_monday_connection_error(text, boolean)
  to service_role;
grant execute on function public.portal_claim_monday_webhook_event(text, text, text, text, text, text)
  to service_role;
grant execute on function public.portal_finish_monday_webhook_event(text, text, integer, text)
  to service_role;

comment on table public.monday_connection_state is
  'Service-role-only OAuth and signed webhook state for the UX OS monday.com app.';
comment on table public.monday_webhook_event is
  'Service-role-only replay and retry ledger for authenticated monday.com board events.';
