create table if not exists public.monday_supply_order_review_state (
  item_id text primary key,
  last_state_hash text,
  last_missing_hash text,
  last_route_hash text,
  last_approved_hash text,
  last_rejected_hash text,
  last_workflow_state text,
  last_total numeric(12, 2),
  last_approval_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.monday_supply_order_review_state enable row level security;

revoke all on table public.monday_supply_order_review_state
  from public, anon, authenticated;
grant all on table public.monday_supply_order_review_state to service_role;

comment on table public.monday_supply_order_review_state is
  'Service-role-only idempotency state for Supply Order Form 2026 webhook validation, routing, and notifications.';
