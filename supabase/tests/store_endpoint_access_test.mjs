// Execute actual authentication adapters with synthetic DB/Auth responses.
// All external I/O except the fixture Auth response throws; no tokens or mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=new URL('../functions/',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const clean=source=>stripTypeScriptTypes(source.replace(/^import[\s\S]*?from\s*['"][^'"]+['"];\s*$/gm,'')
  .replace(/^export\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];\s*$/gm,'')).replace(/^export\s+/gm,'');
function module(path,deps,names){return runInNewContext(`(()=>{${clean(read(path))};return {${names.join(',')}};})()`,{...deps,Date,Intl,URL,Request,Response,Headers,console,crypto:webcrypto,atob,btoa});}
const store=module('_shared/store-context.ts',{},['resolveStoreContext','checkActor','StoreAccessError','revokeStoreMembership']);
const workspace=module('_shared/request-workspace.ts',store,['requestWorkspace','storeContext','storeRows','storeCommand']);
const auth=module('_shared/auth.ts',{},['verifiedTokenIsAuthenticated']);
const policy=module('_shared/store-account-policy.ts',{},['DEFAULT_PAYMENT_TERMS','effectivePaymentTerms','quickBooksFreshness','storeFinancialAccess']);
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const actor=uuid(1),membership=uuid(2),org=uuid(3),account=uuid(4);
function fixture({kind='internal',memberRole='administrator',status='active',enabled=true,rawRole='brand',grant=true,active=true}={}) {
  const tables={portal_profile:[{id:actor,active,role:rawRole,staff_role:'viewer',org:'Wrong legacy org',full_name:'Synthetic actor'}],
    portal_organization_membership:[{id:membership,profile_id:actor,organization_id:org,workspace:kind,member_role:memberRole,status}],
    portal_organization:[{id:org,kind:kind==='store'?'retailer':kind,status:'active',legal_name:'Verified org',legacy_retailer_account_id:account}],
    portal_retailer_account:[{id:account,organization_name:'Verified retailer'}],
    portal_store:[{license_number:'A1',retailer_account_id:account,active:true,closed_at:null,display_name:'Assigned A1'}],
    portal_role_permission:grant?['orders.manage','accounts.manage','pricing.manage','financials.read','claims.manage','notifications.manage','users.manage','catalog.manage'].map(permission=>({staff_role:'administrator',permission})):[],
  };
  const service={from(table){let rows=(tables[table]||[]).slice();const q={select(){return q;},order(){return q;},limit(){return q;},
    eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},is(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,vs){rows=rows.filter(r=>vs.includes(r[k]));return q;},
    maybeSingle(){return Promise.resolve({data:rows[0]||null,error:null});},then(a,b){return Promise.resolve({data:rows,error:null}).then(a,b);}};return q;},
    rpc(name,args){assert.equal(name,'portal_resolve_store_context');return Promise.resolve({data:enabled?{actorId:args.p_actor_id,membershipId:membership,organizationId:org,
      retailerAccountId:account,memberRole,licenses:['A1']}:null,error:enabled?null:{code:'42501'}});}};
  const user={id:actor,email:'fixture@example.invalid',app_metadata:{}};
  const token='fixture.'+btoa(JSON.stringify({sub:actor,role:'authenticated'}))+'.fixture';
  const request=(headers={})=>new Request('https://fixture.invalid/handler',{method:'POST',headers:{Authorization:'Bearer '+token,
    'Content-Type':'application/json','x-ux-membership-id':membership,'x-ux-organization-id':org,...headers},body:JSON.stringify({action:'unsupported',kind:'order',payload:{}})});
  const dependencies={...store,...workspace,...auth,...policy,createClient:()=>service,
    contentScannerConfigured:()=>false,configuredQuickBooksEnvironment:()=> 'sandbox',
    Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://fixture.invalid':'fixture'},serve:handler=>{dependencies.handler=handler;}},
    fetch:async url=>{assert.equal(String(url),'https://fixture.invalid/auth/v1/user','Unexpected outbound connection');return new Response(JSON.stringify(user));},
  };
  return {service,request,dependencies,tables};
}
const endpoints=[['portal-orders','callerFor'],['portal-order-policy','callerFor'],['portal-pricing','callerFor'],['quickbooks-financials','callerFor'],
  ['portal-claims','callerFor'],['portal-notifications','callerFor'],['portal-admin','actorFor'],['portal-intake','identity'],['canix-catalog','authenticate'],['portal-assets','callerFor'],['portal-retailers','callerFor'],['portal-license-document','callerFor']];
