-- Native portal operations layer for the controlled exit from monday.com.
-- monday.com is retained unchanged as historical/fallback evidence. Each
-- workflow moves independently through hold, monday, parallel, and portal
-- modes; a browser can never change this control directly.

create table if not exists public.portal_workflow_control (
  workflow_key text primary key check (workflow_key ~ '^[a-z0-9_]{3,80}$'),
  display_name text not null,
  mode text not null check (mode in ('hold', 'monday', 'parallel', 'portal')),
  monday_retention text not null default 'retain_read_only'
    check (monday_retention in ('retain_active', 'retain_read_only')),
  change_note text not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_email text,
  changed_at timestamptz not null default now()
);

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values
  ('store_onboarding', 'Store onboarding', 'hold', 'retain_active',
   'Migration work paused by business decision on 1 October 2026. Existing production behavior remains unchanged.'),
  ('brand_onboarding', 'Brand onboarding', 'portal', 'retain_read_only',
   'The portal owns Brand company submissions, section review, corrections, approvals, and audit history.'),
  ('brand_purchase_orders', 'Brand purchase orders', 'portal', 'retain_read_only',
   'The portal owns Brand purchase-order entry, review, approval, fulfillment status, and evidence.'),
  ('store_orders', 'Store orders and fulfillment', 'portal', 'retain_read_only',
   'The portal owns order acceptance and fulfillment state. Canix and QuickBooks boundaries remain unchanged.'),
  ('brand_manufacturing', 'Brand manufacturing milestones', 'parallel', 'retain_active',
   'Kept in parallel until the P1 milestone review is approved.'),
  ('catalog_content', 'Catalog content', 'monday', 'retain_active',
   'Not part of the current P0 cutover.'),
  ('lot_ownership', 'Lots and ownership', 'hold', 'retain_active',
   'On hold pending the Canix Owner and Lot / Cost Object decisions.')
on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

create table if not exists public.portal_work_item (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default
    ('WORK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  workflow_key text not null references public.portal_workflow_control(workflow_key),
  target_type text not null check (target_type ~ '^[a-z0-9_]{3,80}$'),
  target_id text not null,
  organization_id uuid references public.portal_organization(id) on delete cascade,
  store_license text references public.portal_store(license_number) on delete set null,
  title text not null,
  summary text,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'waiting', 'completed', 'cancelled')),
  priority text not null default 'P0' check (priority in ('P0', 'P1', 'P2', 'P3')),
  assigned_department text not null default 'Administrator',
  assigned_user uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  source_mode text not null check (source_mode in ('hold', 'monday', 'parallel', 'portal')),
  source_record_id text,
  version integer not null default 1 check (version > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workflow_key, target_type, target_id),
  check ((status = 'completed' and completed_at is not null) or status <> 'completed')
);

create index if not exists portal_work_item_queue_idx
  on public.portal_work_item (status, priority, due_at nulls last, created_at);
create index if not exists portal_work_item_org_idx
  on public.portal_work_item (organization_id, status, updated_at desc);

create table if not exists public.portal_work_item_comment (
  id bigint generated always as identity primary key,
  work_item_id uuid not null references public.portal_work_item(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 4000),
  visibility text not null default 'internal' check (visibility in ('internal', 'brand', 'store')),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_work_item_evidence (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.portal_work_item(id) on delete cascade,
  evidence_type text not null,
  object_path text,
  external_reference text,
  original_name text,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes between 1 and 10485760),
  scan_state text not null default 'not_applicable'
    check (scan_state in ('pending', 'clean', 'quarantined', 'not_applicable')),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  check (object_path is not null or external_reference is not null)
);

