#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A real, byte-exact public review tree derived from the immutable RC.2 capsule.
// No compilation, source rewriting, signing, network or production configuration.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const RC2_BASE_COMMIT='abe000c7acd9c26931a17961e1b4bdda083df84e';
export const RC2_RELEASE_DIRECTORY='releases/rc2';
export const RC2_RELEASE_MANIFEST='artifacts/phase2-mainnet/release-candidate-20261016-r2.json';
export const RC2_RELEASE_SHA256='abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3';
export const REVIEW_MANIFEST='review-manifest.json';
export const REVIEW_MANAGED_DIRECTORIES=Object.freeze(['contracts','zk','abi','test/contracts','test/evidence/rc2']);
const CORE_ARTIFACT='artifacts/phase2-mainnet/contracts.json',FEE_ARTIFACT='artifacts/phase2-fees-mainnet/contracts.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const json=value=>JSON.stringify(stable(value),null,2)+'\n';
const order=(a,b)=>a<b?-1:a>b?1:0;
const circuitNames=['joinsplit','holder-exit'];

const mapping=(sourcePath,reviewPath,kind,extra={})=>Object.freeze({sourcePath,reviewPath,kind,...extra});
const contract=(sourcePath,reviewPath,contractNames,extra={})=>mapping(sourcePath,reviewPath,'solidity-source',
  {contractNames:Object.freeze(contractNames),virtualCompilerSourcePath:sourcePath,...extra});
const ABI_NAMES=Object.freeze([
  ['Phase2ASPPool','PrivacyPool','phase2-mainnet','contracts/PrivacyPool.sol'],
  ['Phase2ASPRegistry','AssociationSetRegistry','phase2-mainnet','contracts/AssociationSetRegistry.sol'],
  ['Phase2RouteAdapter','V3RouteAdapter','phase2-mainnet','contracts/adapters/V3RouteAdapter.sol'],
  ['Phase2Router02Adapter','Router02Adapter','phase2-mainnet','contracts/adapters/Router02Adapter.sol'],
  ['Phase2ASPJoinSplitVerifier','JoinSplitVerifier','phase2-mainnet','contracts/verifiers/JoinSplitVerifier.sol'],
  ['Phase2ASPExitVerifier','HolderExitVerifier','phase2-mainnet','contracts/verifiers/HolderExitVerifier.sol'],
  ['PoseidonT3','PoseidonT3','phase2-mainnet','contracts/libraries/PoseidonT3.sol'],
  ['PoseidonT4','PoseidonT4','phase2-mainnet','contracts/libraries/PoseidonT4.sol'],
  ['Phase2FeeRouteAdapter','FeeV3RouteAdapter','phase2-fees-mainnet','contracts/adapters/FeeAdapters.sol'],
  ['Phase2FeeRouter02Adapter','FeeRouter02Adapter','phase2-fees-mainnet','contracts/adapters/FeeAdapters.sol'],
].map(Object.freeze));
const ozSources=[
  'token/ERC20/IERC20.sol','token/ERC20/extensions/IERC20Permit.sol','token/ERC20/utils/SafeERC20.sol',
  'utils/Address.sol','utils/ReentrancyGuard.sol',
];

