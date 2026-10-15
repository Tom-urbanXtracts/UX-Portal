// Disposable PostgreSQL only. Never accepts a database URL or production key.
// Exercises 20261015120000_store_financial_hold_and_license_lifecycle.sql against
// the local Store schema plus the real durable-order, Store command and
// onboarding-advance functions: tenant/role allow+deny, append-only audit,
// explicit manual holds, document-bound license verification, the license
// ordering boundary on every insert path, atomic onboarding completion, the
// billing role and its scoped membership administration, T-30 reminder
// identities with missing-recipient exceptions, and license-document access.
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image='postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
const container='ux-store-controls-test-'+randomUUID().slice(0,8);
const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const migration=read('supabase/migrations/20261015120000_store_financial_hold_and_license_lifecycle.sql');
const slice=(text,start,end='\n$$;')=>{const i=text.indexOf(start);assert(i>=0,start);return text.slice(i,text.indexOf(end,i)+end.length);};
function sql(input) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']);
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err.trim())));child.stdin.end(input);
  });
}
const svc=statement=>sql('set role service_role;'+statement).then(out=>out.replace(/^SET\n?/,''));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=n=>String(n).padStart(2,'0').repeat(32);
const admin=id(1),internalOrg=id(2),finance=id(101),compliance=id(102),sales=id(103),forgedAdmin=id(104),orphanFinance=id(105);
const ownerA=id(110),buyerA=id(111),staffA=id(112),ownerB=id(113),billingA=id(114),ownerC=id(115),legacyOwnerA=id(116);
const billingNew=id(117),buyerD=id(118),billingD=id(119),adminM=id(3);
const accountA=id(21),accountB=id(22),accountC=id(23),accountD=id(24),orgA=id(31),orgB=id(32),orgC=id(33),orgD=id(34);
const ownerAM=id(41),buyerAM=id(42),staffAM=id(43),ownerBM=id(44),billingAM=id(45),ownerCM=id(46);
const reqA=id(70),reqB=id(71),reqEarly=id(72),reqMissing=id(73),reqRenewal=id(75),reqC=id(76);
const hold=(actor,active,account=accountA,reason='Synthetic',evidence='EVIDENCE-1')=>svc(`select portal_set_financial_hold('${actor}','${account}',${active},'${reason}','${evidence}');`);
const terms=(actor,account,value,reason='Synthetic',evidence='EVIDENCE-1')=>svc(`select portal_set_payment_terms('${actor}',${account?`'${account}'`:'null'},${value===null?'null':`'${value}'`},'${reason}','${evidence}');`);
const effective=account=>sql(`select portal_retailer_effective_payment_terms('${account}')->>'terms';`);
// Direct insert path (staff entry, legacy jobs): only the triggers stand between it and an order.
const order=license=>sql(`insert into portal_order(client_request_id,portal_reference,organization,location_license,location_name,submitted_by_role,state,order_value_cents)
  values(gen_random_uuid(),'DIRECT-'||gen_random_uuid(),'Fixture','${license}','Fixture','internal','ordered',100);`);
const verify=(actor,license,result,expires,{document=id(80),request=reqA,evidence='Checked OCM record'}={})=>
  svc(`select portal_verify_store_license('${actor}','${license}',${document?`'${document}'`:'null'},'${result}',${expires},'${evidence}',${request?`'${request}'`:'null'});`);
const complete=(actor,request,expected='access',evidence='All sections and licenses verified')=>
  svc(`select portal_complete_store_onboarding('${actor}','${request}',${expected?`'${expected}'`:'null'},'${evidence}','actor@example.invalid');`);
