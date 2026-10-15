import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../../ux-portal-prototype.dc.html',import.meta.url),'utf8');
const methods=source.slice(source.indexOf('  refreshSession(force) {'),source.indexOf('\n  authenticatedUser(token) {'));
const normalize=source.slice(source.indexOf('function normalizeWorkspaceRows('),source.indexOf('\nconst INTEGRITY ='));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('Live dashboard does not invent package statistics or product reorder history',()=>{
  const fragment=source.slice(source.indexOf('    const dashRows ='),source.indexOf('\n    const od =',source.indexOf('    const dashRows =')));
  for(const isInternal of [true,false]){
    const rows=runInNewContext(`(()=>{${fragment};return dashRows;})()`,{isInternal,pendingApproval:[]});
    assert(!JSON.stringify(rows).match(/1,161|75%|Last ordered 34|Last ordered 41|Apple Motorbreath|New York Sunrise/));
  }
});
test('Live notification count and list do not represent prototype policies as events',()=>{
  const badge=source.match(/const badges = ([^\n]+);/)[1];
  const values=runInNewContext('('+badge+')',{cart:[],pendingApproval:[],s:{notifRead:false}});
  assert.equal(values.notifications,0);
  const start=source.indexOf('    const notifications =');
  const fragment=source.slice(start,source.indexOf('\n    const compareRows =',start));
  const rows=runInNewContext(`(()=>{${fragment};return notifications;})()`,{s:{},loc:{demo:false},notificationTag:'',TODAY:'fixture'});
  assert.equal(rows.length,0);
});
function fixture(fetch) {
  const stored=[];
  const api=runInNewContext(`({${methods.replace(/\n  }\n\n  portalFetch/,'\n  },\n\n  portalFetch')} });`,{
    fetch,SUPABASE_URL:'https://example.invalid',SUPABASE_KEY:'fixture',
    portalJwtClaims:()=>({role:'authenticated',sub:'actor',exp:9999999999}),
    storePortalSession:(...args)=>stored.push(args),Date,Promise,Error,
  });
  api.state={activeWorkspaceId:'store-a',authUser:{email:'actor@example.invalid'},token:'old',refreshToken:'refresh'};
  api.expirations=0;api.expireSession=()=>api.expirations++;
  api.setState=(update,done)=>{const patch=typeof update==='function'?update(api.state):update;if(patch) Object.assign(api.state,patch);done?.();};
  api.scheduleSessionRefresh=()=>{};api.stored=stored;
  return api;
}
test('Late Store response is rejected after a Brand workspace switch',async()=>{
  const pending=deferred(),api=fixture(()=>pending.promise),request=api.portalFetch('/fixture',{});
  api.state.activeWorkspaceId='brand-a';api._workspaceEpoch=1;
  pending.resolve({status:200,json:async()=>({secret:'old-store'})});
  await assert.rejects(request,/Workspace changed/);
});
test('Response body arriving after context switch is also rejected',async()=>{
  const body=deferred(),api=fixture(async()=>({status:200,json:()=>body.promise}));
  const response=await api.portalFetch('/fixture',{}),request=response.json();
  api.state.activeWorkspaceId='internal';body.resolve({secret:'old-store'});
  await assert.rejects(request,/Workspace changed/);
});
test('Leave and return to the same workspace cannot accept an older response',async()=>{
  const pending=deferred(),api=fixture(()=>pending.promise),request=api.portalFetch('/fixture',{});
  api._workspaceEpoch=2;pending.resolve({status:200,json:async()=>({})});
  await assert.rejects(request,/Workspace changed/);
});
test('A new session for the same email/workspace cannot accept the prior sessions response',async()=>{
  const pending=deferred(),api=fixture(()=>pending.promise),request=api.portalFetch('/fixture',{});
  api._sessionEpoch=1;pending.resolve({status:200,json:async()=>({})});
  await assert.rejects(request,/Workspace changed/);
});
test('Forbidden requests do not trigger token refresh',async()=>{
  const api=fixture(async()=>({status:403,json:async()=>({})}));let refreshed=0;
  api.refreshSession=async()=>{refreshed++;return 'new';};
  assert.equal((await api.portalFetch('/fixture',{})).status,403);assert.equal(refreshed,0);
});
test('Refresh completion for an old workspace does not sign out the new workspace',async()=>{
  const pending=deferred(),api=fixture(async()=>({status:401,json:async()=>({})}));
  api.refreshSession=()=>pending.promise;
  const request=api.portalFetch('/fixture',{});await Promise.resolve();await Promise.resolve();
  api.state.activeWorkspaceId='brand-a';api._workspaceEpoch=1;pending.resolve('new');
  await assert.rejects(request,/Workspace changed/);assert.equal(api.expirations,0);
});
test('A failed refresh for the current session still expires that session',async()=>{
  const api=fixture(async()=>({status:401,json:async()=>({})}));api.refreshSession=async()=>{throw new Error('refresh failed');};
  await assert.rejects(api.portalFetch('/fixture',{}),/refresh failed/);assert.equal(api.expirations,1);
});
test('Refresh arriving after sign-out/new login cannot overwrite the new identity token',async()=>{
  const pending=deferred(),api=fixture(()=>pending.promise),request=api.refreshSession(true);
  api.state.authUser={email:'new@example.invalid'};api.state.token='new-user';api.state.refreshToken='new-refresh';api._sessionEpoch=1;
  pending.resolve({ok:true,json:async()=>({access_token:'stale-user',refresh_token:'stale-refresh'})});
  await assert.rejects(request,/Session changed/);assert.equal(api.state.token,'new-user');assert.equal(api.stored.length,0);
});
test('Token rotation remains valid for the same identity across workspace switches',async()=>{
  const pending=deferred(),api=fixture(()=>pending.promise),request=api.refreshSession(true);
  api.state.activeWorkspaceId='brand-a';api._workspaceEpoch=1;
  pending.resolve({ok:true,json:async()=>({access_token:'rotated',refresh_token:'rotated-refresh'})});
  assert.equal(await request,'rotated');assert.equal(api.state.refreshToken,'rotated-refresh');assert.equal(api.stored.length,1);
});
test('Empty membership results never reconstruct Store access from legacy profile',()=>{
  const normalizeRows=runInNewContext(`(${normalize})`);
  assert.equal(normalizeRows([],{role:'owner',org:'Legacy retailer'}).length,0);
  assert.equal(normalizeRows(null,{role:'internal',staff_role:'administrator'}).length,0);
});
test('Concurrent refresh callers share one rotation request',async()=>{
  let calls=0;const pending=deferred(),api=fixture(()=>{calls++;return pending.promise;});
  const first=api.refreshSession(true),second=api.refreshSession(true);
  assert.equal(first,second);assert.equal(calls,1);
  pending.resolve({ok:true,json:async()=>({access_token:'rotated',refresh_token:'rotated-refresh'})});
  await first;
});
test('An older refresh finishing cannot clear the newer sessions in-flight refresh',async()=>{
  const old=deferred(),next=deferred();let calls=0;const api=fixture(()=>++calls===1?old.promise:next.promise);
  const first=api.refreshSession(true);first.catch(()=>{});
  api._sessionEpoch=1;api._sessionRefreshPromise=null;api.state.authUser={email:'new@example.invalid'};
  const second=api.refreshSession(true);
  old.resolve({ok:true,json:async()=>({access_token:'stale',refresh_token:'stale-refresh'})});
  await assert.rejects(first,/Session changed/);assert.equal(api._sessionRefreshPromise,second);
  next.resolve({ok:true,json:async()=>({access_token:'fresh',refresh_token:'fresh-refresh'})});await second;
});
test('Queued token state update cannot cross a newer sign-in',async()=>{
  const api=fixture(async()=>({ok:true,json:async()=>({access_token:'stale',refresh_token:'stale-refresh'})}));
  const queued=deferred();let apply;
  api.setState=(update,done)=>{apply=()=>{const patch=typeof update==='function'?update(api.state):update;if(patch)Object.assign(api.state,patch);done?.();};queued.resolve();};
  const request=api.refreshSession(true);await queued.promise;
  api._sessionEpoch=1;api.state.authUser={email:'new@example.invalid'};api.state.token='new';apply();
  await assert.rejects(request,/Session changed/);assert.equal(api.state.token,'new');assert.equal(api.stored.length,0);
});
for(const changed of [false,true]) test(`Scheduled refresh failure ${changed?'preserves a newer sign-in':'expires the current session'}`,async()=>{
  let fire;const code=source.slice(source.indexOf('  scheduleSessionRefresh('),source.indexOf('\n  expireSession() {'));
  const scheduler=runInNewContext(`({${code}})`,{portalJwtClaims:()=>({exp:9999999999}),Date,Math,setTimeout:fn=>{fire=fn;return 1;}});
  const pending=deferred(),api=fixture(()=>{});api.clearSessionRefresh=()=>{};api.refreshSession=()=>pending.promise;
  scheduler.scheduleSessionRefresh.call(api,'token','refresh');fire();
  if(changed){api._sessionEpoch=1;api.state.authUser={email:'new@example.invalid'};}
  pending.reject(new Error('old refresh failed'));await Promise.resolve();await Promise.resolve();
  assert.equal(api.expirations,changed?0:1);
});
function sessionChannel() {
  const code=source.slice(source.indexOf('  handleSessionSignal(message) {'),source.indexOf('\n  clearSessionRefresh() {'));
  const channels=[];
  class Channel {constructor(name){this.name=name;channels.push(this);}close(){this.closed=true;}}
  const api=runInNewContext(`({${code.replace(/\n  }\n\n  /g,'\n  },\n\n  ')} })`,{
    BroadcastChannel:Channel,portalJwtClaims:token=>({sub:token}),Date,Number,
  });
  api.state={token:'current-subject'};api.signOut=remote=>{api.signedOut=remote;};
  return {api,channels};
}
test('Sign-out in another tab clears the same identity without repeating the server logout',()=>{
  const {api,channels}=sessionChannel();api.startSessionChannel();
  channels[0].onmessage({data:{type:'signed-out',subject:'current-subject',at:Date.now()}});
  assert.equal(api.signedOut,true);
});
test('Cross-tab sign-out never affects another identity or accepts invalid/stale signals',()=>{
  const {api}=sessionChannel();
  for(const message of [null,{type:'signed-out',subject:'other',at:Date.now()},
    {type:'signed-out',subject:'current-subject',at:Date.now()-360000},
    {type:'signed-out',subject:'current-subject',at:Date.now()+60000},
    {type:'signed-in',subject:'current-subject',at:Date.now()},
    {type:'signed-out',subject:'current-subject',at:'now'}])api.handleSessionSignal(message);
  assert.equal(api.signedOut,undefined);
});
test('Session channel lifecycle closes prior listeners and cleans up on unmount',()=>{
  const {api,channels}=sessionChannel();api.startSessionChannel();api.startSessionChannel();
  assert.equal(channels[0].closed,true);assert.equal(channels[1].closed,undefined);
  api.stopSessionChannel();assert.equal(channels[1].closed,true);assert.equal(api._sessionChannel,null);
});
for(const legacyRole of ['brand','internal'])test('Workspace permissions use selected membership, not legacy '+legacyRole+' profile',async()=>{
  const code=source.slice(source.indexOf('  portalIdentity(token, emailHint, weak) {'),source.indexOf('\n  finishLoginIdentity('));
  const normalizeRows=runInNewContext(`(${normalize})`);let permissionReads=0;
  const api=runInNewContext(`({${code}})`,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_KEY:'fixture',PORTAL_ADMIN_API:'https://fixture.invalid/functions/v1/portal-admin',
    STAFF_PERMISSIONS:['users.manage'],normalizeWorkspaceRows:normalizeRows,Error,Promise,
    fetch:async(url,options)=>{
      if(url.endsWith('/auth/v1/user'))return Response.json({id:'actor',email:'fixture@example.invalid'});
      if(url.includes('/portal_profile?'))return Response.json([{id:'actor',role:legacyRole,staff_role:'administrator',active:true}]);
      if(url.endsWith('/portal_my_workspaces'))return Response.json([{membership_id:'viewer-member',organization_id:'internal-org',organization_name:'Internal',workspace:'internal',member_role:'viewer'}]);
      assert.equal(url,'https://fixture.invalid/functions/v1/portal-admin');permissionReads++;
      assert.equal(options.headers['x-ux-membership-id'],'viewer-member');assert.equal(options.headers['x-ux-organization-id'],'internal-org');
      assert.equal(JSON.parse(options.body).action,'workspace-permissions');
      return Response.json({memberRole:'viewer',permissions:[]});
    },
  });
  const result=await api.portalIdentity('synthetic',null,null);
  assert.equal(permissionReads,1);assert.equal(result.workspaces[0].memberRole,'viewer');assert.equal(result.workspaces[0].permissions.length,0);
});
test('Member role disagreement in the permission response blocks login instead of guessing grants',async()=>{
  const code=source.slice(source.indexOf('  portalIdentity(token, emailHint, weak) {'),source.indexOf('\n  finishLoginIdentity('));
  const api=runInNewContext(`({${code}})`,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_KEY:'fixture',PORTAL_ADMIN_API:'https://fixture.invalid/functions/v1/portal-admin',
    STAFF_PERMISSIONS:['users.manage'],normalizeWorkspaceRows:runInNewContext(`(${normalize})`),Error,Promise,
    fetch:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:'actor',email:'fixture@example.invalid'}:
      url.includes('/portal_profile?')?[{id:'actor',role:'internal',active:true}]:url.endsWith('/portal_my_workspaces')?
      [{membership_id:'selected',organization_id:'org',organization_name:'Internal',workspace:'internal',member_role:'viewer'}]:
      {memberRole:'administrator',permissions:['users.manage']}),
  });
  await assert.rejects(api.portalIdentity('synthetic'),/access unavailable/);
});
test('Responsive layout measures the CSS viewport rather than overflow-expanded mobile innerWidth',()=>{
  const start=source.indexOf('    this._onResize = () =>');
  const resize=source.slice(start,source.indexOf("    window.addEventListener('resize'",start));
  let width;
  const measure=runInNewContext(`(function(){${resize};this._onResize();})`,{window:{innerWidth:1049},document:{documentElement:{clientWidth:390}}});
  measure.call({setState:patch=>{width=patch.vw;}});assert.equal(width,390);
});
