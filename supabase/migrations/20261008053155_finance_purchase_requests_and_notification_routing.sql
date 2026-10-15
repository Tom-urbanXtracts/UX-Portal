-- Department notification routing and the first portal-owned Finance
-- purchase-request workflow. Browser roles receive no direct table access;
-- all reads and mutations pass through the authenticated Edge Function.

create table if not exists public.portal_department_notification_recipient (
  id uuid primary key default gen_random_uuid(),
  department_key text not null references public.portal_department(department_key) on delete cascade,
  recipient_type text not null check (recipient_type in ('owner','inbox')),
  display_name text not null check (length(btrim(display_name)) between 2 and 160),
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email)) and position('@' in recipient_email) > 1),
  active boolean not null default true,
  created_by uuid references public.portal_profile(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_key, recipient_type, recipient_email)
);

create index if not exists portal_department_notification_recipient_route_idx
  on public.portal_department_notification_recipient (department_key, active, recipient_type);

alter table public.portal_department_notification_recipient enable row level security;
revoke all on table public.portal_department_notification_recipient from public, anon, authenticated;
grant all on table public.portal_department_notification_recipient to service_role;

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'finance_purchase_requests', 'Finance purchase requests', 'portal', 'retain_read_only',
  'UX OS owns purchase request intake, threshold routing, Administrator decisions, evidence, notifications, and audit history.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name, mode = excluded.mode,
  monday_retention = excluded.monday_retention, change_note = excluded.change_note,
  changed_at = now();

create table if not exists public.portal_purchase_request (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('PUR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  requester_id uuid not null references public.portal_profile(id) on delete restrict,
  requested_for_department_key text not null references public.portal_department(department_key),
  vendor_name text not null check (length(btrim(vendor_name)) between 2 and 200),
  expense_category text not null check (expense_category in ('supplies','services','inventory','equipment','travel','other')),
  purpose text not null check (length(btrim(purpose)) between 12 and 4000),
  amount numeric(12,2) not null check (amount > 0 and amount <= 9999999999.99),
  needed_by date,
  approval_tier text not null check (approval_tier in ('eric_500','leadership_2999','eran_3000')),
  approval_authority text not null,
  status text not null default 'submitted'
    check (status in ('submitted','under_review','returned','approved','denied','completed','cancelled')),
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

create index if not exists portal_purchase_request_requester_idx
  on public.portal_purchase_request (requester_id, created_at desc);
create index if not exists portal_purchase_request_queue_idx
  on public.portal_purchase_request (status, approval_tier, submitted_at);
create index if not exists portal_purchase_request_department_idx
  on public.portal_purchase_request (requested_for_department_key, created_at desc);

alter table public.portal_purchase_request enable row level security;
revoke all on table public.portal_purchase_request from public, anon, authenticated;
grant all on table public.portal_purchase_request to service_role;

create table if not exists public.portal_purchase_request_decision (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.portal_purchase_request(id) on delete cascade,
  decision text not null check (decision in ('submitted','under_review','returned','approved','denied','completed','cancelled')),
  actor_id uuid not null references public.portal_profile(id) on delete restrict,
  actor_email text,
  evidence_note text,
  created_at timestamptz not null default now()
);

create index if not exists portal_purchase_request_decision_request_idx
  on public.portal_purchase_request_decision (purchase_request_id, created_at desc);

alter table public.portal_purchase_request_decision enable row level security;
revoke all on table public.portal_purchase_request_decision from public, anon, authenticated;
grant all on table public.portal_purchase_request_decision to service_role;

create or replace function public.portal_purchase_request_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  if new.status in ('approved','denied') and old.status is distinct from new.status then new.decided_at := now(); end if;
  if new.status = 'completed' and old.status is distinct from 'completed' then new.completed_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists portal_purchase_request_touch on public.portal_purchase_request;
create trigger portal_purchase_request_touch before update on public.portal_purchase_request
for each row execute function public.portal_purchase_request_touch();

create or replace function public.portal_sync_purchase_request_work_item()
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
    'finance_purchase_requests', 'purchase_request', new.id::text,
    new.reference || ' · ' || new.vendor_name,
    new.purpose, queue_status,
    case when new.amount >= 3000 then 'P1' else 'P2' end,
    'Finance and Accounting', 'portal',
    jsonb_build_object('amount', new.amount, 'approvalTier', new.approval_tier,
      'approvalAuthority', new.approval_authority, 'requestStatus', new.status,
      'requestedForDepartmentKey', new.requested_for_department_key),
    new.requester_id, coalesce(new.reviewer_id, new.requester_id), new.completed_at
  ) on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title, summary = excluded.summary, status = excluded.status,
    priority = excluded.priority, assigned_department = excluded.assigned_department,
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by, completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_purchase_request_work_item on public.portal_purchase_request;
create trigger portal_sync_purchase_request_work_item after insert or update on public.portal_purchase_request
for each row execute function public.portal_sync_purchase_request_work_item();

create or replace function public.portal_submit_purchase_request(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_vendor_name text,
  p_expense_category text, p_purpose text, p_amount numeric, p_needed_by date
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; department_row public.portal_department;
  request_row public.portal_purchase_request; route_tier text; route_authority text;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department where department_key = p_department_key and status = 'active';
  if department_row.department_key is null then raise exception 'Choose an active department'; end if;
  if length(btrim(coalesce(p_vendor_name,''))) < 2 or length(btrim(coalesce(p_purpose,''))) < 12
    or p_expense_category not in ('supplies','services','inventory','equipment','travel','other')
    or p_amount is null or p_amount <= 0 then raise exception 'Complete the purchase request'; end if;
  if p_amount <= 500 then route_tier := 'eric_500'; route_authority := 'Eric Stewart';
  elsif p_amount < 3000 then route_tier := 'leadership_2999'; route_authority := 'Omeed / Jonathan / Drew';
  else route_tier := 'eran_3000'; route_authority := 'Eran'; end if;
  insert into public.portal_purchase_request (
    requester_id, requested_for_department_key, vendor_name, expense_category,
    purpose, amount, needed_by, approval_tier, approval_authority
  ) values (
    p_actor_id, p_department_key, btrim(p_vendor_name), p_expense_category,
    btrim(p_purpose), round(p_amount, 2), p_needed_by, route_tier, route_authority
  ) returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'submitted', p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''), 'Submitted through the Internal portal.');
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_submitted', request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'approvalTier', route_tier, 'approvalAuthority', route_authority,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

