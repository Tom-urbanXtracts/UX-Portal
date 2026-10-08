-- Brand workspace refinement and isolated executive-demo tenant.
-- Test Brand intentionally has no Canix, QuickBooks, or Monday identifiers, so
-- no synthetic record can be handed to a live external system.

alter table public.portal_brand_document
  drop constraint if exists portal_brand_document_category_check;
alter table public.portal_brand_document
  add constraint portal_brand_document_category_check check (category in (
    'company', 'license', 'tax', 'insurance', 'quality', 'commercial',
    'operations', 'brand_logo', 'brand_guidelines', 'product_image',
    'packaging_artwork', 'lifestyle_image', 'sell_sheet', 'menu_asset',
    'social_asset', 'procedure', 'work_instruction', 'training', 'form', 'other'
  ));

update public.portal_brand_onboarding_section
set title = case section_key
  when 'company' then 'Company Profile'
  when 'contacts' then 'Contacts & Authorized Users'
  when 'billing' then 'Billing & Remittance'
  when 'qualified_vendor' then 'Qualification Information'
  when 'identifiers' then 'License & Operating Information'
  when 'documents' then 'Document Upload'
end,
updated_at = now()
where section_key in ('company', 'contacts', 'billing', 'qualified_vendor', 'identifiers', 'documents');

insert into public.portal_organization (kind, legal_name, display_name, status)
values ('brand', 'Test Brand', 'Test Brand', 'active')
on conflict (kind, legal_name) do update set
  display_name = excluded.display_name,
  status = 'active',
  updated_at = now();

insert into public.portal_brand_account (
  organization_id, scope_status, scope_note, updated_at
)
select id, 'pending',
  'DEMO TENANT — synthetic portal data only. No live Canix, QuickBooks, or Monday mapping.',
  now()
from public.portal_organization
where kind = 'brand' and legal_name = 'Test Brand'
on conflict (organization_id) do update set
  canix_brand_id = null,
  canix_brand_name = null,
  canix_owner_id = null,
  canix_owner_name = null,
  monday_account_item_id = null,
  quickbooks_entity_type = null,
  quickbooks_customer_id = null,
  quickbooks_vendor_id = null,
  scope_status = 'pending',
  scope_note = excluded.scope_note,
  updated_at = now();

insert into public.portal_brand_profile_detail (
  organization_id, classification, activation_state, legal_name, dba_name,
  website, primary_contact_name, primary_contact_email,
  operations_contact_email, finance_contact_email, quality_contact_email,
  agreement_state, internal_note, updated_at
)
select id, 'external_partner', 'active', 'Test Brand LLC', 'Test Brand',
  'https://example.invalid/test-brand', 'Morgan Demo', 'marketing@urbanxtract.com',
  'operations@example.invalid', 'finance@example.invalid', 'quality@example.invalid',
  'active', 'DEMO_TENANT — isolated synthetic data for executive review.', now()
from public.portal_organization
where kind = 'brand' and legal_name = 'Test Brand'
on conflict (organization_id) do update set
  activation_state = 'active',
  legal_name = excluded.legal_name,
  dba_name = excluded.dba_name,
  primary_contact_name = excluded.primary_contact_name,
  primary_contact_email = excluded.primary_contact_email,
  internal_note = excluded.internal_note,
  updated_at = now();

insert into public.portal_brand_contact (
  organization_id, contact_type, full_name, email, phone, active
)
select organization.id, contact.contact_type, contact.full_name, contact.email, contact.phone, true
from public.portal_organization as organization
cross join (values
  ('primary', 'Morgan Demo', 'marketing@urbanxtract.com', '(212) 555-0143'),
  ('operations', 'Casey Operations', 'operations@example.invalid', '(212) 555-0144'),
  ('finance', 'Taylor Finance', 'finance@example.invalid', '(212) 555-0145'),
  ('quality', 'Jordan Quality', 'quality@example.invalid', '(212) 555-0146')
) as contact(contact_type, full_name, email, phone)
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
  and not exists (
    select 1 from public.portal_brand_contact existing
    where existing.organization_id = organization.id
      and existing.contact_type = contact.contact_type
      and lower(existing.email) = lower(contact.email)
  );

insert into public.portal_brand_onboarding (organization_id, status, approved_by_email, approved_at)
select id, 'approved', 'demo-system@urbanxtracts.com', now()
from public.portal_organization
where kind = 'brand' and legal_name = 'Test Brand'
on conflict (organization_id) do update set
  status = 'approved',
  approved_by_email = 'demo-system@urbanxtracts.com',
  approved_at = now(),
  monday_handoff_state = 'not_ready',
  monday_handoff_error = 'DEMO TENANT — external handoff disabled.',
  updated_at = now();

