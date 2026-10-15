// Legacy Administrator Users tooling: Billing management and read-only View as.
// Evaluates the prototype's own helper constants and component methods against
// a stub component. Every live path (portal-admin, intake, QuickBooks fetch)
// throws if touched, so a pass proves the synthetic flows never reach them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../../ux-portal-prototype.dc.html',import.meta.url),'utf8');
const logic=source.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const helpers=logic.slice(logic.indexOf('/* Legacy Users tooling'),logic.indexOf('const SEED_AUDIT'));
// Extract one class method (or top-level function) by brace matching, skipping comments, string and template contents.
function method(name,prefix='\n  '){
  const start=logic.indexOf(prefix+name+'(');
  assert(start>=0,name);
  let i=logic.indexOf(')',start),depth=0,quote=null;
  i=logic.indexOf('{',i);
  for(;i<logic.length;i++){
    const c=logic[i];
    if(quote){if(c==='\\')i++;else if(c===quote)quote=null;continue;}
    if(c==='/'&&logic[i+1]==='/'){i=logic.indexOf('\n',i);continue;}
    if(c==='/'&&logic[i+1]==='*'){i=logic.indexOf('*/',i)+1;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;continue;}
    if(c==='{')depth++;
    else if(c==='}'&&--depth===0)return logic.slice(start,i+1);
  }
  throw Error('Unterminated method '+name);
}
const names=['signIn','switchWorkspace','finishLoginIdentity','impersonate','loadFinancials','userActionStores','openUserActions','saveUserActions','reactivateUser','auSubmit','auLocationPool'];
const functions=['legacyWorkspaceRows','normalizeWorkspaceRows','emptyAgreementCommercialState'].map(name=>method(name,'\nfunction '));
const live=label=>()=>{throw Error('Live path touched: '+label);};
function component(state={}){
  const context={DEMO_ORG:'Cannabis Store (DEMO)',LEGACY_DEMO_ORG:'Executive Demo Retail Group',USERS:[],LOCATIONS:[],
    isDemoOrganization:v=>['Cannabis Store (DEMO)','Executive Demo Retail Group'].includes(String(v||'')),
    usDateToIso:()=>'',isoDateToUs:()=>'',QUICKBOOKS_ACCOUNTS_API:'qbo-accounts',QUICKBOOKS_FINANCIALS_API:'qbo-financials',SUPABASE_KEY:'',
    PRODUCTS:[],DEMO_SEED_ORDERS:[],CANIX_INVENTORY_SNAPSHOT:null,QUICKBOOKS_DEMO_ACCOUNTS:[],
    storePortalSession:(...args)=>stored.push(args),window:{confirm:live('confirm')}};
  const stored=[];
  const proto=runInNewContext(`${helpers};${functions.join('\n')};({${names.map(name=>method(name)).join(',')}})`,context);
  const c=Object.create(proto);
  c.state={role:'internal',authUser:{staffRole:'administrator'},token:'administrator-token',impersonating:null,accessPending:null,
    extraUsers:[],liveUsers:[],userOverrides:{},deactivated:[],audit:[],retailerAccounts:[],auAccountType:'standard',auLocs:[],
    financialLoading:false,financialLoaded:false,...state};
  c.setState=patch=>{Object.assign(c.state,typeof patch==='function'?patch(c.state):patch);};
  c.set=c.setState;
  c.requirePermission=()=>true;c.hasPermission=()=>true;
  c.logAudit=(action,subject,detail)=>c.state.audit.push({action,subject,detail});
  c.loc=()=>({demo:false});c.availableLocations=()=>[];
  c.portalAdmin=live('portal-admin');c.post=live('portal-intake');c.portalFetch=live('quickbooks');
  c.stored=stored;c.scheduled=[];c.scheduleSessionRefresh=(...args)=>c.scheduled.push(args);
  return {c,context};
}
// Objects built inside the vm realm compare by value only after a JSON round trip.
const plain=value=>JSON.parse(JSON.stringify(value));
const synthetic=(role,extra={})=>({name:'Synthetic '+role,email:role.toLowerCase().replace(/\W+/g,'-')+'@example.invalid',org:'Cannabis Store (DEMO)',
  role,locs:'',synthetic:true,...extra});

