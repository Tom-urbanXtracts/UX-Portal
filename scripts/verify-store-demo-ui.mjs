// BrowserSkill UI-only smoke test. Start the required browser session and sign
// in manually first. No credentials, browser storage or API tokens are read.
import { execFileSync } from 'node:child_process';
const session = process.argv[2];
if (!session) throw new Error('Pass the active BrowserSkill session ID.');
const bsk = (...args) => execFileSync('bsk', [...args, '--session', session], { encoding: 'utf8', timeout: 20000 });
const sessions = JSON.parse(execFileSync('bsk', ['session', 'list', '--json'], { encoding: 'utf8' }));
if (!sessions.some(s => s.session_id === session && s.browser_instance_id === 'cca39cd4')) throw new Error('Required browser profile is not connected to this session.');
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
async function observeReady() {
  for (let i = 0; i < 32; i++) {
    const page = bsk('observe', '--max-tokens', '10000');
    if (!page.includes('Synthetic demo · Internal Administrators only')) throw new Error('Not in the controlled synthetic demo.');
    if (!page.includes('status "Loading demo…"') && !page.includes('status "Saving…"')) return page;
    await pause();
  }
  throw new Error('Demo did not finish loading.');
}
function refFor(page, kind, label) {
  const line = page.split('\n').find(l => l.includes(' ' + kind + ' "' + label + '"') || l.includes(' ' + kind + ' "' + label + ' ['));
  const ref = line?.match(/@e\d+/)?.[0];
  if (!ref) throw new Error('Missing ' + kind + ': ' + label);
  return ref;
}
async function click(label) { const p = await observeReady(); bsk('click', refFor(p, 'button', label)); return observeReady(); }
async function role(value) { const p = await observeReady(); bsk('select', refFor(p, 'combobox', 'Demo view'), '--value', value); return observeReady(); }
const mode = process.argv[3] || 'submit-sections';
if (mode === 'submit-sections') {
  await click('Company & Onboarding');
  for (let i = 0; i < 6; i++) {
    const p = await observeReady();
    if (!p.includes('button "Submit Section"')) break;
    await click('Submit Section');
    console.log('Submitted synthetic section ' + (i + 1));
  }
  const p = await observeReady();
  if (p.includes('button "Submit Section"')) throw new Error('Unsubmitted sections remain.');
} else if (mode === 'review-correction') {
  await role('internal'); await click('Company & Onboarding');
  let p = await observeReady();
  bsk('fill', refFor(p, 'textbox', 'Review note'), '--value', 'Confirm the synthetic legal business name.');
  await click('Return Section');
  await role('owner'); await click('Company & Onboarding');
  p = await observeReady();
  bsk('fill', refFor(p, 'textbox', 'Legal Business Name *'), '--value', 'urbanXtracts Store — Synthetic Reviewed');
  await click('Save Draft');
  await click('Submit Section');
  p = await observeReady();
  if (!p.includes('Synthetic Reviewed') || !p.includes('SUBMITTED')) throw new Error('Correction/resubmission failed.');
} else if (mode === 'approve-sections') {
  await role('internal'); await click('Company & Onboarding');
  for (let i = 0; i < 6; i++) {
    const p = await observeReady();
    if (!p.includes('button "Approve Section"')) break;
    await click('Approve Section'); console.log('Approved synthetic section ' + (i + 1));
  }
  const p = await observeReady();
  if (p.includes('button "Approve Section"') || !p.includes('APPROVED')) throw new Error('Onboarding review incomplete.');
} else if (mode === 'finance-clear') {
  await role('internal'); await click('Financials');
  let p = await observeReady(); bsk('fill', refFor(p, 'textbox', 'Demo Finance note'), '--value', 'Synthetic acceptance review — no live financial decision');
  await click('Clear for Ordering');
  p = await observeReady(); if (!p.includes('approved')) throw new Error('Finance clearance not visible.');
} else if (mode === 'budtender') {
  const page = await role('budtender');
  const p = page.slice(page.indexOf('region "Internal Administrator Store Demo"'));
  for (const label of ['Add to Draft','Save Draft','Submit Order','Company & Onboarding','Financials','Orders']) {
    if (p.includes('button "' + label + '"')) throw new Error('Budtender has a commercial/admin action: ' + label);
  }
  if (p.includes('Units Available') || /StaticText "\$\d/.test(p)) throw new Error('Commercial quantities or prices leaked.');
} else if (mode === 'paused') {
  const p = await click('Refresh');
  if (!p.includes('Store demonstration is paused.')) throw new Error('Emergency pause was not enforced.');
} else if (mode === 'revoked') {
  const p = await click('Refresh');
  if (!p.includes('Internal Administrator membership and demo authority are required.')) throw new Error('Revoked membership was not denied.');
  if (p.includes('Cart quantity for ') || p.includes('Units Available')) throw new Error('Revoked demo data remained visible.');
} else if (mode === 'second-location') {
  await role('owner'); await click('Catalog & Cart');
  let p = await observeReady(); bsk('select', refFor(p, 'combobox', 'Demo location'), '--value', 'DEMO-UX-STORE-002');
  p = await observeReady(); bsk('select', refFor(p, 'combobox', 'Demo Brand filter'), '--value', 'Wana');
  p = await observeReady(); bsk('fill', refFor(p, 'spinbutton', 'Quantity for Wana Mango Classic Gummies — Demo'), '--value', '2');
  await click('Add to Draft'); await click('Save Draft');
  p = await click('Refresh');
  if (!p.includes('Cart quantity for Wana Mango Classic Gummies — Demo') || !p.includes('Total: $28.00')) throw new Error('Second-location draft did not persist.');
} else if (mode === 'order-workflow') {
  await role('buyer'); await click('Catalog & Cart');
  let p = await observeReady();
  bsk('select', refFor(p, 'combobox', 'Demo Brand filter'), '--value', 'all');
  p = await observeReady();
  bsk('fill', refFor(p, 'spinbutton', 'Quantity for urbanXtracts Flower — Demo'), '--value', '30');
  await click('Add to Draft');
  await click('Save Draft');
  await role('internal'); await click('Financials');
  p = await observeReady(); bsk('fill', refFor(p, 'textbox', 'Demo Finance note'), '--value', 'Synthetic past-due hold acceptance');
  await click('Simulate Past Due');
  await role('buyer'); await click('Catalog & Cart');
  p = await click('Submit Order');
  if (!p.includes('Finance has not cleared ordering') || !p.includes('Cart quantity for urbanXtracts Flower')) throw new Error('Hold did not preserve the Buyer draft.');
  await role('internal'); await click('Financials');
  p = await observeReady(); bsk('fill', refFor(p, 'textbox', 'Demo Finance note'), '--value', 'Synthetic Finance clearance acceptance');
  await click('Clear for Ordering');
  await role('buyer'); await click('Catalog & Cart'); await click('Submit Order');
  p = await click('Orders');
  if (!p.includes('Awaiting Owner Approval') || p.includes('button "Approve Buyer Order"')) throw new Error('Buyer approval boundary failed.');
  await role('owner'); await click('Orders'); await click('Approve Buyer Order');
  await role('internal'); await click('Orders');
  for (const label of ['Approve Order','Mark Shipped','Mark Delivered']) await click(label);
  p = await observeReady(); if (!p.includes('Delivered')) throw new Error('Order lifecycle incomplete.');
} else throw new Error('Unsupported test mode.');
console.log('PASS: ' + mode);
