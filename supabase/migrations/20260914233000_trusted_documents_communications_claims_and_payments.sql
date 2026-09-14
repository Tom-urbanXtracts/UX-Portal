-- Controlled document, communication, claims, publication, and payment
-- foundations. External providers remain fail-closed until their server-only
-- credentials and release flags are configured.

alter table public.portal_asset
  add column if not exists scan_state text not null default 'pending_provider',
  add column if not exists scanner_provider text,
  add column if not exists scanned_at timestamptz,
  add column if not exists sha256 text;

alter table public.portal_asset
  drop constraint if exists portal_asset_scan_state_check;
alter table public.portal_asset
  add constraint portal_asset_scan_state_check check (
    scan_state in ('pending_provider', 'clean', 'quarantined', 'failed')
  );
alter table public.portal_asset
  drop constraint if exists portal_asset_sha256_check;
alter table public.portal_asset
  add constraint portal_asset_sha256_check check (
    sha256 is null or sha256 ~ '^[0-9a-f]{64}$'
  );

alter table public.portal_onboarding_document
  add column if not exists scanner_provider text,
  add column if not exists scanned_at timestamptz;

create or replace function public.portal_review_asset(
  p_asset_id uuid,
  p_decision text,
  p_note text,
  p_reviewer_id uuid,
  p_reviewer_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.portal_asset%rowtype;
  changed public.portal_asset%rowtype;
begin
  if p_decision not in ('approve', 'quarantine') then
    raise exception 'Choose approve or quarantine';
  end if;
  select * into target from public.portal_asset where id = p_asset_id for update;
  if target.id is null then raise exception 'Asset not found'; end if;
  if target.state <> 'pending_review' then
    raise exception 'Only an uploaded asset awaiting review can be decided';
  end if;
  if target.scan_state <> 'clean' or target.scanned_at is null then
    raise exception 'A verified clean malware scan is required before review';
  end if;
  if target.created_by is not null and target.created_by = p_reviewer_id then
    raise exception 'A different authorized reviewer must decide this upload';
  end if;
  if p_decision = 'quarantine' and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'A quarantine reason is required';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(target.owner_type || ':' || target.owner_id::text || ':' || target.purpose, 0)
  );
  if p_decision = 'approve' then
    update public.portal_asset
    set state = 'archived', purge_after = now() + interval '365 days', updated_at = now()
    where owner_type = target.owner_type and owner_id = target.owner_id
      and purpose = target.purpose and state = 'active' and id <> target.id;
  end if;
  update public.portal_asset
  set state = case when p_decision = 'approve' then 'active' else 'quarantined' end,
      scan_state = case when p_decision = 'approve' then scan_state else 'quarantined' end,
      review_note = nullif(trim(coalesce(p_note, '')), ''),
      reviewed_by = p_reviewer_id, reviewed_by_email = p_reviewer_email,
      reviewed_at = now(),
      purge_after = case when p_decision = 'quarantine' then now() + interval '90 days' else null end,
      updated_at = now()
  where id = target.id returning * into changed;
  if p_decision = 'approve' and target.purpose = 'product_image' then
    update public.portal_product_content set image_asset_id = target.id, updated_at = now()
    where canix_item_id = target.owner_id;
    if not found then raise exception 'Create the Canix-linked product content row before approving its image'; end if;
  elsif p_decision = 'approve' and target.purpose = 'coa_document' then
    update public.canix_package_coa set portal_asset_id = target.id where package_id = target.owner_id;
    if not found then raise exception 'The Canix package does not have a current normalized COA row'; end if;
  end if;
  return to_jsonb(changed);
end;
$$;

