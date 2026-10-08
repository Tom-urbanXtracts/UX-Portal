-- Complete the isolated Test Brand demonstration with every required agreement
-- gate satisfied and a visible insurance example in the profile register.

insert into public.portal_brand_document (
  organization_id, category, title, document_date, expires_on, visibility,
  status, notes, object_path, original_name, content_type, size_bytes, sha256,
  scan_state, scan_provider, uploaded_by_email
)
select organization.id, 'insurance', 'Test Brand Insurance Certificate',
  date '2026-01-01', date '2027-12-31', 'brand_and_internal', 'current',
  'DEMO — synthetic insurance certificate for executive review; not legally valid.',
  'test-brand/profile/insurance/ea2ac5b331bc38a393f571e71338a9e39789df55c74f0fb7bdb521983bce8835.pdf',
  'test-brand-insurance.pdf', 'application/pdf', 2245,
  'ea2ac5b331bc38a393f571e71338a9e39789df55c74f0fb7bdb521983bce8835',
  'clean', 'generated-demo-artifact', 'demo-system@urbanxtracts.com'
from public.portal_organization as organization
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
on conflict (organization_id, category, sha256) do update set
  title = excluded.title, document_date = excluded.document_date,
  expires_on = excluded.expires_on, visibility = excluded.visibility,
  status = 'current', notes = excluded.notes, object_path = excluded.object_path,
  original_name = excluded.original_name, size_bytes = excluded.size_bytes,
  scan_state = 'clean', scan_provider = excluded.scan_provider,
  archived_at = null, updated_at = now();

with agreement_seed(requirement_code, agreement_type, reference, object_path,
  original_name, size_bytes, sha256) as (
  values
    ('nda', 'NDA', 'TEST-BRAND-NDA-2026',
      'test-brand/agreement/nda/8a33b5e85b313ca9d2d5a8823f0775a17dbc8b08a4d397ede6d203b1a8e45a8d.pdf',
      'test-brand-nda.pdf', 2241,
      '8a33b5e85b313ca9d2d5a8823f0775a17dbc8b08a4d397ede6d203b1a8e45a8d'),
    ('pricing', 'Pricing / Fee Schedule', 'TEST-BRAND-PRICING-2026',
      'test-brand/agreement/pricing/45fcbf1ed79dd9219a1b0316c088297d196ead8e99085cbc5d2917f8d9412e31.pdf',
      'test-brand-pricing-fee-schedule.pdf', 2237,
      '45fcbf1ed79dd9219a1b0316c088297d196ead8e99085cbc5d2917f8d9412e31')
)
insert into public.portal_brand_agreement (
  organization_id, requirement_code, agreement_type, reference, status,
  visibility, version_label, effective_on, expires_on, term_type,
  renewal_owner, renewal_notice_days, evidence_summary, document_reference,
  submitted_by_email, submitted_at, reviewed_by_email, reviewed_at,
  review_decision, published_at, terms_mode
)
select organization.id, seed.requirement_code, seed.agreement_type, seed.reference,
  'active', 'published', '1.0', date '2026-01-01', date '2027-12-31',
  'fixed_term', 'Operations', array[90, 60, 30, 0],
  'DEMO — synthetic executive-review agreement. Not a valid contract.',
  seed.object_path, 'demo-system@urbanxtracts.com', now(),
  'demo-system@urbanxtracts.com', now(), 'approved', now(), 'metadata_only'
from public.portal_organization as organization
cross join agreement_seed as seed
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
on conflict (organization_id, reference) do update set
  requirement_code = excluded.requirement_code, status = 'active',
  visibility = 'published', version_label = excluded.version_label,
  effective_on = excluded.effective_on, expires_on = excluded.expires_on,
  term_type = excluded.term_type, renewal_owner = excluded.renewal_owner,
  evidence_summary = excluded.evidence_summary,
  document_reference = excluded.document_reference,
  review_decision = 'approved', reviewed_by_email = excluded.reviewed_by_email,
  reviewed_at = now(), published_at = now(), updated_at = now();

with document_seed(reference, object_path, original_name, size_bytes, sha256) as (
  values
    ('TEST-BRAND-NDA-2026',
      'test-brand/agreement/nda/8a33b5e85b313ca9d2d5a8823f0775a17dbc8b08a4d397ede6d203b1a8e45a8d.pdf',
      'test-brand-nda.pdf', 2241,
      '8a33b5e85b313ca9d2d5a8823f0775a17dbc8b08a4d397ede6d203b1a8e45a8d'),
    ('TEST-BRAND-PRICING-2026',
      'test-brand/agreement/pricing/45fcbf1ed79dd9219a1b0316c088297d196ead8e99085cbc5d2917f8d9412e31.pdf',
      'test-brand-pricing-fee-schedule.pdf', 2237,
      '45fcbf1ed79dd9219a1b0316c088297d196ead8e99085cbc5d2917f8d9412e31')
)
insert into public.portal_brand_agreement_document (
  agreement_id, object_path, original_name, content_type, size_bytes, sha256,
  scan_state, scan_provider, uploaded_by_type, uploaded_by_email
)
select agreement.id, seed.object_path, seed.original_name, 'application/pdf',
  seed.size_bytes, seed.sha256, 'clean', 'generated-demo-artifact', 'internal',
  'demo-system@urbanxtracts.com'
from document_seed as seed
join public.portal_brand_agreement as agreement on agreement.reference = seed.reference
join public.portal_organization as organization on organization.id = agreement.organization_id
where organization.kind = 'brand' and organization.legal_name = 'Test Brand'
on conflict (agreement_id) do update set
  object_path = excluded.object_path, original_name = excluded.original_name,
  size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
  scan_state = 'clean', scan_provider = excluded.scan_provider;
