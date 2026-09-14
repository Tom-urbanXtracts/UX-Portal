-- Operational expansion: durable release work, kiosk lifecycle controls,
-- automatic store-access reconciliation, catalog publishing readiness, and
-- policy-held onboarding communications.

alter table public.portal_kiosk_link
  add column if not exists expires_at timestamptz,
  add column if not exists rotated_from_id uuid references public.portal_kiosk_link(id) on delete set null,
  add column if not exists device_label text,
  add column if not exists allowed_categories text[] not null default '{}'::text[],
  add column if not exists allowed_item_ids bigint[] not null default '{}'::bigint[],
  add column if not exists access_count bigint not null default 0,
  add column if not exists last_rotated_at timestamptz;

create index if not exists portal_kiosk_link_expiry_idx
  on public.portal_kiosk_link (active, expires_at)
  where active = true;

create table if not exists public.portal_kiosk_access_event (
  id bigint generated always as identity primary key,
  kiosk_link_id uuid not null references public.portal_kiosk_link(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  product_count integer not null default 0,
  user_agent_family text
);
create index if not exists portal_kiosk_access_event_link_idx
  on public.portal_kiosk_access_event (kiosk_link_id, occurred_at desc);

create table if not exists public.portal_access_review (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references auth.users(id) on delete cascade,
  store_license text not null references public.portal_store(license_number) on update cascade on delete cascade,
  review_type text not null check (review_type in ('buyer_new_store', 'budtender_store_conflict')),
  state text not null default 'pending' check (state in ('pending', 'assigned', 'dismissed')),
  reason text not null,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, store_license, review_type)
);
create index if not exists portal_access_review_queue_idx
  on public.portal_access_review (state, created_at desc);

create or replace function public.portal_reconcile_store_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.active is not true or new.license_status <> 'active' then
    return new;
  end if;

  insert into public.portal_profile_store (profile_id, license_number)
  select profile.id, new.license_number
  from public.portal_profile as profile
  where profile.active = true
    and profile.role = 'owner'
    and profile.org = new.organization
  on conflict do nothing;

  insert into public.portal_access_review (
    profile_id, store_license, review_type, reason
  )
  select profile.id, new.license_number, 'buyer_new_store',
    'A qualified store was added to this retailer. Review whether this Buyer should receive it.'
  from public.portal_profile as profile
  where profile.active = true
    and profile.role = 'buyer'
    and profile.org = new.organization
    and not exists (
      select 1 from public.portal_profile_store as assignment
      where assignment.profile_id = profile.id
        and assignment.license_number = new.license_number
    )
  on conflict (profile_id, store_license, review_type) do update
    set state = case when portal_access_review.state = 'assigned' then 'assigned' else 'pending' end,
        reason = excluded.reason,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists portal_store_access_reconcile_trigger on public.portal_store;
create trigger portal_store_access_reconcile_trigger
after insert or update of active, license_status, organization on public.portal_store
for each row execute function public.portal_reconcile_store_access();

-- Backfill Owner assignments and Buyer reviews for qualified stores that
-- already existed before the trigger.
insert into public.portal_profile_store (profile_id, license_number)
select profile.id, store.license_number
from public.portal_profile as profile
join public.portal_store as store on store.organization = profile.org
where profile.active = true and profile.role = 'owner'
  and store.active = true and store.license_status = 'active'
on conflict do nothing;

insert into public.portal_access_review (
  profile_id, store_license, review_type, reason
)
select profile.id, store.license_number, 'buyer_new_store',
  'Review whether this Buyer should receive this qualified store.'
from public.portal_profile as profile
join public.portal_store as store on store.organization = profile.org
where profile.active = true and profile.role = 'buyer'
  and store.active = true and store.license_status = 'active'
  and not exists (
    select 1 from public.portal_profile_store as assignment
    where assignment.profile_id = profile.id
      and assignment.license_number = store.license_number
  )
on conflict do nothing;

