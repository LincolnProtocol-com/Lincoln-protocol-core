#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Prepare public files only. Never accesses a signer, RPC, keystore or password.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkCore,RELEASE,EXPECTED_RELEASE_SHA256} from '../../releases/rc2/scripts/core/check.mjs';
import {configureMainnetOperations} from './mainnet-operations.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile);
export const DEPLOYMENT_BASE_COMMIT='abe000c7acd9c26931a17961e1b4bdda083df84e';
export const DEPLOYMENT_BASE_TAG='v0.1.0-rc.2';
export const DEFAULT_DEPLOYMENT_DIRECTORY='.phase1-private/mainnet-deployments/rc2-eth-usdg';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
export function verifyDeploymentArchiveBinding(commit){
  need(commit===DEPLOYMENT_BASE_COMMIT,'MAINNET_PREPARE_TAG_MISMATCH');
}
async function regular(root,relative){
  need(!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(part=>part&&part!=='.'&&part!=='..'),'MAINNET_PREPARE_PUBLIC_PATH_REQUIRED');
  const file=path.join(root,relative),stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'MAINNET_PREPARE_REGULAR_FILE_REQUIRED');
  return fs.readFile(file);
}
async function ensureDirectory(directory){
  try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=await fs.lstat(directory);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(directory)===directory,'MAINNET_PREPARE_DIRECTORY_INVALID');
}
async function unpack(bytes,directory){
  await new Promise((resolve,reject)=>{
    const child=spawn('tar',['-xf','-','-C',directory],{stdio:['pipe','ignore','pipe']});
    let message='';child.stderr.on('data',bytes=>{if(message.length<4096)message+=bytes.toString();});
    child.once('error',reject);child.stdin.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('MAINNET_PREPARE_ARCHIVE_FAILED: '+(signal??code)+' '+message.slice(0,300))));
    child.stdin.end(bytes);
  });
}
export async function prepareMainnetDeployment({root=ROOT,directory=DEFAULT_DEPLOYMENT_DIRECTORY}={}){
  root=await fs.realpath(root);
  const parent=path.join(root,'.phase1-private/mainnet-deployments'),output=path.resolve(root,directory);
  need(path.dirname(output)===parent&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(path.basename(output)),'MAINNET_PREPARE_OUTPUT_NOT_ALLOWED');
  const capsuleRoot=path.join(root,'releases/rc2');await checkCore({root:capsuleRoot});
  const operationsBytes=await regular(root,'config/mainnet-operations.json'),operations=JSON.parse(operationsBytes);
  const originalConfig=await regular(capsuleRoot,'config/phase2-mainnet.json');
  const effective=configureMainnetOperations({config:JSON.parse(originalConfig),operations});
  const tag=(await run('git',['-C',root,'rev-parse','--verify',`refs/tags/${DEPLOYMENT_BASE_TAG}^{commit}`],{timeout:30000})).stdout.trim();
  verifyDeploymentArchiveBinding(tag);
  // Reject links or tracked runtime material before extracting the exact public commit.
  const listing=(await run('git',['-C',root,'ls-tree','-r','-z',DEPLOYMENT_BASE_COMMIT],{encoding:'buffer',maxBuffer:8*1024*1024,timeout:30000})).stdout;
  const files=listing.toString('utf8').split('\0').filter(Boolean).map(entry=>{
    const match=/^(100644|100755) blob [0-9a-f]{40}\t(.+)$/.exec(entry);need(match,'MAINNET_PREPARE_ARCHIVE_ENTRY_INVALID');
    const relative=match[2],parts=relative.split('/');
    need(!path.isAbsolute(relative)&&!relative.includes('\\')&&parts.every(part=>part&&part!=='.'&&part!=='..'
      &&!['.git','node_modules','.phase1-private'].includes(part))&&!/(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:keystore\.json|password|wtns))$/.test(relative),
      'MAINNET_PREPARE_PRIVATE_ARCHIVE_ENTRY');return relative;
  });
  const archive=(await run('git',['-C',root,'archive','--format=tar',DEPLOYMENT_BASE_COMMIT],{encoding:'buffer',maxBuffer:160*1024*1024,timeout:60000})).stdout;
  await ensureDirectory(path.join(root,'.phase1-private'));await ensureDirectory(parent);
  try{await fs.mkdir(output,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Object.assign(new Error('MAINNET_PREPARE_DIRECTORY_EXISTS'),{code:'MAINNET_PREPARE_DIRECTORY_EXISTS'});throw error;}
  // An incomplete preparation is left in place on failure. Never erase a
  // directory that may subsequently contain deployment journals or transactions.
  await unpack(archive,output);
  const releaseBytes=await regular(output,RELEASE);need(sha(releaseBytes)===EXPECTED_RELEASE_SHA256,'MAINNET_PREPARE_RELEASE_MISMATCH');
  const release=JSON.parse(releaseBytes);
  for(const ref of release.files.filter(ref=>!ref.path.startsWith('node_modules/'))){
    const bytes=await regular(output,ref.path);
    need(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'MAINNET_PREPARE_FROZEN_FILE_MISMATCH: '+ref.path);
  }
  const archivedConfig=await regular(output,'config/phase2-mainnet.json');
  need(archivedConfig.equals(originalConfig),'MAINNET_PREPARE_FROZEN_CONFIG_MISMATCH');
  const effectiveBytes=Buffer.from(JSON.stringify(effective,null,2)+'\n');
  await fs.writeFile(path.join(output,'config/phase2-mainnet.json'),effectiveBytes,{mode:0o600});
  const snapshot={schema:'lincoln-mainnet-operations-snapshot/v1',chainId:4663,
    base:{tag:DEPLOYMENT_BASE_TAG,commit:DEPLOYMENT_BASE_COMMIT,releaseManifest:RELEASE,releaseManifestSHA256:EXPECTED_RELEASE_SHA256},
    operationsSHA256:sha(operationsBytes),configBeforeSHA256:sha(archivedConfig),configAfterSHA256:sha(effectiveBytes),
    derivedOperationsSnapshot:true,verbatimFrozenRelease:false,frozenInputsVerifiedBeforeOverlay:true,
    signingEnabled:false,keystoreOwnershipVerified:false,mainnetDeployed:false,feeRoutesDeployed:false,routesDeployed:false,stocksDeployed:false,
    deployer:operations.deployer,limits:operations.limits,archivedPublicFiles:files.length,
    keysAccessed:false,transactionsSigned:0,transactionsBroadcast:0};
  await fs.writeFile(path.join(output,'operations-snapshot.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
  await checkCore({root:capsuleRoot});
  return {...snapshot,directory:output};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    need(args.length===1&&args[0]==='--prepare'||args.length===3&&args[0]==='--prepare'&&args[1]==='--directory','USAGE_MAINNET_PREPARE');
    console.log(JSON.stringify(await prepareMainnetDeployment(args.length===3?{directory:args[2]}:{}),null,2));
  }catch(error){console.error(error.code??error.message);process.exitCode=1;}
}
