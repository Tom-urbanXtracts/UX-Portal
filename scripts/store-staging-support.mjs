// Shared by the isolated staging acceptance tools. Never reads browser sessions.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export const project='nqnmgxnxwllstowavjjt';
export const base='https://'+project+'.supabase.co';
export const cli='/Users/Apple/.npm/_npx/bc327d2b4a6dffd7/node_modules/supabase/bin/supabase';
export function keys(){
  const result=JSON.parse(execFileSync(cli,['projects','api-keys','--project-ref',project,'--output','json'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const anon=result.find(row=>row.name==='anon')?.api_key;
  const service=result.find(row=>row.name==='service_role')?.api_key;
  assert(anon&&service,'Staging server credentials unavailable.');
  return {anon,service};
}
export function sql(workdir,query){
  assert(workdir?.startsWith('/tmp/ux-os-staging-20261014.'));
  assert.equal(readFileSync(workdir+'/supabase/.temp/project-ref','utf8').trim(),project);
  const pooler=new URL(readFileSync(workdir+'/supabase/.temp/pooler-url','utf8').trim());
  assert(pooler.username.endsWith('.'+project));
  const password=execFileSync('security',['find-generic-password','-a','postgres','-s','urbanxtracts.ux-os-staging.database.20261014','-w'],{encoding:'utf8'}).trim();
  try{return execFileSync('docker',['run','--rm','-i','-e','PGPASSWORD','-e','PGCONNECT_TIMEOUT',
    'postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3',
    'psql','-X','-h',pooler.hostname,'-p',pooler.port||'5432','-U',decodeURIComponent(pooler.username),'-d','postgres','-At','-v','ON_ERROR_STOP=1'],
    {input:query,encoding:'utf8',env:{...process.env,PGPASSWORD:password,PGCONNECT_TIMEOUT:'15'},maxBuffer:4000000,timeout:120000});
  }catch(error){throw Error(String(error.stderr||error.message).replaceAll(password,'[redacted]'));}
}
export const quote=value=>value==null?'null':"'"+String(value).replaceAll("'","''")+"'";
export function keychainPassword(name){return execFileSync('security',['find-generic-password','-a',name,'-s','urbanxtracts.ux-os-staging.test-account','-w'],{encoding:'utf8'}).trim();}
export async function api(path,{method='GET',body,token,anon,service}={}){
  const response=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{apikey:anon||service,Authorization:'Bearer '+(token||service),'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Staging API '+path.split('?')[0]+' returned '+response.status+' ('+String(data.code||data.error_code||'')+').');
  return data;
}
