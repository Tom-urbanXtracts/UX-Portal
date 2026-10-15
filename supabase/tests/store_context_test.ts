import { resolveStoreContext as resolveVerified, revokeStoreMembership, StoreAccessError, type StoreContextSource, type StoreAction } from '../functions/_shared/store-context.ts';
import { storeCommand } from '../functions/_shared/request-workspace.ts';
const actor='00000000-0000-4000-8000-000000000001', membership='00000000-0000-4000-8000-000000000002';
const organization='00000000-0000-4000-8000-000000000003', account='00000000-0000-4000-8000-000000000004';
const foreign='00000000-0000-4000-8000-000000000005';
function assert(v: unknown): asserts v { if (!v) throw new Error('Assertion failed'); }
const fixture=(overrides: Record<string,unknown> = {}) => ({ actorId:actor,membershipId:membership,organizationId:organization,
  retailerAccountId:account,memberRole:'store_buyer',licenses:['A1'],...overrides });
const source=(row: unknown): StoreContextSource => ({ rpc:()=>Promise.resolve({data:row,error:null}) });
const selection=(action: StoreAction='orders.read', license: unknown='A1') => ({ membershipId:membership,organizationId:organization,license,action });
const resolveStoreContext=(s:StoreContextSource,id:string,choice:Parameters<typeof resolveVerified>[2]) => resolveVerified(s,{id,app_metadata:{}},choice);
async function rejects(fn:()=>Promise<unknown>,status=403) {
  try { await fn(); } catch(e) { assert(e instanceof StoreAccessError && e.status===status); return; }
  throw new Error('Expected denial');
}
Deno.test('Store context uses only explicit authenticated actor and selected membership parameters',async()=>{
  let args: Record<string,unknown>={}; let name='';
  const s: StoreContextSource={rpc:(n,p)=>{name=n;args=p;return Promise.resolve({data:fixture(),error:null});}};
  const c=await resolveStoreContext(s,actor,selection());
  assert(name==='portal_resolve_store_context' && args.p_actor_id===actor && args.p_membership_id===membership);
  assert(Object.keys(args).length===2 && c.licenses[0]==='A1');
});
Deno.test('Missing and invalid identity or workspace selection has no legacy profile fallback',async()=>{
  await rejects(()=>resolveStoreContext(source(fixture()),'',selection()),401);
  await rejects(()=>resolveStoreContext(source(fixture()),actor,{...selection(),membershipId:undefined}));
  await rejects(()=>resolveStoreContext(source(fixture()),actor,{...selection(),organizationId:'Retailer name'}));
});
Deno.test('Forged actor, organization, membership and unsupported roles are denied',async()=>{
  for(const patch of [{actorId:foreign},{membershipId:foreign},{organizationId:foreign},{retailerAccountId:null},
    {memberRole:'administrator'},{memberRole:'brand_owner'},{memberRole:'store_manager'},{memberRole:'toString'}]) {
    await rejects(()=>resolveStoreContext(source(fixture(patch)),actor,selection()));
  }
});
Deno.test('Buyer may read and order only an assigned location, never approve Buyer orders',async()=>{
  for(const action of ['catalog.read','inventory.quantity.read','orders.read','orders.submit'] as StoreAction[]) {
    await resolveStoreContext(source(fixture()),actor,selection(action));
    await rejects(()=>resolveStoreContext(source(fixture()),actor,selection(action,'A2')));
  }
  await rejects(()=>resolveStoreContext(source(fixture()),actor,selection('orders.approve')));
  await rejects(()=>resolveStoreContext(source(fixture()),actor,selection('users.read')));
});
Deno.test('Buyer receives ordering information only: every financial read is denied',async()=>{
  await rejects(()=>resolveStoreContext(source(fixture()),actor,selection('financials.read')));
  await rejects(()=>resolveStoreContext(source(fixture()),actor,{...selection('financials.read'),license:undefined}));
  await rejects(()=>resolveStoreContext(source(fixture()),actor,{...selection('financials.read'),assignedCollection:true}));
});
Deno.test('Owner may use its organization locations but no foreign location',async()=>{
  const s=source(fixture({memberRole:'store_owner',licenses:['A1','A2']}));
  await resolveStoreContext(s,actor,selection('orders.approve','A2'));
  await resolveStoreContext(s,actor,{...selection('financials.read'),license:undefined});
  await rejects(()=>resolveStoreContext(s,actor,selection('orders.submit','B1')));
  await rejects(()=>resolveStoreContext(s,actor,{...selection('orders.submit'),license:undefined}));
});
Deno.test('Budtender receives only one-store education and cannot use commercial/admin actions',async()=>{
  const s=source(fixture({memberRole:'store_staff'}));
  await resolveStoreContext(s,actor,selection('education.read'));
  for(const action of ['catalog.read','inventory.quantity.read','orders.read','orders.submit','orders.approve','financials.read','users.read'] as StoreAction[]) {
    await rejects(()=>resolveStoreContext(s,actor,selection(action)));
  }
  for(const licenses of [[],['A1','A2']]) await rejects(()=>resolveStoreContext(source(fixture({memberRole:'store_staff',licenses})),actor,selection('education.read')));
});
Deno.test('Malformed or empty assignments never grant access',async()=>{
  for(const licenses of [null,{},[''],[null],[]]) await rejects(()=>resolveStoreContext(source(fixture({licenses})),actor,selection()));
});
Deno.test('Database outages, missing schema and disabled/revoked membership fail closed',async()=>{
  for(const code of ['42501','42P01','XX000']) await rejects(()=>resolveStoreContext({rpc:()=>Promise.resolve({data:null,error:{code}})},actor,selection()),code==='42501'?403:503);
  await rejects(()=>resolveStoreContext({rpc:()=>Promise.reject(new Error('offline'))},actor,selection()),503);
  await rejects(()=>resolveStoreContext(source(null),actor,selection()));
});
Deno.test('Every request re-resolves current membership rather than reusing a prior success',async()=>{
  let calls=0;
  const s: StoreContextSource={rpc:()=>{calls++;return Promise.resolve(calls===1?{data:fixture(),error:null}:{data:null,error:{code:'42501'}});}};
  await resolveStoreContext(s,actor,selection());
  await rejects(()=>resolveStoreContext(s,actor,selection())); assert(calls===2);
});
Deno.test('Context is immutable and only includes allowlisted authorization fields',async()=>{
  const row=fixture({internalNotes:'hidden',quickbooksToken:'hidden'});
  const c=await resolveStoreContext(source(row),actor,selection());
  assert(!('internalNotes' in c) && !('quickbooksToken' in c) && Object.isFrozen(c) && Object.isFrozen(c.licenses));
  row.licenses.push('B1'); assert(c.licenses.length===1);
});
Deno.test('Role permissions cannot be combined with another workspace or forged runtime action',async()=>{
  await rejects(()=>resolveStoreContext(source(fixture()),actor,selection('users.manage' as StoreAction)));
  await rejects(()=>resolveStoreContext(source(fixture({memberRole:'brand_owner'})),actor,selection()));
});
Deno.test('Server-owned contractor expiration is enforced through the Eastern calendar day',async()=>{
  const now=new Date('2026-10-15T02:00:00Z'); // Still October 14 in New York.
  await resolveVerified(source(fixture()),{id:actor,app_metadata:{portal_access_expires_on:'2026-10-14'}},selection(),now);
  for(const expiry of ['2026-10-13','bad','2030-02-31',123]) await rejects(()=>resolveVerified(source(fixture()),{id:actor,app_metadata:{portal_access_expires_on:expiry}},selection(),now));
  await rejects(()=>resolveVerified(source(fixture()),{id:actor,app_metadata:{portal_access_expires_on:'2026-10-14'}},selection(),new Date('2026-10-15T05:00:00Z')));
});
Deno.test('Order commit maps only the explicit manual hold to a customer-safe hold response',async()=>{
  const profile={id:actor,role:'buyer',_storeContext:fixture()};
  const service=(code:string)=>({rpc:()=>Promise.resolve({data:null,error:{code}}),from:()=>null});
  try { await storeCommand(service('UXH01'),profile,'order.create',{}); throw new Error('Expected hold'); }
  catch(e) { assert(e instanceof StoreAccessError && e.status===409 && /on hold/.test(e.message) && /draft is preserved/.test(e.message)
    && !/past due|overdue|balance|credit|finance/i.test(e.message)); }
  // Other database outcomes keep their existing meaning.
  const result=await storeCommand(service('23514'),profile,'order.create',{});
  assert((result.error as {code:string}).code==='23514');
});
Deno.test('Order commit maps an unverified or expired license to a distinct customer-safe pause',async()=>{
  const profile={id:actor,role:'buyer',_storeContext:fixture()};
  const service=(code:string)=>({rpc:()=>Promise.resolve({data:null,error:{code}}),from:()=>null});
  let paused='';
  try { await storeCommand(service('UXL01'),profile,'order.create',{}); throw new Error('Expected pause'); }
  catch(e) { assert(e instanceof StoreAccessError && e.status===409 && /license/i.test(e.message) && /draft is preserved/.test(e.message)); paused=(e as Error).message; }
  try { await storeCommand(service('UXH01'),profile,'order.create',{}); } catch(e) { assert((e as Error).message!==paused && !/license/i.test((e as Error).message)); }
});
Deno.test('Authorized billing user reads only own-account financials; it cannot order, approve, administer or open license documents',async()=>{
  const billing=fixture({memberRole:'store_billing',licenses:['A1','A2']});
  // Account-level financial read needs no location selection, like the Account Owner.
  const c=await resolveStoreContext(source(billing),actor,{...selection('financials.read'),license:undefined});
  assert(c.memberRole==='store_billing' && c.retailerAccountId===account);
  await resolveStoreContext(source(billing),actor,{...selection('financials.read'),license:undefined,assignedCollection:true});
  await rejects(()=>resolveStoreContext(source(billing),actor,{...selection('financials.read'),license:'FOREIGN'}));
  for(const action of ['orders.read','orders.submit','orders.approve','users.read','catalog.read','inventory.quantity.read','pricing.read','pricing.propose',
    'policy.read','claims.read','claims.submit','notifications.read','education.read','license_documents.read'] as StoreAction[]) {
    await rejects(()=>resolveStoreContext(source(billing),actor,selection(action)));
    await rejects(()=>resolveStoreContext(source(billing),actor,{...selection(action),license:undefined,assignedCollection:true}));
  }
  // Billing in another retailer's context still resolves only that retailer's account.
  await rejects(()=>resolveStoreContext(source(fixture({memberRole:'store_billing',organizationId:foreign})),actor,{...selection('financials.read'),license:undefined}));
});
Deno.test('License documents are an Account Owner action only',async()=>{
  await resolveStoreContext(source(fixture({memberRole:'store_owner',licenses:['A1','A2']})),actor,{...selection('license_documents.read'),license:undefined});
  for(const memberRole of ['store_buyer','store_staff','store_billing']) {
    await rejects(()=>resolveStoreContext(source(fixture({memberRole})),actor,{...selection('license_documents.read'),license:undefined}));
  }
});
Deno.test('Revocation adapter binds verified actor, requires reason and maps last-Owner denial',async()=>{
  const request={actorMembershipId:membership,targetMembershipId:foreign,reason:'Member left the Store'};
  const auth={id:actor,app_metadata:{}};
  let captured:Record<string,unknown>={};
  await revokeStoreMembership({rpc:(name,p)=>{assert(name==='portal_revoke_store_membership');captured=p;return Promise.resolve({data:{membershipId:foreign,status:'disabled'},error:null});}},auth,request);
  assert(captured.p_actor_id===actor && captured.p_actor_membership_id===membership);
  await rejects(()=>revokeStoreMembership(source(null),auth,{...request,reason:''}),400);
  await rejects(()=>revokeStoreMembership({rpc:()=>Promise.resolve({data:null,error:{code:'23514'}})},auth,request),409);
  await rejects(()=>revokeStoreMembership({rpc:()=>Promise.resolve({data:null,error:{code:'42501'}})},auth,request));
  await rejects(()=>revokeStoreMembership(source(null),auth,request),503);
});
