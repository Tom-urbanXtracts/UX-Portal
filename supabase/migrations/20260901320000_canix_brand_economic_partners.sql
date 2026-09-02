-- Canix Brand is the authoritative market-facing source for Economic Partner.
-- This relationship is deliberately separate from Economic Owner (production
-- risk) and Settlement Counterparty (contractual payment responsibility).

create table if not exists public.portal_brand_economic_partner (
  brand_key text primary key,
  canix_brand_id bigint,
  canix_brand_name text not null,
  economic_partner_party_id uuid not null references public.portal_economic_party(id) on delete restrict,
  source_system text not null default 'canix_brand' check (source_system = 'canix_brand'),
  is_current boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (brand_key = lower(btrim(canix_brand_name))),
  check (length(btrim(canix_brand_name)) between 1 and 200)
);

create index if not exists portal_brand_economic_partner_party_idx
  on public.portal_brand_economic_partner (economic_partner_party_id);
create index if not exists portal_brand_economic_partner_current_idx
  on public.portal_brand_economic_partner (is_current, canix_brand_name);

create or replace function public.portal_economic_partner_code(p_brand_name text)
returns text
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  normalized text;
begin
  normalized := trim(both '_' from regexp_replace(upper(btrim(p_brand_name)), '[^A-Z0-9]+', '_', 'g'));
  if length(normalized) < 2 then
    return 'BRAND_' || upper(substr(md5(lower(btrim(p_brand_name))), 1, 8));
  end if;
  if length(normalized) > 40 then
    return left(normalized, 31) || '_' || upper(substr(md5(lower(btrim(p_brand_name))), 1, 8));
  end if;
  return normalized;
end;
$$;

create or replace function public.portal_sync_brand_economic_partners()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_run_id uuid;
  current_brand_count integer := 0;
  mapped_brand_count integer := 0;
begin
  select last_successful_run_id into current_run_id
  from public.canix_sync_state
  where id = 1;

  if current_run_id is null then
    return jsonb_build_object('synced', false, 'reason', 'no_successful_canix_snapshot', 'brands', 0);
  end if;

  -- Preserve historical mappings for auditability while clearly marking which
  -- brands remain present in the latest successful Canix snapshot.
  update public.portal_brand_economic_partner
  set is_current = false,
      updated_at = now()
  where is_current = true;

  -- Create a reusable party for every distinct Canix Brand. Existing manually
  -- curated legal names and party types are preserved. The Wana display label
  -- is normalized to the exact current Canix value requested by operations.
  with source_brands as (
    select distinct on (lower(btrim(brand_name)))
      lower(btrim(brand_name)) as brand_key,
      brand_id,
      btrim(brand_name) as brand_name,
      public.portal_economic_partner_code(brand_name) as party_code
    from public.canix_package_current
    where sync_run_id = current_run_id
      and nullif(btrim(brand_name), '') is not null
    order by lower(btrim(brand_name)), brand_id nulls last, brand_name
  ), party_sources as (
    select distinct on (party_code) party_code, brand_name
    from source_brands
    order by party_code, brand_name
  )
  insert into public.portal_economic_party (
    party_code, display_name, party_type, active, created_at, updated_at
  )
  select
    party_code,
    case when party_code = 'URBANXTRACTS' then 'urbanXtracts' else brand_name end,
    case when party_code = 'URBANXTRACTS' then 'urbanxtracts' else 'brand_partner' end,
    true,
    now(),
    now()
  from party_sources
  on conflict (party_code) do update set
    display_name = case
      when excluded.party_code = 'WANA' then 'Wana'
      when excluded.party_code = 'URBANXTRACTS' then 'urbanXtracts'
      else public.portal_economic_party.display_name
    end,
    updated_at = now();

  -- Wana may already exist from the earlier ownership registry as "Wana
  -- Brands". Keep the stable party ID and code, but use Canix's display value.
  update public.portal_economic_party
  set display_name = 'Wana', updated_at = now()
  where party_code = 'WANA' and display_name is distinct from 'Wana';

  with source_brands as (
    select distinct on (lower(btrim(brand_name)))
      lower(btrim(brand_name)) as brand_key,
      brand_id,
      btrim(brand_name) as brand_name,
      public.portal_economic_partner_code(brand_name) as party_code
    from public.canix_package_current
    where sync_run_id = current_run_id
      and nullif(btrim(brand_name), '') is not null
    order by lower(btrim(brand_name)), brand_id nulls last, brand_name
  )
  insert into public.portal_brand_economic_partner (
    brand_key, canix_brand_id, canix_brand_name,
    economic_partner_party_id, source_system, is_current,
    first_seen_at, last_seen_at, created_at, updated_at
  )
  select
    source_brands.brand_key,
    source_brands.brand_id,
    source_brands.brand_name,
    parties.id,
    'canix_brand',
    true,
    now(),
    now(),
    now(),
    now()
  from source_brands
  join public.portal_economic_party parties
    on parties.party_code = source_brands.party_code
  on conflict (brand_key) do update set
    canix_brand_id = excluded.canix_brand_id,
    canix_brand_name = excluded.canix_brand_name,
    economic_partner_party_id = excluded.economic_partner_party_id,
    source_system = excluded.source_system,
    is_current = true,
    last_seen_at = now(),
    updated_at = now();

  select count(*) into current_brand_count
  from (
    select distinct lower(btrim(brand_name))
    from public.canix_package_current
    where sync_run_id = current_run_id
      and nullif(btrim(brand_name), '') is not null
  ) source_brands;

  select count(*) into mapped_brand_count
  from public.portal_brand_economic_partner
  where is_current = true;

  return jsonb_build_object(
    'synced', true,
    'runId', current_run_id,
    'brands', current_brand_count,
    'mappedBrands', mapped_brand_count,
    'unmappedBrands', greatest(current_brand_count - mapped_brand_count, 0)
  );
end;
$$;

alter table public.portal_brand_economic_partner enable row level security;

revoke all on table public.portal_brand_economic_partner from public, anon, authenticated;
grant all on table public.portal_brand_economic_partner to service_role;

revoke all on function public.portal_economic_partner_code(text) from public, anon, authenticated;
grant execute on function public.portal_economic_partner_code(text) to service_role;
revoke all on function public.portal_sync_brand_economic_partners() from public, anon, authenticated;
grant execute on function public.portal_sync_brand_economic_partners() to service_role;

comment on table public.portal_brand_economic_partner is
  'Canix Brand to UX OS Economic Partner association. Never used as an Economic Owner fallback.';
comment on column public.portal_brand_economic_partner.economic_partner_party_id is
  'Market relationship sourced from Canix Brand; independent of production risk and settlement responsibility.';
comment on function public.portal_sync_brand_economic_partners() is
  'Synchronizes every nonblank Brand in the latest successful Canix snapshot into the Economic Partner registry.';

-- Seed all partners from the snapshot already in production. Future successful
-- Canix syncs call the same function from the inventory edge function.
select public.portal_sync_brand_economic_partners();