create table if not exists public.portal_work_item_event (
  id bigint generated always as identity primary key,
  work_item_id uuid not null references public.portal_work_item(id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_work_item_comment_idx
  on public.portal_work_item_comment (work_item_id, created_at);
create index if not exists portal_work_item_evidence_idx
  on public.portal_work_item_evidence (work_item_id, created_at);
create index if not exists portal_work_item_event_idx
  on public.portal_work_item_event (work_item_id, created_at);

alter table public.portal_workflow_control enable row level security;
alter table public.portal_work_item enable row level security;
alter table public.portal_work_item_comment enable row level security;
alter table public.portal_work_item_evidence enable row level security;
alter table public.portal_work_item_event enable row level security;

revoke all on table public.portal_workflow_control, public.portal_work_item,
  public.portal_work_item_comment, public.portal_work_item_evidence,
  public.portal_work_item_event from public, anon, authenticated;
grant all on table public.portal_workflow_control, public.portal_work_item,
  public.portal_work_item_comment, public.portal_work_item_evidence,
  public.portal_work_item_event to service_role;
grant usage, select on sequence public.portal_work_item_comment_id_seq,
  public.portal_work_item_event_id_seq to service_role;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'portal-work-evidence', 'portal-work-evidence', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg']::text[]
) on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.portal_work_item_event_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Portal work-item history is append-only';
end;
$$;

drop trigger if exists portal_work_item_event_immutable on public.portal_work_item_event;
create trigger portal_work_item_event_immutable
before update or delete on public.portal_work_item_event
for each row execute function public.portal_work_item_event_immutable();

create or replace function public.portal_work_item_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at := now();
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists portal_work_item_touch on public.portal_work_item;
create trigger portal_work_item_touch
before update on public.portal_work_item
for each row execute function public.portal_work_item_touch();

create or replace function public.portal_work_item_audit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.portal_work_item_event (
    work_item_id, action, from_status, to_status, actor_id, actor_email, detail
  ) values (
    new.id,
    case when tg_op = 'INSERT' then 'created' else 'updated' end,
    case when tg_op = 'UPDATE' then old.status else null end,
    new.status,
    new.updated_by,
    null,
    jsonb_build_object(
      'workflowKey', new.workflow_key,
      'assignedDepartment', new.assigned_department,
      'sourceMode', new.source_mode,
      'version', new.version
    )
  );
  return new;
end;
$$;

drop trigger if exists portal_work_item_audit on public.portal_work_item;
create trigger portal_work_item_audit
after insert or update on public.portal_work_item
for each row execute function public.portal_work_item_audit();

-- Brand purchase orders now have a fully native lifecycle. Legacy states and
-- monday identifiers are retained so historical records remain readable.
alter table public.portal_brand_purchase_order
  drop constraint if exists portal_brand_purchase_order_status_check;
alter table public.portal_brand_purchase_order
  add constraint portal_brand_purchase_order_status_check check (status in (
    'draft', 'submitted', 'under_review', 'approved', 'acknowledged',
    'scheduled', 'in_production', 'quality_review', 'ready_to_ship',
    'shipped', 'delivered', 'complete', 'completed', 'on_hold',
    'rejected', 'cancelled', 'exception'
  ));
alter table public.portal_brand_purchase_order
  drop constraint if exists portal_brand_purchase_order_handoff_state_check;
alter table public.portal_brand_purchase_order
  add constraint portal_brand_purchase_order_handoff_state_check check (
    handoff_state in (
      'not_ready', 'pending', 'accepted', 'needs_reconciliation',
      'not_configured', 'parallel', 'portal_native'
    )
  );
alter table public.portal_brand_purchase_order
  add column if not exists priority text not null default 'P0'
    check (priority in ('P0', 'P1', 'P2', 'P3')),
  add column if not exists assigned_department text not null default 'Administrator',
  add column if not exists assigned_user uuid references auth.users(id) on delete set null,
  add column if not exists due_at timestamptz,
  add column if not exists revision integer not null default 1 check (revision > 0),
  add column if not exists approved_at timestamptz,
  add column if not exists completed_at timestamptz;

create or replace function public.portal_sync_brand_po_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  if new.status = 'draft' then return new; end if;
  queue_status := case
    when new.status in ('complete', 'completed', 'delivered') then 'completed'
    when new.status in ('cancelled', 'rejected') then 'cancelled'
    when new.status in ('on_hold', 'exception') then 'waiting'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, organization_id, title, summary,
    status, priority, assigned_department, assigned_user, due_at, source_mode,
    source_record_id, metadata, created_by, updated_by, completed_at
  ) values (
    'brand_purchase_orders', 'brand_purchase_order', new.id::text,
    new.organization_id, new.reference,
    coalesce(new.notes, 'Brand purchase order'), queue_status, new.priority,
    new.assigned_department, new.assigned_user, new.due_at, 'portal',
    new.monday_item_id,
    jsonb_build_object('purchaseOrderStatus', new.status, 'requestType', new.request_type),
    new.created_by, new.created_by,
    case when queue_status = 'completed' then coalesce(new.completed_at, now()) else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    priority = excluded.priority,
    assigned_department = excluded.assigned_department,
    assigned_user = excluded.assigned_user,
    due_at = excluded.due_at,
    source_mode = excluded.source_mode,
    source_record_id = coalesce(excluded.source_record_id, portal_work_item.source_record_id),
    metadata = portal_work_item.metadata || excluded.metadata,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_brand_po_work_item on public.portal_brand_purchase_order;
create trigger portal_sync_brand_po_work_item
after insert or update on public.portal_brand_purchase_order
for each row execute function public.portal_sync_brand_po_work_item();

alter table public.portal_brand_onboarding
  drop constraint if exists portal_brand_onboarding_monday_handoff_state_check;
alter table public.portal_brand_onboarding
  add constraint portal_brand_onboarding_monday_handoff_state_check check (
    monday_handoff_state in (
      'not_ready', 'queued', 'accepted', 'reconciliation_required', 'portal_native'
    )
  );

create or replace function public.portal_sync_brand_onboarding_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  queue_status := case
    when new.status = 'approved' then 'completed'
    when new.status = 'changes_requested' then 'waiting'
    when new.status = 'draft' then 'not_started'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, organization_id, title, summary,
    status, priority, assigned_department, source_mode, source_record_id,
    metadata, completed_at
  ) values (
    'brand_onboarding', 'brand_onboarding', new.id::text,
    new.organization_id, new.reference, 'Brand company onboarding',
    queue_status, 'P0', 'Administrator', 'portal', new.monday_item_id,
    jsonb_build_object('onboardingStatus', new.status, 'revision', new.revision),
    case when queue_status = 'completed' then coalesce(new.approved_at, now()) else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    source_mode = excluded.source_mode,
    source_record_id = coalesce(excluded.source_record_id, portal_work_item.source_record_id),
    metadata = portal_work_item.metadata || excluded.metadata,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_brand_onboarding_work_item on public.portal_brand_onboarding;
create trigger portal_sync_brand_onboarding_work_item
after insert or update on public.portal_brand_onboarding
for each row execute function public.portal_sync_brand_onboarding_work_item();

alter table public.portal_order
  add column if not exists workflow_source text not null default 'portal'
    check (workflow_source in ('monday', 'parallel', 'portal')),
  add column if not exists fulfillment_priority text not null default 'P0'
    check (fulfillment_priority in ('P0', 'P1', 'P2', 'P3')),
  add column if not exists assigned_department text not null default 'Administrator',
  add column if not exists assigned_user uuid references auth.users(id) on delete set null,
  add column if not exists due_at timestamptz;

update public.portal_order
set workflow_source = case
  when monday_item_id is not null then 'monday'
  else 'portal'
end;

create or replace function public.portal_sync_order_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  queue_status := case
    when new.state = 'delivered' then 'completed'
    when new.state in ('declined', 'canceled') then 'cancelled'
    when new.state = 'exception' or new.release_hold then 'waiting'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, store_license, title, summary,
    status, priority, assigned_department, assigned_user, due_at, source_mode,
    source_record_id, metadata, created_by, updated_by, completed_at
  ) values (
    'store_orders', 'store_order', new.id::text, new.location_license,
    coalesce(new.order_number, new.portal_reference),
    new.organization || ' · ' || new.location_name, queue_status,
    new.fulfillment_priority, new.assigned_department, new.assigned_user,
    new.due_at, new.workflow_source, new.monday_item_id,
    jsonb_build_object('orderState', new.state, 'workflowState', new.workflow_state,
      'orderValueCents', new.order_value_cents, 'releaseHold', new.release_hold),
    new.submitted_by, new.submitted_by,
    case when queue_status = 'completed' then now() else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    priority = excluded.priority,
    assigned_department = excluded.assigned_department,
    assigned_user = excluded.assigned_user,
    due_at = excluded.due_at,
    source_mode = excluded.source_mode,
    source_record_id = coalesce(excluded.source_record_id, portal_work_item.source_record_id),
    metadata = portal_work_item.metadata || excluded.metadata,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_order_work_item on public.portal_order;
create trigger portal_sync_order_work_item
after insert or update on public.portal_order
for each row execute function public.portal_sync_order_work_item();

-- Seed queues from existing durable records without touching monday.com.
update public.portal_brand_purchase_order
set handoff_state = 'portal_native',
    updated_at = now()
where status <> 'draft'
  and handoff_state in ('not_configured', 'not_ready', 'pending');

update public.portal_brand_onboarding
set monday_handoff_state = 'portal_native',
    monday_handoff_error = null,
    updated_at = now()
where status = 'approved'
  and monday_handoff_state in ('not_ready', 'queued', 'reconciliation_required');

update public.portal_brand_onboarding
set updated_at = updated_at;

update public.portal_order
set updated_at = updated_at;

-- Recommended, reversible receiving-claim operating rule. It creates no
-- credit, refund, invoice, or accounting entry.
create table if not exists public.portal_receiving_claim_policy (
  id smallint primary key default 1 check (id = 1),
  policy_state text not null default 'active_recommended'
    check (policy_state in ('draft', 'active_recommended', 'active_approved', 'paused')),
  claim_window_days integer not null default 5 check (claim_window_days between 1 and 90),
  window_basis text not null default 'calendar_days'
    check (window_basis in ('calendar_days', 'business_days')),
  evidence_required_for text[] not null default array['damaged', 'wrong_item']::text[],
  initial_response_business_days integer not null default 2
    check (initial_response_business_days between 1 and 30),
  owner_department text not null default 'Administrator',
  creates_financial_record boolean not null default false check (creates_financial_record = false),
  decision_note text not null default
    'Recommended operational default pending executive confirmation; no accounting record is created automatically.',
  updated_by uuid references auth.users(id) on delete set null,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into public.portal_receiving_claim_policy (id)
values (1) on conflict (id) do nothing;
alter table public.portal_receiving_claim_policy enable row level security;
revoke all on table public.portal_receiving_claim_policy from public, anon, authenticated;
grant all on table public.portal_receiving_claim_policy to service_role;

-- Brand transactional templates use the same no-cost Resend boundary and
-- delivery evidence as existing Store and Internal messages.
alter table public.portal_notification_template
  drop constraint if exists portal_notification_template_audience_check;
alter table public.portal_notification_template
  add constraint portal_notification_template_audience_check
  check (audience in ('store', 'brand', 'internal'));
alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_audience_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_audience_check
  check (audience in ('store', 'brand', 'internal'));

insert into public.portal_notification_template (
  template_key, title, audience, category, mandatory, subject_template,
  text_template, allowed_variables, approval_state
) values
  ('brand_purchase_order_received', 'Brand purchase order received', 'brand', 'order', true,
   'Purchase order {{purchaseOrderNumber}} was received',
   'We received purchase order {{purchaseOrderNumber}} for {{brandName}}. Current status: Submitted. Sign in at {{portalUrl}} to follow review and fulfillment. This message does not create a QuickBooks transaction.',
   array['purchaseOrderNumber','brandName','portalUrl'], 'approved'),
  ('brand_purchase_order_state_changed', 'Brand purchase order status changed', 'brand', 'order', true,
   'Purchase order {{purchaseOrderNumber}} is now {{purchaseOrderState}}',
   'Purchase order {{purchaseOrderNumber}} for {{brandName}} is now {{purchaseOrderState}}. Sign in at {{portalUrl}} for the current timeline and approved notes.',
   array['purchaseOrderNumber','brandName','purchaseOrderState','portalUrl'], 'approved'),
  ('brand_purchase_order_internal', 'Brand purchase order needs review', 'internal', 'order', true,
   'Brand purchase order {{purchaseOrderNumber}} — {{brandName}}',
   '{{brandName}} submitted purchase order {{purchaseOrderNumber}}. Review the request type, products, quantities, needed-by date, agreements, and fulfillment gates in the Portal work queue.',
   array['purchaseOrderNumber','brandName'], 'approved')
on conflict (template_key) do update set
  title = excluded.title,
  audience = excluded.audience,
  category = excluded.category,
  mandatory = excluded.mandatory,
  subject_template = excluded.subject_template,
  text_template = excluded.text_template,
  allowed_variables = excluded.allowed_variables,
  approval_state = excluded.approval_state,
  version = public.portal_notification_template.version + 1,
  updated_at = now();

comment on table public.portal_workflow_control is
  'Administrator-controlled source mode for each staged monday.com exit. monday.com data is retained and never deleted by this control.';
comment on table public.portal_work_item is
  'Native internal operations queue for assignments, priorities, due dates, and source-labelled work.';
comment on table public.portal_work_item_event is
  'Append-only audit evidence for every native work-item state change.';
comment on table public.portal_receiving_claim_policy is
  'Reversible receiving-claim service rule. Claims never create a credit, refund, invoice, or payment automatically.';
