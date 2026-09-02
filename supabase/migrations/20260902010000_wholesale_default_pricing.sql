-- The operator-maintained wholesale list is staged separately from store-level
-- proposals. Canix item identity is mandatory before a source row can publish.

create table if not exists public.portal_wholesale_price_source (
  id uuid primary key default gen_random_uuid(),
  source_document_id text not null,
  source_sheet_id text not null,
  source_tab text not null,
  source_row integer not null check (source_row > 0),
  brand text,
  product_name text not null,
  product_profile text,
  terpenes text,
  thc text,
  case_size numeric check (case_size is null or case_size > 0),
  unit_price_cents integer not null check (unit_price_cents > 0 and unit_price_cents <= 10000000),
  case_price_cents integer check (case_price_cents is null or case_price_cents > 0),
  canix_item_id bigint,
  review_state text not null default 'unreviewed' check (review_state in (
    'unreviewed', 'exact_ready', 'normalized_review', 'missing_brand',
    'brand_conflict', 'name_collision', 'linked_conflict', 'no_match',
    'verified', 'published', 'rejected'
  )),
  review_reason text,
  suggested_canix_item_ids bigint[] not null default '{}',
  review_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  published_at timestamptz,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_document_id, source_sheet_id, source_tab, source_row)
);

create unique index if not exists portal_wholesale_price_verified_item_idx
  on public.portal_wholesale_price_source (canix_item_id)
  where canix_item_id is not null and review_state in ('verified', 'published');

create index if not exists portal_wholesale_price_review_queue_idx
  on public.portal_wholesale_price_source (review_state, brand, product_name);

create table if not exists public.portal_default_price (
  canix_item_id bigint primary key,
  product_id text generated always as ('canix:item:' || canix_item_id::text) stored,
  product_name text not null,
  brand text,
  sku text,
  unit_price_cents integer not null check (unit_price_cents > 0 and unit_price_cents <= 10000000),
  case_size numeric check (case_size is null or case_size > 0),
  case_price_cents integer check (case_price_cents is null or case_price_cents > 0),
  source_price_id uuid not null references public.portal_wholesale_price_source(id),
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(),
  active boolean not null default true
);

create unique index if not exists portal_default_price_product_id_idx
  on public.portal_default_price (product_id);

alter table public.portal_wholesale_price_source enable row level security;
alter table public.portal_default_price enable row level security;
revoke all on table public.portal_wholesale_price_source from anon, authenticated;
revoke all on table public.portal_default_price from anon, authenticated;
grant all on table public.portal_wholesale_price_source to service_role;
grant all on table public.portal_default_price to service_role;

