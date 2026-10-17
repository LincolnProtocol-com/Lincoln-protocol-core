#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {contractReleaseCandidate} from '../phase2-mainnet/freeze-release.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const RELEASE='artifacts/phase2-mainnet/release-candidate-20261016.json';
export const EXPECTED_UPSTREAM='99e0be62475ac95bb5f8030659c782d5275475a1';
export const EXPECTED_RELEASE_SHA256='b4290759e353e434aaa539fe5b2adcbae456aa56339a28980019d157a0f1ddc8';
const sha=x=>createHash('sha256').update(x).digest('hex');
const need=(ok,code)=>{if(!ok)throw new Error(code);};
async function regular(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(x=>x&&x!=='.'&&x!=='..'),'CORE_PUBLIC_PATH_REQUIRED');
  const file=path.join(root,relative),stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'CORE_REGULAR_FILE_REQUIRED');
  return fs.readFile(file);
}
export async function checkCore({root=ROOT}={}){
  root=await fs.realpath(root);
  const inventory=JSON.parse(await regular(root,'audit/upstream-files.json'));
  need(inventory.schema==='lincoln-core-upstream-extraction/v1'&&inventory.upstreamCommit===EXPECTED_UPSTREAM
    &&inventory.releaseManifest===RELEASE&&inventory.releaseManifestSHA256===EXPECTED_RELEASE_SHA256,'CORE_UPSTREAM_BINDING_INVALID');
  const paths=new Set();
  for(const ref of inventory.files){
    need(!paths.has(ref.path)&&['upstream-git','public-parameter'].includes(ref.origin),'CORE_UPSTREAM_ENTRY_INVALID');paths.add(ref.path);
    const bytes=await regular(root,ref.path);
    need(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'CORE_UPSTREAM_FILE_CHANGED: '+ref.path);
  }
  const releaseBytes=await regular(root,RELEASE);
  need(sha(releaseBytes)===EXPECTED_RELEASE_SHA256,'CORE_RELEASE_MANIFEST_CHANGED');
  const release=JSON.parse(releaseBytes),rebuilt=await contractReleaseCandidate({root});
  need(isDeepStrictEqual(release,rebuilt),'CORE_RELEASE_CONTENT_CHANGED');
  const catalog=JSON.parse(await regular(root,'abi/manifest.json'));
  const entries=catalog.contracts.filter(e=>['phase2-mainnet','phase2-fees-mainnet'].includes(e.group));
  need(entries.length===10,'CORE_ABI_SET_INVALID');
  for(const entry of entries){
    const artifact=JSON.parse(await regular(root,entry.group==='phase2-mainnet'?'artifacts/phase2-mainnet/contracts.json':'artifacts/phase2-fees-mainnet/contracts.json'));
    const abi=JSON.parse(await regular(root,entry.path));
    need(isDeepStrictEqual(abi,artifact[entry.contract].abi),'CORE_ABI_ARTIFACT_MISMATCH');
  }
  return {passed:true,upstreamCommit:EXPECTED_UPSTREAM,releaseManifestSHA256:EXPECTED_RELEASE_SHA256,
    preservedUpstreamFiles:paths.size,frozenFiles:release.files.length,contracts:entries.length,
    chainId:4663,mainnetDeployed:false,publicTransactions:0};
}
export async function checkReviewFiles({root=ROOT}={}){
  root=await fs.realpath(root);
  const release=JSON.parse(await regular(root,RELEASE));
  need(sha(await regular(root,RELEASE))===EXPECTED_RELEASE_SHA256,'CORE_RELEASE_MANIFEST_CHANGED');
  const expected=new Map(release.files.filter(ref=>ref.path.startsWith('node_modules/')).map(ref=>[ref.path,ref]));
  const dependencies=JSON.parse(await regular(root,'audit/dependency-sources.json')),seen=new Set();
  need(dependencies.schema==='lincoln-core-dependency-source-snapshots/v1'
    &&dependencies.releaseManifestSHA256===EXPECTED_RELEASE_SHA256,'CORE_DEPENDENCY_SNAPSHOT_BINDING_INVALID');
  for(const ref of dependencies.files){
    const pinned=expected.get(ref.compilerPath);
    need(pinned&&!seen.has(ref.compilerPath)&&ref.snapshotPath==='vendor/solidity/'+ref.compilerPath.slice('node_modules/'.length)
      &&ref.sha256===pinned.sha256&&ref.bytes===pinned.bytes,'CORE_DEPENDENCY_SNAPSHOT_ENTRY_INVALID');seen.add(ref.compilerPath);
    const bytes=await regular(root,ref.snapshotPath);
    need(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'CORE_DEPENDENCY_SNAPSHOT_CHANGED');
  }
  need(seen.size===expected.size,'CORE_DEPENDENCY_SNAPSHOT_SET_INCOMPLETE');
  const adaptations=JSON.parse(await regular(root,'audit/test-adaptations.json'));
  need(adaptations.schema==='lincoln-core-test-adaptations/v1'&&adaptations.upstreamCommit===EXPECTED_UPSTREAM
    &&adaptations.adaptations.length===2,'CORE_TEST_ADAPTATION_BINDING_INVALID');
  for(const entry of adaptations.adaptations){
    need(['tests/phase2-asp-sdk.test.mjs','tests/phase2-mainnet-plan.test.mjs'].includes(entry.path)
      &&sha(await regular(root,entry.path))===entry.packagedSHA256,'CORE_TEST_ADAPTATION_CHANGED');
  }
  return {dependencySourceSnapshots:seen.size,documentedTestAdaptations:adaptations.adaptations.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===2,'USAGE_CORE_CHECK');console.log(JSON.stringify({...await checkCore(),...await checkReviewFiles()},null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
