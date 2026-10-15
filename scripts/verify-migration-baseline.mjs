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

console.log(JSON.stringify({
  status:'pass',
  repositoryMigrations:current.length,
  productionHistory:artifact.productionHistory.length,
  versionAliases:artifact.versionAliases.length,
  productionOnlyResolved:artifact.productionOnlyResolution.length,
  repositoryOnlyCandidates:artifact.repositoryOnly.length,
  productionDeployment:false,
}));
