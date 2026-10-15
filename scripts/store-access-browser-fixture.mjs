// Isolated browser integration fixture: real portal UI + portal-admin adapter
// + PostgreSQL membership commands. Auth is explicitly synthetic, not SSO/UAT.
// No production credentials, mail, source refresh, or external API is accepted.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {randomUUID,webcrypto} from 'node:crypto';
const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const address='http://127.0.0.1:4174';
const image='postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
const container='ux-store-browser-'+randomUUID().slice(0,8);
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const users=[{id:id(1),email:'candidate-admin@urbanxtracts.com',app_metadata:{}},
  {id:id(10),email:'owner@example.invalid',app_metadata:{}},{id:id(12),email:'buyer@example.invalid',app_metadata:{}},
  {id:id(14),email:'new-member@example.invalid',app_metadata:{}}];
const token='fixture.'+Buffer.from(JSON.stringify({sub:id(1),role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.local-only';
const quote=value=>value==null?'null':"'"+String(value).replaceAll("'","''")+"'";
const name=value=>{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw Error('Invalid fixture identifier');return '"'+value+'"';};
function sql(query,service=true){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']);
  let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);
  child.on('error',reject);child.on('close',code=>code===0?resolve(output.trim()):reject(Object.assign(Error(error),{code:error.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]})));
  child.stdin.end((service?'set role service_role;':'')+query);
});}
const jsonValue=output=>JSON.parse(output.split('\n').findLast(line=>line.startsWith('{')||line.startsWith('[')||line==='null')||'null');
const database={
  from(table){const conditions=[];let sort='',limit='',single=false;
    const q={select(){return q;},eq(k,v){conditions.push(`${name(k)}=${typeof v==='boolean'?v:quote(v)}`);return q;},
      is(k,v){if(v!==null)throw Error('Unsupported fixture filter');conditions.push(`${name(k)} is null`);return q;},
      in(k,values){conditions.push(values.length?`${name(k)} in (${values.map(quote).join(',')})`:'false');return q;},
      order(k){sort=' order by '+name(k);return q;},limit(n){if(!Number.isInteger(n)||n>1000)throw Error('Fixture bound exceeded');limit=' limit '+n;return q;},
      maybeSingle(){single=true;return execute();},then(a,b){return execute().then(a,b);}};
    async function execute(){try{const rows=jsonValue(await sql(`select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select * from ${name(table)}${conditions.length?' where '+conditions.join(' and '):''}${sort}${limit}) t;`));
      return {data:single?rows[0]||null:rows,error:null};}catch(error){return {data:null,error:{code:error.code,message:error.message}};}}
    return q;
  },
  async rpc(fn,args){const allowed=['portal_resolve_store_context','portal_manage_store_membership'];
    if(!allowed.includes(fn))throw Error('Unapproved fixture RPC');
    const values=Object.entries(args).map(([key,value])=>name(key)+'=>'+(Array.isArray(value)&&key==='p_licenses'
      ?`array[${value.map(quote).join(',')}]::text[]`:quote(typeof value==='object'&&value!==null?JSON.stringify(value):value)));
    try{return {data:jsonValue(await sql(`select ${name(fn)}(${values.join(',')});`)),error:null};}
    catch(error){return {data:null,error:{code:error.code,message:error.message}};}
  },
  auth:{admin:{getUserById:async uid=>({data:{user:users.find(user=>user.id===uid)||null},error:null}),
    listUsers:async ({page})=>({data:{users:page===1?users:[]},error:null})}},
};
function load(path,deps,names){const source=stripTypeScriptTypes(read('supabase/functions/'+path)
  .replace(/^import[\s\S]*?from\s*['"][^'"]+['"];\s*$/gm,'').replace(/^export\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];\s*$/gm,''))
  .replace(/^export\s+/gm,'');
  return runInNewContext(`(()=>{${source};return {${names.join(',')}};})()`,{...deps,Date,Intl,URL,Request,Response,Headers,console,crypto:webcrypto,atob,btoa});
}
const context=load('_shared/store-context.ts',{},['checkActor','resolveStoreContext','StoreAccessError','revokeStoreMembership']);
const workspace=load('_shared/request-workspace.ts',context,['requestWorkspace','storeContext','storeRows','storeCommand']);
const auth=load('_shared/auth.ts',{},['verifiedTokenIsAuthenticated']);
let handler;
load('portal-admin/index.ts',{...context,...workspace,...auth,createClient:()=>database,
  Deno:{env:{get:key=>key==='SUPABASE_URL'?address:'local-fixture'},serve:fn=>{handler=fn;}},
  fetch:async url=>{if(String(url)!==address+'/auth/v1/user')throw Error('External fixture request denied');return Response.json(users[0]);},
},[]);
const source=read('ux-portal-prototype.dc.html');
const permissionCode=source.slice(source.indexOf('const STAFF_PERMISSIONS = ['),source.indexOf('\n];',source.indexOf('const STAFF_PERMISSIONS = ['))+3);
const permissions=runInNewContext(permissionCode+';STAFF_PERMISSIONS');
let server,started=false;
async function stop(){if(server)await new Promise(resolve=>server.close(resolve));if(started){started=false;execFileSync('docker',['stop',container],{stdio:'pipe'});}}
process.on('SIGINT',()=>stop().then(()=>process.exit()));process.on('SIGTERM',()=>stop().then(()=>process.exit()));
try {
  execFileSync('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_HOST_AUTH_METHOD=trust',image],{stdio:'pipe'});started=true;
  for(let i=0;i<100;i++){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'pipe'});break;}
    catch{if(i===99)throw Error('Fixture database startup failed');await new Promise(resolve=>setTimeout(resolve,100));}}
  await sql(read('supabase/tests/store_access_local_schema.sql')+read('supabase/migrations/20261014215429_store_membership_access_foundation.sql')
    +read('supabase/migrations/20261014223749_store_membership_administration.sql'),false);
  await sql(`create table portal_access_review(id uuid,profile_id uuid,store_license text,review_type text,state text,reason text,created_at timestamptz);
    create table portal_brand_account(organization_id uuid,scope_status text,canix_brand_id bigint,canix_owner_id bigint,monday_account_item_id text);
    alter table portal_profile add column locations text;
    grant select on portal_access_review,portal_brand_account to service_role;
    insert into auth.users(id,email) values(${quote(id(10))},'owner@example.invalid'),(${quote(id(12))},'buyer@example.invalid'),(${quote(id(14))},'new-member@example.invalid');
    insert into portal_profile(id,full_name,org,role,active) values(${quote(id(10))},'Fixture Owner','Fixture Retailer','owner',true),
      (${quote(id(12))},'Fixture Buyer','Independent Brand','brand',true),(${quote(id(14))},'Fixture New Member','Independent Brand','brand',true);
    insert into portal_retailer_account values(${quote(id(21))},'Fixture Retailer','Fixture Retailer','ready_to_order');
    insert into portal_organization values(${quote(id(20))},'retailer','Fixture Retailer','Fixture Retailer','active',${quote(id(21))}),
      (${quote(id(23))},'brand','Fixture Brand','Fixture Brand','active',null);
    insert into portal_store(license_number,display_name,retailer_account_id,active) values
      ('LOCAL-A1','Fixture Store #1',${quote(id(21))},true),('LOCAL-A2','Fixture Store #2',${quote(id(21))},true);
    insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status,is_default) values
      (${quote(id(30))},${quote(id(10))},${quote(id(20))},'store','store_owner','active',false),
      (${quote(id(32))},${quote(id(12))},${quote(id(20))},'store','store_buyer','active',false),
      (${quote(id(33))},${quote(id(1))},${quote(id(23))},'brand','brand_owner','active',false),
      (${quote(id(34))},${quote(id(1))},${quote(id(20))},'store','store_buyer','active',false);
    insert into portal_membership_store(membership_id,license_number) values(${quote(id(32))},'LOCAL-A1'),(${quote(id(34))},'LOCAL-A1');
    update portal_store_access_control set enabled=true;
    update portal_organization_membership set is_default=true where id=${quote(id(3))};
    insert into portal_role_permission select 'administrator',v from unnest(array[${permissions.map(quote).join(',')}]) v
      where not exists(select 1 from portal_role_permission where staff_role='administrator' and permission=v);`,false);
  const html=read('dist/portal.html').replace('</head>','<script>window.UX_PORTAL_CONFIG='+JSON.stringify({supabaseUrl:address,supabaseAnonKey:'local-fixture',ssoDomain:'urbanxtracts.com'})+';</script></head>');
  server=createServer(async (req,res)=>{
    try{const url=new URL(req.url,address);let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Fixture request too large');}
      const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
      if(url.pathname==='/candidate'){res.writeHead(302,{Location:'/#access_token='+token+'&refresh_token=local-fixture-only'});res.end();return;}
      if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store',
        'Content-Security-Policy':"connect-src 'self' blob: data:; frame-src 'none'; form-action 'self'; object-src 'none'"});res.end(html);return;}
      if(req.headers.authorization!=='Bearer '+token){send({error:'Synthetic fixture authentication required'},401);return;}
      if(url.pathname==='/auth/v1/user'){send(users[0]);return;}
      if(url.pathname==='/auth/v1/logout'){send({});return;}
      if(url.pathname==='/rest/v1/portal_profile'){send((await database.from('portal_profile').select('*').eq('id',id(1))).data);return;}
      if(url.pathname==='/rest/v1/rpc/portal_my_workspaces'){
        send(jsonValue(await sql(`select coalesce(jsonb_agg(jsonb_build_object('membership_id',m.id,'organization_id',o.id,
          'organization_kind',o.kind,'organization_name',o.legal_name,'workspace',m.workspace,'member_role',m.member_role,'is_default',m.is_default)),'[]')
          from portal_organization_membership m join portal_organization o on o.id=m.organization_id where m.profile_id=${quote(id(1))} and m.status='active' and o.status='active';`)));return;}
      if(url.pathname==='/functions/v1/portal-admin'){
        const result=await handler(new Request(url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:body}));
        res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;}
      send({error:'This feature is not installed in the isolated administration fixture.'},503);
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error.message)}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4174,'127.0.0.1',resolve);});
  console.log('SYNTHETIC AUTH FIXTURE — not production SSO or full release acceptance.');
  console.log('Real candidate UI, portal-admin adapter and PostgreSQL commands. External API traffic blocked.');
  console.log('Preview: '+address+'/candidate');
} catch(error){await stop();throw error;}
