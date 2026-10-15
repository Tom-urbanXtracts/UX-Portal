// Real Supabase Auth + deployed candidate handlers + staging SQL only.
// Mutations are confined to synthetic .invalid identities; Store access is
// restored to disabled even when an assertion fails. No email/source writes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keys,api,base,sql,keychainPassword} from './store-staging-support.mjs';
const workdir=process.argv[2],credential=keys(),sessions={};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const results=[];
async function check(name,run){try{await run();results.push({name,pass:true});console.log('PASS: '+name);}
  catch(error){results.push({name,pass:false,error:error.message});console.log('FAIL: '+name+': '+error.message);}}
for(const name of ['admin','viewer','owner','buyer','budtender','replacement']){
  sessions[name]=await api('/auth/v1/token?grant_type=password',{...credential,method:'POST',
    body:{email:'ux-staging-'+name+'@example.invalid',password:keychainPassword(name)}});
  assert.equal(sessions[name].user.app_metadata.ux_staging,true);
}
async function call(endpoint,name,membership,organization,body,method='POST'){
  const response=await fetch(base+'/functions/v1/'+endpoint,{method,redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{apikey:credential.anon,Authorization:'Bearer '+sessions[name].access_token,'Content-Type':'application/json',
      'x-ux-membership-id':id(membership),'x-ux-organization-id':id(organization)},
    body:method==='GET'?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
}
const admin=body=>call('portal-admin','admin',3,2,body);
await check('Real sign-in grants Administrator only through its selected membership',async()=>{
  const r=await admin({action:'workspace-permissions'});assert.equal(r.status,200);assert(r.body.permissions.includes('users.manage'));
  const viewer=await call('portal-admin','viewer',4,2,{action:'workspace-permissions'});assert.equal(viewer.status,200);
  assert(!viewer.body.permissions.includes('users.manage'));
});
await check('Forged membership and Viewer administration are denied',async()=>{
  assert.equal((await call('portal-admin','admin',999,2,{action:'list-store-access'})).status,403);
  assert.equal((await call('portal-admin','viewer',4,2,{action:'list-store-access'})).status,403);
});
await check('Store demo remains Internal Administrator-only',async()=>{
  for(const [name,membership,org] of [['owner',30,20],['buyer',32,20],['budtender',35,20],['viewer',4,2]])
    assert.equal((await call('portal-store-demo',name,membership,org,{action:'get'})).status,403,name+' received demo access');
});
await check('Paused Store endpoint cannot borrow the legacy Internal profile',async()=>{
  assert.equal((await call('portal-admin','admin',34,20,{action:'list-store-access'})).status,403);
});
try{
  sql(workdir,'update public.portal_store_access_control set enabled=true where id;');
  const directory=async()=>{const r=await admin({action:'list-store-access',organizationId:id(20)});assert.equal(r.status,200);return r.body;};
  await check('Existing-account role/location save, retry and scoped disable/reactivation',async()=>{
    let member=(await directory()).members.find(row=>row.id===id(32));assert(member);
    const body={action:'manage-store-access',organizationId:id(20),profileId:member.profile_id,membershipId:member.id,
      expectedUpdatedAt:member.updated_at,memberRole:'store_staff',licenses:['STAGING-A2'],status:'active',
      reason:'Synthetic staging real-Auth acceptance',requestId:randomUUID()};
    const saved=await admin(body);assert.equal(saved.status,200,JSON.stringify(saved.body));
    assert.equal((await admin(body)).status,200,'An exact retry failed');
    member=(await directory()).members.find(row=>row.id===id(32));assert.equal(member.member_role,'store_staff');
    assert.deepEqual(member.licenses,['STAGING-A2']);
    assert.equal((await admin({...body,expectedUpdatedAt:member.updated_at,status:'disabled',requestId:randomUUID()})).status,200);
    assert.equal((await call('portal-admin','buyer',32,20,{action:'list-users'})).status,403);
    member=(await directory()).members.find(row=>row.id===id(32));
    assert.equal((await admin({...body,expectedUpdatedAt:member.updated_at,memberRole:'store_buyer',licenses:['STAGING-A1'],requestId:randomUUID()})).status,200);
  });
  await check('Last eligible Owner cannot be demoted',async()=>{
    const member=(await directory()).members.find(row=>row.id===id(30));
    const r=await admin({action:'manage-store-access',organizationId:id(20),profileId:member.profile_id,membershipId:member.id,
      expectedUpdatedAt:member.updated_at,memberRole:'store_buyer',licenses:['STAGING-A1'],status:'active',reason:'Synthetic sole-Owner denial',requestId:randomUUID()});
    assert.equal(r.status,409);assert.match(r.body.error,/eligible replacement Owner/);
  });
  await check('Older Brand and Internal handlers deny selected Store context',async()=>{
    for(const endpoint of ['portal-brand-documents','portal-brand-support','portal-brand-supply-chain','portal-brand-onboarding',
      'portal-brand-profile','portal-brand-operations','portal-internal-work']){
      const r=await call(endpoint,'admin',34,20,{action:'get',organizationId:id(23)});
      assert.equal(r.status,403,endpoint+' accepted selected Store context (HTTP '+r.status+')');
    }
  });
  await check('Brand membership reads documents without Internal review authority',async()=>{
    const brand=await call('portal-brand-documents','admin',33,23,{action:'get',organizationId:id(23)});
    assert.equal(brand.status,200,JSON.stringify(brand.body));assert.equal(brand.body.capabilities.canReview,false);
    const internal=await call('portal-brand-documents','admin',3,2,{action:'get',organizationId:id(23)});
    assert.equal(internal.status,200);assert.equal(internal.body.capabilities.canReview,true);
  });
}finally{sql(workdir,'update public.portal_store_access_control set enabled=false where id;');}
console.log(JSON.stringify({suite:'real-auth-staging',passed:results.filter(row=>row.pass).length,failed:results.filter(row=>!row.pass),
  productionDeployment:false,storeAccessRestoredToDisabled:true}));
if(results.some(row=>!row.pass))process.exitCode=1;