test('Role mapping is explicit: Billing never falls back to Owner or Buyer, unknown roles map to nothing',()=>{
  const key=runInNewContext(`${helpers};legacyStoreRoleKey`,{});
  assert.equal(key({role:'Billing contact'}),'billing');assert.equal(key({role:'Billing'}),'billing');assert.equal(key({sourceRole:'billing',role:'Store owner'}),'billing');
  assert.equal(key({role:'Store owner'}),'owner');assert.equal(key({role:'Buyer'}),'buyer');assert.equal(key({role:'Budtender'}),'budtender');
  for(const role of ['Account management','Administrator','Kiosk device','billing manager','',undefined]) assert.equal(key({role}),null,String(role));
  assert.equal(key({sourceRole:'internal',role:'Buyer'}),'buyer','an unlisted source role defers to the label, never to Owner');
});
test('Location rule: Owner and Billing get every location, Buyer at least one, Budtender exactly one',()=>{
  const rule=(...args)=>plain(runInNewContext(`${helpers};legacyStoreLocationRule`,{})(...args));const all=['A','B'];
  for(const role of ['owner','billing']) assert.deepEqual(rule(role,[],all),{ok:true,licenses:['A','B'],label:'All 2 locations'});
  assert.equal(rule('buyer',[],all).ok,false);assert.deepEqual(rule('buyer',['B'],all).licenses,['B']);
  assert.equal(rule('budtender',['A','B'],all).ok,false);assert.equal(rule('budtender',[],all).ok,false);assert.deepEqual(rule('budtender',['A'],all).licenses,['A']);
  assert.equal(rule('manager',['A'],all).ok,false);
});
test('View as Billing enters read-only Financials and never loads live QuickBooks data under the Administrator token',async()=>{
  const {c}=component();
  c.impersonate(synthetic('Billing contact'));
  assert.equal(c.state.role,'billing');assert.equal(c.state.screen,'receivables');assert.equal(c.state.impersonating.sourceRole,'billing');
  assert.equal(c.state.financialData,null);assert.match(c.state.toast,/Billing\)\. Read-only financials only/);
  await c.loadFinancials(true);await c.loadFinancials();
  const owner=component().c;owner.impersonate(synthetic('Store owner'));assert.equal(owner.state.role,'owner');assert.equal(owner.state.screen,'dash');
  const buyer=component().c;buyer.impersonate(synthetic('Buyer'));assert.equal(buyer.state.role,'buyer');
  const budtender=component().c;budtender.impersonate(synthetic('Budtender'));assert.equal(budtender.state.screen,'kiosk');
  const unknown=component().c;unknown.impersonate(synthetic('Account management'));
  assert.equal(unknown.state.impersonating,null);assert.equal(unknown.state.role,'internal');assert.match(unknown.state.toast,/No session was started/);
});
const billingWorkspace={membership_id:'m-billing',organization_id:'o-1',organization_kind:'retailer',organization_name:'Retailer One',
  workspace:'store',member_role:'store_billing',is_default:true};