const doc=(actor,membership,document,access='read')=>svc(`select portal_authorize_license_document('${actor}',${membership?`'${membership}'`:'null'},'${document}','${access}');`);
const count=async q=>Number(await sql(`select count(*) from ${q};`));
const plus=days=>`current_date+${days}`;
let started=false;
try {
  execFileSync('docker',['run','--rm','-d','--network','none','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image],{stdio:'pipe'});started=true;
  for(let i=0;i<100;i++) {try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'pipe'});break;}catch{if(i===99)throw Error('Local PostgreSQL did not start');await wait(100);}}
  const inventory=read('supabase/migrations/20260901250000_security_and_inventory_commitments.sql');
  const lots=read('supabase/migrations/20260902070000_inbound_lot_integrity.sql');
  await sql(read('supabase/tests/store_access_local_schema.sql')
    +`alter table auth.users add column raw_user_meta_data jsonb not null default '{}'::jsonb;
      alter table portal_profile add column locations text;
      alter table portal_organization add column created_at timestamptz not null default now();
      alter table portal_retailer_account add column quickbooks_customer_id text, add column account_owner_email text;
      create unique index portal_organization_membership_scope_unique on portal_organization_membership(profile_id,organization_id,workspace);
      create table portal_profile_department(profile_id uuid references portal_profile,department_key text,member_role text default 'member',status text default 'active',primary key(profile_id,department_key));
      create table portal_onboarding_request(id uuid primary key,retailer_account_id uuid references portal_retailer_account,stage text not null,
        workflow_state text not null default 'accepted',owner_email text,updated_at timestamptz not null default now());
      create table portal_onboarding_store(id bigint generated by default as identity primary key,onboarding_request_id uuid not null references portal_onboarding_request,
        store_number integer,store_name text,license_number text not null,qualification_status text not null default 'qualified',quickbooks_customer_id text,license_expires_on date);
      create table portal_onboarding_person(id bigint generated by default as identity primary key,onboarding_request_id uuid references portal_onboarding_request,access_status text);
      create table portal_onboarding_event(id bigint generated by default as identity primary key,onboarding_request_id uuid,source text,from_stage text,to_stage text,
        actor_id uuid,actor_email text,note text,created_at timestamptz default now());
      create table portal_onboarding_document(id uuid primary key,onboarding_request_id uuid not null references portal_onboarding_request,object_path text not null unique,
        original_name text not null,content_type text not null,sha256 text not null,scan_state text not null);
      create table portal_store_demo_control(id boolean primary key default true check(id),enabled boolean not null default false);
      create table portal_store_demo_session(actor_id uuid primary key references portal_profile(id),revision integer not null,state jsonb not null,updated_at timestamptz default now());
      alter table portal_admin_audit add column actor_org text;
      insert into portal_store_demo_control values(true,true);
      insert into portal_role_permission values('administrator','store.demo');`
    +read('supabase/migrations/20260901150000_durable_portal_orders.sql')
    +inventory.slice(0,inventory.indexOf('create or replace function public.portal_release_terminal_inventory_commitments()'))
    +slice(lots,'create or replace function public.portal_commit_order_line_inventory()')
    +read('supabase/migrations/20261014215429_store_membership_access_foundation.sql')
    +read('supabase/migrations/20261014220938_store_endpoint_access_commands.sql')
    // The reviewed scoped administration this migration extends with store_billing.
    +read('supabase/migrations/20261014223749_store_membership_administration.sql')
    // The real onboarding advance function, unchanged, so completion is exercised end to end.
    +slice(read('supabase/migrations/20260905130000_retailer_store_accounting_controls.sql'),'create or replace function public.portal_advance_onboarding_request(')
    +`grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role;
      insert into portal_retailer_account values('${accountA}','Retailer A','A','ready_to_order','QB-A','main-a@example.invalid'),
        ('${accountB}','Retailer B','B','ready_to_order','QB-B',null),('${accountC}','Retailer C','C','ready_to_order','QB-C','Main-C@Example.invalid'),
        -- No Account Owner and no valid designated main contact: reminders must raise an exception, never guess.
        ('${accountD}','Retailer D','D','ready_to_order','QB-D','not-an-email');
      -- A location activated before this migration, with no audited verification.
      insert into portal_store(license_number,organization,display_name,retailer_account_id,active,license_status,license_expires_on,ordering_status)
        values('LIC-LEGACY','Retailer A','Legacy','${accountA}',true,'active',current_date+365,'ready');`);
  // Rerun-safe: applying the migration twice must succeed and keep one config row.
  await sql(migration);await sql(migration);
  assert.equal(await sql('select terms from portal_payment_terms_default;'),'Net 30');
  assert.equal(await sql("select compliance_email||':'||compliance_email_review||':'||delivery_enabled||':'||(reviewed_at is not null)||':'||(review_note like 'Confirmed and reaffirmed 2026-10-15%') from portal_license_reminder_config;"),'tom@urbanxtracts.com:reaffirmed:false:true:true');
  await assert.rejects(sql("update portal_license_reminder_config set compliance_email_review='prelaunch_replace_or_reaffirm_required';"),/23514/);
  assert.equal(await sql("select count(*) from pg_proc where proname in ('portal_store_command','portal_store_command_core');"),'2');
  assert.equal(await sql("select count(*) from pg_proc where proname in ('portal_approve_store_onboarding') or (proname='portal_verify_store_license' and pg_get_function_identity_arguments(oid) like '%p_document_ref%');"),'0');
  console.log('PASS: migration is rerun-safe; Net 30 default, Compliance recipient confirmed and reaffirmed (not pending review); retired signatures removed');

  const people=[[admin,'administrator'],[finance,'operations'],[compliance,'quality'],[sales,'sales'],[forgedAdmin,'administrator'],[orphanFinance,'operations'],
    [ownerA,null],[buyerA,null],[staffA,null],[ownerB,null],[billingA,null],[ownerC,null],[billingNew,null],[buyerD,null],[billingD,null]];
  await sql(people.filter(([p])=>p!==admin).map(([p])=>`insert into auth.users(id,email) values('${p}','${p}@example.invalid');`).join('')
    +people.map(([p,staff])=>`insert into portal_profile(id,full_name,org,role,active,staff_role) values('${p}','Fixture','Fixture','${staff?'internal':'brand'}',true,${staff?`'${staff}'`:'null'})
      on conflict(id) do update set role=excluded.role,staff_role=excluded.staff_role;`).join('')
    +`insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values
      ('${id(51)}','${finance}','${internalOrg}','internal','operations','active'),('${id(52)}','${compliance}','${internalOrg}','internal','quality','active'),
      ('${id(53)}','${sales}','${internalOrg}','internal','sales','active'),('${id(54)}','${forgedAdmin}','${internalOrg}','internal','viewer','active');
    insert into portal_profile_department(profile_id,department_key) values('${finance}','finance'),('${compliance}','quality'),('${sales}','sales'),('${orphanFinance}','finance');
    insert into portal_organization(id,kind,legal_name,display_name,status,legacy_retailer_account_id) values('${orgA}','retailer','Retailer A','A','active','${accountA}'),
      ('${orgB}','retailer','Retailer B','B','active','${accountB}'),('${orgC}','retailer','Retailer C','C','active','${accountC}'),('${orgD}','retailer','Retailer D','D','active','${accountD}');
    insert into portal_store(license_number,organization,display_name,retailer_account_id,active,ordering_status) values
      ('LIC-A1','Retailer A','A1','${accountA}',true,'ready'),('LIC-A2','Retailer A','A2','${accountA}',true,'ready'),('LIC-B1','Retailer B','B1','${accountB}',true,'ready'),
      ('LIC-A3','Retailer A','A3','${accountA}',true,'ready'),('LIC-A4','Retailer A','A4','${accountA}',true,'ready'),('LIC-A5','Retailer A','A5','${accountA}',true,'ready'),
      ('LIC-C1','Retailer C','C1','${accountC}',true,'ready');
    -- Due at T-30 with a recorded expiration; never orderable (no verification), only a reminder subject.
    insert into portal_store(license_number,organization,display_name,retailer_account_id,active,ordering_status,license_expires_on) values
      ('LIC-D1','Retailer D','D1','${accountD}',true,'paused',current_date+30);
    insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values
      ('${ownerAM}','${ownerA}','${orgA}','store','store_owner','active'),('${buyerAM}','${buyerA}','${orgA}','store','store_buyer','active'),
      ('${staffAM}','${staffA}','${orgA}','store','store_staff','active'),('${ownerBM}','${ownerB}','${orgB}','store','store_owner','active'),
      ('${billingAM}','${billingA}','${orgA}','store','store_billing','active'),
      -- Retailer D has a Buyer and a Billing user but no Owner: neither may be guessed as the reminder recipient.
      ('${id(49)}','${buyerD}','${orgD}','store','store_buyer','active'),('${id(50)}','${billingD}','${orgD}','store','store_billing','active');
    insert into portal_membership_store values('${buyerAM}','LIC-A1',now()),('${buyerAM}','LIC-LEGACY',now()),('${staffAM}','LIC-A1',now());
    insert into portal_onboarding_request(id,retailer_account_id,stage,owner_email) values('${reqA}','${accountA}','access','owner@example.invalid'),
      ('${reqB}','${accountB}','access',null),('${reqEarly}','${accountA}','terms',null),('${reqMissing}','${accountA}','access',null),
      ('${reqRenewal}','${accountA}','qualification',null),('${reqC}','${accountC}','access',null);
    insert into portal_onboarding_store(onboarding_request_id,store_number,store_name,license_number) values('${reqA}',1,'A1','LIC-A1'),('${reqA}',2,'A2','LIC-A2'),
      ('${reqB}',1,'B1','LIC-B1'),('${reqEarly}',1,'A1','LIC-A1'),('${reqMissing}',1,'A9','LIC-A9'),('${reqRenewal}',1,'A3','LIC-A3'),('${reqRenewal}',2,'A4','LIC-A4'),
      ('${reqRenewal}',3,'A5','LIC-A5'),('${reqC}',1,'C1','LIC-C1');
    insert into portal_onboarding_document values
      ('${id(80)}','${reqA}','${reqA}/${sha(80)}.pdf','license.pdf','application/pdf','${sha(80)}','clean'),
      ('${id(81)}','${reqB}','${reqB}/${sha(81)}.pdf','license.pdf','application/pdf','${sha(81)}','clean'),
      ('${id(82)}','${reqA}','${reqA}/${sha(82)}.pdf','pending.pdf','application/pdf','${sha(82)}','pending_provider'),
      ('${id(83)}','${reqA}','../escape/${sha(83)}.pdf','forged.pdf','application/pdf','${sha(83)}','clean'),
      ('${id(84)}','${reqRenewal}','${reqRenewal}/${sha(84)}.png','license.png','image/png','${sha(84)}','clean'),
      ('${id(86)}','${reqC}','${reqC}/${sha(86)}.jpg','license.jpg','image/jpeg','${sha(86)}','clean');`);

  const role=(actor,scope)=>sql(`select coalesce(portal_internal_control_role('${actor}','${scope}'),'none');`);
  assert.equal(await role(admin,'financial'),'administrator');assert.equal(await role(finance,'financial'),'finance');
  assert.equal(await role(compliance,'license'),'compliance');assert.equal(await role(finance,'license'),'finance');
  for(const actor of [compliance,sales,forgedAdmin,orphanFinance,ownerA,buyerA,billingA]) assert.equal(await role(actor,'financial'),'none',actor);
  for(const actor of [sales,forgedAdmin,orphanFinance,ownerA,billingA]) assert.equal(await role(actor,'license'),'none',actor);
  assert.equal(await role(admin,'forged_scope'),'none');
  console.log('PASS: Finance/Administrator and Compliance authority resolve only from active Internal membership and department');

  // Authorized billing user: Store workspace only, account-level, no assignment, no commands.
  await assert.rejects(sql(`insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values('${id(47)}','${billingA}','${internalOrg}','internal','store_billing','active');`),/23514/);
  await assert.rejects(sql(`insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values('${id(48)}','${billingA}','${orgB}','store','store_manager','active');`),/23514/);
  await assert.rejects(sql(`insert into portal_membership_store values('${billingAM}','LIC-A1',now());`),/42501/);
  await assert.rejects(svc(`select portal_resolve_store_context('${billingA}','${billingAM}');`),/42501/); // Store access remains held.
  await sql('update portal_store_access_control set enabled=true;');
  const billingContext=JSON.parse(await svc(`select portal_resolve_store_context('${billingA}','${billingAM}');`));
  assert.equal(billingContext.memberRole,'store_billing');assert.equal(billingContext.retailerAccountId,accountA);
  assert.deepEqual(billingContext.licenses,['LIC-A1','LIC-A2','LIC-A3','LIC-A4','LIC-A5','LIC-LEGACY']);
  await assert.rejects(svc(`select portal_resolve_store_context('${billingA}','${ownerBM}');`),/42501/);
  await assert.rejects(svc(`select portal_lock_store_context('${billingA}','${billingAM}','${orgA}','LIC-A1');`),/42501/);
  await assert.rejects(svc(`select portal_store_command('${billingA}','${billingAM}','${orgA}','price.propose','{"location_license":"LIC-A1","product_id":"canix:item:1","proposed_price_cents":1}');`),/42501/);
  // Scoped Internal Administrator administration may grant Billing: account-wide, never with a location.
  const proof=ids=>JSON.stringify(ids.map(v=>({id:v,eligible:true,expiresOn:null})));
  const manage=({actor=admin,actorM=adminM,org=orgA,person=billingNew,member=null,role='store_billing',licenses=[],status='active',expected=null,request})=>
    svc(`select portal_manage_store_membership('${actor}','${actorM}','${org}','${person}',${member?`'${member}'`:'null'},'${role}',
      array[${licenses.map(v=>`'${v}'`).join(',')}]::text[],'${status}',${expected?`'${expected}'`:'null'},'Synthetic billing administration','${request}','${proof([actor,person])}',clock_timestamp());`);
  await assert.rejects(manage({licenses:['LIC-A1'],request:id(600)}),/23514/,'billing with a location assignment');
  for(const role of ['billing','store_manager','administrator','']) await assert.rejects(manage({role,request:id(601)}),/22023/,'unlisted role '+role);
  for(const [actor,actorM] of [[ownerA,ownerAM],[billingA,billingAM],[finance,id(51)],[sales,id(53)]]) await assert.rejects(manage({actor,actorM,request:id(602)}),/42501/,'non-administrator '+actor);
  const granted=JSON.parse(await manage({request:id(603)}));
  assert.deepEqual([granted.memberRole,granted.licenses,granted.emailSent,granted.globalAccountChanged],['store_billing',[],false,false]);
  assert.equal(await count(`portal_membership_store where membership_id='${granted.membershipId}'`),0);
  assert.equal(JSON.parse(await manage({request:id(603)})).idempotent,true);
  assert.deepEqual(JSON.parse(await svc(`select portal_resolve_store_context('${billingNew}','${granted.membershipId}');`)).licenses,['LIC-A1','LIC-A2','LIC-A3','LIC-A4','LIC-A5','LIC-LEGACY']);
  // Tenant isolation: the same person cannot also hold Billing at another retailer, and a foreign location is refused.
  await assert.rejects(manage({org:orgB,request:id(604)}),/23514/,'second retailer');
  await assert.rejects(manage({org:orgB,person:ownerC,role:'store_buyer',licenses:['LIC-A1'],request:id(605)}),/42501/,'foreign location');
  await assert.rejects(svc(`select portal_resolve_store_context('${billingNew}','${billingAM}');`),/42501/,'another member\'s membership');
  // Store Owners still administer only Buyers and Budtenders; Billing administers no one.
  await assert.rejects(svc(`select portal_revoke_store_membership('${ownerA}','${ownerAM}','${granted.membershipId}','Synthetic');`),/42501/);
  await assert.rejects(svc(`select portal_revoke_store_membership('${billingNew}','${granted.membershipId}','${buyerAM}','Synthetic');`),/42501/);
  await assert.rejects(svc(`select portal_lock_store_context('${billingNew}','${granted.membershipId}','${orgA}','LIC-A1');`),/42501/);
  // Demotion back to Buyer requires an explicit assignment; nothing is inferred.
  const version=await sql(`select updated_at from portal_organization_membership where id='${granted.membershipId}';`);
  await assert.rejects(manage({member:granted.membershipId,expected:version,role:'store_buyer',request:id(606)}),/23514/);
  await manage({member:granted.membershipId,expected:version,status:'disabled',request:id(607)});
  assert.equal(await sql(`select status from portal_organization_membership where id='${granted.membershipId}';`),'disabled');
  assert.equal(await count(`portal_admin_audit where action='manage-store-membership' and detail->'after'->>'memberRole'='store_billing'`),2);
  await sql('update portal_store_access_control set enabled=false;');
  console.log('PASS: billing user resolves only its own account, cannot hold an assignment, run a Store command or exist outside the Store workspace');
  console.log('PASS: only an Internal Administrator grants Billing (account-wide, zero locations, audited, idempotent); Store, Billing, Finance and Sales actors, unlisted roles, second retailers and foreign locations are denied');

  await terms(finance,accountA,'Net 15');
  assert.equal(await effective(accountA),'Net 15');assert.equal(await effective(accountB),'Net 30');
  assert.equal(await sql(`select prior_value->>'terms'||'>'||(new_value->>'terms')||':'||internal_role||':'||actor_id from portal_store_control_event where control='payment_terms_override';`),`Net 30>Net 15:finance:${finance}`);
  for(const actor of [sales,compliance,ownerA,forgedAdmin,billingA]) await assert.rejects(terms(actor,accountA,'Net 60'),/42501/);
  await assert.rejects(terms(admin,accountA,'Net 60','',''),/22023/);
  await assert.rejects(terms(admin,accountA,'Net 15'),/23514/);
  assert.equal(await count("information_schema.columns where table_name='portal_retailer_payment_terms' and column_name ~ '(license|location|store)'"),0);
  await terms(admin,accountA,'');assert.equal(await effective(accountA),'Net 30');
  await terms(admin,null,'Net 30 EOM');assert.equal(await effective(accountB),'Net 30 EOM');await terms(admin,null,'Net 30');
  assert.equal(await count("portal_store_control_event where control like 'payment_terms%'"),4);
  console.log('PASS: one inherited account override, no location column, Finance/Administrator only, one audit event per accepted change');

  // License verification names a real, clean document of the matching request, account and license.
  for(const actor of [sales,ownerA,forgedAdmin,billingA]) await assert.rejects(verify(actor,'LIC-A1','verified',plus(365)),/42501/);
  await assert.rejects(verify(compliance,'LIC-A1','verified','null'),/22023/);
  await assert.rejects(verify(compliance,'LIC-A1','verified','current_date'),/22023/);
  await assert.rejects(verify(compliance,'LIC-A1','verified',plus(365),{evidence:''}),/22023/);
  await assert.rejects(verify(compliance,'LIC-A1','verified',plus(365),{document:null}),/22023/);
  await assert.rejects(verify(compliance,'LIC-A1','verified',plus(365),{request:null}),/22023/);
  await assert.rejects(svc(`select portal_verify_store_license('${compliance}','LIC-A1','DOC-LIC-A1','verified',current_date+365,'Free text document',null);`),/22P02|42883/);
  const refused=[['nonexistent document',{document:id(900)}],['dirty scan',{document:id(82)}],['cross-account document',{document:id(81)}],
    ['mismatched request',{request:reqRenewal}],['nonexistent request',{request:id(999)}],['forged document ID',{document:randomUUID()}]];
  for(const [label,options] of refused) await assert.rejects(verify(compliance,'LIC-A1','verified',plus(365),options),/22023/,label);
  await assert.rejects(verify(compliance,'LIC-A9','verified',plus(365),{request:reqMissing,document:id(80)}),/22023/,'document of another request');
  await assert.rejects(verify(compliance,'LIC-NOPE','verified',plus(365)),/22023/,'license not on the request');
  await assert.rejects(verify(compliance,'LIC-B1','verified',plus(365),{document:id(80)}),/22023/,'other account license with this account document');
  assert.equal(await count("portal_store_control_event where control='license_verification'"),0,'refusals write no evidence');
  // Activation or a new expiration without an authorized verification (an upload, a Sales edit) is refused.
  await assert.rejects(sql(`update portal_store set license_status='active',license_expires_on=${plus(365)} where license_number='LIC-A1';`),/42501/);
  await verify(compliance,'LIC-A1','verified',plus(30));
  assert.equal(await sql(`select license_status||':'||(license_expires_on-current_date) from portal_store where license_number='LIC-A1';`),'active:30');
  await assert.rejects(sql(`update portal_store set license_expires_on=${plus(400)} where license_number='LIC-A1';`),/42501/);
  await verify(finance,'LIC-A2','rejected','null',{evidence:'Name mismatch'});
  assert.equal(await sql(`select license_status from portal_store where license_number='LIC-A2';`),'pending_qualification');
  await verify(admin,'LIC-A2','verified',plus(31));
  await verify(compliance,'LIC-B1','verified',plus(200),{document:id(81),request:reqB});
  await verify(compliance,'LIC-C1','verified',plus(30),{document:id(86),request:reqC});
  assert.equal(await sql(`select string_agg(internal_role||':'||result||':'||license_number||':'||document_id||':'||document_sha256||':'||onboarding_request_id||':'||retailer_account_id,',' order by id) from portal_store_control_event where control='license_verification';`),
    [`compliance:verified:LIC-A1:${id(80)}:${sha(80)}:${reqA}:${accountA}`,`finance:rejected:LIC-A2:${id(80)}:${sha(80)}:${reqA}:${accountA}`,
     `administrator:verified:LIC-A2:${id(80)}:${sha(80)}:${reqA}:${accountA}`,`compliance:verified:LIC-B1:${id(81)}:${sha(81)}:${reqB}:${accountB}`,
     `compliance:verified:LIC-C1:${id(86)}:${sha(86)}:${reqC}:${accountC}`].join(','));
  console.log('PASS: verification requires a clean document UUID of the matching request, account and license; nonexistent, dirty, cross-account, mismatched and forged IDs write no evidence');

  await hold(finance,true);
  for(const license of ['LIC-A1','LIC-A2']) await assert.rejects(order(license),/UXH01/);
  await order('LIC-B1');
  for(const actor of [sales,compliance,ownerA,buyerA,forgedAdmin,billingA]) await assert.rejects(hold(actor,false),/42501/);
  await assert.rejects(hold(admin,true),/23514/);await assert.rejects(hold(admin,false,accountA,'',''),/22023/);
  // A refresh job holding only service credentials cannot clear the hold outside the audited function.
  await assert.rejects(svc(`update portal_retailer_financial_hold set active=false;`),/42501/);
  await assert.rejects(svc(`delete from portal_retailer_financial_hold;`),/42501/);
  assert.equal(await sql(`select active from portal_retailer_financial_hold where retailer_account_id='${accountA}';`),'t');
  await hold(admin,false);await order('LIC-A1');
  assert.equal(await count(`portal_store_control_event where control='financial_hold' and retailer_account_id='${accountA}'`),2);
  assert.equal(await sql(`select string_agg(internal_role||':'||(prior_value->>'active')||'>'||(new_value->>'active')||':'||reason||':'||evidence,',' order by id) from portal_store_control_event where control='financial_hold';`),
    'finance:false>true:Synthetic:EVIDENCE-1,administrator:true>false:Synthetic:EVIDENCE-1');
  console.log('PASS: explicit hold blocks every account location only; Store, Sales, Compliance, billing and forged roles cannot change it; one event per command');

  // License ordering boundary on every portal_order insert path, independent of the financial hold.
  await assert.rejects(order('LIC-LEGACY'),/UXL01/,'active before migration but never verified');
  await assert.rejects(order('LIC-A3'),/UXL01/,'pending qualification');
  await assert.rejects(order('LIC-NOT-A-STORE'),/UXL01/,'missing location');
  for(const license of ['LIC-A3','LIC-A4','LIC-A5']) await verify(compliance,license,'verified',plus(100),{document:id(84),request:reqRenewal});
  await sql(`update portal_store set active=false where license_number='LIC-A4';update portal_store set closed_at=now() where license_number='LIC-A5';`);
  await assert.rejects(order('LIC-A4'),/UXL01/,'inactive');await assert.rejects(order('LIC-A5'),/UXL01/,'closed');
  await order('LIC-A3');
  // Simulate the passage of time: a past verified expiration (superuser fixture insert), now lapsed.
  await sql(`insert into portal_store_control_event(control,actor_id,internal_role,retailer_account_id,license_number,document_id,document_sha256,onboarding_request_id,result,prior_value,new_value,reason,evidence)
    values('license_verification','${compliance}','compliance','${accountA}','LIC-A3','${id(84)}','${sha(84)}','${reqRenewal}','verified','{}',jsonb_build_object('result','verified','licenseExpiresOn',current_date-1),'Historical fixture','Historical fixture');
    update portal_store set license_expires_on=current_date-1 where license_number='LIC-A3';`);
  await assert.rejects(order('LIC-A3'),/UXL01/,'expired');
  // A renewed upload alone stays paused; only an authorized verification of it resumes ordering.
  await sql(`insert into portal_onboarding_document values('${id(85)}','${reqRenewal}','${reqRenewal}/${sha(85)}.pdf','renewal.pdf','application/pdf','${sha(85)}','clean');`);
  await assert.rejects(order('LIC-A3'),/UXL01/,'renewal uploaded, not verified');
  await assert.rejects(sql(`update portal_store set license_expires_on=${plus(365)} where license_number='LIC-A3';`),/42501/);
  await assert.rejects(verify(sales,'LIC-A3','verified',plus(365),{document:id(85),request:reqRenewal}),/42501/);
  await hold(finance,true);
  await assert.rejects(order('LIC-A3'),/UXL01/,'license pause reported while a hold is also active');
  await verify(compliance,'LIC-A3','verified',plus(365),{document:id(85),request:reqRenewal});
  await assert.rejects(order('LIC-A3'),/UXH01/,'verified renewal does not clear the hold');
  assert.equal(await sql(`select active from portal_retailer_financial_hold where retailer_account_id='${accountA}';`),'t');
  await hold(finance,false);await order('LIC-A3');
  console.log('PASS: direct inserts pause on missing, unverified, expired, inactive or closed license scope (UXL01) independently of the hold (UXH01); renewal resumes only after verification');

  // Normal Store command path: the reviewed command plus the distinct, authorized license pause.
  await sql(`update portal_store_access_control set enabled=true;
    insert into canix_sync_state values(1,now(),'${id(60)}');
    insert into canix_marketplace_sync_state values(1,'${id(61)}',now(),'success','full_shop');
    insert into canix_package_current values(1,'${id(60)}',4467,1,10,'CountBased','available',100,100,1,'TestPassed',null,null);
    insert into canix_marketplace_product_snapshot values('${id(61)}','10',100);`);
  const create=(who,membershipId,license,requestId)=>svc(`select portal_store_command('${who}','${membershipId}','${orgA}','order.create','${JSON.stringify({
    p_client_request_id:requestId,p_portal_reference:'CMD-'+requestId,p_location_license:license,p_location_name:license,p_submitted_by_email:'buyer@example.invalid',
    p_order_value_cents:100,p_contains_preorder:false,p_release_hold:false,p_metadata:{synthetic:true},
    p_lines:[{productId:'canix:item:1',quantity:1,unitPriceCents:100,product:'Fixture',unit:'each',lineTotalCents:100}]})}');`);
  const accepted=JSON.parse(await create(buyerA,buyerAM,'LIC-A1',id(62)));assert.equal(accepted.created,true);
  await assert.rejects(create(buyerA,buyerAM,'LIC-LEGACY',id(63)),/UXL01/,'unverified location via the Store command');
  await assert.rejects(create(buyerA,buyerAM,'LIC-A2',id(64)),/42501/,'unassigned location is refused before license state is disclosed');
  await assert.rejects(create(billingA,billingAM,'LIC-A1',id(65)),/42501/,'billing user cannot order');
  await hold(finance,true);
  await assert.rejects(create(buyerA,buyerAM,'LIC-A1',id(66)),/UXH01/,'manual hold via the Store command');
  // Idempotent retry of an accepted order still returns it.
  assert.equal(JSON.parse(await create(buyerA,buyerAM,'LIC-A1',id(62))).id,accepted.id);
  await hold(finance,false);
  await sql('update portal_store_access_control set enabled=false;');
  console.log('PASS: Store command orders at a verified location, reports UXL01 only after authorization, keeps UXH01 independent and preserves accepted retries');

  // Independent controls: license decisions never touch a hold, and hold changes never touch a license.
  await hold(finance,true);
  assert.equal(await sql(`select license_status from portal_store where license_number='LIC-A1';`),'active');
  await verify(compliance,'LIC-A1','verified',plus(60));
  assert.equal(await sql(`select active from portal_retailer_financial_hold where retailer_account_id='${accountA}';`),'t');
  await hold(finance,false);
  assert.equal(await sql(`select license_expires_on-current_date from portal_store where license_number='LIC-A1';`),'60');
  await verify(compliance,'LIC-A1','verified',plus(30));
  console.log('PASS: only Compliance/Finance/Administrator verification with evidence and a current expiration activates or renews; holds and license state are independent');

  await assert.rejects(sql('update portal_store_control_event set reason=\'x\';'),/42501/);
  await assert.rejects(sql('delete from portal_store_control_event;'),/42501/);
  await assert.rejects(sql('truncate portal_store_control_event;'),/42501/);
  await assert.rejects(svc(`insert into portal_store_control_event(control,actor_id,internal_role,prior_value,new_value,reason,evidence) values('payment_terms_default','${admin}','administrator','{}','{}','x','x');`),/42501/);
  const tables=['portal_payment_terms_default','portal_retailer_payment_terms','portal_retailer_financial_hold','portal_store_control_event','portal_license_reminder_config','portal_license_renewal_reminder','portal_license_document_access_event','portal_license_reminder_exception'];
  assert.equal(await sql(`select bool_and(relrowsecurity) from pg_class where relname in (${tables.map(t=>`'${t}'`).join(',')});`),'t');
  assert.equal(await sql(`select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname in (${tables.map(t=>`'${t}'`).join(',')});`),'0');
  assert.equal(await sql(`select bool_or(has_table_privilege('service_role',t,'insert') or has_table_privilege('service_role',t,'update') or has_table_privilege('service_role',t,'delete'))
    from unnest(array[${tables.map(t=>`'${t}'`).join(',')}]) t;`),'f');
  for(const who of ['anon','authenticated']) {
    for(const table of tables) await assert.rejects(sql(`set role ${who};select * from ${table};`),/42501/);
    await assert.rejects(sql(`set role ${who};select portal_set_financial_hold('${admin}','${accountA}',true,'x','x');`),/42501/);
    await assert.rejects(sql(`set role ${who};select portal_authorize_license_document('${admin}',null,'${id(900)}','read');`),/42501/);
    await assert.rejects(sql(`set role ${who};select portal_complete_store_onboarding('${admin}','${reqA}','access','x');`),/42501/);
  }
  const definers=['portal_internal_control_role','portal_set_payment_terms','portal_set_financial_hold','portal_verify_store_license','portal_complete_store_onboarding',
    'portal_plan_license_renewal_reminders','portal_license_reminder_send_decision','portal_license_reminder_main_contact','portal_license_reminder_owner_active',
    'portal_license_reminder_compliance_profile','portal_set_license_reminder_recipient','portal_authorize_license_document','portal_retailer_effective_payment_terms',
    'portal_assert_store_license_orderable','portal_enforce_store_license_scope','portal_enforce_manual_financial_hold','portal_require_verified_license_activation',
    'portal_require_onboarding_approval','portal_queue_license_notifications'];
  const quoted=names=>names.map(n=>`'${n}'`).join(',');
  assert.equal(await sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in (${quoted(definers)}) and prosecdef;`),String(definers.length));
  assert.equal(await sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in (${quoted([...definers,'portal_store_command','portal_store_command_core','portal_resolve_store_context','portal_reject_audit_change','portal_manage_store_membership'])})
     and not exists(select 1 from unnest(proconfig) c where c like 'search_path=%');`),'0');
  assert.equal(await sql(`select count(*) from pg_proc p cross join unnest(array['anon','authenticated']) r
    where p.pronamespace='public'::regnamespace and p.proname in (${quoted([...definers,'portal_store_command','portal_store_command_core','portal_resolve_store_context','portal_commit_store_demo','portal_manage_store_membership'])})
      and has_function_privilege(r,p.oid,'execute');`),'0');
  assert.equal(await sql(`select count(*) from pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.pronamespace='public'::regnamespace and p.proname in (${quoted([...definers,'portal_store_command','portal_store_command_core','portal_resolve_store_context','portal_commit_store_demo','portal_manage_store_membership'])})
      and a.grantee=0 and a.privilege_type='EXECUTE';`),'0');
  console.log('PASS: append-only audit, RLS with no policies, service role read-only, no PUBLIC/anon/authenticated execution, pinned search_path on every definer');

  // Atomic, state-bound onboarding completion.
  await assert.rejects(sql(`update portal_onboarding_request set stage='ready' where id='${reqA}';`),/42501/);
  await assert.rejects(complete(sales,reqA),/42501/);
  await assert.rejects(complete(billingA,reqA),/42501/);
  await assert.rejects(complete(compliance,reqA,'access',''),/22023/);
  await assert.rejects(complete(compliance,reqEarly,'terms'),/23514/,'early approval');
  await assert.rejects(complete(compliance,reqA,'terms'),/40001/,'stale approval of a stage that has moved');
  await assert.rejects(complete(compliance,reqMissing),/23514/,'qualified license with no verification');
  await sql(`update portal_onboarding_store set qualification_status='qualified' where onboarding_request_id='${reqRenewal}';
    update portal_onboarding_request set stage='access' where id='${reqRenewal}';`);
  await assert.rejects(complete(compliance,reqRenewal),/23514/,'inactive/closed qualified locations');
  // Every prerequisite of this function holds, but the real advance refuses (no active legacy Store Owner).
  await assert.rejects(complete(compliance,reqA),/At least one active Store Owner/,'failed transition');
  assert.equal(await count(`portal_store_control_event where control='onboarding_approval'`),0,'no durable approval survives any refusal');
  assert.equal(await sql(`select stage from portal_onboarding_request where id='${reqA}';`),'access');
  await sql(`insert into auth.users(id,email) values('${legacyOwnerA}','legacy-owner@example.invalid');
    insert into portal_profile(id,full_name,org,role,active) values('${legacyOwnerA}','Legacy Owner','Retailer A','owner',true);`);
  const done=JSON.parse(await complete(compliance,reqA));
  assert.equal(done.stage,'ready');assert.equal(done.approvedBy,'compliance');
  assert.equal(await sql(`select count(*)||':'||max(prior_value->>'stage')||':'||max(new_value->>'stage')||':'||max(internal_role) from portal_store_control_event where control='onboarding_approval' and onboarding_request_id='${reqA}';`),'1:access:ready:compliance');
  assert.equal(await sql(`select count(*) from portal_onboarding_event where onboarding_request_id='${reqA}' and to_stage='ready';`),'1');
  // A historical approval never authorizes a later transition.
  await sql(`update portal_onboarding_request set stage='access' where id='${reqA}';`);
  await assert.rejects(sql(`update portal_onboarding_request set stage='ready' where id='${reqA}';`),/42501/);
  await assert.rejects(complete(compliance,reqC,'qualification'),/40001/);
  console.log('PASS: completion requires the exact pre-ready stage and verified licenses; early, stale, unverified, Sales and failed transitions leave no approval; accepted completion is one bound event');

  // T-30 reminder intents. LIC-A1, LIC-C1 and LIC-D1 expire in exactly 30 days: due today.
  assert.equal(await svc('select portal_plan_license_renewal_reminders(current_date);'),'6');
  assert.equal(await svc('select portal_plan_license_renewal_reminders(current_date);'),'0');
  assert.equal(await sql('select portal_queue_license_notifications();'),'0');
  // Retailer D: no Owner and no valid main contact. Compliance still gets its intent; one exception, no guessed recipient.
  assert.equal(await sql(`select string_agg(recipient_kind||':'||channel||':'||coalesce(recipient_profile_id::text,recipient_email),',') from portal_license_renewal_reminder where license_number='LIC-D1';`),'internal_compliance:email:tom@urbanxtracts.com');
  assert.equal(await sql(`select count(*)||':'||max(exception_kind)||':'||max(retailer_account_id::text)||':'||max(due_on-current_date)||':'||max(dedupe_key) from portal_license_reminder_exception;`),
    `1:missing_account_recipient:${accountD}:0:license-renewal-exception:LIC-D1:${await sql('select (current_date+30)::text;')}:missing_account_recipient`);
  assert.match(await sql('select required_action from portal_license_reminder_exception;'),/Add an active Store Owner, or record a valid designated main contact.*no recipient was guessed/);
  assert.equal(await count(`portal_license_renewal_reminder where recipient_profile_id in ('${buyerD}','${billingD}') or license_number='LIC-D1' and recipient_kind<>'internal_compliance'`),0);
  await assert.rejects(sql('update portal_license_reminder_exception set required_action=\'x\';'),/42501/);
  await assert.rejects(sql('delete from portal_license_reminder_exception;'),/42501/);
  await assert.rejects(svc(`insert into portal_license_reminder_exception(dedupe_key,license_number,license_expires_on,due_on,exception_kind,required_action) values('x','x',current_date,current_date,'missing_account_recipient','x');`),/42501/);
  // No planning or decision path can write a notification, outbox, email or SMS record.
  assert.equal(await sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'portal_%license%' or proname like 'portal_%reminder%')
    and prosrc ~* '(notification_outbox|insert\\s+into\\s+(public\\.)?[a-z_]*(outbox|notification|email|sms)[a-z_]*|resend|twilio|net\\.http)';`),'0');
  const reminders=license=>sql(`select string_agg(recipient_kind||':'||channel||':'||coalesce(recipient_profile_id::text,recipient_email),',' order by recipient_kind,channel,id) from portal_license_renewal_reminder where license_number='${license}';`);
  assert.equal(await reminders('LIC-A1'),`account_owner:email:${ownerA},account_owner:in_portal:${ownerA},internal_compliance:email:tom@urbanxtracts.com`);
  assert.equal(await reminders('LIC-C1'),'internal_compliance:email:tom@urbanxtracts.com,main_contact:email:main-c@example.invalid');
  assert.equal(await count(`portal_license_renewal_reminder where license_number not in ('LIC-A1','LIC-C1','LIC-D1')`),0);
  assert.equal(await count(`portal_license_renewal_reminder where recipient_profile_id in ('${buyerA}','${staffA}','${ownerB}','${billingA}','${billingNew}')`),0);
  // Replacing the Compliance recipient with a portal identity adds its email and in-portal intents.
  await assert.rejects(svc(`select portal_set_license_reminder_recipient('${compliance}','${compliance}@example.invalid','replaced','Reviewed');`),/42501/);
  await svc(`select portal_set_license_reminder_recipient('${admin}','${compliance}@example.invalid','replaced','Replacement review record');`);
  assert.equal(await svc('select portal_plan_license_renewal_reminders(current_date);'),'6');
  assert.equal(await svc('select portal_plan_license_renewal_reminders(current_date);'),'0');
  // A late catch-up run the next day adds only the newly due LIC-A2 (T-31 today), never duplicates.
  assert.equal(await svc('select portal_plan_license_renewal_reminders(current_date+1);'),'4');
  assert.equal(await reminders('LIC-A2'),`account_owner:email:${ownerA},account_owner:in_portal:${ownerA},internal_compliance:email:${compliance}@example.invalid,internal_compliance:in_portal:${compliance}`);
  assert.equal(await count(`portal_license_renewal_reminder where recipient_kind='internal_compliance' and channel='in_portal' and recipient_profile_id='${compliance}'`),4);
  assert.equal(await count('portal_license_reminder_exception'),1,'catch-up runs never duplicate the exception');
  const decision=async(where)=>JSON.parse(await svc(`select portal_license_reminder_send_decision((select id from portal_license_renewal_reminder where ${where}));`));
  const ownerEmail=await decision(`license_number='LIC-A1' and recipient_kind='account_owner' and channel='email'`);
  assert.deepEqual([ownerEmail.send,ownerEmail.reason,ownerEmail.recipientAuthorized,ownerEmail.destination],[false,'delivery_disabled_pending_release',true,`${ownerA}@example.invalid`]);
  const portalIntent=await decision(`license_number='LIC-A1' and recipient_kind='internal_compliance' and channel='in_portal'`);
  assert.deepEqual([portalIntent.send,portalIntent.destination],[false,compliance]);
  const replaced=await decision(`license_number='LIC-A1' and recipient_email='tom@urbanxtracts.com'`);
  assert.deepEqual([replaced.send,replaced.reason,replaced.destination],[false,'recipient_no_longer_authorized',null]);
  assert.equal((await decision(`license_number='LIC-C1' and recipient_kind='main_contact'`)).recipientAuthorized,true);
  await sql(`insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status) values('${ownerCM}','${ownerC}','${orgC}','store','store_owner','active');`);
  assert.equal((await decision(`license_number='LIC-C1' and recipient_kind='main_contact'`)).reason,'superseded_by_account_owner');
  await sql(`update portal_organization_membership set status='disabled' where id='${ownerAM}';`);
  assert.equal((await decision(`license_number='LIC-A1' and recipient_kind='account_owner' and channel='in_portal'`)).reason,'recipient_no_longer_authorized');
  await sql(`update portal_organization_membership set status='active' where id='${ownerAM}';`);
  assert.equal(await count("portal_license_renewal_reminder where delivery_state<>'disabled_pending_release'"),0);
  await assert.rejects(sql(`insert into portal_license_renewal_reminder(dedupe_key,license_number,license_expires_on,due_on,recipient_kind,recipient_email,channel)
    values('forged','LIC-A1',current_date,current_date,'internal_compliance','x@example.invalid','in_portal');`),/23514/,'in-portal intent without a portal identity');
  await assert.rejects(sql(`insert into portal_license_renewal_reminder(dedupe_key,license_number,license_expires_on,due_on,recipient_kind,recipient_email,channel)
    values('forged2','LIC-A1',current_date,current_date,'main_contact','x@example.invalid','in_portal');`),/23514/);
  await assert.rejects(sql('update portal_license_reminder_config set delivery_enabled=true;'),/23514/);
  await assert.rejects(svc(`update portal_license_reminder_config set compliance_email='other@example.invalid';`),/42501/);
  await assert.rejects(svc(`select portal_set_license_reminder_recipient('${admin}','other@example.invalid','reaffirmed','Reviewed');`),/22023/);
  await svc(`select portal_set_license_reminder_recipient('${admin}','${compliance}@example.invalid','reaffirmed','Reaffirmation review record');`);
  assert.equal(await sql("select compliance_email_review||':'||delivery_enabled from portal_license_reminder_config;"),'reaffirmed:false');
  console.log('PASS: T-30 intents reach Owners, the designated main contact only without an Owner, and Internal Compliance by email and its portal identity; deduplicated; send-time authority re-checked; delivery off');
  console.log('PASS: an account with neither an Owner nor a valid main contact gets one append-only, deduplicated exception and no guessed recipient; Compliance is still planned; no outbox, email or SMS path exists');

  await assert.rejects(doc(ownerA,ownerAM,id(80)),/42501/); // Store access remains held.
  await sql('update portal_store_access_control set enabled=true;');
  const issued=JSON.parse(await doc(ownerA,ownerAM,id(80),'download'));
  assert.deepEqual([issued.objectPath,issued.onboardingRequestId,issued.sha256],[`${reqA}/${sha(80)}.pdf`,reqA,sha(80)]);
  for(const actor of [admin,finance,compliance]) assert.equal(JSON.parse(await doc(actor,null,id(81))).documentId,id(81));
  for(const [actor,membership,document] of [[ownerA,ownerAM,id(81)],[buyerA,buyerAM,id(80)],[staffA,staffAM,id(80)],[billingA,billingAM,id(80)],[ownerB,ownerBM,id(80)],
    [ownerA,ownerBM,id(80)],[ownerA,ownerAM,id(900)],[ownerA,ownerAM,id(82)],[admin,null,id(83)],[sales,null,id(80)],[forgedAdmin,null,id(80)],[ownerA,null,id(80)]]) {
    await assert.rejects(doc(actor,membership,document),/42501/,`${actor}:${document}`);
  }
  await assert.rejects(doc(admin,null,id(80),'delete'),/22023/);
  assert.equal(await sql(`select string_agg(actor_role||':'||access||':'||workspace,',' order by id) from portal_license_document_access_event;`),
    'store_owner:download:store,administrator:read:internal,finance:read:internal,compliance:read:internal');
  await assert.rejects(sql('update portal_license_document_access_event set access=\'read\';'),/42501/);
  await sql('update portal_store_access_control set enabled=false;');
  console.log('PASS: license documents allow only the owning Account Owner, Compliance, Finance and Administrator; billing, forged paths and dirty scans are denied; every allowed read is audited');

  await svc(`select portal_commit_store_demo('${admin}',0,'{}','place-hold');`);
  await assert.rejects(svc(`select portal_commit_store_demo('${admin}',1,'{}','finance-review');`),/22023/);
  await assert.rejects(svc(`select portal_commit_store_demo('${finance}',1,'{}','place-hold');`),/42501/);
  console.log('PASS: demo commit accepts the new synthetic control actions only for Internal Administrators and retires finance-review');
} finally {
  if(started)execFileSync('docker',['stop',container],{stdio:'pipe'});
}
