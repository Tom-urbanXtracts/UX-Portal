-- Administrator-controlled access review calendar and privileged-system register.
-- Reviews are manual by design; this release does not automate vendor or user
-- deactivation and does not store credentials in this inventory.

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'access_governance_reviews', 'User and vendor access reviews', 'portal', 'retain_read_only',
  'UX OS schedules and evidences reviews. Review execution and remediation remain Administrator-controlled.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

create table if not exists public.portal_it_system (
  system_key text primary key check (system_key ~ '^[a-z0-9_]{2,60}$'),
  display_name text not null unique,
  category text not null check (category in ('platform', 'identity', 'integration', 'vendor', 'device', 'facility')),
  privileged boolean not null default true,
  platform_owner text not null default 'IT',
  business_owner text,
  reconnect_authority text not null,
  visibility_summary text not null,
  credential_location text not null check (credential_location in ('external_admin', 'encrypted_vault', 'no_credentials', 'not_confirmed')),
  connection_state text not null default 'unknown'
    check (connection_state in ('connected', 'manual', 'not_connected', 'on_hold', 'unknown')),
  health_state text not null default 'unknown'
    check (health_state in ('healthy', 'degraded', 'outage', 'unknown', 'not_applicable')),
  freshness text not null default 'unknown'
    check (freshness in ('real_time', 'event_driven', 'five_minutes', 'scheduled', 'manual', 'unknown', 'not_applicable')),
  last_verified_at timestamptz,
  next_review_on date,
  evidence_note text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.portal_it_system (
  system_key, display_name, category, platform_owner, business_owner,
  reconnect_authority, visibility_summary, credential_location,
  connection_state, health_state, freshness, evidence_note
) values
  ('ux_os', 'UX OS Portal', 'platform', 'IT', 'All departments', 'IT Admin', 'Role-scoped Portal access', 'encrypted_vault', 'connected', 'healthy', 'real_time', 'Portal foundation is active.'),
  ('google_workspace', 'Google Workspace', 'identity', 'IT', 'All departments', 'IT Admin', 'Employee identity and SSO', 'external_admin', 'connected', 'healthy', 'real_time', 'Workspace SSO is the workforce identity path.'),
  ('monday', 'Monday.com', 'integration', 'IT', 'Operations', 'IT Admin', 'Historical and approved retained workflows', 'encrypted_vault', 'connected', 'unknown', 'event_driven', 'Connection exists; each workflow has a separate source boundary.'),
  ('canix', 'Canix', 'integration', 'IT', 'Operations and Compliance', 'IT Admin', 'Cannabis inventory and compliance source', 'encrypted_vault', 'connected', 'unknown', 'five_minutes', 'Canix remains authoritative; five minutes is the accepted maximum delay.'),
  ('pistil_data', 'PistilData', 'vendor', 'IT', 'Sales', 'IT Admin', 'Vendor access under review', 'not_confirmed', 'unknown', 'unknown', 'unknown', 'Connection and access evidence require confirmation.'),
  ('quickbooks', 'QuickBooks', 'integration', 'IT', 'Finance', 'Finance Admin or IT Admin', 'Finance, Executives, IT, and Sales have approved broad visibility', 'encrypted_vault', 'connected', 'unknown', 'scheduled', 'QuickBooks remains authoritative; reconnect is restricted.'),
  ('contractor_portal', 'Contractor portal access', 'identity', 'IT', 'IT', 'IT Admin', 'Expiration-controlled contractor accounts', 'no_credentials', 'manual', 'unknown', 'manual', 'Portal contractor access is reviewed manually.'),
  ('laptop', 'Laptop assignments', 'device', 'IT', 'IT', 'IT Admin', 'Assignment register only', 'no_credentials', 'manual', 'unknown', 'manual', 'MDM and endpoint enforcement remain held.'),
  ('phone', 'Phone assignments', 'device', 'IT', 'IT', 'IT Admin', 'Assignment register only', 'no_credentials', 'manual', 'unknown', 'manual', 'Device automation remains held.'),
  ('id_card', 'ID card assignments', 'facility', 'IT', 'Operations', 'IT Admin', 'Physical-access assignment register', 'no_credentials', 'manual', 'unknown', 'manual', 'Physical access is confirmed manually.'),
  ('supabase', 'Supabase', 'platform', 'IT', 'IT', 'IT Admin', 'Portal database, Auth, Storage, and Edge Functions', 'external_admin', 'connected', 'healthy', 'real_time', 'Production Portal backend is active.'),
  ('portal_hosting', 'Portal hosting', 'platform', 'IT', 'IT', 'IT Admin', 'Production Portal hosting and domain binding', 'external_admin', 'connected', 'healthy', 'real_time', 'Production hostname is active.'),
  ('github', 'GitHub and source code', 'platform', 'IT', 'IT', 'IT Admin', 'Source repository and deployment evidence', 'external_admin', 'manual', 'unknown', 'manual', 'Repository access review is manual.'),
  ('resend', 'Resend', 'vendor', 'IT', 'Marketing and Operations', 'IT Admin', 'Controlled Portal email delivery', 'encrypted_vault', 'connected', 'unknown', 'event_driven', 'Delivery events are recorded; plan upgrade is approved.'),
  ('domain_dns', 'Domain and DNS', 'platform', 'IT', 'IT', 'IT Admin', 'Wix-managed DNS for the Portal hostname', 'external_admin', 'manual', 'healthy', 'manual', 'DNS changes require Administrator evidence.'),
  ('document_scanner', 'Document scanner', 'vendor', 'IT', 'Quality and Compliance', 'IT Admin', 'Malware scanning for Portal-managed uploads', 'not_confirmed', 'on_hold', 'unknown', 'unknown', 'Production scanner approval and connection remain held.')
on conflict (system_key) do nothing;

create table if not exists public.portal_governance_review (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('REVIEW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  review_kind text not null check (review_kind in ('user_access', 'vendor_access')),
  title text not null,
  period_start date not null,
  period_end date not null,
  due_on date not null,
  cadence text not null default 'quarterly' check (cadence in ('monthly', 'quarterly', 'semiannual', 'annual')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  owner_department text not null default 'Administrator',
  evidence_note text,
  completed_by uuid references public.portal_profile(id) on delete restrict,
  completed_by_email text,
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_kind, period_start, period_end),
  check (period_end >= period_start),
  check (due_on >= period_start),
  check ((status = 'completed' and completed_at is not null) or status <> 'completed')
);

insert into public.portal_governance_review (
  review_kind, title, period_start, period_end, due_on, cadence, status
) values
  ('user_access', 'Q4 2026 workforce access review', date '2026-10-01', date '2026-12-31', date '2026-12-31', 'quarterly', 'scheduled'),
  ('vendor_access', 'Q4 2026 vendor access review', date '2026-10-01', date '2026-12-31', date '2026-12-31', 'quarterly', 'scheduled')
on conflict (review_kind, period_start, period_end) do nothing;

alter table public.portal_it_system enable row level security;
alter table public.portal_governance_review enable row level security;
revoke all on table public.portal_it_system, public.portal_governance_review
  from public, anon, authenticated;
grant all on table public.portal_it_system, public.portal_governance_review to service_role;

create or replace function public.portal_it_system_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); new.version := old.version + 1; return new; end;
$$;
drop trigger if exists portal_it_system_touch on public.portal_it_system;
create trigger portal_it_system_touch before update on public.portal_it_system
for each row execute function public.portal_it_system_touch();

create or replace function public.portal_governance_review_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); new.version := old.version + 1; return new; end;
$$;
drop trigger if exists portal_governance_review_touch on public.portal_governance_review;
create trigger portal_governance_review_touch before update on public.portal_governance_review
for each row execute function public.portal_governance_review_touch();

