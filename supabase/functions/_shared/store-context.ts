/** Prepared live-Store boundary. Not connected to legacy endpoints yet.
 * Auth must validate the bearer token before supplying verifiedActor.
 * Never cache this result across requests or use a previous workspace role.
 */
export type StoreAction = 'education.read' | 'catalog.read' | 'inventory.quantity.read'
  | 'orders.read' | 'orders.submit' | 'orders.approve' | 'financials.read' | 'users.read'
  | 'pricing.read' | 'pricing.propose' | 'policy.read' | 'claims.read' | 'claims.submit' | 'notifications.read'
  | 'license_documents.read';
export type StoreContext = Readonly<{
  actorId: string; membershipId: string; organizationId: string;
  retailerAccountId: string; memberRole: 'store_owner' | 'store_buyer' | 'store_staff' | 'store_billing';
  licenses: readonly string[];
}>;
export class StoreAccessError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status=status; }
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const actions: Record<StoreContext['memberRole'], readonly StoreAction[]> = {
  store_owner: ['education.read','catalog.read','inventory.quantity.read','orders.read','orders.submit','orders.approve','financials.read','users.read','pricing.read','pricing.propose','policy.read','claims.read','claims.submit','notifications.read','license_documents.read'],
  // Buyers receive ordering information only: no invoices, balances, payment history or terms.
  store_buyer: ['education.read','catalog.read','inventory.quantity.read','orders.read','orders.submit','pricing.read','pricing.propose','policy.read','claims.read','claims.submit','notifications.read'],
  store_staff: ['education.read'],
  // Authorized billing user: own-account invoices, balances, payment history and
  // terms only. No ordering, approval, license documents or user administration.
  store_billing: ['financials.read'],
};
// Account-level reads that need no location selection.
const accountLevel: readonly StoreAction[] = ['financials.read','users.read','license_documents.read'];
export interface StoreContextSource {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
}
// Construct ONLY from a successful server-side Auth getUser response, not token
// decoding, cached session, user_metadata, request body or browser storage.
export type VerifiedStoreActor = { id: string; app_metadata: Record<string, unknown> };
export function checkActor(actor: VerifiedStoreActor, now: Date): string {
  if (!actor || !uuid(actor.id)) throw new StoreAccessError(401, 'Verified identity required.');
  if (!actor.app_metadata || typeof actor.app_metadata !== 'object' || Array.isArray(actor.app_metadata)) throw new StoreAccessError(403, 'Account access could not be verified.');
  const expiry = actor.app_metadata.portal_access_expires_on;
  if (expiry !== null && expiry !== undefined && expiry !== '') {
    const date = typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? new Date(expiry + 'T00:00:00Z') : new Date(NaN);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find(p=>p.type===type)?.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==expiry || expiry < today) throw new StoreAccessError(403, 'Account access expired or requires review.');
  }
  return actor.id;
}
export async function resolveStoreContext(source: StoreContextSource, verifiedActor: VerifiedStoreActor, selection: {
  membershipId: unknown; organizationId: unknown; license?: unknown; action: StoreAction; assignedCollection?: boolean;
}, now = new Date()): Promise<StoreContext> {
  const verifiedActorId = checkActor(verifiedActor, now);
  if (!uuid(selection.membershipId) || !uuid(selection.organizationId)) throw new StoreAccessError(403, 'Select an explicit Store membership.');
  let result;
  try {
    result = await source.rpc('portal_resolve_store_context', { p_actor_id: verifiedActorId, p_membership_id: selection.membershipId });
  } catch { throw new StoreAccessError(503, 'Store access could not be verified.'); }
  if (result.error) throw new StoreAccessError(result.error.code === '42501' ? 403 : 503, 'Store access could not be verified.');
  const row = result.data as StoreContext | null;
  if (!row || row.actorId !== verifiedActorId || row.membershipId !== selection.membershipId || row.organizationId !== selection.organizationId
    || !uuid(row.retailerAccountId) || !Object.hasOwn(actions, row.memberRole)
    || !Array.isArray(row.licenses) || row.licenses.some(v => typeof v !== 'string' || !v.trim())) {
    throw new StoreAccessError(403, 'Store context does not match the current membership.');
  }
  if (row.memberRole === 'store_staff' && row.licenses.length !== 1) throw new StoreAccessError(403, 'Budtender requires one active Store.');
  if (!actions[row.memberRole].includes(selection.action)) throw new StoreAccessError(403, 'This action is not available to this Store role.');
  // Financial row/field scoping remains a separate mandatory projection gate.
  // Buyers must select one assigned location; financial reads are Owner/billing-only.
  // Only server adapters may choose a collection operation. It does not grant
  // a record/location outside the returned allowlist or bypass mutation checks.
  if (selection.assignedCollection && !row.licenses.length) throw new StoreAccessError(403, 'No active Store is assigned.');
  const locationRequired = !selection.assignedCollection && (!['store_owner','store_billing'].includes(row.memberRole) || !accountLevel.includes(selection.action));
  if ((locationRequired || selection.license !== undefined) && (typeof selection.license !== 'string' || !row.licenses.includes(selection.license))) {
    throw new StoreAccessError(403, 'The selected Store is outside your current assignment.');
  }
  return Object.freeze({ actorId: row.actorId, membershipId: row.membershipId, organizationId: row.organizationId,
    retailerAccountId: row.retailerAccountId, memberRole: row.memberRole,
    licenses: Object.freeze([...new Set(row.licenses)]) });
}
export async function revokeStoreMembership(source: StoreContextSource, verifiedActor: VerifiedStoreActor, request: {
  actorMembershipId: unknown; targetMembershipId: unknown; reason: unknown;
}, now = new Date()): Promise<void> {
  const actorId = checkActor(verifiedActor, now);
  if (!uuid(request.actorMembershipId) || !uuid(request.targetMembershipId) || typeof request.reason !== 'string'
    || !request.reason.trim() || request.reason.length > 1000) throw new StoreAccessError(400, 'Current membership and a reason are required.');
  let result;
  try { result = await source.rpc('portal_revoke_store_membership', { p_actor_id: actorId,
    p_actor_membership_id: request.actorMembershipId, p_target_membership_id: request.targetMembershipId, p_reason: request.reason.trim() }); }
  catch { throw new StoreAccessError(503, 'Store membership change could not be verified.'); }
  if (result.error) throw new StoreAccessError(result.error.code === '23514' ? 409 : result.error.code === '42501' ? 403 : 503, 'Store membership change could not be verified.');
  const row = result.data as Record<string,unknown> | null;
  if (row?.membershipId !== request.targetMembershipId || row?.status !== 'disabled') throw new StoreAccessError(503, 'Store membership change could not be verified.');
}