// loadAuthenticatedSession hands finishLoginIdentity rows already normalized (and permission-checked) by the prototype itself.
const normalized=rows=>runInNewContext(`${functions[1]};normalizeWorkspaceRows`,{})(rows,{}).map(row=>({...row,permissions:[]}));
test('Authenticated store_billing sign-in is recognized as Billing contact and lands in read-only Financials',()=>{
  // The real authenticated path: finishLoginIdentity derives the label from the membership, then signIn maps it.
  const {c}=component({role:null,authUser:null,token:null});c.scheduleSessionRefresh=()=>{};
  c.finishLoginIdentity({me:{id:'u-1',full_name:'Billing Person',org:'Retailer One',role:'billing',locations:''},
    token:'billing-token',email:'billing@retailer.example',workspaces:normalized([billingWorkspace]),workspaceResolution:'membership'});
  assert.equal(c.state.role,'billing');assert.equal(c.state.screen,'receivables');assert.equal(c.state.toastKind,'SIGNED IN');
  assert.equal(c.state.authUser.role,'Billing contact');assert.equal(c.state.activeWorkspaceId,'m-billing');
  assert.deepEqual(plain(c.state.authUser.permissions),[]);
  // Both explicit Billing labels map to billing, with or without verified workspace rows.
  for(const label of ['Billing contact','Billing']){
    const direct=component({role:null,authUser:null}).c;
    direct.signIn({name:'B',email:'b@retailer.example',org:'Retailer One',role:label,locs:'',workspaces:[{id:'m-billing',organization:'Retailer One',workspace:'store',memberRole:'store_billing',isDefault:true}]});
    assert.equal(direct.state.role,'billing',label);assert.equal(direct.state.screen,'receivables',label);
    const legacy=component({role:null,authUser:null}).c;
    legacy.signIn({name:'B',email:'b@retailer.example',org:'Retailer One',role:label,locs:''});
    assert.equal(legacy.state.role,'billing',label+' legacy');assert.equal(legacy.state.screen,'receivables',label+' legacy');
    assert.equal(legacy.state.workspaces[0].memberRole,'store_billing',label+' legacy');
  }
});
test('signIn refuses unknown roles instead of falling back to any portal role',()=>{
  for(const label of ['billing','Billing manager','Administrator','Kiosk device','',undefined]){
    const {c}=component({role:null,authUser:null,screen:'login'});
    c.signIn({name:'X',email:'x@retailer.example',org:'Retailer One',role:label,locs:'',workspaces:[billingWorkspace]});
    assert.equal(c.state.role,null,String(label));assert.equal(c.state.authUser,null,String(label));assert.equal(c.state.screen,'login',String(label));
    assert.equal(c.state.toastKind,'NO ROLE',String(label));
  }
  // An authenticated membership with an unrecognized store role derives no label and is refused before any session is kept.
  const {c}=component({role:null,authUser:null,token:null});
  assert.throws(()=>c.finishLoginIdentity({me:{id:'u-2',full_name:'Unknown',org:'Retailer One',role:'owner',locations:''},token:'t',email:'u@retailer.example',
    workspaces:normalized([{...billingWorkspace,member_role:'store_manager'}]),workspaceResolution:'membership'}),/access not assigned/);
  assert.equal(c.state.role,null);assert.equal(c.state.authUser,null);assert.equal(c.state.token,null);
  assert.equal(c.stored.length,0);assert.equal(c.scheduled.length,0);
});
const KNOWN_MEMBER_ROLES={internal:['administrator','operations','sales','quality','viewer'],
  brand:['brand_owner','brand_manager','brand_contributor','brand_viewer'],
  store:['store_owner','store_buyer','store_billing','store_staff']};
const STORE_ROLE={store_owner:['owner','dash','Store owner'],store_buyer:['buyer','dash','Buyer'],
  store_billing:['billing','receivables','Billing contact'],store_staff:['budtender','kiosk','Budtender']};
const UNKNOWN_MEMBER_ROLES=[['store','store_manager'],['store','manager'],['store','owner'],['store','budtender'],['store','Store_Owner'],['store','brand_viewer'],
  ['store','administrator'],['store',''],['store','constructor'],['store','__proto__'],['store','toString'],
  ['internal','finance'],['internal','store_owner'],['internal','brand_owner'],['internal','Administrator'],['internal',''],['internal','constructor'],
  ['brand','brand_preview'],['brand','brand_management'],['brand','store_staff'],['brand','viewer'],['brand',''],['brand','hasOwnProperty']];
const membership=(workspace,member_role,extra={})=>({membership_id:'m-'+workspace+'-'+(member_role||'blank'),organization_id:'o-'+workspace,
  organization_kind:workspace==='store'?'retailer':workspace,organization_name:workspace+' organization',workspace,member_role,is_default:true,...extra});