for(const endpoint of ['portal-brand-documents','portal-brand-support','portal-brand-supply-chain','portal-brand-onboarding','portal-brand-profile','portal-brand-operations','portal-internal-work']) {
  test(endpoint+': selected Store cannot borrow a legacy Internal Administrator profile',async()=>{
    const f=fixture({kind:'store',memberRole:'store_buyer',rawRole:'internal',enabled:false});
    f.tables.portal_profile[0].staff_role='administrator';
    f.tables.portal_organization.push({id:uuid(99),kind:'brand',status:'active',legal_name:'Other Brand'});
    const api=module(endpoint+'/index.ts',f.dependencies,['actorFor']);
    await assert.rejects(api.actorFor(f.request(),uuid(99)),error=>error.status===403);
  });
  test(endpoint+': a missing selected membership cannot restore legacy authority',async()=>{
    const f=fixture({rawRole:'internal'});f.tables.portal_profile[0].staff_role='administrator';
    f.tables.portal_organization.push({id:uuid(99),kind:'brand',status:'active',legal_name:'Other Brand'});
    const api=module(endpoint+'/index.ts',f.dependencies,['actorFor']);
    await assert.rejects(api.actorFor(f.request({'x-ux-membership-id':''}),uuid(99)),error=>error.status===403);
  });
}
for(const [endpoint,fn] of [['portal-work-queue','administratorFor'],['portal-kiosk','actorFor']]) {
  test(endpoint+': selected Internal Administrator is allowed',async()=>{
    const f=fixture(),api=module(endpoint+'/index.ts',f.dependencies,[fn]);
    assert(await api[fn](f.request()));
  });
  test(endpoint+': selected Store cannot borrow the legacy Internal profile',async()=>{
    const f=fixture({kind:'store',memberRole:'store_buyer',rawRole:'internal'});
    f.tables.portal_profile[0].staff_role='administrator';
    const api=module(endpoint+'/index.ts',f.dependencies,[fn]);
    await assert.rejects(api[fn](f.request()),error=>error.status===403);
  });
  test(endpoint+': missing selected membership fails closed',async()=>{
    const f=fixture({rawRole:'internal'});f.tables.portal_profile[0].staff_role='administrator';
    const api=module(endpoint+'/index.ts',f.dependencies,[fn]);
    await assert.rejects(api[fn](f.request({'x-ux-membership-id':''})),error=>error.status===403);
  });
}
test('portal-sku-intake: selected Store cannot borrow an independent Brand membership',async()=>{
  const f=fixture({kind:'store',memberRole:'store_buyer',rawRole:'brand'});
  const api=module('portal-sku-intake/index.ts',f.dependencies,['actorFor']);
  await assert.rejects(api.actorFor(f.request()),error=>error.status===403);
});
test('portal-sku-intake: selected Brand membership is retained as Brand scope',async()=>{
  const f=fixture({kind:'brand',memberRole:'brand_owner',rawRole:'internal'});
  const api=module('portal-sku-intake/index.ts',f.dependencies,['actorFor']);
  const result=await api.actorFor(f.request());
  assert.equal(result.actorType,'brand');
  assert.equal(result.profile._workspaceOrganizationId,org);
});
for(const [endpoint,fn] of endpoints) {
  const load=fixture=>module(endpoint+'/index.ts',fixture.dependencies,[fn]);
  const profile=result=>result?.profile||result;
  test(endpoint+': selected Internal membership derives current role, not legacy profile',async()=>{
    const f=fixture(),api=load(f),result=await api[fn](f.request());assert.equal(profile(result).role,'internal');assert.equal(profile(result).staff_role,'administrator');
  });
  test(endpoint+': forged or missing selected membership is denied',async()=>{
    for(const value of [uuid(99),'']){const f=fixture(),api=load(f);await assert.rejects(api[fn](f.request({'x-ux-membership-id':value})),e=>e instanceof store.StoreAccessError&&e.status===403);}
  });
  test(endpoint+': disabled membership is denied despite active Internal legacy profile',async()=>{
    const f=fixture({status:'disabled',rawRole:'internal'}),api=load(f);await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);
  });
  test(endpoint+': held Store context never borrows Internal legacy role',async()=>{
    const f=fixture({kind:'store',memberRole:endpoint==='portal-admin'?'store_owner':'store_buyer',enabled:false,rawRole:'internal'}),api=load(f);
    await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);
  });
  test(endpoint+': explicit Store scope is bounded or intentionally Internal-only',async()=>{
    const f=fixture({kind:'store',memberRole:endpoint==='portal-admin'?'store_owner':'store_buyer'}),api=load(f);
    if(['portal-assets','portal-retailers','portal-license-document'].includes(endpoint)){await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);return;}
    if(endpoint==='quickbooks-financials'){
      // Buyers receive ordering information only; the Account Owner reads own-account financials.
      await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);
      const owner=fixture({kind:'store',memberRole:'store_owner'}),p=profile(await load(owner)[fn](owner.request()));
      assert.equal(p.role,'owner');assert.equal(p._storeContext.retailerAccountId,account);return;
    }
    const p=profile(await api[fn](f.request()));assert.equal(p.role,endpoint==='portal-admin'?'owner':'buyer');assert.equal(p.org,'Verified retailer');assert.equal(p._storeContext.retailerAccountId,account);
  });
  test(endpoint+': real HTTP handler returns denial without source-system calls',async()=>{
    const f=fixture({status:'disabled'});load(f);const base=f.request();
    const request=['quickbooks-financials','canix-catalog'].includes(endpoint)?new Request(base.url,{headers:base.headers}):base;
    const response=await f.dependencies.handler(request);assert.equal(response.status,403);
    assert.equal(Object.keys(await response.json()).join(','),'error');
  });
}
test('Budtender can use only the education catalog adapter',async()=>{
  for(const [endpoint,fn] of endpoints){const f=fixture({kind:'store',memberRole:'store_staff'}),api=module(endpoint+'/index.ts',f.dependencies,[fn]);
    if(endpoint==='canix-catalog')assert.equal((await api[fn](f.request())).role,'budtender');
    else await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);
  }
});
test('Brand membership cannot authorize Store APIs or inherit Internal profile authority',async()=>{
  for(const [endpoint,fn] of endpoints.filter(([name])=>!['portal-admin','portal-notifications'].includes(name))){const f=fixture({kind:'brand',memberRole:'brand_owner',rawRole:'internal'}),api=module(endpoint+'/index.ts',f.dependencies,[fn]);
    await assert.rejects(api[fn](f.request()),e=>e instanceof store.StoreAccessError&&e.status===403);
  }
});
test('Accepted Store retry uses the private command and does not re-read mutable source stock',async()=>{
  const f=fixture({kind:'store',memberRole:'store_buyer'});
  const orderId=uuid(50),requestId=uuid(51);
  f.tables.portal_order=[{id:orderId,client_request_id:requestId,retailer_account_id:account,submitted_by:actor,
    workflow_state:'accepted',state:'ordered',order_number:'LOCAL-RETRY',order_value_cents:100}];
  const original=f.service.rpc;let commands=0;
  f.service.rpc=(name,args)=>{
    if(name!=='portal_store_command')return original(name,args);
    commands++;assert.equal(args.p_command,'order.create');assert.equal(args.p_membership_id,membership);
    assert.equal(args.p_payload.p_lines[0].quantity,1);
    return Promise.resolve({data:{id:orderId,created:false},error:null});
  };
  const api=module('portal-intake/index.ts',f.dependencies,['identity','retryAcceptedStoreOrder']);
  const profile=await api.identity(f.request());
  const result=await api.retryAcceptedStoreOrder({clientRequestId:requestId,portalReference:'LOCAL-RETRY',licenceNumber:'A1',
    lines:[{productId:'canix:item:1',quantity:1,unitPriceCents:100}]},profile);
  assert.equal(commands,1);assert.equal(result.idempotent,true);assert.equal(result.portalOrderId,orderId);
});
test('Accepted retry is denied when membership is revoked before the private command',async()=>{
  const f=fixture({kind:'store',memberRole:'store_buyer'}),orderId=uuid(50),requestId=uuid(51);
  f.tables.portal_order=[{id:orderId,client_request_id:requestId,retailer_account_id:account,submitted_by:actor,workflow_state:'accepted'}];
  const original=f.service.rpc;
  f.service.rpc=(name,args)=>name==='portal_store_command'?Promise.resolve({data:null,error:{code:'42501'}}):original(name,args);
  const api=module('portal-intake/index.ts',f.dependencies,['identity','retryAcceptedStoreOrder']),caller=await api.identity(f.request());
  await assert.rejects(api.retryAcceptedStoreOrder({clientRequestId:requestId,portalReference:'LOCAL-RETRY'},caller),e=>e instanceof store.StoreAccessError&&e.status===403);
});
test('An unreconciled durable Store order is never reported as accepted',async()=>{
  const f=fixture({kind:'store',memberRole:'store_buyer'}),orderId=uuid(50),requestId=uuid(51);
  f.tables.portal_order=[{id:orderId,client_request_id:requestId,retailer_account_id:account,submitted_by:actor,workflow_state:'pending'}];
  const original=f.service.rpc;
  f.service.rpc=(name,args)=>name==='portal_store_command'?Promise.resolve({data:{id:orderId,created:false},error:null}):original(name,args);
  const api=module('portal-intake/index.ts',f.dependencies,['identity','retryAcceptedStoreOrder']),caller=await api.identity(f.request());
  await assert.rejects(api.retryAcceptedStoreOrder({clientRequestId:requestId,portalReference:'LOCAL-RETRY'},caller),/needs reconciliation/);
});
test('Legacy Store administration is held before any global Auth mutation',async()=>{
  for(const kind of ['internal','store'])for(const action of ['invite-user','update-user','invite-onboarding-person']) {
    const f=fixture({kind,memberRole:kind==='internal'?'administrator':'store_owner'});
    module('portal-admin/index.ts',f.dependencies,['actorFor']);
    const response=await f.dependencies.handler(new Request(f.request(),{body:JSON.stringify({action,email:'not-sent@example.invalid'})}));
    assert.equal(response.status,409);assert.match((await response.json()).error,/held/);
  }
});
test('Internal Viewer cannot borrow Administrator grants from the legacy profile',async()=>{
  const f=fixture({memberRole:'viewer',rawRole:'internal'});
  const api=module('portal-admin/index.ts',f.dependencies,['actorFor']);
  assert.equal((await api.actorFor(f.request())).staff_role,'viewer');
  const response=await f.dependencies.handler(new Request(f.request(),{body:JSON.stringify({action:'list-users'})}));
  assert.equal(response.status,403);assert.match((await response.json()).error,/Administrator/);
});
test('Store templates and invoice notices are held before recipient lookup, quota or provider use',async()=>{
  const f=fixture();f.tables.portal_notification_template=[{template_key:'store_welcome',approval_state:'approved',audience:'store'}];
  const api=module('portal-notifications/index.ts',f.dependencies,['callerFor','sendTemplate','sendInvoiceNotice']);
  const caller=await api.callerFor(f.request());
  await assert.rejects(api.sendTemplate(caller,{templateKey:'store_welcome',recipientProfileId:uuid(90)}),/held/);
  await assert.rejects(api.sendInvoiceNotice(caller,{}),/held/);
});
test('Retrying a stored Store email holds the row without taking quota or contacting Resend',async()=>{
  const f=fixture();let changed;
  const original=f.service.from;
  f.service.from=table=>{
    if(table!=='portal_notification_outbox')throw Error('Unexpected recipient/provider lookup');
    const q={update(value){changed=value;return q;},eq(){return q;},select(){return q;},single(){return Promise.resolve({data:changed,error:null});}};
    return q;
  };
  const api=module('portal-notifications/index.ts',f.dependencies,['deliver']);
  assert.equal((await api.deliver({id:uuid(91),audience:'store'},{audience:'store'})).state,'held_policy');
  f.service.from=original;
});
test('Scoped membership administration forwards server Auth eligibility, never browser-provided eligibility',async()=>{
  const f=fixture(),target=uuid(40),targetOrg=uuid(41);
  f.tables.portal_organization_membership.push({id:uuid(42),profile_id:target,organization_id:targetOrg,workspace:'store',member_role:'store_owner',status:'active'});
  f.service.auth={admin:{getUserById:async id=>({data:{user:{id,app_metadata:id===target?{portal_access_expires_on:'2000-01-01'}:{},
    user_metadata:{portal_access_expires_on:'2099-01-01'}}},error:null})}};
  const original=f.service.rpc;let proof;
  f.service.rpc=(name,args)=>{
    if(name!=='portal_manage_store_membership')return original(name,args);
    proof=args;return Promise.resolve({data:{globalAccountChanged:false},error:null});
  };
  const api=module('portal-admin/index.ts',f.dependencies,['actorFor','manageStoreAccess']),actorProfile=await api.actorFor(f.request());
  await api.manageStoreAccess(actorProfile,{organizationId:targetOrg,profileId:target,memberRole:'store_owner',status:'active',licenses:[],reason:'Synthetic test',requestId:uuid(43),
    p_actor_id:uuid(99),p_verified_identities:[{id:target,eligible:true}],app_metadata:{portal_access_expires_on:'2099-01-01'}});
  assert.equal(proof.p_actor_id,actor);assert.equal(proof.p_actor_membership_id,membership);
  assert.equal(proof.p_verified_identities.find(row=>row.id===target).eligible,false);
});
test('Store Owner and Internal Viewer cannot invoke scoped membership writes',async()=>{
  for(const options of [{kind:'store',memberRole:'store_owner'},{kind:'internal',memberRole:'viewer'}]){
    const f=fixture(options),api=module('portal-admin/index.ts',f.dependencies,['actorFor','manageStoreAccess']),actorProfile=await api.actorFor(f.request());
    await assert.rejects(api.manageStoreAccess(actorProfile,{}),/Only an Internal Administrator/);
  }
});
test('Workspace permission HTTP response is bound to selected Viewer membership',async()=>{
  const f=fixture({memberRole:'viewer',rawRole:'internal'});module('portal-admin/index.ts',f.dependencies,['actorFor']);
  const response=await f.dependencies.handler(new Request(f.request(),{body:JSON.stringify({action:'workspace-permissions'})}));
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.memberRole,'viewer');assert.equal(result.permissions.length,0);
});
test('Mismatched Auth identity cannot supply Store membership eligibility',async()=>{
  const f=fixture();f.service.auth={admin:{getUserById:async()=>({data:{user:{id:uuid(99),app_metadata:{}}},error:null})}};
  const api=module('portal-admin/index.ts',f.dependencies,['actorFor','manageStoreAccess']),actorProfile=await api.actorFor(f.request());
  await assert.rejects(api.manageStoreAccess(actorProfile,{organizationId:uuid(41),profileId:uuid(40),memberRole:'store_owner',status:'active',licenses:[],reason:'Synthetic test',requestId:uuid(43)}),/eligibility could not be verified/);
});
test('Authorized billing user reads own-account financials only and every other Store API denies it',async()=>{
  const f=fixture({kind:'store',memberRole:'store_billing'});
  const p=await module('quickbooks-financials/index.ts',f.dependencies,['callerFor']).callerFor(f.request());
  assert.equal(p.profile.role,'billing');assert.equal(p.profile._storeContext.retailerAccountId,account);assert.equal(p.internal,false);
  for(const [endpoint,fn] of endpoints.filter(([name])=>name!=='quickbooks-financials')){
    const g=fixture({kind:'store',memberRole:'store_billing'}),api=module(endpoint+'/index.ts',g.dependencies,[fn]);
    await assert.rejects(api[fn](g.request()),e=>e instanceof store.StoreAccessError&&e.status===403,endpoint);
  }
});
test('Final onboarding approval calls only the atomic, state-bound database operation',async()=>{
  const f=fixture(),calls=[];module('portal-retailers/index.ts',f.dependencies,['callerFor']);
  f.service.rpc=(name,args)=>{calls.push([name,args]);return Promise.resolve({data:{id:uuid(70),stage:'ready'},error:null});};
  const send=body=>f.dependencies.handler(new Request(f.request(),{body:JSON.stringify(body)}));
  const response=await send({action:'advance-onboarding',requestId:uuid(70),targetStage:'ready',currentStage:'access',note:'All sections and licenses verified'});
  assert.equal(response.status,200);
  assert.deepEqual(calls.map(([name])=>name),['portal_complete_store_onboarding']);
  assert.equal(JSON.stringify(calls[0][1]),JSON.stringify({p_actor_id:actor,p_request_id:uuid(70),p_expected_stage:'access',p_evidence:'All sections and licenses verified',p_actor_email:'fixture@example.invalid'}));
  // Earlier stages keep the one-step advance and never write an approval.
  calls.length=0;await send({action:'advance-onboarding',requestId:uuid(70),targetStage:'access',note:'Terms recorded'});
  assert.deepEqual(calls.map(([name])=>name),['portal_advance_onboarding_request']);
  // A database refusal of the atomic operation surfaces as a denial, not a partial success.
  f.service.rpc=()=>Promise.resolve({data:null,error:{code:'42501',message:'Compliance, Finance or an Internal portal Administrator must approve onboarding'}});
  assert.equal((await send({action:'advance-onboarding',requestId:uuid(70),targetStage:'ready',currentStage:'access',note:'x'})).status,403);
});
test('License verification forwards a document UUID and never free-text document references',async()=>{
  const f=fixture(),calls=[];module('portal-retailers/index.ts',f.dependencies,['callerFor']);
  f.service.rpc=(name,args)=>{calls.push([name,args]);return Promise.resolve({data:{result:'verified'},error:null});};
  const send=body=>f.dependencies.handler(new Request(f.request(),{body:JSON.stringify({action:'verify-store-license',licenseNumber:'A1',result:'verified',
    licenseExpiresOn:'2027-10-15',evidence:'Checked OCM record',requestId:uuid(70),...body})}));
  assert.equal((await send({documentId:uuid(80)})).status,200);
  assert.equal(calls[0][0],'portal_verify_store_license');assert.equal(calls[0][1].p_document_id,uuid(80));assert.equal('p_document_ref' in calls[0][1],false);
  for(const documentId of ['DOC-A1','',undefined,'00000000-0000-4000-8000-00000000008z']){
    calls.length=0;const response=await send({documentId,documentRef:'DOC-A1'});
    assert.equal(response.status,400,String(documentId));assert.equal(calls.length,0);
  }
});
// License document links: database authorization and audit first, then a short-lived signed URL only.
const docs={[uuid(80)]:{account,scan:'clean',request:uuid(70)},[uuid(81)]:{account:uuid(5),scan:'clean',request:uuid(71)},
  [uuid(82)]:{account,scan:'pending_provider',request:uuid(70)},[uuid(83)]:{account,scan:'clean',request:uuid(70),forgedPath:true}};
