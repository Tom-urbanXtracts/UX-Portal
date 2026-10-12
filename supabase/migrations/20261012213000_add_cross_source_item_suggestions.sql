alter table public.portal_item_match_suggestion
  add column if not exists suggested_source_system text,
  add column if not exists suggested_source_item_id text,
  add column if not exists suggested_source_name text;

alter table public.portal_item_match_suggestion
  drop constraint if exists portal_item_match_suggestion_match_method_check;
alter table public.portal_item_match_suggestion
  add constraint portal_item_match_suggestion_match_method_check check (match_method in (
    'exact_sku','exact_name_brand','normalized_name_brand',
    'exact_source_name','none','ambiguous'
  ));

create or replace function public.portal_refresh_item_match_suggestions()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_row public.portal_item_source_mapping%rowtype;
  policy_row public.portal_item_matching_policy%rowtype;
  candidate_ids uuid[];
  candidate_id uuid;
  candidate_reference text;
  candidate_count integer;
  candidate_source_system text;
  candidate_source_item_id text;
  candidate_source_name text;
  chosen_method text;
  chosen_confidence numeric;
  chosen_status text;
  chosen_reason text;
  mapped_row public.portal_item_source_mapping%rowtype;
  suggested_count integer := 0;
  approved_count integer := 0;
  ambiguous_count integer := 0;
  no_match_count integer := 0;
  cross_source_count integer := 0;
