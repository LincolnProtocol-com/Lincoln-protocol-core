#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Never overwrite historical acceptance reports or use a supplied RPC/wallet.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkCore} from './check.mjs';
const ROOT=await fs.realpath(fileURLToPath(new URL('../../',import.meta.url)));
const mode=process.argv[2]??'all';
if(process.argv.length>3||!['all','native','fees'].includes(mode))throw new Error('USAGE_CORE_ACCEPTANCE_ALL_NATIVE_FEES');
await checkCore();
// macOS /var aliases /private/var: canonicalize so preserved upstream CLI guards execute.
const work=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-core-acceptance-')));
try{
  // Copy only the reviewed public inventory, never ignored operator wallets or .env files.
  const inventory=JSON.parse(await fs.readFile(path.join(ROOT,'audit/upstream-files.json')));
  for(const {path:relative}of inventory.files){
    const target=path.join(work,relative);await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(path.join(ROOT,relative),target);
  }
  await fs.mkdir(path.join(work,'audit'));
  await fs.copyFile(path.join(ROOT,'audit/upstream-files.json'),path.join(work,'audit/upstream-files.json'));
  // Dependencies must be regular files too: production checks reject symlinked trees.
  await fs.cp(path.join(ROOT,'node_modules'),path.join(work,'node_modules'),{recursive:true});
  await checkCore({root:work});
  const selected=mode==='all'?['native','fees']:[mode];
  for(const name of selected){
    const script=name==='native'?'verify-final-parameters.mjs':'verify-fee-parameters.mjs';
    const relative=`artifacts/phase2-mainnet/final-${name==='native'?'':'fee-'}parameter-acceptance.json`;
    const historical=await fs.readFile(path.join(ROOT,relative));
    // A successful no-op process must never reuse a historical passed report.
    await fs.unlink(path.join(work,relative));
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(work,'scripts/phase2-mainnet',script),'--verify'],{
        cwd:work,stdio:'inherit',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:work,LANG:'C',NO_COLOR:'1'},
      });
      child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('CORE_ACCEPTANCE_FAILED: '+name+' '+(signal??code))));
    });
    const bytes=await fs.readFile(path.join(work,relative)),report=JSON.parse(bytes);
    const expected=name==='native'?{checks:36,proofs:11,transactions:43}:{checks:22,proofs:4,transactions:73};
    if(report.passed!==true||report.localOnly!==true||report.publicTransactions!==0||bytes.equals(historical)
      ||typeof report.runId!=='string'||report.runId===JSON.parse(historical).runId
      ||Object.entries(expected).some(([key,count])=>report[key]?.length!==count)
      ||!report.checks.every(check=>check.passed===true))throw new Error('CORE_ACCEPTANCE_REPORT_INVALID');
    const output=path.join(ROOT,'audit/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${name}.json`);
    await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes,{flag:'wx'});
    console.log(JSON.stringify({passed:true,mode:name,report:path.relative(ROOT,output),localOnly:true,publicTransactions:0}));
  }
}finally{await fs.rm(work,{recursive:true,force:true});}
await checkCore();