const normalize=rows=>plain(runInNewContext(`${functions[1]};normalizeWorkspaceRows`,{})(rows,{}));
test('Membership rows are allowlisted per workspace: every known role is kept, unknown roles never become selectable',()=>{
  for(const [workspace,roles] of Object.entries(KNOWN_MEMBER_ROLES)) for(const role of roles){
    const [row]=normalize([membership(workspace,role)]);
    assert.equal(row?.memberRole,role,workspace+'/'+role);assert.equal(row.workspace,workspace);
  }
  for(const [workspace,role] of UNKNOWN_MEMBER_ROLES) assert.deepEqual(normalize([membership(workspace,role)]),[],workspace+'/'+role);
  // Mixed rows: the unknown default is dropped, the valid membership survives.
  const mixed=normalize([membership('store','store_manager'),membership('store','store_buyer',{is_default:false})]);
  assert.deepEqual(mixed.map(row=>row.memberRole),['store_buyer']);
  assert.deepEqual(normalize([{...membership('store','store_owner'),workspace:'retail'}]),[]);
});
test('signIn resolves every known membership explicitly and refuses unknown roles without opening Budtender',()=>{
  for(const [memberRole,[role,screen,label]] of Object.entries(STORE_ROLE)){
    const {c}=component({role:null,authUser:null});
    c.signIn({name:'S',email:'s@retailer.example',org:'Retailer One',role:label,locs:'',workspaces:normalized([membership('store',memberRole)])});
    assert.equal(c.state.role,role,memberRole);assert.equal(c.state.screen,screen,memberRole);assert.equal(c.state.activeWorkspaceId,'m-store-'+memberRole);
  }
  for(const memberRole of KNOWN_MEMBER_ROLES.internal){
    const {c}=component({role:null,authUser:null});
    c.signIn({name:'I',email:'i@urbanxtracts.example',org:'urbanXtracts',role:'Account management',locs:'',staffRole:memberRole,workspaces:normalized([membership('internal',memberRole)])});
    assert.equal(c.state.role,'internal',memberRole);assert.equal(c.state.authUser.staffRole,memberRole);assert.equal(c.state.screen,'dash');
  }
  for(const memberRole of KNOWN_MEMBER_ROLES.brand){
    const {c}=component({role:null,authUser:null});
    c.signIn({name:'B',email:'b@brand.example',org:'Brand One',role:'Brand member',locs:'',workspaces:normalized([membership('brand',memberRole)])});
    assert.equal(c.state.role,'brand',memberRole);assert.equal(c.state.screen,'brand-home',memberRole);
  }
  // Unknown memberships reaching signIn directly (not pre-normalized) are refused for every label, including Budtender.
  for(const [workspace,memberRole] of UNKNOWN_MEMBER_ROLES) for(const label of ['Budtender','Store owner','Account management','Brand member']){
    const {c}=component({role:null,authUser:null,screen:'login'});
    c.signIn({name:'U',email:'u@retailer.example',org:'Retailer One',role:label,locs:'',
      workspaces:[{id:'m-unknown',organization:'Retailer One',workspace,memberRole,isDefault:true}]});
    const at=workspace+'/'+memberRole+' as '+label;
    assert.equal(c.state.role,null,at);assert.notEqual(c.state.role,'budtender',at);assert.equal(c.state.authUser,null,at);
    assert.equal(c.state.screen,'login',at);assert.equal(c.state.toastKind,'NO ROLE',at);
    assert(!c.state.audit.some(entry=>entry.action==='Signed in'),at);
  }
  // A valid membership beside an unknown default is the one opened; the unknown row is not selectable.
  const {c}=component({role:null,authUser:null});
  c.signIn({name:'M',email:'m@retailer.example',org:'Retailer One',role:'Budtender',locs:'',workspaces:[
    {id:'m-manager',organization:'Retailer One',workspace:'store',memberRole:'store_manager',isDefault:true},
    {id:'m-buyer',organization:'Retailer One',workspace:'store',memberRole:'store_buyer',isDefault:false}]});
  assert.equal(c.state.role,'buyer');assert.equal(c.state.activeWorkspaceId,'m-buyer');assert.deepEqual(c.state.workspaces.map(row=>row.id),['m-buyer']);
  // Legacy (no membership rows) internal accounts with an unrecognized staff role are refused too.
  const legacy=component({role:null,authUser:null}).c;
  legacy.signIn({name:'L',email:'l@urbanxtracts.example',org:'urbanXtracts',role:'Account management',locs:'',staffRole:'finance'});
  assert.equal(legacy.state.role,null);assert.equal(legacy.state.toastKind,'NO ROLE');
});
test('switchWorkspace opens only known memberships and refuses an unknown role without changing workspace',()=>{
  const rows=[...Object.keys(STORE_ROLE).map(role=>membership('store',role,{is_default:role==='store_owner'})),
    ...KNOWN_MEMBER_ROLES.internal.map(role=>membership('internal',role,{is_default:false})),
    ...KNOWN_MEMBER_ROLES.brand.map(role=>membership('brand',role,{is_default:false}))];
  const {c}=component({role:null,authUser:null});
  c.signIn({name:'S',email:'s@retailer.example',org:'Retailer One',role:'Store owner',locs:'',workspaces:normalized(rows)});
  assert.equal(c.state.role,'owner');
  for(const [memberRole,[role,screen]] of Object.entries(STORE_ROLE)){
    c.switchWorkspace('m-store-'+memberRole);
    assert.equal(c.state.role,role,memberRole);assert.equal(c.state.screen,screen,memberRole);assert.equal(c.state.activeWorkspaceId,'m-store-'+memberRole);
  }
  for(const memberRole of KNOWN_MEMBER_ROLES.internal){c.switchWorkspace('m-internal-'+memberRole);assert.equal(c.state.role,'internal');assert.equal(c.state.authUser.staffRole,memberRole);}
  for(const memberRole of KNOWN_MEMBER_ROLES.brand){c.switchWorkspace('m-brand-'+memberRole);assert.equal(c.state.role,'brand');assert.equal(c.state.screen,'brand-home');}
  c.switchWorkspace('m-store-store_owner');
  // Rows injected into state without normalization are still refused at switch time.
  for(const [workspace,memberRole] of UNKNOWN_MEMBER_ROLES){
    c.setState({workspaces:[...c.state.workspaces,{id:'m-injected',organization:'Injected',workspace,memberRole,isDefault:false,permissions:['users.manage']}],toastKind:null});
    c.switchWorkspace('m-injected');
    const at=workspace+'/'+memberRole;
    assert.equal(c.state.role,'owner',at);assert.notEqual(c.state.role,'budtender',at);assert.equal(c.state.activeWorkspaceId,'m-store-store_owner',at);
    assert.equal(c.state.screen,'dash',at);assert.deepEqual(plain(c.state.authUser.permissions),[],at);assert.equal(c.state.toastKind,'BLOCKED \u2014 ACCESS',at);
    c.setState({workspaces:c.state.workspaces.filter(row=>row.id!=='m-injected')});
  }
});
const identity=(workspaces,extra={})=>({me:{id:'u-1',full_name:'Person',org:'Retailer One',role:'owner',locations:''},
  token:'access-token',refreshToken:'refresh-token',email:'person@retailer.example',workspaces,workspaceResolution:'membership',...extra});
