import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [inputPath, capturedAt, runId] = process.argv.slice(2);

if (!inputPath || !capturedAt || !runId) {
  throw new Error(
    "Usage: node scripts/prepare-canix-marketplace-browser-snapshot.mjs <bsk-evaluate.json> <captured-at> <run-id>",
  );
}

const parsed = JSON.parse(await readFile(resolve(inputPath), "utf8"));
if (parsed?.ok !== true || !parsed?.value) {
  throw new Error("The Browser Skill evaluation did not complete successfully.");
}

const source = parsed.value;
const products = Array.isArray(source.products) ? source.products : [];
const declaredProductCount = Number(source.declaredProductCount);

if (!Number.isInteger(declaredProductCount) || declaredProductCount <= 0) {
  throw new Error("The marketplace did not expose a valid declared product count.");
}
if (products.length !== declaredProductCount) {
  throw new Error(
    `Captured ${products.length} products, but the marketplace declared ${declaredProductCount}.`,
  );
}

const requiredText = [
  "marketplaceProductId",
  "productGid",
  "productName",
  "brandName",
  "itemCategoryName",
  "saleUnit",
  "productUrl",
];
const ids = new Set();
const gids = new Set();

for (const [index, product] of products.entries()) {
  for (const field of requiredText) {
    if (typeof product[field] !== "string" || !product[field].trim()) {
      throw new Error(`Product ${index + 1} is missing ${field}.`);
    }
  }
  if (ids.has(product.marketplaceProductId)) {
    throw new Error(`Duplicate marketplace product ID ${product.marketplaceProductId}.`);
  }
  if (gids.has(product.productGid)) {
    throw new Error(`Duplicate product GID ${product.productGid}.`);
  }
  ids.add(product.marketplaceProductId);
  gids.add(product.productGid);
  for (const field of ["priceCents", "availableQuantity", "minimumOrderQuantity"]) {
    if (!Number.isFinite(product[field]) || product[field] < 0) {
      throw new Error(`Product ${product.marketplaceProductId} has invalid ${field}.`);
    }
  }
  if (product.msrpCents !== null && (!Number.isFinite(product.msrpCents) || product.msrpCents < 0)) {
    throw new Error(`Product ${product.marketplaceProductId} has invalid msrpCents.`);
  }
  if (product.hasImage !== Boolean(product.imageUrl)) {
    throw new Error(`Product ${product.marketplaceProductId} has inconsistent image fields.`);
  }
}

const snapshot = {
  source: {
    shopSlug: source.shopSlug,
    sourceUrl: source.sourceUrl,
    sourceMode: "browser_verified_snapshot",
    snapshotScope: "full_shop",
    capturedAt,
    syncRunId: runId,
    declaredProductCount,
    capturedProductCount: products.length,
  },
  products,
};

const sqlString = (value) => value === null || value === undefined
  ? "null"
  : `'${String(value).replaceAll("'", "''")}'`;
const sqlNumber = (value) => value === null || value === undefined
  ? "null"
  : String(value);
const csvValue = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const dataDirectory = resolve("data");
await mkdir(dataDirectory, { recursive: true });
const dateLabel = capturedAt.slice(0, 10);
const jsonPath = resolve(dataDirectory, `canix-marketplace-listings-${dateLabel}.json`);
const csvPath = resolve(dataDirectory, `canix-marketplace-listings-${dateLabel}.csv`);
const migrationPath = resolve(
  "supabase/migrations/20261014194814_refresh_canix_marketplace_browser_snapshot.sql",
);

await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);

const csvHeaders = [
  "marketplace_product_id",
  "product_gid",
  "product_name",
  "brand_name",
  "item_category_name",
  "price_cents",
  "msrp_cents",
  "available_quantity",
  "sale_unit",
  "minimum_order_quantity",
  "has_image",
  "image_url",
  "product_url",
];
const csvRows = products.map((product) => [
  product.marketplaceProductId,
  product.productGid,
  product.productName,
  product.brandName,
  product.itemCategoryName,
  product.priceCents,
  product.msrpCents,
  product.availableQuantity,
  product.saleUnit,
  product.minimumOrderQuantity,
  product.hasImage,
  product.imageUrl,
  product.productUrl,
].map(csvValue).join(","));
await writeFile(csvPath, `${csvHeaders.join(",")}\n${csvRows.join("\n")}\n`);

const valueRows = products.map((product) => `  (
    ${sqlString(product.marketplaceProductId)},
    ${sqlString(product.productGid)},
    ${sqlString(product.productName)},
    ${sqlString(product.brandName)},
    ${sqlString(product.itemCategoryName)},
    ${sqlNumber(product.priceCents)},
    ${sqlNumber(product.msrpCents)},
    ${sqlNumber(product.availableQuantity)},
    ${sqlString(product.saleUnit)},
    ${product.hasImage ? "true" : "false"},
    ${sqlString(product.imageUrl)}
  )`).join(",\n");

const migration = `-- Browser-verified full-shop snapshot captured from the public Canix
-- urbanXtracts Marketplace. This publication snapshot feeds the portal's existing
-- marketplace reconciliation path; it does not replace package-level inventory.

with snapshot(
  marketplace_product_id, product_gid, product_name, brand_name,
  item_category_name, price_cents, msrp_cents, available_quantity,
  sale_unit, has_image, image_url
) as (values
${valueRows}
)
insert into public.canix_marketplace_product_snapshot (
  sync_run_id, shop_slug, marketplace_product_id, product_gid, product_name,
  brand_name, item_category_name, price_cents, msrp_cents,
  available_quantity, sale_unit, has_image, image_url, synced_at
)
select
  ${sqlString(runId)}::uuid,
  ${sqlString(source.shopSlug)},
  snapshot.marketplace_product_id,
  snapshot.product_gid,
  snapshot.product_name,
  snapshot.brand_name,
  snapshot.item_category_name,
  snapshot.price_cents,
  snapshot.msrp_cents,
  snapshot.available_quantity,
  snapshot.sale_unit,
  snapshot.has_image,
  snapshot.image_url,
  ${sqlString(capturedAt)}::timestamptz
from snapshot
on conflict (sync_run_id, marketplace_product_id) do update set
  product_gid = excluded.product_gid,
  product_name = excluded.product_name,
  brand_name = excluded.brand_name,
  item_category_name = excluded.item_category_name,
  price_cents = excluded.price_cents,
  msrp_cents = excluded.msrp_cents,
  available_quantity = excluded.available_quantity,
  sale_unit = excluded.sale_unit,
  has_image = excluded.has_image,
  image_url = excluded.image_url,
  synced_at = excluded.synced_at;

insert into public.canix_marketplace_sync_state (
  id, shop_slug, source_url, status, source_mode, snapshot_scope,
  last_successful_run_id, last_successful_at, total_shop_product_count,
  snapshot_product_count, last_error, updated_at
) values (
  1,
  ${sqlString(source.shopSlug)},
  ${sqlString(source.sourceUrl)},
  'success',
  'browser_verified_snapshot',
  'full_shop',
  ${sqlString(runId)}::uuid,
  ${sqlString(capturedAt)}::timestamptz,
  ${declaredProductCount},
  ${products.length},
  null,
  now()
)
on conflict (id) do update set
  shop_slug = excluded.shop_slug,
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
`;

await mkdir(dirname(migrationPath), { recursive: true });
await writeFile(migrationPath, migration);

console.log(JSON.stringify({
  ok: true,
  products: products.length,
  jsonPath,
  csvPath,
  migrationPath,
}, null, 2));