create table if not exists public.portal_readiness_task (
  id uuid primary key default gen_random_uuid(),
  task_key text not null unique,
  title text not null,
  section text not null,
  description text not null,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed', 'controlled_hold')),
  owner_label text,
  due_on date,
  evidence_summary text,
  source_reference text,
  completion_check text not null default 'manual',
  sort_order integer not null default 100,
  active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_readiness_comment (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.portal_readiness_task(id) on delete cascade,
  body text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_readiness_evidence (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.portal_readiness_task(id) on delete cascade,
  label text not null,
  url text,
  note text,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default now(),
  check (url is not null or note is not null)
);

create index if not exists portal_readiness_task_status_idx
  on public.portal_readiness_task (status, sort_order, updated_at desc);
create index if not exists portal_readiness_comment_task_idx
  on public.portal_readiness_comment (task_id, created_at desc);
create index if not exists portal_readiness_evidence_task_idx
  on public.portal_readiness_evidence (task_id, created_at desc);

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label, source_reference, completion_check, sort_order)
values
  ('monday-direct-onboarding', 'Direct Monday onboarding delivery', 'Store onboarding', 'Create the Store Onboarding item without relying on the paused Make scenario; preserve idempotency and all existing fields.', 'in_progress', 'Operations / IT', 'Store Onboarding board 18428027063', 'monday_direct_onboarding', 10),
  ('onboarding-document-security', 'Private onboarding document workflow', 'Store onboarding', 'Use private storage, file-type and size validation, scan/quarantine state, audit evidence, and controlled Monday delivery.', 'controlled_hold', 'IT / Compliance', 'Scanner provider approval', 'onboarding_scanner', 20),
  ('kiosk-lifecycle', 'Managed kiosk links', 'Kiosk', 'Add expiration, rotation, device labels, usage, QR output, and optional category/product restrictions.', 'in_progress', 'Operations', 'Portal kiosk capability links', 'kiosk_lifecycle', 30),
  ('store-access-reconciliation', 'Automatic new-store access reconciliation', 'Users and access', 'Owners receive every qualified store; Buyers enter a review queue; Budtenders remain limited to one store.', 'in_progress', 'Administration', 'Retailer access policy', 'access_reconciliation', 40),
  ('durable-readiness-register', 'Durable release-readiness work register', 'Release readiness', 'Store owner, due date, evidence, comments, and status instead of keeping decisions only in page copy.', 'in_progress', 'Administration', 'Release readiness', 'readiness_register', 50),
  ('catalog-publishing-workflow', 'Catalog completeness and publication workflow', 'Catalog', 'Compute missing required content, support review/approval/scheduling, and prevent incomplete new records from being published.', 'in_progress', 'Sales / Operations', 'Monday Product Content board', 'catalog_workflow', 60),
  ('onboarding-communications', 'Onboarding communication outbox', 'Notifications', 'Prepare invitation, incomplete-profile, license-expiry, and ready-confirmation events. Delivery remains held until channel policy is approved.', 'controlled_hold', 'Sales / Compliance', 'Notification policy decision', 'notification_policy', 70)
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  owner_label = excluded.owner_label,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table public.portal_product_content
  add column if not exists workflow_state text not null default 'draft',
  add column if not exists completeness_score integer not null default 0,
  add column if not exists missing_fields text[] not null default '{}'::text[],
  add column if not exists validation_warnings text[] not null default '{}'::text[],
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists scheduled_publish_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_product_content'::regclass
      and conname = 'portal_product_content_workflow_state_check'
  ) then
    alter table public.portal_product_content add constraint portal_product_content_workflow_state_check
      check (workflow_state in ('draft', 'review', 'approved', 'scheduled', 'published', 'archived')) not valid;
  end if;
end
$$;
alter table public.portal_product_content validate constraint portal_product_content_workflow_state_check;

create or replace function public.portal_product_content_readiness()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  missing text[] := '{}'::text[];
  present integer := 0;
