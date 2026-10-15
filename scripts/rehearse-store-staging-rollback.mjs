// Rehearses the supported Store release rollback in isolated staging:
// pause access and workflow, preserve additive schema/history, verify denial,
// and leave the Administrator-only demo available. No production operations.
import assert from 'node:assert/strict';
import {api,base,keychainPassword,keys,quote,sql} from './store-staging-support.mjs';

const workdir=process.argv[2];
assert(workdir?.startsWith('/tmp/ux-os-staging-20261014.'),'Pass the isolated staging workdir.');
const credential=keys(),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const query=value=>sql(workdir,value).trim();
const parse=value=>JSON.parse(query(value));
const before=parse(`select jsonb_build_object(
  'access',(select to_jsonb(a) from portal_store_access_control a where id),
  'workflow',(select to_jsonb(w) from portal_workflow_control w where workflow_key='store_orders'),
  'orders',(select count(*) from portal_order),'orderLines',(select count(*) from portal_order_line),
  'events',(select count(*) from portal_order_event),'workItems',(select count(*) from portal_work_item),
  'workEvents',(select count(*) from portal_work_item_event),'claims',(select count(*) from portal_receiving_claim),
  'shopProducts',(select count(*) from canix_marketplace_product_snapshot),
  'notifications',(select count(*) from portal_notification_outbox),'monday',(select count(*) from portal_order_sync_outbox),
  'cron',(select count(*) from cron.job),'vault',(select count(*) from vault.secrets));`);
assert.equal(before.access.enabled,false,'Rollback rehearsal must begin with Store access disabled.');
assert.equal(before.workflow.mode,'hold','Rollback rehearsal must begin with Store ordering held.');
assert.equal(query("select count(*) from portal_order where portal_reference not like 'UXSTAGE-%';"),'0');

const sessions={};
for(const name of ['admin','owner','viewer'])sessions[name]=await api('/auth/v1/token?grant_type=password',{...credential,method:'POST',body:{
  email:'ux-staging-'+name+'@example.invalid',password:keychainPassword(name),
}});
async function call(endpoint,name,membership,organization,body){
  const response=await fetch(base+'/functions/v1/'+endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{
    apikey:credential.anon,Authorization:'Bearer '+sessions[name].access_token,'Content-Type':'application/json',
    'x-ux-membership-id':id(membership),'x-ux-organization-id':id(organization),
  },body:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
}

try{
  // Simulate the release being live only for the synthetic staging identities.
  query(`begin;
    update portal_store_access_control set enabled=true,updated_at=now() where id;
    update portal_workflow_control set mode='portal',change_note='UXSTAGE rollback rehearsal: temporary activation' where workflow_key='store_orders';
    commit;`);
  const active=await call('portal-orders','owner',30,20,{action:'rollback-probe'});
  assert.equal(active.status,400,JSON.stringify(active.body));

  // Supported rollback is a feature pause, not a destructive down migration.
  query(`begin;
    update portal_store_access_control set enabled=false,updated_at=now() where id;
    update portal_workflow_control set mode='hold',change_note='UXSTAGE rollback rehearsal: Store access paused before artifact restore'
      where workflow_key='store_orders';
    commit;`);
  const paused=await call('portal-orders','owner',30,20,{action:'rollback-probe'});
  assert.equal(paused.status,403,JSON.stringify(paused.body));
  const adminDemo=await call('portal-store-demo','admin',3,2,{action:'read',role:'owner'});
  assert.equal(adminDemo.status,200,JSON.stringify(adminDemo.body));
  for(const [name,membership,organization] of [['owner',30,20],['viewer',4,2]]){
    const denied=await call('portal-store-demo',name,membership,organization,{action:'read',role:'owner'});
    assert.equal(denied.status,403,name+' received demo access during rollback');
  }
  console.log('PASS: Store access and ordering pause atomically before artifact restoration.');
  console.log('PASS: The paused release denies Store users while the Internal Administrator demo remains available.');
}finally{
  // Safety pause is committed independently so a later metadata-restore error
  // can never leave Store access enabled.
  query('update portal_store_access_control set enabled=false,updated_at=now() where id;');
  query(`begin;
    update portal_store_access_control set enabled=${before.access.enabled?'true':'false'},
      updated_at=${quote(before.access.updated_at)}::timestamptz where id;
    update portal_workflow_control set mode=${quote(before.workflow.mode)},monday_retention=${quote(before.workflow.monday_retention)},
      change_note=${quote(before.workflow.change_note)},changed_by=${quote(before.workflow.changed_by)}::uuid,
      changed_by_email=${quote(before.workflow.changed_by_email)},changed_at=${quote(before.workflow.changed_at)}::timestamptz
      where workflow_key='store_orders';
    commit;`);
}

const after=parse(`select jsonb_build_object(
  'access',(select enabled from portal_store_access_control where id),
  'workflow',(select mode from portal_workflow_control where workflow_key='store_orders'),
  'orders',(select count(*) from portal_order),'orderLines',(select count(*) from portal_order_line),
  'events',(select count(*) from portal_order_event),'workItems',(select count(*) from portal_work_item),
  'workEvents',(select count(*) from portal_work_item_event),'claims',(select count(*) from portal_receiving_claim),
  'shopProducts',(select count(*) from canix_marketplace_product_snapshot),
  'notifications',(select count(*) from portal_notification_outbox),'monday',(select count(*) from portal_order_sync_outbox),
  'cron',(select count(*) from cron.job),'vault',(select count(*) from vault.secrets));`);
assert.equal(after.access,false);
assert.equal(after.workflow,'hold');
for(const key of ['orders','orderLines','events','workItems','workEvents','claims','shopProducts','notifications','monday','cron','vault']){
  assert.equal(Number(after[key]),Number(before[key]),key+' changed during rollback rehearsal');
}
console.log('PASS: Additive schema and all durable order, audit, claim, Shop, outbox, schedule, and Vault counts were preserved.');
console.log(JSON.stringify({suite:'store-staging-rollback',passed:3,productionDeployment:false,storeAccess:false,
  administratorDemoOnly:true,destructiveDownMigration:false}));
