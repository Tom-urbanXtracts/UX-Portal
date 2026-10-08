-- Resend-backed notifications for shared Internal department requests.
-- Messages remain durable in the existing outbox and are subject to the
-- portal's provider quota, idempotency, template approval, and webhook controls.

alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_event_type_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_event_type_check check (event_type in (
    'user_invitation', 'onboarding_submitted', 'onboarding_incomplete', 'license_expiry', 'store_ready',
    'kiosk_guide', 'order_guide', 'user_guide', 'order_state', 'invoice_notice', 'payment_recorded',
    'payment_receipt', 'receiving_claim_submitted', 'receiving_claim_updated', 'coa_amended',
    'recall_notice', 'inventory_sync_failed', 'integration_failed', 'owner_approval_required',
    'claim_status_changed', 'access_request_internal', 'onboarding_review_internal',
    'license_review_internal', 'order_delivery_failed', 'quickbooks_sync_failed',
    'pricing_review_required', 'order_approval_aging_internal', 'daily_operations_digest',
    'sku_section_assignment', 'brand_purchase_order_received', 'brand_purchase_order_state_changed',
    'brand_application_resume', 'brand_application_submitted', 'department_request'
  ));

insert into public.portal_notification_template (
  template_key, title, audience, category, mandatory, default_channels,
  subject_template, text_template, allowed_variables, approval_state
) values
  ('department_request_received', 'Department request received', 'internal', 'account', true,
   array['in_portal','email']::text[],
   'Request {{requestReference}} was received',
   E'Hello {{recipientName}},\n\nWe received {{requestReference}} — {{requestTitle}} for {{departmentName}}. Priority: {{priority}}. Current status: Submitted.\n\nYou can follow the request in My Work: {{portalUrl}}',
   array['recipientName','requestReference','requestTitle','departmentName','priority','portalUrl'], 'approved'),
  ('department_request_updated', 'Department request updated', 'internal', 'account', true,
   array['in_portal','email']::text[],
   'Request {{requestReference}} is now {{requestStatus}}',
   E'Hello {{recipientName}},\n\n{{requestReference}} — {{requestTitle}} is now {{requestStatus}}.\n\nReview note: {{decisionNote}}\n\nOpen My Work for the current record and audit history: {{portalUrl}}',
   array['recipientName','requestReference','requestTitle','requestStatus','decisionNote','portalUrl'], 'approved')
on conflict (template_key) do update set
  title = excluded.title, audience = excluded.audience, category = excluded.category,
  mandatory = excluded.mandatory, default_channels = excluded.default_channels,
  subject_template = excluded.subject_template, text_template = excluded.text_template,
  allowed_variables = excluded.allowed_variables, approval_state = excluded.approval_state,
  version = public.portal_notification_template.version + 1, updated_at = now();