create or replace function public.portal_decide_purchase_request(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; request_row public.portal_purchase_request;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal' and staff_role = 'administrator';
  if actor_row.id is null then raise exception 'Administrator access required'; end if;
  select * into request_row from public.portal_purchase_request where id = p_request_id for update;
  if request_row.id is null then raise exception 'Purchase request not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Purchase request changed'; end if;
  if request_row.status not in ('submitted','under_review','returned','approved') then
    raise exception 'Purchase request is not reviewable'; end if;
  if p_decision not in ('under_review','returned','approved','denied','completed') then
    raise exception 'Invalid purchase request decision'; end if;
  if p_decision in ('returned','approved','denied','completed') and length(btrim(coalesce(p_note,''))) < 8 then
    raise exception 'Decision evidence required'; end if;
  if p_decision = 'approved' and request_row.requester_id = p_actor_id then
    raise exception 'You cannot approve your own purchase request'; end if;
  update public.portal_purchase_request set status = p_decision,
    reviewer_id = p_actor_id, reviewer_email = nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    decision_note = nullif(btrim(coalesce(p_note,'')), '')
  where id = p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, p_decision, p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''), nullif(btrim(coalesce(p_note,'')), ''));
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_' || p_decision, request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'approvalAuthority', request_row.approval_authority, 'evidence', request_row.decision_note,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

