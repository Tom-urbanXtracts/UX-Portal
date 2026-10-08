-- Durable, organization-scoped Brand company onboarding. Supabase owns draft
-- progress and review evidence; Monday receives an outbox only after every
-- section is approved. Files are private and may be retained only after the
-- configured malware scanner returns a verified clean verdict.

create table if not exists public.portal_brand_onboarding (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.portal_organization(id) on delete cascade,
  reference text not null unique default ('BRAND-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  status text not null default 'draft' check (status in (
    'draft', 'in_progress', 'in_review', 'changes_requested', 'approved', 'archived'
  )),
  revision integer not null default 0 check (revision >= 0),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  monday_item_id text,
  monday_board_id text,
  monday_handoff_state text not null default 'not_ready' check (monday_handoff_state in (
    'not_ready', 'queued', 'accepted', 'reconciliation_required'
  )),
  monday_handoff_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_brand_onboarding_section (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.portal_brand_onboarding(id) on delete cascade,
  section_key text not null check (section_key in (
    'company', 'contacts', 'billing', 'qualified_vendor', 'identifiers', 'documents'
  )),
  position smallint not null check (position between 1 and 6),
  title text not null,
  status text not null default 'not_started' check (status in (
    'not_started', 'draft', 'in_progress', 'submitted', 'approved', 'changes_requested', 'reopened'
  )),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  completion_percent smallint not null default 0 check (completion_percent between 0 and 100),
  revision integer not null default 0 check (revision >= 0),
  assigned_membership_id uuid references public.portal_organization_membership(id) on delete set null,
  review_note text,
  submitted_at timestamptz,
  approved_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onboarding_id, section_key),
  unique (onboarding_id, position)
);

create table if not exists public.portal_brand_onboarding_section_revision (
  id bigint generated always as identity primary key,
  section_id uuid not null references public.portal_brand_onboarding_section(id) on delete cascade,
  revision integer not null,
  action text not null check (action in (
    'saved', 'submitted', 'approved', 'changes_requested', 'reopened', 'assigned'
  )),
  data jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  note text,
  created_at timestamptz not null default now(),
  unique (section_id, revision)
);

create table if not exists public.portal_brand_onboarding_document (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.portal_brand_onboarding_section(id) on delete cascade,
  field_key text not null,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null check (scan_state = 'clean'),
  scan_provider text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_email text,
  created_at timestamptz not null default now(),
  unique (section_id, field_key, sha256)
);

create table if not exists public.portal_brand_onboarding_event (
  id bigint generated always as identity primary key,
  onboarding_id uuid not null references public.portal_brand_onboarding(id) on delete cascade,
  section_id uuid references public.portal_brand_onboarding_section(id) on delete cascade,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  actor_scope text not null check (actor_scope in ('brand', 'internal', 'system')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_brand_onboarding_outbox (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.portal_brand_onboarding(id) on delete cascade,
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  onboarding_revision integer not null check (onboarding_revision >= 0),
  event_type text not null default 'brand_onboarding_approved' check (event_type = 'brand_onboarding_approved'),
  state text not null default 'pending' check (state in ('pending', 'processing', 'accepted', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  monday_board_id text,
  monday_item_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onboarding_id, event_type, onboarding_revision)
);

create index if not exists portal_brand_onboarding_status_idx
  on public.portal_brand_onboarding (status, updated_at desc);
create index if not exists portal_brand_onboarding_section_parent_idx
  on public.portal_brand_onboarding_section (onboarding_id, position);
create index if not exists portal_brand_onboarding_event_parent_idx
  on public.portal_brand_onboarding_event (onboarding_id, created_at desc);
create index if not exists portal_brand_onboarding_outbox_retry_idx
  on public.portal_brand_onboarding_outbox (state, next_attempt_at)
  where state in ('pending', 'failed');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-brand-onboarding-documents', 'portal-brand-onboarding-documents', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_brand_onboarding enable row level security;
alter table public.portal_brand_onboarding_section enable row level security;
alter table public.portal_brand_onboarding_section_revision enable row level security;
alter table public.portal_brand_onboarding_document enable row level security;
alter table public.portal_brand_onboarding_event enable row level security;
alter table public.portal_brand_onboarding_outbox enable row level security;

-- Browser clients never access these workflow tables or files directly. The
-- Edge Function validates the current Auth user, organization membership, role
-- permission, section assignment, and revision before using service_role.
revoke all on table public.portal_brand_onboarding,
  public.portal_brand_onboarding_section,
  public.portal_brand_onboarding_section_revision,
  public.portal_brand_onboarding_document,
  public.portal_brand_onboarding_event,
  public.portal_brand_onboarding_outbox
  from public, anon, authenticated;

grant all on table public.portal_brand_onboarding,
  public.portal_brand_onboarding_section,
  public.portal_brand_onboarding_section_revision,
  public.portal_brand_onboarding_document,
  public.portal_brand_onboarding_event,
  public.portal_brand_onboarding_outbox
  to service_role;

grant usage, select on sequence
  public.portal_brand_onboarding_section_revision_id_seq,
  public.portal_brand_onboarding_event_id_seq
  to service_role;

comment on table public.portal_brand_onboarding is
  'One durable company-onboarding record per Brand organization. Monday handoff begins only after all sections are approved.';
comment on table public.portal_brand_onboarding_section is
  'Separately assigned, partially saved, reviewed, and versioned Brand onboarding section.';
comment on table public.portal_brand_onboarding_document is
  'Private Brand onboarding evidence stored only after a verified clean malware scan.';
comment on table public.portal_brand_onboarding_outbox is
  'Idempotent, retryable internal workflow handoff created after complete Brand onboarding approval.';
