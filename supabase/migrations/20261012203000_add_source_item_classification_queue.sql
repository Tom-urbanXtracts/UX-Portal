-- Persist a reviewable inventory classification for every connected source
-- item. Source refreshes may update automatic classifications, but they never
-- replace a classification approved by an internal reviewer.

alter table public.portal_sku_intake
  drop constraint if exists portal_sku_intake_inventory_class_check,
  add constraint portal_sku_intake_inventory_class_check check (inventory_class in (
    'finished_product','biomass','clone','seed','oil','rosin','bulk','plant_material'
  ));

alter table public.portal_item_source_mapping
  add column if not exists inventory_class text,
  add column if not exists classification_status text not null default 'unclassified',
  add column if not exists classification_method text,
  add column if not exists classification_confidence numeric,
  add column if not exists classification_note text not null default '',
  add column if not exists classified_at timestamptz,
  add column if not exists classified_by_email text;

alter table public.portal_item_source_mapping
  drop constraint if exists portal_item_source_mapping_inventory_class_check,
  add constraint portal_item_source_mapping_inventory_class_check check (
    inventory_class is null or inventory_class in (
      'finished_product','biomass','clone','seed','oil','rosin','bulk','plant_material'
    )
  ),
  drop constraint if exists portal_item_source_mapping_classification_status_check,
  add constraint portal_item_source_mapping_classification_status_check check (
    classification_status in (
      'unclassified','auto_classified','needs_review','approved','not_required'
    )
  ),
  drop constraint if exists portal_item_source_mapping_classification_confidence_check,
  add constraint portal_item_source_mapping_classification_confidence_check check (
    classification_confidence is null or
    (classification_confidence >= 0 and classification_confidence <= 1)
  ),
  drop constraint if exists portal_item_source_mapping_classification_value_check,
  add constraint portal_item_source_mapping_classification_value_check check (
    classification_status in ('unclassified','needs_review','not_required')
    or inventory_class is not null
  );

create index if not exists portal_item_source_mapping_classification_queue_idx
  on public.portal_item_source_mapping (
    classification_status, inventory_class, source_active, source_system, updated_at desc
  );

create or replace function public.portal_refresh_source_item_classifications()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  classified_count integer;
  review_count integer;
begin
  -- An approved Portal SKU is the strongest available classification evidence.
  update public.portal_item_source_mapping mapping
  set inventory_class = sku.inventory_class,
      classification_status = 'approved',
      classification_method = 'approved_portal_sku',
      classification_confidence = 1,
      classification_note = case
        when nullif(btrim(mapping.classification_note), '') is not null
          then mapping.classification_note
        else 'Inherited from the approved Portal SKU identity mapping.'
      end,
      classified_at = coalesce(mapping.approved_at, now()),
      classified_by_email = coalesce(mapping.approved_by_email, 'system@urbanxtracts.com')
  from public.portal_sku_intake sku
  where mapping.portal_sku_id = sku.id
    and mapping.decision_status = 'approved'
    and mapping.classification_status not in ('approved','not_required');

  -- Apply only explicit, reviewable Canix rules. Manually approved and
  -- Not-required decisions are immutable until a reviewer replaces them.
  with candidates as (
    select
      mapping.source_system,
      mapping.source_item_id,
      item.quantity_type,
      lower(concat_ws(' ',
        mapping.source_name,
        mapping.source_item_type,
        item.item_category_name,
        item.item_sub_type_name
      )) as haystack
    from public.portal_item_source_mapping mapping
    join public.canix_item_current item
      on mapping.source_system = 'canix'
     and item.item_id::text = mapping.source_item_id
    where mapping.source_present is true
      and mapping.classification_status not in ('approved','not_required')
  ), rules as (
    select
      source_system,
      source_item_id,
      case
        when haystack ~ '(^|[^a-z])(clone|clones)([^a-z]|$)' then 'clone'
        when haystack ~ '(^|[^a-z])(seed|seeds)([^a-z]|$)' then 'seed'
        when haystack ~ 'biomass' then 'biomass'
        when haystack ~ '(^|[^a-z])bulk([^a-z]|$)' then 'bulk'
        when haystack ~ 'rosin' then 'rosin'
        when haystack ~ '(distillate|resin|liquid diamonds|htfse|(^|[^a-z])oil([^a-z]|$))' then 'oil'
        when haystack ~ '(plant material|fresh flower|dry flower|(^|[^a-z])(smalls|bigs|trim)([^a-z]|$))' then 'plant_material'
        when quantity_type = 'CountBased'
          and haystack !~ '(work in progress|(^|[^a-z])wip([^a-z]|$)|formulation|filling|packaging|template|sandbox)'
          then 'finished_product'
        else null
      end as inventory_class,
      case
        when haystack ~ '(^|[^a-z])(clone|clones|seed|seeds)([^a-z]|$)'
          or haystack ~ '(biomass|(^|[^a-z])bulk([^a-z]|$)|rosin|distillate|resin|liquid diamonds|htfse|(^|[^a-z])oil([^a-z]|$)|plant material|fresh flower|dry flower|(^|[^a-z])(smalls|bigs|trim)([^a-z]|$))'
          then 1::numeric
        when quantity_type = 'CountBased'
          and haystack !~ '(work in progress|(^|[^a-z])wip([^a-z]|$)|formulation|filling|packaging|template|sandbox)'
          then 0.9::numeric
        else null
      end as confidence
    from candidates
  )
  update public.portal_item_source_mapping mapping
  set inventory_class = rules.inventory_class,
      classification_status = case
        when rules.inventory_class is null then 'needs_review'
        else 'auto_classified'
      end,
      classification_method = case
        when rules.inventory_class is null then 'manual_review_required'
        when rules.inventory_class = 'finished_product' then 'canix_count_based_finished_product'
        else 'canix_name_or_category_rule'
      end,
      classification_confidence = rules.confidence,
      classification_note = case
        when rules.inventory_class is null
          then 'Canix fields do not support a deterministic inventory classification.'
        else 'Automatically classified from current Canix item fields; reviewable in the Portal.'
      end,
      classified_at = now(),
      classified_by_email = 'system@urbanxtracts.com'
  from rules
  where mapping.source_system = rules.source_system
    and mapping.source_item_id = rules.source_item_id;

  update public.portal_item_source_mapping mapping
  set inventory_class = null,
      classification_status = 'needs_review',
      classification_method = 'quickbooks_identity_review_required',
      classification_confidence = null,
      classification_note = 'QuickBooks type alone does not determine the Portal inventory class.',
      classified_at = now(),
      classified_by_email = 'system@urbanxtracts.com'
  where mapping.source_system = 'quickbooks'
    and mapping.source_present is true
    and mapping.classification_status not in ('approved','not_required');

  select count(*)::integer into classified_count
  from public.portal_item_source_mapping
  where source_present is true
    and classification_status in ('auto_classified','approved');

  select count(*)::integer into review_count
  from public.portal_item_source_mapping
  where source_present is true
    and classification_status in ('unclassified','needs_review');

  return jsonb_build_object(
    'classified', classified_count,
    'needsReview', review_count
  );
end;
$$;

revoke all on function public.portal_refresh_source_item_classifications()
  from public, anon, authenticated;
grant execute on function public.portal_refresh_source_item_classifications()
  to service_role;

select public.portal_refresh_source_item_classifications();

comment on column public.portal_item_source_mapping.inventory_class is
  'Durable Portal inventory class. Approved and Not-required decisions survive source refreshes.';
comment on function public.portal_refresh_source_item_classifications() is
  'Refreshes automatic Canix classifications and review queues without replacing manual decisions.';
