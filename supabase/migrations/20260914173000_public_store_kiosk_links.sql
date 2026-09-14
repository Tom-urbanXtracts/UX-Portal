-- Revocable, store-scoped capability links for education-only kiosk mode.
-- The bearer token is returned once; only its SHA-256 digest is retained.

create table if not exists public.portal_kiosk_link (
  id uuid primary key default gen_random_uuid(),
  store_license text not null references public.portal_store(license_number) on update cascade on delete cascade,
  label text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) between 6 and 16),
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  check ((active and revoked_at is null) or (not active and revoked_at is not null))
);

create index if not exists portal_kiosk_link_store_idx
  on public.portal_kiosk_link (store_license, active, created_at desc);

alter table public.portal_kiosk_link enable row level security;
revoke all on table public.portal_kiosk_link from public, anon, authenticated;
grant all on table public.portal_kiosk_link to service_role;

comment on table public.portal_kiosk_link is
  'Revocable public kiosk capabilities. Raw bearer tokens are never stored; public responses contain published product education only.';
comment on column public.portal_kiosk_link.store_license is
  'The single licensed store represented by the kiosk display. The public response does not expose this license number.';

