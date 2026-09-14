-- Keep the Finance Cost Object decision separate from the Canix Lot ID pointer.
-- A code may be approved only when the protected Monday inbound-lot mirror
-- contains the same value. A deliberate no-code decision is recorded rather
-- than represented by an ambiguous blank.

create table if not exists public.portal_lot_cost_object_decision (
  lot_id text primary key,
  monday_item_id text not null,
  decision_status text not null check (decision_status in (
    'pending_assignment', 'assigned', 'not_required'
  )),
  cost_object_id text,
  decision_note text not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_by_email text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (lot_id ~ '^[A-Z0-9-]{1,20}$'),
  check (length(btrim(decision_note)) between 8 and 1500),
  check (
    (decision_status = 'assigned'
      and cost_object_id ~ '^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$')
    or
    (decision_status in ('pending_assignment', 'not_required')
      and cost_object_id is null)
  )
);

create table if not exists public.portal_lot_cost_object_event (
  id bigint generated always as identity primary key,
  lot_id text not null,
  monday_item_id text not null,
  prior_status text,
  decision_status text not null,
  prior_cost_object_id text,
  cost_object_id text,
  decision_note text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default now()
);

create index if not exists portal_lot_cost_object_decision_status_idx
  on public.portal_lot_cost_object_decision (decision_status, updated_at desc);

create index if not exists portal_lot_cost_object_event_lot_idx
  on public.portal_lot_cost_object_event (lot_id, created_at desc);

create or replace function public.portal_reject_lot_cost_object_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Cost Object decision history is append-only';
end;
$$;

drop trigger if exists portal_lot_cost_object_event_immutable
  on public.portal_lot_cost_object_event;
create trigger portal_lot_cost_object_event_immutable
before update or delete on public.portal_lot_cost_object_event
for each row execute function public.portal_reject_lot_cost_object_event_mutation();

alter table public.portal_lot_cost_object_decision enable row level security;
alter table public.portal_lot_cost_object_event enable row level security;

revoke all on function public.portal_reject_lot_cost_object_event_mutation()
  from public, anon, authenticated;

revoke all on table public.portal_lot_cost_object_decision from public, anon, authenticated;
revoke all on table public.portal_lot_cost_object_event from public, anon, authenticated;
grant all on table public.portal_lot_cost_object_decision to service_role;
grant all on table public.portal_lot_cost_object_event to service_role;
grant usage, select on sequence public.portal_lot_cost_object_event_id_seq to service_role;

