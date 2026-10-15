-- Durable, section-scoped SKU / NPI intake workflow.
-- Monday and Canix remain downstream systems; this record owns draft progress,
-- contributor scope, review decisions, and an immutable revision trail.

create table if not exists public.portal_sku_intake (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('SKU-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  brand_name text not null check (length(trim(brand_name)) between 1 and 200),
  product_name text not null check (length(trim(product_name)) between 1 and 300),
  status text not null default 'draft' check (status in (
    'draft', 'in_progress', 'in_review', 'approved', 'changes_requested', 'archived'
  )),
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_sku_intake_section (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.portal_sku_intake(id) on delete cascade,
  section_key text not null check (section_key in (
    'basics', 'formulation', 'ingredients', 'suppliers', 'allergens',
    'packaging', 'label', 'claims', 'marketing', 'notes'
  )),
  position smallint not null check (position between 1 and 10),
  title text not null,
  status text not null default 'not_started' check (status in (
    'not_started', 'draft', 'shared', 'in_progress', 'submitted',
    'approved', 'changes_requested', 'reopened'
  )),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  completion_percent smallint not null default 0 check (completion_percent between 0 and 100),
  revision integer not null default 0 check (revision >= 0),
  assigned_email text,
  review_note text,
  submitted_at timestamptz,
  approved_at timestamptz,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_id, section_key),
  unique (intake_id, position)
);

create table if not exists public.portal_sku_intake_section_invite (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.portal_sku_intake_section(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null,
  contributor_email text,
  active boolean not null default true,
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  access_count integer not null default 0 check (access_count >= 0)
);

create table if not exists public.portal_sku_intake_section_revision (
  id bigint generated always as identity primary key,
  section_id uuid not null references public.portal_sku_intake_section(id) on delete cascade,
  revision integer not null,
  action text not null check (action in (
    'saved', 'submitted', 'approved', 'changes_requested', 'reopened'
  )),
  data jsonb not null default '{}'::jsonb,
  actor_type text not null check (actor_type in ('internal', 'contributor')),
  actor_email text,
  note text,
  created_at timestamptz not null default now(),
  unique (section_id, revision)
);

create table if not exists public.portal_sku_intake_event (
  id bigint generated always as identity primary key,
  intake_id uuid not null references public.portal_sku_intake(id) on delete cascade,
  section_id uuid references public.portal_sku_intake_section(id) on delete cascade,
  action text not null,
  actor_type text not null check (actor_type in ('internal', 'contributor', 'system')),
  actor_email text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_sku_intake_document (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.portal_sku_intake_section(id) on delete cascade,
  field_key text not null,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null check (scan_state = 'clean'),
  scan_provider text not null,
  uploaded_by_type text not null check (uploaded_by_type in ('internal', 'contributor')),
  uploaded_by_email text,
  created_at timestamptz not null default now(),
  unique (section_id, field_key, sha256)
);

create index if not exists portal_sku_intake_status_idx
  on public.portal_sku_intake (status, updated_at desc);
create index if not exists portal_sku_intake_section_intake_idx
  on public.portal_sku_intake_section (intake_id, position);
create index if not exists portal_sku_intake_invite_section_idx
  on public.portal_sku_intake_section_invite (section_id, active, expires_at desc);
create index if not exists portal_sku_intake_event_intake_idx
  on public.portal_sku_intake_event (intake_id, created_at desc);
create index if not exists portal_sku_intake_document_section_idx
  on public.portal_sku_intake_document (section_id, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-sku-intake-documents', 'portal-sku-intake-documents', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_sku_intake enable row level security;
alter table public.portal_sku_intake_section enable row level security;
alter table public.portal_sku_intake_section_invite enable row level security;
alter table public.portal_sku_intake_section_revision enable row level security;
alter table public.portal_sku_intake_event enable row level security;
alter table public.portal_sku_intake_document enable row level security;

revoke all on table public.portal_sku_intake, public.portal_sku_intake_section,
  public.portal_sku_intake_section_invite, public.portal_sku_intake_section_revision,
  public.portal_sku_intake_event, public.portal_sku_intake_document
  from public, anon, authenticated;
grant all on table public.portal_sku_intake, public.portal_sku_intake_section,
  public.portal_sku_intake_section_invite, public.portal_sku_intake_section_revision,
  public.portal_sku_intake_event, public.portal_sku_intake_document to service_role;
grant usage, select on sequence public.portal_sku_intake_section_revision_id_seq,
  public.portal_sku_intake_event_id_seq to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;
alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check check (permission in (
    'inventory.read', 'inventory.sync', 'orders.manage', 'accounts.manage', 'pricing.manage',
    'catalog.manage', 'financials.read', 'economics.manage', 'cost_objects.manage',
    'quality.manage', 'lineage.read', 'users.manage', 'audit.read', 'readiness.read',
    'readiness.manage', 'notifications.manage', 'claims.manage', 'publications.manage',
    'sku_intake.read', 'sku_intake.manage'
  ));

insert into public.portal_role_permission (staff_role, permission) values
  ('administrator', 'sku_intake.read'), ('administrator', 'sku_intake.manage'),
  ('operations', 'sku_intake.read'), ('operations', 'sku_intake.manage'),
  ('sales', 'sku_intake.read'), ('sales', 'sku_intake.manage'),
  ('quality', 'sku_intake.read'), ('quality', 'sku_intake.manage'),
  ('viewer', 'sku_intake.read')
on conflict do nothing;

insert into public.portal_notification_template
  (template_key, title, audience, category, mandatory, subject_template, text_template, allowed_variables, approval_state)
values (
  'sku_section_assignment', 'SKU intake section assignment', 'store', 'account', true,
  'Complete {{sectionTitle}} for {{productName}}',
  'urbanXtracts assigned you the {{sectionTitle}} section for {{brandName}} — {{productName}} ({{reference}}). Save partial work as often as needed, then submit the section for review. This link opens only the assigned section and expires on {{expiresOn}}: {{sectionUrl}}',
  array['sectionTitle','productName','brandName','reference','expiresOn','sectionUrl'], 'approved'
)
on conflict (template_key) do update set
  title = excluded.title, audience = excluded.audience, category = excluded.category,
  mandatory = excluded.mandatory, subject_template = excluded.subject_template,
  text_template = excluded.text_template, allowed_variables = excluded.allowed_variables,
  approval_state = excluded.approval_state, version = public.portal_notification_template.version + 1,
  updated_at = now();

comment on table public.portal_sku_intake is
  'Master NPI record. Approval is derived from ten separately reviewed, versioned sections.';
comment on table public.portal_sku_intake_section_invite is
  'Revocable, expiring capability scoped to exactly one SKU intake section; raw tokens are never stored.';
comment on table public.portal_sku_intake_section_revision is
  'Immutable evidence snapshot for every submit, decision, and approved-section reopen.';
comment on table public.portal_sku_intake_document is
  'Private, digest-addressed SKU intake evidence retained only after a clean malware scan.';
