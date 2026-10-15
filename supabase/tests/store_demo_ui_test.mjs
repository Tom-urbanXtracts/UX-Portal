// Store Demo catalog "Add to Draft": evaluates the prototype's own storeDemoAdd
// method and catalog card mapping against a stub component. Products come from
// the browser-verified snapshot, so the minimum under test is the source value.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../../ux-portal-prototype.dc.html',import.meta.url),'utf8');
const snapshot=JSON.parse(readFileSync(new URL('../../data/canix-marketplace-listings-2026-10-14.json',import.meta.url),'utf8'));
const logic=source.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
// Extract one class method by brace matching, skipping comments, string and template contents.
function method(name,prefix='\n  '){
  const start=logic.indexOf(prefix+name+'(');
  assert(start>=0,name);
  let i=logic.indexOf(')',start),depth=0,quote=null;
  i=logic.indexOf('{',i);
  for(;i<logic.length;i++){
    const c=logic[i];
    if(quote){if(c==='\\')i++;else if(c===quote)quote=null;continue;}
    if(c==='/'&&logic[i+1]==='/'){i=logic.indexOf('\n',i);continue;}
    if(c==='/'&&logic[i+1]==='*'){i=logic.indexOf('*/',i)+1;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;continue;}
    if(c==='{')depth++;
    else if(c==='}'&&--depth===0)return logic.slice(start,i+1);
  }
  throw Error('Unterminated method '+name);
}
// Same shape the synthetic projection serves to commercial views.
const projected=id=>{
  const p=snapshot.products.find(row=>row.marketplaceProductId===id);
  return {id:p.marketplaceProductId,name:p.productName,brand:p.brandName,category:p.itemCategoryName,priceCents:p.priceCents,
    saleUnit:p.saleUnit,minimumOrderQuantity:p.minimumOrderQuantity,available:p.availableQuantity,snapshotAvailableQuantity:p.availableQuantity,hasImage:false};
};
const BERRY_KUSH=projected('18780'); // minimum 8 each
const BERRY_LEMONADE=projected('13057'); // minimum 1 each
const plain=value=>JSON.parse(JSON.stringify(value));
function component(state={}){
  const proto=runInNewContext(`({${method('storeDemoAdd')}})`,{Number});
  const c=Object.create(proto);
  c.state={storeDemoRole:'owner',storeDemoCart:[],storeDemoQuantities:{},storeDemoAddErrors:{},...state};
  c.setState=patch=>{Object.assign(c.state,typeof patch==='function'?patch(c.state):patch);};
  c.set=c.setState;
  return c;
}
// The catalog card mapping rendered by the template, evaluated against the same component.
const cardsFragment=(()=>{
  const start=logic.indexOf('    const storeDemoProducts = (storeDemo.products');
  assert(start>=0,'catalog card mapping');
  return logic.slice(start,logic.indexOf('\n    const storeDemoCart =',start));
})();
function cards(c){
  return runInNewContext(`(function(){${cardsFragment};return storeDemoProducts;}).call(self)`,{
    self:c,s:c.state,storeDemo:{products:[BERRY_KUSH,BERRY_LEMONADE]},storeDemoBrandFilter:'all',storeDemoCategoryFilter:'all',storeDemoSearch:'',
    MONEY:cents=>'$'+(cents/100).toFixed(2),Number,String});
}

test('Snapshot fixture carries the exact source minimum under test',()=>{
  assert.equal(BERRY_KUSH.minimumOrderQuantity,8);
  assert.equal(BERRY_KUSH.saleUnit,'each');
  assert.equal(BERRY_LEMONADE.minimumOrderQuantity,1);
});

