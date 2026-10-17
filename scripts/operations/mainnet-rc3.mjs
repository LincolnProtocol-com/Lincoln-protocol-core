#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline RC.3 preparation. Only public files are archived; the original account
// ledger is validated read-only and referenced in place, never copied or reset.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {getAddress,isAddress,getContractAddress,encodeDeployData} from 'viem';
import {checkCore} from '../../releases/rc3/scripts/core/check.mjs';
import {deploymentSpecs,linkMainnetBytecode,normalizeAdoptedDeployments} from '../../releases/rc3/scripts/phase2-mainnet/deploy.mjs';
import {verifyMainnetLimitsState} from './mainnet-limits.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile);
export const RC3_CANDIDATE_TAG='v0.1.0-rc.3';
export const RC3_RELEASE_DIRECTORY='releases/rc3';
export const RC3_RELEASE_MANIFEST='artifacts/phase2-mainnet/release-candidate-20261017-r3.json';
export const RC3_RELEASE_SHA256='dea4a351f51a78e773ed37543b533bf7d0fdac31b81ad166bd4b1ac2692f9c1d';
export const RC3_OPERATIONS_FILE='config/mainnet-operations-rc3.json';
export const DEFAULT_RC3_DEPLOYMENT_DIRECTORY='.phase1-private/mainnet-deployments/rc3-eth-usdg';
export const PARENT_PLAN_ID='ec1130a3d41de4287d16dba8073dbedea97871c9a3536b20aadbc4c4ea6a79aa';
const CONFIG='config/phase2-mainnet.json',METADATA='operations-snapshot.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function exact(value,keys){need(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),'RC3_OPERATIONS_SHAPE_INVALID');}
function publicPath(value){
  need(typeof value==='string'&&!path.isAbsolute(value)&&!value.includes('\\')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')
    &&!value.split('/').some(p=>['.git','node_modules','.phase1-private'].includes(p))
    &&!/(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:keystore\.json|password|wtns))$/.test(value),'RC3_ARCHIVE_PRIVATE_PATH');
  return value;
}
async function regular(file,{privateFile=false}={}){
  const stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'RC3_REGULAR_FILE_REQUIRED');
  need(stat.size<=160*1024*1024,'RC3_FILE_TOO_LARGE');
  if(privateFile)need((stat.mode&0o077)===0&&(typeof process.getuid!=='function'||stat.uid===process.getuid()),'RC3_PRIVATE_FILE_PERMISSIONS_INVALID');
  return fs.readFile(file);
}
async function directory(file){const stat=await fs.lstat(file);need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'RC3_DIRECTORY_INVALID');return file;}
async function ensureDirectory(file){try{await fs.mkdir(file,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}return directory(file);}
function parseStore(bytes,identity){
  let encoded;try{encoded=JSON.parse(bytes);}catch{throw Object.assign(new Error('RC3_SOURCE_STORE_CORRUPT'),{code:'RC3_SOURCE_STORE_CORRUPT'});}
  need(encoded&&Object.keys(encoded).sort().join(',')==='digest,identity,schema,value'&&encoded.schema==='phase1-service-store/v1'
    &&encoded.identity===identity,'RC3_SOURCE_STORE_IDENTITY_MISMATCH');
  const {digest,...body}=encoded;need(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)&&sha(JSON.stringify(body))===digest,'RC3_SOURCE_STORE_CORRUPT');
  return {value:encoded.value,digest};
}
const limitsValid=limits=>limits&&Object.keys(limits).sort().join(',')==='budgetWei,maxFeePerGasWei,reserveWei'
  &&['budgetWei','maxFeePerGasWei'].every(k=>typeof limits[k]==='string'&&/^[1-9][0-9]*$/.test(limits[k]))
  &&typeof limits.reserveWei==='string'&&/^(0|[1-9][0-9]*)$/.test(limits.reserveWei);

