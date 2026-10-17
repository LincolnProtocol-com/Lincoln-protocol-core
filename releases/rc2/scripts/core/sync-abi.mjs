#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline ABI-only export from the two production artifacts. No dependencies,
// source execution, wallets, runtime profiles, network requests or compilation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const MANIFEST='abi/manifest.json';
const CORE='artifacts/phase2-mainnet/contracts.json';
const FEES='artifacts/phase2-fees-mainnet/contracts.json';
const GROUPS=[
  ['phase2-mainnet',CORE,['Phase2ASPExitVerifier','Phase2ASPJoinSplitVerifier','Phase2ASPPool','Phase2ASPRegistry',
    'Phase2RouteAdapter','Phase2Router02Adapter','PoseidonT3','PoseidonT4']],
  ['phase2-fees-mainnet',FEES,['Phase2FeeRouteAdapter','Phase2FeeRouter02Adapter']],
];
const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const json=value=>JSON.stringify(stable(value),null,2)+'\n';
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const name=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

async function regular(root,relative,{missing=false}={}){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')
    &&relative.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.')),'CORE_ABI_PUBLIC_PATH_REQUIRED');
  const filename=path.join(root,relative);
  let stat;try{stat=await fs.lstat(filename);}catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(filename)===filename,'CORE_ABI_REGULAR_FILE_REQUIRED');
  return fs.readFile(filename);
}
function validABI(abi){
  need(Array.isArray(abi)&&abi.length>0,'CORE_ABI_ARRAY_REQUIRED');
  for(const entry of abi){
    need(entry&&typeof entry==='object'&&['constructor','function','event','error','fallback','receive'].includes(entry.type),'CORE_ABI_ENTRY_INVALID');
    if(['function','event','error'].includes(entry.type))need(name(entry.name),'CORE_ABI_ENTRY_NAME_INVALID');
  }
  return abi;
}
function production(meta,schema){
  need(meta?.schema===schema&&meta.releaseCandidate===true&&meta.testOnly===false&&meta.productionReady===false
    &&JSON.stringify(meta.allowedChainIds)==='[4663]'&&digest(meta.sourceSetSHA256)&&digest(meta.inputSHA256)
    &&typeof meta.compiler==='string'&&meta.compiler.startsWith('0.8.28+'),'CORE_ABI_PRODUCTION_BUILD_REQUIRED');
}
function validateArtifacts(core,fees,coreSHA){
  production(core._meta,'phase2-asp-production-build/v1');
  need(core._meta.policyMode==='asp','CORE_ABI_PRODUCTION_BUILD_REQUIRED');
  production(fees._meta,'phase2-fees-production-build/v1');
  need(fees._meta.experimental===false&&fees._meta.deployed===false
    &&JSON.stringify(fees._meta.adapters)===JSON.stringify(GROUPS[1][2]),'CORE_ABI_PRODUCTION_FEE_BUILD_REQUIRED');
  const bound=fees._meta.coreRelease;
  need(bound?.build?.path===CORE&&bound.build.sha256===coreSHA&&bound.sourceSetSHA256===core._meta.sourceSetSHA256,'CORE_ABI_FEE_CORE_BINDING_MISMATCH');
  for(const circuit of ['joinsplit','holder-exit']){
    const c=core._meta.circuits?.[circuit],f=bound.manifests?.[circuit];
    need(c?.manifest===`protocol/phase2-mainnet/build/${circuit}/manifest.json`&&digest(c.manifestSHA256)&&digest(c.zkeySHA256)
      &&c.verifyFromR1cs===true&&c.verificationKeyBound===true&&c.solidityVerifierBound===true&&c.finalBeacon===true
      &&c.transcriptBound===true&&Number.isSafeInteger(c.nonBeaconContributors)&&c.nonBeaconContributors>=2,'CORE_ABI_FINAL_CIRCUIT_BINDING_REQUIRED');
    need(f?.path===c.manifest&&f.sha256===c.manifestSHA256&&f.zkeySHA256===c.zkeySHA256,'CORE_ABI_FEE_CORE_BINDING_MISMATCH');
  }
  for(const [,artifactPath,names]of GROUPS){
    const artifact=artifactPath===CORE?core:fees,actual=Object.keys(artifact).filter(key=>key!=='_meta').sort();
    need(JSON.stringify(actual)===JSON.stringify([...names].sort()),'CORE_ABI_CONTRACT_SET_INVALID');
    for(const contractName of names){
      const contract=artifact[contractName];validABI(contract?.abi);
      need(typeof contract.source==='string'&&typeof contract.bytecode==='string'&&contract.bytecode.startsWith('0x')
        &&typeof contract.deployedBytecode==='string'&&contract.deployedBytecode.startsWith('0x'),'CORE_ABI_CONTRACT_ARTIFACT_INVALID');
    }
  }
}
function buildMetadata(meta,contract){
  const build={};
  for(const key of ['schema','compiler','compilerVersion','optimizerRuns','evmVersion','viaIR','inputSHA256',
    'sourceSetSHA256','compilerInputSHA256','upstreamCommit','protocolPin','monorepoPin','allowedChainIds',
    'experimental','testOnly','releaseCandidate','policyMode','productionReady','deploymentStatus','compilerSettings'])
    if(meta[key]!==undefined)build[key]=meta[key];
  if(meta.schema==='phase2-asp-production-build/v1')build.circuits=meta.circuits;
  if(meta.schema==='phase2-fees-production-build/v1'){
    build.coreRelease=meta.coreRelease;build.sourceDerivation=meta.sourceDerivation;build.feeModel=meta.feeModel;
  }
  for(const key of ['bytecode','deployedBytecode']){
    const value=contract[key];need((value.length-2)%2===0,'CORE_ABI_BYTECODE_TEMPLATE_INVALID');
    build[`${key}TemplateSHA256`]=sha(value);build[`${key}TemplateBytes`]=(value.length-2)/2;
  }
  for(const key of ['linkReferences','deployedLinkReferences','immutableReferences'])if(contract[key]!==undefined)build[key]=contract[key];
  return build;
}
async function output(root,relative,bytes){
  const filename=path.join(root,relative),directory=path.dirname(filename);
  let current=root;
  for(const part of relative.split('/').slice(0,-1)){
    current=path.join(current,part);let stat;
    try{stat=await fs.lstat(current);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(current,{mode:0o755});stat=await fs.lstat(current);}
    need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(current)===current,'CORE_ABI_OUTPUT_DIRECTORY_INVALID');
  }
  need(current===directory,'CORE_ABI_OUTPUT_DIRECTORY_INVALID');
  // Recheck existing targets before rename so symlinks cannot be silently used
  // as ABI inputs or followed by an in-place write.
  await regular(root,relative,{missing:true});
  const temporary=filename+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o644});await fs.rename(temporary,filename);}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Deterministic ten-contract standalone catalog. ABI provenance is not a new
 * mathematical verification of the proving parameters or a deployment claim.
 */
