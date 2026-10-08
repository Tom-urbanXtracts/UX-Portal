-- Promote the Brand document register into a controlled Quality & Operations
-- library, and add Portal-owned queues for Brand tasks and support. Monday is
-- not called by these workflows.

alter table public.portal_brand_document
  drop constraint if exists portal_brand_document_status_check;
alter table public.portal_brand_document
  drop constraint if exists portal_brand_document_check1;

update public.portal_brand_document
set status = 'approved'
where status = 'current';

alter table public.portal_brand_document
  add column if not exists version_number integer not null default 1
    check (version_number > 0),
  add column if not exists version_label text,
  add column if not exists effective_on date,
  add column if not exists review_on date,
  add column if not exists document_owner text,
  add column if not exists related_type text
    check (related_type is null or related_type in ('brand', 'product', 'vendor', 'component')),
  add column if not exists related_id text,
  add column if not exists supersedes_document_id uuid
    references public.portal_brand_document(id) on delete set null,
  add column if not exists review_note text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_by_email text,
  add column if not exists reviewed_at timestamptz;

alter table public.portal_brand_document
  add constraint portal_brand_document_status_check
  check (status in (
    'draft', 'submitted', 'changes_requested', 'approved', 'superseded', 'archived'
  ));

alter table public.portal_brand_document
  add constraint portal_brand_document_archive_state_check
  check (
    (status = 'archived' and archived_at is not null)
    or (status <> 'archived' and archived_at is null)
  );

alter table public.portal_brand_document
  drop constraint if exists portal_brand_document_category_check;

alter table public.portal_brand_document
  add constraint portal_brand_document_category_check
  check (category in (
    'company', 'license', 'tax', 'insurance', 'quality', 'commercial',
    'operations', 'brand_logo', 'brand_guidelines', 'product_image',
    'packaging_artwork', 'lifestyle_image', 'sell_sheet', 'menu_asset',
    'social_asset', 'procedure', 'work_instruction', 'training', 'form',
    'product_quality_plan', 'sop', 'manufacturing_batch_record',
    'master_manufacturing_plan', 'recall_procedure', 'audit_report',
    'gmp_haccp', 'iso_certification', 'sds_msds',
    'certificate_of_compliance', 'food_grade', 'allergen_statement',
    'origin_traceability', 'kosher_halal', 'packaging_certification',
    'hardware_safety', 'engineering_diagram', 'letter_of_guarantee',
    'other'
  ));

drop index if exists portal_brand_document_expiry_idx;
create index portal_brand_document_expiry_idx
  on public.portal_brand_document (organization_id, expires_on)
  where status = 'approved' and expires_on is not null;

create index if not exists portal_brand_document_quality_idx
  on public.portal_brand_document (
    organization_id, category, related_type, related_id, status,
    version_number desc, created_at desc
  );

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values
  ('brand_tasks', 'Brand tasks and requests', 'portal', 'retain_read_only',
   'The Portal owns organization-scoped Brand task visibility, due dates, comments, and evidence.'),
  ('brand_support', 'Brand portal support', 'portal', 'retain_read_only',
   'The Portal owns Brand-submitted portal issues and the Internal response history.'),
  ('brand_order_issues', 'Brand order issues', 'portal', 'retain_read_only',
   'The Portal owns purchase-order issue intake and links every issue to its source order.')
on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

-- Seed isolated Test Brand examples so the executive walkthrough shows the
-- difference between an assigned task, an order issue, and general support.
with test_brand as (
  select id from public.portal_organization
  where kind = 'brand' and legal_name = 'Test Brand'
  limit 1
), examples(workflow_key, target_type, target_id, title, summary, status, priority, due_at, metadata) as (
  values
    ('brand_tasks', 'brand_profile', 'test-brand-license-review',
     'Confirm license renewal contact',
     'Review the current license owner and confirm who should receive renewal reminders.',
     'in_progress', 'P2', now() + interval '14 days',
     jsonb_build_object('demo', true, 'category', 'onboarding')),
    ('brand_support', 'portal_issue', 'test-brand-portal-navigation',
     'Example portal navigation question',
     'Sample request showing how a Brand can ask for help without sending a separate email.',
     'waiting', 'P3', null,
     jsonb_build_object('demo', true, 'category', 'how_to'))
)
insert into public.portal_work_item (
  workflow_key, target_type, target_id, organization_id, title, summary,
  status, priority, assigned_department, due_at, source_mode, metadata
)
select examples.workflow_key, examples.target_type, examples.target_id,
  test_brand.id, examples.title, examples.summary, examples.status,
  examples.priority, 'Administrator', examples.due_at, 'portal', examples.metadata
from test_brand cross join examples
on conflict (workflow_key, target_type, target_id) do nothing;

comment on column public.portal_brand_document.status is
  'Controlled lifecycle: Brand uploads submit for review; Internal administrators approve, request changes, supersede, or archive.';
comment on column public.portal_brand_document.related_type is
  'Optional controlled link to the Brand, product, vendor, or component the document governs.';
