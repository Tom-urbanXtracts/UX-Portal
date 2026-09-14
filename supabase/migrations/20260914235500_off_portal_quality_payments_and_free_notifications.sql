-- Keep public COA/recall publishing and payment collection outside UX OS.
-- Expand the approved message library and enforce Resend's free-plan ceilings
-- atomically so the portal cannot intentionally send beyond the no-cost tier.

alter table public.portal_notification_policy
  add column if not exists delivery_cost_mode text not null default 'free_tier_hard_cap'
    check (delivery_cost_mode = 'free_tier_hard_cap'),
  add column if not exists daily_email_limit integer not null default 100
    check (daily_email_limit between 1 and 100),
  add column if not exists monthly_email_limit integer not null default 3000
    check (monthly_email_limit between 1 and 3000);

update public.portal_notification_policy
set email_provider = 'resend',
    delivery_cost_mode = 'free_tier_hard_cap',
    daily_email_limit = least(daily_email_limit, 100),
    monthly_email_limit = least(monthly_email_limit, 3000),
    recall_copy_approved = false,
    payment_receipt_copy_approved = false,
    updated_at = now()
where id = 1;

update public.portal_notification_template
set approval_state = 'retired', updated_at = now()
where template_key in ('coa_amended', 'recall_notice', 'payment_receipt');

insert into public.portal_notification_template
  (template_key, title, audience, category, mandatory, subject_template, text_template, allowed_variables)
values
  ('owner_approval_required', 'Store Owner approval required', 'store', 'order', true,
   'Approval needed for order {{orderNumber}}',
   'Order {{orderNumber}} for {{storeName}} is waiting for Store Owner approval because it exceeds the store approval threshold. Current total: {{orderTotal}}. Sign in at {{portalUrl}} to approve or decline it. Inventory and pricing will be checked again before processing.',
   array['orderNumber','storeName','orderTotal','portalUrl']),
  ('claim_status_changed', 'Receiving claim status changed', 'store', 'claim', true,
   'Claim {{claimNumber}} is now {{claimState}}',
   'Receiving claim {{claimNumber}} for order {{orderNumber}} is now {{claimState}}. {{resolutionSummary}} Sign in at {{portalUrl}} for the current record. This notice does not itself create a credit, refund, replacement, or accounting change.',
   array['claimNumber','orderNumber','claimState','resolutionSummary','portalUrl']),
  ('payment_recorded', 'QuickBooks payment recorded', 'store', 'financial', false,
   'Payment recorded for invoice {{invoiceNumber}}',
   'The latest QuickBooks snapshot records a payment of {{amount}} against invoice {{invoiceNumber}}. Remaining balance: {{balance}}. Sign in at {{portalUrl}} to view the current financial history. Payments are collected outside the portal through the approved cannabis-banking process.',
   array['amount','invoiceNumber','balance','portalUrl']),
  ('access_request_internal', 'Workforce access request', 'internal', 'account', true,
   'Portal access request from {{recipientName}}',
   '{{recipientName}} requested {{requestedRole}} access. Review the request in Users and Access, confirm job responsibility and store scope, then approve or decline it. New workforce SSO users remain Viewer until an Administrator changes the role.',
   array['recipientName','requestedRole']),
  ('onboarding_review_internal', 'Onboarding review required', 'internal', 'account', true,
   'Review onboarding for {{storeName}}',
   '{{storeName}} has an onboarding request ready for review. Current stage: {{onboardingStage}}. Missing items: {{missingItems}}. Review the license evidence, QuickBooks identity, store details, and user scope in Store Onboarding.',
   array['storeName','onboardingStage','missingItems']),
  ('license_review_internal', 'License review due', 'internal', 'account', true,
   'License review due for {{storeName}}',
   '{{storeName}} license {{licenseNumber}} reaches its review date on {{licenseReviewDate}}. Verify the authoritative state record and retained evidence. Do not infer validity from the portal date alone.',
   array['storeName','licenseNumber','licenseReviewDate']),
  ('order_delivery_failed', 'Order delivery to Monday failed', 'internal', 'integration', true,
   'Order {{orderNumber}} needs delivery reconciliation',
   'The portal safely retained order {{orderNumber}}, but Monday delivery did not complete. Failure reference: {{failureReference}}. Reconcile the existing outbox record before retrying so a duplicate order is not created.',
   array['orderNumber','failureReference']),
  ('quickbooks_sync_failed', 'QuickBooks sync failed', 'internal', 'integration', true,
   'QuickBooks financial sync needs attention',
   'The latest QuickBooks sync did not complete. The portal continues to show the last successful snapshot and does not replace missing balances with zero. Failure reference: {{failureReference}}.',
   array['failureReference']),
  ('pricing_review_required', 'Pricing identity review required', 'internal', 'financial', true,
   'Wholesale price needs Canix identity review',
   '{{productName}} from {{sourceName}} could not be published because its Canix Item ID is not yet approved. Candidate detail: {{candidateDetail}}. Review the item identity before publishing a default price.',
   array['productName','sourceName','candidateDetail']),
  ('order_approval_aging_internal', 'Order approval aging', 'internal', 'order', false,
   'Order {{orderNumber}} is still awaiting Store Owner approval',
   'Order {{orderNumber}} for {{storeName}} has awaited Store Owner approval for {{ageHours}} hours. Contact the store through the approved sales process. The portal does not delegate approval automatically.',
   array['orderNumber','storeName','ageHours']),
  ('daily_operations_digest', 'Daily operations digest', 'internal', 'integration', false,
   'UX OS daily operations summary — {{reportDate}}',
   'Inventory exceptions: {{inventoryExceptions}}. Orders needing attention: {{orderExceptions}}. Onboarding reviews: {{onboardingReviews}}. Claims awaiting review: {{claimReviews}}. Integration failures: {{integrationFailures}}. Open UX OS for the source records; this message contains no credentials or raw provider responses.',
   array['reportDate','inventoryExceptions','orderExceptions','onboardingReviews','claimReviews','integrationFailures'])
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

