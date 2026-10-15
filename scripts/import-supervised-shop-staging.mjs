// Data import only, into the explicitly guarded staging project. No migration,
// production writes, scheduler changes, password collection or source writes.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {sql,quote,project} from './store-staging-support.mjs';
const [workdir,path]=process.argv.slice(2);
assert(path?.startsWith('/tmp/ux-shop-supervised-'));
const {source,products}=JSON.parse(readFileSync(path,'utf8'));
assert.equal(source.shopSlug,'urbanXtracts');
assert.equal(source.sourceMode,'browser_verified_snapshot');
assert.equal(source.snapshotScope,'full_shop');
assert(products.length>0 && products.length===source.declaredProductCount);
assert.equal(new Set(products.map(p=>p.marketplaceProductId)).size,products.length);
assert(/^[0-9a-f-]{36}$/.test(source.syncRunId));
assert(Date.now()-Date.parse(source.capturedAt)>=0 && Date.now()-Date.parse(source.capturedAt)<3600000);
const rows=products.map(p=>{
  assert(/^\d+$/.test(p.marketplaceProductId));
  assert(Number.isSafeInteger(p.priceCents)&&p.priceCents>0);
  assert(Number.isFinite(p.availableQuantity)&&p.availableQuantity>=0);
  return {sync_run_id:source.syncRunId,shop_slug:source.shopSlug,marketplace_product_id:p.marketplaceProductId,
    product_gid:p.productGid,product_name:p.productName,brand_name:p.brandName,item_category_name:p.itemCategoryName,
    price_cents:p.priceCents,msrp_cents:null,available_quantity:p.availableQuantity,sale_unit:p.saleUnit,
    has_image:p.hasImage,image_url:p.imageUrl,synced_at:source.capturedAt};
});
console.log(sql(workdir,`begin;
insert into public.canix_marketplace_product_snapshot
select * from jsonb_populate_recordset(null::public.canix_marketplace_product_snapshot,${quote(JSON.stringify(rows))}::jsonb);
insert into public.canix_marketplace_sync_state(id,shop_slug,source_url,status,source_mode,snapshot_scope,last_successful_run_id,
last_successful_at,total_shop_product_count,snapshot_product_count,updated_at)
values(1,${quote(source.shopSlug)},${quote(source.sourceUrl)},'success','browser_verified_snapshot','full_shop',
${quote(source.syncRunId)},${quote(source.capturedAt)},${products.length},${products.length},now())
on conflict(id) do update set shop_slug=excluded.shop_slug,source_url=excluded.source_url,status=excluded.status,
source_mode=excluded.source_mode,snapshot_scope=excluded.snapshot_scope,last_successful_run_id=excluded.last_successful_run_id,
last_successful_at=excluded.last_successful_at,total_shop_product_count=excluded.total_shop_product_count,
snapshot_product_count=excluded.snapshot_product_count,last_error=null,updated_at=now();
select jsonb_build_object('project',${quote(project)},'products',count(*),'images',count(*) filter(where has_image),
'brands',count(distinct brand_name),'sourceMode','browser_verified_snapshot','productionChanged',false)
from public.canix_marketplace_product_snapshot where sync_run_id=${quote(source.syncRunId)};
commit;`));