create or replace function public.portal_set_lot_cost_object_decision(
  p_lot_id text,
  p_decision_status text,
  p_cost_object_id text,
  p_decision_note text,
  p_actor_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_lot_id text := upper(nullif(btrim(p_lot_id), ''));
  normalized_status text := lower(nullif(btrim(p_decision_status), ''));
  normalized_cost_object text := upper(nullif(btrim(p_cost_object_id), ''));
  normalized_note text := nullif(btrim(p_decision_note), '');
  active_rows integer;
  source_row public.portal_inbound_lot%rowtype;
  prior public.portal_lot_cost_object_decision%rowtype;
  changed public.portal_lot_cost_object_decision%rowtype;
begin
  if normalized_lot_id is null or normalized_lot_id !~ '^[A-Z0-9-]{1,20}$' then
    raise exception 'A valid Lot ID is required';
  end if;
  if normalized_status not in ('pending_assignment', 'assigned', 'not_required') then
    raise exception 'Unsupported Cost Object decision status';
  end if;
  if normalized_note is null or length(normalized_note) < 8 then
    raise exception 'A decision note of at least 8 characters is required';
  end if;
  if p_actor_id is null or not exists (
    select 1
    from public.portal_profile profile
    join public.portal_role_permission permission
      on permission.staff_role = profile.staff_role
    where profile.id = p_actor_id
      and profile.active
      and profile.role = 'internal'
      and permission.permission = 'cost_objects.manage'
  ) then
    raise exception 'Cost Object decision permission is required';
  end if;

  select count(*)::integer into active_rows
  from public.portal_inbound_lot
  where active and lot_id = normalized_lot_id;
  if active_rows <> 1 then
    raise exception 'Lot ID must resolve to exactly one active Monday register row';
  end if;

  select * into source_row
  from public.portal_inbound_lot
  where active and lot_id = normalized_lot_id
  for update;

  if normalized_status = 'assigned' then
    if source_row.approval_status is distinct from 'approved' then
      raise exception 'The Monday inbound-lot row must be approved first';
    end if;
    if normalized_cost_object is null
      or normalized_cost_object !~ '^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$' then
      raise exception 'Cost Object must use DEPT-LINE or DEPT-LINE-VARIANT';
    end if;
    if upper(nullif(btrim(source_row.cost_object_id), '')) is distinct from normalized_cost_object then
      raise exception 'The assigned code must exactly match the approved Monday Cost Object value';
    end if;
  elsif normalized_status = 'not_required'
    and nullif(btrim(source_row.cost_object_id), '') is not null then
    raise exception 'Clear the Monday Cost Object value before approving Not Required';
  else
    normalized_cost_object := null;
  end if;

  select * into prior
  from public.portal_lot_cost_object_decision
  where lot_id = normalized_lot_id
  for update;

  insert into public.portal_lot_cost_object_decision (
    lot_id, monday_item_id, decision_status, cost_object_id, decision_note,
    decided_by, decided_by_email, decided_at, updated_at
  ) values (
    normalized_lot_id, source_row.monday_item_id, normalized_status,
    normalized_cost_object, normalized_note, p_actor_id,
    nullif(btrim(p_actor_email), ''), now(), now()
  )
  on conflict (lot_id) do update set
    monday_item_id = excluded.monday_item_id,
    decision_status = excluded.decision_status,
    cost_object_id = excluded.cost_object_id,
    decision_note = excluded.decision_note,
    decided_by = excluded.decided_by,
    decided_by_email = excluded.decided_by_email,
    decided_at = excluded.decided_at,
    updated_at = excluded.updated_at
  returning * into changed;

  insert into public.portal_lot_cost_object_event (
    lot_id, monday_item_id, prior_status, decision_status,
    prior_cost_object_id, cost_object_id, decision_note, actor_id, actor_email
  ) values (
    changed.lot_id, changed.monday_item_id, prior.decision_status,
    changed.decision_status, prior.cost_object_id, changed.cost_object_id,
    changed.decision_note, p_actor_id, nullif(btrim(p_actor_email), '')
  );

  return jsonb_build_object(
    'lotId', changed.lot_id,
    'mondayItemId', changed.monday_item_id,
    'status', changed.decision_status,
    'costObjectId', changed.cost_object_id,
    'decisionNote', changed.decision_note,
    'decidedBy', changed.decided_by_email,
    'decidedAt', changed.decided_at
  );
end;
$$;

revoke all on function public.portal_set_lot_cost_object_decision(
  text, text, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.portal_set_lot_cost_object_decision(
  text, text, text, text, uuid, text
) to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;

alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check
  check (permission in (
    'inventory.read',
    'inventory.sync',
    'orders.manage',
    'accounts.manage',
    'pricing.manage',
    'catalog.manage',
    'financials.read',
    'economics.manage',
    'cost_objects.manage',
    'quality.manage',
    'lineage.read',
    'users.manage',
    'audit.read',
    'readiness.read'
  )) not valid;

alter table public.portal_role_permission
  validate constraint portal_role_permission_permission_check;

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'cost_objects.manage'),
  ('operations', 'cost_objects.manage')
on conflict do nothing;

comment on table public.portal_lot_cost_object_decision is
  'Audited Finance/Operations decision for a valid Monday-backed Lot ID. A deliberate no-code decision is never represented by an ambiguous blank.';
comment on column public.portal_lot_cost_object_decision.cost_object_id is
  'Approved DEPT-LINE[-VARIANT] copied only when it exactly matches the protected Monday inbound-lot value.';
comment on table public.portal_lot_cost_object_event is
  'Append-only history of Cost Object status and code decisions.';
