#!/usr/bin/env node
// Offline production component preparation. No wallet, RPC or deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadVerifiedMainnetRelease} from '../../src/phase2-mainnet/release.mjs';
import {compileMainnetFeeComponent,feeSHA256,MAINNET_FEE_ARTIFACT,MAINNET_FEE_INPUT,MAINNET_FEE_MANIFEST,MAINNET_FEE_SOURCE,MAINNET_FEE_TYPES} from '../../src/phase2-fees/mainnet-release.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),json=x=>JSON.stringify(x,null,2)+'\n';
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};

export async function buildMainnetFeeRelease({rootDirectory=ROOT,checkOnly=false}={}){
  const root=await fs.realpath(rootDirectory);
  // Verify final Groth16 materials and reproduce the current core bytecode first.
  // Old pre-guardian artifacts or source drift fail before any fee output is written.
  const coreRelease=await loadVerifiedMainnetRelease({root});
  const built=compileMainnetFeeComponent({rootDirectory:root,coreRelease}),meta=built.artifact._meta;
  const files=new Map([[MAINNET_FEE_SOURCE,built.derivedSource],[MAINNET_FEE_ARTIFACT,built.artifactBytes],
    [MAINNET_FEE_INPUT,json(built.portableInput)]]);
  const manifest={schema:'phase2-fees-mainnet-contract-package/v1',releaseCandidate:true,testOnly:false,productionReady:false,deployed:false,allowedChainIds:[4663],
    artifact:{path:MAINNET_FEE_ARTIFACT,sha256:feeSHA256(built.artifactBytes),sourceSetSHA256:meta.sourceSetSHA256},
    standardInput:{path:MAINNET_FEE_INPUT,sha256:feeSHA256(json(built.portableInput))},sourceDerivation:meta.sourceDerivation,coreRelease:meta.coreRelease,
    contracts:Object.fromEntries(MAINNET_FEE_TYPES.map(name=>{const c=built.artifact[name];return [name,{source:c.source,abiSHA256:feeSHA256(json(c.abi)),
      runtimeTemplateSHA256:feeSHA256(c.deployedBytecode),initcodeSHA256:feeSHA256(c.bytecode),runtimeBytes:(c.deployedBytecode.length-2)/2,initcodeBytes:(c.bytecode.length-2)/2,linked:false}];})),limitations:meta.limitations};
  files.set(MAINNET_FEE_MANIFEST,json(manifest));
  for(const [relative,content]of files){const file=path.join(root,relative);
    if(checkOnly)check((await fs.readFile(file)).equals(Buffer.from(content)),'MAINNET_FEE_RELEASE_DRIFT');
    else{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{mode:0o644});}
  }
  return {schema:'phase2-fees-mainnet-build-result/v1',passed:true,checkOnly,chainId:4663,releaseCandidate:true,productionReady:false,
    artifact:MAINNET_FEE_ARTIFACT,artifactSHA256:manifest.artifact.sha256,coreArtifactSHA256:coreRelease.artifactSHA256,
    adapters:MAINNET_FEE_TYPES.length,rpcRequests:0,transactionsBroadcast:0,keysAccessed:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{check(process.argv.length<=3&&(process.argv[2]===undefined||process.argv[2]==='--check'),'USAGE_BUILD_MAINNET_FEES_CHECK');
    console.log(JSON.stringify(await buildMainnetFeeRelease({checkOnly:process.argv[2]==='--check'}),null,2));
  }catch(error){console.error(/^[A-Z][A-Z0-9_]{1,90}$/.test(error.code??error.message)?error.code??error.message:'MAINNET_FEE_BUILD_FAILED');process.exitCode=1;}
}