create or replace function public.portal_verify_wholesale_price_source(
  p_source_price_id uuid,
  p_canix_item_id bigint,
  p_actor_id uuid,
  p_review_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.portal_wholesale_price_source%rowtype;
  current_item record;
begin
  if length(trim(coalesce(p_review_note, ''))) < 8 then
    raise exception 'A manual price identity review note is required';
  end if;

  select * into source_row
  from public.portal_wholesale_price_source
  where id = p_source_price_id
  for update;

  if not found then raise exception 'Wholesale source row not found'; end if;
  if source_row.review_state = 'published' then
    raise exception 'A published price must be superseded, not remapped';
  end if;

  select
    package.item_id,
    max(coalesce(nullif(package.product_name, ''), package.item_name)) as product_name,
    max(nullif(package.brand_name, '')) as brand,
    max(nullif(package.sku, '')) as sku
  into current_item
  from public.canix_package_current as package
  join public.canix_sync_state as sync
    on sync.id = 1 and sync.last_successful_run_id = package.sync_run_id
  where package.item_id = p_canix_item_id
    and package.quantity_type = 'CountBased'
  group by package.item_id;

  if not found then
    raise exception 'Canix item is absent from the latest CountBased inventory snapshot';
  end if;

  if exists (
    select 1 from public.portal_wholesale_price_source as other
    where other.id <> p_source_price_id
      and other.canix_item_id = p_canix_item_id
      and other.review_state in ('verified', 'published')
  ) then
    raise exception 'Canix item is already verified for another wholesale source row';
  end if;

  update public.portal_wholesale_price_source
  set canix_item_id = p_canix_item_id,
      review_state = 'verified',
      review_reason = 'Canix Item ID manually verified by an authorized pricing manager.',
      review_note = trim(p_review_note),
      reviewed_by = p_actor_id,
      reviewed_at = now(),
      updated_at = now()
  where id = p_source_price_id;

  insert into public.portal_admin_audit (
    actor_id, actor_org, action, detail
  ) values (
    p_actor_id,
    'urbanXtracts',
    'pricing.wholesale_identity_verified',
    jsonb_build_object(
      'sourcePriceId', p_source_price_id,
      'sourceRow', source_row.source_row,
      'sourceProductName', source_row.product_name,
      'sourceBrand', source_row.brand,
      'canixItemId', p_canix_item_id,
      'canixProductName', current_item.product_name,
      'canixBrand', current_item.brand,
      'reviewNote', trim(p_review_note)
    )
  );

  return jsonb_build_object(
    'id', p_source_price_id,
    'state', 'verified',
    'canixItemId', p_canix_item_id,
    'canixProductName', current_item.product_name
  );
end;
$$;

create or replace function public.portal_publish_wholesale_price_source(
  p_source_price_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.portal_wholesale_price_source%rowtype;
  current_item record;
begin
  select * into source_row
  from public.portal_wholesale_price_source
  where id = p_source_price_id
  for update;

  if not found then raise exception 'Wholesale source row not found'; end if;
  if source_row.review_state <> 'verified' or source_row.canix_item_id is null then
    raise exception 'Wholesale source identity must be verified before publication';
  end if;

  select
    package.item_id,
    max(coalesce(nullif(package.product_name, ''), package.item_name)) as product_name,
    max(nullif(package.brand_name, '')) as brand,
    max(nullif(package.sku, '')) as sku
  into current_item
  from public.canix_package_current as package
  join public.canix_sync_state as sync
    on sync.id = 1 and sync.last_successful_run_id = package.sync_run_id
  where package.item_id = source_row.canix_item_id
    and package.quantity_type = 'CountBased'
  group by package.item_id;

  if not found then
    raise exception 'Verified Canix item is absent from the latest CountBased inventory snapshot';
  end if;

  insert into public.portal_default_price (
    canix_item_id, product_name, brand, sku, unit_price_cents,
    case_size, case_price_cents, source_price_id, published_by, published_at, active
  ) values (
    source_row.canix_item_id, current_item.product_name, current_item.brand,
    current_item.sku, source_row.unit_price_cents, source_row.case_size,
    source_row.case_price_cents, source_row.id, p_actor_id, now(), true
  )
  on conflict (canix_item_id) do update
  set product_name = excluded.product_name,
      brand = excluded.brand,
      sku = excluded.sku,
      unit_price_cents = excluded.unit_price_cents,
      case_size = excluded.case_size,
      case_price_cents = excluded.case_price_cents,
      source_price_id = excluded.source_price_id,
      published_by = excluded.published_by,
      published_at = excluded.published_at,
      active = true;

  update public.portal_wholesale_price_source
  set review_state = 'published',
      published_at = now(),
      updated_at = now()
  where id = p_source_price_id;

  insert into public.portal_admin_audit (
    actor_id, actor_org, action, detail
  ) values (
    p_actor_id,
    'urbanXtracts',
    'pricing.wholesale_default_published',
    jsonb_build_object(
      'sourcePriceId', source_row.id,
      'sourceRow', source_row.source_row,
      'canixItemId', source_row.canix_item_id,
      'productName', current_item.product_name,
      'unitPriceCents', source_row.unit_price_cents
    )
  );

  return jsonb_build_object(
    'id', source_row.id,
    'state', 'published',
    'canixItemId', source_row.canix_item_id,
    'productName', current_item.product_name,
    'unitPriceCents', source_row.unit_price_cents
  );
end;
$$;

revoke all on function public.portal_verify_wholesale_price_source(uuid, bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.portal_publish_wholesale_price_source(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.portal_verify_wholesale_price_source(uuid, bigint, uuid, text)
  to service_role;
grant execute on function public.portal_publish_wholesale_price_source(uuid, uuid)
  to service_role;

with source_rows as (
  select *
  from jsonb_to_recordset($pricing$[{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":9,"brand":"urbanXtracts","product_name":"FULL SPECTRUM LUNCHBOX. 5 Product Variety Pack","product_profile":null,"terpenes":null,"thc":null,"case_size":1,"unit_price_cents":7500,"case_price_cents":7500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":10,"brand":"urbanXtracts","product_name":"Singapore Sling 1G Live Rosin SOLVENTLESS Dablicator","product_profile":"Indica","terpenes":"7.86%","thc":"80.54%","case_size":12,"unit_price_cents":3250,"case_price_cents":39000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":11,"brand":"urbanXtracts","product_name":"Singapore Sling - Live Rosin Jar - 1g","product_profile":"Indica","terpenes":"6.55%","thc":"66.26%","case_size":12,"unit_price_cents":3000,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":12,"brand":"urbanXtracts","product_name":"Strawberry Shortcake - Live Rosin Jar - 1g","product_profile":"Indica","terpenes":"7.53%","thc":"62.39%","case_size":12,"unit_price_cents":3000,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":13,"brand":"urbanXtracts","product_name":"Hudson Valley Kush 1G Cold Cure Live Rosin","product_profile":"Hybrid","terpenes":"7.31%","thc":"67.70%","case_size":12,"unit_price_cents":3000,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":14,"brand":"urbanXtracts","product_name":"Hudson Valley Kush - Solventless \"DAD\" Hash - 1g","product_profile":"Sativa","terpenes":"4.36%","thc":"49.31%","case_size":12,"unit_price_cents":2500,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":15,"brand":"urbanXtracts","product_name":"Platinum Kush Breath - Solventless \"DAD\" Hash - 1g","product_profile":"Hybrid","terpenes":"3.99%","thc":"63.69%","case_size":12,"unit_price_cents":2500,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":16,"brand":"urbanXtracts","product_name":"Black Orchard - Solventless \"DAD\" Hash - 1g","product_profile":"Indica","terpenes":"4.31%","thc":"56.31%","case_size":12,"unit_price_cents":2500,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":17,"brand":"urbanXtracts","product_name":"WarheadZ - Solventless \"DAD\" Hash - 1g","product_profile":"Sativa","terpenes":"1.11%","thc":"40.59%","case_size":13,"unit_price_cents":2500,"case_price_cents":32500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":18,"brand":"urbanXtracts","product_name":"Wild Berry Fusion - Solventless \"DAD\" Hash - 1g","product_profile":null,"terpenes":null,"thc":null,"case_size":12,"unit_price_cents":2500,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":19,"brand":"urbanXtracts","product_name":"MAC1 - 14G - Cannabis Flower","product_profile":"Hybrid","terpenes":"2.66%","thc":"27.43%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":20,"brand":"urbanXtracts","product_name":"Singapore Sling - 14G - Cannabis Flower","product_profile":"Indica","terpenes":"1.37%","thc":"25.60%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":21,"brand":"urbanXtracts","product_name":"Jet Fuel - 14G - Cannabis Flower","product_profile":"Sativa","terpenes":"2.39%","thc":"29.48%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":22,"brand":"urbanXtracts","product_name":"Berry Lemonade 14G - Cannabis Flower","product_profile":"Hybrid","terpenes":"2.14%","thc":"22.50%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":23,"brand":"urbanXtracts","product_name":"Mendo Breath 14G - Cannabis Flower","product_profile":"Indica","terpenes":"2.09%","thc":"23.75%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":24,"brand":"urbanXtracts","product_name":"Wild Cherry Z - 14G - Cannabis Flower","product_profile":"Indica","terpenes":"1.93%","thc":"34.13%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":25,"brand":"urbanXtracts","product_name":"Garlic Cookies - Cannabis Flower - 14G","product_profile":"Indica","terpenes":"1.88%","thc":"28.88%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":26,"brand":"urbanXtracts","product_name":"Biscotti Cake - 14G - Cannabis Flower","product_profile":"Hybrid","terpenes":"2.97%","thc":"31.49%","case_size":8,"unit_price_cents":4500,"case_price_cents":36000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":27,"brand":"urbanXtracts","product_name":"Garlic Cookies - 7G - Cannabis Flower","product_profile":"Indica","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":2500,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":28,"brand":"urbanXtracts","product_name":"Jet Fuel - 7G - Cannabis Flower","product_profile":"Sativa","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":2500,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":29,"brand":"urbanXtracts","product_name":"Singapore Sling - Pre-Roll - 1g","product_profile":"Indica","terpenes":"1.39%","thc":"21.66%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":30,"brand":"urbanXtracts","product_name":"Orange Creamsicle - Pre-Roll - 1g","product_profile":"Sativa","terpenes":"0.60%","thc":"21.24%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":31,"brand":"urbanXtracts","product_name":"Nana Glue - Pre-Roll - 1g","product_profile":"Sativa","terpenes":"1.57%","thc":"21.73%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":32,"brand":"urbanXtracts","product_name":"Platinum Kush Breath - Pre-Roll - 1g","product_profile":"Hybrid","terpenes":"1.95%","thc":"23.94%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":33,"brand":"urbanXtracts","product_name":"Black Orchard - Pre-Roll - 1g","product_profile":"Indica","terpenes":"2.19%","thc":"20.03%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":34,"brand":"urbanXtracts","product_name":"Wild Berry Fusion - Pre-Roll - 1g","product_profile":"Indica","terpenes":"2.43%","thc":"20.20%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":35,"brand":"urbanXtracts","product_name":"Jet Fuel - Pre-Roll - 1g","product_profile":"Hybrid","terpenes":"1.47%","thc":"27.54%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":36,"brand":"urbanXtracts","product_name":"Sweet Cheese - Pre-Roll - 1g","product_profile":"Sativa","terpenes":"0.59%","thc":"27.08%","case_size":36,"unit_price_cents":500,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":37,"brand":"urbanXtracts","product_name":"Berries & Bananas (Wild Berry Fusion flower + Nana Glue/Wild Berry Fusion Hash)","product_profile":"Indica","terpenes":"2.00%","thc":"24.80%","case_size":36,"unit_price_cents":800,"case_price_cents":28800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":38,"brand":"urbanXtracts","product_name":"Goliath (Singapore Sling Flower + Hash)","product_profile":"Indica","terpenes":"1.42%","thc":"29.11%","case_size":36,"unit_price_cents":800,"case_price_cents":28800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":39,"brand":"urbanXtracts","product_name":"Nana Express (Nana Glue + WarheadZ Hash)","product_profile":"Sativa","terpenes":"1.22%","thc":"24.15%","case_size":36,"unit_price_cents":800,"case_price_cents":28800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":40,"brand":"urbanXtracts","product_name":"Flight 420 (Jet Fuel Flower + Black Orchard Hash)","product_profile":"Hybrid","terpenes":"1.80%","thc":"33.86%","case_size":36,"unit_price_cents":800,"case_price_cents":28800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":41,"brand":"urbanXtracts","product_name":"Berry Bomb (Berry Lemonade Flower + Black Orchard Hash)","product_profile":"Indica","terpenes":"1.29%","thc":"27.29%","case_size":36,"unit_price_cents":800,"case_price_cents":28800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":43,"brand":"Jerry Garcia","product_name":"Jerry Garcia Rosin Infused Pre-Rolls 2-pk - Dark Star","product_profile":"Indica","terpenes":"1.43%","thc":"36.27%","case_size":15,"unit_price_cents":1600,"case_price_cents":24000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":44,"brand":"Jerry Garcia","product_name":"Jerry Garcia Rosin Infused Pre-Rolls 2-pk - Sunshine Daydream","product_profile":"Sativa","terpenes":"2.04%","thc":"36.81%","case_size":15,"unit_price_cents":1600,"case_price_cents":24000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":46,"brand":"CannaDots","product_name":"THC Dissolvable Dots - Unflavored 2.5MG - 100MG (40 pack)","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1450,"case_price_cents":29000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":47,"brand":"CannaDots","product_name":"THC Sublingual Dots - Orange 5MG - 100MG","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1350,"case_price_cents":27000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":48,"brand":"CannaDots","product_name":"THC Sublingual Dots - Blueberry 5MG - 100MG","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1350,"case_price_cents":27000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":49,"brand":"CannaDots","product_name":"THC Sublingual Dots - Cherry 5MG - 100MG","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1350,"case_price_cents":27000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":51,"brand":"HoneyPot","product_name":"HoneyPot NIGHT - 100mg THC Made with Cured Resin","product_profile":null,"terpenes":null,"thc":"100mg","case_size":24,"unit_price_cents":1350,"case_price_cents":32400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":52,"brand":"HoneyPot","product_name":"HoneyPot DAY - 100mg THC Made w/ Cannabinoid rich ethanol extraction","product_profile":null,"terpenes":null,"thc":"100mg","case_size":24,"unit_price_cents":1350,"case_price_cents":32400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":54,"brand":"Cannatela","product_name":"Hazelnut-Cocoa Spread","product_profile":null,"terpenes":null,"thc":"100mg","case_size":32,"unit_price_cents":1750,"case_price_cents":56000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":55,"brand":"Cannatela","product_name":"DubHigh Pistchio Spread","product_profile":null,"terpenes":null,"thc":"100mg","case_size":32,"unit_price_cents":2000,"case_price_cents":64000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":57,"brand":"Leilala & Watson","product_name":"Watermelon – 100mg Rosin Gummy Bar  (2.5MG / Servings)","product_profile":"Hybrid","terpenes":null,"thc":"100mg","case_size":12,"unit_price_cents":1585,"case_price_cents":19020},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":58,"brand":"Leilala & Watson","product_name":"Uplift Blueberry – 100mg Rosin Gummy Bar","product_profile":"Sativa","terpenes":null,"thc":"100mg","case_size":12,"unit_price_cents":1550,"case_price_cents":18600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":59,"brand":"Leilala & Watson","product_name":"Chill Sour Raspberry – 100mg Rosin Gummy Bar","product_profile":"Hybrid","terpenes":null,"thc":"100mg","case_size":12,"unit_price_cents":1550,"case_price_cents":18600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":60,"brand":"Leilala & Watson","product_name":"Restore Mixed Berry – 100mg Rosin Gummy Bar","product_profile":"Indica","terpenes":null,"thc":"100mg","case_size":12,"unit_price_cents":1550,"case_price_cents":18600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":62,"brand":"Joke n Toke","product_name":"0.5g Pre-Pack Chillum - Nana Glue, Purple Dream, PKB","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":950,"case_price_cents":22800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":63,"brand":"Joke n Toke","product_name":"1.5g Reload - Nana Glue, Purple Dream, PKB","product_profile":null,"terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1300,"case_price_cents":20800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":65,"brand":"Satori","product_name":"Satori - 0.5g AIO Berry Delight Rosin","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":3000,"case_price_cents":72000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":66,"brand":"Satori","product_name":"Satori - 0.5g AIO Strawberry Candy Rosin","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":3000,"case_price_cents":72000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":67,"brand":"Satori","product_name":"Satori - 1oz 600mg Water-Soluble Elixir","product_profile":null,"terpenes":null,"thc":null,"case_size":12,"unit_price_cents":4000,"case_price_cents":48000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":69,"brand":"Rosa Reta","product_name":"Gas Tanker | Live Rosin All-In-One Vape .5g","product_profile":null,"terpenes":null,"thc":null,"case_size":10,"unit_price_cents":3000,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":70,"brand":"Rosa Reta","product_name":"Straw Candy | Live Rosin All-In-One Vape .5g","product_profile":null,"terpenes":null,"thc":null,"case_size":10,"unit_price_cents":3000,"case_price_cents":30000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":72,"brand":"Moondust","product_name":"Apple Motorbreath - 2G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":"80.40.%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":73,"brand":"Moondust","product_name":"Forbidden Passion - 2G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":"74.37%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":74,"brand":"Moondust","product_name":"GMO Berries - 2G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":"76.41%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":75,"brand":"Moondust","product_name":"Guava Sherb - 2G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":"75.99.%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":76,"brand":"Moondust","product_name":"Orange Mimosa - 2G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":"81.15.%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":77,"brand":"Moondust","product_name":"Red, White, and Glue - 2G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":"76.95%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":78,"brand":"Moondust","product_name":"Strawnana Gas - 2G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":"79.64%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":79,"brand":"Moondust","product_name":"Killer Kiwi - 2G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":"78.91%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":80,"brand":"Moondust","product_name":"Tiger's Blood - 2G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":"79.08%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":81,"brand":"Moondust","product_name":"Blue Razz - 2G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":"80.90%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":82,"brand":"Moondust","product_name":"Watermelon Bubble - 2G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":"76.21%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":83,"brand":"Moondust","product_name":"Zour Patch Cough - 2G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":"73.34%","case_size":10,"unit_price_cents":4000,"case_price_cents":40000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":84,"brand":"Moondust","product_name":"Apple Motorbreath - 1G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":85,"brand":"Moondust","product_name":"Forbidden Passion - 1G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":86,"brand":"Moondust","product_name":"GMO Berries - 1G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":87,"brand":"Moondust","product_name":"Guava Sherb - 1G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":88,"brand":"Moondust","product_name":"Orange Mimosa - 1G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":89,"brand":"Moondust","product_name":"Red, White, and Glue - 1G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":90,"brand":"Moondust","product_name":"Strawnana Gas - 1G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":91,"brand":"Moondust","product_name":"Killer Kiwi - 1G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":92,"brand":"Moondust","product_name":"Tiger's Blood - 1G Live Resin Disposable","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":93,"brand":"Moondust","product_name":"Blue Razz Burst - 1G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":94,"brand":"Moondust","product_name":"Watermelon Bubble - 1G Live Resin Disposable","product_profile":"Indica","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":95,"brand":"Moondust","product_name":"Zour Patch Cough - 1G Live Resin Disposable","product_profile":"Sativa","terpenes":null,"thc":null,"case_size":10,"unit_price_cents":2250,"case_price_cents":22500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":96,"brand":"Moondust","product_name":"Blue Razz Burst  - 1G MoonRock Prerolls","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1100,"case_price_cents":17600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":97,"brand":"Moondust","product_name":"Red, White, and Glue - 1G MoonRock Prerolls","product_profile":"Hybrid","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1100,"case_price_cents":17600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":98,"brand":"Moondust","product_name":"Killer Kiwi - 1G MoonRock Prerolls","product_profile":"Indica","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1100,"case_price_cents":17600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":99,"brand":"Moondust","product_name":"Watermelon Bubble  - 1G MoonRock Prerolls","product_profile":"Indica","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1100,"case_price_cents":17600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":100,"brand":"Moondust","product_name":"Zour Patch Cough - 1G MoonRock Prerolls","product_profile":"Sativa","terpenes":null,"thc":null,"case_size":16,"unit_price_cents":1100,"case_price_cents":17600},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":102,"brand":"Royal Genetics","product_name":"Tropicana Cookies 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"80.40.%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":103,"brand":"Royal Genetics","product_name":"White Truffle 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"74.37%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":104,"brand":"Royal Genetics","product_name":"Permanent Marker 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"76.41%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":105,"brand":"Royal Genetics","product_name":"Pink Rozay 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"75.99.%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":106,"brand":"Royal Genetics","product_name":"Guava 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"81.15.%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":107,"brand":"Royal Genetics","product_name":"Donny Burger 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"76.95%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":108,"brand":"Royal Genetics","product_name":"Papaya 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"79.64%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":109,"brand":"Royal Genetics","product_name":"Zoap 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"78.91%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":110,"brand":"Royal Genetics","product_name":"Original Z 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"79.08%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":111,"brand":"Royal Genetics","product_name":"Gelonade 1G AIO Vape","product_profile":null,"terpenes":null,"thc":"80.90%","case_size":10,"unit_price_cents":2000,"case_price_cents":20000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":112,"brand":"Royal Genetics","product_name":"Gummy - Shimizu White Peach - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":113,"brand":"Royal Genetics","product_name":"Gummy - Nordic Blueberry - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":114,"brand":"Royal Genetics","product_name":"Gummy - Yuzu Lemon - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":115,"brand":"Royal Genetics","product_name":"Gummy - Densuke Watermelon - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":116,"brand":"Royal Genetics","product_name":"Gummy - Miyazaki Mango - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":117,"brand":"Royal Genetics","product_name":"Gummy - Kyoho Grape - 35G","product_profile":null,"terpenes":null,"thc":"100.00%","case_size":20,"unit_price_cents":900,"case_price_cents":18000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":119,"brand":"Wana","product_name":"Wana Classic Blueberry Indica","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1300,"case_price_cents":26000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":120,"brand":"Wana","product_name":"Wana Classic Mango Sativa","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1300,"case_price_cents":26000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":121,"brand":"Wana","product_name":"Wana Quick Limoncello Hybrid","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":122,"brand":"Wana","product_name":"Wana Quick Peach Bellini Sativa","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":123,"brand":"Wana","product_name":"Wana Quick Pina Colada Indica","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":124,"brand":"Wana","product_name":"Wana Quick Island Punch Indica","product_profile":null,"terpenes":null,"thc":"100mg","case_size":21,"unit_price_cents":1400,"case_price_cents":29400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":125,"brand":"Wana","product_name":"Wana Quick New York Sunrise Sativa","product_profile":null,"terpenes":null,"thc":"100mg","case_size":22,"unit_price_cents":1400,"case_price_cents":30800},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":126,"brand":"Wana","product_name":"Wana Quick Strawberry Margarita 1:1 Hybrid","product_profile":null,"terpenes":null,"thc":"100mg","case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":127,"brand":"Wana","product_name":"Wana Stay Asleep 4:2:1:1","product_profile":null,"terpenes":null,"thc":null,"case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":128,"brand":"Wana","product_name":"Wana Fast Asleep 4:1:1:1","product_profile":null,"terpenes":null,"thc":null,"case_size":20,"unit_price_cents":1400,"case_price_cents":28000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":130,"brand":"Made in Xiaolin","product_name":"The Godfather VSXL - 12G Cannagar","product_profile":null,"terpenes":null,"thc":null,"case_size":1,"unit_price_cents":25500,"case_price_cents":25500},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":131,"brand":"Made in Xiaolin","product_name":"The Capo VSXL - 6G Cannagar","product_profile":null,"terpenes":null,"thc":null,"case_size":1,"unit_price_cents":13000,"case_price_cents":13000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":132,"brand":"Made in Xiaolin","product_name":"The Goomah VSXL - 3G Cannagar","product_profile":null,"terpenes":null,"thc":null,"case_size":1,"unit_price_cents":7000,"case_price_cents":7000},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":133,"brand":"Made in Xiaolin","product_name":"The Bambino Twin Pack - 2 .7g Infused Joint","product_profile":null,"terpenes":null,"thc":null,"case_size":25,"unit_price_cents":1850,"case_price_cents":46250},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":135,"brand":"Flash","product_name":"Banana Kush - 1.0g AIO Flash Pen","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":1850,"case_price_cents":44400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":136,"brand":"Flash","product_name":"Cotton Candy Kush - 1.0g AIO Flash Pen","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":1850,"case_price_cents":44400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":137,"brand":"Flash","product_name":"Grape Stomper - 1.0g AIO Flash Pen","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":1850,"case_price_cents":44400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":138,"brand":"Flash","product_name":"Strawberry Cough - 1.0g AIO Flash Pen","product_profile":null,"terpenes":null,"thc":null,"case_size":24,"unit_price_cents":1850,"case_price_cents":44400},{"source_document_id":"11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso","source_sheet_id":"1220163199","source_tab":"ACTIVE CART","source_row":139,"brand":"Flash","product_name":"Watermelon Zkittlez - 1.0g AIO Flash Pen","product_profile":null,"terpenes":null,"thc":null,"case_size":12,"unit_price_cents":1850,"case_price_cents":22200}]$pricing$::jsonb) as source(
    source_document_id text,
    source_sheet_id text,
    source_tab text,
    source_row integer,
    brand text,
    product_name text,
    product_profile text,
    terpenes text,
    thc text,
    case_size numeric,
    unit_price_cents integer,
    case_price_cents integer
  )
)
insert into public.portal_wholesale_price_source (
  source_document_id, source_sheet_id, source_tab, source_row, brand,
  product_name, product_profile, terpenes, thc, case_size,
  unit_price_cents, case_price_cents
)
select
  source_document_id, source_sheet_id, source_tab, source_row, brand,
  product_name, product_profile, terpenes, thc, case_size,
  unit_price_cents, case_price_cents
from source_rows
on conflict (source_document_id, source_sheet_id, source_tab, source_row) do update
set brand = excluded.brand,
    product_name = excluded.product_name,
    product_profile = excluded.product_profile,
    terpenes = excluded.terpenes,
    thc = excluded.thc,
    case_size = excluded.case_size,
    unit_price_cents = excluded.unit_price_cents,
    case_price_cents = excluded.case_price_cents,
    updated_at = now();

comment on table public.portal_wholesale_price_source is
  'Audited staging rows from the approved wholesale Google Sheet. No row affects ordering before Canix identity verification and publication.';
comment on table public.portal_default_price is
  'Current published default wholesale list price. A store-specific approved price overrides this value.';
