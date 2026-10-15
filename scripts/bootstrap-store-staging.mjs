// One-purpose schema bootstrap for the approved, empty Free staging project.
// Never imports production rows, Auth users, Vault contents, or connector secrets.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const project='nqnmgxnxwllstowavjjt';
const production='cbhsavfbtcpdyxcvguay';
const workdir=process.argv[2];
assert(workdir?.startsWith('/tmp/ux-os-staging-20261014.'),'Use the owned isolated staging directory.');
assert.equal(readFileSync(workdir+'/supabase/.temp/project-ref','utf8').trim(),project);
const pooler=new URL(readFileSync(workdir+'/supabase/.temp/pooler-url','utf8').trim());
assert(pooler.username.endsWith('.'+project),'Connection must target staging.');
assert(pooler.hostname.endsWith('.pooler.supabase.com'));
const password=execFileSync('security',['find-generic-password','-a','postgres','-s','urbanxtracts.ux-os-staging.database.20261014','-w'],{encoding:'utf8'}).trim();
// Use the previously verified cached PostgreSQL client image, without a DB port.
const clientImage='postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';
function sql(query){
  try{return execFileSync('docker',['run','--rm','-i','-e','PGPASSWORD','-e','PGCONNECT_TIMEOUT',clientImage,'psql','-X','-h',pooler.hostname,
    '-p',pooler.port||'5432','-U',decodeURIComponent(pooler.username),'-d','postgres','-At','-v','ON_ERROR_STOP=1'],
    {input:query,encoding:'utf8',env:{...process.env,PGPASSWORD:password,PGCONNECT_TIMEOUT:'15'},maxBuffer:4000000,timeout:120000});
  }catch(error){throw Error(String(error.stderr||error.message).replaceAll(password,'[redacted]'));}
}
const raw=readFileSync(workdir+'/production-public-schema.sql','utf8');
assert(raw.length>100000,'Incomplete schema dump.');
assert(!/^COPY\s/m.test(raw),'Data imports are forbidden.');
assert(!/^CREATE (?:SERVER|FOREIGN)/m.test(raw),'External database connections are forbidden.');
assert(!/(?:sb_secret_|sbp_)[A-Za-z0-9_-]{20}/.test(raw),'Unexpected secret in schema.');
const schema=raw.replace(/^\\(?:un)?restrict.*$/gm,'').replaceAll(production,project);
const empty=sql("select count(*) from information_schema.tables where table_schema='public';").trim();
assert.equal(empty,'0','Refusing to overwrite or rebuild an initialized staging database.');
const migrations=['20261014215429_store_membership_access_foundation.sql',
  '20261014220938_store_endpoint_access_commands.sql','20261014223749_store_membership_administration.sql'];
const pending=migrations.map(name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).join('\n');
const privateBuckets=`
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values
  ('portal-assets','portal-assets',false,20971520,array['image/jpeg','image/png','image/webp','application/pdf']::text[]),
  ('portal-onboarding-documents','portal-onboarding-documents',false,10485760,array['application/pdf','image/png','image/jpeg']::text[]),
  ('portal-sku-intake-documents','portal-sku-intake-documents',false,10485760,array['application/pdf','image/png','image/jpeg']::text[]),
  ('portal-brand-onboarding-documents','portal-brand-onboarding-documents',false,10485760,array['application/pdf','image/png','image/jpeg']::text[]),
  ('portal-brand-agreements','portal-brand-agreements',false,10485760,array['application/pdf']::text[]),
  ('portal-work-evidence','portal-work-evidence',false,10485760,array['application/pdf','image/png','image/jpeg']::text[]),
  ('portal-claim-evidence','portal-claim-evidence',false,10485760,array['application/pdf','image/png','image/jpeg']::text[]),
  ('portal-brand-documents','portal-brand-documents',false,62914560,array['application/pdf','image/png','image/jpeg','application/zip']::text[]),
  ('portal-brand-supply-documents','portal-brand-supply-documents',false,62914560,array['application/pdf','image/png','image/jpeg','application/zip']::text[]),
  ('portal-brand-application-documents','portal-brand-application-documents',false,10485760,array['application/pdf','image/png','image/jpeg']::text[])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;`;
const guard=`
do $stage$ declare target record; begin
  for target in select c.oid::regclass as tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') loop
    execute format('alter table %s enable row level security',target.tbl);
  end loop;
  for target in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'portal_enable_%schedule%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',target.fn);
  end loop;
end $stage$;
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke all on sequences from anon,authenticated;
alter default privileges in schema public revoke all on functions from public,anon,authenticated;
revoke all on all functions in schema public from public,anon,authenticated;
grant execute on function public.portal_my_workspaces(),public.portal_my_permissions(),
  public.portal_my_workspace_permissions(uuid),public.portal_role(),public.portal_org() to authenticated;
do $stage$ begin
  if exists(select 1 from cron.job) then raise exception 'Staging must have no scheduled jobs'; end if;
  if exists(select 1 from vault.secrets) then raise exception 'Staging must have no Vault secrets'; end if;
end $stage$;`;
// Send the schema as one server-side batch rather than thousands of WAN
// round-trips. No interpolation of untrusted business/user values occurs.
assert(!schema.includes('$ux_stage_schema$'));
sql('begin;\ndo $ux_stage_bootstrap$ begin execute $ux_stage_schema$'+schema
  +'$ux_stage_schema$; end $ux_stage_bootstrap$;\n'+privateBuckets+'\n'+pending+'\n'+guard+'\ncommit;');
console.log(JSON.stringify({project,status:'schema_bootstrapped',productionRowsCopied:0,productionUsersCopied:0,
  schemaSha256:createHash('sha256').update(raw).digest('hex'),preparedMigrations:migrations,liveStoreAccess:false,
  privateBuckets:10,schedules:0,vaultSecrets:0,repositoryLinkChanged:false}));
