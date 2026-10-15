-- One durable Portal SKU master and a conservative assisted-matching queue.
-- Source refreshes may update evidence and suggestions, but never erase a
-- Portal decision. Only unique exact matches may be approved automatically.

alter table public.portal_sku_intake
  add column if not exists external_sku text,
  add column if not exists inventory_class text not null default 'finished_product',
  add column if not exists master_status text not null default 'draft',
  add column if not exists sellable boolean not null default false,
  add column if not exists master_note text not null default '';

alter table public.portal_sku_intake
  drop constraint if exists portal_sku_intake_inventory_class_check,
  add constraint portal_sku_intake_inventory_class_check check (inventory_class in (
    'finished_product','biomass','seed','oil','rosin','bulk','plant_material'
  )),
  drop constraint if exists portal_sku_intake_master_status_check,
  add constraint portal_sku_intake_master_status_check check (master_status in (
    'draft','active','inactive','retired'
  )),
  drop constraint if exists portal_sku_intake_sellable_class_check,
  add constraint portal_sku_intake_sellable_class_check check (
    not sellable or (inventory_class = 'finished_product' and master_status = 'active')
  );

update public.portal_sku_intake
set master_status = case when status = 'approved' then 'active' else 'draft' end,
    sellable = status = 'approved',
    updated_at = now()
where master_status = 'draft' and sellable = false;

create unique index if not exists portal_sku_intake_active_external_sku_idx
  on public.portal_sku_intake (lower(btrim(external_sku)))
  where master_status = 'active' and nullif(btrim(external_sku), '') is not null;
create index if not exists portal_sku_intake_master_queue_idx
  on public.portal_sku_intake (master_status, inventory_class, updated_at desc);
create index if not exists portal_sku_intake_identity_idx
  on public.portal_sku_intake (lower(btrim(brand_name)), lower(btrim(product_name)))
  where master_status = 'active';

create table if not exists public.portal_item_matching_policy (
  singleton boolean primary key default true check (singleton),
  auto_approve_exact_sku boolean not null default true,
  auto_approve_exact_name_brand boolean not null default true,
  suggest_normalized_name_brand boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.portal_item_matching_policy (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.portal_item_match_suggestion (
  source_system text not null,
  source_item_id text not null,
  suggested_portal_sku_id uuid references public.portal_sku_intake(id) on delete cascade,
  suggested_reference text,
  match_method text not null check (match_method in (
    'exact_sku','exact_name_brand','normalized_name_brand','none','ambiguous'
  )),
  confidence numeric not null default 0 check (confidence between 0 and 1),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  suggestion_status text not null check (suggestion_status in (
    'suggested','auto_approved','ambiguous','no_match'
  )),
  reasoning text not null default '',
  generated_at timestamptz not null default now(),
  primary key (source_system, source_item_id),
  foreign key (source_system, source_item_id)
    references public.portal_item_source_mapping(source_system, source_item_id)
    on delete cascade
);

create index if not exists portal_item_match_suggestion_queue_idx
  on public.portal_item_match_suggestion (suggestion_status, match_method, generated_at desc);
create index if not exists portal_item_match_suggestion_sku_idx
  on public.portal_item_match_suggestion (suggested_portal_sku_id)
  where suggested_portal_sku_id is not null;

alter table public.portal_item_matching_policy enable row level security;
alter table public.portal_item_match_suggestion enable row level security;
revoke all on table public.portal_item_matching_policy,
  public.portal_item_match_suggestion from public, anon, authenticated;
grant all on table public.portal_item_matching_policy,
  public.portal_item_match_suggestion to service_role;

alter table public.portal_data_control_event
  drop constraint if exists portal_data_control_event_control_type_check;
alter table public.portal_data_control_event
  add constraint portal_data_control_event_control_type_check
  check (control_type in (
    'owner_mapping','package_lot','item_mapping','source_item_mapping',
    'portal_sku_master','lot_register','cost_object','catalog_record'
  ));

create or replace function public.portal_normalize_item_identity(p_value text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select regexp_replace(lower(btrim(p_value)), '[^a-z0-9]+', '', 'g');
$$;

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
  chosen_method text;
  chosen_confidence numeric;
  chosen_status text;
  chosen_reason text;
  mapped_row public.portal_item_source_mapping%rowtype;
  suggested_count integer := 0;
  approved_count integer := 0;
  ambiguous_count integer := 0;
  no_match_count integer := 0;
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

    if candidate_count = 1 then
      candidate_id := candidate_ids[1];
      select reference into candidate_reference
      from public.portal_sku_intake where id = candidate_id;
    elsif candidate_count > 1 then
      ambiguous_count := ambiguous_count + 1;
    else
      no_match_count := no_match_count + 1;
    end if;

    if candidate_count = 1 and source_row.decision_status = 'to_be_mapped'
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
    elsif candidate_count = 1 then
      suggested_count := suggested_count + 1;
    end if;

    insert into public.portal_item_match_suggestion (
      source_system, source_item_id, suggested_portal_sku_id,
      suggested_reference, match_method, confidence, candidate_count,
      suggestion_status, reasoning, generated_at
    ) values (
      source_row.source_system, source_row.source_item_id, candidate_id,
      candidate_reference, chosen_method, chosen_confidence, candidate_count,
      chosen_status, chosen_reason, now()
    )
    on conflict (source_system, source_item_id) do update set
      suggested_portal_sku_id = excluded.suggested_portal_sku_id,
      suggested_reference = excluded.suggested_reference,
      match_method = excluded.match_method,
      confidence = excluded.confidence,
      candidate_count = excluded.candidate_count,
      suggestion_status = excluded.suggestion_status,
      reasoning = excluded.reasoning,
      generated_at = excluded.generated_at;
  end loop;

  return jsonb_build_object(
    'suggested', suggested_count,
    'autoApproved', approved_count,
    'ambiguous', ambiguous_count,
    'noMatch', no_match_count
  );
end;
$$;

revoke all on function public.portal_normalize_item_identity(text),
  public.portal_refresh_item_match_suggestions()
  from public, anon, authenticated;
grant execute on function public.portal_normalize_item_identity(text),
  public.portal_refresh_item_match_suggestions()
  to service_role;

comment on column public.portal_sku_intake.inventory_class is
  'Separates sellable finished products from Biomass, Seeds, Oil, Rosin, Bulk, and Plant Material.';
comment on table public.portal_item_match_suggestion is
  'Regenerable assisted-match evidence. Durable mapping decisions remain in portal_item_source_mapping.';
comment on function public.portal_refresh_item_match_suggestions() is
  'Suggests exact SKU, exact product-name-plus-Brand, then normalized-name-plus-Brand matches. Only unique configured exact matches auto-approve.';

select public.portal_refresh_item_match_suggestions();
