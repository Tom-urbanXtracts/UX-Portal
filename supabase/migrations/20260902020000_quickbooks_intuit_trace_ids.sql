-- Preserve Intuit's support correlation ID for protected troubleshooting.
-- This value is metadata only: response bodies, access tokens, and refresh
-- tokens remain excluded from operational error records.

alter table public.quickbooks_sync_state
  add column if not exists last_intuit_tid text;

comment on column public.quickbooks_sync_state.last_intuit_tid is
  'Latest sanitized intuit_tid response header for administrator-only support diagnostics; never exposed to retailer clients.';