test('Add to Draft refuses a positive quantity below the source minimum and leaves the draft unchanged',()=>{
  const existing=[{productId:BERRY_LEMONADE.id,quantity:3}];
  for(const typed of ['7','1',7]){
    const c=component({storeDemoCart:existing.map(l=>({...l})),storeDemoQuantities:{[BERRY_KUSH.id]:typed}});
    c.storeDemoAdd(BERRY_KUSH);
    assert.deepEqual(plain(c.state.storeDemoCart),existing,'draft unchanged for '+typed);
    assert.equal(c.state.storeDemoAddErrors[BERRY_KUSH.id],'Minimum 8 each for '+BERRY_KUSH.name+'. Nothing was added.');
  }
});

test('Add to Draft refusal does not replace an existing valid line for the same product',()=>{
  const c=component({storeDemoCart:[{productId:BERRY_KUSH.id,quantity:10}],storeDemoQuantities:{[BERRY_KUSH.id]:'7'}});
  c.storeDemoAdd(BERRY_KUSH);
  assert.deepEqual(plain(c.state.storeDemoCart),[{productId:BERRY_KUSH.id,quantity:10}]);
});

test('Add to Draft refuses empty, zero and fractional quantities with an actionable message',()=>{
  for(const typed of ['','0','-3']){
    const c=component({storeDemoQuantities:{[BERRY_KUSH.id]:typed}});
    c.storeDemoAdd(BERRY_KUSH);
    assert.deepEqual(plain(c.state.storeDemoCart),[],typed);
    assert.match(c.state.storeDemoAddErrors[BERRY_KUSH.id],/^Minimum 8 each for .+\. Nothing was added\.$/);
  }
  const c=component({storeDemoQuantities:{[BERRY_KUSH.id]:'8.5'}});
  c.storeDemoAdd(BERRY_KUSH);
  assert.deepEqual(plain(c.state.storeDemoCart),[]);
  assert.equal(c.state.storeDemoAddErrors[BERRY_KUSH.id],'Enter a whole quantity for '+BERRY_KUSH.name+'. Nothing was added.');
});

test('Add to Draft accepts the exact minimum, the untouched default and non-multiples above it',()=>{
  for(const [typed,expected] of [['8',8],[undefined,8],['9',9],['13',13]]){
    const c=component({storeDemoQuantities:typed===undefined?{}:{[BERRY_KUSH.id]:typed},storeDemoAddErrors:{[BERRY_KUSH.id]:'stale'}});
    c.storeDemoAdd(BERRY_KUSH);
    assert.deepEqual(plain(c.state.storeDemoCart),[{productId:BERRY_KUSH.id,quantity:expected}],String(typed));
    assert.equal(c.state.storeDemoAddErrors[BERRY_KUSH.id],undefined,'a successful add clears the product message');
  }
  const c=component({storeDemoQuantities:{[BERRY_LEMONADE.id]:'1'}});
  c.storeDemoAdd(BERRY_LEMONADE);
  assert.deepEqual(plain(c.state.storeDemoCart),[{productId:BERRY_LEMONADE.id,quantity:1}]);
});

test('A refusal for one product does not touch another product line or message',()=>{
  const c=component({storeDemoCart:[{productId:BERRY_LEMONADE.id,quantity:2}],storeDemoAddErrors:{[BERRY_LEMONADE.id]:'kept'},storeDemoQuantities:{[BERRY_KUSH.id]:'7'}});
  c.storeDemoAdd(BERRY_KUSH);
  assert.deepEqual(plain(c.state.storeDemoCart),[{productId:BERRY_LEMONADE.id,quantity:2}]);
  assert.equal(c.state.storeDemoAddErrors[BERRY_LEMONADE.id],'kept');
});

test('Non-ordering views cannot add and receive no message',()=>{
  for(const role of ['budtender','billing','internal']){
    const c=component({storeDemoRole:role,storeDemoQuantities:{[BERRY_KUSH.id]:'7'}});
    c.storeDemoAdd(BERRY_KUSH);
    assert.deepEqual(plain(c.state.storeDemoCart),[]);
    assert.deepEqual(plain(c.state.storeDemoAddErrors),{});
  }
});

