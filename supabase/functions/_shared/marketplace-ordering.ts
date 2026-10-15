import { labFailed } from './security-contract.ts';
export const ORDER_FACILITY_ID = 4467;
export const ORDER_FACILITY_NAME = "OCM-DIST-24-000069";
export const MARKETPLACE_PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type MarketplaceState = Record<string, unknown>;

export function marketplaceSnapshotError(
  state: MarketplaceState | null | undefined,
  now = Date.now(),
): string | null {
  if (
    !state || state.status !== "success" ||
    state.snapshot_scope !== "full_shop" ||
    !state.last_successful_run_id || !state.last_successful_at
  ) {
    return "The Canix Marketplace catalog is not ready for store ordering.";
  }
  const refreshedAt = Date.parse(String(state.last_successful_at));
  if (
    !Number.isFinite(refreshedAt) || refreshedAt > now ||
    now - refreshedAt > MARKETPLACE_PRICE_MAX_AGE_MS
  ) {
    return "The Canix Marketplace catalog is stale. Ordering is paused until it is refreshed.";
  }
  return null;
}

export function marketplacePriceCents(value: unknown): number | null {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
type PackageRow=Record<string,unknown>;
/** A bidirectional exact-ID join. Reject both one listing -> multiple items
 * and one item -> multiple listings. Product names never establish identity. */
export function marketplaceIdentityIndex(packages:PackageRow[]):Map<string,string> {
  const items=new Map<string,Set<string>>(),products=new Map<string,Set<string>>();
  for(const p of packages){
    const units=Number(p.orderable_units===null||p.orderable_units===undefined?p.weight:p.orderable_units);
    const item=String(p.item_id||''),product=String(p.product_id||'');
    if(p.quantity_type!=='CountBased'||p.status_category!=='available'||labFailed(p)||!Number.isFinite(units)||units<=0
      || (p.facility_id!==undefined&&Number(p.facility_id)!==ORDER_FACILITY_ID)||!/^\d+$/.test(item)||!/^\d+$/.test(product))continue;
    if(!items.has(item))items.set(item,new Set());items.get(item)!.add(product);
    if(!products.has(product))products.set(product,new Set());products.get(product)!.add(item);
  }
  const result=new Map<string,string>();
  for(const [item,ids] of items){if(ids.size!==1)continue;const product=[...ids][0];if(products.get(product)?.size===1)result.set(item,product);}
  return result;
}
export async function loadMarketplaceIdentity(service:any,runId:string):Promise<Map<string,string>> {
  const rows:PackageRow[]=[];
  for(let from=0;from<30000;from+=1000){
    const {data,error}=await service.from('canix_package_current').select('package_id,item_id,product_id,facility_id,quantity_type,status_category,weight,orderable_units,lab_test_status,test_result_status')
      .eq('sync_run_id',runId).eq('facility_id',ORDER_FACILITY_ID).eq('quantity_type','CountBased').eq('status_category','available')
      .order('package_id').range(from,from+999);
    if(error)throw error;rows.push(...(data||[]));
    if((data||[]).length<1000)return marketplaceIdentityIndex(rows);
  }
  throw new Error('Marketplace identity source is incomplete; ordering is held.');
}
