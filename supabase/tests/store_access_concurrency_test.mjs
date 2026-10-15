// Disposable PostgreSQL only. Never accepts a database URL or production key.
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image='postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
const container='ux-store-access-test-'+randomUUID().slice(0,8);
const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sql(input,name='store-test') {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i','-e','PGAPPNAME='+name,container,'psql','-h','127.0.0.1','-U','postgres','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']);
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err.trim())));child.stdin.end(input);
  });
}
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const admin=id(1),adminM=id(3),owner=id(10),owner2=id(11),buyer=id(12),org=id(20),account=id(21),ownerM=id(30),owner2M=id(31),buyerM=id(32);
const revoke=target=>`select portal_revoke_store_membership('${admin}','${adminM}','${target}','Local concurrency acceptance');`;
const price=()=>`select portal_store_command('${buyer}','${buyerM}','${org}','price.propose','{"location_license":"LOCAL-A1","product_id":"canix:item:1","product_name":"Local only","proposed_price_cents":100}');`;
async function held(name) {
  for(let i=0;i<100;i++){
    if(await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep';`)==='1')return;
    await wait(20);
  }
  throw Error('Concurrent transaction did not reach the expected barrier');
}
let started=false;
try {
  execFileSync('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image],{stdio:'pipe'});started=true;
  for(let i=0;i<100;i++) {try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'pipe'});break;}catch{if(i===99)throw Error('Local PostgreSQL did not start');await wait(100);}}
  const inventory=read('supabase/migrations/20260901250000_security_and_inventory_commitments.sql');
  const lots=read('supabase/migrations/20260902070000_inbound_lot_integrity.sql');
  const triggerStart=lots.indexOf('create or replace function public.portal_commit_order_line_inventory()');
  const triggerEnd=lots.indexOf('\n$$;',triggerStart)+4;
  await sql(read('supabase/tests/store_access_local_schema.sql')
    +`create table public.portal_pending_profile (
      email text primary key, full_name text not null, org text not null,
      role text not null, locations text, added_by text,
      created_at timestamptz not null default now());
      alter table auth.users
        add column raw_user_meta_data jsonb not null default '{}'::jsonb;
      alter table public.portal_profile add column locations text;
      alter table public.portal_organization
        add column created_at timestamptz not null default now();
      create unique index portal_organization_membership_scope_unique
        on public.portal_organization_membership(profile_id,organization_id,workspace);`
    +read('supabase/migrations/20260901150000_durable_portal_orders.sql')
    +inventory.slice(0,inventory.indexOf('create or replace function public.portal_release_terminal_inventory_commitments()'))
    +lots.slice(triggerStart,triggerEnd)+read('supabase/migrations/20261014215429_store_membership_access_foundation.sql')
    +read('supabase/migrations/20261014220938_store_endpoint_access_commands.sql')
    +read('supabase/migrations/20261014223749_store_membership_administration.sql')
    +read('supabase/migrations/20261015003000_provision_workforce_workspace_membership.sql'));
  await sql('begin;'+read('supabase/tests/store_context_database_test.sql'));
  console.log('PASS: rollback-only Store context database suite');
  await sql(`insert into auth.users(id,email) values('${owner}','owner@example.invalid'),('${owner2}','owner2@example.invalid'),('${buyer}','buyer@example.invalid');
    insert into portal_profile(id,full_name,org,role,active)
      select id,'Local fixture','Legacy name must not authorize','brand',true from auth.users where id in ('${owner}','${owner2}','${buyer}')
      on conflict(id) do update set full_name=excluded.full_name,org=excluded.org,role=excluded.role,active=excluded.active;
    insert into portal_retailer_account values('${account}','Local retailer','Local retailer','ready_to_order');
    insert into portal_organization values('${org}','retailer','Local retailer','Local retailer','active','${account}');
    insert into portal_store(license_number,organization,display_name,retailer_account_id,active) values('LOCAL-A1','Local retailer','A1','${account}',true);
    insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values
    ('${ownerM}','${owner}','${org}','store','store_owner','active'),('${owner2M}','${owner2}','${org}','store','store_owner','active'),('${buyerM}','${buyer}','${org}','store','store_buyer','active');
    insert into portal_membership_store values('${buyerM}','LOCAL-A1',now());update portal_store_access_control set enabled=true;`);
  // Read authorization succeeded before revocation. Commit must re-authorize.
  await sql(`select portal_resolve_store_context('${buyer}','${buyerM}');`);
  let first=sql('begin;'+revoke(buyerM)+'select pg_sleep(1);commit;','revoke-first');
  await held('revoke-first');
  await assert.rejects(sql(price(),'late-mutation'),/42501/);await first;
  assert.equal(await sql('select count(*) from portal_price_proposal;'),'0');
  console.log('PASS: revocation wins over a waiting previously authorized mutation');
  await sql(`update portal_organization_membership set status='active' where id='${buyerM}';`);
  first=sql('begin;'+price()+'select pg_sleep(1);commit;','mutation-first');await held('mutation-first');
  const second=sql(revoke(buyerM),'revoke-second');await first;await second;
  assert.equal(await sql('select count(*) from portal_price_proposal;'),'1');
  console.log('PASS: accepted mutation is retained before subsequent revocation');
  first=sql('begin;'+revoke(ownerM)+'select pg_sleep(1);commit;','owner-first');await held('owner-first');
  await assert.rejects(sql(revoke(owner2M),'owner-second'),/23514/);await first;
  assert.equal(await sql(`select count(*) from portal_organization_membership where organization_id='${org}' and member_role='store_owner' and status='active';`),'1');
  console.log('PASS: concurrent Owner removals cannot remove the last active Owner');
  await sql(`update portal_organization_membership set status='active' where id='${buyerM}';`);
  first=sql("begin;update portal_store_access_control set enabled=false;select pg_sleep(1);commit;",'pause-first');await held('pause-first');
  await assert.rejects(sql(price(),'pause-waiter'),/42501/);await first;
  console.log('PASS: pause committed before a waiting mutation blocks it');
  await sql('update portal_store_access_control set enabled=true;');
  first=sql(`begin;delete from portal_membership_store where membership_id='${buyerM}';select pg_sleep(1);commit;`,'assignment-first');await held('assignment-first');
  await assert.rejects(sql(price(),'assignment-waiter'),/42501/);await first;
  console.log('PASS: removed location assignment blocks a waiting mutation');
  assert.equal(await sql(`select count(*) from portal_profile where id='${buyer}' and active and role='brand';`),'1');
  console.log('PASS: scoped revocation leaves independent global/Brand identity unchanged');
  // Actual legacy durable order/line/event/commitment functions above, not stubs.
  await sql(`update portal_organization_membership set status='active' where id='${buyerM}';
    insert into portal_membership_store values('${buyerM}','LOCAL-A1',now());
    update portal_store set license_status='active',license_expires_on=current_date+365,ordering_status='ready',approval_threshold_cents=300;
    insert into canix_sync_state values(1,now(),'${id(50)}');
    insert into canix_marketplace_sync_state values(1,'${id(51)}',now(),'success','full_shop');
    insert into canix_package_current values(1,'${id(50)}',4467,1,10,'CountBased','available',10,10,1,'TestPassed',null,null),
      (2,'${id(50)}',4467,2,11,'CountBased','available',7,7,1,'TestPassed',null,null);
    insert into canix_marketplace_product_snapshot values('${id(51)}','10',100),('${id(51)}','11',200);`);
  const payload=(requestId,lines)=>({p_client_request_id:requestId,p_portal_reference:'LOCAL-'+requestId,p_location_license:'LOCAL-A1',
    p_location_name:'A1',p_submitted_by_email:'buyer@example.invalid',p_order_value_cents:lines.reduce((sum,l)=>sum+l.quantity*l.unitPriceCents,0),
    p_contains_preorder:false,p_release_hold:false,p_lines:lines.map(l=>({...l,product:'Local fixture',unit:'each',lineTotalCents:l.quantity*l.unitPriceCents})),p_metadata:{synthetic:true}});
  const create=p=>`select portal_store_command('${buyer}','${buyerM}','${org}','order.create','${JSON.stringify(p)}');`;
  const cart=payload(id(60),[{productId:'canix:item:1',quantity:2,unitPriceCents:100},{productId:'canix:item:2',quantity:1,unitPriceCents:200}]);
  const created=JSON.parse(await sql(create(cart)));
  assert.equal(created.state,'awaiting_owner_approval');
  assert.equal(JSON.parse(await sql(create(cart))).id,created.id);
  assert.equal(await sql(`select count(*) from portal_order_line where order_id='${created.id}';`),'2');
  assert.equal(await sql(`select count(*) from portal_inventory_commitment where order_id='${created.id}' and active;`),'2');
  console.log('PASS: multi-item cart, current Store threshold, durable lines, commitments and idempotent retry');
  const transition=who=>`select portal_store_command('${who==='buyer'?buyer:owner2}','${who==='buyer'?buyerM:owner2M}','${org}','order.transition',
    '{"p_order_id":"${created.id}","p_expected_state":"awaiting_owner_approval","p_target_state":"ordered"}');`;
  await assert.rejects(sql(transition('buyer')),/42501/);await sql(transition('owner'));
  assert.equal(await sql('select count(*) from portal_order_sync_outbox;'),'0');
  console.log('PASS: Owner approval, Buyer denial and no Monday handoff');
  const oldPrice=payload(id(61),[{productId:'canix:item:2',quantity:1,unitPriceCents:200}]);
  await sql("insert into portal_store_price(location_license,product_id,price_cents) values('LOCAL-A1','canix:item:2',250);");
  await assert.rejects(sql(create(oldPrice)),/40001/);
  console.log('PASS: a price change between draft validation and commit preserves the order count');
  await sql("update canix_sync_state set last_successful_at=now()-interval '6 minutes';");
  await assert.rejects(sql(create(payload(id(62),[{productId:'canix:item:1',quantity:1,unitPriceCents:100}]))),/40001/);
  await sql('update canix_sync_state set last_successful_at=now();');
  console.log('PASS: five-minute source gate rechecked inside the order transaction');
  first=sql('begin;'+create(payload(id(63),[{productId:'canix:item:1',quantity:5,unitPriceCents:100}]))+'select pg_sleep(1);commit;','stock-first');
  await held('stock-first');
  await assert.rejects(sql(create(payload(id(64),[{productId:'canix:item:1',quantity:5,unitPriceCents:100}]))),/40001/);await first;
  assert.equal(await sql("select sum(quantity) from portal_inventory_commitment where product_id='canix:item:1' and active;"),'7');
  await sql(create(payload(id(63),[{productId:'canix:item:1',quantity:5,unitPriceCents:100}])));
  assert.equal(await sql("select sum(quantity) from portal_inventory_commitment where product_id='canix:item:1' and active;"),'7');
  console.log('PASS: concurrent orders cannot oversell the facility after existing commitments');
  console.log('PASS: retry returns the accepted order even when the remaining quantity is lower than that order');
  await assert.rejects(sql(create({...cart,p_receiving_instructions:'Changed retry payload'})),/40001/);
  console.log('PASS: reusing an accepted request ID with changed instructions is rejected');
  await sql(`update portal_order set canix_sales_order_id=99 where client_request_id='${id(63)}';
    update canix_package_current set weight=7,orderable_units=7 where package_id=1;
    insert into canix_package_current values(3,'${id(50)}',4467,1,10,'CountBased','allocated',3,0,1,'TestPassed',null,99),
      (4,'${id(50)}',9999,1,10,'CountBased','allocated',999,0,1,'TestPassed',null,99);`);
  assert.equal(await sql(`select portal_store_available_units(1,'${id(50)}');`),'3');
  console.log('PASS: linked allocation coverage avoids double reservation and excludes other facilities');
  await assert.rejects(sql(create(payload(id(65),[{productId:'canix:item:1',quantity:2,unitPriceCents:100},
    {productId:'canix:item:1',quantity:2,unitPriceCents:100}]))),/40001/);
  console.log('PASS: duplicate SKU lines are checked against their combined quantity');
  await sql(`insert into canix_package_current values(5,'${id(50)}',4467,3,10,'CountBased','available',1,1,1,'TestPassed',null,null);`);
  await assert.rejects(sql(create(payload(id(66),[{productId:'canix:item:1',quantity:1,unitPriceCents:100}]))),/40001/);
  await sql('update canix_package_current set weight=0,orderable_units=0 where package_id=5;');
  await sql(create(payload(id(66),[{productId:'canix:item:1',quantity:1,unitPriceCents:100}])));
  console.log('PASS: positive-stock historical aliases block identity; zero-stock aliases do not');
  await sql(`update portal_profile set role='brand',staff_role=null where id='${admin}';
    insert into auth.users(id,email) values('${id(70)}','replacement@example.invalid');
    insert into portal_profile(id,full_name,org,role,active,staff_role) values('${id(70)}','Replacement','Independent Brand','brand',true,null)
      on conflict(id) do update set full_name=excluded.full_name,org=excluded.org,role=excluded.role,active=excluded.active,staff_role=excluded.staff_role;`);
  const proof=[admin,owner,owner2,buyer,id(70)].map(id=>({id,eligible:true,expiresOn:null}));
  const updated=member=>sql(`select updated_at from portal_organization_membership where id='${member}';`);
  const manage=({person,member=null,role='store_buyer',licenses=['LOCAL-A1'],status='active',expected=null,request=id(80),identities=proof,actor=admin,actorM=adminM,organization=org,verifiedAt='clock_timestamp()'})=>
    `select portal_manage_store_membership('${actor}','${actorM}','${organization}','${person}',${member?`'${member}'`:'null'},'${role}',
    array[${licenses.map(v=>`'${v}'`).join(',')}]::text[],'${status}',${expected?`'${expected}'`:'null'},'Synthetic scoped administration','${request}','${JSON.stringify(identities)}',${verifiedAt});`;
  const add=manage({person:id(70)}),added=JSON.parse((await sql('begin;set local role service_role;'+add+'commit;')).split('\n').find(row=>row.startsWith('{')));
  assert.equal(added.globalAccountChanged,false);assert.equal(added.emailSent,false);
  assert.equal(JSON.parse(await sql(add)).idempotent,true);
  assert.equal(await sql(`select count(*) from portal_admin_audit where detail->>'requestId'='${id(80)}';`),'1');
  assert.equal(await sql(`select role||':'||active from portal_profile where id='${id(70)}';`),'brand:true');
  console.log('PASS: existing-account Store grant, request retry and audit preserve independent global/Brand identity');
  await assert.rejects(sql(manage({person:id(70),member:added.membershipId,expected:'2000-01-01',request:id(81)})),/40001/);
  await assert.rejects(sql(manage({person:id(70),member:added.membershipId,expected:await updated(added.membershipId),licenses:[],request:id(82)})),/23514/);
  await assert.rejects(sql(manage({person:id(70),member:added.membershipId,expected:await updated(added.membershipId),licenses:['FOREIGN'],request:id(83)})),/42501/);
  await assert.rejects(sql(manage({person:id(70),member:added.membershipId,expected:await updated(added.membershipId),verifiedAt:"clock_timestamp()-interval '31 seconds'",request:id(84)})),/40001/);
  console.log('PASS: stale version, invalid assignments and stale Auth proof cannot change membership');
  await sql(manage({person:owner,member:ownerM,expected:await updated(ownerM),role:'store_owner',licenses:[],request:id(85)}));
  const expiredProof=proof.map(v=>v.id===owner?{...v,eligible:false,expiresOn:null}:v);
  await assert.rejects(sql(manage({person:owner2,member:owner2M,expected:await updated(owner2M),role:'store_buyer',identities:expiredProof,request:id(86)})),/23514/);
  await sql(manage({person:id(70),member:added.membershipId,expected:await updated(added.membershipId),role:'store_owner',licenses:[],identities:expiredProof,request:id(87)}));
  await sql(manage({person:owner2,member:owner2M,expected:await updated(owner2M),role:'store_owner',licenses:[],status:'disabled',identities:expiredProof,request:id(88)}));
  assert.equal(await sql(`select active from portal_profile where id='${owner2}';`),'t');
  console.log('PASS: expired Owner cannot satisfy recovery; eligible replacement allows scoped removal without global deactivation');
  await sql(`insert into portal_retailer_account values('${id(90)}','Other retailer','Other','ready_to_order');
    insert into portal_organization values('${id(91)}','retailer','Other retailer','Other','active','${id(90)}');
    insert into portal_store(license_number,retailer_account_id,active) values('OTHER','${id(90)}',true);`);
  await assert.rejects(sql(manage({person:id(70),organization:id(91),licenses:['OTHER'],request:id(92)})),/23514/);
  await assert.rejects(sql(manage({person:admin,role:'store_owner',licenses:[],request:id(93)})),/22023/);
  const buyerVersion=await updated(buyerM);
  first=sql('begin;'+manage({person:buyer,member:buyerM,expected:buyerVersion,role:'store_staff',request:id(95)})+'select pg_sleep(1);commit;','role-change-first');
  await held('role-change-first');
  await assert.rejects(sql(price(),'role-change-waiter'),/42501/);await first;
  await assert.rejects(sql(manage({person:buyer,member:buyerM,expected:buyerVersion,request:id(96)})),/40001/);
  console.log('PASS: committed role change blocks waiting Buyer writes and stale administration saves');
  await sql(`insert into auth.users(id,email) values('${id(97)}','concurrent-grant@example.invalid');
    insert into portal_profile(id,full_name,org,role,active,staff_role) values('${id(97)}','Concurrent grant','Independent Brand','brand',true,null)
      on conflict(id) do update set full_name=excluded.full_name,org=excluded.org,role=excluded.role,active=excluded.active,staff_role=excluded.staff_role;`);
  const grantProof=proof.concat([{id:id(97),eligible:true,expiresOn:null}]);
  first=sql('begin;'+manage({person:id(97),identities:grantProof,request:id(98)})+'select pg_sleep(1);commit;','grant-first');
  await held('grant-first');
  await assert.rejects(sql(manage({person:id(97),identities:grantProof,organization:id(91),licenses:['OTHER'],request:id(99)})),/23514/);await first;
  assert.equal(await sql(`select count(*) from portal_organization_membership where profile_id='${id(97)}' and workspace='store' and status='active';`),'1');
  console.log('PASS: simultaneous grants cannot give one person access to two retailer organizations');
  await sql('update portal_store_access_control set enabled=false;');
  await assert.rejects(sql(manage({person:buyer,member:buyerM,expected:await updated(buyerM),request:id(94)})),/42501/);
  console.log('PASS: second-retailer grant, self-change and paused access administration are denied');
  await assert.rejects(sql('set role authenticated;select * from portal_store_membership_change;'),/42501/);
  await assert.rejects(sql('set role anon;'+manage({person:buyer,member:buyerM,expected:await updated(buyerM),request:id(100)})),/42501/);
  console.log('PASS: browser and anonymous roles cannot read administration history or execute membership writes directly');
} finally {
  if(started)execFileSync('docker',['stop',container],{stdio:'pipe'});
}
