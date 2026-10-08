-- Record the Brand-order follow-up workstreams that were deliberately placed
-- on hold on 1 October 2026. These controls are visible in the protected
-- Administrator Work queues page and do not disable the already-released,
-- fail-closed catalog and purchase-order capabilities.

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values
  (
    'brand_catalog_readiness',
    'Brand catalog data readiness',
    'hold',
    'retain_read_only',
    'On hold. Products remain visible under Needs setup and cannot be ordered until Canix identity, order unit, approved units per case when applicable, and an approved wholesale price are resolved.'
  ),
  (
    'brand_purchase_order_acceptance',
    'Brand purchase-order production acceptance',
    'hold',
    'retain_read_only',
    'On hold. Resume the end-to-end draft, multi-line submission, Internal approval, fulfillment, receipt, exception, and completion test after at least one catalog item is orderable.'
  ),
  (
    'brand_order_notification_expansion',
    'Brand order notification expansion',
    'hold',
    'retain_read_only',
    'On hold. Existing controlled submission and status notices remain available; new mandatory recipients, delay alerts, escalation timing, and additional channels are not enabled.'
  ),
  (
    'brand_reporting_expansion',
    'Brand reporting expansion',
    'hold',
    'retain_read_only',
    'On hold. Do not publish new Brand sales figures, downloads, or reporting dimensions until Finance and Sales Operations approve the figure definition, privacy boundary, and export policy.'
  )
on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();