export const REVIEW_MAPPINGS=Object.freeze([
  contract('protocol/phase2-mainnet/contracts/Phase2ASPPool.sol','contracts/PrivacyPool.sol',['Phase2ASPPool']),
  contract('protocol/phase2-mainnet/contracts/Phase2ASPRegistry.sol','contracts/AssociationSetRegistry.sol',['Phase2ASPRegistry']),
  contract('protocol/phase2-mainnet/contracts/Phase2RouteAdapter.sol','contracts/adapters/V3RouteAdapter.sol',['Phase2RouteAdapter']),
  contract('protocol/phase2-mainnet/contracts/Phase2Router02Adapter.sol','contracts/adapters/Router02Adapter.sol',['Phase2Router02Adapter']),
  contract('protocol/phase2-fees/mainnet/Phase2FeeRouteAdapter.sol','contracts/adapters/FeeAdapters.sol',['Phase2FeeRouteAdapter','Phase2FeeRouter02Adapter']),
  contract('protocol/phase2-mainnet/generated/Phase2ASPJoinSplitVerifier.sol','contracts/verifiers/JoinSplitVerifier.sol',['Phase2ASPJoinSplitVerifier']),
  contract('protocol/phase2-mainnet/generated/Phase2ASPExitVerifier.sol','contracts/verifiers/HolderExitVerifier.sol',['Phase2ASPExitVerifier']),
  ...['PoseidonT3','PoseidonT4'].map(name=>contract(`vendor/solidity/poseidon-solidity/${name}.sol`,`contracts/libraries/${name}.sol`,[name],
    {virtualCompilerSourcePath:`poseidon-solidity/${name}.sol`,frozenReferencePath:`node_modules/poseidon-solidity/${name}.sol`})),
  ...ozSources.map(name=>mapping(`vendor/solidity/@openzeppelin/contracts/${name}`,`contracts/vendor/openzeppelin/${name}`,'solidity-dependency',
    {virtualCompilerSourcePath:`@openzeppelin/contracts/${name}`,frozenReferencePath:`node_modules/@openzeppelin/contracts/${name}`})),
  mapping('vendor/solidity/@openzeppelin/contracts/package.json','contracts/vendor/openzeppelin/package.json','dependency-metadata',
    {frozenReferencePath:'node_modules/@openzeppelin/contracts/package.json'}),
  mapping('vendor/solidity/poseidon-solidity/package.json','contracts/vendor/poseidon-solidity/package.json','dependency-metadata',
    {frozenReferencePath:'node_modules/poseidon-solidity/package.json'}),
  ...['joinsplit/main.circom','joinsplit/joinsplit.circom','holder-exit/main.circom'].map(name=>
    mapping(`protocol/phase2-asp/circuits/${name}`,`zk/circuits/${name}`,'circuit-source',
      {virtualCompilerSourcePath:`protocol/phase2-asp/circuits/${name}`})),
  ...circuitNames.flatMap(name=>['final.zkey','main.r1cs','main_js/main.wasm','verification_key.json','manifest.json','ceremony-transcript.json'].map(file=>
    mapping(`protocol/phase2-mainnet/build/${name}/${file}`,`zk/parameters/${name}/${file}`,'public-proving-material',{circuit:name}))),
  mapping('vendor/nocturne-protocol/packages/circuits/data/powersOfTau28_hez_final_15.ptau',
    'zk/parameters/powersOfTau28_hez_final_15.ptau','public-phase-one-transcript'),
  ...['beacon-commitment.json','beacon-commitment.applied.json','beacon-commitment.observation.json','beacon-commitment.publication.json'].map(file=>
    mapping(`artifacts/phase2-ceremony/${file}`,`zk/ceremony/${file}`,'public-beacon-evidence')),
  ...circuitNames.map(name=>mapping(`artifacts/phase2-ceremony/contributions/leo-independent-20261016/${name}.zkey`,
    `zk/ceremony/parents/${name}.zkey`,'public-pre-beacon-parent-key',{circuit:name})),
  ...ABI_NAMES.map(([name,friendly,group])=>mapping(`abi/${group}/${name}.json`,`abi/${friendly}.json`,'contract-abi',{contractNames:Object.freeze([name])})),
  ...['Base.sol','Pool.t.sol','Caps.t.sol','Registry.t.sol','Adapter.t.sol','FeeAdapter.t.sol','Invariant.t.sol'].map(file=>
    mapping(`protocol/phase2-mainnet/fuzz/test/${file}`,`test/contracts/${file}`,'foundry-test')),
  mapping('artifacts/phase2-mainnet/final-parameter-acceptance.json','test/evidence/rc2/native.json','real-proof-acceptance'),
  mapping('artifacts/phase2-mainnet/final-fee-parameter-acceptance.json','test/evidence/rc2/fees.json','real-proof-acceptance'),
  mapping('audit/acceptance/standalone-20261016-r2/foundry.json','test/evidence/rc2/foundry.json','mock-verifier-foundry-acceptance'),
]);