const sha='a'.repeat(64);
function licenseFixture(options,internalRoles={administrator:'administrator',operations:'finance',quality:'compliance'}){
  const f=fixture(options),calls=[],signed=[];const resolve=f.service.rpc;
  f.service.rpc=(name,args)=>{
    if(name==='portal_resolve_store_context')return resolve(name,args);
    calls.push([name,args]);assert.equal(name,'portal_authorize_license_document');
    const d=docs[args.p_document_id];
    const internalRole=args.p_membership_id===null?internalRoles[options?.memberRole||'administrator']:null;
    const ownerOk=args.p_membership_id===membership&&(options?.memberRole==='store_owner')&&d?.account===account;
    if(!d||d.scan!=='clean'||!(internalRole||ownerOk))return Promise.resolve({data:null,error:{code:'42501'}});
    const path=d.forgedPath?'../other/'+sha+'.pdf':d.request+'/'+sha+'.pdf';
    return Promise.resolve({data:{documentId:args.p_document_id,onboardingRequestId:d.request,sha256:sha,objectPath:path,originalName:'license.pdf',contentType:'application/pdf'},error:null});
  };
  f.service.storage={from:bucket=>({createSignedUrl:(path,ttl,opts)=>{signed.push({bucket,path,ttl,opts});
    return Promise.resolve({data:{signedUrl:`https://fixture.invalid/storage/v1/object/sign/${bucket}/${path}?token=signed`},error:null});}})};
  const api=module('portal-license-document/index.ts',f.dependencies,['callerFor','issueLicenseDocumentLink']);
  return {...f,calls,signed,api};
}
test('License documents: owning Account Owner and Internal Compliance, Finance and Administrator receive a 60-second signed link after audit',async()=>{
  for(const options of [{kind:'store',memberRole:'store_owner'},{memberRole:'administrator'},{memberRole:'operations'},{memberRole:'quality'}]){
    const f=licenseFixture(options),caller=await f.api.callerFor(f.request());
    const link=await f.api.issueLicenseDocumentLink(caller,{action:'issue',documentId:uuid(80),access:'download'});
    assert.equal(f.calls.length,1,'authorization/audit RPC runs exactly once');
    assert.equal(f.calls[0][1].p_actor_id,actor);assert.equal(f.calls[0][1].p_membership_id,options.kind==='store'?membership:null);
    assert.equal(JSON.stringify(f.signed),JSON.stringify([{bucket:'portal-onboarding-documents',path:uuid(70)+'/'+sha+'.pdf',ttl:60,opts:{download:'license.pdf'}}]));
    assert.equal(link.expiresInSeconds,60);assert.match(link.signedUrl,/\/storage\/v1\/object\/sign\/portal-onboarding-documents\/.*[?&]token=/);
    assert.equal(JSON.stringify(link).includes('objectPath'),false);assert.equal('path' in link,false);
  }
});
test('License documents: Buyer, Budtender and billing users are denied before any database document lookup',async()=>{
  for(const memberRole of ['store_buyer','store_staff','store_billing']){
    const f=licenseFixture({kind:'store',memberRole});
    await assert.rejects(f.api.callerFor(f.request()),e=>e instanceof store.StoreAccessError&&e.status===403,memberRole);
    assert.equal(f.calls.length,0);assert.equal(f.signed.length,0);
  }
});
test('License documents: other account, Sales, guessed ID, dirty scan and forged path never produce a link',async()=>{
  const cases=[[{kind:'store',memberRole:'store_owner'},uuid(81)],[{kind:'store',memberRole:'store_owner'},uuid(900)],
    [{kind:'store',memberRole:'store_owner'},uuid(82)],[{memberRole:'administrator'},uuid(83)],[{memberRole:'sales'},uuid(80)],[{memberRole:'viewer'},uuid(80)]];
  for(const [options,documentId] of cases){
    const f=licenseFixture(options),caller=await f.api.callerFor(f.request());
    await assert.rejects(f.api.issueLicenseDocumentLink(caller,{action:'issue',documentId,access:'read'}),e=>e.status===403,documentId);
    assert.equal(f.signed.length,0,'no URL is signed on denial');
  }
});
test('License documents: forged membership and browser-supplied paths are rejected without signing',async()=>{
  const f=licenseFixture({kind:'store',memberRole:'store_owner'});
  await assert.rejects(f.api.callerFor(f.request({'x-ux-membership-id':uuid(99)})),e=>e instanceof store.StoreAccessError&&e.status===403);
  const caller=await f.api.callerFor(f.request());
  for(const body of [{action:'issue',documentId:uuid(80),objectPath:'a/doc.pdf'},{action:'issue',documentId:uuid(80),path:'x'},
    {action:'issue',documentId:uuid(80),membershipId:uuid(99)},{action:'issue',documentId:'DOC-A1'},{action:'issue',documentId:uuid(80),access:'delete'}]){
    await assert.rejects(f.api.issueLicenseDocumentLink(caller,body),e=>e.status===400,JSON.stringify(body));
  }
  assert.equal(f.calls.length,0);assert.equal(f.signed.length,0);
  // An unsigned or foreign URL from storage fails closed.
  f.service.storage={from:()=>({createSignedUrl:()=>Promise.resolve({data:{signedUrl:'https://fixture.invalid/storage/v1/object/public/portal-onboarding-documents/x.pdf'},error:null})})};
  await assert.rejects(f.api.issueLicenseDocumentLink(caller,{action:'issue',documentId:uuid(80)}),e=>e.status===503);
});