with definitions(section_key, position, title, data) as (
  values
    ('company', 1, 'Company Profile', jsonb_build_object(
      'legal_name','Test Brand LLC','dba_name','Test Brand','entity_type','LLC',
      'website','https://example.invalid/test-brand','address_line_1','100 Demo Way',
      'city','New York','state','NY','postal_code','10001')),
    ('contacts', 2, 'Contacts & Authorized Users', jsonb_build_object(
      'primary_name','Morgan Demo','primary_email','marketing@urbanxtract.com',
      'primary_phone','(212) 555-0143','operations_contact','Casey Operations',
      'finance_contact','Taylor Finance','quality_contact','Jordan Quality',
      'authorized_signer','Morgan Demo','shipping_name','Casey Operations',
      'shipping_email','operations@example.invalid','shipping_phone','(212) 555-0144')),
    ('billing', 3, 'Billing & Remittance', jsonb_build_object(
      'billing_contact_name','Taylor Finance','billing_email','finance@example.invalid',
      'billing_address_line_1','100 Demo Way','billing_city','New York','billing_state','NY',
      'billing_postal_code','10001','ein','00-0000000','remittance_contact','Taylor Finance',
      'payment_terms_request','Net 30','billing_notes','DEMO — no real banking information.')),
    ('qualified_vendor', 4, 'Qualification Information', jsonb_build_object(
      'vendor_status','Previously qualified','quality_contact','Jordan Quality',
      'audit_status','Current','recall_policy_confirmed',true)),
    ('identifiers', 5, 'License & Operating Information', jsonb_build_object(
      'brand_license_number','DEMO-BRAND-0001','brand_license_expiration','2027-12-31',
      'ownership_code','TEST','operating_state','New York')),
    ('documents', 6, 'Document Upload', jsonb_build_object(
      'w9_confirmed',true,'insurance_confirmed',true,'license_confirmed',true,
      'attestation','DEMO documents are synthetic and not legally valid.'))
)
insert into public.portal_brand_onboarding_section (
  onboarding_id, section_key, position, title, status, data,
  completion_percent, revision, submitted_at, approved_at, updated_by_email
)
select onboarding.id, definition.section_key, definition.position,
  definition.title, 'approved', definition.data, 100, 1, now(), now(),
  'demo-system@urbanxtracts.com'
from public.portal_brand_onboarding as onboarding
join public.portal_organization as organization on organization.id = onboarding.organization_id
cross join definitions as definition
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
on conflict (onboarding_id, section_key) do update set
  title = excluded.title,
  status = 'approved',
  data = excluded.data,
  completion_percent = 100,
  approved_at = now(),
  updated_at = now();

insert into public.portal_brand_governance_policy (
  organization_id, approved_by_email, approved_at
)
select id, 'demo-system@urbanxtracts.com', now()
from public.portal_organization
where kind = 'brand' and legal_name = 'Test Brand'
on conflict (organization_id) do update set
  approved_by_email = excluded.approved_by_email,
  approved_at = excluded.approved_at,
  updated_at = now();

insert into public.portal_brand_financial_policy (
  organization_id, quickbooks_classification, identity_status, ar_visibility,
  statement_state, sales_dollars_state, settlement_state, banking_setup_state,
  reviewed_by_email, reviewed_at
)
select id, 'customer', 'verified', 'quickbooks_read_only', 'enabled', 'approved',
  'not_required', 'not_required', 'demo-system@urbanxtracts.com', now()
from public.portal_organization
where kind = 'brand' and legal_name = 'Test Brand'
on conflict (organization_id) do update set
  quickbooks_classification = 'customer', identity_status = 'verified',
  ar_visibility = 'quickbooks_read_only', statement_state = 'enabled',
  sales_dollars_state = 'approved', settlement_state = 'not_required',
  banking_setup_state = 'not_required', reviewed_by_email = excluded.reviewed_by_email,
  reviewed_at = excluded.reviewed_at, updated_at = now();

