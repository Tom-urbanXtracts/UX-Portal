-- Shared Internal Employee Portal workflow foundation.
-- This builds on portal_work_item instead of introducing a second task engine.
-- Browsers have no direct table access; the portal-internal-work function
-- re-resolves the authenticated profile and enforces requester/Administrator
-- scope for every operation.

create table if not exists public.portal_department (
  department_key text primary key check (department_key ~ '^[a-z0-9_]{2,40}$'),
  display_name text not null unique,
  status text not null default 'active' check (status in ('active', 'held', 'archived')),
  platform_owner text not null default 'IT',
  business_owner text,
  backup_owner text not null default 'Executive Member',
  sensitive_tier boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.portal_department (
  department_key, display_name, status, platform_owner, business_owner,
  backup_owner, sensitive_tier
) values
  ('executive', 'Executive Leadership', 'active', 'IT', null, 'Executive Member', true),
  ('finance', 'Finance and Accounting', 'active', 'IT', null, 'Executive Member', true),
  ('hr', 'Human Resources', 'held', 'IT', null, 'Executive Member', true),
  ('it_admin', 'IT and Administration', 'active', 'IT', null, 'Executive Member', true),
  ('marketing', 'Marketing', 'active', 'IT', null, 'Executive Member', false),
  ('operations', 'Operations', 'active', 'IT', null, 'Executive Member', false),
  ('quality', 'Quality and Compliance', 'active', 'IT', null, 'Executive Member', true),
  ('sales', 'Sales and Commercial', 'active', 'IT', null, 'Executive Member', false)
on conflict (department_key) do update set
  display_name = excluded.display_name,
  status = excluded.status,
  platform_owner = excluded.platform_owner,
  backup_owner = excluded.backup_owner,
  sensitive_tier = excluded.sensitive_tier,
  updated_at = now();

create table if not exists public.portal_profile_department (
  profile_id uuid not null references public.portal_profile(id) on delete cascade,
  department_key text not null references public.portal_department(department_key),
  member_role text not null default 'member'
    check (member_role in ('member', 'manager', 'department_head', 'backup_owner')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  primary key (profile_id, department_key)
);

create table if not exists public.portal_access_request (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('ACCESS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  requester_id uuid not null references public.portal_profile(id) on delete restrict,
  target_profile_id uuid not null references public.portal_profile(id) on delete restrict,
  requested_staff_role text not null
    check (requested_staff_role in ('administrator', 'operations', 'sales', 'quality', 'viewer')),
  requested_department_key text references public.portal_department(department_key),
  requested_department_role text not null default 'member'
    check (requested_department_role in ('member', 'manager', 'department_head', 'backup_owner')),
  requested_expires_on date,
  justification text not null check (length(btrim(justification)) between 12 and 4000),
  risk_tier text not null default 'ordinary'
    check (risk_tier in ('ordinary', 'sensitive', 'privileged')),
  status text not null default 'submitted'
    check (status in ('draft', 'submitted', 'under_review', 'returned', 'approved', 'denied', 'cancelled')),
  assigned_department text not null default 'Administrator'
    check (assigned_department = 'Administrator'),
  reviewer_id uuid references public.portal_profile(id) on delete set null,
  reviewer_email text,
  decision_note text,
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_expires_on is null or requested_expires_on >= created_at::date),
  check ((status in ('approved', 'denied') and decided_at is not null)
    or status not in ('approved', 'denied'))
);

create index if not exists portal_access_request_requester_idx
  on public.portal_access_request (requester_id, created_at desc);
create index if not exists portal_access_request_queue_idx
  on public.portal_access_request (status, risk_tier, submitted_at nulls last);
create unique index if not exists portal_access_request_one_open_per_target_idx
  on public.portal_access_request (target_profile_id)
  where status in ('submitted', 'under_review', 'returned');

create table if not exists public.portal_access_request_decision (
  id bigint generated always as identity primary key,
  access_request_id uuid not null references public.portal_access_request(id) on delete restrict,
  decision text not null check (decision in ('submitted', 'under_review', 'returned', 'approved', 'denied', 'cancelled')),
  actor_id uuid not null references public.portal_profile(id) on delete restrict,
  actor_email text,
  note text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_access_request_decision_idx
  on public.portal_access_request_decision (access_request_id, created_at);

create table if not exists public.portal_work_item_delegation (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.portal_work_item(id) on delete cascade,
  delegated_by uuid not null references public.portal_profile(id) on delete restrict,
  delegated_to uuid not null references public.portal_profile(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.portal_profile(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (delegated_by <> delegated_to),
  check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists portal_work_item_active_delegation_idx
  on public.portal_work_item_delegation (work_item_id)
  where revoked_at is null;

alter table public.portal_department enable row level security;
alter table public.portal_profile_department enable row level security;
alter table public.portal_access_request enable row level security;
alter table public.portal_access_request_decision enable row level security;
alter table public.portal_work_item_delegation enable row level security;

revoke all on table public.portal_department, public.portal_profile_department,
  public.portal_access_request, public.portal_access_request_decision,
  public.portal_work_item_delegation from public, anon, authenticated;
grant all on table public.portal_department, public.portal_profile_department,
  public.portal_access_request, public.portal_access_request_decision,
  public.portal_work_item_delegation to service_role;
grant usage, select on sequence public.portal_access_request_decision_id_seq
  to service_role;

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'access_requests', 'Workforce access requests', 'portal', 'retain_read_only',
  'UX OS owns access request, review, decision, evidence, assignment, and audit history. Cross-system deactivation remains held.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

create or replace function public.portal_access_request_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    new.submitted_at := now();
  end if;
  if new.status in ('approved', 'denied') and old.status is distinct from new.status then
    new.decided_at := now();
  elsif new.status not in ('approved', 'denied') then
    new.decided_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists portal_access_request_touch on public.portal_access_request;
create trigger portal_access_request_touch
before update on public.portal_access_request
for each row execute function public.portal_access_request_touch();

create or replace function public.portal_sync_access_request_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  queue_status := case
    when new.status = 'draft' then 'not_started'
    when new.status in ('returned') then 'waiting'
    when new.status = 'approved' then 'completed'
    when new.status in ('denied', 'cancelled') then 'cancelled'
    else 'in_progress'
  end;

  insert into public.portal_work_item (
    workflow_key, target_type, target_id, title, summary, status, priority,
    assigned_department, source_mode, metadata, created_by, updated_by,
    completed_at
  ) values (
    'access_requests', 'access_request', new.id::text,
    new.reference || ' · ' || replace(new.requested_staff_role, '_', ' '),
    'Workforce access request', queue_status,
    case when new.risk_tier = 'privileged' then 'P0'
      when new.risk_tier = 'sensitive' then 'P1' else 'P2' end,
    'Administrator', 'portal',
    jsonb_build_object(
      'accessRequestStatus', new.status,
      'requesterId', new.requester_id,
      'targetProfileId', new.target_profile_id,
      'requestedStaffRole', new.requested_staff_role,
      'requestedDepartmentKey', new.requested_department_key,
      'riskTier', new.risk_tier,
      'expiresOn', new.requested_expires_on
    ),
    new.requester_id, coalesce(new.reviewer_id, new.requester_id),
    case when queue_status = 'completed' then new.decided_at else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    status = excluded.status,
    priority = excluded.priority,
    assigned_department = excluded.assigned_department,
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_access_request_work_item
  on public.portal_access_request;
create trigger portal_sync_access_request_work_item
after insert or update on public.portal_access_request
for each row execute function public.portal_sync_access_request_work_item();

create or replace function public.portal_access_request_decision_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Access request decision history is append-only';
end;
$$;

drop trigger if exists portal_access_request_decision_immutable
  on public.portal_access_request_decision;
create trigger portal_access_request_decision_immutable
before update or delete on public.portal_access_request_decision
for each row execute function public.portal_access_request_decision_immutable();

create or replace function public.portal_apply_access_request_decision(
  p_access_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_actor_id uuid,
  p_actor_email text,
  p_note text
)
returns public.portal_access_request
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_row public.portal_access_request;
begin
  if p_decision not in ('under_review', 'returned', 'approved', 'denied') then
    raise exception 'Unsupported access request decision';
  end if;

  select * into request_row
  from public.portal_access_request
  where id = p_access_request_id
  for update;

  if not found then raise exception 'Access request not found'; end if;
  if request_row.version <> p_expected_version then
    raise exception 'Access request changed';
  end if;
  if request_row.status not in ('submitted', 'under_review', 'returned') then
    raise exception 'Access request is not reviewable';
  end if;
  if p_decision in ('returned', 'denied') and length(btrim(coalesce(p_note, ''))) < 8 then
    raise exception 'A decision note is required';
  end if;
  if p_decision = 'approved' and request_row.requester_id = p_actor_id
    and request_row.target_profile_id = p_actor_id then
    raise exception 'A requester cannot approve their own access';
  end if;

  update public.portal_access_request
  set status = p_decision,
      reviewer_id = p_actor_id,
      reviewer_email = p_actor_email,
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_access_request_id
  returning * into request_row;

  if p_decision = 'approved' then
    update public.portal_profile
    set staff_role = request_row.requested_staff_role
    where id = request_row.target_profile_id
      and role = 'internal'
      and active is true;
    if not found then raise exception 'Active workforce profile not found'; end if;

    if request_row.requested_department_key is not null then
      insert into public.portal_profile_department (
        profile_id, department_key, member_role, status, assigned_by,
        assigned_at, ended_at
      ) values (
        request_row.target_profile_id, request_row.requested_department_key,
        request_row.requested_department_role, 'active', p_actor_id, now(), null
      ) on conflict (profile_id, department_key) do update set
        member_role = excluded.member_role,
        status = 'active',
        assigned_by = excluded.assigned_by,
        assigned_at = now(),
        ended_at = null;
    end if;

    insert into public.portal_admin_audit (
      actor_id, action, target_id, detail
    ) values (
      p_actor_id, 'access_request_approved', request_row.target_profile_id,
      jsonb_build_object(
        'accessRequestId', request_row.id,
        'accessRequestReference', request_row.reference,
        'staffRole', request_row.requested_staff_role,
        'departmentKey', request_row.requested_department_key,
        'departmentRole', request_row.requested_department_role,
        'expiresOn', request_row.requested_expires_on
      )
    );
  end if;

  insert into public.portal_access_request_decision (
    access_request_id, decision, actor_id, actor_email, note, evidence
  ) values (
    request_row.id, p_decision, p_actor_id, p_actor_email,
    nullif(btrim(coalesce(p_note, '')), ''),
    jsonb_build_object('expectedVersion', p_expected_version,
      'resultVersion', request_row.version)
  );

  return request_row;
end;
$$;

revoke all on function public.portal_apply_access_request_decision(
  uuid, integer, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.portal_apply_access_request_decision(
  uuid, integer, text, uuid, text, text
) to service_role;

comment on table public.portal_access_request is
  'Portal-native workforce access request. Approval is Administrator-controlled and every decision is append-only.';
comment on table public.portal_work_item_delegation is
  'Time-bounded work-item delegation. Delegation never grants broader portal permissions.';
