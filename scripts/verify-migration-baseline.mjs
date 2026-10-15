import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(new URL('..',import.meta.url).pathname);
const artifactPath=resolve(root,'artifacts/store-demo-release-2026-10-15/migration-baseline-reconciliation.json');
const artifact=JSON.parse(await readFile(artifactPath,'utf8'));
const migrationDir=resolve(root,'supabase/migrations');
const names=(await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort();
const current=[];
for(const filename of names){
  const bytes=await readFile(resolve(migrationDir,filename));
  current.push({
    version:filename.slice(0,14),
    name:filename.slice(15,-4),
    md5:createHash('md5').update(bytes).digest('hex'),
  });
}

assert.equal(artifact.schemaVersion,1,'Unsupported migration-baseline artifact.');
assert.deepEqual(current,artifact.repositoryMigrations,
  'Repository migrations changed; refresh and review the baseline reconciliation before release.');
assert.equal(artifact.counts.repository,current.length);
assert.equal(artifact.counts.productionOnly,artifact.productionOnly.length);
assert.equal(artifact.counts.repositoryOnly,artifact.repositoryOnly.length);
assert.equal(artifact.counts.versionAliases,artifact.versionAliases.length);

for(const resolution of artifact.productionOnlyResolution){
  assert.equal(resolution.productionStatementsMd5,resolution.repositoryFileMd5,
    `Production-only migration ${resolution.productionName} is not reconciled to equivalent source.`);
  const local=resolve(root,resolution.equivalentRepositoryFile);
  const digest=createHash('md5').update(await readFile(local)).digest('hex');
  assert.equal(digest,resolution.repositoryFileMd5,
    `Reconciled source changed for ${resolution.productionName}.`);
}

const productionNames=new Set(artifact.productionHistory.map(row=>row.name));
for(const alias of artifact.versionAliases){
  assert(productionNames.has(alias.name),`Unknown production alias ${alias.name}.`);
  assert.notEqual(alias.repositoryVersion,alias.productionAppliedVersion,
    `Non-alias entry recorded for ${alias.name}.`);
}

// The explicit reviewed candidate list is the only approved production apply
// order. It must stay identical to the reconciliation's repository-only set and
// to the files actually present in the repository.
const candidatePath=resolve(root,'artifacts/store-demo-release-2026-10-15/production-candidate-migrations.json');
const candidateList=JSON.parse(await readFile(candidatePath,'utf8'));
assert.equal(candidateList.schemaVersion,1,'Unsupported candidate-migration artifact.');
assert.equal(candidateList.productionProject,artifact.productionProject,
  'Candidate list targets a different project than the reconciliation.');

const candidates=candidateList.candidates;
assert.deepEqual(candidates.map(entry=>entry.order),candidates.map((_,index)=>index+1),
  'Candidate order must be contiguous and start at 1.');
assert.deepEqual(
  candidates.map(entry=>({version:entry.version,name:entry.name,md5:entry.md5})),
  [...artifact.repositoryOnly].sort((a,b)=>a.version.localeCompare(b.version)),
  'Candidate list does not match the reconciled repository-only migrations in repository order.');

const repositoryIndex=new Map(current.map(entry=>[entry.version+'_'+entry.name,entry.md5]));
for(const entry of candidates){
  const key=entry.version+'_'+entry.name;
  assert(repositoryIndex.has(key),`Candidate ${key} is not in the repository.`);
  assert.equal(repositoryIndex.get(key),entry.md5,
    `Candidate ${key} changed; re-review the candidate list before release.`);
  assert(typeof entry.rerunSafe==='boolean',`Candidate ${key} has no re-run safety review.`);
  assert(entry.rerunSafeBasis,`Candidate ${key} has no re-run safety basis.`);
  assert(entry.productionLedgerRow==='absent',
    `Candidate ${key} is no longer repository-only; refresh the reconciliation.`);
}

// Approval is a human gate. Recording an approver must not be possible without
// a date, and this check never asserts that approval has happened.
assert.equal(Boolean(candidateList.approvedBy),Boolean(candidateList.approvedAt),
  'Candidate list approval requires both an approver and a date.');
const candidateListApproved=Boolean(candidateList.approvedBy);

console.log(JSON.stringify({
  status:'pass',
  repositoryMigrations:current.length,
  productionHistory:artifact.productionHistory.length,
  versionAliases:artifact.versionAliases.length,
  productionOnlyResolved:artifact.productionOnlyResolution.length,
  repositoryOnlyCandidates:artifact.repositoryOnly.length,
  candidateListEntries:candidates.length,
  candidateListApproved,
  productionDeployment:false,
}));
