-- Close the reorder-basis deferral by publishing both source-labelled signals
-- from portal order history instead of selecting an unsupported proxy.

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label,
   evidence_summary, source_reference, completion_check, sort_order)
values
  (
    'store-reorder-signals',
    'Source-labelled reorder signals',
    'Store performance',
    'Show both the average interval between portal orders and days since the latest portal order for each store, without inferring retailer POS sell-through.',
    'completed',
    'Sales Operations',
    'The store comparison now presents both portal-order-history measures side by side. Insufficient history remains explicit, and retail POS sell-through remains Not connected.',
    'Portal order history',
    'store_reorder_signals',
    66
  )
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  status = 'completed',
  owner_label = excluded.owner_label,
  evidence_summary = excluded.evidence_summary,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();