begin
  if nullif(trim(coalesce(new.short_description, '')), '') is null then missing := array_append(missing, 'short description'); else present := present + 1; end if;
  if coalesce(array_length(new.selling_points, 1), 0) = 0 then missing := array_append(missing, 'selling points'); else present := present + 1; end if;
  if nullif(trim(coalesce(new.ingredients, '')), '') is null then missing := array_append(missing, 'ingredients'); else present := present + 1; end if;
  if nullif(trim(coalesce(new.usage_information, '')), '') is null then missing := array_append(missing, 'usage information'); else present := present + 1; end if;
  if nullif(trim(coalesce(new.product_profile, '')), '') is null then missing := array_append(missing, 'product profile'); else present := present + 1; end if;
  new.missing_fields := missing;
  new.completeness_score := present * 20;
  new.validation_warnings := case
    when new.image_url is null then array['Product image is intentionally on hold until the approved scanner is active.']::text[]
    else '{}'::text[] end;
  if new.publication_state = 'published' and new.workflow_state not in ('published', 'archived') then
    new.workflow_state := 'published';
  elsif new.publication_state = 'archived' then
    new.workflow_state := 'archived';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_product_content_readiness_trigger on public.portal_product_content;
create trigger portal_product_content_readiness_trigger
before insert or update of short_description, selling_points, ingredients, usage_information, product_profile, image_url, publication_state
on public.portal_product_content
for each row execute function public.portal_product_content_readiness();

-- Recalculate existing rows without changing their public state.
update public.portal_product_content set short_description = short_description;

