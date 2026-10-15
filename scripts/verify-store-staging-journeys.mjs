// Real Auth, real deployed handlers and full staging schema. Synthetic data
// only for order journeys; restores the supervised Shop snapshot and holds.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keys,api,base,sql,quote,keychainPassword} from './store-staging-support.mjs';
const workdir=process.argv[2],credential=keys(),sessions={},results=[];
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const run=randomUUID(),shopRun=randomUUID(),prefix='UXSTAGE-'+randomUUID().slice(0,8)+'-';
const query=q=>sql(workdir,q).trim();
const saved=JSON.parse(query(`select jsonb_build_object(
'canix',(select coalesce(jsonb_agg(s),'[]') from canix_sync_state s),
'shop',(select coalesce(jsonb_agg(s),'[]') from canix_marketplace_sync_state s),
'stores',(select jsonb_agg(s) from portal_store s where license_number in ('STAGING-A1','STAGING-A2')),
'account',(select to_jsonb(a) from portal_retailer_account a where id='${id(21)}'),
'claimsPolicy',(select coalesce(jsonb_agg(p),'[]') from portal_receiving_claim_policy p),
'workflow',(select coalesce(jsonb_agg(w),'[]') from portal_workflow_control w where workflow_key='store_orders'));`));
assert.equal(query("select count(*) from portal_order where portal_reference not like 'UXSTAGE-%';"),'0','Run only on synthetic order staging');
assert.equal(query('select count(*) from canix_package_current;'),'0','Do not replace connected physical inventory');
for(const name of ['admin','owner','buyer','budtender']){
  sessions[name]=await api('/auth/v1/token?grant_type=password',{...credential,method:'POST',
    body:{email:'ux-staging-'+name+'@example.invalid',password:keychainPassword(name)}});
  assert.equal(sessions[name].user.app_metadata.ux_staging,true);
}
async function call(endpoint,name,body,method='POST',license){
  const membership={admin:3,owner:30,buyer:32,budtender:35}[name];
  const response=await fetch(base+'/functions/v1/'+endpoint+(license?'?license='+encodeURIComponent(license):''),
    {method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{apikey:credential.anon,
      Authorization:'Bearer '+sessions[name].access_token,'Content-Type':'application/json',
      'x-ux-membership-id':id(membership),'x-ux-organization-id':id(name==='admin'?2:20)},
      body:method==='GET'?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
}
async function check(name,fn){await fn();results.push(name);console.log('PASS: '+name);}
const make=(name='buyer',lines=[{productId:'canix:item:99000001',quantity:2,unitPriceCents:100},
  {productId:'canix:item:99000002',quantity:1,unitPriceCents:200}],license='STAGING-A1')=>
  ({name,body:{kind:'order',payload:{clientRequestId:randomUUID(),portalReference:prefix+randomUUID().slice(0,8),
    licenceNumber:license,lines,receivingInstructions:'Synthetic staging acceptance only'}}});
const send=order=>call('portal-intake',order.name,order.body);
const expect=(r,status)=>assert.equal(r.status,status,JSON.stringify(r.body));
const transition=(orderId,targetState,name='admin')=>call('portal-orders',name,{action:'transition',orderId,targetState});
let firstId;
try{
  query(`begin;
  update portal_store_access_control set enabled=true where id;
  insert into quickbooks_customer_cache(quickbooks_customer_id,display_name,active,balance) values('STAGING-QB','Synthetic QB identity',true,0);
  insert into portal_receiving_claim_policy(id,policy_state,claim_window_days,initial_response_business_days,
    evidence_required_for,approved_at,decision_note) values(1,'active_approved',5,2,array['short','damaged','wrong_item'],now(),
    'Synthetic test configuration following repository policy; not a new live approval') on conflict(id) do nothing;
  update portal_store set license_status='active',license_expires_on=current_date+365,qualified_at=now(),
    ordering_status='ready',quickbooks_customer_id='STAGING-QB',approval_threshold_cents=300
    where license_number in ('STAGING-A1','STAGING-A2');
  update portal_retailer_account set portal_status='ready_to_order',quickbooks_customer_id='STAGING-QB' where id='${id(21)}';
  insert into portal_workflow_control(workflow_key,display_name,mode,change_note)
    values('store_orders','Synthetic Store journey','portal','Temporary staging acceptance')
    on conflict(workflow_key) do update set mode='portal';
  insert into canix_sync_state(id,status,last_successful_run_id,last_successful_at) values(1,'success','${run}',now())
    on conflict(id) do update set status='success',last_successful_run_id='${run}',last_successful_at=now();
  update canix_marketplace_sync_state set last_successful_run_id='${shopRun}',last_successful_at=now(),status='success',snapshot_scope='full_shop' where id=1;
  insert into canix_marketplace_product_snapshot(sync_run_id,shop_slug,marketplace_product_id,product_gid,product_name,brand_name,price_cents)
    values('${shopRun}','urbanXtracts','99000011','synthetic-1','Synthetic Product One','Synthetic Brand',100),
      ('${shopRun}','urbanXtracts','99000012','synthetic-2','Synthetic Product Two','Synthetic Brand',200);
  insert into canix_package_current(package_id,item_id,product_id,item_name,product_name,brand_name,quantity_type,
    facility_id,status_category,weight,orderable_units,lab_test_status,test_result_status,sync_run_id,source_payload,is_finished_good,reservation_state)
    values(99000021,99000001,99000011,'Synthetic Product One','Synthetic Product One','Synthetic Brand','CountBased',4467,'available',20,20,'TestPassed','TestPassed','${run}','{"synthetic":true}',true,'known'),
    (99000022,99000002,99000012,'Synthetic Product Two','Synthetic Product Two','Synthetic Brand','CountBased',4467,'available',20,20,'TestPassed','TestPassed','${run}','{"synthetic":true}',true,'known');
  insert into portal_package_lot_control(package_id,sync_run_id,lot_id,integrity_status,allocation_eligible,detail)
    values(99000021,'${run}','STAGING-LOT','valid',true,'Synthetic test proof, not business approval'),
    (99000022,'${run}','STAGING-LOT','valid',true,'Synthetic test proof, not business approval');
  commit;`);
  await check('Full-schema multi-item checkout, commitments and accepted retry',async()=>{
    const order=make(),r=await send(order);expect(r,200);firstId=r.body.portalOrderId;assert(firstId);
    assert.equal(r.body.ownerApprovalRequired,true);
    assert.equal(query(`select state from portal_order where id='${firstId}';`),'awaiting_owner_approval');
    const repeat=await send(order);expect(repeat,200);assert.equal(repeat.body.portalOrderId,firstId);
    assert.equal(query(`select count(*) from portal_order_line where order_id='${firstId}';`),'2');
    assert.equal(query(`select count(*) from portal_inventory_commitment where order_id='${firstId}' and active;`),'2');
  });
  await check('Buyer cannot approve; Owner approval then Internal processing/delivery',async()=>{
    expect(await transition(firstId,'ordered','buyer'),403);
    expect(await transition(firstId,'ordered','owner'),200);
    expect(await transition(firstId,'delivered'),403);
    for(const state of ['approved','processed','delivered'])expect(await transition(firstId,state),200);
    assert.equal(query(`select count(*) from portal_inventory_commitment where order_id='${firstId}' and active;`),'0');
  });
  await check('Current prices, location scope and Budtender ordering fail closed',async()=>{
    expect(await send(make('buyer',[{productId:'canix:item:99000001',quantity:1,unitPriceCents:101}])),409);
    expect(await send(make('buyer',undefined,'STAGING-A2')),403);
    expect(await send(make('budtender')),403);
  });
  await check('Five-minute physical inventory expiry and recovery',async()=>{
    query("update canix_sync_state set last_successful_at=now()-interval '6 minutes';");
    expect(await send(make()),503);
    query('update canix_sync_state set last_successful_at=now();');
    expect(await send(make('owner',[{productId:'canix:item:99000001',quantity:1,unitPriceCents:100}])),200);
  });
  await check('Shop outage preserves its snapshot but blocks new submissions',async()=>{
    query("update canix_marketplace_sync_state set status='error',last_error='Synthetic outage';");
    expect(await send(make()),503);
    assert.equal(query(`select count(*) from canix_marketplace_product_snapshot where sync_run_id='${shopRun}';`),'2');
    query("update canix_marketplace_sync_state set status='success',last_error=null;");
  });
  await check('Preorder accepted with fulfillment held until passing release',async()=>{
    query("update canix_package_current set lab_test_status='NotSubmitted',test_result_status='NotSubmitted' where package_id=99000022;");
    const r=await send(make('owner',[{productId:'canix:item:99000002',quantity:1,unitPriceCents:200}]));expect(r,200);
    assert.equal(r.body.releaseHold,true);expect(await transition(r.body.portalOrderId,'approved'),200);
    expect(await transition(r.body.portalOrderId,'processed'),409);
    query("update canix_package_current set lab_test_status='TestPassed',test_result_status='TestPassed' where package_id=99000022;");
    expect(await transition(r.body.portalOrderId,'processed'),200);
    expect(await transition(r.body.portalOrderId,'delivered'),200);
  });
  await check('Receiving claim is scoped to delivered order and assigned location',async()=>{
    const line=Number(query(`select min(id) from portal_order_line where order_id='${firstId}';`));
    const body={action:'create',orderId:firstId,orderLineId:line,claimType:'other',quantity:1,narrative:'Synthetic receiving issue'};
    expect(await call('portal-claims','buyer',body),201);
    expect(await call('portal-claims','budtender',body),403);
    expect(await call('portal-claims','buyer',{...body,claimType:'damaged'}),400);
  });
  await check('Direct Data API cannot read or mutate protected records',async()=>{
    for(const token of [credential.anon,sessions.admin.access_token,sessions.owner.access_token,sessions.buyer.access_token]){
      for(const table of ['portal_order','portal_order_line','portal_store','canix_marketplace_product_snapshot','portal_store_membership_change']){
        const response=await fetch(base+'/rest/v1/'+table+'?select=*',{headers:{apikey:credential.anon,Authorization:'Bearer '+token}});
        assert([401,403].includes(response.status),table+' unexpectedly reachable '+response.status);
      }
      const response=await fetch(base+'/rest/v1/rpc/portal_store_command',{method:'POST',
        headers:{apikey:credential.anon,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({p_actor_id:sessions.owner.user.id,
          p_membership_id:id(30),p_organization_id:id(20),p_command:'order.create',p_payload:{}})});
      assert([401,403].includes(response.status),'Private command reachable '+response.status);
    }
  });
  await check('Portal-native tests create no email or Monday outbox',async()=>{
    assert.equal(query('select count(*) from portal_notification_outbox;'),'0');
    assert.equal(query('select count(*) from portal_order_sync_outbox;'),'0');
    assert.equal(query('select count(*) from cron.job;'),'0');
  });
}catch(error){console.error('JOURNEY FAILURE: '+error.message);throw error;}finally{
  // Pause in its own committed statement even if later fixture cleanup fails.
  query('update portal_store_access_control set enabled=false where id;');
  // SQL before teardown checks owns exactly the synthetic fixture identifiers.
  query(`begin;
  update portal_store_access_control set enabled=false where id;
  -- Retain append-only workflow evidence and its order rather than bypassing
  -- immutable-history triggers. Terminal transitions release commitments.
  update portal_order set state='declined' where portal_reference like ${quote(prefix+'%')} and state='awaiting_owner_approval';
  update portal_order set state='canceled' where portal_reference like ${quote(prefix+'%')} and state in ('ordered','approved');
  -- A processed synthetic test order is retained as evidence, not deleted.
  update portal_order set state='delivered' where portal_reference like ${quote(prefix+'%')} and state='processed';
  delete from portal_package_lot_control where sync_run_id='${run}';
  delete from canix_package_current where sync_run_id='${run}' and source_payload->>'synthetic'='true';
  delete from canix_marketplace_product_snapshot where sync_run_id='${shopRun}';
  delete from canix_sync_state where id=1;
  insert into canix_sync_state select * from jsonb_populate_recordset(null::canix_sync_state,${quote(JSON.stringify(saved.canix))});
  delete from canix_marketplace_sync_state where id=1;
  insert into canix_marketplace_sync_state select * from jsonb_populate_recordset(null::canix_marketplace_sync_state,${quote(JSON.stringify(saved.shop))});
  update portal_store s set license_status=b.license_status,license_expires_on=b.license_expires_on,qualified_at=b.qualified_at,
    ordering_status=b.ordering_status,quickbooks_customer_id=b.quickbooks_customer_id,approval_threshold_cents=b.approval_threshold_cents
    from jsonb_populate_recordset(null::portal_store,${quote(JSON.stringify(saved.stores))}) b where s.license_number=b.license_number;
  update portal_retailer_account set portal_status=${quote(saved.account.portal_status)},quickbooks_customer_id=${quote(saved.account.quickbooks_customer_id)} where id='${id(21)}';
  delete from quickbooks_customer_cache where quickbooks_customer_id='STAGING-QB';
  delete from portal_receiving_claim_policy where id=1;
  insert into portal_receiving_claim_policy select * from jsonb_populate_recordset(null::portal_receiving_claim_policy,${quote(JSON.stringify(saved.claimsPolicy))});
  update portal_workflow_control set mode='hold',change_note='Synthetic staging acceptance only; ordering held' where workflow_key='store_orders';
  update portal_workflow_control w set mode=b.mode,change_note=b.change_note
    from jsonb_populate_recordset(null::portal_workflow_control,${quote(JSON.stringify(saved.workflow))}) b where w.workflow_key=b.workflow_key;
  commit;`);
  console.log('RESTORED: Store access disabled; supervised Shop snapshot retained; temporary source fixtures removed; synthetic workflow evidence retained.');
}
console.log(JSON.stringify({suite:'full-schema-staging-journeys',passed:results.length,productionDeployment:false}));
