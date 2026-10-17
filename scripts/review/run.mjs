#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ROOT,RELEASE_DIRECTORY,LEGACY_RELEASE_DIRECTORY,ensureReleaseDependencies} from './runtime.mjs';
export async function checkPublicReview({root=ROOT}={}){
  root=await fs.realpath(root);const release=await ensureReleaseDependencies({root});
  const {syncReviewLayout}=await import('./layout.mjs');
  const layout=await syncReviewLayout({root,checkOnly:true});
  const {checkCore,checkReviewFiles}=await import(pathToFileURL(path.join(release,'scripts/core/check.mjs')));
  return {passed:true,layout,...await checkCore({root:release}),...await checkReviewFiles({root:release})};
}
const run=(binary,args,cwd,env=process.env)=>new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd,stdio:'inherit',env});
  child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('REVIEW_COMMAND_FAILED: '+(signal??code))));
});
async function nodeTests(directory){
  const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw new Error('REVIEW_TEST_SYMLINK_REJECTED');const file=path.join(directory,entry.name);
    if(entry.isDirectory())result.push(...await nodeTests(file));else if(entry.isFile()&&entry.name.endsWith('.test.mjs'))result.push(file);
  }return result.sort();
}
export async function runReviewCommand(command,{root=ROOT}={}){
  const allowed=['check','build','circuits','abi','node','contracts','contracts-deep','proofs','native','fees','plan'];
  if(!allowed.includes(command))throw new Error('USAGE_REVIEW_COMMAND');
  root=await fs.realpath(root);const checked=await checkPublicReview({root}),release=path.join(root,RELEASE_DIRECTORY);
  if(command==='check'){console.log(JSON.stringify(checked,null,2));return;}
  const legacy={build:'scripts/core/build.mjs',circuits:'scripts/core/check-circuits.mjs',abi:'scripts/core/sync-abi.mjs'};
  if(legacy[command])await run(process.execPath,[path.join(release,legacy[command]),...(command==='abi'?['--check']:[])],release);
  else if(command==='node'){
    await run(process.execPath,['--test',...await nodeTests(path.join(release,'tests'))],release);
    // Root tests also exercise the real archived planning/recovery tools. A
    // fresh checkout has no historical dependency cache to rely on.
    await ensureReleaseDependencies({root,releaseDirectory:LEGACY_RELEASE_DIRECTORY});
    const tests=await nodeTests(path.join(root,'test'));if(tests.length)await run(process.execPath,['--test',...tests],root);
  }else if(command==='contracts'||command==='contracts-deep'){
    await run('forge',['test','--root',path.join(release,'protocol/phase2-mainnet'),...(command==='contracts-deep'?['--match-contract','CapsTest|PoolInvariantTest']:[])],release,command==='contracts-deep'?{...process.env,FOUNDRY_PROFILE:'deep'}:process.env);
  }
  else if(['proofs','native','fees'].includes(command))await run(process.execPath,[path.join(release,'scripts/core/acceptance.mjs'),command==='proofs'?'all':command],release);
  else if(command==='plan')await run(process.execPath,[path.join(root,'scripts/operations/mainnet-rc3.mjs'),'--plan'],root);
  await checkPublicReview({root});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3)throw new Error('USAGE_REVIEW_COMMAND');await runReviewCommand(process.argv[2]);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