test('Catalog card exposes the refusal accessibly and clears it on the next quantity edit',()=>{
  const c=component({storeDemoQuantities:{[BERRY_KUSH.id]:'7'}});
  cards(c).find(p=>p.id===BERRY_KUSH.id).onAdd();
  const card=cards(c).find(p=>p.id===BERRY_KUSH.id);
  assert.equal(card.hasAddError,true);
  assert.equal(card.addInvalid,'true');
  assert.equal(card.addError,'Minimum 8 each for '+BERRY_KUSH.name+'. Nothing was added.');
  assert.equal(card.addErrorId,'store-demo-add-error-'+BERRY_KUSH.id);
  const other=cards(c).find(p=>p.id===BERRY_LEMONADE.id);
  assert.equal(other.hasAddError,false);
  assert.equal(other.addInvalid,'false');
  card.onQuantity({target:{value:'8'}});
  const edited=cards(c).find(p=>p.id===BERRY_KUSH.id);
  assert.equal(edited.hasAddError,false);
  assert.equal(c.state.storeDemoQuantities[BERRY_KUSH.id],'8');
  edited.onAdd();
  assert.deepEqual(plain(c.state.storeDemoCart),[{productId:BERRY_KUSH.id,quantity:8}]);
});

test('Template renders the per-product refusal as an alert tied to its quantity input',()=>{
  const card=source.slice(source.indexOf('<sc-for list="{{ storeDemoProducts }}" as="product">'),source.indexOf('</sc-for></div></section>',source.indexOf('<sc-for list="{{ storeDemoProducts }}" as="product">')));
  assert.match(card,/<input aria-label="\{\{ product\.quantityLabel \}\}" aria-describedby="\{\{ product\.addErrorId \}\}" aria-invalid="\{\{ product\.addInvalid \}\}"/);
  assert.match(card,/<sc-if value="\{\{ product\.hasAddError \}\}" hint-placeholder-val="\{\{ false \}\}"><p id="\{\{ product\.addErrorId \}\}" role="alert" class="sd-field-error">\{\{ product\.addError \}\}<\/p><\/sc-if>/);
});

// Synthetic Invoice table: the prototype's own renderVals fragment and template, fed the invoice subset
// that store_demo_test.ts proves the real projection returns for each role and accounting scenario.
const invoiceProjection=JSON.parse(readFileSync(new URL('./fixtures/store_demo_invoice_projection.json',import.meta.url),'utf8'));
const between=(text,from,to)=>{const a=text.indexOf(from);assert(a>=0,from);const b=text.indexOf(to,a);assert(b>a,to);return text.slice(a,b);};
const invoiceVals=(()=>{
  const consts=between(logic,'    const storeDemoBalanceUnknown =','\n    const dataControlData =');
  const stats=between(logic,'      storeDemoStats: [','      storeDemoAccountingNotice:');
  const fields=between(logic,'      storeDemoHasInvoices:','      storeDemoFinancialNotice:');
  return (role,body)=>runInNewContext(`(function(){${consts};return {${stats}${fields}};})()`,{
    storeDemo:body,storeDemoFinance:body.finance||{},storeDemoRole:role,
    MONEY:runInNewContext(between(logic,'const MONEY =',';\n').slice('const MONEY ='.length)),formatDateTimeUs:String,Number,String});
})();
const invoiceTable=between(source,'<h3 class="sd-h3">Synthetic Invoice</h3>','<p class="sd-small">{{ storeDemoFinancialNotice }}</p>');
// Minimal render of the table fragment: one sc-if, then every binding must resolve to a value.
function renderInvoiceTable(vals){
  const open=invoiceTable.match(/<sc-if value="\{\{ (\w+) \}\}"[^>]*>/);
  assert(open,'invoice table is conditional');
  if(!vals[open[1]])return '';
  return invoiceTable.slice(open.index+open[0].length).replace(/\{\{ ([\w.]+) \}\}/g,(_,name)=>{
    assert(name in vals,'unresolved binding '+name);
    return String(vals[name]);
  });
}
const invoiceCells=html=>[...html.matchAll(/<td data-label="([^"]+)">([^<]*)<\/td>/g)].map(m=>[m[1],m[2]]);
const balanceStat=vals=>vals.storeDemoStats.find(s=>s.label==='Open balance');

