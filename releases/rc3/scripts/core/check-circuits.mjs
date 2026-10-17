#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Recompile computation only; never initializes or replaces a Groth16 key.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {checkCore} from './check.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const run=promisify(execFile);
async function files(directory){
  const result=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    need(!entry.isSymbolicLink(),'CIRCUIT_SOURCE_SYMLINK_REJECTED');const file=path.join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(file));else if(entry.isFile()&&entry.name.endsWith('.circom'))result.push(file);
  }
  return result.sort();
}
let temporary;
try{
  need(process.argv.length===2,'USAGE_CORE_CHECK_CIRCUITS');await checkCore();
  const compilerDirectory=path.join(ROOT,'node_modules/circom2'),pkg=JSON.parse(await fs.readFile(path.join(compilerDirectory,'package.json')));
  need(pkg.version==='0.2.22','CIRCUIT_COMPILER_VERSION_MISMATCH');
  const compiler=path.join(compilerDirectory,typeof pkg.bin==='string'?pkg.bin:pkg.bin?.circom2);
  const compilerHash=sha(await fs.readFile(compiler)),wasmHash=sha(await fs.readFile(path.join(compilerDirectory,'circom.wasm')));
  const version=(await run(process.execPath,[compiler,'--version'],{cwd:ROOT,timeout:30000})).stdout.trim();
  const libraryDirectory=path.join(ROOT,'node_modules/circomlib/circuits');
  const library=[];
  for(const file of await files(libraryDirectory)){
    const bytes=await fs.readFile(file);
    // Preserve the original path prefix used to hash the library source inventory.
    library.push({path:'scripts/private-transfer/deps/node_modules/circomlib/circuits/'+path.relative(libraryDirectory,file).split(path.sep).join('/'),bytes:bytes.length,sha256:sha(bytes)});
  }
  const libraryHash=sha(JSON.stringify(library));
  const legacyLockHash=sha(await fs.readFile(path.join(ROOT,'scripts/private-transfer/deps/package-lock.json')));
  temporary=await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-core-circuits-'));
  for(const name of ['joinsplit','holder-exit']){
    const manifest=JSON.parse(await fs.readFile(path.join(ROOT,`protocol/phase2-mainnet/build/${name}/manifest.json`)));
    const inputs=manifest.inputs;
    need(inputs.compilerEntrypointSHA256===compilerHash&&inputs.compilerWasmSHA256===wasmHash&&inputs.compilerVersion===version,'CIRCUIT_COMPILER_BYTES_MISMATCH');
    need(inputs.circomlibSourceSetSHA256===libraryHash&&inputs.dependencyLockSHA256===legacyLockHash,'CIRCUIT_TOOL_INPUT_MISMATCH');
    const output=path.join(temporary,name);await fs.mkdir(output);
    await run(process.execPath,[compiler,path.join(ROOT,`protocol/phase2-asp/circuits/${name}/main.circom`),
      '--r1cs','--wasm','--sym','--O2','-l',path.join(ROOT,'node_modules'),'-o',output],{cwd:ROOT,timeout:180000,maxBuffer:4*1024*1024});
    for(const [kind,filename]of [['r1cs','main.r1cs'],['wasm','main_js/main.wasm']]){
      const actual=await fs.readFile(path.join(output,filename));
      need(sha(actual)===manifest.artifacts[kind].sha256,'CIRCUIT_RECOMPILE_MISMATCH: '+name+' '+kind);
    }
    console.log(JSON.stringify({passed:true,circuit:name,r1csSHA256:manifest.artifacts.r1cs.sha256,
      wasmSHA256:manifest.artifacts.wasm.sha256,compilerVersion:version,provingKeysWritten:false,publicTransactions:0}));
  }
}catch(error){console.error(error.code??error.message);process.exitCode=1;}
finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true});}
