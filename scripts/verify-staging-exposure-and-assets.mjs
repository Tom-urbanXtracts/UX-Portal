// Isolated staging acceptance for public exposure and private-file boundaries.
// Never points at production and never prints credentials or signed URLs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {api,base,keychainPassword,keys,quote,sql} from './store-staging-support.mjs';

const workdir=process.argv[2];
assert(workdir?.startsWith('/tmp/ux-os-staging-20261014.'),'Pass the isolated staging workdir.');
const credential=keys();
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const results=[];
const query=value=>sql(workdir,value).trim();
const parse=value=>JSON.parse(query(value)||'null');

async function session(name){
  return api('/auth/v1/token?grant_type=password',{...credential,method:'POST',body:{
    email:'ux-staging-'+name+'@example.invalid',password:keychainPassword(name),
  }});
}
async function edge(name,{token=credential.anon,membership,organization,body={},method='POST'}={}){
  const headers={apikey:credential.anon,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  if(membership)headers['x-ux-membership-id']=membership;
  if(organization)headers['x-ux-organization-id']=organization;
  const response=await fetch(base+'/functions/v1/'+name,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers,
    body:method==='GET'?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
}
async function storage(path,{method='GET',token=credential.service,body,contentType='application/json'}={}){
  return fetch(base+'/storage/v1/'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{
    apikey:credential.service,Authorization:'Bearer '+token,'Content-Type':contentType,
  },body});
}
function pass(name){results.push(name);console.log('PASS: '+name);}

const admin=await session('admin'),buyer=await session('buyer');
const publicRelations=parse(`select coalesce(jsonb_agg(jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,
  'anon',has_table_privilege('anon',c.oid,'select,insert,update,delete'),
  'authenticated',has_table_privilege('authenticated',c.oid,'select,insert,update,delete')) order by c.relname),'[]')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m');`);
const tables=publicRelations.filter(row=>['r','p'].includes(row.kind));
assert(tables.length>=150,'Unexpectedly incomplete public schema.');
assert.equal(tables.filter(row=>!row.rls).length,0,'Every public table must have RLS.');
assert.equal(publicRelations.filter(row=>row.anon).length,0,'Anonymous table grants must remain empty.');
const browserTables=publicRelations.filter(row=>row.authenticated).map(row=>row.name).sort();
assert.deepEqual(browserTables,[
  'portal_brand_account','portal_organization','portal_organization_membership','portal_pending_profile','portal_profile',
  'portal_workspace_role_permission',
]);
pass(`${tables.length} public tables use RLS; browser table grants match the six-table login allowlist`);

const callable=parse(`select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
  'definer',p.prosecdef,'public',has_function_privilege('public',p.oid,'execute'),
  'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'))
  order by p.proname),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and (has_function_privilege('public',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute')
    or has_function_privilege('authenticated',p.oid,'execute'));`);
assert.equal(callable.some(row=>row.public||row.anon),false,'No public or anonymous function execution is allowed.');
assert.deepEqual(callable.filter(row=>row.authenticated).map(row=>row.name).sort(),[
  'portal_my_permissions','portal_my_workspace_permissions','portal_my_workspaces','portal_org','portal_role',
]);
pass('Public-function execution is limited to the five signed-in identity helpers');

const deployed=[
  'portal-admin','canix-catalog','portal-pricing','portal-intake','portal-orders','portal-order-policy',
  'quickbooks-financials','portal-claims','portal-notifications','portal-assets','portal-retailers','portal-store-demo',
  'portal-brand-onboarding','portal-brand-profile','portal-brand-operations','portal-brand-documents','portal-brand-support',
  'portal-brand-supply-chain','portal-internal-work','portal-work-queue','portal-kiosk','portal-sku-intake',
];
for(const name of deployed){
  const response=await edge(name,{body:{}});
  assert(response.status>=400,`${name} accepted an anonymous request (${response.status}).`);
}
assert.equal((await edge('portal-kiosk',{body:{action:'resolve',token:'invalid'}})).status,404);
assert.equal((await edge('portal-sku-intake',{body:{action:'resolve',token:'invalid'}})).status,404);
pass(`All ${deployed.length} deployed handlers reject anonymous access; public-token routes fail closed on invalid tokens`);

const assetCountBefore=query('select count(*) from portal_asset;');
const assetAttempt=await edge('portal-assets',{token:admin.access_token,membership:id(3),organization:id(2),body:{
  action:'create-upload',purpose:'product_image',ownerId:1,contentType:'image/png',sizeBytes:8,filename:'staging.png',
}});
assert.equal(assetAttempt.status,503,JSON.stringify(assetAttempt.body));
assert.equal(query('select count(*) from portal_asset;'),assetCountBefore,'Product-asset hold must not create an asset row.');
const pdf=Buffer.from('%PDF-1.4\n% UX staging clean document\n%%EOF\n');
const documentCountBefore=query('select count(*) from portal_brand_document;');
const documentTitle='UXSTAGE private document '+randomUUID();
const documentAttempt=await edge('portal-brand-documents',{token:buyer.access_token,membership:id(36),organization:id(23),body:{
  action:'upload',organizationId:id(23),category:'company',title:documentTitle,
  file:{name:'uxstage.pdf',contentType:'application/pdf',sizeBytes:pdf.length,base64:pdf.toString('base64')},
}});
assert.equal(documentAttempt.status,201,JSON.stringify(documentAttempt.body));
const scannedDocumentId=String(documentAttempt.body?.document?.id||'');
assert.match(scannedDocumentId,/^[0-9a-f-]{36}$/i,'Clean document upload did not return an ID.');
assert.equal(query('select count(*) from portal_brand_document;'),String(Number(documentCountBefore)+1));
const archiveScanned=await edge('portal-brand-documents',{token:admin.access_token,membership:id(3),organization:id(2),body:{
  action:'archive',organizationId:id(23),documentId:scannedDocumentId,
}});
assert.equal(archiveScanned.status,200,JSON.stringify(archiveScanned.body));
const scannedObjectPath=query(`select object_path from portal_brand_document where id=${quote(scannedDocumentId)};`);
if(scannedObjectPath){
  const removed=await storage('object/portal-brand-documents',{method:'DELETE',body:JSON.stringify({prefixes:[scannedObjectPath]})});
  assert(removed.ok,'Synthetic scanned-document cleanup failed with '+removed.status);
}
query(`delete from portal_brand_document where id=${quote(scannedDocumentId)};`);
assert.equal(query('select count(*) from portal_brand_document;'),documentCountBefore);
pass('Product images remain held while configured scanning accepts and archives a clean Brand document');

const bucket='portal-brand-documents',objectPath=`${id(23)}/rehearsal/${randomUUID()}.pdf`,documentId=randomUUID();
const bucketExisted=query(`select exists(select 1 from storage.buckets where id=${quote(bucket)});`)==='t';
let membershipDisabled=false,objectUploaded=false,documentInserted=false,signedUrl='';
try{
  query(`insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    values(${quote(bucket)},${quote(bucket)},false,62914560,array['application/pdf','image/png','image/jpeg','application/zip'])
    on conflict(id) do update set public=false;`);
  const upload=await storage('object/'+bucket+'/'+objectPath,{method:'POST',body:pdf,contentType:'application/pdf'});
  assert(upload.ok,'Synthetic private-object upload failed with '+upload.status);objectUploaded=true;
  const digest=createHash('sha256').update(pdf).digest('hex');
  query(`insert into portal_brand_document(id,organization_id,category,title,visibility,status,object_path,original_name,
    content_type,size_bytes,sha256,scan_state,scan_provider,uploaded_by,uploaded_by_email,version_number,version_label,
    related_type,related_id,reviewed_by,reviewed_by_email,reviewed_at)
    values(${quote(documentId)},${quote(id(23))},'company','UXSTAGE private download rehearsal','brand_and_internal','approved',
    ${quote(objectPath)},'uxstage-private.pdf','application/pdf',${pdf.length},${quote(digest)},'clean','synthetic-rehearsal',
    ${quote(buyer.user.id)},'ux-staging-buyer@example.invalid',1,'v1','brand',${quote(id(23))},${quote(admin.user.id)},
    'ux-staging-admin@example.invalid',now());`);documentInserted=true;
  for(const token of [credential.anon,buyer.access_token,admin.access_token]){
    const direct=await storage('object/authenticated/'+bucket+'/'+objectPath,{token});
    assert(!direct.ok,'Private object was directly readable with browser credentials.');
  }
  const download=await edge('portal-brand-documents',{token:buyer.access_token,membership:id(36),organization:id(23),body:{
    action:'download-document',organizationId:id(23),documentId,
  }});
  assert.equal(download.status,200,JSON.stringify(download.body));
  signedUrl=String(download.body.signedUrl||'');
  assert(signedUrl.startsWith(base+'/storage/v1/object/sign/'),'Unexpected signed URL host.');
  assert.equal((await fetch(signedUrl,{redirect:'error',signal:AbortSignal.timeout(30000)})).status,200);
  query(`update portal_organization_membership set status='disabled' where id=${quote(id(36))};`);membershipDisabled=true;
  const afterDisable=await edge('portal-brand-documents',{token:buyer.access_token,membership:id(36),organization:id(23),body:{
    action:'download-document',organizationId:id(23),documentId,
  }});
  assert.equal(afterDisable.status,403,JSON.stringify(afterDisable.body));
  assert.equal((await fetch(signedUrl,{redirect:'error',signal:AbortSignal.timeout(30000)})).status,200,
    'An already-issued five-minute signed URL is expected to remain usable until expiry or object removal.');
  pass('Private document access is server-authorized; membership revocation blocks new links and existing links stay bounded to five minutes');
}finally{
  if(membershipDisabled)query(`update portal_organization_membership set status='active' where id=${quote(id(36))};`);
  if(objectUploaded){
    const removed=await storage('object/'+bucket,{method:'DELETE',body:JSON.stringify({prefixes:[objectPath]})});
    if(!removed.ok)console.error('Cleanup warning: private object removal returned '+removed.status);
  }
  if(documentInserted)query(`delete from portal_brand_document where id=${quote(documentId)};`);
  if(!bucketExisted){
    const removedBucket=await storage('bucket/'+bucket,{method:'DELETE'});
    if(!removedBucket.ok)console.error('Cleanup warning: private bucket removal returned '+removedBucket.status);
  }
}
if(signedUrl){
  assert.equal(query(`select count(*) from storage.objects where bucket_id=${quote(bucket)} and name=${quote(objectPath)};`),'0',
    'Removed private object must be absent from the Storage origin.');
  // A URL fetched before deletion can remain in the CDN cache briefly. Probe a
  // cache-distinct URL to verify origin deletion without claiming CDN purge or
  // stronger revocation than the five-minute signed-link lifetime provides.
  const originProbe=new URL(signedUrl);
  originProbe.searchParams.set('uxstage_origin_probe',randomUUID());
  const removed=await fetch(originProbe,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),
    headers:{'Cache-Control':'no-cache'}});
  assert.notEqual(removed.status,200,'Removed object must not remain readable from the Storage origin.');
  pass('Removing the private object clears the origin; previously cached links remain bounded to five minutes');
}

assert.equal(query(`select status from portal_organization_membership where id=${quote(id(36))};`),'active');
assert.equal(query('select count(*) from portal_notification_outbox;'),'0');
assert.equal(query('select count(*) from portal_order_sync_outbox;'),'0');
assert.equal(query('select count(*) from cron.job;'),'0');
console.log(JSON.stringify({suite:'staging-exposure-and-assets',passed:results.length,productionDeployment:false}));
