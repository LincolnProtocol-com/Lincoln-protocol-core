// SPDX-License-Identifier: Apache-2.0
// Public local snapshot preparation only. No RPC, npm, signing or wallet access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {prepareMainnetDeployment,verifyDeploymentArchiveBinding,DEPLOYMENT_BASE_COMMIT,DEFAULT_DEPLOYMENT_DIRECTORY} from '../../scripts/core/prepare-mainnet-deployment.mjs';
import {configureMainnetOperations} from '../../scripts/core/mainnet-operations.mjs';

const ROOT=await fs.realpath(fileURLToPath(new URL('../../',import.meta.url)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('archive identity requires the exact immutable RC.2 commit',()=>{
  assert.equal(DEPLOYMENT_BASE_COMMIT,'abe000c7acd9c26931a17961e1b4bdda083df84e');
  assert.equal(DEFAULT_DEPLOYMENT_DIRECTORY,'.phase1-private/mainnet-deployments/rc2-eth-usdg');
  verifyDeploymentArchiveBinding(DEPLOYMENT_BASE_COMMIT);
  for(const value of ['HEAD','v0.1.0-rc.2','bd1c873','0'.repeat(40),undefined])
    assert.throws(()=>verifyDeploymentArchiveBinding(value),{code:'MAINNET_PREPARE_TAG_MISMATCH'});
});
test('output cannot target the source checkout, keystores, parent paths or nested ids',async()=>{
  for(const directory of [ROOT,'/Users/leo/.foundry/keystores','.phase1-private/mainnet-deployments',
    '.phase1-private/mainnet-deployments/../elsewhere','.phase1-private/mainnet-deployments/one/two'])
    await assert.rejects(()=>prepareMainnetDeployment({root:ROOT,directory}),{code:'MAINNET_PREPARE_OUTPUT_NOT_ALLOWED'});
});
test('preparation archives only the fixed public release, preserves source configuration and never overwrites a snapshot',{timeout:120000},async()=>{
  const id='test-prepare-'+randomUUID(),output=path.join(ROOT,'.phase1-private/mainnet-deployments',id);
  const untracked=path.join(ROOT,'untracked-prepare-'+randomUUID()+'.txt');
  const original=await fs.readFile(path.join(ROOT,'releases/rc2/config/phase2-mainnet.json'));
  await fs.writeFile(untracked,'Synthetic public exclusion marker, not a secret.',{flag:'wx'});
  let created=false;
  try{
    const result=await prepareMainnetDeployment({root:ROOT,directory:output});created=true;
    assert.equal(result.base.commit,DEPLOYMENT_BASE_COMMIT);assert.equal(result.base.tag,'v0.1.0-rc.2');
    assert.equal(result.base.releaseManifestSHA256,'abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3');
    assert.equal(result.derivedOperationsSnapshot,true);assert.equal(result.verbatimFrozenRelease,false);
    assert.equal(result.signingEnabled,false);assert.equal(result.keysAccessed,false);
    assert.equal(result.transactionsSigned,0);assert.equal(result.transactionsBroadcast,0);
    assert.equal(result.configBeforeSHA256,digest(original));
    assert.deepEqual(await fs.readFile(path.join(ROOT,'releases/rc2/config/phase2-mainnet.json')),original);
    const operationsBytes=await fs.readFile(path.join(ROOT,'config/mainnet-operations.json'));
    assert.equal(result.operationsSHA256,digest(operationsBytes));
    const effective=await fs.readFile(path.join(output,'config/phase2-mainnet.json'));
    assert.equal(result.configAfterSHA256,digest(effective));
    assert.deepEqual(JSON.parse(effective),configureMainnetOperations({config:JSON.parse(original),operations:JSON.parse(operationsBytes)}));
    assert.ok(Object.values(JSON.parse(effective).limits).some(value=>value===null));
    for(const relative of ['.git','node_modules','.phase1-private',path.basename(untracked),'config/mainnet-operations.json','config/phase2-mainnet-operations.json'])
      await assert.rejects(()=>fs.access(path.join(output,relative)),{code:'ENOENT'});
    const sentinel=path.join(output,'test-existing-journal-marker');await fs.writeFile(sentinel,'Do not overwrite or delete.');
    await assert.rejects(()=>prepareMainnetDeployment({root:ROOT,directory:output}),{code:'MAINNET_PREPARE_DIRECTORY_EXISTS'});
    assert.equal(await fs.readFile(sentinel,'utf8'),'Do not overwrite or delete.');
  }finally{
    await fs.unlink(untracked);
    // Only this test's newly created random directory is disposable. Never the
    // stable user deployment directory or an existing operator journal.
    if(created)await fs.rm(output,{recursive:true,force:true});
  }
});