create table if not exists public.portal_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null check (event_type in (
    'user_invitation', 'onboarding_incomplete', 'license_expiry', 'store_ready'
  )),
  recipient_email text not null,
  retailer_account_id uuid references public.portal_retailer_account(id) on delete cascade,
  store_license text references public.portal_store(license_number) on update cascade on delete cascade,
  onboarding_request_id uuid references public.portal_onboarding_request(id) on delete cascade,
  state text not null default 'held_policy'
    check (state in ('held_policy', 'pending', 'sending', 'sent', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portal_notification_outbox_queue_idx
  on public.portal_notification_outbox (state, available_at, created_at);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-onboarding-documents',
  'portal-onboarding-documents',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.portal_onboarding_document (
  id uuid primary key default gen_random_uuid(),
  onboarding_request_id uuid not null references public.portal_onboarding_request(id) on delete cascade,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null default 'pending_provider'
    check (scan_state in ('pending_provider', 'clean', 'quarantined', 'failed')),
  transfer_state text not null default 'pending'
    check (transfer_state in ('pending', 'delivered', 'failed')),
  monday_item_id text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onboarding_request_id, sha256)
);
create index if not exists portal_onboarding_document_request_idx
  on public.portal_onboarding_document (onboarding_request_id, created_at desc);

create or replace function public.portal_queue_license_notifications()
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  inserted_count integer;
begin
  insert into public.portal_notification_outbox (
    event_key, event_type, recipient_email, retailer_account_id, store_license, payload
  )
  select
    'license-expiry:' || store.license_number || ':' || profile.id || ':' || store.license_expires_on,
    'license_expiry', auth_user.email, store.retailer_account_id, store.license_number,
    jsonb_build_object(
      'storeName', store.display_name,
      'organization', store.organization,
      'licenseExpiresOn', store.license_expires_on,
      'daysRemaining', store.license_expires_on - current_date
    )
  from public.portal_store as store
  join public.portal_profile as profile
    on profile.org = store.organization and profile.active = true and profile.role in ('owner', 'buyer')
  join auth.users as auth_user on auth_user.id = profile.id
  where store.active = true
    and store.license_expires_on between current_date and current_date + 30
  on conflict (event_key) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.portal_prepare_onboarding_communications()
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  inserted_count integer := 0;
  step_count integer := 0;
begin
  perform public.portal_queue_license_notifications();

  insert into public.portal_notification_outbox (
    event_key, event_type, recipient_email, retailer_account_id,
    onboarding_request_id, payload
  )
  select
    'onboarding-incomplete:' || request.id || ':' || to_char(current_date, 'IYYY-IW'),
    'onboarding_incomplete', lower(request.owner_email), request.retailer_account_id,
    request.id,
    jsonb_build_object(
      'legalEntity', request.legal_entity,
      'dba', request.dba,
      'stage', request.stage,
      'submittedAt', request.submitted_at
    )
  from public.portal_onboarding_request as request
  where request.owner_email is not null
    and request.stage not in ('ready', 'rejected', 'closed')
    and request.submitted_at < now() - interval '7 days'
  on conflict (event_key) do nothing;
  get diagnostics step_count = row_count;
  inserted_count := inserted_count + step_count;

  insert into public.portal_notification_outbox (
    event_key, event_type, recipient_email, retailer_account_id,
    onboarding_request_id, payload
  )
  select
    'store-ready:' || request.id || ':' || lower(request.owner_email),
    'store_ready', lower(request.owner_email), request.retailer_account_id,
    request.id,
    jsonb_build_object('legalEntity', request.legal_entity, 'dba', request.dba)
  from public.portal_onboarding_request as request
  where request.owner_email is not null and request.stage = 'ready'
  on conflict (event_key) do nothing;
  get diagnostics step_count = row_count;
  inserted_count := inserted_count + step_count;
  return inserted_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'portal-notification-preparation';
    perform cron.schedule(
      'portal-notification-preparation',
      '10 8 * * *',
      'select public.portal_prepare_onboarding_communications()'
    );
  end if;
end
$$;

alter table public.portal_kiosk_access_event enable row level security;
alter table public.portal_access_review enable row level security;
alter table public.portal_readiness_task enable row level security;
alter table public.portal_readiness_comment enable row level security;
alter table public.portal_readiness_evidence enable row level security;
alter table public.portal_notification_outbox enable row level security;
alter table public.portal_onboarding_document enable row level security;

revoke all on table public.portal_kiosk_access_event from public, anon, authenticated;
revoke all on table public.portal_access_review from public, anon, authenticated;
revoke all on table public.portal_readiness_task from public, anon, authenticated;
revoke all on table public.portal_readiness_comment from public, anon, authenticated;
revoke all on table public.portal_readiness_evidence from public, anon, authenticated;
revoke all on table public.portal_notification_outbox from public, anon, authenticated;
revoke all on table public.portal_onboarding_document from public, anon, authenticated;
grant all on table public.portal_kiosk_access_event to service_role;
grant all on table public.portal_access_review to service_role;
grant all on table public.portal_readiness_task to service_role;
grant all on table public.portal_readiness_comment to service_role;
grant all on table public.portal_readiness_evidence to service_role;
grant all on table public.portal_notification_outbox to service_role;
grant all on table public.portal_onboarding_document to service_role;
grant usage, select on sequence public.portal_kiosk_access_event_id_seq to service_role;
grant usage, select on sequence public.portal_readiness_comment_id_seq to service_role;
grant usage, select on sequence public.portal_readiness_evidence_id_seq to service_role;

revoke all on function public.portal_reconcile_store_access() from public, anon, authenticated;
revoke all on function public.portal_product_content_readiness() from public, anon, authenticated;
revoke all on function public.portal_queue_license_notifications() from public, anon, authenticated;
revoke all on function public.portal_prepare_onboarding_communications() from public, anon, authenticated;
grant execute on function public.portal_queue_license_notifications() to service_role;
grant execute on function public.portal_prepare_onboarding_communications() to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;
alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check check (permission in (
    'inventory.read', 'inventory.sync', 'orders.manage', 'accounts.manage',
    'pricing.manage', 'catalog.manage', 'financials.read', 'economics.manage',
    'cost_objects.manage', 'quality.manage', 'lineage.read', 'users.manage',
    'audit.read', 'readiness.read', 'readiness.manage'
  ));

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'readiness.manage'),
  ('operations', 'readiness.manage')
on conflict do nothing;

comment on table public.portal_access_review is
  'Administrative review queue created when a qualified store changes the possible scope of retailer users.';
comment on table public.portal_readiness_task is
  'Durable work register behind the Release Readiness screen; live diagnostics remain computed separately.';
comment on table public.portal_notification_outbox is
  'Prepared onboarding and license communications. New rows remain policy-held until an approved channel policy and mail transport are enabled.';
comment on table public.portal_onboarding_document is
  'Private onboarding document archive with hash, transfer audit, and fail-closed scanner state. Monday delivery is recorded separately from scanner approval.';
