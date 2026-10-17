#!/usr/bin/env node
// Candidate artifact generation only. No RPC, wallets, tests, proofs or frozen release writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import solc from 'solc';
import {keccak256} from 'viem';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const SOURCE='contracts/adapters/HedgeFunV4Adapter.candidate.sol';
const CONTRACT='Phase2FeeHedgeFunV4Adapter';
const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const args=process.argv.slice(2);
need(args.length===0||args.length===2&&args[0]==='--output-directory','V4_CANDIDATE_BUILD_ARGUMENTS');
const directory=path.resolve(args[1]??'/private/tmp/lincoln-v4-candidate-build-20261017');
need(directory.startsWith('/private/tmp/')&&!directory.endsWith('/'),'V4_CANDIDATE_BUILD_TMP_ONLY');
need(solc.version().startsWith('0.8.28+'),'V4_CANDIDATE_SOLC_VERSION');
const sources={};
async function readSource(ref){
  need(ref===SOURCE||ref.startsWith('contracts/vendor/openzeppelin/'),'V4_CANDIDATE_IMPORT_DENIED');
  if(Object.hasOwn(sources,ref))return;
  const filename=path.join(ROOT,ref);need(await fs.realpath(filename)===filename,'V4_CANDIDATE_SOURCE_SYMLINK');
  const content=await fs.readFile(filename,'utf8');sources[ref]={content};
  const pattern=/import\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]\s*;/g;
  for(const match of content.matchAll(pattern)){
    need(match[1].startsWith('.'),'V4_CANDIDATE_IMPORT_DENIED');
    await readSource(path.posix.normalize(path.posix.join(path.posix.dirname(ref),match[1])));
  }
}
await readSource(SOURCE);
const settings={optimizer:{enabled:true,runs:10000},viaIR:true,evmVersion:'cancun',
  outputSelection:{'*':{'*':['abi','metadata','evm.bytecode','evm.deployedBytecode'],'':['ast']}}};
const input={language:'Solidity',sources,settings};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
const errors=(output.errors??[]).filter(value=>value.severity==='error');
if(errors.length){console.error(JSON.stringify({error:'V4_CANDIDATE_COMPILATION_FAILED',diagnostics:errors},null,2));process.exitCode=1;}
else{
  const compiled=output.contracts[SOURCE][CONTRACT],creation=compiled.evm.bytecode,runtime=compiled.evm.deployedBytecode;
  need(Object.keys(creation.linkReferences??{}).length===0&&Object.keys(runtime.linkReferences??{}).length===0,'V4_CANDIDATE_UNEXPECTED_LINK_REFERENCES');
  need(/^[0-9a-f]+$/i.test(creation.object)&&/^[0-9a-f]+$/i.test(runtime.object),'V4_CANDIDATE_BYTECODE_INVALID');
  const creationBytes=creation.object.length/2,runtimeBytes=runtime.object.length/2;
  need(runtimeBytes<=24576&&creationBytes<=49152,'V4_CANDIDATE_EVM_SIZE_LIMIT');
  const sourceDigests=Object.fromEntries(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b)).map(([ref,{content}])=>[ref,sha(content)]));
  const build={schema:'lincoln-candidate-contract-build/v1',status:'compiled-untested-unapproved-not-deployed',
    contract:CONTRACT,source:SOURCE,sourceSHA256:sourceDigests[SOURCE],sourceDigests,
    sourceSetSHA256:sha(JSON.stringify(Object.entries(sourceDigests).sort())),compiler:solc.version(),
    settings:{optimizer:settings.optimizer,viaIR:settings.viaIR,evmVersion:settings.evmVersion},
    abi:compiled.abi,metadata:JSON.parse(compiled.metadata),creationBytecode:'0x'+creation.object,
    creationBytecodeSHA256:sha(Buffer.from(creation.object,'hex')),creationBytes,
    runtimeTemplate:'0x'+runtime.object,runtimeTemplateKeccak256:keccak256('0x'+runtime.object),runtimeBytes,
    runtimeCodeHash:null,immutableReferences:runtime.immutableReferences??{},linkReferences:creation.linkReferences??{},
    diagnostics:output.errors??[],compiled:true,tested:false,audited:false,deployed:false,
    constructorArguments:null,deploymentApproval:null,gasBudgetWei:null,
    networkRequests:0,keysAccessed:false,transactionsSigned:0,transactionsBroadcast:0};
  await fs.mkdir(directory,{recursive:true,mode:0o755});
  need(await fs.realpath(directory)===directory,'V4_CANDIDATE_BUILD_OUTPUT_SYMLINK');
  for(const[name,value]of [['candidate-build.json',build],['compiler-input.json',input],['compiler-output.json',output]])
    await fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const abi={schema:'lincoln-candidate-interface/v1',status:build.status,contract:CONTRACT,source:SOURCE,
    sourceSHA256:build.sourceSHA256,abiOrigin:'solc compiler output; not an audited or deployed interface.',
    runtimeCodeHash:null,deploymentApproval:null,abi:compiled.abi};
  await fs.writeFile(path.join(directory,'candidate-abi.json'),JSON.stringify(abi,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({directory,compiler:build.compiler,sourceSHA256:build.sourceSHA256,
    sourceSetSHA256:build.sourceSetSHA256,creationBytes,runtimeBytes,immutableReferenceIds:Object.keys(build.immutableReferences),
    compiled:true,tested:false,deployed:false,transactionsSigned:0},null,2));
}