alter table public.portal_notification_outbox
  drop constraint if exists portal_notification_outbox_event_type_check;
alter table public.portal_notification_outbox
  add constraint portal_notification_outbox_event_type_check check (event_type in (
    'user_invitation', 'onboarding_submitted', 'onboarding_incomplete', 'license_expiry', 'store_ready',
    'kiosk_guide', 'order_guide', 'user_guide', 'order_state', 'invoice_notice', 'payment_recorded',
    'receiving_claim_submitted', 'receiving_claim_updated', 'inventory_sync_failed', 'integration_failed',
    'owner_approval_required', 'claim_status_changed', 'access_request_internal',
    'onboarding_review_internal', 'license_review_internal', 'order_delivery_failed',
    'quickbooks_sync_failed', 'pricing_review_required', 'order_approval_aging_internal',
    'daily_operations_digest'
  ));

create or replace function public.portal_claim_resend_free_quota(p_outbox_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_limit_value integer;
  monthly_limit_value integer;
  daily_used bigint;
  monthly_used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('portal-resend-free-tier', 0));

  select daily_email_limit, monthly_email_limit
  into daily_limit_value, monthly_limit_value
  from public.portal_notification_policy
  where id = 1;

  if daily_limit_value is null or monthly_limit_value is null then
    return 'policy_missing';
  end if;

  select count(*) into daily_used
  from public.portal_notification_outbox
  where channel = 'email'
    and state in ('sending', 'sent', 'delivered')
    and coalesce(sent_at, updated_at) >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  select count(*) into monthly_used
  from public.portal_notification_outbox
  where channel = 'email'
    and state in ('sending', 'sent', 'delivered')
    and coalesce(sent_at, updated_at) >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';

  if daily_used >= daily_limit_value then
    update public.portal_notification_outbox
    set state = 'held_provider',
        last_error = 'Free email daily limit reached; message held for review.',
        updated_at = now()
    where id = p_outbox_id and state = 'pending';
    return 'daily_limit';
  end if;

  if monthly_used >= monthly_limit_value then
    update public.portal_notification_outbox
    set state = 'held_provider',
        last_error = 'Free email monthly limit reached; message held for review.',
        updated_at = now()
    where id = p_outbox_id and state = 'pending';
    return 'monthly_limit';
  end if;

  update public.portal_notification_outbox
  set state = 'sending',
      attempt_count = attempt_count + 1,
      updated_at = now(),
      last_error = null
  where id = p_outbox_id and state = 'pending';

  if not found then return 'not_pending'; end if;
  return 'claimed';
end;
$$;

revoke all on function public.portal_claim_resend_free_quota(uuid) from public, anon, authenticated;
grant execute on function public.portal_claim_resend_free_quota(uuid) to service_role;

create or replace function public.portal_resend_free_quota_status()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'dailyUsed', count(*) filter (
      where channel = 'email'
        and state in ('sending', 'sent', 'delivered')
        and coalesce(sent_at, updated_at) >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    ),
    'monthlyUsed', count(*) filter (
      where channel = 'email'
        and state in ('sending', 'sent', 'delivered')
        and coalesce(sent_at, updated_at) >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
    )
  )
  from public.portal_notification_outbox;
$$;

revoke all on function public.portal_resend_free_quota_status() from public, anon, authenticated;
grant execute on function public.portal_resend_free_quota_status() to service_role;

delete from public.portal_role_permission where permission = 'publications.manage';

update public.portal_readiness_task
set active = false,
    status = 'completed',
    evidence_summary = 'Removed from UX OS by business decision on 14 Sep 2026. Public COA/recall publication remains off-portal.',
    updated_at = now()
where task_key = 'public-coa-recall';

update public.portal_readiness_task
set active = false,
    status = 'completed',
    evidence_summary = 'Removed from UX OS by business decision on 14 Sep 2026. The portal displays QuickBooks payment history but does not collect payments.',
    updated_at = now()
where task_key = 'payment-collection';

update public.portal_readiness_task
set title = 'No-cost transactional notifications',
    description = 'Use approved internal/store templates, a durable idempotent outbox, signed delivery evidence, and atomic hard caps at the Resend free-plan ceilings.',
    status = 'in_progress',
    evidence_summary = 'Template library and atomic 100/day and 3,000/month hard caps are deployed. Production sending remains held until updates.urbanxtracts.com and the Resend webhook are verified.',
    source_reference = 'portal-notifications and updates.urbanxtracts.com',
    completion_check = 'free_sender_domain_and_delivery_acceptance',
    updated_at = now()
where task_key = 'onboarding-communications';
