-- Make discovery-to-review staging idempotent. A Monday item is still only a
-- draft control record: ownership and approval remain human decisions.

create table if not exists public.portal_lot_review_staging (
  lot_id text primary key check (lot_id ~ '^[A-Z0-9-]{1,20}$'),
  state text not null default 'creating'
    check (state in ('creating', 'created', 'error')),
  monday_item_id text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_error text,
  first_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.portal_lot_review_staging enable row level security;
revoke all on table public.portal_lot_review_staging
  from public, anon, authenticated;
grant all on table public.portal_lot_review_staging to service_role;

create or replace function public.portal_claim_lot_review_staging(p_lot_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_lot text;
begin
  if p_lot_id is null or p_lot_id !~ '^[A-Z0-9-]{1,20}$' then
    raise exception 'Invalid lot ID for review staging';
  end if;

  insert into public.portal_lot_review_staging as target (
    lot_id, state, attempt_count, last_error,
    first_attempt_at, last_attempt_at, completed_at
  ) values (
    p_lot_id, 'creating', 1, null, now(), now(), null
  )
  on conflict (lot_id) do update
  set state = 'creating',
      monday_item_id = null,
      attempt_count = target.attempt_count + 1,
      last_error = null,
      last_attempt_at = now(),
      completed_at = null
  where target.state = 'error'
     or (target.state = 'creating' and target.last_attempt_at < now() - interval '10 minutes')
  returning lot_id into claimed_lot;

  return claimed_lot is not null;
end;
$$;

create or replace function public.portal_finish_lot_review_staging(
  p_lot_id text,
  p_state text,
  p_monday_item_id text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_state not in ('created', 'error') then
    raise exception 'Unsupported lot review staging result';
  end if;
  update public.portal_lot_review_staging
  set state = p_state,
      monday_item_id = case when p_state = 'created' then nullif(btrim(p_monday_item_id), '') else null end,
      last_error = case when p_state = 'error' then left(coalesce(p_error, 'Monday lot staging failed.'), 1000) else null end,
      last_attempt_at = now(),
      completed_at = case when p_state = 'created' then now() else null end
  where lot_id = p_lot_id;
  return found;
end;
$$;

revoke all on function public.portal_claim_lot_review_staging(text)
  from public, anon, authenticated;
revoke all on function public.portal_finish_lot_review_staging(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_claim_lot_review_staging(text)
  to service_role;
grant execute on function public.portal_finish_lot_review_staging(text, text, text, text)
  to service_role;

comment on table public.portal_lot_review_staging is
  'Idempotency ledger for administrator-requested creation of pending Monday lot-review rows from valid unknown Canix pointers.';
