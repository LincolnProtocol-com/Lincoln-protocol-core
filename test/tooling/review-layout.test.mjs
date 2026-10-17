import {describe,test,before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {syncReviewLayout,REVIEW_MAPPINGS,CURRENT_RELEASE_DIRECTORY,CURRENT_RELEASE_MANIFEST,CURRENT_RELEASE_SHA256} from '../../scripts/review/layout.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const poolMapping=REVIEW_MAPPINGS.find(item=>item.reviewPath==='contracts/PrivacyPool.sol');

describe('review layout integrity in one isolated public-file fixture',{concurrency:false},()=>{
  let root,capsule,source,view,sourceBytes,viewManifestBytes,releaseManifestBytes;
  const run=options=>syncReviewLayout({root,...options});
  before(async()=>{
    root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-review-layout-test-')));
    capsule=path.join(root,CURRENT_RELEASE_DIRECTORY);
    // Minimal pinned closure only: no node_modules, operator files, or complete
    // capsule copy. COPYFILE_FICLONE is best effort and still makes regular,
    // independent files; mutations below cannot alter the source repository.
    const inputs=new Set([...REVIEW_MAPPINGS.map(item=>item.sourcePath),CURRENT_RELEASE_MANIFEST,'abi/manifest.json',
      'artifacts/phase2-mainnet/contracts.json','artifacts/phase2-fees-mainnet/contracts.json']);
    for(const relative of inputs){
      const target=path.join(capsule,relative);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(ROOT,CURRENT_RELEASE_DIRECTORY,relative),target,constants.COPYFILE_FICLONE);
    }
    const generated=await run();assert.equal(generated.copiedFiles,59);assert.equal(generated.changedFiles,61);
    source=path.join(capsule,poolMapping.sourcePath);view=path.join(root,poolMapping.reviewPath);
    sourceBytes=await fs.readFile(source);viewManifestBytes=await fs.readFile(path.join(root,'review-manifest.json'));
    releaseManifestBytes=await fs.readFile(path.join(capsule,CURRENT_RELEASE_MANIFEST));
  });
  afterEach(async()=>{assert.equal((await run({checkOnly:true})).passed,true);});
  after(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});

  test('generated sources are real files, ten friendly ABIs bind RC.3, and checking is deterministic',async()=>{
    const first=await run({checkOnly:true}),second=await run({checkOnly:true});
    assert.equal(first.changedFiles,0);assert.equal(first.manifestSHA256,second.manifestSHA256);assert.equal(first.releaseSHA256,CURRENT_RELEASE_SHA256);
    assert.equal((await fs.lstat(view)).isFile(),true);assert.equal((await fs.lstat(view)).isSymbolicLink(),false);
    const catalog=JSON.parse(await fs.readFile(path.join(root,'abi/manifest.json')));
    assert.equal(catalog.candidateTag,'v0.1.0-rc.3');assert.equal(catalog.releaseDirectory,'releases/rc3');
    assert.equal(catalog.schema,'lincoln-review-abi-catalog/v1');assert.equal(catalog.entries.length,10);
    const entry=catalog.entries.find(item=>item.contractName==='Phase2ASPPool');
    assert.equal(entry.abiPath,'abi/PrivacyPool.json');assert.equal(entry.sourceReviewPath,'contracts/PrivacyPool.sol');
    assert.deepEqual(await fs.readFile(view),sourceBytes);
  });


  test('historical RC.2 evidence is neither managed as current nor overwritten by RC.3 sync',async()=>{
    const historical=path.join(root,'test/evidence/rc2/historical.json'),bytes=Buffer.from('{"historicalRelease":"v0.1.0-rc.2"}\n');
    await fs.mkdir(path.dirname(historical),{recursive:true});
    await fs.writeFile(historical,bytes);
    const current=await run();assert.equal(current.changedFiles,0);
    assert.deepEqual(await fs.readFile(historical),bytes);
    const manifest=JSON.parse(await fs.readFile(path.join(root,'review-manifest.json')));
    assert.equal(manifest.candidateTag,'v0.1.0-rc.3');
    assert.ok(manifest.files.some(item=>item.reviewPath==='test/evidence/rc3/native.json'));
    assert.ok(!manifest.files.some(item=>item.reviewPath.startsWith('test/evidence/rc2/')));
  });

  test('a nonempty edited review source fails without being overwritten or silently repaired',async()=>{
    const edited=Buffer.concat([sourceBytes,Buffer.from('\n// simulated reviewer edit\n')]);
    try{
      await fs.writeFile(view,edited);
      await assert.rejects(()=>run(),/REVIEW_EXISTING_FILE_DIFFERS/);
      assert.deepEqual(await fs.readFile(view),edited);assert.deepEqual(await fs.readFile(source),sourceBytes);
    }finally{await fs.writeFile(view,sourceBytes);}
  });

  test('editing both source and view and updating their review digest cannot bypass the frozen capsule binding',async()=>{
    const edited=Buffer.concat([sourceBytes,Buffer.from('\n// simulated matching tamper\n')]);
    const manifest=JSON.parse(viewManifestBytes),item=manifest.files.find(item=>item.reviewPath===poolMapping.reviewPath);
    item.sha256=sha(edited);item.bytes=edited.length;
    try{
      await fs.writeFile(source,edited);await fs.writeFile(view,edited);
      await fs.writeFile(path.join(root,'review-manifest.json'),JSON.stringify(manifest));
      await assert.rejects(()=>run({checkOnly:true}),/REVIEW_CAPSULE_SOURCE_CHANGED/);
    }finally{
      await fs.writeFile(source,sourceBytes);await fs.writeFile(view,sourceBytes);
      await fs.writeFile(path.join(root,'review-manifest.json'),viewManifestBytes);
    }
  });

  test('rewriting a capsule reference and its advertised release digest cannot change the pinned RC.3 release',async()=>{
    const modified=JSON.parse(releaseManifestBytes);modified.files.find(item=>item.path===poolMapping.sourcePath).sha256='00'.repeat(32);
    const modifiedBytes=Buffer.from(JSON.stringify(modified));
    const advertised=JSON.parse(viewManifestBytes);advertised.releaseSHA256=sha(modifiedBytes);
    try{
      await fs.writeFile(path.join(capsule,CURRENT_RELEASE_MANIFEST),modifiedBytes);
      await fs.writeFile(path.join(root,'review-manifest.json'),JSON.stringify(advertised));
      await assert.rejects(()=>run({checkOnly:true}),/REVIEW_CURRENT_RELEASE_CHANGED/);
    }finally{
      await fs.writeFile(path.join(capsule,CURRENT_RELEASE_MANIFEST),releaseManifestBytes);
      await fs.writeFile(path.join(root,'review-manifest.json'),viewManifestBytes);
    }
  });

  test('an unlisted Solidity file is rejected instead of escaping the review manifest',async()=>{
    const rogue=path.join(root,'contracts/Unreviewed.sol');
    try{await fs.writeFile(rogue,'contract Unreviewed {}\n');await assert.rejects(()=>run({checkOnly:true}),/REVIEW_UNEXPECTED_FILE/);}
    finally{await fs.unlink(rogue);}
  });

  test('missing mapped files fail checks and only an explicit sync recreates the exact bytes',async()=>{
    try{
      await fs.unlink(view);await assert.rejects(()=>run({checkOnly:true}),/REVIEW_LAYOUT_INCOMPLETE/);
      assert.equal((await run()).changedFiles,1);assert.deepEqual(await fs.readFile(view),sourceBytes);
    }finally{await fs.writeFile(view,sourceBytes);}
  });

  test('an allowed README filename does not exempt symbolic links from validation',async()=>{
    const readme=path.join(root,'contracts/README.md');
    try{
      await fs.symlink(source,readme);await assert.rejects(()=>run({checkOnly:true}),/REVIEW_SYMLINK_REJECTED/);
      await fs.unlink(readme);await fs.writeFile(readme,'Optional review documentation.\n');
      assert.equal((await run({checkOnly:true})).passed,true);
    }finally{await fs.unlink(readme).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  });

  test('changing the generated review-manifest schema cannot be accepted as a new authority',async()=>{
    const changed=JSON.parse(viewManifestBytes);changed.schema='untrusted-schema';
    try{
      await fs.writeFile(path.join(root,'review-manifest.json'),JSON.stringify(changed));
      await assert.rejects(()=>run({checkOnly:true}),/REVIEW_EXISTING_FILE_DIFFERS/);
    }finally{await fs.writeFile(path.join(root,'review-manifest.json'),viewManifestBytes);}
  });
});