function relative(value){
  need(typeof value==='string'&&!path.isAbsolute(value)&&!value.includes('\\')
    &&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.')),'REVIEW_PUBLIC_PATH_REQUIRED');return value;
}
async function regular(root,value,{missing=false}={}){
  const filename=path.join(root,relative(value));let stat;
  try{stat=await fs.lstat(filename);}catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(filename)===filename,'REVIEW_REGULAR_FILE_REQUIRED');
  return fs.readFile(filename);
}
async function capsuleDirectory(root){
  const directory=path.join(root,RC2_RELEASE_DIRECTORY),stat=await fs.lstat(directory);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(directory)===directory,'REVIEW_CAPSULE_DIRECTORY_INVALID');return directory;
}
async function managedFiles(root,directory){
  relative(directory);const filename=path.join(root,directory);let stat;
  try{stat=await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(filename)===filename,'REVIEW_DIRECTORY_INVALID');
  const files=[];
  for(const entry of await fs.readdir(filename,{withFileTypes:true})){
    const name=directory+'/'+entry.name;
    need(!entry.isSymbolicLink(),'REVIEW_SYMLINK_REJECTED');
    if(entry.isDirectory())files.push(...await managedFiles(root,name));
    else{need(entry.isFile(),'REVIEW_REGULAR_FILE_REQUIRED');files.push(name);}
  }
  return files;
}
async function writeNewOrEmpty(root,value,bytes){
  let directory=root;
  for(const part of value.split('/').slice(0,-1)){
    directory=path.join(directory,part);let stat;
    try{stat=await fs.lstat(directory);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(directory,{mode:0o755});stat=await fs.lstat(directory);}
    need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(directory)===directory,'REVIEW_DIRECTORY_INVALID');
  }
  const existing=await regular(root,value,{missing:true});
  need(existing===null||existing.length===0||existing.equals(bytes),'REVIEW_EXISTING_FILE_DIFFERS');
  if(existing?.equals(bytes))return;
  const filename=path.join(root,value),temporary=filename+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o644});await fs.rename(temporary,filename);}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