export function configureRC3Operations({config,operations,releaseSHA256=RC3_RELEASE_SHA256}={}){
  exact(operations,['schema','chainId','candidate','deployer','signingEnabled','continuation']);
  exact(operations.candidate,['tag','manifest','sha256']);
  exact(operations.deployer,['address','signingAccount','addressSource','keystoreOwnershipVerified']);
  exact(operations.continuation,['parentTag','planId','genesisHash','sharedSignerRelativePath','sourceJournalRelativePath','limits','adoptedDeployments']);
  need(operations.schema==='lincoln-mainnet-operations/v2'&&operations.chainId===4663&&config?.chain?.id===4663,'RC3_OPERATIONS_CHAIN_INVALID');
  need(operations.candidate.tag===RC3_CANDIDATE_TAG&&operations.candidate.manifest===RC3_RELEASE_MANIFEST
    &&operations.candidate.sha256===releaseSHA256,'RC3_OPERATIONS_CANDIDATE_MISMATCH');
  const {address,signingAccount,addressSource,keystoreOwnershipVerified}=operations.deployer,c=operations.continuation;
  need(operations.signingEnabled===false&&keystoreOwnershipVerified===false&&addressSource==='user-supplied','RC3_SIGNING_DISABLED_REQUIRED');
  need(isAddress(address,{strict:true})&&!/^0x0{40}$/i.test(address)&&typeof signingAccount==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(signingAccount),'RC3_DEPLOYER_INVALID');
  need(config.deployer?.address===null&&config.deployer.signingAccount===null,'RC3_FROZEN_DEPLOYER_REQUIRED');
  need(![config.guardian?.address,config.provider?.address].some(role=>same(role,address)),'RC3_ROLE_COLLISION');
  const base='.phase1-private/mainnet-deployments/rc2-eth-usdg/.phase1-private/phase2-mainnet';
  need(c.parentTag==='v0.1.0-rc.2'&&c.planId===PARENT_PLAN_ID&&/^0x[a-f0-9]{64}$/.test(c.genesisHash)
    &&c.sharedSignerRelativePath===`${base}/signers/4663-${address.toLowerCase()}`
    &&c.sourceJournalRelativePath===`${base}/deployments/${PARENT_PLAN_ID}/deployment.json`&&limitsValid(c.limits),'RC3_CONTINUATION_BINDING_INVALID');
  need(Array.isArray(c.adoptedDeployments)&&c.adoptedDeployments.length===2,'RC3_ADOPTED_DEPLOYMENTS_INVALID');
  for(const [i,id]of ['PoseidonT3','PoseidonT4'].entries()){
    const anchor=c.adoptedDeployments[i];exact(anchor,['id','sourceReservationId','hash','address','nonce']);
    need(anchor.id===id&&anchor.sourceReservationId===`deploy:${PARENT_PLAN_ID}:${id}`&&anchor.nonce===String(i)
      &&/^0x[a-f0-9]{64}$/.test(anchor.hash)&&isAddress(anchor.address,{strict:true})
      &&same(getContractAddress({from:address,nonce:BigInt(anchor.nonce)}),anchor.address),'RC3_ADOPTED_DEPLOYMENTS_INVALID');
  }
  const effective=structuredClone(config);
  effective.deployer={...effective.deployer,address:getAddress(address),signingAccount,
    signerLocation:'local-foundry-keystore-user-managed',status:'rc3-continuation-original-account-ledger'};
  return effective;
}

