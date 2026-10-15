-- Public, resumable Brand applications. Applicants authenticate with an
-- expiring email capability until Internal approval creates the real Brand
-- workspace and Brand Owner account. Browser clients never receive direct
-- table or Storage access; the Edge Function is the only public boundary.

create table public.portal_brand_application (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default (
    'BRAND-APP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  status text not null default 'draft' check (status in (
    'draft', 'in_progress', 'submitted', 'initial_review',
    'qualification_review', 'changes_requested', 'agreement_preparation',
    'approved', 'rejected', 'withdrawn'
  )),
  applicant_name text not null,
  applicant_email text not null,
  applicant_phone text,
  brand_name text not null,
  website text,
  email_verified_at timestamptz,
  resume_token_hash text not null unique check (resume_token_hash ~ '^[0-9a-f]{64}$'),
  resume_token_prefix text not null check (length(resume_token_prefix) = 8),
  resume_token_expires_at timestamptz not null,
  resume_token_last_used_at timestamptz,
  resume_email_last_sent_at timestamptz,
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_to_email text,
  organization_id uuid unique references public.portal_organization(id) on delete set null,
  revision integer not null default 0 check (revision >= 0),
  submitted_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index portal_brand_application_active_identity_idx
  on public.portal_brand_application (lower(applicant_email), lower(brand_name))
  where status not in ('approved', 'rejected', 'withdrawn');
create index portal_brand_application_queue_idx
  on public.portal_brand_application (status, submitted_at nulls last, updated_at desc);

create table public.portal_brand_application_section (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.portal_brand_application(id) on delete cascade,
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
  review_note text,
  submitted_at timestamptz,
  approved_at timestamptz,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, section_key),
  unique (application_id, position)
);

create table public.portal_brand_application_document (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.portal_brand_application_section(id) on delete cascade,
  field_key text not null,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null check (scan_state = 'clean'),
  scan_provider text not null,
  uploaded_by_email text,
  created_at timestamptz not null default now(),
  unique (section_id, field_key, sha256)
);

create table public.portal_brand_application_event (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.portal_brand_application(id) on delete cascade,
  section_id uuid references public.portal_brand_application_section(id) on delete cascade,
  action text not null,
  actor_scope text not null check (actor_scope in ('applicant', 'internal', 'system')),
  actor_email text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-brand-application-documents',
  'portal-brand-application-documents',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_brand_application enable row level security;
alter table public.portal_brand_application_section enable row level security;
alter table public.portal_brand_application_document enable row level security;
alter table public.portal_brand_application_event enable row level security;

revoke all on table
  public.portal_brand_application,
  public.portal_brand_application_section,
  public.portal_brand_application_document,
  public.portal_brand_application_event
from public, anon, authenticated;

grant all on table
  public.portal_brand_application,
  public.portal_brand_application_section,
  public.portal_brand_application_document,
  public.portal_brand_application_event
to service_role;
grant usage, select on sequence public.portal_brand_application_event_id_seq to service_role;

-- Reuse the existing free-tier email quota and durable notification outbox.
alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_event_type_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_event_type_check check (event_type in (
    'user_invitation', 'onboarding_submitted', 'onboarding_incomplete', 'license_expiry', 'store_ready',
    'kiosk_guide', 'order_guide', 'user_guide', 'order_state', 'invoice_notice', 'payment_recorded',
    'payment_receipt', 'receiving_claim_submitted', 'receiving_claim_updated', 'coa_amended',
    'recall_notice', 'inventory_sync_failed',
    'integration_failed', 'owner_approval_required', 'claim_status_changed', 'access_request_internal',
    'onboarding_review_internal', 'license_review_internal', 'order_delivery_failed',
    'quickbooks_sync_failed', 'pricing_review_required', 'order_approval_aging_internal',
    'daily_operations_digest', 'sku_section_assignment', 'brand_purchase_order_received',
    'brand_purchase_order_state_changed', 'brand_application_resume', 'brand_application_submitted'
  ));

insert into public.portal_notification_template (
  template_key, title, audience, category, mandatory, subject_template,
  text_template, allowed_variables, approval_state
) values
  (
    'brand_application_resume', 'Brand application secure link', 'brand', 'account', true,
    'Continue your urbanXtracts Brand application',
    'Hello {{applicantName}},\n\nUse this private link to continue the Brand application for {{brandName}} ({{reference}}): {{applicationUrl}}\n\nThe link expires on {{expiresOn}}. You can save each section and return later. Do not forward the link because it opens the application without a portal password.',
    array['applicantName','brandName','reference','applicationUrl','expiresOn'], 'approved'
  ),
  (
    'brand_application_submitted', 'Brand application submitted', 'brand', 'account', true,
    'We received the Brand application for {{brandName}}',
    'Hello {{applicantName}},\n\nWe received Brand application {{reference}} for {{brandName}}. urbanXtracts will review each section and contact you through the application if changes are needed. Submission does not yet create Portal access or approve a commercial relationship.',
    array['applicantName','brandName','reference'], 'approved'
  )
on conflict (template_key) do update set
  title = excluded.title,
  audience = excluded.audience,
  category = excluded.category,
  mandatory = excluded.mandatory,
  subject_template = excluded.subject_template,
  text_template = excluded.text_template,
  allowed_variables = excluded.allowed_variables,
  approval_state = 'approved',
  version = public.portal_notification_template.version + 1,
  updated_at = now();

comment on table public.portal_brand_application is
  'Prospective Brand application authenticated by a hashed, expiring email capability until approval creates the real Brand workspace.';
comment on table public.portal_brand_application_section is
  'Six separately saved and reviewed Company & Onboarding sections for prospective Brands.';
comment on table public.portal_brand_application_document is
  'Private application evidence stored only after malware scanning. Banking details, audit reports, and recall materials are outside this workflow.';
