-- Close the onboarding scanner task after production deployment and
-- acceptance. Product-image and portal-managed COA uploads remain governed by
-- the separate PORTAL_ASSET_UPLOADS_ENABLED release flag.

update public.portal_readiness_task
set status = 'completed',
    evidence_summary = 'Production Cloud Run ClamAV service is connected through Supabase-only secrets. Health, clean-file, EICAR rejection, invalid-credential, digest-mismatch, and oversized-file acceptance passed on 14 Sep 2026.',
    source_reference = 'Cloud Run ux-portal-document-scanner and Supabase content-scanner integration',
    completion_check = 'scanner_acceptance_passed',
    updated_at = now()
where task_key = 'onboarding-document-security';

insert into public.portal_readiness_evidence (task_id, label, note)
select task.id,
       'Production scanner acceptance — 14 Sep 2026',
       'Cloud Run revision received 100% of traffic with a dedicated service account and Secret Manager credential. Acceptance results: health 200, clean 200, EICAR 422, invalid credential 401, digest mismatch 409, and oversized upload 413. Product-asset uploads remain disabled by their separate release flag.'
from public.portal_readiness_task as task
where task.task_key = 'onboarding-document-security'
  and not exists (
    select 1
    from public.portal_readiness_evidence as evidence
    where evidence.task_id = task.id
      and evidence.label = 'Production scanner acceptance — 14 Sep 2026'
  );
