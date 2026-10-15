-- Final receiving-claim policy approved 1 Oct 2026.
-- Claims remain operational records only: no claim creates a QuickBooks credit,
-- refund, replacement, payment change, invoice mutation, or Canix adjustment.

alter table public.portal_receiving_claim_policy
  add column if not exists retention_years integer not null default 7
    check (retention_years between 1 and 20),
  add column if not exists late_override_role text not null default 'administrator'
    check (late_override_role = 'administrator'),
  add column if not exists automatic_accounting_action boolean not null default false
    check (not automatic_accounting_action),
  add column if not exists approved_at timestamptz;

update public.portal_receiving_claim_policy
set policy_state = 'active_approved',
    claim_window_days = 5,
    window_basis = 'calendar_days',
    evidence_required_for = array['short','damaged','wrong_item'],
    initial_response_business_days = 2,
    owner_department = 'Administrator',
    creates_financial_record = false,
    decision_note = 'Approved receiving-claim policy. Finance handles any approved accounting action separately.',
    retention_years = 7,
    late_override_role = 'administrator',
    automatic_accounting_action = false,
    approved_at = now(),
    updated_at = now()
where id = 1;

alter table public.portal_receiving_claim_policy
  alter column approved_at set not null;

alter table public.portal_receiving_claim_policy enable row level security;
revoke all on table public.portal_receiving_claim_policy from public, anon, authenticated;
grant select, insert, update, delete on table public.portal_receiving_claim_policy to service_role;

-- Department ownership is intentionally deferred. Until that decision is made,
-- the Administrator role owns this operational queue.
delete from public.portal_role_permission
where permission = 'claims.manage' and staff_role <> 'administrator';

alter table public.portal_order
  add column if not exists delivered_at timestamptz;

update public.portal_order as target
set delivered_at = coalesce(
  (
    select max(event.created_at)
    from public.portal_order_event as event
    where event.order_id = target.id and event.to_state = 'delivered'
  ),
  target.updated_at,
  target.accepted_at,
  target.submitted_at
)
where target.state = 'delivered' and target.delivered_at is null;

create or replace function public.portal_stamp_order_delivery()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.state = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists portal_order_delivery_stamp on public.portal_order;
create trigger portal_order_delivery_stamp
before insert or update of state on public.portal_order
for each row execute function public.portal_stamp_order_delivery();

alter table public.portal_receiving_claim
  add column if not exists delivery_completed_at timestamptz,
  add column if not exists evidence_required boolean not null default false,
  add column if not exists response_due_at timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists late_submission boolean not null default false,
  add column if not exists late_override_by uuid references auth.users(id) on delete set null,
  add column if not exists late_override_reason text,
  add column if not exists closed_at timestamptz;

alter table public.portal_receiving_claim
  drop constraint if exists portal_receiving_claim_state_check;
alter table public.portal_receiving_claim
  add constraint portal_receiving_claim_state_check check (state in (
    'submitted', 'under_review', 'more_information', 'approved', 'denied', 'closed',
    'partially_approved', 'resolved', 'withdrawn'
  ));
alter table public.portal_receiving_claim
  drop constraint if exists portal_receiving_claim_late_override_check;
alter table public.portal_receiving_claim
  add constraint portal_receiving_claim_late_override_check check (
    not late_submission or (
      late_override_by is not null and length(trim(coalesce(late_override_reason, ''))) >= 8
    )
  );