async function prepareLayout(root){
  const capsule=await capsuleDirectory(root),releaseBytes=await regular(capsule,RC2_RELEASE_MANIFEST);
  need(sha(releaseBytes)===RC2_RELEASE_SHA256,'REVIEW_RC2_RELEASE_CHANGED');
  const release=JSON.parse(releaseBytes);
  need(release.schema==='phase2-mainnet-contract-candidate/v1'&&release.chainId===4663&&release.releaseCandidate===true
    &&release.productionReady===false&&Array.isArray(release.files),'REVIEW_RC2_RELEASE_INVALID');
  const references=new Map();
  for(const ref of release.files){
    relative(ref.path);need(!references.has(ref.path)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&/^[a-f0-9]{64}$/.test(ref.sha256),'REVIEW_RC2_REFERENCE_INVALID');
    references.set(ref.path,ref);
  }
  async function pinned(sourcePath,referencePath=sourcePath){
    const ref=references.get(referencePath);need(ref,'REVIEW_SOURCE_NOT_FROZEN');
    const bytes=await regular(capsule,sourcePath);
    need(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'REVIEW_CAPSULE_SOURCE_CHANGED');return bytes;
  }
  // Circuit source references are inside their individually pinned manifests,
  // not independent mutable declarations in the new review tree.
  for(const name of circuitNames){
    const manifest=JSON.parse(await pinned(`protocol/phase2-mainnet/build/${name}/manifest.json`));
    need(manifest.schema==='phase2-asp-production-circuits/v1'&&manifest.inputs?.circuit===name&&Array.isArray(manifest.inputs.sources),'REVIEW_CIRCUIT_MANIFEST_INVALID');
    for(const ref of manifest.inputs.sources){
      relative(ref.path);need(ref.path.startsWith('protocol/phase2-asp/circuits/')&&/^[a-f0-9]{64}$/.test(ref.sha256)
        &&Number.isSafeInteger(ref.bytes)&&ref.bytes>0,'REVIEW_CIRCUIT_SOURCE_REFERENCE_INVALID');
      const previous=references.get(ref.path);need(previous===undefined||previous.bytes===ref.bytes&&previous.sha256===ref.sha256,'REVIEW_CIRCUIT_SOURCE_REFERENCE_INVALID');
      references.set(ref.path,ref);
    }
  }
  const catalog=JSON.parse(await pinned('abi/manifest.json'));
  need(catalog.schema==='lincoln-core-abi-catalog/v1'&&catalog.chainId===4663&&Array.isArray(catalog.contracts)&&catalog.contracts.length===10,'REVIEW_FROZEN_ABI_CATALOG_INVALID');
  const artifacts={};for(const artifactPath of [CORE_ARTIFACT,FEE_ARTIFACT])artifacts[artifactPath]=JSON.parse(await pinned(artifactPath));
  const files=new Map(),entries=[],seenSource=new Set();
  for(const item of REVIEW_MAPPINGS){
    relative(item.sourcePath);relative(item.reviewPath);
    need(!item.sourcePath.startsWith('releases/')&&!files.has(item.reviewPath)&&!seenSource.has(item.sourcePath),'REVIEW_MAPPING_INVALID');seenSource.add(item.sourcePath);
    need(REVIEW_MANAGED_DIRECTORIES.some(directory=>item.reviewPath.startsWith(directory+'/'))
      &&!item.reviewPath.split('/').some(part=>/^phase[0-9]/i.test(part)),'REVIEW_MAPPING_INVALID');
    const bytes=await pinned(item.sourcePath,item.frozenReferencePath??item.sourcePath);
    files.set(item.reviewPath,bytes);entries.push({...item,bytes:bytes.length,sha256:sha(bytes)});
  }
  const abiEntries=ABI_NAMES.map(([name,friendly,group,sourceReviewPath])=>{
    const frozenABIPath=`abi/${group}/${name}.json`,entry=catalog.contracts.find(item=>item.group===group&&item.contract===name);
    const artifactPath=group==='phase2-mainnet'?CORE_ARTIFACT:FEE_ARTIFACT,artifact=artifacts[artifactPath];
    need(entry?.path===frozenABIPath&&entry.source?.path===artifactPath&&entry.source.artifactKey===name
      &&entry.source.sha256===references.get(artifactPath).sha256&&entry.abiSHA256===references.get(frozenABIPath).sha256,'REVIEW_FROZEN_ABI_ENTRY_INVALID');
    const abiPath=`abi/${friendly}.json`;
    need(isDeepStrictEqual(JSON.parse(files.get(abiPath)),artifact[name]?.abi),'REVIEW_ABI_ARTIFACT_MISMATCH');
    return {contractName:name,abiPath,frozenABIPath,abiSHA256:sha(files.get(abiPath)),sourceReviewPath,chainId:4663,
      productionArtifact:{path:artifactPath,sha256:references.get(artifactPath).sha256}};
  }).sort((a,b)=>order(a.abiPath,b.abiPath));
  const reviewCatalog={schema:'lincoln-review-abi-catalog/v1',chainId:4663,releaseDirectory:RC2_RELEASE_DIRECTORY,
    baseCommit:RC2_BASE_COMMIT,releaseManifest:RC2_RELEASE_MANIFEST,releaseSHA256:RC2_RELEASE_SHA256,
    entries:abiEntries,scope:'Byte-identical RC.2 ABIs with review paths; no deployment addresses or new compiler outputs.'};
  const catalogBytes=Buffer.from(json(reviewCatalog));files.set('abi/manifest.json',catalogBytes);
  const manifest={schema:'lincoln-core-review-layout/v1',baseCommit:RC2_BASE_COMMIT,releaseDirectory:RC2_RELEASE_DIRECTORY,
    releaseManifest:RC2_RELEASE_MANIFEST,releaseSHA256:RC2_RELEASE_SHA256,
    sourceAuthority:'Immutable RC.2 capsule; review copies are generated and must not be edited independently.',
    sourcePathsRelativeTo:'releaseDirectory',reviewPathsRelativeTo:'repository root',
    files:entries.sort((a,b)=>order(a.reviewPath,b.reviewPath)),
    generatedFiles:[{sourcePath:'abi/manifest.json',sourceSHA256:references.get('abi/manifest.json').sha256,
      reviewPath:'abi/manifest.json',kind:'friendly-review-abi-catalog',bytes:catalogBytes.length,sha256:sha(catalogBytes)}],
    invariants:['Mapped Solidity, Circom, ABI, parameter, ceremony and evidence bytes are unchanged from the pinned RC.2 release.',
      'Contract identifiers and virtual compiler source paths are retained; friendly filenames do not rename deployed types.',
      'The review tree is not a replacement compiler root; the immutable capsule preserves reproducible source/import paths.',
      'No new bytecode, proving key, contribution ceremony, deployment, audit result or mainnet authorization is created.']};
  files.set(REVIEW_MANIFEST,Buffer.from(json(manifest)));return {capsule,files,manifest};
}

