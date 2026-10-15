-- Keep the buyer-facing Canix Marketplace catalog separate from the physical
-- package ledger. The Marketplace is a publication snapshot; Canix REST
-- remains authoritative for package inventory and Monday remains authoritative
-- for approved commercial content.

create table if not exists public.canix_marketplace_sync_state (
  id smallint primary key default 1 check (id = 1),
  shop_slug text not null,
  marketplace_shop_id text,
  source_url text not null,
  status text not null default 'never_run'
    check (status in ('never_run', 'running', 'success', 'error')),
  source_mode text not null default 'browser_verified_snapshot'
    check (source_mode in ('browser_verified_snapshot', 'canix_shop_graphql')),
  snapshot_scope text not null default 'brand_filtered'
    check (snapshot_scope in ('brand_filtered', 'full_shop')),
  last_successful_run_id uuid,
  last_successful_at timestamptz,
  total_shop_product_count integer,
  snapshot_product_count integer,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.canix_marketplace_product_snapshot (
  sync_run_id uuid not null,
  shop_slug text not null,
  marketplace_product_id text not null,
  product_gid text not null,
  product_name text not null,
  brand_id text,
  brand_name text not null,
  item_category_name text,
  price_cents bigint,
  msrp_cents bigint,
  available_quantity numeric,
  sale_unit text,
  has_image boolean not null default false,
  image_url text,
  synced_at timestamptz not null default now(),
  primary key (sync_run_id, marketplace_product_id)
);

create index if not exists canix_marketplace_product_snapshot_product_idx
  on public.canix_marketplace_product_snapshot (marketplace_product_id, sync_run_id);

create index if not exists canix_marketplace_product_snapshot_brand_idx
  on public.canix_marketplace_product_snapshot (lower(brand_name), sync_run_id);

alter table public.canix_marketplace_sync_state enable row level security;
alter table public.canix_marketplace_product_snapshot enable row level security;
revoke all on table public.canix_marketplace_sync_state from public, anon, authenticated;
revoke all on table public.canix_marketplace_product_snapshot from public, anon, authenticated;
grant all on table public.canix_marketplace_sync_state to service_role;
grant all on table public.canix_marketplace_product_snapshot to service_role;

comment on table public.canix_marketplace_sync_state is
  'Server-owned publication snapshot state for the urbanXtracts Canix Marketplace shop.';
comment on table public.canix_marketplace_product_snapshot is
  'Buyer-facing Canix Marketplace product facts. This table is not an inventory ledger and never replaces package-level Canix REST data.';

-- Initial verified snapshot captured from the enabled urbanXtracts Canix shop
-- on 1 Oct 2026. It is intentionally limited to Brand = urbanXtracts. The
-- server-side connector can replace it with a full-shop snapshot after a
-- durable Canix Shop credential is configured.
with seed(
  marketplace_product_id, product_name, item_category_name,
  price_cents, available_quantity, has_image
) as (values
  ('10171', 'UXT - Berries & Bananas - Hash Infused Pre-Roll - 1.2g', 'Infused Flower - Each', 800, 385, false),
  ('15943', 'UXT - Berry Bomb - Hash Infused Pre-Roll - 1.2g', 'Infused Pre-Roll - Each', 800, 2548, true),
  ('13057', 'UXT - Berry Lemonade - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 334, true),
  ('17163', 'UXT - Biscotti Cake - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 1816, true),
  ('12883', 'UXT - Black Orchard - Pre-Roll - 1g', 'Raw Pre-Roll - Each', 500, 2807, true),
  ('17140', 'UXT - Black Orchard- Solventless "DAD" Hash - 1g', 'Concentrate/Extract (Non Solvent) - Each', 2500, 1217, false),
  ('17903', 'UXT - Cherry Marker - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 980, true),
  ('17900', 'UXT - Diamond Runtz - Cannabis Flower - 28g', 'Bud/Flower - Each', 7500, 694, true),
  ('15944', 'UXT - Flight 420 - Hash Infused Pre-Roll - 1.2g', 'Infused Pre-Roll - Each', 800, 983, true),
  ('12278', 'UXT - FULL SPECTRUM LUNCHBOX 420 Edition', 'Variety Pack', 7500, 217, true),
  ('17164', 'UXT - Garlic Cookies - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 2382, false),
  ('17899', 'UXT - Garlic Cookies - Cannabis Flower - 28g', 'Bud/Flower - Each', 7500, 851, true),
  ('17375', 'UXT - Garlic Cookies - Cannabis Flower - 7g', 'Bud/Flower - Each', 2500, 559, true),
  ('10172', 'UXT - Goliath - Hash Infused Pre-Roll - 1.2g', 'Infused Pre-Roll - Each', 800, 438, true),
  ('10173', 'UXT - Hudson Valley Kush - Cold Cure Live Rosin Jar - 1g', 'Concentrate/Extract - Each', 36000, 4, true),
  ('13058', 'UXT - Jet Fuel - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 1010, true),
  ('17376', 'UXT - Jet Fuel - Cannabis Flower - 7g', 'Bud/Flower - Each', 2500, 163, true),
  ('15933', 'UXT - Jet Fuel - Pre-Roll - 1g', 'Raw Pre-Roll - Each', 500, 1137, true),
  ('14459', 'UXT - MAC 1 - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 448, true),
  ('13056', 'UXT - Mendo Breath - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 410, true),
  ('12537', 'UXT - Nana Express - Hash Infused Pre-Roll - 1.2g', 'Infused Pre-Roll - Each', 800, 1224, true),
  ('10184', 'UXT - Nana Glue - Pre-Roll - 1.g', 'Raw Pre-Roll - Each', 500, 1789, true),
  ('11081', 'UXT - Orange Creamsicle - Pre-Roll - 1g', 'Raw Pre-Roll - Each', 500, 297, true),
  ('17771', 'UXT - Papaya Candy - 100% Live Rosin All-In-One - 1G', 'Vape Cartridge - Each', 3450, 707, true),
  ('10187', 'UXT - Platinum Kush Breath - Cold Cure Live Rosin Jar - 1g', 'Concentrate/Extract - Each', 36000, 12, true),
  ('10188', 'UXT - Platinum Kush Breath - Pre-Roll - 1.g', 'Raw Pre-Roll - Each', 500, 913, true),
  ('17147', 'UXT - Platinum Kush Breath - Solventless "DAD" Hash - 1g', 'Concentrate/Extract (Non Solvent) - Each', 2500, 1613, false),
  ('11694', 'UXT - Singapore Sling - Cold Cure Live Rosin Jar - 1g (90–120u)', 'Concentrate/Extract - Each', 36000, 782, true),
  ('14809', 'UXT - Singapore Sling - Live Rosin Stylus - 1g', 'Concentrate/Extract - Each', 3250, 1099, false),
  ('10190', 'UXT - Singapore Sling - Pre-Roll - 1.g', 'Raw Pre-Roll - Each', 500, 398, true),
  ('17901', 'UXT - Sky Fuel - Cannabis Flower - 28g', 'Bud/Flower - Each', 7500, 1004, true),
  ('11651', 'UXT - Strawberry Shortcake - Cold Cure Live Rosin Jar - 1g', 'Concentrate/Extract - Each', 36000, 202, true),
  ('15934', 'UXT - Sweet Cheese- Pre-Roll - 1g', 'Raw Pre-Roll - Each', 500, 216, false),
  ('17902', 'UXT - Tropical Juice - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 614, true),
  ('11702', 'UXT - WarheadZ - Solventless "DAD" Hash - 1g', 'Concentrate/Extract - Each', 30000, 418, true),
  ('12884', 'UXT - Wild Berry Fusion - Pre-Roll - 1g', 'Raw Pre-Roll - Each', 500, 2788, true),
  ('17161', 'UXT - Wild Cherry Z - Cannabis Flower - 14g', 'Bud/Flower - Each', 4500, 371, true)
)
insert into public.canix_marketplace_product_snapshot (
  sync_run_id, shop_slug, marketplace_product_id, product_gid, product_name,
  brand_name, item_category_name, price_cents, available_quantity, sale_unit,
  has_image, synced_at
)
select
  '591af4c1-12e6-4ec4-9a1b-c2839887fe10'::uuid,
  'urbanXtracts',
  seed.marketplace_product_id,
  encode(convert_to('Product-gid://canix/Product/' || seed.marketplace_product_id, 'UTF8'), 'base64'),
  seed.product_name,
  'urbanXtracts',
  seed.item_category_name,
  seed.price_cents,
  seed.available_quantity,
  'each',
  seed.has_image,
  '2026-10-01 14:15:00+00'::timestamptz
from seed
on conflict (sync_run_id, marketplace_product_id) do update set
  product_name = excluded.product_name,
  item_category_name = excluded.item_category_name,
  price_cents = excluded.price_cents,
  available_quantity = excluded.available_quantity,
  has_image = excluded.has_image,
  synced_at = excluded.synced_at;

insert into public.canix_marketplace_sync_state (
  id, shop_slug, marketplace_shop_id, source_url, status, source_mode,
  snapshot_scope, last_successful_run_id, last_successful_at,
  total_shop_product_count, snapshot_product_count, last_error, updated_at
) values (
  1,
  'urbanXtracts',
  'U2hvcC1naWQ6Ly9jYW5peC9NYXJrZXRwbGFjZVNob3AvMTQ3',
  'https://app.canix.com/marketplace/urbanXtracts',
  'success',
  'browser_verified_snapshot',
  'brand_filtered',
  '591af4c1-12e6-4ec4-9a1b-c2839887fe10'::uuid,
  '2026-10-01 14:15:00+00'::timestamptz,
  120,
  37,
  null,
  now()
)
on conflict (id) do update set
  shop_slug = excluded.shop_slug,
  marketplace_shop_id = excluded.marketplace_shop_id,
  source_url = excluded.source_url,
  status = excluded.status,
  source_mode = excluded.source_mode,
  snapshot_scope = excluded.snapshot_scope,
  last_successful_run_id = excluded.last_successful_run_id,
  last_successful_at = excluded.last_successful_at,
  total_shop_product_count = excluded.total_shop_product_count,
  snapshot_product_count = excluded.snapshot_product_count,
  last_error = null,
  updated_at = now();