begin
  select * into policy_row
  from public.portal_item_matching_policy
  where singleton = true;

  delete from public.portal_item_match_suggestion suggestion
  where not exists (
    select 1 from public.portal_item_source_mapping mapping
    where mapping.source_system = suggestion.source_system
      and mapping.source_item_id = suggestion.source_item_id
      and mapping.source_present = true
      and mapping.decision_status in ('to_be_mapped','pending_review','conflict')
  );

  for source_row in
    select * from public.portal_item_source_mapping
    where source_present = true
      and decision_status in ('to_be_mapped','pending_review','conflict')
    order by source_system, source_item_id
  loop
    candidate_ids := null;
    candidate_id := null;
    candidate_reference := null;
    candidate_count := 0;
    candidate_source_system := null;
    candidate_source_item_id := null;
    candidate_source_name := null;
    chosen_method := 'none';
    chosen_confidence := 0;
    chosen_status := 'no_match';
    chosen_reason := 'No active Portal SKU matched the available source identity.';

    if nullif(btrim(source_row.source_sku), '') is not null then
      select array_agg(id order by id), count(*)::integer
        into candidate_ids, candidate_count
      from public.portal_sku_intake
      where master_status = 'active'
        and nullif(btrim(external_sku), '') is not null
        and lower(btrim(external_sku)) = lower(btrim(source_row.source_sku));
      if candidate_count > 0 then
        chosen_method := case when candidate_count = 1 then 'exact_sku' else 'ambiguous' end;
        chosen_confidence := case when candidate_count = 1 then 1 else 0 end;
        chosen_status := case when candidate_count = 1 then 'suggested' else 'ambiguous' end;
        chosen_reason := case when candidate_count = 1
          then 'Unique exact SKU match.'
          else 'More than one active Portal SKU matched the source SKU.' end;
      end if;
    end if;

    if candidate_count = 0
      and nullif(btrim(source_row.source_name), '') is not null
      and nullif(btrim(source_row.source_brand_name), '') is not null then
      select array_agg(id order by id), count(*)::integer
        into candidate_ids, candidate_count
      from public.portal_sku_intake
      where master_status = 'active'
        and lower(btrim(product_name)) = lower(btrim(source_row.source_name))
        and lower(btrim(brand_name)) = lower(btrim(source_row.source_brand_name));
      if candidate_count > 0 then
        chosen_method := case when candidate_count = 1 then 'exact_name_brand' else 'ambiguous' end;
        chosen_confidence := case when candidate_count = 1 then 1 else 0 end;
        chosen_status := case when candidate_count = 1 then 'suggested' else 'ambiguous' end;
        chosen_reason := case when candidate_count = 1
          then 'Unique exact product name and Brand match.'
          else 'More than one active Portal SKU has the exact product name and Brand.' end;
      end if;
    end if;

    if candidate_count = 0 and policy_row.suggest_normalized_name_brand
      and nullif(public.portal_normalize_item_identity(coalesce(source_row.source_name, '')), '') is not null
      and nullif(public.portal_normalize_item_identity(coalesce(source_row.source_brand_name, '')), '') is not null then
      select array_agg(id order by id), count(*)::integer
        into candidate_ids, candidate_count
      from public.portal_sku_intake
      where master_status = 'active'
        and public.portal_normalize_item_identity(product_name) =
          public.portal_normalize_item_identity(source_row.source_name)
        and public.portal_normalize_item_identity(brand_name) =
          public.portal_normalize_item_identity(source_row.source_brand_name);
      if candidate_count > 0 then
        chosen_method := case when candidate_count = 1 then 'normalized_name_brand' else 'ambiguous' end;
        chosen_confidence := case when candidate_count = 1 then 0.88 else 0 end;
        chosen_status := case when candidate_count = 1 then 'suggested' else 'ambiguous' end;
        chosen_reason := case when candidate_count = 1
          then 'Unique normalized product name and Brand match; review is required.'
          else 'Normalized product name and Brand matched more than one active Portal SKU.' end;
      end if;
    end if;

    if candidate_count = 0
      and source_row.source_system = 'quickbooks'
      and nullif(public.portal_normalize_item_identity(coalesce(source_row.source_name, '')), '') is not null then
      select count(*)::integer,
             min(mapping.source_system),
             min(mapping.source_item_id),
             min(mapping.source_name)
        into candidate_count, candidate_source_system,
             candidate_source_item_id, candidate_source_name
      from public.portal_item_source_mapping mapping
      where mapping.source_system = 'canix'
        and mapping.source_present = true
        and public.portal_normalize_item_identity(mapping.source_name) =
          public.portal_normalize_item_identity(source_row.source_name);
      if candidate_count > 0 then
        chosen_method := case when candidate_count = 1 then 'exact_source_name' else 'ambiguous' end;
        chosen_confidence := case when candidate_count = 1 then 0.95 else 0 end;
        chosen_status := case when candidate_count = 1 then 'suggested' else 'ambiguous' end;
        chosen_reason := case when candidate_count = 1
          then 'Unique exact-name Canix source item; review before assigning a Portal SKU.'
          else 'The QuickBooks name matched more than one current Canix item.' end;
        if candidate_count > 1 then
          candidate_source_system := null;
          candidate_source_item_id := null;
          candidate_source_name := null;
        end if;
      end if;
    end if;

    if candidate_count = 1 and candidate_id is null
      and candidate_source_item_id is not null then
      cross_source_count := cross_source_count + 1;
      suggested_count := suggested_count + 1;
    elsif candidate_count = 1 then
      candidate_id := candidate_ids[1];
      select reference into candidate_reference
      from public.portal_sku_intake where id = candidate_id;
    elsif candidate_count > 1 then
      ambiguous_count := ambiguous_count + 1;
    else
      no_match_count := no_match_count + 1;
    end if;

    if candidate_count = 1 and candidate_id is not null
      and source_row.decision_status = 'to_be_mapped'
      and ((chosen_method = 'exact_sku' and policy_row.auto_approve_exact_sku)
        or (chosen_method = 'exact_name_brand' and policy_row.auto_approve_exact_name_brand)) then
      chosen_status := 'auto_approved';
      update public.portal_item_source_mapping
      set portal_sku_reference = candidate_reference,
          portal_sku_id = candidate_id,
          decision_status = 'approved',
          match_method = chosen_method,
          match_confidence = chosen_confidence,
          decision_note = 'System auto-approved: ' || chosen_reason,
          approved_by = null,
          approved_by_email = 'system@portal.urbanxtracts.com',
          approved_at = now(),
          updated_at = now()
      where source_system = source_row.source_system
        and source_item_id = source_row.source_item_id
        and decision_status = 'to_be_mapped'
      returning * into mapped_row;
      if found then
        approved_count := approved_count + 1;
        insert into public.portal_data_control_event (
          control_type, control_key, action, prior_state, current_state,
          actor_id, actor_email
        ) values (
          'source_item_mapping', source_row.source_system || ':' || source_row.source_item_id,
          'approved', to_jsonb(source_row), to_jsonb(mapped_row), null,
          'system@portal.urbanxtracts.com'
        );
      end if;
    elsif candidate_count = 1 and candidate_source_item_id is null then
      suggested_count := suggested_count + 1;
    end if;

    insert into public.portal_item_match_suggestion (
      source_system, source_item_id, suggested_portal_sku_id,
      suggested_reference, suggested_source_system,
      suggested_source_item_id, suggested_source_name,
      match_method, confidence, candidate_count,
      suggestion_status, reasoning, generated_at
    ) values (
      source_row.source_system, source_row.source_item_id, candidate_id,
      candidate_reference, candidate_source_system,
      candidate_source_item_id, candidate_source_name,
      chosen_method, chosen_confidence, candidate_count,
      chosen_status, chosen_reason, now()
    )
    on conflict (source_system, source_item_id) do update set
      suggested_portal_sku_id = excluded.suggested_portal_sku_id,
      suggested_reference = excluded.suggested_reference,
      suggested_source_system = excluded.suggested_source_system,
      suggested_source_item_id = excluded.suggested_source_item_id,
      suggested_source_name = excluded.suggested_source_name,
      match_method = excluded.match_method,
      confidence = excluded.confidence,
      candidate_count = excluded.candidate_count,
      suggestion_status = excluded.suggestion_status,
      reasoning = excluded.reasoning,
      generated_at = excluded.generated_at;
  end loop;

  return jsonb_build_object(
    'suggested', suggested_count,
    'crossSourceSuggested', cross_source_count,
    'autoApproved', approved_count,
    'ambiguous', ambiguous_count,
    'noMatch', no_match_count
  );