test('Unknown sync renders no invoice row and keeps every balance withheld',()=>{
  for(const role of ['owner','billing','internal']){
    const vals=invoiceVals(role,invoiceProjection[role].unknown);
    assert.equal(vals.storeDemoHasInvoices,false,role);
    assert.equal(renderInvoiceTable(vals),'',role);
    assert.equal(balanceStat(vals).value,'Withheld',role);
    assert.equal(balanceStat(vals).note,'Not shown as zero while the sync time is unknown',role);
    for(const field of ['storeDemoInvoiceNumber','storeDemoInvoiceStatus','storeDemoInvoiceAmount','storeDemoInvoiceBalance'])
      assert.equal(vals[field],'',role+' '+field);
  }
});

test('Current/Paid and Overdue render one fully populated synthetic invoice row for Billing, Internal and Owner',()=>{
  const expected={
    current:[['Invoice','DEMO-INV-001'],['Status','Paid'],['Amount','$1,200.00'],['Balance','$0.00']],
    overdue:[['Invoice','DEMO-INV-001'],['Status','Overdue'],['Amount','$1,200.00'],['Balance','$1,200.00']]};
  for(const role of ['owner','billing','internal'])for(const scenario of ['current','overdue']){
    const vals=invoiceVals(role,invoiceProjection[role][scenario]);
    const html=renderInvoiceTable(vals);
    assert.equal((html.match(/<tr>/g)||[]).length,2,role+' '+scenario+': header row plus exactly one invoice row');
    assert.deepEqual(invoiceCells(html),expected[scenario],role+' '+scenario);
    assert.equal(balanceStat(vals).value,expected[scenario][3][1],role+' '+scenario+': open balance matches the row');
    assert.equal(balanceStat(vals).note,'Synthetic invoices · warning only, never a block');
  }
});

test('Synthetic Invoice template uses flat display fields, keeps headers and data labels, and has no nested invoice alias',()=>{
  assert.doesNotMatch(invoiceTable,/invoice\./,'no invoice.* bindings');
  assert.doesNotMatch(invoiceTable,/<sc-for/,'no loop inside the table');
  assert.match(invoiceTable,/<sc-if value="\{\{ storeDemoHasInvoices \}\}"[^>]*><table class="sd-table">/);
  assert.match(invoiceTable,/<thead><tr><th scope="col">Invoice<\/th><th scope="col">Status<\/th><th scope="col">Amount<\/th><th scope="col">Balance<\/th><\/tr><\/thead>/);
  assert.match(invoiceTable,/<tbody><tr><td data-label="Invoice">\{\{ storeDemoInvoiceNumber \}\}<\/td><td data-label="Status">\{\{ storeDemoInvoiceStatus \}\}<\/td><td data-label="Amount">\{\{ storeDemoInvoiceAmount \}\}<\/td><td data-label="Balance">\{\{ storeDemoInvoiceBalance \}\}<\/td><\/tr><\/tbody>/);
  assert.doesNotMatch(logic,/storeDemoInvoiceRows/,'retired list binding is gone');
});

test('Buyer and Budtender receive no invoice fields',()=>{
  for(const role of ['buyer','budtender'])for(const scenario of ['current','overdue','unknown']){
    const body=invoiceProjection[role][scenario];
    assert(!('invoices' in body)&&!('finance' in body),role+' '+scenario);
    const vals=invoiceVals(role,body);
    assert.equal(vals.storeDemoHasInvoices,false);
    assert.equal(renderInvoiceTable(vals),'');
    for(const field of ['storeDemoInvoiceNumber','storeDemoInvoiceStatus','storeDemoInvoiceAmount','storeDemoInvoiceBalance'])
      assert.equal(vals[field],'',role+' '+scenario+' '+field);
  }
});