revoke all on function public.portal_submit_purchase_request(uuid,text,text,text,text,text,numeric,date) from public, anon, authenticated;
grant execute on function public.portal_submit_purchase_request(uuid,text,text,text,text,text,numeric,date) to service_role;
revoke all on function public.portal_decide_purchase_request(uuid,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.portal_decide_purchase_request(uuid,text,uuid,integer,text,text) to service_role;

alter table public.portal_notification_outbox drop constraint if exists portal_notification_outbox_event_type_check;
alter table public.portal_notification_outbox add constraint portal_notification_outbox_event_type_check check (event_type in (
  'user_invitation','onboarding_submitted','onboarding_incomplete','license_expiry','store_ready',
  'kiosk_guide','order_guide','user_guide','order_state','invoice_notice','payment_recorded',
  'payment_receipt','receiving_claim_submitted','receiving_claim_updated','coa_amended','recall_notice',
  'inventory_sync_failed','integration_failed','owner_approval_required','claim_status_changed',
  'access_request_internal','onboarding_review_internal','license_review_internal','order_delivery_failed',
  'quickbooks_sync_failed','pricing_review_required','order_approval_aging_internal','daily_operations_digest',
  'sku_section_assignment','brand_purchase_order_received','brand_purchase_order_state_changed',
  'brand_application_resume','brand_application_submitted','department_request','purchase_request'
));

insert into public.portal_notification_template (
  template_key, title, audience, category, mandatory, default_channels,
  subject_template, text_template, allowed_variables, approval_state
) values
  ('department_request_routed', 'Department request routed', 'internal', 'account', true,
   array['in_portal','email']::text[], 'New request {{requestReference}} for {{departmentName}}',
   E'Hello {{recipientName}},\n\n{{requestReference}} — {{requestTitle}} was submitted for {{departmentName}}. Priority: {{priority}}.\n\nAdministrators control the review queue. Open My Work: {{portalUrl}}',
   array['recipientName','requestReference','requestTitle','departmentName','priority','portalUrl'], 'approved'),
  ('department_request_team_updated', 'Department request team update', 'internal', 'account', true,
   array['in_portal','email']::text[], '{{requestReference}} is now {{requestStatus}}',
   E'Hello {{recipientName}},\n\n{{requestReference}} — {{requestTitle}} is now {{requestStatus}}.\n\nReview note: {{decisionNote}}\n\nOpen My Work: {{portalUrl}}',
   array['recipientName','requestReference','requestTitle','requestStatus','decisionNote','portalUrl'], 'approved'),
  ('purchase_request_received', 'Purchase request received', 'internal', 'account', true,
   array['in_portal','email']::text[], 'Purchase request {{requestReference}} was received',
   E'Hello {{recipientName}},\n\nWe received {{requestReference}} for {{vendorName}} in the amount of {{amount}}. Required business authority: {{approvalAuthority}}.\n\nFollow the request in My Work: {{portalUrl}}',
   array['recipientName','requestReference','vendorName','amount','approvalAuthority','portalUrl'], 'approved'),
  ('purchase_request_approval_required', 'Purchase approval required', 'internal', 'account', true,
   array['in_portal','email']::text[], '{{requestReference}} requires {{approvalAuthority}} approval',
   E'Hello {{recipientName}},\n\n{{requestReference}} for {{vendorName}} totals {{amount}} and requires {{approvalAuthority}} as the business authority. Administrators control the portal queue and must record the approval evidence.\n\nOpen My Work: {{portalUrl}}',
   array['recipientName','requestReference','vendorName','amount','approvalAuthority','portalUrl'], 'approved'),
  ('purchase_request_updated', 'Purchase request updated', 'internal', 'account', true,
   array['in_portal','email']::text[], '{{requestReference}} is now {{requestStatus}}',
   E'Hello {{recipientName}},\n\n{{requestReference}} for {{vendorName}} is now {{requestStatus}}.\n\nDecision evidence: {{decisionNote}}\n\nOpen My Work: {{portalUrl}}',
   array['recipientName','requestReference','vendorName','requestStatus','decisionNote','portalUrl'], 'approved')
on conflict (template_key) do update set
  title = excluded.title, audience = excluded.audience, category = excluded.category,
  mandatory = excluded.mandatory, default_channels = excluded.default_channels,
  subject_template = excluded.subject_template, text_template = excluded.text_template,
  allowed_variables = excluded.allowed_variables, approval_state = excluded.approval_state,
  version = public.portal_notification_template.version + 1, updated_at = now();

comment on table public.portal_department_notification_recipient is
  'Configured department owners and shared inboxes. Active Administrators and assigned department heads/backup owners are resolved dynamically.';
comment on table public.portal_purchase_request is
  'Portal-owned Finance purchase requests with server-computed authority tiers and Administrator-controlled decisions.';
