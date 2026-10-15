// Admin-created, confirmed .invalid accounts: no invitation or email is sent.
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {keys,api,sql,quote as q,keychainPassword} from './store-staging-support.mjs';
const workdir=process.argv[2],credential=keys();
assert.equal(sql(workdir,'select count(*) from public.portal_profile;').trim(),'0','Refusing to overwrite initialized staging profiles.');
const existing=await api('/auth/v1/admin/users?page=1&per_page=100',credential);
assert(existing.users.every(user=>user.email?.startsWith('ux-staging-')&&user.email.endsWith('@example.invalid')&&user.app_metadata?.ux_staging===true),
  'Staging contains an account not created by this seed. Review required.');
const accounts=[['admin','Staging Admin','internal','administrator'],['viewer','Staging Viewer','internal','viewer'],
  ['owner','Staging Owner','owner',null],['buyer','Staging Buyer','brand',null],['budtender','Staging Budtender','budtender',null],
  ['replacement','Staging Replacement Owner','brand',null]];
const users=[];
for(const [name,fullName,role,staffRole] of accounts){
  const prior=existing.users.find(user=>user.email==='ux-staging-'+name+'@example.invalid');
  if(prior){assert(keychainPassword(name));users.push({name,id:prior.id,fullName,role,staffRole});continue;}
  const password=randomBytes(27).toString('base64url')+'aA1!';
  execFileSync('security',['add-generic-password','-a',name,'-s','urbanxtracts.ux-os-staging.test-account','-w',password],{stdio:'pipe'});
  const user=await api('/auth/v1/admin/users',{...credential,method:'POST',body:{email:'ux-staging-'+name+'@example.invalid',password,
    email_confirm:true,app_metadata:{ux_staging:true},user_metadata:{full_name:fullName}}});
  assert(user.id&&user.email.endsWith('@example.invalid'));
  users.push({name,id:user.id,fullName,role,staffRole});
}
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const byName=Object.fromEntries(users.map(user=>[user.name,user]));
const profileValues=users.map(user=>`(${q(user.id)},${q(user.fullName)},${q(user.role==='internal'?'urbanXtracts':'Staging Retailer')},${q(user.role)},true,${q(user.staffRole)})`).join(',');
const member=(n,name,org,workspace,role,def=true)=>`(${q(id(n))},${q(byName[name].id)},${q(id(org))},${q(workspace)},${q(role)},'active',${def})`;
const permissionsSource=await import('node:fs').then(fs=>fs.readFileSync(new URL('../ux-portal-prototype.dc.html',import.meta.url),'utf8'));
const permissionBlock=permissionsSource.match(/const STAFF_PERMISSIONS = (\[[\s\S]*?\]);/)?.[1];
assert(permissionBlock);
const permissions=[...permissionBlock.matchAll(/'([a-z_.]+)'/g)].map(match=>match[1]);
const workspaceMigration=await import('node:fs').then(fs=>fs.readFileSync(new URL('../supabase/migrations/20260929194710_brand_workspace_access.sql',import.meta.url),'utf8'));
const workspacePolicy=workspaceMigration.slice(workspaceMigration.indexOf('insert into public.portal_workspace_role_permission ('),
  workspaceMigration.indexOf('alter table public.portal_workspace_role_permission enable row level security;'));
assert(workspacePolicy.startsWith('insert into public.portal_workspace_role_permission ('));
sql(workdir,`begin;
insert into public.portal_profile(id,full_name,org,role,active,staff_role) values ${profileValues};
insert into public.portal_role_permission(staff_role,permission) values ${permissions.map(p=>`('administrator',${q(p)})`).join(',')};
${workspacePolicy}
insert into public.portal_retailer_account(id,organization_name,display_name,portal_status) values(${q(id(21))},'Staging Retailer','Staging Retailer','ready_to_order');
insert into public.portal_organization(id,kind,legal_name,display_name,status,legacy_retailer_account_id) values
(${q(id(2))},'internal','urbanXtracts','urbanXtracts','active',null),
(${q(id(20))},'retailer','Staging Retailer','Staging Retailer','active',${q(id(21))}),
(${q(id(23))},'brand','Staging Brand','Staging Brand','active',null);
insert into public.portal_store(license_number,display_name,organization,retailer_account_id,active) values
('STAGING-A1','Demo Store #1','Staging Retailer',${q(id(21))},true),('STAGING-A2','Demo Store #2','Staging Retailer',${q(id(21))},true);
insert into public.portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status,is_default) values
${member(3,'admin',2,'internal','administrator')},${member(4,'viewer',2,'internal','viewer')},
${member(30,'owner',20,'store','store_owner')},${member(32,'buyer',20,'store','store_buyer')},
${member(35,'budtender',20,'store','store_staff')},${member(33,'admin',23,'brand','brand_owner',false)},
${member(34,'admin',20,'store','store_buyer',false)},${member(36,'buyer',23,'brand','brand_owner',false)},
${member(37,'replacement',23,'brand','brand_owner')};
insert into public.portal_membership_store(membership_id,license_number) values
(${q(id(32))},'STAGING-A1'),(${q(id(35))},'STAGING-A1'),(${q(id(34))},'STAGING-A1');
insert into public.portal_store_demo_control(id,enabled) values(true,true);
commit;`);
console.log(JSON.stringify({status:'synthetic_auth_seeded',accounts:users.map(({name,id})=>({name,id})),mailSent:0,liveStoreAccess:false,passwords:'macOS Keychain only'}));
