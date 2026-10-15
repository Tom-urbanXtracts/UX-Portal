import { checkActor, resolveStoreContext, StoreAccessError, type StoreAction, type StoreContext, type StoreContextSource } from './store-context.ts';
export { StoreAccessError } from './store-context.ts';
type Row=Record<string,unknown>;
// Client is server-side only. No request-provided service credentials accepted.
export type WorkspaceDatabase=StoreContextSource & { from(table:string): any };
const uuid=(v:unknown):v is string=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const staffRoles=new Set(['administrator','operations','sales','quality','viewer']);

/** Call only AFTER Auth has verified the bearer token and loaded current user.
 * Every old Store endpoint must use this boundary; legacy profile role/org is
 * display compatibility only and cannot restore membership or location access.
 */
export async function requestWorkspace(service:WorkspaceDatabase,request:Request,user:Row,rawProfile:Row,action:StoreAction,
  options:{allowBrand?:boolean;internalOnly?:boolean;denyStore?:boolean;brandOrganizationId?:string}={}):Promise<Row> {
  const actor={id:String(user.id||''),app_metadata:(user.app_metadata||{}) as Row};
  checkActor(actor,new Date());
  if(rawProfile.id!==actor.id || rawProfile.active!==true) throw new StoreAccessError(403,'Active portal identity required.');
  const membershipId=request.headers.get('x-ux-membership-id');
  const organizationId=request.headers.get('x-ux-organization-id');
  if(!uuid(membershipId)||!uuid(organizationId)) throw new StoreAccessError(403,'Select a verified workspace before continuing.');
  const {data:membership,error:me}=await service.from('portal_organization_membership')
    .select('id,profile_id,organization_id,workspace,member_role,status').eq('id',membershipId).eq('profile_id',actor.id)
    .eq('organization_id',organizationId).eq('status','active').maybeSingle();
  if(me) throw new StoreAccessError(503,'Workspace access could not be verified.');
  if(!membership) throw new StoreAccessError(403,'This workspace membership is no longer active.');
  const {data:organization,error:oe}=await service.from('portal_organization').select('id,kind,status,legal_name,legacy_retailer_account_id')
    .eq('id',organizationId).eq('status','active').maybeSingle();
  if(oe) throw new StoreAccessError(503,'Workspace access could not be verified.');
  if(!organization) throw new StoreAccessError(403,'This organization is not active.');
  const base={...rawProfile,_workspaceMembershipId:membershipId,_workspaceOrganizationId:organizationId,_verifiedActor:actor};
  if(membership.workspace==='internal' && organization.kind==='internal' && staffRoles.has(membership.member_role)) {
    return {...base,role:'internal',staff_role:membership.member_role,org:organization.legal_name};
  }
  if(options.internalOnly) throw new StoreAccessError(403,'An Internal workspace is required.');
  if(membership.workspace==='brand' && organization.kind==='brand' && options.allowBrand &&
    ['brand_owner','brand_manager','brand_contributor','brand_viewer'].includes(membership.member_role)) {
    if(options.brandOrganizationId && options.brandOrganizationId!==organizationId)
      throw new StoreAccessError(403,'This Brand is outside the selected workspace.');
    return {...base,role:'brand',staff_role:null,org:organization.legal_name};
  }
  if(options.denyStore) throw new StoreAccessError(403,'A Brand or authorized Internal workspace is required.');
  if(membership.workspace!=='store'||organization.kind!=='retailer') throw new StoreAccessError(403,'This endpoint is not available in the selected workspace.');
  const context=await resolveStoreContext(service,actor,{membershipId,organizationId,action,assignedCollection:true});
  const {data:account,error:ae}=await service.from('portal_retailer_account').select('id,organization_name').eq('id',context.retailerAccountId).maybeSingle();
  if(ae) throw new StoreAccessError(503,'Retailer scope could not be verified.');
  if(!account?.organization_name) throw new StoreAccessError(403,'A verified retailer relationship is required.');
  return {...base,role:context.memberRole==='store_owner'?'owner':context.memberRole==='store_buyer'?'buyer':'budtender',
    staff_role:null,org:account.organization_name,locations:context.licenses.join(', '),_storeContext:context};
}
export function storeContext(profile:Row):StoreContext|null {
  if(profile.role==='internal'||profile.role==='brand') return null;
  const context=profile._storeContext as StoreContext|undefined;
  if(!context||context.actorId!==profile.id) throw new StoreAccessError(403,'Store membership must be verified.');
  return context;
}
export async function storeRows(service:WorkspaceDatabase,profile:Row,fields:string):Promise<Row[]> {
  const context=storeContext(profile);
  if(!context) throw new StoreAccessError(403,'Store scope required.');
  if(!context.licenses.length) return [];
  const {data,error}=await service.from('portal_store').select(fields).eq('retailer_account_id',context.retailerAccountId)
    .eq('active',true).is('closed_at',null).in('license_number',[...context.licenses]);
  if(error) throw new StoreAccessError(503,'Store locations could not be verified.');
  return data||[];
}
export async function storeCommand(service:WorkspaceDatabase,profile:Row,command:string,payload:Row):Promise<{data:any;error:any}> {
  const context=storeContext(profile);
  if(!context) throw new StoreAccessError(403,'Store scope required.');
  const result = await service.rpc('portal_store_command',{p_actor_id:context.actorId,p_membership_id:context.membershipId,
    p_organization_id:context.organizationId,p_command:command,p_payload:payload});
  if (result.error?.code==='42501') throw new StoreAccessError(403,'Your current Store membership no longer authorizes this change.');
  if (result.error?.code==='40001') throw new StoreAccessError(409,'The source or Store state changed. Your draft is preserved; refresh and review it.');
  return result;
}