/** No lock is created and no journal is rewritten. Never return signed bytes. */
export async function inspectRC3Continuation({root=ROOT,operations,verifyLimitsState=verifyMainnetLimitsState,allowPendingAmendment=false}={}){
  root=await fs.realpath(root);const c=operations.continuation,address=operations.deployer.address;
  const signerDirectory=await directory(path.join(root,c.sharedSignerRelativePath)),signerStat=await fs.lstat(signerDirectory);
  need((signerStat.mode&0o077)===0&&(typeof process.getuid!=='function'||signerStat.uid===process.getuid()),'RC3_PRIVATE_DIRECTORY_PERMISSIONS_INVALID');
  for(const lock of [path.join(signerDirectory,'.service.lock'),path.join(path.dirname(path.join(root,c.sourceJournalRelativePath)),'.service.lock')]){
    try{await fs.lstat(lock);throw Object.assign(new Error('RC3_SOURCE_STORE_LOCKED'),{code:'RC3_SOURCE_STORE_LOCKED'});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const ledger=parseStore(await regular(path.join(signerDirectory,'signer.json'),{privateFile:true}),`lincoln-mainnet-signer:4663:${address.toLowerCase()}`);
  const journal=parseStore(await regular(path.join(root,c.sourceJournalRelativePath),{privateFile:true}),`lincoln-mainnet-deployment:${c.planId}`);
  const state=ledger.value,pins=journal.value?.pins;
  need(state?.schema==='phase2-mainnet-signer/v1'&&state.chainId===4663&&same(state.address,address)
    &&state.genesisHash===c.genesisHash&&journal.value.schema==='phase2-mainnet-deployment/v1'&&pins?.planId===c.planId
    &&same(pins.deployer,address)&&pins.genesisHash===c.genesisHash,'RC3_SOURCE_IDENTITY_MISMATCH');
  const limitState=await verifyLimitsState({root,operations,ledger:state,sourceJournal:journal.value,
    ledgerDigest:ledger.digest,sourceJournalDigest:journal.digest,allowPending:allowPendingAmendment});
  need(Array.isArray(state.entries)&&new Set(state.entries.map(e=>e.id)).size===state.entries.length&&Array.isArray(journal.value.steps)
    &&new Set(journal.value.steps.map(e=>e.id)).size===journal.value.steps.length
    &&new Set(journal.value.steps.map(e=>e.reservationId)).size===journal.value.steps.length,'RC3_SOURCE_ENTRIES_INVALID');
  for(const anchor of c.adoptedDeployments){
    const entry=state.entries.find(e=>e.id===anchor.sourceReservationId),step=journal.value.steps.find(e=>e.id===anchor.id);
    need(entry&&entry.hash===anchor.hash&&entry.nonce===anchor.nonce&&entry.chainId===4663&&entry.to===null&&entry.value==='0'
      &&entry.intentDigest===sha(JSON.stringify({to:entry.to,data:entry.data,value:entry.value}))
      &&['confirmed','unknown','signed','broadcasting','submitted'].includes(entry.status),'RC3_SOURCE_ANCHOR_MISMATCH');
    need(anchor.id!=='PoseidonT3'||entry.status==='confirmed','RC3_CONFIRMED_LIBRARY_REQUIRED');
    need(step&&step.reservationId===anchor.sourceReservationId&&step.nonce===anchor.nonce&&same(step.address,anchor.address)
      &&same(step.deployer,address)&&step.data===entry.data
      &&(!step.hash||step.hash===anchor.hash)&&(!entry.contractAddress||same(entry.contractAddress,anchor.address)),'RC3_SOURCE_JOURNAL_MISMATCH');
  }
  const unresolved=state.entries.filter(e=>['unknown','broadcasting','signed','submitted'].includes(e.status)
    ||!['confirmed','reverted','cancelled'].includes(e.status));
  return {sharedSignerDirectory:signerDirectory,adoptedDeployments:structuredClone(c.adoptedDeployments),limits:limitState.limits,
    originalLimits:structuredClone(c.limits),limitsAmendment:limitState.amendment,pendingLimitsAmendment:limitState.pending,
    sourceLedgerDigest:ledger.digest,sourceJournalDigest:journal.digest,
    readiness:{blocked:limitState.pending||unresolved.length>0,code:limitState.pending?'MAINNET_LIMITS_AMENDMENT_INCOMPLETE':unresolved.length?'ACCOUNT_UNKNOWN_BROADCAST':null,
      unresolved:unresolved.map(e=>({hash:e.hash??null,nonce:e.nonce,status:e.status}))}};
}

/** An interrupted password prompt may leave the current plan's reservation
 * prepared but never signed. Only its exact frozen CREATE intent can resume;
 * every hash-bearing or foreign reservation remains blocked. No state changes.
 */
async function unsignedPreparedReadiness({root,output,operations,effective,continuation}){
  if(continuation.pendingLimitsAmendment)return continuation.readiness;
  if(!continuation.readiness.blocked)return continuation.readiness;
  try{
    const state=parseStore(await regular(path.join(continuation.sharedSignerDirectory,'signer.json'),{privateFile:true}),
      `lincoln-mainnet-signer:4663:${operations.deployer.address.toLowerCase()}`).value;
    const live=state.entries.filter(e=>!['confirmed','reverted','cancelled'].includes(e.status));
    need(live.length===1&&live[0].status==='prepared'&&!Object.hasOwn(live[0],'hash')&&!Object.hasOwn(live[0],'rawTransaction'),
      'RC3_UNSIGNED_RESUME_SIGNED_OR_FOREIGN');
    const entry=live[0],manifest=JSON.parse(await regular(path.join(output,RC3_RELEASE_MANIFEST)));
    const buildBytes=await regular(path.join(output,publicPath(effective.productionArtifacts.build))),artifacts=JSON.parse(buildBytes);
    need(sha(buildBytes)===manifest.coreArtifactSHA256&&/^[a-f0-9]{64}$/.test(artifacts._meta?.sourceSetSHA256),
      'RC3_UNSIGNED_RESUME_ARTIFACT_MISMATCH');
    const adopted=normalizeAdoptedDeployments(continuation.adoptedDeployments),artifactSHA256=manifest.coreArtifactSHA256;
    const planId=sha(JSON.stringify({artifactSHA256,config:effective,routes:[],relayer:null,adoptedDeployments:adopted}));
    need(entry.id.startsWith(`deploy:${planId}:`),'RC3_UNSIGNED_RESUME_FOREIGN_PLAN');
    const journal=parseStore(await regular(path.join(output,'.phase1-private/phase2-mainnet/deployments',planId,'deployment.json'),{privateFile:true}),
      `lincoln-mainnet-deployment:${planId}`).value;
    const pins={planId,artifactSHA256,sourceSetSHA256:artifacts._meta.sourceSetSHA256,genesisHash:operations.continuation.genesisHash,
      deployer:effective.deployer.address,provider:effective.provider.address,relayer:null,...continuation.limits,
      signerDirectory:continuation.sharedSignerDirectory,adoptedDeployments:adopted};
    need(journal.schema==='phase2-mainnet-deployment/v1'&&journal.status==='deploying'&&isDeepStrictEqual(journal.pins,pins),
      'RC3_UNSIGNED_RESUME_JOURNAL_MISMATCH');
    const specs=deploymentSpecs({config:effective,routes:[]});
    need(Array.isArray(journal.steps)&&journal.steps.length>=3&&journal.steps.length<=specs.length,
      'RC3_UNSIGNED_RESUME_JOURNAL_MISMATCH');
    const addresses={},adoptedById=new Map(adopted.map(a=>[a.id,a]));
    for(const [i,step]of journal.steps.entries()){
      const spec=specs[i],anchor=adoptedById.get(spec.id),last=i===journal.steps.length-1;
      need(step.id===spec.id,'RC3_UNSIGNED_RESUME_JOURNAL_MISMATCH');
      let args=[];
      if(spec.contract==='Phase2ASPRegistry')args=[effective.provider.address,effective.guardian.address];
      if(spec.contract==='Phase2ASPPool')args=[addresses.Phase2ASPJoinSplitVerifier,addresses.Phase2ASPExitVerifier,addresses.Phase2ASPRegistry,
        spec.asset.address,BigInt(spec.depositCaps.maxDepositUnits),BigInt(spec.depositCaps.maxTotalUnits)];
      const libraries=Object.fromEntries(['PoseidonT3','PoseidonT4'].filter(id=>addresses[id]).map(id=>[id,addresses[id]]));
      const data=encodeDeployData({abi:artifacts[spec.contract].abi,bytecode:linkMainnetBytecode(artifacts[spec.contract],libraries),args});
      need(step.data===data&&same(step.deployer,effective.deployer.address)&&/^(0|[1-9][0-9]*)$/.test(step.nonce)
        &&same(step.address,getContractAddress({from:effective.deployer.address,nonce:BigInt(step.nonce)})),
        'RC3_UNSIGNED_RESUME_INTENT_MISMATCH');
      const sourceId=anchor?.sourceReservationId??`deploy:${planId}:${spec.id}`,reservation=state.entries.find(e=>e.id===sourceId);
      need(reservation&&step.reservationId===sourceId&&reservation.data===data&&reservation.nonce===step.nonce
        &&reservation.chainId===4663&&reservation.to===null&&reservation.value==='0'
        &&reservation.intentDigest===sha(JSON.stringify({to:null,data,value:'0'})),'RC3_UNSIGNED_RESUME_INTENT_MISMATCH');
      if(anchor)need(!last&&step.kind==='reused'&&step.status==='verified'&&step.sourceReservationId===sourceId
        &&step.sourcePlanId===operations.continuation.planId&&step.hash===anchor.hash&&step.nonce===anchor.nonce
        &&same(step.address,anchor.address)&&reservation.status==='confirmed'&&reservation.hash===anchor.hash,
        'RC3_UNSIGNED_RESUME_ADOPTION_MISMATCH');
      else if(last)need(reservation.id===entry.id&&step.status==='prepared'&&!Object.hasOwn(step,'hash')&&!Object.hasOwn(step,'runtime')
        &&!Object.hasOwn(reservation,'hash')&&!Object.hasOwn(reservation,'rawTransaction')&&reservation.status==='prepared'
        &&reservation.gas===spec.gasCap&&/^[1-9][0-9]*$/.test(reservation.gasPrice)
        &&BigInt(reservation.gasPrice)<=BigInt(continuation.limits.maxFeePerGasWei)
        &&BigInt(reservation.feeCeilingWei)===BigInt(reservation.gas)*BigInt(reservation.gasPrice),
        'RC3_UNSIGNED_RESUME_INTENT_MISMATCH');
      else need(step.status==='verified'&&reservation.status==='confirmed'&&step.hash===reservation.hash,
        'RC3_UNSIGNED_RESUME_PRIOR_STEP_MISMATCH');
      addresses[spec.id]=step.address;
    }
    return {...continuation.readiness,blocked:false,code:null,unsignedPreparedResume:true};
  }catch(error){return {...continuation.readiness,unsignedPreparedResume:false,unsignedResumeBlockedReason:error.code??'RC3_UNSIGNED_RESUME_INVALID'};}
}

/** Fixed tag/capsule only. ls-tree validates every archive path before extraction. */
export async function readRC3Archive({root=ROOT}={}){
  let commit;try{commit=(await run('git',['-C',root,'rev-parse','--verify',`refs/tags/${RC3_CANDIDATE_TAG}^{commit}`],{timeout:30000})).stdout.trim();}
  catch{throw Object.assign(new Error('RC3_RELEASE_TAG_NOT_AVAILABLE'),{code:'RC3_RELEASE_TAG_NOT_AVAILABLE'});}
  need(/^[a-f0-9]{40}$/.test(commit),'RC3_TAG_COMMIT_INVALID');
  const tree=(await run('git',['-C',root,'rev-parse','--verify',`${commit}:${RC3_RELEASE_DIRECTORY}`],{timeout:30000})).stdout.trim();
  const listing=(await run('git',['-C',root,'ls-tree','-r','-z',tree],{encoding:'buffer',maxBuffer:8*1024*1024,timeout:30000})).stdout;
  const files=listing.toString().split('\0').filter(Boolean).map(entry=>{
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);need(match,'RC3_ARCHIVE_ENTRY_INVALID');
    return {path:publicPath(match[3]),mode:match[1],blob:match[2]};
  });
  need(files.length>0&&new Set(files.map(e=>e.path)).size===files.length,'RC3_ARCHIVE_ENTRY_INVALID');
  const archive=(await run('git',['-C',root,'archive','--format=tar',`${commit}:${RC3_RELEASE_DIRECTORY}`],{encoding:'buffer',maxBuffer:160*1024*1024,timeout:60000})).stdout;
  return {commit,tree,files,async extract(output){await new Promise((resolve,reject)=>{
    const child=spawn('tar',['-xf','-','-C',output],{stdio:['pipe','ignore','ignore']});
    child.once('error',reject);child.stdin.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('RC3_ARCHIVE_EXTRACTION_FAILED: '+(signal??code))));
    child.stdin.end(archive);
  });}};
}

