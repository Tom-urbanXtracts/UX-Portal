// Read-only rendered-DOM regression; no private application state is inspected.
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const session=process.argv[2];if(!session)throw Error('Pass BrowserSkill session.');
const expression=`(() => {
  const main=document.getElementById('main-content');
  const panel=document.querySelector('section[aria-label="Store membership administration"]');
  return {viewport:document.documentElement.clientWidth,main:main?.getBoundingClientRect().width,panel:panel?.getBoundingClientRect().width};
})()`;
const result=JSON.parse(execFileSync('bsk',['evaluate','--session',session,'--json',expression],{encoding:'utf8'}));
assert.equal(result.ok,true);const values=result.value;
assert(values.viewport<820,'Run this check in mobile emulation.');
assert(values.main>=values.viewport*.85&&values.panel>=values.viewport*.65,'Mobile form is squeezed: '+JSON.stringify(values));
console.log('PASS: mobile Store administration uses the available viewport '+JSON.stringify(values));
