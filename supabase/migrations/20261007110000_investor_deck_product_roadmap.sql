-- Record the October 2026 investor-deck product direction as controlled work.
-- These rows are planning records only. They do not enable a capability or
-- support a claim that a pictured investor-deck workflow is live.

insert into public.portal_readiness_task
  (task_key, title, section, description, status, owner_label,
   source_reference, completion_check, sort_order)
values
  (
    'deck-capability-claims-audit',
    'Investor-deck capability and claims audit',
    'Product direction',
    'Compare every investor-deck statement and screenshot with production. Label each capability Live, In Development, Designed Intent, On Hold, or Out of Scope, and retain evidence for every Live claim.',
    'not_started',
    'Product / Administration / IT',
    'UrbanXtracts investor overview, October 2026',
    'deck_capability_claims_audit',
    200
  ),
  (
    'role-specific-home-pages',
    'Role-specific Internal and Brand home pages',
    'Workspace experience',
    'Give Internal and Brand users action-oriented home pages built around their authorized work. Store work remains held until the Store strategy is reactivated.',
    'not_started',
    'Product / Operations / IT',
    'Investor-deck three-sided operating model',
    'role_specific_home_pages',
    210
  ),
  (
    'internal-exception-command-center',
    'Internal exception command center',
    'Internal workspace',
    'Surface orders, onboarding reviews, catalog blocks, expiring records, integration failures, receivables, inventory risk, and reported issues with a direct resolution path.',
    'not_started',
    'Operations / Administration / IT',
    'Investor-deck manage-by-exception model',
    'internal_exception_command_center',
    220
  ),
  (
    'connected-metric-source-freshness',
    'Source and freshness labels for connected metrics',
    'Data controls',
    'Show the source system, last successful update, stale state, and unavailable state beside every connected inventory, financial, order, and performance metric.',
    'not_started',
    'Data / IT',
    'Canix, QuickBooks, and Portal authority boundaries',
    'connected_metric_source_freshness',
    230
  ),
  (
    'brand-performance-home',
    'Brand performance and action home',
    'Brand workspace',
    'Present approved Brand-scoped orders, units or cases, product trends, open purchase orders, inventory status, receivables, expiring items, and required actions.',
    'not_started',
    'Sales Operations / Finance / Data',
    'Investor-deck Brand growth model',
    'brand_performance_home',
    240
  ),
  (
    'metric-glossary-reporting-policy',
    'Metric glossary and reporting policy',
    'Reporting',
    'Define sales, revenue, outstanding, approved sale, reorder interval, inventory pressure, and opportunity with one approved meaning and source for each.',
    'not_started',
    'Finance / Sales Operations / Data',
    'Investor-deck commerce and connected-data claims',
    'metric_glossary_reporting_policy',
    250
  ),
  (
    'brand-account-opportunity-model',
    'Brand account opportunity model',
    'Brand workspace',
    'Use approved portal order history to identify reorder cadence, assortment gaps, inactive products, and account opportunities without claiming retailer POS sell-through.',
    'controlled_hold',
    'Sales Operations / Data / Legal',
    'Investor-deck Brand growth model',
    'brand_account_opportunity_model',
    260
  ),
  (
    'role-specific-visual-system',
    'Role-specific visual and interaction system',
    'Product experience',
    'Apply the deck visual direction to dashboards and commerce surfaces while retaining accessible light forms, tables, and review pages.',
    'not_started',
    'Product / Design / Accessibility',
    'UrbanXtracts investor overview visual system',
    'role_specific_visual_system',
    270
  ),
  (
    'retailer-buying-desk',
    'Retailer buying desk',
    'Store workspace',
    'When Store work resumes, provide a catalog, saved lists, reorder actions, cart, order history, billing visibility, media, and role-scoped multi-location purchasing.',
    'controlled_hold',
    'Sales / Operations / Product',
    'Investor-deck retailer operating experience',
    'retailer_buying_desk',
    280
  ),
  (
    'promotions-commercial-offers',
    'Promotions and commercial offers',
    'Commerce',
    'Support approved promotions and eligibility without silently overriding contract, store, retailer, or default pricing.',
    'controlled_hold',
    'Sales / Finance / Operations',
    'Investor-deck retailer buying desk',
    'promotions_commercial_offers',
    290
  ),
  (
    'supply-production-planning',
    'Internal supply and production planning',
    'Operations',
    'Connect demand requirements, Brand purchase orders, recipes or BOMs, materials, reservations, SOPs, and production milestones in an Internal workspace.',
    'controlled_hold',
    'Operations / Production / Quality / Data',
    'Investor-deck production operating system',
    'supply_production_planning',
    300
  ),
  (
    'decision-support-forecasts',
    'Decision-support forecasts',
    'Connected data',
    'Add reorder-risk, inventory-pressure, cash-collection, assortment-gap, and production-demand signals only after their inputs, owners, explanations, and confidence rules are approved.',
    'controlled_hold',
    'Finance / Operations / Sales Operations / Data',
    'Investor-deck connected-data advantage',
    'decision_support_forecasts',
    310
  ),
  (
    'ai-buying-assistant',
    'Constrained AI buying assistant',
    'Store workspace',
    'Consider a constrained assistant only after the catalog, permissions, recommendations, audit controls, privacy boundary, and cost limit are reliable and approved.',
    'controlled_hold',
    'Product / Security / Legal / Sales',
    'Investor-deck retailer operating experience',
    'ai_buying_assistant',
    320
  )
on conflict (task_key) do update set
  title = excluded.title,
  section = excluded.section,
  description = excluded.description,
  owner_label = excluded.owner_label,
  source_reference = excluded.source_reference,
  completion_check = excluded.completion_check,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();
