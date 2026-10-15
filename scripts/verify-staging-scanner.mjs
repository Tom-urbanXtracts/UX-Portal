// Positive malware-scanner acceptance against isolated UX OS Staging only.
// Requires a configured staging scanner endpoint and secret. Never prints
// credentials, file contents, signed URLs or provider responses.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {api,base,keychainPassword,keys,sql} from './store-staging-support.mjs';

const workdir=process.argv[2];
assert(workdir?.startsWith('/tmp/ux-os-staging-20261014.'),'Pass the isolated staging workdir.');
const credential=keys();
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

async function session(name){
  return api('/auth/v1/token?grant_type=password',{...credential,method:'POST',body:{
    email:'ux-staging-'+name+'@example.invalid',password:keychainPassword(name),
  }});
}

async function edge(name,{token,membership,organization,body}={}){
  const response=await fetch(base+'/functions/v1/'+name,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{
      apikey:credential.anon,Authorization:'Bearer '+token,'Content-Type':'application/json',
      'x-ux-membership-id':membership,'x-ux-organization-id':organization,
    },
    body:JSON.stringify(body||{}),
  });
  return {status:response.status,body:await response.json().catch(()=>({}))};
}

function file(bytes,name){
  return {name,contentType:'application/pdf',sizeBytes:bytes.length,base64:bytes.toString('base64')};
}

function eicarPdf(){
  // ClamAV's EICAR signature matches the exact 68-byte test file. Embed that
  // file as a PDF attachment so the request also satisfies the Portal's
  // independently enforced PDF magic-byte contract.
  const marker='X5O!P%@AP[4'+String.fromCharCode(92)+'PZX54(P^)7CC)7}'
    +String.fromCharCode(36)+'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!'
    +String.fromCharCode(36)+'H+H*';
  const objects=[
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(eicar.com) 5 0 R] >> >> >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>\nendobj\n',
    `4 0 obj\n<< /Type /EmbeddedFile /Length ${Buffer.byteLength(marker)} >>\nstream\n${marker}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Filespec /F (eicar.com) /EF << /F 4 0 R >> >>\nendobj\n',
  ];
  let pdf='%PDF-1.4\n%1234\n';
  const offsets=[0];
  for(const object of objects){offsets.push(Buffer.byteLength(pdf));pdf+=object;}
  const xref=Buffer.byteLength(pdf);
  pdf+='xref\n0 6\n0000000000 65535 f \n';
  for(let index=1;index<=5;index+=1)pdf+=String(offsets[index]).padStart(10,'0')+' 00000 n \n';
  pdf+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf,'binary');
}

const admin=await session('admin');
const selectedMembership=id(3),selectedOrganization=id(2),brandOrganization=id(23);
const before=Number(sql(workdir,"select count(*) from portal_brand_document where title like 'UXSTAGE scanner acceptance %';").trim());
const suffix=randomUUID();
const clean=Buffer.from(`%PDF-1.4\n% UX OS staging clean scanner acceptance ${suffix}\n%%EOF\n`);
const eicar=eicarPdf();

const cleanUpload=await edge('portal-brand-documents',{
  token:admin.access_token,membership:selectedMembership,organization:selectedOrganization,
  body:{action:'upload',organizationId:brandOrganization,category:'company',
    title:'UXSTAGE scanner acceptance '+suffix,file:file(clean,'uxstage-clean.pdf')},
});
assert.equal(cleanUpload.status,201,`Clean staging upload returned ${cleanUpload.status} (${String(cleanUpload.body?.error||cleanUpload.body?.code||'no error detail')}).`);
const documentId=String(cleanUpload.body?.document?.id||'');
assert.match(documentId,/^[0-9a-f-]{36}$/i,'Clean staging upload did not return a document ID.');
const state=sql(workdir,`select scan_state||'|'||coalesce(scan_provider,'') from portal_brand_document where id='${documentId}';`).trim();
assert.match(state,/^clean\|.+/,'Clean staging upload did not retain a verified scanner result.');

const infectedUpload=await edge('portal-brand-documents',{
  token:admin.access_token,membership:selectedMembership,organization:selectedOrganization,
  body:{action:'upload',organizationId:brandOrganization,category:'company',
    title:'UXSTAGE scanner acceptance EICAR '+suffix,file:file(eicar,'uxstage-eicar.pdf')},
});
assert.equal(infectedUpload.status,422,`EICAR staging upload returned ${infectedUpload.status} (${String(infectedUpload.body?.error||infectedUpload.body?.code||'no error detail')}), expected 422.`);
const after=Number(sql(workdir,"select count(*) from portal_brand_document where title like 'UXSTAGE scanner acceptance %';").trim());
assert.equal(after,before+1,'The infected upload created a durable document record.');

const archive=await edge('portal-brand-documents',{
  token:admin.access_token,membership:selectedMembership,organization:selectedOrganization,
  body:{action:'archive',organizationId:brandOrganization,documentId},
});
assert.equal(archive.status,200,`Clean acceptance document archive returned ${archive.status}.`);

console.log(JSON.stringify({
  suite:'staging-malware-scanner',passed:3,cleanAccepted:true,eicarRejected:true,
  cleanEvidenceArchived:true,productionDeployment:false,
}));
