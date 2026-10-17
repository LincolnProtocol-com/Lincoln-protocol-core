// SPDX-License-Identifier: Apache-2.0
// Disposable public fixtures only. No RPC, keystores or operator ledger access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureReleaseDependencies,RELEASE_DIRECTORY,LEGACY_RELEASE_DIRECTORY} from '../../scripts/review/runtime.mjs';
import {mainnetOperationsPlan} from '../../scripts/core/mainnet-operations.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const encode=value=>JSON.stringify(value,null,2)+'\n';
const lock=version=>({name:'@lincolnprotocol/core',version,lockfileVersion:3,requires:true,packages:{
  '':{name:'@lincolnprotocol/core',version,dependencies:{solc:'0.8.28'},engines:{node:'>=22'}},
  'node_modules/solc':{version:'0.8.28',resolved:'https://registry.npmjs.org/solc/-/solc-0.8.28.tgz',integrity:'sha512-synthetic-pin',dependencies:{semver:'^5.5.0'}},
  'node_modules/semver':{version:'5.7.2',resolved:'https://registry.npmjs.org/semver/-/semver-5.7.2.tgz',integrity:'sha512-synthetic-transitive-pin'}}});
async function put(root,relative,bytes){const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
async function fixture(fn){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-review-runtime-')));
  try{
    await put(root,'package-lock.json',encode(lock('0.1.0-rc.3')));
    for(const [directory,version]of [[RELEASE_DIRECTORY,'0.1.0-rc.3'],[LEGACY_RELEASE_DIRECTORY,'0.1.0-rc.2']])
      await put(root,path.join(directory,'package-lock.json'),encode(lock(version)));
    await put(root,'node_modules/solc/index.js','// synthetic compiler marker\n');
    await fs.mkdir(path.join(root,'node_modules/.bin'));
    await fs.symlink('../solc/index.js',path.join(root,'node_modules/.bin/solc'));
    await fn(root);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
const legacy=root=>ensureReleaseDependencies({root,releaseDirectory:LEGACY_RELEASE_DIRECTORY});

test('current capsule dependencies require exact lock bytes and use independent regular copies',()=>fixture(async root=>{
  const release=await ensureReleaseDependencies({root}),source=path.join(root,'node_modules/solc/index.js');
  const copied=path.join(release,'node_modules/solc/index.js'),binary=path.join(release,'node_modules/.bin/solc');
  assert.equal((await fs.lstat(copied)).isFile(),true);assert.equal(await fs.realpath(copied),copied);
  assert.equal((await fs.lstat(binary)).isSymbolicLink(),true);
  assert.equal(await fs.readlink(binary),'../solc/index.js');assert.equal(await fs.realpath(binary),copied);
  await fs.writeFile(source,'// changed synthetic root dependency\n');
  assert.equal(await fs.readFile(copied,'utf8'),'// synthetic compiler marker\n');
  assert.equal(await fs.readFile(binary,'utf8'),'// synthetic compiler marker\n');
}));

test('historical hydration accepts only the two release-version labels and leaves current capsule bytes unchanged',()=>fixture(async root=>{
  const currentLock=await fs.readFile(path.join(root,RELEASE_DIRECTORY,'package-lock.json'));
  await assert.rejects(fs.access(path.join(root,LEGACY_RELEASE_DIRECTORY,'node_modules')),{code:'ENOENT'});
  const release=await legacy(root);assert.equal(release,path.join(root,LEGACY_RELEASE_DIRECTORY));
  assert.equal(await fs.realpath(path.join(release,'node_modules/.bin/solc')),path.join(release,'node_modules/solc/index.js'));
  assert.deepEqual(await fs.readFile(path.join(root,RELEASE_DIRECTORY,'package-lock.json')),currentLock);
  await assert.rejects(fs.access(path.join(root,RELEASE_DIRECTORY,'node_modules')),{code:'ENOENT'});
  assert.equal(await legacy(root),release);
}));

test('historical hydration rejects direct, transitive, integrity, URL, engine and unexpected metadata changes',async()=>{
  const mutations=[
    value=>value.packages[''].dependencies.solc='0.8.29',
    value=>value.packages['node_modules/solc'].version='0.8.29',
    value=>value.packages['node_modules/semver'].version='5.7.1',
    value=>value.packages['node_modules/semver'].integrity='sha512-different',
    value=>value.packages['node_modules/solc'].resolved='https://example.invalid/other.tgz',
    value=>value.packages[''].engines.node='>=24',
    value=>value.overrides={solc:'0.8.29'},
    value=>value.version='arbitrary-version',
    value=>value.packages[''].version='arbitrary-version',
  ];
  for(const mutate of mutations)await fixture(async root=>{
    const changed=lock('0.1.0-rc.2');mutate(changed);
    await put(root,path.join(LEGACY_RELEASE_DIRECTORY,'package-lock.json'),encode(changed));
    await assert.rejects(()=>legacy(root),/REVIEW_DEPENDENCY_LOCK_CHANGED/);
    await assert.rejects(fs.access(path.join(root,LEGACY_RELEASE_DIRECTORY,'node_modules')),{code:'ENOENT'});
  });
});

test('current capsule does not inherit the historical semantic lock exception',()=>fixture(async root=>{
  await put(root,path.join(RELEASE_DIRECTORY,'package-lock.json'),JSON.stringify(lock('0.1.0-rc.3')));
  await assert.rejects(()=>ensureReleaseDependencies({root}),/REVIEW_DEPENDENCY_LOCK_CHANGED/);
}));

test('an existing dependency directory never bypasses lock validation',()=>fixture(async root=>{
  await legacy(root);
  const changed=lock('0.1.0-rc.2');changed.packages['node_modules/solc'].integrity='sha512-tampered';
  await put(root,path.join(LEGACY_RELEASE_DIRECTORY,'package-lock.json'),encode(changed));
  await assert.rejects(()=>legacy(root),/REVIEW_DEPENDENCY_LOCK_CHANGED/);
}));

test('dependency hydration rejects unrecognized release paths and symbolic-link destinations',()=>fixture(async root=>{
  for(const releaseDirectory of ['releases/rc1','../rc2','releases/rc2/','/releases/rc2'])
    await assert.rejects(()=>ensureReleaseDependencies({root,releaseDirectory}),/REVIEW_RELEASE_DIRECTORY_INVALID/);
  await fs.symlink(path.join(root,'node_modules'),path.join(root,LEGACY_RELEASE_DIRECTORY,'node_modules'));
  await assert.rejects(()=>legacy(root),/REVIEW_DEPENDENCY_DIRECTORY_INVALID/);
}));

test('dependency hydration rejects a linked lock file or linked root dependency directory',async()=>{
  await fixture(async root=>{
    const file=path.join(root,LEGACY_RELEASE_DIRECTORY,'package-lock.json');await fs.rename(file,file+'.regular');await fs.symlink(file+'.regular',file);
    await assert.rejects(()=>legacy(root),/REVIEW_DEPENDENCY_LOCK_INVALID/);
  });
  await fixture(async root=>{
    const source=path.join(root,'node_modules');await fs.rename(source,source+'-regular');await fs.symlink(source+'-regular',source);
    await assert.rejects(()=>legacy(root),/REVIEW_RUN_NPM_CI_FIRST/);
  });
});

test('concurrent dependency preparation preserves one regular destination and removes temporary copies',()=>fixture(async root=>{
  const results=await Promise.all([legacy(root),legacy(root)]);assert.equal(results[0],results[1]);
  const entries=await fs.readdir(path.join(root,LEGACY_RELEASE_DIRECTORY));assert.equal(entries.some(name=>name.startsWith('.lincoln-deps-')),false);
  assert.equal(await fs.realpath(path.join(results[0],'node_modules')),path.join(results[0],'node_modules'));
}));

test('real archived operations plan self-prepares missing RC.2 dependencies in an isolated public checkout',{timeout:120000},async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-legacy-fresh-checkout-')));
  try{
    await fs.mkdir(path.join(root,'releases'),{recursive:true});
    await fs.cp(path.join(ROOT,LEGACY_RELEASE_DIRECTORY),path.join(root,LEGACY_RELEASE_DIRECTORY),{
      recursive:true,mode:constants.COPYFILE_FICLONE,
      filter:file=>!path.relative(path.join(ROOT,LEGACY_RELEASE_DIRECTORY),file).split(path.sep).some(part=>part==='node_modules'||part.startsWith('.lincoln-deps-')),
    });
    const release=JSON.parse(await fs.readFile(path.join(root,LEGACY_RELEASE_DIRECTORY,'artifacts/phase2-mainnet/release-candidate-20261016-r2.json')));
    // Only the exact compiler-source dependency closure read by checkCore is
    // required in this fixture; JavaScript imports resolve from this test's
    // actual locked installation. No full cached release node_modules exists.
    for(const ref of release.files.filter(ref=>ref.path.startsWith('node_modules/')))
      await put(root,ref.path,await fs.readFile(path.join(ROOT,ref.path)));
    for(const relative of ['package-lock.json','config/mainnet-operations.json'])
      await put(root,relative,await fs.readFile(path.join(ROOT,relative)));
    const currentMarker=path.join(RELEASE_DIRECTORY,'protocol/phase2-mainnet/contracts/Phase2ASPPool.sol');
    const currentBytes=await fs.readFile(path.join(ROOT,currentMarker));await put(root,currentMarker,currentBytes);
    const historicalLock=await fs.readFile(path.join(root,LEGACY_RELEASE_DIRECTORY,'package-lock.json'));
    await assert.rejects(fs.access(path.join(root,LEGACY_RELEASE_DIRECTORY,'node_modules')),{code:'ENOENT'});
    const plan=await mainnetOperationsPlan({root});
    assert.equal(plan.offline,true);assert.equal(plan.transactionsBroadcast,0);assert.equal(plan.transactionsSigned,0);assert.equal(plan.keysAccessed,false);
    assert.equal(plan.candidate.tag,'v0.1.0-rc.2');assert.equal(plan.frozenConfigurationUnchanged,true);
    assert.equal(plan.filesWritten,0);assert.equal(plan.filesWrittenScope,'operator-configuration-and-state');
    assert.equal(plan.dependencyPreparationWrites,'ignored-node-modules-only');
    for(const ref of release.files.filter(ref=>ref.path.startsWith('node_modules/'))){
      const file=path.join(root,LEGACY_RELEASE_DIRECTORY,ref.path);
      assert.equal((await fs.lstat(file)).isFile(),true);assert.equal(await fs.realpath(file),file);
      assert.deepEqual(await fs.readFile(file),await fs.readFile(path.join(ROOT,ref.path)));
    }
    assert.deepEqual(await fs.readFile(path.join(root,LEGACY_RELEASE_DIRECTORY,'package-lock.json')),historicalLock);
    assert.deepEqual(await fs.readFile(path.join(root,currentMarker)),currentBytes);
    await assert.rejects(fs.access(path.join(root,'.phase1-private')),{code:'ENOENT'});
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
