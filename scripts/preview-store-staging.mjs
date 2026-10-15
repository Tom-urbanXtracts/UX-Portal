// Local candidate frontend backed by real staging Auth/API, never production.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {base} from './store-staging-support.mjs';
const address='http://127.0.0.1:4174';
const config={supabaseUrl:address,supabaseKey:'sb_publishable_TukThv1W74qHSPP5-1tkMw_AuxFP1qf',ssoDomain:'urbanxtracts.com'};
const html=readFileSync(new URL('../dist/portal.html',import.meta.url),'utf8').replace('</head>',
  '<script>window.UX_PORTAL_CONFIG='+JSON.stringify(config)+';</script></head>');
const functions=new Set(['portal-admin','canix-catalog','portal-pricing','portal-intake','portal-orders','portal-order-policy',
  'quickbooks-financials','portal-claims','portal-notifications','portal-assets','portal-retailers','portal-store-demo',
  'portal-brand-onboarding','portal-brand-profile','portal-brand-operations','portal-brand-documents','portal-brand-support',
  'portal-brand-supply-chain','portal-internal-work','portal-work-queue','portal-kiosk','portal-sku-intake']);
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,address);
    if(url.pathname==='/'){
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"connect-src 'self' blob: data:; frame-src 'none'; form-action 'self'; object-src 'none'"});
      res.end(req.method==='HEAD'?undefined:html);return;
    }
    const allowed=url.pathname.startsWith('/rest/v1/')||['/auth/v1/user','/auth/v1/token','/auth/v1/logout','/auth/v1/authorize'].includes(url.pathname)
      || (url.pathname.startsWith('/functions/v1/')&&functions.has(url.pathname.slice('/functions/v1/'.length)));
    if(!allowed){res.writeHead(404);res.end('Not installed in isolated staging preview.');return;}
    let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('Request too large');}
    const upstream=await fetch(base+url.pathname+url.search,{method:req.method,redirect:url.pathname==='/auth/v1/authorize'?'manual':'error',signal:AbortSignal.timeout(30000),
      headers:{apikey:req.headers.apikey||config.supabaseKey,Authorization:req.headers.authorization||'',
        'Content-Type':req.headers['content-type']||'application/json',
        'x-ux-membership-id':req.headers['x-ux-membership-id']||'','x-ux-organization-id':req.headers['x-ux-organization-id']||''},
      body:['GET','HEAD'].includes(req.method)?undefined:body});
    const responseHeaders={'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'};
    if(url.pathname==='/auth/v1/authorize'&&upstream.headers.get('location')) responseHeaders.Location=upstream.headers.get('location');
    res.writeHead(upstream.status,responseHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Staging request unavailable; production was not contacted.'}));}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4174,'127.0.0.1',resolve);});
console.log('STAGING ONLY — real Auth/backend, synthetic identities. '+address);
process.on('SIGINT',()=>server.close(()=>process.exit()));
process.on('SIGTERM',()=>server.close(()=>process.exit()));
