-- Permit short-lived, server-generated onboarding archives in the same private
-- bucket as their source documents. Individual user uploads remain capped at
-- 10 MB and restricted to PDF/PNG/JPEG by the Edge Function.
update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/zip'
    ]::text[]
where id = 'portal-brand-onboarding-documents';
