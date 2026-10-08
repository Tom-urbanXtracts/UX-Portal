-- Emergency production changes require independent retrospective approval
-- within one business day. The Portal owns the task and audit evidence.

insert into public.portal_workflow_control (workflow_key, display_name, mode, monday_retention, change_note)
values ('emergency_changes', 'Emergency change retrospective approval', 'portal', 'retain_read_only',
  'UX OS owns emergency-change intake, independent retrospective approval, evidence, and audit history.')
on conflict (workflow_key) do update set display_name = excluded.display_name, mode = excluded.mode,
  monday_retention = excluded.monday_retention, change_note = excluded.change_note, changed_at = now();

create table if not exists public.portal_emergency_change (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('CHANGE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  system_key text not null references public.portal_it_system(system_key) on delete restrict,
  title text not null check (length(btrim(title)) between 5 and 200),
  summary text not null check (length(btrim(summary)) between 12 and 4000),
  emergency_reason text not null check (length(btrim(emergency_reason)) between 12 and 2000),
  risk_level text not null default 'high' check (risk_level in ('medium', 'high', 'critical')),
  status text not null default 'awaiting_retrospective'
    check (status in ('awaiting_retrospective', 'approved', 'returned')),
  implemented_at timestamptz not null default now(),
  retrospective_due_at timestamptz not null,
  created_by uuid not null references public.portal_profile(id) on delete restrict,
  created_by_email text,
  reviewer_id uuid references public.portal_profile(id) on delete restrict,
  reviewer_email text,
  review_note text,
  reviewed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('approved', 'returned') and reviewed_at is not null) or status = 'awaiting_retrospective'),
  check (reviewer_id is null or reviewer_id <> created_by)
);

alter table public.portal_emergency_change enable row level security;
revoke all on table public.portal_emergency_change from public, anon, authenticated;
grant all on table public.portal_emergency_change to service_role;

create or replace function public.portal_emergency_change_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); new.version := old.version + 1; return new; end;
$$;
create trigger portal_emergency_change_touch before update on public.portal_emergency_change
for each row execute function public.portal_emergency_change_touch();

create or replace function public.portal_sync_emergency_change_work_item()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  insert into public.portal_work_item (workflow_key, target_type, target_id, title, summary, status,
    priority, assigned_department, due_at, source_mode, metadata, created_by, updated_by, completed_at)
  values ('emergency_changes', 'emergency_change', new.id::text, new.reference || ' · ' || new.title,
    'Independent retrospective approval required.',
    case when new.status = 'awaiting_retrospective' then 'waiting'
      when new.status = 'approved' then 'completed' else 'in_progress' end,
    'P0', 'Administrator', new.retrospective_due_at, 'portal',
    jsonb_build_object('systemKey', new.system_key, 'riskLevel', new.risk_level,
      'changeStatus', new.status, 'createdBy', new.created_by),
    new.created_by, coalesce(new.reviewer_id, new.created_by),
    case when new.status = 'approved' then new.reviewed_at else null end)
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title, status = excluded.status, priority = excluded.priority,
    due_at = excluded.due_at, metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by, completed_at = excluded.completed_at;
  return new;
end;
$$;
create trigger portal_sync_emergency_change_work_item after insert or update on public.portal_emergency_change
for each row execute function public.portal_sync_emergency_change_work_item();

create or replace function public.portal_create_emergency_change(
  p_actor_id uuid, p_actor_email text, p_system_key text, p_title text,
  p_summary text, p_emergency_reason text, p_risk_level text
)
returns public.portal_emergency_change
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; change_row public.portal_emergency_change;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if not exists (select 1 from public.portal_it_system where system_key = p_system_key) then raise exception 'System not found'; end if;
  if length(btrim(coalesce(p_title, ''))) < 5 or length(btrim(coalesce(p_summary, ''))) < 12
    or length(btrim(coalesce(p_emergency_reason, ''))) < 12 then raise exception 'Complete the emergency change record'; end if;
  if p_risk_level not in ('medium', 'high', 'critical') then raise exception 'Unsupported risk level'; end if;
  insert into public.portal_emergency_change (system_key, title, summary, emergency_reason,
    risk_level, retrospective_due_at, created_by, created_by_email)
  values (p_system_key, btrim(p_title), btrim(p_summary), btrim(p_emergency_reason), p_risk_level,
    public.portal_add_business_days(now(), 1), p_actor_id, p_actor_email)
  returning * into change_row;
  insert into public.portal_admin_audit (actor_id, action, detail) values
    (p_actor_id, 'emergency_change_recorded', jsonb_build_object('changeId', change_row.id,
      'reference', change_row.reference, 'systemKey', change_row.system_key,
      'riskLevel', change_row.risk_level, 'dueAt', change_row.retrospective_due_at,
      'actorEmail', p_actor_email));
  return change_row;
end;
$$;

create or replace function public.portal_decide_emergency_change(
  p_actor_id uuid, p_actor_email text, p_change_id uuid, p_expected_version integer,
  p_decision text, p_review_note text
)
returns public.portal_emergency_change
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; change_row public.portal_emergency_change;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if p_decision not in ('approved', 'returned') then raise exception 'Unsupported decision'; end if;
  if length(btrim(coalesce(p_review_note, ''))) < 8 then raise exception 'Retrospective evidence is required'; end if;
  select * into change_row from public.portal_emergency_change where id = p_change_id for update;
  if not found then raise exception 'Emergency change not found'; end if;
  if change_row.version <> p_expected_version then raise exception 'Emergency change changed'; end if;
  if change_row.status <> 'awaiting_retrospective' then raise exception 'Emergency change is not awaiting review'; end if;
  if change_row.created_by = p_actor_id then raise exception 'A change implementer cannot approve their own retrospective'; end if;
  update public.portal_emergency_change set status = p_decision, review_note = btrim(p_review_note),
    reviewer_id = p_actor_id, reviewer_email = p_actor_email, reviewed_at = now()
  where id = p_change_id returning * into change_row;
  insert into public.portal_admin_audit (actor_id, action, detail) values
    (p_actor_id, 'emergency_change_' || p_decision, jsonb_build_object('changeId', change_row.id,
      'reference', change_row.reference, 'systemKey', change_row.system_key,
      'reviewNote', change_row.review_note, 'actorEmail', p_actor_email));
  return change_row;
end;
$$;

revoke all on function public.portal_create_emergency_change(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.portal_create_emergency_change(uuid, text, text, text, text, text, text) to service_role;
revoke all on function public.portal_decide_emergency_change(uuid, text, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.portal_decide_emergency_change(uuid, text, uuid, integer, text, text) to service_role;

comment on table public.portal_emergency_change is
  'Administrator-recorded emergency production changes requiring independent retrospective approval within one business day.';
