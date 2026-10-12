-- Promote the existing catalog candidates into the durable Portal SKU master.
-- Catalog publication remains a separate approval gate: this migration only
-- establishes product identity, classification, and source-item matching.

create temporary table portal_catalog_sku_candidates on commit drop as
select
  content.canix_item_id,
  btrim(item.name) as product_name,
  coalesce(
    nullif(btrim(item.product_brand_name), ''),
    nullif(btrim(item.brand_name), ''),
    'Brand not recorded'
  ) as brand_name,
  nullif(btrim(item.sku), '') as external_sku
from public.portal_product_content content
join public.canix_item_current item
  on item.item_id = content.canix_item_id
where item.quantity_type = 'CountBased'
  and coalesce(item.item_category_name, '') not in (
    'Bulk', 'Biomass', 'Seeds', 'Seed', 'Plant Material'
  )
  and lower(item.name) !~
    '(bulk|biomass|seed|plant material|work in progress|wip|formulation|filling|packaging)';

-- Promote an existing exact product-and-Brand record rather than creating a
-- duplicate (currently this preserves the reviewed Wana intake record).
update public.portal_sku_intake sku
set external_sku = coalesce(sku.external_sku, candidate.external_sku),
    inventory_class = 'finished_product',
    master_status = 'active',
    sellable = true,
    master_note = concat(
      'Activated from the existing Portal catalog candidate linked to Canix Item ',
      candidate.canix_item_id,
      '. Catalog publication remains separately gated.'
    ),
    updated_at = now()
from portal_catalog_sku_candidates candidate
where lower(btrim(sku.product_name)) = lower(candidate.product_name)
  and lower(btrim(sku.brand_name)) = lower(candidate.brand_name);

-- Create one Portal SKU for each remaining finished-product catalog candidate.
insert into public.portal_sku_intake (
  reference,
  brand_name,
  product_name,
  status,
  created_by_email,
  workflow_version,
  external_sku,
  inventory_class,
  master_status,
  sellable,
  master_note
)
select
  concat('SKU-CANIX-', candidate.canix_item_id),
  candidate.brand_name,
  candidate.product_name,
  'draft',
  'catalog-bootstrap@urbanxtracts.com',
  2,
  candidate.external_sku,
  'finished_product',
  'active',
  true,
  concat(
    'Activated from the existing Portal catalog candidate linked to Canix Item ',
    candidate.canix_item_id,
    '. Catalog publication remains separately gated.'
  )
from portal_catalog_sku_candidates candidate
where not exists (
  select 1
  from public.portal_sku_intake sku
  where lower(btrim(sku.product_name)) = lower(candidate.product_name)
    and lower(btrim(sku.brand_name)) = lower(candidate.brand_name)
)
on conflict (reference) do nothing;

-- Every Portal SKU keeps the same six-section intake structure, even when the
-- identity was bootstrapped from an already selected catalog record.
insert into public.portal_sku_intake_section (
  intake_id,
  section_key,
  position,
  title,
  status,
  updated_by_email
)
select
  sku.id,
  section.section_key,
  section.position,
  section.title,
  'not_started',
  'catalog-bootstrap@urbanxtracts.com'
from portal_catalog_sku_candidates candidate
join public.portal_sku_intake sku
  on lower(btrim(sku.product_name)) = lower(candidate.product_name)
 and lower(btrim(sku.brand_name)) = lower(candidate.brand_name)
cross join (
  values
    ('product_identity', 1::smallint, 'Product Identity & Ownership'),
    ('commercial_ordering', 2::smallint, 'Commercial & Ordering'),
    ('formulation_bom', 3::smallint, 'Formulation & Bill of Materials'),
    ('packaging_labeling', 4::smallint, 'Packaging & Labeling'),
    ('quality_compliance', 5::smallint, 'Manufacturing, Quality & Compliance'),
    ('marketing_launch', 6::smallint, 'Marketing, Integrations & Launch')
) as section(section_key, position, title)
on conflict (intake_id, section_key) do nothing;

insert into public.portal_sku_intake_event (
  intake_id,
  action,
  actor_type,
  actor_email,
  detail
)
select
  sku.id,
  'master_activated',
  'system',
  'catalog-bootstrap@urbanxtracts.com',
  jsonb_build_object(
    'inventoryClass', 'finished_product',
    'masterStatus', 'active',
    'sellable', true,
    'canixItemId', candidate.canix_item_id,
    'catalogPublicationSeparatelyGated', true
  )
from portal_catalog_sku_candidates candidate
join public.portal_sku_intake sku
  on lower(btrim(sku.product_name)) = lower(candidate.product_name)
 and lower(btrim(sku.brand_name)) = lower(candidate.brand_name);

insert into public.portal_data_control_event (
  control_type,
  control_key,
  action,
  current_state,
  actor_email
)
select
  'portal_sku_master',
  sku.reference,
  'approved',
  to_jsonb(sku),
  'catalog-bootstrap@urbanxtracts.com'
from portal_catalog_sku_candidates candidate
join public.portal_sku_intake sku
  on lower(btrim(sku.product_name)) = lower(candidate.product_name)
 and lower(btrim(sku.brand_name)) = lower(candidate.brand_name);

select public.portal_refresh_item_match_suggestions();
