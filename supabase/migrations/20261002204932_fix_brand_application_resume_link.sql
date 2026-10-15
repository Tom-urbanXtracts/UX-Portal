-- Postgres standard-conforming strings preserve backslash-n literally. The
-- original template therefore let email clients absorb the trailing "\n\nThe"
-- into the URL. Replace it with real newlines and bump the controlled version.
update public.portal_notification_template
set text_template = E'Hello {{applicantName}},\n\nUse this private link to continue the Brand application for {{brandName}} ({{reference}}):\n{{applicationUrl}}\n\nThe link expires on {{expiresOn}}. You can save each section and return later. Do not forward the link because it opens the application without a portal password.',
    version = version + 1,
    approval_state = 'approved',
    updated_at = now()
where template_key = 'brand_application_resume';

update public.portal_notification_template
set text_template = E'Hello {{applicantName}},\n\nWe received Brand application {{reference}} for {{brandName}}. urbanXtracts will review each section and contact you through the application if changes are needed. Submission does not yet create Portal access or approve a commercial relationship.',
    version = version + 1,
    approval_state = 'approved',
    updated_at = now()
where template_key = 'brand_application_submitted';
