-- Portal-native workforce offboarding. UX OS access is disabled immediately;
-- external systems remain explicit, manual checklist items until a later
-- automation release is separately approved.

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'workforce_offboarding', 'Workforce offboarding', 'portal', 'retain_read_only',
  'UX OS owns the case, immediate Portal deactivation, checklist, evidence, and audit history. External-system deactivation remains manual.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

create table if not exists public.portal_offboarding_case (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('OFFBOARD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  target_profile_id uuid not null references public.portal_profile(id) on delete restrict,
  target_email text not null check (target_email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  target_name text not null,
  reason text not null check (length(btrim(reason)) between 12 and 4000),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'cancelled')),
  portal_deactivated_at timestamptz not null default now(),
  auth_revocation_state text not null default 'pending'
    check (auth_revocation_state in ('pending', 'revoked', 'failed')),
  auth_revocation_note text,
  external_automation_state text not null default 'manual_required'
    check (external_automation_state = 'manual_required'),
  initiated_by uuid not null references public.portal_profile(id) on delete restrict,
  initiated_by_email text,
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'completed' and completed_at is not null) or status <> 'completed')
);

create unique index if not exists portal_offboarding_one_open_case_idx
  on public.portal_offboarding_case (target_profile_id)
  where status = 'in_progress';
create index if not exists portal_offboarding_queue_idx
  on public.portal_offboarding_case (status, created_at desc);

create table if not exists public.portal_offboarding_checklist (
  id uuid primary key default gen_random_uuid(),
  offboarding_case_id uuid not null references public.portal_offboarding_case(id) on delete cascade,
  system_key text not null check (system_key ~ '^[a-z0-9_]{2,60}$'),
  system_name text not null,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed', 'not_applicable')),
  owner_department text not null default 'Administrator',
  evidence_note text,
  completed_by uuid references public.portal_profile(id) on delete restrict,
  completed_by_email text,
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offboarding_case_id, system_key),
  check ((status in ('completed', 'not_applicable') and completed_at is not null)
    or status not in ('completed', 'not_applicable'))
);

alter table public.portal_offboarding_case enable row level security;
alter table public.portal_offboarding_checklist enable row level security;
revoke all on table public.portal_offboarding_case,
  public.portal_offboarding_checklist from public, anon, authenticated;
grant all on table public.portal_offboarding_case,
  public.portal_offboarding_checklist to service_role;

create or replace function public.portal_offboarding_case_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists portal_offboarding_case_touch on public.portal_offboarding_case;
create trigger portal_offboarding_case_touch
before update on public.portal_offboarding_case
for each row execute function public.portal_offboarding_case_touch();

create or replace function public.portal_offboarding_checklist_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists portal_offboarding_checklist_touch on public.portal_offboarding_checklist;
create trigger portal_offboarding_checklist_touch
before update on public.portal_offboarding_checklist
for each row execute function public.portal_offboarding_checklist_touch();

create or replace function public.portal_sync_offboarding_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, title, summary, status, priority,
    assigned_department, source_mode, metadata, created_by, updated_by, completed_at
  ) values (
    'workforce_offboarding', 'offboarding_case', new.id::text,
    new.reference || ' · ' || new.target_name,
    'Portal access is disabled. Complete every manual system and asset step.',
    case when new.status = 'completed' then 'completed'
      when new.status = 'cancelled' then 'cancelled' else 'in_progress' end,
    'P0', 'Administrator', 'portal',
    jsonb_build_object(
      'offboardingStatus', new.status,
      'targetProfileId', new.target_profile_id,
      'targetEmail', new.target_email,
      'authRevocationState', new.auth_revocation_state,
      'externalAutomationState', new.external_automation_state
    ),
    new.initiated_by, new.initiated_by,
    case when new.status = 'completed' then new.completed_at else null end
  ) on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    status = excluded.status,
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_offboarding_work_item on public.portal_offboarding_case;
create trigger portal_sync_offboarding_work_item
after insert or update on public.portal_offboarding_case
for each row execute function public.portal_sync_offboarding_work_item();

create or replace function public.portal_start_offboarding(
  p_actor_id uuid,
  p_actor_email text,
  p_target_profile_id uuid,
  p_target_email text,
  p_reason text
)
returns public.portal_offboarding_case
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor_row public.portal_profile;
  target_row public.portal_profile;
  case_row public.portal_offboarding_case;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then
    raise exception 'Administrator access is required';
  end if;
  if p_actor_id = p_target_profile_id then
    raise exception 'You cannot offboard your own account';
  end if;

  select * into target_row from public.portal_profile
  where id = p_target_profile_id for update;
  if not found or target_row.active is not true or target_row.role <> 'internal' then
    raise exception 'Active workforce profile not found';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 12 then
    raise exception 'A business reason is required';
  end if;

  update public.portal_profile set active = false where id = p_target_profile_id;

  insert into public.portal_offboarding_case (
    target_profile_id, target_email, target_name, reason,
    initiated_by, initiated_by_email
  ) values (
    p_target_profile_id, lower(btrim(p_target_email)),
    coalesce(nullif(btrim(target_row.full_name), ''), lower(btrim(p_target_email))),
    btrim(p_reason), p_actor_id, p_actor_email
  ) returning * into case_row;

  insert into public.portal_offboarding_checklist (
    offboarding_case_id, system_key, system_name, status,
    owner_department, evidence_note, completed_by, completed_by_email, completed_at
  ) values
    (case_row.id, 'ux_os', 'UX OS Portal', 'completed', 'Administrator',
      'Portal profile deactivated by the controlled offboarding transaction.', p_actor_id, p_actor_email, now()),
    (case_row.id, 'google_workspace', 'Google Workspace', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'monday', 'Monday.com', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'canix', 'Canix', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'pistil_data', 'PistilData', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'quickbooks', 'QuickBooks', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'contractor_portal', 'Contractor portal access', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'laptop', 'Laptop assignment', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'phone', 'Phone assignment', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'id_card', 'ID card assignment', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'supabase', 'Supabase', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'portal_hosting', 'Portal hosting', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'github', 'GitHub and source code', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'resend', 'Resend', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'domain_dns', 'Domain and DNS', 'not_started', 'Administrator', null, null, null, null),
    (case_row.id, 'document_scanner', 'Document scanner', 'not_started', 'Administrator', null, null, null, null);

  insert into public.portal_admin_audit (actor_id, action, target_id, target_email, detail)
  values (
    p_actor_id, 'workforce_offboarding_started', p_target_profile_id,
    lower(btrim(p_target_email)),
    jsonb_build_object('offboardingCaseId', case_row.id, 'reference', case_row.reference,
      'portalDeactivatedAt', case_row.portal_deactivated_at,
      'externalAutomationState', case_row.external_automation_state)
  );

  return case_row;
