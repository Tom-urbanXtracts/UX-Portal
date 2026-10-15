// UI actions only, against the isolated synthetic fixture. Never production.
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const session=process.argv[2];if(!session)throw Error('Pass the BrowserSkill session.');
const sessions=JSON.parse(execFileSync('bsk',['session','list','--json'],{encoding:'utf8'}));
assert(sessions.some(row=>row.session_id===session&&row.browser_instance_id==='cca39cd4'));
const bsk=(...args)=>execFileSync('bsk',[...args,'--session',session],{encoding:'utf8',timeout:20000});
assert(JSON.parse(bsk('tab','list','--scope','agent','--json')).tabs.some(tab=>tab.active&&tab.url.startsWith('http://127.0.0.1:4174/')),
  'Refusing to run fixture mutations on any other origin.');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function observe(predicate=()=>true){for(let i=0;i<60;i++){
  const page=bsk('observe','--max-tokens','13000');
  if(!page.includes('Local Admin')&&page.includes('Checking…')) {await new Promise(resolve=>setTimeout(resolve,100));continue;}
  assert(page.includes('Local Admin'),'Refusing to operate outside the synthetic fixture.');
  if(predicate(page))return page;await new Promise(resolve=>setTimeout(resolve,100));
}throw Error('Fixture UI did not reach the expected state.');}
function ref(page,kind,label){const line=page.split('\n').find(line=>line.includes(' '+kind+' "'+label+'"')||line.includes(' '+kind+' "'+label+' ['));
  const found=line?.match(/@e\d+/)?.[0];if(!found)throw Error('Missing '+kind+': '+label);return found;}
async function click(label){const page=await observe();bsk('click',ref(page,'button',label));}
async function select(label,value){const page=await observe();bsk('select',ref(page,'combobox',label),'--value',value);}
async function fill(label,value){const page=await observe();bsk('fill',ref(page,'textbox',label),'--value',value);}
async function membership(value){await select('Store membership',value);await observe(page=>page.includes('Store access change reason'));}
async function save(reason){await fill('Store access change reason',reason);await click('Save Store membership');
  return observe(page=>page.includes('Store membership saved.')&&page.includes('combobox "Store membership [')&&!page.includes('button "Save Store membership" [disabled]'));}
let p=await observe();
if(!p.includes('button "Users and Access"'))await click('Administration');
await click('Users and Access');await observe(page=>page.includes('Fixture Buyer'));
bsk('click','details:has(section[aria-label="Store membership administration"]) > summary');
await click('Load Store access');await observe(page=>page.includes('Store retailer organization'));
await select('Store retailer organization',id(20));await observe(page=>page.includes('Fixture Store #1'));
await membership(id(32));await select('Store membership role','store_staff');await click('Fixture Store #2 · LOCAL-A2');
await save('Synthetic Browser test: assign Budtender to second store');
await membership(id(32));p=await observe();assert(p.includes('store_staff'));assert(p.includes('LOCAL-A2'));
console.log('PASS: browser role/location save through real adapter and PostgreSQL');
await select('Store membership status','disabled');await save('Synthetic Browser test: disable Store membership only');
await membership(id(32));p=await observe();assert(p.includes('="disabled"'));
await select('Store membership status','active');await click('Fixture Store #1 · LOCAL-A1');
await save('Synthetic Browser test: reactivate Store membership');
console.log('PASS: browser scoped disable and reactivation');
await membership(id(30));await select('Store membership role','store_buyer');await click('Fixture Store #1 · LOCAL-A1');
await fill('Store access change reason','Synthetic Browser test: sole Owner protection');await click('Save Store membership');
p=await observe(page=>page.includes('Add an eligible replacement Owner'));assert(!p.includes('Store membership saved.'));
console.log('PASS: browser last-Owner denial remains visible and does not save');
await membership('');await select('Existing Store user',id(14));await select('Store membership role','store_buyer');
await click('Fixture Store #2 · LOCAL-A2');await save('Synthetic Browser test: add existing independent Brand identity');
p=await observe();assert(p.includes('Fixture New Member'));assert(p.includes('No email was sent.'));
console.log('PASS: browser adds existing identity without invitation or global account change');
await click('Brand Fixture Brand');p=await observe(page=>page.includes('Brand Home')||page.includes('Brand workspace'));
assert(!p.includes('Store membership administration'));assert(!p.includes('button "Store Demo"'));
await click('Store Fixture Retailer');p=await observe(page=>page.includes('Fixture Retailer')&&!page.includes('Brand Home'));
assert(!p.includes('Store membership administration'));assert(!p.includes('button "Store Demo"'));
await click('Internal urbanXtracts');p=await observe();
if(!p.includes('button "Users and Access"'))await click('Administration');
await click('Users and Access');
p=await observe(page=>page.includes('Users and access'));
assert(!p.includes('combobox "Store membership ['),'Old Store administration data survived the workspace switch.');
console.log('PASS: Brand/Store workspace switches remove Internal controls and stale membership data');
