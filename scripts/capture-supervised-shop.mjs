// Supervised, DOM-only capture. Never reads browser storage or credentials.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const [session, output] = process.argv.slice(2);
assert(session && output?.startsWith('/tmp/ux-shop-supervised-'));
const expression = `(() => {
  if (location.origin !== 'https://app.canix.com' || location.pathname !== '/marketplace/urbanXtracts') throw Error('Wrong Shop');
  const declared = document.querySelector('main')?.innerText.match(/\\(\\s*([\\d,]+)\\s+PRODUCTS\\)/i);
  const products = new Map();
  for (const card of document.querySelectorAll('.MuiCard-root')) {
    const a = [...card.querySelectorAll('a[href*="/products/"]')].find(a=>a.textContent.trim());
    if (!a) continue;
    const gid = a.getAttribute('href').split('/products/')[1];
    const id = atob(gid).match(/\\/(\\d+)$/)?.[1];
    const headings = [...card.querySelectorAll('h6')];
    const priceText = headings.find(h=>h.textContent.trim().startsWith('$'))?.textContent.trim();
    const availableText = [...card.querySelectorAll('p')].find(p=>/available/i.test(p.textContent))?.textContent;
    const available = availableText?.match(/([\\d,.]+)\\s+(.+?)\\s+available/i);
    let group = card.parentElement;
    while (group && !group.querySelector('h5')) group=group.parentElement;
    const image = card.querySelector('img');
    const imageSource = image?.getAttribute('src') || null;
    const imageUrl = imageSource?.startsWith('data:image/') ? null : imageSource;
    const product = {marketplaceProductId:id, productGid:gid, productName:a.textContent.trim(),
      brandName:headings[0]?.textContent.trim(), itemCategoryName:group?.querySelector('h5')?.textContent.trim(),
      priceCents:priceText ? Math.round(Number(priceText.replace(/[$,]/g,''))*100) : null,
      availableQuantity:available ? Number(available[1].replace(/,/g,'')) : null,
      saleUnit:card.querySelector('[role="combobox"]')?.textContent.trim(),
      hasImage:Boolean(imageUrl),imageUrl,
      // A pre-filled quantity is a suggestion, not verified minimum/case size.
      suggestedOrderQuantity:Number(card.querySelector('input[name="quantity"]')?.value),
      minimumOrderQuantity:null,unitsPerCase:null,
      productUrl:new URL(a.getAttribute('href'),location.origin).href};
    if (products.has(id) && JSON.stringify(products.get(id)) !== JSON.stringify(product)) throw Error('Conflicting duplicate card');
    products.set(id,product);
  }
  return {declaredProductCount:Number(declared?.[1].replace(/,/g,'')),products:[...products.values()]};
})()`;
const result=JSON.parse(execFileSync('bsk',['evaluate','--session',session,'--json',expression],{encoding:'utf8',maxBuffer:2000000}));
assert.equal(result.ok,true,'Browser capture failed');
const source=result.value;
assert(Number.isSafeInteger(source.declaredProductCount) && source.declaredProductCount>0);
assert.equal(source.products.length,source.declaredProductCount,'Partial capture refused');
for(const p of source.products){
  assert(/^\d+$/.test(p.marketplaceProductId));
  for(const key of ['productName','brandName','itemCategoryName','saleUnit'])assert(p[key]?.trim());
  assert(Number.isSafeInteger(p.priceCents)&&p.priceCents>0);
  assert(Number.isFinite(p.availableQuantity)&&p.availableQuantity>=0);
  if(p.imageUrl)assert.equal(new URL(p.imageUrl).hostname,'assets.canix.com');
}
const snapshot={source:{shopSlug:'urbanXtracts',sourceUrl:'https://app.canix.com/marketplace/urbanXtracts',
  sourceMode:'browser_verified_snapshot',snapshotScope:'full_shop',capturedAt:new Date().toISOString(),
  syncRunId:randomUUID(),declaredProductCount:source.declaredProductCount,capturedProductCount:source.products.length},products:source.products};
writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,products:snapshot.products.length,brands:new Set(snapshot.products.map(p=>p.brandName)).size,
  images:snapshot.products.filter(p=>p.hasImage).length,capturedAt:snapshot.source.capturedAt,productionChanged:false}));
