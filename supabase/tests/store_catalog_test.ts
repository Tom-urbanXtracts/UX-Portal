import { projectStoreProducts } from '../functions/_shared/store-catalog.ts';
import { projectStoreOrder } from '../functions/_shared/store-order-projection.ts';
import { marketplaceIdentityIndex, marketplaceSnapshotError, loadMarketplaceIdentity } from '../functions/_shared/marketplace-ordering.ts';
const assert=(v:unknown)=>{if(!v)throw new Error('Assertion failed');};
const product={id:'canix-item-1',sourceId:'canix:item:1',name:'Product',brand:'Brand',category:'Flower',releaseVerified:true,orderMode:'standard',
  availableUnits:100,ownerId:999,cost:500,content:{imageUrl:'https://assets.canix.com/a.png',ingredients:'Flower',internalNotes:'hidden'},
  marketplace:{unitPriceCents:100,msrpCents:200,marketplaceProductId:'10'},
  orderConstraints:{caseQuantity:12},lots:[{tag:'secret-tag',packageId:123,room:'Room',lotId:'lot',sourcePackageIds:[1],owner:'hidden',
    lab:'TestPassed',hasCoa:true,releaseVerified:true,coa:{documentUrl:'https://assets.canix.com/coa.pdf',sourceDocumentId:'private',labName:'Lab',
      cannabinoids:[{name:'THC',value:20,unit:'%',ownerId:'hidden'}],terpenes:[]}}]};
const packageRow=(item_id=1,product_id=10,overrides={})=>({item_id,product_id,facility_id:4467,quantity_type:'CountBased',status_category:'available',weight:10,orderable_units:10,...overrides});
Deno.test('Commercial Store catalog allowlists product data and strips package/custody/cost fields',()=>{
  const value=projectStoreProducts([product],false)[0],serialized=JSON.stringify(value);
  assert((value.marketplace as Record<string,unknown>).unitPriceCents===100);
  assert(value.availableUnits===null);
  for(const s of ['secret-tag','private','hidden','ownerId','packageId','sourcePackageIds','lotId','msrpCents'])assert(!serialized.includes(s));
});
Deno.test('Budtender gets only released education without pricing, availability or case controls',()=>{
  const value=projectStoreProducts([product,{...product,orderMode:'preorder',releaseVerified:false}],true);
  assert(value.length===1);
  for(const k of ['marketplace','availableUnits','orderMode','mixedRelease','orderConstraints','priceCents'])assert(!(k in value[0]));
  assert((value[0].content as Record<string,unknown>).imageUrl==='https://assets.canix.com/a.png');
});
Deno.test('Multiple packages for one exact Product/Item identity retain one orderable SKU',()=>{
  const map=marketplaceIdentityIndex([packageRow(),packageRow()]);assert(map.size===1&&map.get('1')==='10');
});
Deno.test('Both directions of ambiguous Product/Item identity fail closed',()=>{
  assert(marketplaceIdentityIndex([packageRow(1,10),packageRow(2,10)]).size===0);
  assert(marketplaceIdentityIndex([packageRow(1,10),packageRow(1,11)]).size===0);
});
Deno.test('Zero-stock historical aliases do not create a second orderable identity',()=>{
  const map=marketplaceIdentityIndex([packageRow(1,10),packageRow(2,10,{weight:0,orderable_units:0})]);assert(map.size===1&&map.get('1')==='10');
});
Deno.test('Other facilities, bulk, allocated and failed-lab packages cannot establish Store identity',()=>{
  for(const patch of [{facility_id:1},{quantity_type:'WeightBased'},{status_category:'allocated'},{test_result_status:'TestFailed'}])
    assert(marketplaceIdentityIndex([packageRow(1,10,patch)]).size===0);
});
Deno.test('Marketplace rejects a future-dated publication snapshot',()=>{
  assert(marketplaceSnapshotError({status:'success',snapshot_scope:'full_shop',last_successful_run_id:'run',last_successful_at:'2030-01-01T00:00:00Z'},Date.parse('2026-10-14T00:00:00Z'))!==null);
});
Deno.test('Identity source is paginated and an ambiguity on page two is not lost',async()=>{
  let page=0;
  const service={from(){const q:any={select(){return q;},eq(){return q;},order(){return q;},range(){return Promise.resolve({data:page++===0?Array.from({length:1000},()=>packageRow()):[packageRow(2,10)],error:null});}};return q;}};
  assert((await loadMarketplaceIdentity(service,'run')).size===0&&page===2);
});
Deno.test('Store order projection omits package tags, source IDs, queue errors and Internal event notes',()=>{
  const safe=projectStoreOrder({id:'order',mondayItemId:'hidden',canixSalesOrderId:'hidden',workflowError:'hidden',assignedUser:'hidden',
    lines:[{productId:'canix:item:1',quantity:1,unitPriceCents:100,tag:'hidden'}],events:[{toState:'approved',note:'hidden',actorEmail:'hidden',rawStatus:'hidden'}]});
  assert(!JSON.stringify(safe).includes('hidden'));
  assert((safe.lines as Record<string,unknown>[])[0].quantity===1);
});