end;
$$;

create or replace function public.portal_update_offboarding_checklist(
  p_actor_id uuid,
  p_actor_email text,
  p_checklist_id uuid,
  p_expected_version integer,
  p_status text,
  p_evidence_note text
)
returns public.portal_offboarding_checklist
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor_row public.portal_profile;
  item_row public.portal_offboarding_checklist;
  case_row public.portal_offboarding_case;
  remaining_count integer;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then
    raise exception 'Administrator access is required';
  end if;
  if p_status not in ('not_started', 'in_progress', 'completed', 'not_applicable') then
    raise exception 'Unsupported checklist status';
  end if;
  if p_status in ('completed', 'not_applicable')
    and length(btrim(coalesce(p_evidence_note, ''))) < 8 then
    raise exception 'Evidence or a not-applicable reason is required';
  end if;

  select * into item_row from public.portal_offboarding_checklist
  where id = p_checklist_id for update;
  if not found then raise exception 'Checklist item not found'; end if;
  if item_row.version <> p_expected_version then raise exception 'Checklist item changed'; end if;

  select * into case_row from public.portal_offboarding_case
  where id = item_row.offboarding_case_id for update;
  if case_row.status <> 'in_progress' then raise exception 'Offboarding case is not active'; end if;

  update public.portal_offboarding_checklist
  set status = p_status,
      evidence_note = nullif(btrim(coalesce(p_evidence_note, '')), ''),
      completed_by = case when p_status in ('completed', 'not_applicable') then p_actor_id else null end,
      completed_by_email = case when p_status in ('completed', 'not_applicable') then p_actor_email else null end,
      completed_at = case when p_status in ('completed', 'not_applicable') then now() else null end
  where id = p_checklist_id
  returning * into item_row;

  select count(*) into remaining_count
  from public.portal_offboarding_checklist
  where offboarding_case_id = case_row.id
    and status not in ('completed', 'not_applicable');
  if remaining_count = 0 then
    update public.portal_offboarding_case
    set status = 'completed', completed_at = now()
    where id = case_row.id;
  else
    update public.portal_offboarding_case set updated_at = now() where id = case_row.id;
  end if;

  insert into public.portal_admin_audit (actor_id, action, target_id, target_email, detail)
  values (
    p_actor_id, 'offboarding_checklist_updated', case_row.target_profile_id,
    case_row.target_email,
    jsonb_build_object('offboardingCaseId', case_row.id, 'checklistId', item_row.id,
      'systemKey', item_row.system_key, 'status', p_status,
      'evidenceNote', item_row.evidence_note)
  );

  return item_row;
end;
$$;

create or replace function public.portal_record_offboarding_auth_state(
  p_actor_id uuid,
  p_actor_email text,
  p_offboarding_case_id uuid,
  p_auth_state text,
  p_auth_note text
)
returns public.portal_offboarding_case
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor_row public.portal_profile;
  case_row public.portal_offboarding_case;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then
    raise exception 'Administrator access is required';
  end if;
  if p_auth_state not in ('revoked', 'failed') then
    raise exception 'Unsupported Auth revocation state';
  end if;

  update public.portal_offboarding_case
  set auth_revocation_state = p_auth_state,
      auth_revocation_note = nullif(btrim(coalesce(p_auth_note, '')), '')
  where id = p_offboarding_case_id
  returning * into case_row;
  if not found then raise exception 'Offboarding case not found'; end if;

  insert into public.portal_admin_audit (actor_id, action, target_id, target_email, detail)
  values (
    p_actor_id,
    case when p_auth_state = 'revoked' then 'offboarding_auth_revoked'
      else 'offboarding_auth_revocation_failed' end,
    case_row.target_profile_id, case_row.target_email,
    jsonb_build_object('offboardingCaseId', case_row.id,
      'reference', case_row.reference, 'authRevocationState', p_auth_state,
      'actorEmail', p_actor_email)
  );
  return case_row;
end;
$$;

revoke all on function public.portal_start_offboarding(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_start_offboarding(uuid, text, uuid, text, text)
  to service_role;
revoke all on function public.portal_update_offboarding_checklist(uuid, text, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_update_offboarding_checklist(uuid, text, uuid, integer, text, text)
  to service_role;
revoke all on function public.portal_record_offboarding_auth_state(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_record_offboarding_auth_state(uuid, text, uuid, text, text)
  to service_role;

comment on table public.portal_offboarding_case is
  'Portal-native workforce offboarding case. Portal access is disabled immediately; external system actions remain manual.';
comment on table public.portal_offboarding_checklist is
  'Manual system, vendor-access, and asset checklist for a workforce offboarding case.';