create table if not exists public.portal_notification_template (
  template_key text primary key check (template_key ~ '^[a-z0-9_]{3,80}$'),
  title text not null,
  audience text not null check (audience in ('store', 'internal')),
  category text not null check (category in ('account', 'education', 'order', 'financial', 'quality', 'claim', 'integration')),
  mandatory boolean not null default false,
  default_channels text[] not null default array['in_portal', 'email']::text[],
  subject_template text not null,
  text_template text not null,
  allowed_variables text[] not null default '{}'::text[],
  approval_state text not null default 'approved' check (approval_state in ('draft', 'approved', 'retired')),
  version integer not null default 1 check (version > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (default_channels <@ array['in_portal', 'email']::text[])
);

create table if not exists public.portal_notification_policy (
  id smallint primary key default 1 check (id = 1),
  email_provider text not null default 'resend' check (email_provider = 'resend'),
  sender_name text not null default 'urbanXtracts Portal',
  sender_local_part text not null default 'portal',
  sending_subdomain text not null default 'updates.urbanxtracts.com',
  optional_guidance_email_enabled boolean not null default true,
  mandatory_notice_email_enabled boolean not null default true,
  recall_copy_approved boolean not null default false,
  payment_receipt_copy_approved boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.portal_notification_policy (id) values (1) on conflict (id) do nothing;

alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_event_type_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_event_type_check check (event_type in (
    'user_invitation', 'onboarding_submitted', 'onboarding_incomplete', 'license_expiry', 'store_ready',
    'kiosk_guide', 'order_guide', 'user_guide', 'order_state', 'invoice_notice', 'payment_receipt',
    'receiving_claim_submitted', 'receiving_claim_updated', 'coa_amended', 'recall_notice',
    'inventory_sync_failed', 'integration_failed'
  ));
alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_state_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_state_check check (state in (
    'held_policy', 'held_provider', 'pending', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'cancelled'
  ));
alter table public.portal_notification_outbox
  add column if not exists template_key text references public.portal_notification_template(template_key),
  add column if not exists audience text check (audience in ('store', 'internal')),
  add column if not exists channel text not null default 'email' check (channel in ('email', 'in_portal')),
  add column if not exists mandatory boolean not null default false,
  add column if not exists provider text,
  add column if not exists provider_message_id text,
  add column if not exists delivered_at timestamptz,
  add column if not exists template_version integer;

insert into public.portal_notification_template
  (template_key, title, audience, category, mandatory, subject_template, text_template, allowed_variables)
values
  ('store_welcome', 'Welcome and first steps', 'store', 'account', false,
   'Welcome to the urbanXtracts Portal — {{storeName}}',
   'Hello {{recipientName}},\n\nYour portal access for {{storeName}} is ready. Sign in at {{portalUrl}}. Start by confirming your store, delivery, and user details.\n\nNeed help? Reply to this message or contact your urbanXtracts representative.',
   array['recipientName','storeName','portalUrl']),
  ('kiosk_mode_guide', 'How to use Kiosk Mode', 'store', 'education', false,
   'How to use urbanXtracts Kiosk Mode',
   'Kiosk Mode gives budtenders product identity, product levels, COAs, terpenes, and approved profiles without showing pricing, inventory totals, or account financials.\n\n1. Open the store-specific Kiosk link.\n2. Scan or enter the full package tag.\n3. Confirm the product and lot.\n4. Open the COA and product details supplied by the portal.\n\nNever interpret a COA as a medical or effects claim. Kiosk access can be revoked by a Store Owner or urbanXtracts administrator.',
   '{}'::text[]),
  ('order_how_to', 'How to place an order', 'store', 'education', false,
   'How to place an order in the urbanXtracts Portal',
   '1. Select the store you are ordering for.\n2. Browse the catalog and add released or clearly marked pre-order products.\n3. Review current published pricing and the delivery details.\n4. Submit the order.\n5. If the store threshold requires Owner approval, the order remains Awaiting approval until an Owner acts.\n\nAfter submission, edits and cancellations go through your urbanXtracts sales representative. Store-visible states are Ordered, Approved, Processed, and Delivered.',
   '{}'::text[]),
  ('user_how_to', 'How to add and manage a user', 'store', 'education', false,
   'How to add a user to {{storeName}}',
   'Store Owners can invite users for their organization. Buyers receive only their assigned stores and Budtenders receive one store. For a role or store-assignment change, open Users, choose Manage, select the approved role and store scope, then save. Deactivated users lose access on every device. urbanXtracts Administrators control final role and scope changes.',
   array['storeName']),
  ('onboarding_submitted_store', 'Onboarding request received', 'store', 'account', true,
   'We received the onboarding request for {{storeName}}',
   'Your onboarding request {{requestReference}} was received. Documents are accepted only after malware scanning. We will show missing information and readiness status in the portal; this message does not mean the store is approved to order.',
   array['storeName','requestReference']),
  ('onboarding_submitted_internal', 'New store onboarding submitted', 'internal', 'account', true,
   'New store onboarding: {{storeName}}',
   '{{storeName}} submitted onboarding request {{requestReference}}. Review license, QuickBooks identity, documents, role assignments, and order readiness in Store Onboarding.',
   array['storeName','requestReference']),
  ('onboarding_needs_information', 'Onboarding needs information', 'store', 'account', true,
   'Action needed for {{storeName}} onboarding',
   'The onboarding request for {{storeName}} needs: {{missingItems}}. Sign in at {{portalUrl}} or reply to your urbanXtracts representative. Ordering remains unavailable until the required checks pass.',
   array['storeName','missingItems','portalUrl']),
  ('store_ready', 'Store ready to order', 'store', 'account', true,
   '{{storeName}} is ready to order',
   '{{storeName}} has passed portal onboarding and may now use the catalog and ordering workflow. Sign in at {{portalUrl}}. Availability and pricing are evaluated again when an order is submitted.',
   array['storeName','portalUrl']),
  ('license_expiry', 'License expiration notice', 'store', 'account', true,
   'License action for {{storeName}} — {{daysRemaining}} days remaining',
   'The portal record for {{storeName}} shows license {{licenseNumber}} expiring on {{licenseExpiresOn}}. A lapsed license pauses ordering for this store only. Submit renewal evidence through the approved document route.',
   array['storeName','daysRemaining','licenseNumber','licenseExpiresOn']),
  ('order_received', 'Order received', 'store', 'order', true,
   'Order {{orderNumber}} was received',
   'We received order {{orderNumber}} for {{storeName}} totaling {{orderTotal}}. Current status: Ordered. If Owner approval is required, the portal will show Awaiting approval until that step is complete.',
   array['orderNumber','storeName','orderTotal']),
  ('order_state_changed', 'Order status changed', 'store', 'order', true,
   'Order {{orderNumber}} is now {{orderState}}',
   'Order {{orderNumber}} for {{storeName}} is now {{orderState}}. Sign in at {{portalUrl}} for the current order history. The portal never estimates a status when the source workflow is unavailable.',
   array['orderNumber','storeName','orderState','portalUrl']),
  ('invoice_notice', 'Invoice notice', 'store', 'financial', false,
   'Invoice {{invoiceNumber}} — {{balance}} due {{dueDate}}',
   'Invoice {{invoiceNumber}} for {{storeName}} has an open balance of {{balance}} due {{dueDate}}. Sign in at {{portalUrl}} to view the latest QuickBooks snapshot. This notice does not change the invoice or place an order hold.',
   array['invoiceNumber','storeName','balance','dueDate','portalUrl']),
  ('payment_receipt', 'Payment receipt', 'store', 'financial', true,
   'Payment received for invoice {{invoiceNumber}}',
   'The portal received payment confirmation {{paymentReference}} for {{amount}} against invoice {{invoiceNumber}}. QuickBooks remains the accounting record; the portal will show the reconciled status after the next successful accounting sync.',
   array['paymentReference','amount','invoiceNumber']),
  ('claim_received', 'Receiving claim received', 'store', 'claim', true,
   'Receiving claim {{claimNumber}} was received',
   'We received claim {{claimNumber}} for order {{orderNumber}} at {{storeName}}. Type: {{claimType}}. Quantity: {{quantity}}. No credit, refund, or invoice change is created automatically.',
   array['claimNumber','orderNumber','storeName','claimType','quantity']),
  ('claim_internal', 'Receiving claim needs review', 'internal', 'claim', true,
   'Receiving claim {{claimNumber}} — {{storeName}}',
   '{{storeName}} submitted claim {{claimNumber}} for order {{orderNumber}}. Review the claimed line, quantity, narrative, scan-cleared evidence, and final disposition in the Claims queue.',
   array['claimNumber','storeName','orderNumber']),
  ('coa_amended', 'COA amended', 'store', 'quality', true,
   'A COA was amended for lot {{lotReference}}',
   'The COA for lot {{lotReference}} has a newer approved version. Open the portal to view the current document and acknowledge the notice. The portal reproduces source data and does not interpret the result.',
   array['lotReference']),
  ('recall_notice', 'Recall or withdrawal notice', 'store', 'quality', true,
   'IMPORTANT — product notice for lot {{lotReference}}',
   'Approved recall wording has not been configured. This template cannot be sent until Compliance approves the trigger, exact copy, affected audience, and acknowledgement rule.',
   array['lotReference']),
  ('inventory_sync_failed', 'Inventory sync failed', 'internal', 'integration', true,
   'Canix inventory sync needs attention',
   'The latest Canix inventory sync did not complete. The portal is showing the last successful snapshot. Failure reference: {{failureReference}}. Review the integration log and alert IT.',
   array['failureReference']),
  ('integration_failed', 'Integration failure', 'internal', 'integration', true,
   '{{integrationName}} needs attention',
   '{{integrationName}} did not complete {{operationName}}. Failure reference: {{failureReference}}. The portal preserved its last successful state and did not substitute missing values.',
   array['integrationName','operationName','failureReference'])
on conflict (template_key) do update set
  title = excluded.title, audience = excluded.audience, category = excluded.category,
  mandatory = excluded.mandatory, subject_template = excluded.subject_template,
  text_template = excluded.text_template, allowed_variables = excluded.allowed_variables,
  version = portal_notification_template.version + 1, updated_at = now();

create table if not exists public.portal_receiving_claim (
  id uuid primary key default gen_random_uuid(),
  claim_number text not null unique,
  order_id uuid not null references public.portal_order(id),
  order_line_id bigint not null references public.portal_order_line(id),
  organization text not null,
  store_license text not null references public.portal_store(license_number),
  claim_type text not null check (claim_type in ('short', 'damaged', 'wrong_item', 'refused', 'other')),
  quantity integer not null check (quantity > 0),
  narrative text not null check (length(trim(narrative)) between 3 and 2000),
  evidence_state text not null default 'not_provided' check (evidence_state in ('not_provided', 'pending_scan', 'clean', 'quarantined')),
  state text not null default 'submitted' check (state in ('submitted', 'under_review', 'approved', 'partially_approved', 'denied', 'resolved', 'withdrawn')),
  resolution_note text,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_by_email text,
  decided_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists portal_receiving_claim_scope_idx
  on public.portal_receiving_claim (organization, store_license, submitted_at desc);
create index if not exists portal_receiving_claim_queue_idx
  on public.portal_receiving_claim (state, submitted_at asc);

create sequence if not exists public.portal_receiving_claim_number_seq start 1000;
create or replace function public.portal_create_receiving_claim(
  p_order_id uuid, p_order_line_id bigint, p_organization text, p_store_license text,
  p_claim_type text, p_quantity integer, p_narrative text,
  p_submitted_by uuid, p_submitted_by_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_order public.portal_order%rowtype;
  target_line public.portal_order_line%rowtype;
  claimed integer;
  created public.portal_receiving_claim%rowtype;
begin
  select * into target_order from public.portal_order where id = p_order_id for share;
  if target_order.id is null or target_order.state <> 'delivered' then
    raise exception 'Claims may be raised only against a delivered order';
  end if;
  if target_order.organization <> p_organization or target_order.location_license <> p_store_license then
    raise exception 'The claim scope does not match the order';
  end if;
  select * into target_line from public.portal_order_line where id = p_order_line_id and order_id = p_order_id for update;
  if target_line.id is null then raise exception 'The order line was not found'; end if;
  select coalesce(sum(quantity), 0) into claimed from public.portal_receiving_claim
  where order_line_id = p_order_line_id and state not in ('denied', 'withdrawn');
  if p_quantity < 1 or claimed + p_quantity > target_line.quantity then
    raise exception 'Claimed quantity exceeds the remaining order-line quantity';
  end if;
  insert into public.portal_receiving_claim (
    claim_number, order_id, order_line_id, organization, store_license,
    claim_type, quantity, narrative, submitted_by, submitted_by_email
  ) values (
    'CLM-' || lpad(nextval('public.portal_receiving_claim_number_seq')::text, 6, '0'),
    p_order_id, p_order_line_id, p_organization, p_store_license,
    p_claim_type, p_quantity, trim(p_narrative), p_submitted_by, lower(p_submitted_by_email)
  ) returning * into created;
  return to_jsonb(created);
end;
$$;

create table if not exists public.portal_document_retention_rule (
  record_class text primary key,
  display_name text not null,
  regulatory_floor_years integer check (regulatory_floor_years is null or regulatory_floor_years > 0),
  proposed_retention_years integer check (proposed_retention_years is null or proposed_retention_years > 0),
  proposed_retention_days integer check (proposed_retention_days is null or proposed_retention_days > 0),
  start_event text not null,
  disposition text not null default 'review_then_delete' check (disposition in ('retain', 'review_then_delete', 'delete')),
  policy_state text not null default 'pending_approval' check (policy_state in ('pending_approval', 'approved', 'superseded')),
  legal_basis text,
  automatic_deletion_enabled boolean not null default false,
  notes text,
  updated_at timestamptz not null default now(),
  check (not automatic_deletion_enabled or policy_state = 'approved')
);
insert into public.portal_document_retention_rule
  (record_class, display_name, regulatory_floor_years, proposed_retention_years, proposed_retention_days, start_event, disposition, policy_state, legal_basis, notes)
values
  ('distribution_books_records_invoices', 'Distribution books, records, and invoices', 5, 5, null, 'record_created', 'review_then_delete', 'pending_approval', '9 NYCRR 123.8(a)(5)', 'Five-year regulatory floor; Finance/Compliance must approve the operational schedule.'),
  ('coa_and_lot_traceability', 'COAs and lot traceability', 5, 5, null, 'lot_closed', 'review_then_delete', 'pending_approval', 'Cannabis Law §78; applicable OCM recordkeeping rules', 'Preserve current, amended, and superseded evidence; no automatic destruction.'),
  ('recall_and_quality_notice', 'Recall, withdrawal, and quality notices', 5, 5, null, 'matter_closed', 'review_then_delete', 'pending_approval', 'Cannabis Law §78; applicable OCM recordkeeping rules', 'Preserve audience, exact copy, delivery, bounce, and acknowledgement evidence.'),
  ('receiving_claim', 'Receiving claims and evidence', null, 5, null, 'claim_resolved', 'review_then_delete', 'pending_approval', null, 'Business proposal only; Compliance and Finance must approve.'),
  ('store_onboarding', 'Store onboarding and license documents', null, 5, null, 'relationship_closed', 'review_then_delete', 'pending_approval', null, 'Business proposal only; regulatory and privacy review required.'),
  ('quarantined_upload', 'Quarantined uploads', null, null, 90, 'quarantined_at', 'delete', 'pending_approval', null, 'Existing technical target is 90 days. Existing purge dates remain unchanged until approved.'),
  ('superseded_catalog_asset', 'Superseded product images and portal COAs', null, null, 365, 'superseded_at', 'delete', 'pending_approval', null, 'Existing technical target is 365 days; active assets never receive a purge date.')
on conflict (record_class) do update set
  display_name = excluded.display_name, regulatory_floor_years = excluded.regulatory_floor_years,
  proposed_retention_years = excluded.proposed_retention_years, start_event = excluded.start_event,
  proposed_retention_days = excluded.proposed_retention_days,
  legal_basis = excluded.legal_basis, notes = excluded.notes, updated_at = now();

create table if not exists public.portal_legal_hold (
  id uuid primary key default gen_random_uuid(),
  record_class text not null references public.portal_document_retention_rule(record_class),
  record_id text,
  reason text not null,
  active boolean not null default true,
  placed_by uuid references auth.users(id) on delete set null,
  placed_at timestamptz not null default now(),
  released_by uuid references auth.users(id) on delete set null,
  released_at timestamptz,
  check ((active and released_at is null) or (not active and released_at is not null))
);

create table if not exists public.portal_publication (
  id uuid primary key default gen_random_uuid(),
  publication_type text not null check (publication_type in ('coa', 'recall')),
  source_package_id bigint,
  source_compliance_tag text,
  state text not null default 'draft' check (state in ('draft', 'approved', 'published', 'revoked')),
  public_code_hash text unique,
  display_payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  check (publication_type <> 'coa' or source_package_id is not null),
  check (state not in ('approved', 'published') or approved_by is not null),
  check (state <> 'published' or (public_code_hash is not null and published_by is not null))
);
create index if not exists portal_publication_source_idx
  on public.portal_publication (publication_type, source_package_id, state);

create table if not exists public.portal_payment_attempt (
  id uuid primary key default gen_random_uuid(),
  quickbooks_invoice_id text not null,
  quickbooks_customer_id text not null,
  organization text not null,
  store_license text references public.portal_store(license_number),
  invoice_number text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_session_id text unique,
  provider_checkout_url text,
  provider_payment_id text,
  state text not null default 'creating' check (state in ('creating', 'open', 'completed', 'expired', 'failed', 'cancelled', 'reconciled')),
  initiated_by uuid references auth.users(id) on delete set null,
  initiated_by_email text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  reconciled_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists portal_payment_attempt_one_open_invoice_idx
  on public.portal_payment_attempt (quickbooks_invoice_id)
  where state in ('creating', 'open');
create unique index if not exists portal_notification_provider_message_idx
  on public.portal_notification_outbox (provider, provider_message_id)
  where provider_message_id is not null;

alter table public.portal_notification_template enable row level security;
alter table public.portal_notification_policy enable row level security;
alter table public.portal_receiving_claim enable row level security;
alter table public.portal_document_retention_rule enable row level security;
alter table public.portal_legal_hold enable row level security;
alter table public.portal_publication enable row level security;
alter table public.portal_payment_attempt enable row level security;

revoke all on table public.portal_notification_template, public.portal_notification_policy,
  public.portal_receiving_claim, public.portal_document_retention_rule, public.portal_legal_hold,
  public.portal_publication, public.portal_payment_attempt from public, anon, authenticated;
grant all on table public.portal_notification_template, public.portal_notification_policy,
  public.portal_receiving_claim, public.portal_document_retention_rule, public.portal_legal_hold,
  public.portal_publication, public.portal_payment_attempt to service_role;
grant usage, select on sequence public.portal_receiving_claim_number_seq to service_role;
revoke all on function public.portal_create_receiving_claim(uuid, bigint, text, text, text, integer, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_create_receiving_claim(uuid, bigint, text, text, text, integer, text, uuid, text)
  to service_role;

alter table public.portal_role_permission drop constraint if exists portal_role_permission_permission_check;
alter table public.portal_role_permission add constraint portal_role_permission_permission_check check (permission in (
  'inventory.read', 'inventory.sync', 'orders.manage', 'accounts.manage', 'pricing.manage',
  'catalog.manage', 'financials.read', 'economics.manage', 'cost_objects.manage',
  'quality.manage', 'lineage.read', 'users.manage', 'audit.read', 'readiness.read',
  'readiness.manage', 'notifications.manage', 'claims.manage', 'publications.manage'
));
insert into public.portal_role_permission (staff_role, permission) values
  ('administrator', 'notifications.manage'), ('operations', 'notifications.manage'), ('sales', 'notifications.manage'),
  ('administrator', 'claims.manage'), ('operations', 'claims.manage'), ('sales', 'claims.manage'),
  ('administrator', 'publications.manage'), ('quality', 'publications.manage')
on conflict do nothing;

update public.portal_readiness_task set
  title = 'Malware-scanned onboarding documents',
  description = 'Require a digest-matched clean ClamAV result before private storage or Monday delivery; infected and unavailable results fail closed.',
  status = 'in_progress',
  owner_label = 'IT / Compliance',
  source_reference = 'services/document-scanner and portal-intake',
  completion_check = 'scanner_acceptance',
  updated_at = now()
where task_key = 'onboarding-document-security';

update public.portal_readiness_task set
  title = 'Transactional notification sender and templates',
  description = 'Use approved internal/store templates, a durable idempotent outbox, scoped recipients, and signed delivery/bounce evidence.',
  status = 'controlled_hold',
  owner_label = 'Sales / Compliance / IT',
  source_reference = 'portal-notifications and updates.urbanxtracts.com',
  completion_check = 'notification_provider_acceptance',
  updated_at = now()
where task_key = 'onboarding-communications';

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label, source_reference, completion_check, sort_order)
values
  ('receiving-claims', 'Retailer receiving claims', 'Orders', 'Record delivered-line shortages, damage, wrong items, refusals, and other issues without creating an automatic credit, refund, or accounting change.', 'completed', 'Operations', 'portal-claims', 'receiving_claims_foundation', 80),
  ('document-retention', 'Document retention and legal holds', 'Documents', 'Maintain a policy register with regulatory floors and legal holds. Automatic deletion remains off until every required policy decision is approved.', 'controlled_hold', 'Compliance / Finance / Operations', 'portal_document_retention_rule', 'retention_policy_approval', 90),
  ('public-coa-recall', 'Controlled public COA and recall publishing', 'Quality', 'Create durable drafts, require separate-user approval, and preserve opaque-code, non-enumeration, rate-limit, revocation, and recall-copy gates.', 'controlled_hold', 'CCO / Security', 'portal-publications', 'publication_policy_acceptance', 100),
  ('payment-collection', 'Hosted invoice payment collection', 'Financials', 'Bind Stripe-hosted Checkout to an exact open balance from the latest production QuickBooks snapshot without accepting card data or writing QuickBooks.', 'controlled_hold', 'Finance / Legal / Security', 'portal-payments', 'payment_provider_acceptance', 110)
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  status = case when public.portal_readiness_task.status = 'completed' then 'completed' else excluded.status end,
  owner_label = excluded.owner_label,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  updated_at = now();

comment on table public.portal_notification_template is
  'Versioned portal message library. Mandatory operational and quality notices cannot be muted; marketing is outside this system.';
comment on table public.portal_document_retention_rule is
  'Policy register only. Automatic deletion stays disabled until an approved rule and legal-hold-aware worker exist.';
comment on table public.portal_payment_attempt is
  'Hosted checkout attempts bound to a verified QuickBooks invoice snapshot. This table never marks or changes a QuickBooks invoice.';