export async function syncABI({root=ROOT,checkOnly=false}={}){
  need(typeof root==='string'&&typeof checkOnly==='boolean','CORE_ABI_OPTIONS_INVALID');root=await fs.realpath(root);
  const inputs=new Map();for(const [,artifactPath]of GROUPS)inputs.set(artifactPath,await regular(root,artifactPath));
  const core=JSON.parse(inputs.get(CORE)),fees=JSON.parse(inputs.get(FEES));validateArtifacts(core,fees,sha(inputs.get(CORE)));
  const files=new Map(),contracts=[],sources=[];
  for(const [group,artifactPath,names]of GROUPS){
    const artifact=artifactPath===CORE?core:fees,source={kind:'project-compiled-artifact',path:artifactPath,sha256:sha(inputs.get(artifactPath))};
    sources.push(source);
    for(const contractName of names){
      const contract=artifact[contractName],relative=`abi/${group}/${contractName}.json`,bytes=json(contract.abi);
      files.set(relative,bytes);contracts.push({group,contract:contractName,path:relative,abiSHA256:sha(bytes),entries:contract.abi.length,
        coverage:'complete-compiled-contract',source:{...source,artifactKey:contractName,sourceName:contract.source},build:buildMetadata(artifact._meta,contract)});
    }
  }
  contracts.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);sources.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest={schema:'lincoln-core-abi-catalog/v1',generator:'scripts/core/sync-abi.mjs',chainId:4663,contracts,sources,
    bytecodeHashEncoding:'SHA256 of the artifact UTF-8 hex/template string, including its 0x prefix when present.',
    deploymentScope:'Compiled build metadata only; no live deployment addresses, runtime state or network calls.',
    limitations:['This standalone catalog contains only the eight production core contracts and two production fee adapters.',
      'Metadata and ABI export do not replace final-parameter verification, bytecode reproduction, independent audit or live deployment verification.',
      'No proving-key bytes, witnesses, wallet backups, credentials, runtime profiles or transaction journals are exported.']};
  files.set(MANIFEST,json(manifest));
  const changed=[];
  for(const [relative,bytes]of files){const old=await regular(root,relative,{missing:true});if(old===null||!old.equals(Buffer.from(bytes)))changed.push(relative);}
  // Refuse a core/fee rebuild racing this read before writing any output.
  for(const [relative,bytes]of inputs)need((await regular(root,relative)).equals(bytes),'CORE_ABI_INPUT_CHANGED_DURING_EXPORT');
  if(checkOnly)need(changed.length===0,'CORE_ABI_CATALOG_DRIFT');
  else for(const relative of changed)await output(root,relative,files.get(relative));
  return {passed:true,checkOnly,contracts:contracts.length,groups:GROUPS.length,files:files.size,changedFiles:changed.length,
    manifest:MANIFEST,manifestSHA256:sha(files.get(MANIFEST)),coreArtifactSHA256:sha(inputs.get(CORE)),feeArtifactSHA256:sha(inputs.get(FEES)),
    networkRequests:0,transactionsBroadcast:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--check','USAGE_CORE_ABI_SYNC_CHECK');
    console.log(JSON.stringify(await syncABI({checkOnly:process.argv[2]==='--check'}),null,2));
  }catch(error){console.error(error.code??'CORE_ABI_SYNC_FAILED');process.exitCode=1;}
}
