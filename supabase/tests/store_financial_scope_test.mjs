import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Execute the actual projection function, not a second implementation. Queries
// use synthetic rows only and never reach a source system or production DB.
const source = readFileSync(new URL('../functions/quickbooks-financials/index.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(`type Row = Record<string, unknown>; type Caller = any; type CustomerScope = any;
class PortalError extends Error { constructor(status, message) { super(message); this.status=status; } }
function clean(value: unknown, max=160): string { return String(value ?? '').trim().slice(0,max); }
${source.slice(source.indexOf('async function customerScope('), source.indexOf('\nfunction invoiceState('))}
customerScope;`);
function fixture({ collision = false, separate = false } = {}) {
  const tables = {
    portal_retailer_account: [
      { id:'a', organization_name:'Retailer A', display_name:'A', quickbooks_customer_id:'qb-a' },
      { id:'b', organization_name:'Retailer B', display_name:'B', quickbooks_customer_id:collision?'qb-a':'qb-b' },
    ],
    portal_store: [
      { retailer_account_id:'a', organization:'Retailer A', display_name:'A1', license_number:'a1', quickbooks_customer_id:separate?'qb-a1':'qb-a', active:true, closed_at:null },
      { retailer_account_id:'a', organization:'Retailer A', display_name:'A2', license_number:'a2', quickbooks_customer_id:separate?'qb-a2':'qb-a', active:true, closed_at:null },
      { retailer_account_id:'b', organization:'Retailer B', display_name:'B1', license_number:'b1', quickbooks_customer_id:collision?'qb-a':'qb-b', active:true, closed_at:null },
    ],
    portal_profile_store: [{profile_id:'buyer-a',license_number:'a1'}],
  };
  const service = { from(table) {
    let rows = tables[table].slice();
    const query = { select(){return query;}, order(){return query;},
      eq(key,value){ rows=rows.filter(r=>r[key]===value);return query;},
      in(key,values){ rows=rows.filter(r=>values.includes(r[key]));return query;},
      then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject);} };
    return query;
  } };
  return runInNewContext(code, {service,storeContext:profile=>profile._storeContext});
}
const caller = role => ({ internal:role==='internal', user:{}, profile:{ id:'buyer-a',role,org:'Wrong legacy organization',
  _storeContext:{retailerAccountId:'a',licenses:['a1']} } });
test('Owner sees only its organization customer once across two locations',async()=>{
  const result=await fixture()(caller('owner'));
  assert.deepEqual(Array.from(result.rows, r=>r.customerId),['qb-a']);
});
test('Buyer cannot see organization aggregate spanning an unassigned location',async()=>{
  const result=await fixture()(caller('buyer'));
  assert.equal(result.rows.length,0);assert.ok(result.missing.some(r=>r.reason==='shared_quickbooks_customer_outside_assignment'));
});
test('Owner cannot receive shared customer rows or parent totals crossing retailers',async()=>{
  const result=await fixture({collision:true})(caller('owner'));
  assert.equal(result.rows.length,0);assert.ok(result.missing.length>0);
});
test('Buyer with attributable location accounting receives only its assigned customer',async()=>{
  const result=await fixture({separate:true})(caller('buyer'));
  assert.deepEqual(Array.from(result.rows,r=>r.customerId),['qb-a1']);
});
test('Internal financial projection retains its separately authorized broad scope',async()=>{
  const result=await fixture()(caller('internal'));
  assert.deepEqual(Array.from(result.rows,r=>r.customerId).sort(),['qb-a','qb-b']);
});
