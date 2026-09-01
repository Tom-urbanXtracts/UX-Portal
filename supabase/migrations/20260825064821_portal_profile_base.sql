-- Foundational portal identity record. This migration reconstructs the
-- original production baseline so a clean environment can be built from the
-- repository instead of relying on untracked dashboard history.

create table if not exists public.portal_profile (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  org text not null,
  role text not null check (role in ('owner', 'buyer', 'budtender', 'internal')),
  locations text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.portal_profile enable row level security;