with requirements(requirement_code, agreement_name, applicability, condition_summary, gate_code, sort_order) as (
  values
    ('nda','NDA','required','Required before onboarding unless the MSA includes equivalent confidentiality terms.','onboarding',10),
    ('msa','Master Service Agreement','required','Required for every external Brand.','onboarding',20),
    ('manufacturing','Manufacturing / Processing Agreement','conditional','Required before production begins.','production',30),
    ('sales','Sales Agreement','conditional','Required before products are offered for sale.','sale',40),
    ('distribution','Distribution Agreement','conditional','Required before distribution begins.','distribution',50),
    ('quality','Quality Agreement','conditional','Required before production begins.','production',60),
    ('brand_ip','Brand / IP License','conditional','Required when trademark rights are not covered by the MSA.','brand_use',70),
    ('tolling','Tolling Agreement','not_required','Not applicable to this synthetic demo relationship.','toll',80),
    ('consignment','Consignment Agreement','not_required','Not applicable to this synthetic demo relationship.','consignment',90),
    ('revenue_share','Revenue Share Agreement','not_required','Not applicable to this synthetic demo relationship.','settlement',100),
    ('pricing','Pricing / Fee Schedule','required','Controlled commercial exhibit for the demo relationship.','pricing',110),
    ('ach','ACH / Payment Authorization','not_required','Electronic payment collection is not enabled.','payment',120)
)
insert into public.portal_brand_agreement_requirement (
  organization_id, requirement_code, agreement_name, applicability,
  condition_summary, gate_code, sort_order,
  decision_reason, decision_by_email, decision_at
)
select organization.id, requirement.requirement_code, requirement.agreement_name,
  requirement.applicability, requirement.condition_summary, requirement.gate_code,
  requirement.sort_order,
  case when requirement.applicability = 'not_required'
    then 'Not applicable to the isolated Test Brand demonstration relationship.' else null end,
  case when requirement.applicability = 'not_required'
    then 'demo-system@urbanxtracts.com' else null end,
  case when requirement.applicability = 'not_required' then now() else null end
from public.portal_organization as organization
cross join requirements as requirement
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
on conflict (organization_id, requirement_code) do update set
  agreement_name = excluded.agreement_name,
  applicability = excluded.applicability,
  condition_summary = excluded.condition_summary,
  gate_code = excluded.gate_code,
  sort_order = excluded.sort_order,
  decision_reason = excluded.decision_reason,
  decision_by_email = excluded.decision_by_email,
  decision_at = excluded.decision_at,
  updated_at = now();

do $$
declare
  demo_org uuid;
  demo_po uuid;
begin
  select id into demo_org from public.portal_organization
  where kind = 'brand' and legal_name = 'Test Brand';

  insert into public.portal_brand_purchase_order (
    organization_id, reference, request_type, status, requested_on, needed_by,
    notes, currency, total_amount, handoff_state, handoff_error,
    created_by_email, submitted_at, acknowledged_at, shipping_destination,
    customer_reference, subtotal_cents
  ) values (
    demo_org, 'BPO-DEMO-1001', 'finished_goods_purchase', 'in_production',
    current_date - 18, current_date + 7,
    'DEMO — synthetic purchase order. No external handoff.', 'USD', 5040.00,
    'not_configured', 'DEMO TENANT — external handoff disabled.',
    'marketing@urbanxtract.com', now() - interval '18 days', now() - interval '17 days',
    'Test Brand Demo Warehouse', 'TB-PO-1001', 504000
  )
  on conflict (reference) do update set
    status = excluded.status, notes = excluded.notes, subtotal_cents = excluded.subtotal_cents,
    updated_at = now()
  returning id into demo_po;

  insert into public.portal_brand_purchase_order_line (
    purchase_order_id, line_number, canix_item_id, product_name, sku,
    requested_quantity, uom_code, order_basis, ordered_units,
    case_quantity, unit_price_cents, case_price_cents, line_total_cents
  ) values
    (demo_po, 1, 990001, 'Test Brand Citrus Gummies 10-Pack', 'TB-GUM-CIT-10', 240, 'UNIT', 'case', 240, 24, 1250, 30000, 300000),
    (demo_po, 2, 990002, 'Test Brand Live Resin Vape 1g', 'TB-VAPE-LR-1G', 96, 'UNIT', 'case', 96, 12, 2125, 25500, 204000)
  on conflict (purchase_order_id, line_number) do update set
    product_name = excluded.product_name, requested_quantity = excluded.requested_quantity,
    ordered_units = excluded.ordered_units, unit_price_cents = excluded.unit_price_cents,
    line_total_cents = excluded.line_total_cents;

  insert into public.portal_brand_distribution_milestone (
    organization_id, purchase_order_id, status, source_system, brand_visible,
    external_note, occurred_at
  ) values
    (demo_org, demo_po, 'ordered', 'Portal', true, 'Purchase order submitted.', now() - interval '18 days'),
    (demo_org, demo_po, 'approved', 'Portal', true, 'Approved for the demo production schedule.', now() - interval '17 days'),
    (demo_org, demo_po, 'production', 'Portal', true, 'Demo batch is in production.', now() - interval '10 days')
  on conflict do nothing;
end $$;

comment on table public.portal_brand_document is
  'Organization-scoped Brand document and marketing asset register. Files are private, malware-scanned, versioned by upload history, and archived rather than deleted.';