create or replace function public.portal_add_business_days(
  p_started_at timestamptz,
  p_business_days integer
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  local_value timestamp := p_started_at at time zone 'America/New_York';
  candidate timestamp := p_started_at at time zone 'America/New_York';
  remaining integer := greatest(coalesce(p_business_days, 0), 0);
begin
  while remaining > 0 loop
    candidate := candidate + interval '1 day';
    if extract(isodow from candidate) between 1 and 5 then
      remaining := remaining - 1;
    end if;
  end loop;
  return candidate at time zone 'America/New_York';
end;
$$;

update public.portal_receiving_claim as claim
set
  delivery_completed_at = coalesce(claim.delivery_completed_at, orders.delivered_at, orders.updated_at),
  evidence_required = claim.claim_type in ('short', 'damaged', 'wrong_item'),
  response_due_at = coalesce(claim.response_due_at, public.portal_add_business_days(claim.submitted_at, 2)),
  first_response_at = case
    when claim.first_response_at is not null then claim.first_response_at
    when claim.state <> 'submitted' then coalesce(claim.decided_at, claim.updated_at)
    else null
  end,
  closed_at = case
    when claim.closed_at is not null then claim.closed_at
    when claim.state in ('resolved', 'withdrawn') then coalesce(claim.decided_at, claim.updated_at)
    else null
  end
from public.portal_order as orders
where orders.id = claim.order_id;

create table if not exists public.portal_receiving_claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.portal_receiving_claim(id) on delete cascade,
  evidence_kind text not null check (evidence_kind in ('photo', 'manifest', 'proof_of_delivery', 'other')),
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null default 'clean' check (scan_state = 'clean'),
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists portal_receiving_claim_evidence_claim_idx
  on public.portal_receiving_claim_evidence (claim_id, created_at);
alter table public.portal_receiving_claim_evidence enable row level security;
revoke all on table public.portal_receiving_claim_evidence from public, anon, authenticated;
grant all on table public.portal_receiving_claim_evidence to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-claim-evidence', 'portal-claim-evidence', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.portal_receiving_claim_transition_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.state <> old.state then
    if not (
      (old.state = 'submitted' and new.state in ('under_review', 'more_information', 'withdrawn'))
      or (old.state = 'under_review' and new.state in ('more_information', 'approved', 'denied'))
      or (old.state = 'more_information' and new.state in ('submitted', 'under_review', 'withdrawn'))
      or (old.state in ('approved', 'denied', 'partially_approved', 'resolved') and new.state = 'closed')
    ) then
      raise exception 'Unsupported receiving-claim transition from % to %', old.state, new.state;
    end if;
    if old.state = 'submitted' and new.state in ('under_review', 'more_information') then
      new.first_response_at := coalesce(new.first_response_at, now());
    end if;
    if new.state in ('approved', 'denied') then
      new.decided_at := coalesce(new.decided_at, now());
    end if;
    if new.state = 'closed' then
      new.closed_at := coalesce(new.closed_at, now());
    end if;
  end if;
  if new.evidence_required and new.state in ('under_review', 'approved', 'closed')
     and new.evidence_state <> 'clean' then
    raise exception 'Required receiving-claim evidence must pass malware scanning before review';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists portal_receiving_claim_transition_guard
  on public.portal_receiving_claim;
create trigger portal_receiving_claim_transition_guard
before update on public.portal_receiving_claim
for each row execute function public.portal_receiving_claim_transition_guard();

drop function if exists public.portal_create_receiving_claim(
  uuid, bigint, text, text, text, integer, text, uuid, text
);
create function public.portal_create_receiving_claim(
  p_order_id uuid,
  p_order_line_id bigint,
  p_organization text,
  p_store_license text,
  p_claim_type text,
  p_quantity integer,
  p_narrative text,
  p_submitted_by uuid,
  p_submitted_by_email text,
  p_late_override_by uuid,
  p_late_override_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_order public.portal_order%rowtype;
  target_line public.portal_order_line%rowtype;
  policy public.portal_receiving_claim_policy%rowtype;
  override_profile public.portal_profile%rowtype;
  claimed integer;
  delivered_at timestamptz;
  is_late boolean;
  needs_evidence boolean;
  created public.portal_receiving_claim%rowtype;
begin
  select * into policy from public.portal_receiving_claim_policy where id = 1;
  if policy.id is null then raise exception 'Receiving-claim policy is unavailable'; end if;

  select * into target_order from public.portal_order where id = p_order_id for share;
  if target_order.id is null or target_order.state <> 'delivered' then
    raise exception 'Claims may be raised only against a delivered order';
  end if;
  if target_order.organization <> p_organization or target_order.location_license <> p_store_license then
    raise exception 'The claim scope does not match the order';
  end if;
  delivered_at := coalesce(target_order.delivered_at, target_order.updated_at, target_order.accepted_at, target_order.submitted_at);
  is_late := now() > delivered_at + make_interval(days => policy.claim_window_days);
  if is_late then
    if p_late_override_by is null or length(trim(coalesce(p_late_override_reason, ''))) < 8 then
      raise exception 'The five-calendar-day receiving-claim window has closed; an Administrator override and reason are required';
    end if;
    select * into override_profile from public.portal_profile where id = p_late_override_by;
    if override_profile.id is null or override_profile.active is false
       or override_profile.role <> 'internal' or override_profile.staff_role <> 'administrator' then
      raise exception 'Only an active Administrator may approve a late receiving claim';
    end if;
  end if;

  if p_claim_type is null or not (p_claim_type = any(array['short','damaged','wrong_item','refused','other'])) then
    raise exception 'Choose a supported claim type';
  end if;
  needs_evidence := p_claim_type = any(policy.evidence_required_for);
  select * into target_line from public.portal_order_line
  where id = p_order_line_id and order_id = p_order_id for update;
  if target_line.id is null then raise exception 'The order line was not found'; end if;
  select coalesce(sum(quantity), 0) into claimed from public.portal_receiving_claim
  where order_line_id = p_order_line_id and state not in ('denied', 'withdrawn');
  if p_quantity < 1 or claimed + p_quantity > target_line.quantity then
    raise exception 'Claimed quantity exceeds the remaining order-line quantity';
  end if;

  insert into public.portal_receiving_claim (
    claim_number, order_id, order_line_id, organization, store_license,
    claim_type, quantity, narrative, evidence_required, evidence_state, state,
    delivery_completed_at, response_due_at, submitted_by, submitted_by_email,
    late_submission, late_override_by, late_override_reason
  ) values (
    'CLM-' || lpad(nextval('public.portal_receiving_claim_number_seq')::text, 6, '0'),
    p_order_id, p_order_line_id, p_organization, p_store_license,
    p_claim_type, p_quantity, trim(p_narrative), needs_evidence, 'not_provided',
    case when needs_evidence then 'more_information' else 'submitted' end,
    delivered_at, public.portal_add_business_days(now(), policy.initial_response_business_days),
    p_submitted_by, lower(p_submitted_by_email), is_late,
    case when is_late then p_late_override_by else null end,
    case when is_late then trim(p_late_override_reason) else null end
  ) returning * into created;
  return to_jsonb(created);
end;
$$;

revoke all on function public.portal_create_receiving_claim(
  uuid, bigint, text, text, text, integer, text, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.portal_create_receiving_claim(
  uuid, bigint, text, text, text, integer, text, uuid, text, uuid, text
) to service_role;

update public.portal_document_retention_rule
set proposed_retention_years = 7,
    proposed_retention_days = null,
    start_event = 'claim_closed',
    disposition = 'review_then_delete',
    policy_state = 'approved',
    automatic_deletion_enabled = false,
    legal_basis = 'Approved urbanXtracts receiving-claim policy',
    notes = 'Retain the claim, its clean evidence, decisions, and audit history for seven years after closure. Legal hold overrides disposition.',
    updated_at = now()
where record_class = 'receiving_claim';

comment on table public.portal_receiving_claim_policy is
  'Approved receiving-claim service policy: five calendar days, two-business-day first response, Administrator queue ownership, and seven-year retention.';
comment on table public.portal_receiving_claim_evidence is
  'Private, malware-scanned PDF/JPEG/PNG evidence for receiving claims. No object is publicly addressable.';
comment on column public.portal_receiving_claim.response_due_at is
  'First-response target calculated as two New York business days after submission.';
comment on column public.portal_receiving_claim.late_submission is
  'True only when an active Administrator supplied an auditable late-claim override reason.';
