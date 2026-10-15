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
    // License approval requires verification evidence; the note is harmless for other sections.
    bsk('fill', refFor(p, 'textbox', 'Review note'), '--value', 'Synthetic license verification evidence');
    await click('Approve Section'); console.log('Approved synthetic section ' + (i + 1));
  }
  const p = await observeReady();
  if (p.includes('button "Approve Section"') || !p.includes('APPROVED')) throw new Error('Onboarding review incomplete.');
} else if (mode === 'finance-warning') {
  // Overdue accounting is a visible warning only; it creates no hold.
  await role('internal'); await click('Account & License');
  await click('Overdue Invoice');
  const p = await observeReady();
  if (!p.includes('invoice overdue') || !p.includes('Manual financial hold: None') || !p.includes('never block ordering')) throw new Error('Overdue warning-only state not visible.');
} else if (mode === 'budtender') {
  const page = await role('budtender');
  const p = page.slice(page.indexOf('region "Internal Administrator Store Demo"'));
  for (const label of ['Add to Draft','Save Draft','Submit Order','Company & Onboarding','Account & License','Orders']) {
    if (p.includes('button "' + label + '"')) throw new Error('Budtender has a commercial/admin action: ' + label);
  }
  if (p.includes('Snapshot displayed') || p.includes('Demo remaining') || p.includes('Minimum ') || /StaticText "\$\d/.test(p)) throw new Error('Commercial quantities, minimums or prices leaked.');
} else if (mode === 'billing') {
  // Billing is read-only own-account financials: one finance tab, no ordering, onboarding, license or internal controls.
  const page = await role('billing');
  const p = page.slice(page.indexOf('region "Internal Administrator Store Demo"'));
  if (!p.includes('button "Account Financials"') || !p.includes('Account financials · Read only') || !p.includes('Payment terms:')) throw new Error('Billing did not land on Account Financials.');
  for (const label of ['Catalog & Cart','Orders','Company & Onboarding','Activity & Reset','Add to Draft','Save Draft','Submit Order','Save Account Terms','Place Manual Hold','Release Manual Hold','Overdue Invoice','Record Renewed License (synthetic, no file)','Verify Renewed License','Reset My Demo']) {
    if (p.includes('button "' + label + '"')) throw new Error('Billing has an ordering/admin action: ' + label);
  }
  if (p.includes('Product ID ') || p.includes('Snapshot displayed') || p.includes('Control Audit') || p.includes('Ordering paused')) throw new Error('Billing received catalog, audit or ordering-gate content.');
} else if (mode === 'paused') {
  const p = await click('Refresh');
  if (!p.includes('Store demonstration is paused.')) throw new Error('Emergency pause was not enforced.');
} else if (mode === 'revoked') {
  const p = await click('Refresh');
  if (!p.includes('Internal Administrator membership and demo authority are required.')) throw new Error('Revoked membership was not denied.');
  if (p.includes('Cart quantity for ') || p.includes('Snapshot displayed')) throw new Error('Revoked demo data remained visible.');
} else if (mode === 'second-location') {
  await role('owner'); await click('Catalog & Cart');
  let p = await observeReady(); bsk('select', refFor(p, 'combobox', 'Demo location'), '--value', 'DEMO-UX-STORE-002');
  p = await observeReady(); bsk('select', refFor(p, 'combobox', 'Demo Brand filter'), '--value', 'Wana');
  p = await observeReady(); bsk('fill', refFor(p, 'spinbutton', 'Quantity for Wana Classic Mango Sativa'), '--value', '2');
  await click('Add to Draft'); await click('Save Draft');
  p = await click('Refresh');
  if (!p.includes('Cart quantity for Wana Classic Mango Sativa') || !p.includes('Total: $26.00')) throw new Error('Second-location draft did not persist.');
} else if (mode === 'order-workflow') {
  await role('buyer'); await click('Catalog & Cart');
  let p = await observeReady();
  bsk('select', refFor(p, 'combobox', 'Demo Brand filter'), '--value', 'all');
  p = await observeReady();
  bsk('fill', refFor(p, 'spinbutton', 'Quantity for UXT - Berry Lemonade - Cannabis Flower - 14g'), '--value', '30');
  await click('Add to Draft');
  await click('Save Draft');
  await role('internal'); await click('Account & License');
  p = await observeReady(); bsk('fill', refFor(p, 'textbox', 'Demo control reason'), '--value', 'Synthetic manual hold acceptance');
  p = await observeReady(); bsk('fill', refFor(p, 'textbox', 'Demo control evidence'), '--value', 'DEMO-EVIDENCE-UI');
  await click('Place Manual Hold');
  await role('buyer'); await click('Catalog & Cart');
  p = await click('Submit Order');
  if (!p.includes('Ordering is on hold for this account') || !p.includes('Cart quantity for UXT - Berry Lemonade - Cannabis Flower - 14g')) throw new Error('Hold did not preserve the Buyer draft.');
  await role('internal'); await click('Account & License');
  await click('Release Manual Hold');
  // An overdue warning after release does not block the Buyer.
  await click('Overdue Invoice');
  await role('buyer'); await click('Catalog & Cart'); await click('Submit Order');
  p = await click('Orders');
  if (!p.includes('Awaiting Owner Approval') || p.includes('button "Approve Buyer Order"')) throw new Error('Buyer approval boundary failed.');
  await role('owner'); await click('Orders'); await click('Approve Buyer Order');
  await role('internal'); await click('Orders');
  for (const label of ['Approve Order','Mark Shipped','Mark Delivered']) await click(label);
  p = await observeReady(); if (!p.includes('Delivered')) throw new Error('Order lifecycle incomplete.');
} else throw new Error('Unsupported test mode.');
console.log('PASS: ' + mode);