create or replace function public.portal_sync_governance_review_work_item()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, title, summary, status, priority,
    assigned_department, due_at, source_mode, metadata, created_by, updated_by, completed_at
  ) values (
    'access_governance_reviews', 'governance_review', new.id::text,
    new.reference || ' · ' || new.title,
    'Administrator-controlled ' || replace(new.review_kind, '_', ' ') || ' review.',
    case when new.status = 'scheduled' then 'not_started'
      when new.status = 'in_progress' then 'in_progress'
      when new.status = 'completed' then 'completed' else 'cancelled' end,
    'P1', 'Administrator', new.due_on::timestamptz + interval '23 hours 59 minutes',
    'portal', jsonb_build_object('reviewKind', new.review_kind, 'cadence', new.cadence,
      'periodStart', new.period_start, 'periodEnd', new.period_end),
    new.completed_by, new.completed_by,
    case when new.status = 'completed' then new.completed_at else null end
  ) on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title, status = excluded.status, due_at = excluded.due_at,
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by, completed_at = excluded.completed_at;
  return new;
end;
$$;
drop trigger if exists portal_sync_governance_review_work_item on public.portal_governance_review;
create trigger portal_sync_governance_review_work_item
after insert or update on public.portal_governance_review
for each row execute function public.portal_sync_governance_review_work_item();

