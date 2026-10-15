-- Shared department request intake for the Internal Employee Portal.
-- This is intentionally generic: specialized Finance, Operations, Marketing,
-- Quality, and IT workflows may extend it without creating parallel task engines.

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'department_requests', 'Department requests', 'portal', 'retain_read_only',
  'UX OS owns department request intake, routing, review, evidence, and audit history. No Monday handoff is created.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

create table if not exists public.portal_department_request (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('REQ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  requester_id uuid not null references public.portal_profile(id) on delete restrict,
  department_key text not null references public.portal_department(department_key),
  request_type text not null check (request_type ~ '^[a-z0-9_]{2,50}$'),
  title text not null check (length(btrim(title)) between 5 and 200),
  details text not null check (length(btrim(details)) between 12 and 4000),
  priority text not null default 'P2' check (priority in ('P0','P1','P2','P3')),
  status text not null default 'submitted'
    check (status in ('submitted','under_review','returned','approved','denied','completed','cancelled')),
  assigned_department text not null,
  reviewer_id uuid references public.portal_profile(id) on delete set null,
  reviewer_email text,
  decision_note text,
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portal_department_request_requester_idx
  on public.portal_department_request (requester_id, created_at desc);
create index if not exists portal_department_request_queue_idx
  on public.portal_department_request (department_key, status, priority, submitted_at);

alter table public.portal_department_request enable row level security;
revoke all on table public.portal_department_request from public, anon, authenticated;
grant all on table public.portal_department_request to service_role;

create or replace function public.portal_department_request_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  if new.status in ('approved','denied') and old.status is distinct from new.status then
    new.decided_at := now();
  end if;
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists portal_department_request_touch on public.portal_department_request;
create trigger portal_department_request_touch before update on public.portal_department_request
for each row execute function public.portal_department_request_touch();

create or replace function public.portal_sync_department_request_work_item()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare queue_status text;
begin
  queue_status := case
    when new.status = 'returned' then 'waiting'
    when new.status = 'completed' then 'completed'
    when new.status in ('denied','cancelled') then 'cancelled'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, title, summary, status, priority,
    assigned_department, source_mode, metadata, created_by, updated_by, completed_at
  ) values (
    'department_requests', 'department_request', new.id::text,
    new.reference || ' · ' || new.title, new.details, queue_status, new.priority,
    new.assigned_department, 'portal',
    jsonb_build_object('departmentKey', new.department_key, 'requestType', new.request_type,
      'requestStatus', new.status), new.requester_id,
    coalesce(new.reviewer_id, new.requester_id), new.completed_at
  ) on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title, summary = excluded.summary, status = excluded.status,
    priority = excluded.priority, assigned_department = excluded.assigned_department,
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by, completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_department_request_work_item on public.portal_department_request;
create trigger portal_sync_department_request_work_item after insert or update on public.portal_department_request
for each row execute function public.portal_sync_department_request_work_item();

create or replace function public.portal_submit_department_request(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_request_type text,
  p_title text, p_details text, p_priority text
) returns public.portal_department_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; department_row public.portal_department;
  request_row public.portal_department_request;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department where department_key = p_department_key;
  if department_row.department_key is null or department_row.status <> 'active' then
    raise exception 'Choose an active department';
  end if;
  if p_request_type !~ '^[a-z0-9_]{2,50}$' or length(btrim(coalesce(p_title,''))) < 5
    or length(btrim(coalesce(p_details,''))) < 12 or p_priority not in ('P0','P1','P2','P3') then
    raise exception 'Complete the department request';
  end if;
  insert into public.portal_department_request (
    requester_id, department_key, request_type, title, details, priority, assigned_department
  ) values (
    p_actor_id, p_department_key, p_request_type, btrim(p_title), btrim(p_details), p_priority,
    department_row.display_name
  ) returning * into request_row;
  insert into public.portal_admin_audit (actor_id, event_type, metadata)
  values (p_actor_id, 'department_request_submitted', jsonb_build_object(
    'requestId', request_row.id, 'reference', request_row.reference,
    'departmentKey', p_department_key, 'requestType', p_request_type,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

create or replace function public.portal_decide_department_request(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_department_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; request_row public.portal_department_request;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal' and staff_role = 'administrator';
  if actor_row.id is null then raise exception 'Administrator access required'; end if;
  select * into request_row from public.portal_department_request where id = p_request_id for update;
  if request_row.id is null then raise exception 'Department request not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Department request changed'; end if;
  if request_row.status not in ('submitted','under_review','returned','approved') then
    raise exception 'Department request is not reviewable';
  end if;
  if p_decision not in ('under_review','returned','approved','denied','completed') then
    raise exception 'Invalid department request decision';
  end if;
  if p_decision in ('returned','approved','denied','completed') and length(btrim(coalesce(p_note,''))) < 8 then
    raise exception 'Decision evidence required';
  end if;
  if p_decision = 'approved' and request_row.requester_id = p_actor_id then
    raise exception 'You cannot approve your own department request';
  end if;
  update public.portal_department_request set status = p_decision,
    reviewer_id = p_actor_id, reviewer_email = nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    decision_note = nullif(btrim(coalesce(p_note,'')), '')
  where id = p_request_id returning * into request_row;
  insert into public.portal_admin_audit (actor_id, event_type, metadata)
  values (p_actor_id, 'department_request_' || p_decision, jsonb_build_object(
    'requestId', request_row.id, 'reference', request_row.reference,
    'departmentKey', request_row.department_key, 'evidence', request_row.decision_note,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

revoke all on function public.portal_submit_department_request(uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.portal_submit_department_request(uuid,text,text,text,text,text,text) to service_role;
revoke all on function public.portal_decide_department_request(uuid,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.portal_decide_department_request(uuid,text,uuid,integer,text,text) to service_role;

comment on table public.portal_department_request is
  'Portal-owned shared department request intake. Specialized workflows extend this foundation; no Monday handoff is created.';