/** Injected archive/check dependencies are for isolated synthetic-file tests.
 * The CLI below always constructs this with the fixed production defaults. */
export function createMainnetRC3Operator({verifyCandidate=async({root})=>checkCore({root:path.join(root,RC3_RELEASE_DIRECTORY)}),
  archiveProvider=readRC3Archive,releaseSHA256=RC3_RELEASE_SHA256,verifyLimitsState=verifyMainnetLimitsState}={}){
  async function inputs(root){
    root=await fs.realpath(root);await verifyCandidate({root});
    const operationsBytes=await regular(path.join(root,RC3_OPERATIONS_FILE)),operations=JSON.parse(operationsBytes);
    const originalConfig=await regular(path.join(root,RC3_RELEASE_DIRECTORY,CONFIG));
    const effective=configureRC3Operations({config:JSON.parse(originalConfig),operations,releaseSHA256});
    return {root,operationsBytes,operations,originalConfig,effective};
  }
  async function archive(root){
    const input=await archiveProvider({root});
    need(/^[a-f0-9]{40}$/.test(input.commit)&&/^[a-f0-9]{40}$/.test(input.tree)&&Array.isArray(input.files),'RC3_ARCHIVE_IDENTITY_INVALID');
    for(const entry of input.files){publicPath(entry.path);need(['100644','100755'].includes(entry.mode)&&/^[a-f0-9]{40}$/.test(entry.blob),'RC3_ARCHIVE_ENTRY_INVALID');
      need(blob(await regular(path.join(root,RC3_RELEASE_DIRECTORY,entry.path)))===entry.blob,'RC3_TAG_CAPSULE_MISMATCH');}
    need(input.files.length>0&&new Set(input.files.map(e=>e.path)).size===input.files.length
      &&[CONFIG,RC3_RELEASE_MANIFEST].every(relative=>input.files.some(entry=>entry.path===relative)),'RC3_ARCHIVE_ENTRY_INVALID');
    need(sha(await regular(path.join(root,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST)))===releaseSHA256,'RC3_RELEASE_SHA_MISMATCH');
    return input;
  }
  const archiveIdentity=input=>({tag:RC3_CANDIDATE_TAG,commit:input.commit,capsulePath:RC3_RELEASE_DIRECTORY,tree:input.tree,
    filesSHA256:sha(JSON.stringify(input.files)),releaseManifest:RC3_RELEASE_MANIFEST,releaseManifestSHA256:releaseSHA256});
  async function prepare({root=ROOT}={}){
    const value=await inputs(root);root=value.root;const {operations,operationsBytes,originalConfig,effective}=value;
    const continuation=await inspectRC3Continuation({root,operations,verifyLimitsState}),source=await archive(root);
    await ensureDirectory(path.join(root,'.phase1-private'));await ensureDirectory(path.join(root,'.phase1-private/mainnet-deployments'));
    const output=path.join(root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY);
    try{await fs.mkdir(output,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Object.assign(new Error('RC3_SNAPSHOT_ALREADY_EXISTS'),{code:'RC3_SNAPSHOT_ALREADY_EXISTS'});throw error;}
    // Incomplete output remains intact on failure. Never erase operator journals.
    await source.extract(output);
    for(const entry of source.files)need(blob(await regular(path.join(output,entry.path)))===entry.blob,'RC3_EXTRACTED_FILE_MISMATCH');
    const archivedConfig=await regular(path.join(output,CONFIG));need(archivedConfig.equals(originalConfig),'RC3_CONFIG_MISMATCH');
    const effectiveBytes=encode(effective);await fs.writeFile(path.join(output,CONFIG),effectiveBytes,{mode:0o600});await fs.chmod(path.join(output,CONFIG),0o600);
    const snapshot={schema:'lincoln-mainnet-operations-snapshot/v2',chainId:4663,base:archiveIdentity(source),operationsSHA256:sha(operationsBytes),
      configBeforeSHA256:sha(originalConfig),configAfterSHA256:sha(effectiveBytes),archivedPublicFiles:source.files.length,
      derivedOperationsSnapshot:true,verbatimFrozenRelease:false,signingEnabled:false,keystoreOwnershipVerified:false,
      deployer:operations.deployer,sharedSignerDirectory:continuation.sharedSignerDirectory,adoptedDeployments:continuation.adoptedDeployments,
      limits:continuation.originalLimits,sourceLedgerDigestAtPreparation:continuation.sourceLedgerDigest,
      sourceJournalDigestAtPreparation:continuation.sourceJournalDigest,preparedWithUnknownBroadcast:continuation.readiness.blocked,
      originalLedgerCopied:false,rawSignedTransactionsCopied:false,keysAccessed:false,transactionsSigned:0,transactionsBroadcast:0,
      routesDeployed:false,stocksDeployed:false,mainnetDeployed:false};
    await fs.writeFile(path.join(output,METADATA),encode(snapshot),{flag:'wx',mode:0o600});
    await verifyCandidate({root});return {directory:output,...snapshot,readiness:continuation.readiness};
  }
  async function check({root=ROOT,limits,allowPendingAmendment=false}={}){
    const value=await inputs(root);root=value.root;const {operations,operationsBytes,originalConfig,effective}=value;
    const continuation=await inspectRC3Continuation({root,operations,verifyLimitsState,allowPendingAmendment}),source=await archive(root),output=await directory(path.join(root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY));
    const snapshot=JSON.parse(await regular(path.join(output,METADATA),{privateFile:true}));
    need(snapshot.schema==='lincoln-mainnet-operations-snapshot/v2'&&snapshot.chainId===4663
      &&isDeepStrictEqual(snapshot.base,archiveIdentity(source))&&snapshot.operationsSHA256===sha(operationsBytes)
      &&snapshot.configBeforeSHA256===sha(originalConfig)&&snapshot.configAfterSHA256===sha(encode(effective))
      &&snapshot.archivedPublicFiles===source.files.length&&snapshot.derivedOperationsSnapshot===true&&snapshot.verbatimFrozenRelease===false
      &&snapshot.signingEnabled===false&&snapshot.sharedSignerDirectory===continuation.sharedSignerDirectory
      &&isDeepStrictEqual(snapshot.adoptedDeployments,continuation.adoptedDeployments)&&isDeepStrictEqual(snapshot.limits,continuation.originalLimits)
      &&snapshot.originalLedgerCopied===false&&snapshot.rawSignedTransactionsCopied===false&&snapshot.keysAccessed===false
      &&snapshot.transactionsSigned===0&&snapshot.transactionsBroadcast===0,'RC3_SNAPSHOT_METADATA_MISMATCH');
    for(const entry of source.files){
      const bytes=await regular(path.join(output,entry.path));
      need(entry.path===CONFIG?bytes.equals(encode(effective)):blob(bytes)===entry.blob,'RC3_SNAPSHOT_FILE_MISMATCH');
    }
    if(limits!==undefined)need(limitsValid(limits)&&isDeepStrictEqual(limits,continuation.limits),'RC3_EXPLICIT_LIMITS_MUST_MATCH_ORIGINAL');
    const readiness=await unsignedPreparedReadiness({root,output,operations,effective,continuation});
    return {directory:output,account:operations.deployer.signingAccount,checkedPublicFiles:source.files.length,
      sharedSignerDirectory:continuation.sharedSignerDirectory,adoptedDeployments:continuation.adoptedDeployments,
      limits:continuation.limits,originalLimits:continuation.originalLimits,limitsAmendment:continuation.limitsAmendment,
      readiness,keysAccessed:false,transactionsBroadcast:0};
  }
  async function plan({root=ROOT}={}){
    const {operations}=await inputs(root);
    return {schema:'lincoln-mainnet-operations-plan/v2',candidate:operations.candidate,chainId:4663,signingEnabled:false,
      scope:['ETH','USDG'],routes:false,stocks:false,inheritsOriginalAccountLedger:true,originalLimits:operations.continuation.limits,
      adoptedDeployments:operations.continuation.adoptedDeployments,privateFilesRead:false,keysAccessed:false,transactionsBroadcast:0,
      next:'Prepare the RC.3 snapshot. Any unresolved original transaction blocks deployment; recovery is a separate explicit command.'};
  }
  return {prepare,check,plan};
}
const operator=createMainnetRC3Operator();
export const prepareRC3Deployment=operator.prepare,checkRC3Deployment=operator.check,mainnetRC3Plan=operator.plan;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);let result;
    if(args.length===0||args.length===1&&args[0]==='--prepare')result=await prepareRC3Deployment();
    else if(args.length===1&&args[0]==='--plan')result=await mainnetRC3Plan();
    else if(args[0]==='--check'){
      let limits;
      if(args.length!==1){need(args.length===7&&args[1]==='--budget-wei'&&args[3]==='--max-fee-per-gas-wei'&&args[5]==='--reserve-wei','USAGE_MAINNET_RC3');
        limits={budgetWei:args[2],maxFeePerGasWei:args[4],reserveWei:args[6]};}
      result=await checkRC3Deployment({limits});
    }else throw Object.assign(new Error('USAGE_MAINNET_RC3'),{code:'USAGE_MAINNET_RC3'});
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(JSON.stringify({error:error.code??'MAINNET_RC3_PREPARATION_FAILED',automaticResend:false}));process.exitCode=1;}
}