-- Backfill work items for the initial review schedule after the trigger exists.
update public.portal_governance_review set updated_at = now()
where period_start = date '2026-10-01' and period_end = date '2026-12-31';

create or replace function public.portal_update_governance_review(
  p_actor_id uuid, p_actor_email text, p_review_id uuid,
  p_expected_version integer, p_status text, p_due_on date, p_evidence_note text
)
returns public.portal_governance_review
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; review_row public.portal_governance_review;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if p_status not in ('scheduled', 'in_progress', 'completed', 'cancelled') then
    raise exception 'Unsupported review status'; end if;
  if p_status = 'completed' and length(btrim(coalesce(p_evidence_note, ''))) < 8 then
    raise exception 'Review evidence is required'; end if;
  select * into review_row from public.portal_governance_review where id = p_review_id for update;
  if not found then raise exception 'Governance review not found'; end if;
  if review_row.version <> p_expected_version then raise exception 'Governance review changed'; end if;
  update public.portal_governance_review set
    status = p_status, due_on = p_due_on,
    evidence_note = nullif(btrim(coalesce(p_evidence_note, '')), ''),
    completed_by = case when p_status = 'completed' then p_actor_id else null end,
    completed_by_email = case when p_status = 'completed' then p_actor_email else null end,
    completed_at = case when p_status = 'completed' then now() else null end
  where id = p_review_id returning * into review_row;
  insert into public.portal_admin_audit (actor_id, action, detail) values (
    p_actor_id, 'governance_review_updated',
    jsonb_build_object('reviewId', review_row.id, 'reference', review_row.reference,
      'reviewKind', review_row.review_kind, 'status', review_row.status,
      'dueOn', review_row.due_on, 'evidenceNote', review_row.evidence_note));
  return review_row;
end;
$$;

create or replace function public.portal_update_it_system(
  p_actor_id uuid, p_actor_email text, p_system_key text, p_expected_version integer,
  p_connection_state text, p_health_state text, p_freshness text,
  p_next_review_on date, p_evidence_note text
)
returns public.portal_it_system
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; system_row public.portal_it_system;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if p_connection_state not in ('connected', 'manual', 'not_connected', 'on_hold', 'unknown')
    or p_health_state not in ('healthy', 'degraded', 'outage', 'unknown', 'not_applicable')
    or p_freshness not in ('real_time', 'event_driven', 'five_minutes', 'scheduled', 'manual', 'unknown', 'not_applicable') then
    raise exception 'Unsupported system state'; end if;
  if length(btrim(coalesce(p_evidence_note, ''))) < 8 then raise exception 'Verification evidence is required'; end if;
  select * into system_row from public.portal_it_system where system_key = p_system_key for update;
  if not found then raise exception 'System not found'; end if;
  if system_row.version <> p_expected_version then raise exception 'System register changed'; end if;
  update public.portal_it_system set
    connection_state = p_connection_state, health_state = p_health_state,
    freshness = p_freshness, next_review_on = p_next_review_on,
    evidence_note = btrim(p_evidence_note), last_verified_at = now()
  where system_key = p_system_key returning * into system_row;
  insert into public.portal_admin_audit (actor_id, action, detail) values (
    p_actor_id, 'privileged_system_verified',
    jsonb_build_object('systemKey', system_row.system_key,
      'connectionState', system_row.connection_state, 'healthState', system_row.health_state,
      'freshness', system_row.freshness, 'nextReviewOn', system_row.next_review_on,
      'evidenceNote', system_row.evidence_note, 'actorEmail', p_actor_email));
  return system_row;
end;
$$;

revoke all on function public.portal_update_governance_review(uuid, text, uuid, integer, text, date, text)
  from public, anon, authenticated;
grant execute on function public.portal_update_governance_review(uuid, text, uuid, integer, text, date, text)
  to service_role;
revoke all on function public.portal_update_it_system(uuid, text, text, integer, text, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.portal_update_it_system(uuid, text, text, integer, text, text, text, date, text)
  to service_role;

comment on table public.portal_it_system is
  'Privileged system and integration register. It stores control metadata and evidence, never credentials.';
comment on table public.portal_governance_review is
  'Manual workforce and vendor access review schedule with Administrator evidence and work-queue linkage.';