test('finishLoginIdentity keeps and schedules a session only for a recognized membership',()=>{
  for(const [workspace,roles] of Object.entries(KNOWN_MEMBER_ROLES)) for(const memberRole of roles){
    const {c}=component({role:null,authUser:null,token:null});
    c.finishLoginIdentity(identity(normalized([membership(workspace,memberRole)])));
    const at=workspace+'/'+memberRole;
    assert.equal(c.state.toastKind,'SIGNED IN',at);assert.equal(c.state.token,'access-token',at);
    assert.equal(c.stored.length,1,at);assert.equal(c.scheduled.length,1,at);
    assert.equal(c.state.role,workspace==='store'?STORE_ROLE[memberRole][0]:workspace,at);
  }
  // Unknown roles: whether filtered upstream (no workspaces left) or arriving raw, nothing is kept or scheduled.
  for(const [workspace,memberRole] of UNKNOWN_MEMBER_ROLES) for(const rows of [normalized([membership(workspace,memberRole)]),
    [{id:'m-raw',organization:'Retailer One',workspace,memberRole,isDefault:true,permissions:[]}]]){
    const {c}=component({role:null,authUser:null,token:null,refreshToken:null,screen:'login'});
    const at=workspace+'/'+memberRole+' rows='+rows.length;
    assert.throws(()=>c.finishLoginIdentity(identity(rows)),/^Error: access not assigned$/,at);
    assert.equal(c.state.authUser,null,at);assert.equal(c.state.role,null,at);assert.notEqual(c.state.role,'budtender',at);
    assert.equal(c.state.token,null,at);assert.equal(c.state.refreshToken,null,at);assert.equal(c.state.screen,'login',at);
    assert.equal(c.stored.length,0,at);assert.equal(c.scheduled.length,0,at);
  }
  // An unknown default beside a valid membership opens the valid one.
  const {c}=component({role:null,authUser:null,token:null});
  c.finishLoginIdentity(identity(normalized([membership('store','store_manager'),membership('store','store_billing',{is_default:false})])));
  assert.equal(c.state.role,'billing');assert.equal(c.stored.length,1);
});
// A recording stand-in for the QuickBooks financial endpoint.
function recorder(c){
  const calls=[];
  c.portalFetch=(url,options)=>{calls.push({url,method:options.method,authorization:options.headers.Authorization});
    return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({invoices:[],payments:[],byStore:[]})});};
  return calls;
}
test('Every retailer View as session, including Owner, makes zero live financial requests under the Administrator token',async()=>{
  for(const label of ['Store owner','Billing contact','Buyer','Budtender']){
    const {c}=component();c.impersonate(synthetic(label,{org:'Retailer One'}));
    assert(c.state.impersonating,label);
    const calls=recorder(c);
    await c.loadFinancials(true);await c.loadFinancials();
    assert.equal(calls.length,0,label);assert.equal(c.state.financialData,null,label);assert.notEqual(c.state.financialLoading,true,label);
  }
  // Directly impersonating state for Owner and Billing, independent of how the session started.
  for(const role of ['owner','billing']){
    const {c}=component({role,impersonating:synthetic(role==='owner'?'Store owner':'Billing contact',{sourceRole:role})});
    const calls=recorder(c);
    await c.loadFinancials(true);await c.loadFinancials(false);
    assert.equal(calls.length,0,role);
  }
});
test('Ordinary authenticated Owner, Billing and Internal Finance remain eligible for the server-scoped financial endpoint',async()=>{
  for(const role of ['owner','billing']){
    const {c}=component({role,authUser:{name:'Store user',role:role==='owner'?'Store owner':'Billing contact'},token:role+'-token'});
    c.hasPermission=()=>false;
    const calls=recorder(c);
    await c.loadFinancials();
    assert.deepEqual(calls,[{url:'qbo-financials',method:'GET',authorization:'Bearer '+role+'-token'}],role);
    assert.equal(c.state.financialLoaded,true,role);assert.equal(c.state.financialError,null,role);
  }
  const finance=component({role:'internal',authUser:{staffRole:'finance'},token:'finance-token'}).c;
  finance.hasPermission=permission=>permission==='financials.read';
  const calls=recorder(finance);await finance.loadFinancials();
  assert.deepEqual(calls,[{url:'qbo-financials',method:'GET',authorization:'Bearer finance-token'}]);
  // Buyers and Internal staff without financials.read stay excluded.
  for(const [role,permitted] of [['buyer',true],['budtender',true],['internal',false]]){
    const {c}=component({role,token:'t'});c.hasPermission=()=>permitted;const none=recorder(c);
    await c.loadFinancials(true);assert.equal(none.length,0,role);
  }
});
test('Demo add-user requires a synthetic .invalid address and never invites, emails or writes the live directory',()=>{
  for(const email of ['billing@urbanxtracts.com','billing@example.com','billing@invalid.example']){
    const {c}=component({auRole:'Billing',auName:'Synthetic Billing',auEmail:email});
    c.auSubmit();assert.match(c.state.auErr,/\.invalid address/);assert.equal(c.state.extraUsers.length,0);
  }
  const {c}=component({auRole:'Billing',auName:'Synthetic Billing',auEmail:'Billing@Example.invalid'});
  c.auSubmit();
  const [user]=c.state.extraUsers;
  assert.deepEqual([user.email,user.role,user.sourceRole,user.locs,user.synthetic,user.org],['billing@example.invalid','Billing contact','billing','All 2 locations',true,'Cannabis Store (DEMO)']);
  assert.match(c.state.toast,/No invitation or email was sent/);assert.equal(c.state.audit[0].action,'Synthetic demo user added');
  c.setState({auRole:'Budtender',auName:'Two stores',auEmail:'bud@example.invalid',auLocs:['DEMO-UX-STORE-001','DEMO-UX-STORE-002']});
  c.auSubmit();assert.match(c.state.auErr,/exactly one store/);
  c.setState({auRole:'Buyer',auName:'No stores',auEmail:'buyer@example.invalid',auLocs:[]});
  c.auSubmit();assert.match(c.state.auErr,/at least one store/);
  c.setState({auRole:'Billing',auName:'Duplicate',auEmail:'billing@example.invalid'});
  c.auSubmit();assert.match(c.state.auErr,/already listed/);
  // A non-synthetic retailer role choice cannot reach any live invitation.
  c.setState({auRole:'Account management',auName:'Live',auEmail:'person@retailer.example'});
  c.auSubmit();assert.match(c.state.auErr,/Live retailer invitations remain held/);
});
test('Synthetic users are managed locally as Owner, Buyer, Billing or Budtender with the location rules; nothing live is written',()=>{
  const user=synthetic('Buyer',{sourceRole:'buyer',locs:'Demo Store #1'});
  const {c}=component();
  c.openUserActions(user);assert.equal(c.state.userActionRole,'buyer');
  c.setState({userActionRole:'billing',userActionLocations:[]});c.saveUserActions(user);
  assert.deepEqual(plain(c.state.userOverrides[user.email]),{role:'Billing contact',sourceRole:'billing',locs:'All 2 locations'});
  assert.match(c.state.toast,/no live permission changed and nothing was sent/);
  const billing={...user,...c.state.userOverrides[user.email]};
  c.openUserActions(billing);assert.equal(c.state.userActionRole,'billing');assert.deepEqual(plain(c.state.userActionLocations),['DEMO-UX-STORE-001','DEMO-UX-STORE-002']);
  c.setState({userActionRole:'budtender',userActionLocations:['DEMO-UX-STORE-001','DEMO-UX-STORE-002']});c.saveUserActions(billing);
  assert.match(c.state.userActionError,/exactly one store/);
  c.setState({userActionRole:'budtender',userActionLocations:['DEMO-UX-STORE-002'],userActionError:null});c.saveUserActions(billing);
  assert.equal(c.state.userOverrides[user.email].locs,'DEMO-UX-STORE-002');
  c.setState({userActionEmail:user.email,userActionRole:'owner',userActionLocations:[]});c.saveUserActions(billing);
  assert.equal(c.state.userOverrides[user.email].role,'Store owner');
  // An unrecognized role is refused rather than opened as Buyer.
  const before=c.state.userActionEmail;c.setState({userActionEmail:null});
  c.openUserActions(synthetic('Account management'));assert.equal(c.state.userActionEmail,null);assert.match(c.state.toast,/can be managed here/);
  assert.notEqual(before,undefined);
  // A read-only View as session cannot manage anyone.
  const viewing=component({impersonating:synthetic('Billing contact')}).c;viewing.openUserActions(user);assert.equal(viewing.state.userActionEmail,undefined);
});
test('Store Demo stylesheet reflows at 820px without fixed minimum widths and keeps 44px touch targets',()=>{
  const css=source.match(/<style id="store-demo-workspace">([\s\S]*?)<\/style>/)[1];
  const narrow=css.slice(css.indexOf('@media (max-width:820px)'));
  for(const rule of ['.sd-context{grid-template-columns:minmax(0,1fr)','.sd-status{grid-template-columns:minmax(0,1fr)','.sd-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.sd-toolbar{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}','.sd-draft-line{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}','.sd-btn,.sd-input,.sd-fixed{min-height:44px}',
    '.sd-table td::before{content:attr(data-label)']) assert(narrow.includes(rule),rule);
  // Every grid track either shrinks to zero or is capped at the container width; no fixed track can force overflow.
  for(const [,tracks] of css.matchAll(/grid-template-columns:([^;}]+)/g)){
    for(const [,min] of tracks.matchAll(/minmax\((min\([^)]*\)|[^,]+),/g)) assert(/^(0|min\(100%,\d+px\))$/.test(min.trim()),'unsafe minimum '+tracks);
    for(const px of tracks.replace(/minmax\([^)]*\)|min\([^)]*\)/g,'').matchAll(/(\d+)px/g)) assert(Number(px[1])<=110,'fixed track '+tracks);
  }
  assert(css.includes('.sd *{min-width:0}')&&css.includes('overflow-wrap:anywhere'));
  const template=source.slice(source.indexOf('<section aria-label="Internal Administrator Store Demo" class="sd">'),source.indexOf('</section>\n</sc-if>',source.indexOf('class="sd"')));
  for(const [,style] of template.matchAll(/style="([^"]*)"/g)) assert(!/(?:^|;)\s*(?:min-)?width:\s*\d{3,}px/.test(style),'no inline fixed or minimum width over 99px: '+style);
  for(const label of ['aria-label="Demo controls"','aria-label="Demo status"','aria-label="Store demo sections"','<h1>urbanXtracts Store</h1>','<h2 class="sd-state"']) assert(template.includes(label),label);
  assert.equal((template.match(/<button /g)||[]).length,(template.match(/<button type="button"/g)||[]).length,'every Store Demo button is type="button"');
});