end;
$$;

create or replace function public.portal_refresh_source_item_classifications()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  classified_count integer;
  review_count integer;
  cross_source_count integer;
begin
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

  with normalized as (
    select mapping.*,
      public.portal_normalize_item_identity(mapping.source_name) as normalized_name
    from public.portal_item_source_mapping mapping
    where mapping.source_present is true
  ), unique_canix as (
    select normalized_name,
      min(source_item_id) as canix_item_id,
      min(inventory_class) as inventory_class,
      count(*)::integer as candidate_count,
      count(distinct inventory_class)::integer as class_count
    from normalized
    where source_system = 'canix'
      and classification_status in ('approved','auto_classified')
      and inventory_class is not null
      and nullif(normalized_name, '') is not null
    group by normalized_name
  ), inherited as (
    select qb.source_item_id, canix.canix_item_id, canix.inventory_class
    from normalized qb
    join unique_canix canix using (normalized_name)
    where qb.source_system = 'quickbooks'
      and qb.classification_status = 'needs_review'
      and canix.candidate_count = 1
      and canix.class_count = 1
  )
  update public.portal_item_source_mapping mapping
  set inventory_class = inherited.inventory_class,
      classification_status = 'auto_classified',
      classification_method = 'unique_exact_canix_name',
      classification_confidence = 0.95,
      classification_note = 'Inherited from unique exact-name Canix item ' || inherited.canix_item_id || '; Portal SKU identity remains reviewable.',
      classified_at = now(),
      classified_by_email = 'system@urbanxtracts.com'
  from inherited
  where mapping.source_system = 'quickbooks'
    and mapping.source_item_id = inherited.source_item_id;

  get diagnostics cross_source_count = row_count;

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
    'crossSourceClassified', cross_source_count,
    'needsReview', review_count
  );
end;
$$;

revoke all on function public.portal_refresh_item_match_suggestions(),
  public.portal_refresh_source_item_classifications()
  from public, anon, authenticated;
grant execute on function public.portal_refresh_item_match_suggestions(),
  public.portal_refresh_source_item_classifications()
  to service_role;

select public.portal_refresh_item_match_suggestions();
select public.portal_refresh_source_item_classifications();

comment on column public.portal_item_match_suggestion.suggested_source_item_id is
  'Review-only cross-system identity evidence. It never approves a Portal SKU mapping.';
comment on function public.portal_refresh_source_item_classifications() is
  'Classifies source items from Canix fields and unique exact-name Canix evidence while preserving manual decisions.';