/** No target is changed if any nonempty target differs or a managed directory
 * contains an unlisted file. README.md is the only optional extra in these trees.
 */
export async function syncReviewLayout({root=ROOT,checkOnly=false}={}){
  need(typeof root==='string'&&typeof checkOnly==='boolean','REVIEW_LAYOUT_OPTIONS_INVALID');root=await fs.realpath(root);
  const {capsule,files,manifest}=await prepareLayout(root),known=new Set(files.keys());
  for(const directory of REVIEW_MANAGED_DIRECTORIES)for(const filename of await managedFiles(root,directory))
    need(known.has(filename)||path.basename(filename)==='README.md','REVIEW_UNEXPECTED_FILE');
  const missing=[];
  for(const [filename,bytes]of files){
    const existing=await regular(root,filename,{missing:true});
    if(existing===null||existing.length===0){missing.push(filename);continue;}
    need(existing.equals(bytes),'REVIEW_EXISTING_FILE_DIFFERS');
  }
  need(!checkOnly||missing.length===0,'REVIEW_LAYOUT_INCOMPLETE');
  // Revalidate source identity before touching output, including files referenced
  // by a pinned circuit manifest rather than by the top-level inventory itself.
  for(const item of manifest.files){const bytes=await regular(capsule,item.sourcePath);need(bytes.length===item.bytes&&sha(bytes)===item.sha256,'REVIEW_CAPSULE_SOURCE_CHANGED');}
  if(!checkOnly)for(const filename of missing)await writeNewOrEmpty(root,filename,files.get(filename));
  return {passed:true,checkOnly,baseCommit:RC2_BASE_COMMIT,releaseSHA256:RC2_RELEASE_SHA256,
    copiedFiles:manifest.files.length,generatedFiles:manifest.generatedFiles.length,changedFiles:missing.length,
    manifest:REVIEW_MANIFEST,manifestSHA256:sha(files.get(REVIEW_MANIFEST)),contracts:10,
    sourceBytes:manifest.files.reduce((sum,item)=>sum+item.bytes,0),networkRequests:0,publicTransactions:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--check','USAGE_REVIEW_LAYOUT_CHECK');
    console.log(JSON.stringify(await syncReviewLayout({checkOnly:process.argv[2]==='--check'}),null,2));
  }catch(error){console.error(error.code??'REVIEW_LAYOUT_FAILED');process.exitCode=1;}
}
