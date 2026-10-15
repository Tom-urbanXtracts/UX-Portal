-- Bind Brand manufacturing projections to one approved monday.com board and
-- one stable set of source columns. This record is service-role-only so a
-- browser cannot redirect the receiver or broaden its scope.

create table if not exists public.monday_brand_milestone_state (
  id smallint primary key default 1 check (id = 1),
  board_id text not null default '18433592669',
  board_name text not null default 'UX OS Brand Production Milestones',
  column_mapping jsonb not null default '{}'::jsonb,
  webhook_id text,
  webhook_url text,
  webhook_status text not null default 'not_configured'
    check (webhook_status in ('not_configured', 'active', 'error')),
  configured_at timestamptz,
  configured_by uuid references auth.users(id) on delete set null,
  verification_item_id text,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.monday_brand_milestone_state (id)
values (1)
on conflict (id) do nothing;

alter table public.monday_brand_milestone_state enable row level security;
revoke all on table public.monday_brand_milestone_state
  from public, anon, authenticated;
grant all on table public.monday_brand_milestone_state to service_role;

comment on table public.monday_brand_milestone_state is
  'Service-role-only board, column, and signed-webhook binding for Brand manufacturing milestones.';

comment on column public.monday_brand_milestone_state.column_mapping is
  'Stable monday.com column IDs keyed by portal field name; titles are display labels only.';
