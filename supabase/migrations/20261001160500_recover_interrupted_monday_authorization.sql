-- Cancel an interrupted, unnecessary Monday reauthorization only when a
-- complete prior connection and its active signed order webhook still exist.
-- The encrypted provider tokens remain untouched and will rotate normally.

update public.monday_connection_state
set connection_status = 'connected',
    oauth_state_hash = null,
    oauth_state_expires_at = null,
    oauth_state_actor = null,
    encrypted_pkce_verifier = null,
    last_error = null,
    updated_at = now()
where id = 1
  and connection_status = 'authorizing'
  and encrypted_access_token is not null
  and encrypted_refresh_token is not null
  and nullif(account_id, '') is not null
  and webhook_status = 'active';
