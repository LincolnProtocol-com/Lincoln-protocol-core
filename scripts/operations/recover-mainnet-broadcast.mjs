#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Explicit recovery of one existing signed hash. Never signs or changes a nonce.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPublicClient,getContractAddress,http} from 'viem';
import {checkDeploymentSnapshot} from './check-deployment.mjs';
import {checkRC3Deployment,PARENT_PLAN_ID,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST,RC3_RELEASE_SHA256} from './mainnet-rc3.mjs';
import {checkPublicReview} from '../review/run.mjs';
import {openServiceStore} from '../../releases/rc2/src/phase1-service/store.mjs';
import {createMainnetSigner,mainnetSignerDirectory,MAINNET_RPC} from '../../releases/rc2/src/phase2-mainnet/signer.mjs';
import {verifyRecoveryTransaction,sanitizeBroadcastError} from './recovery-validation.mjs';
import {verifyMainnetRecoveryLimits} from './mainnet-limits.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const notFound=error=>['TransactionNotFoundError','TransactionReceiptNotFoundError'].includes(error?.name);
const settled=entry=>['confirmed','reverted','cancelled'].includes(entry.status);
async function existingPrivateFile(file){
 const stat=await fs.lstat(file);
 need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file&&(stat.mode&0o077)===0
  &&(typeof process.getuid!=='function'||stat.uid===process.getuid()),'RECOVERY_PRIVATE_STORE_INVALID');
}
async function readSigner(directory,address){
 await existingPrivateFile(path.join(directory,'signer.json'));
 const store=await openServiceStore({directory,identity:`lincoln-mainnet-signer:4663:${address.toLowerCase()}`,filename:'signer.json'});
 try{return await store.read();}finally{await store.close();}
}
async function publicBytes(file){
 const stat=await fs.lstat(file);
 need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file&&stat.size<=160*1024*1024,'RECOVERY_CONTINUATION_FILE_INVALID');
 return fs.readFile(file);
}
async function continuationJournal({root,planId,directory,address,initial,validateContinuationSnapshot}){
 const checked=await validateContinuationSnapshot({root});
 need(checked&&typeof checked.directory==='string'&&path.isAbsolute(checked.directory)
  &&await fs.realpath(checked.directory)===checked.directory&&checked.sharedSignerDirectory===directory,'RECOVERY_CONTINUATION_SIGNER_MISMATCH');
 need(checked.limits&&['budgetWei','maxFeePerGasWei','reserveWei'].every(key=>checked.limits[key]===initial[key]),'RECOVERY_CONTINUATION_LIMITS_MISMATCH');
 const config=JSON.parse(await publicBytes(path.join(checked.directory,'config/phase2-mainnet.json')));
 need(config.chain?.id===4663&&same(config.deployer?.address,address),'RECOVERY_CONTINUATION_ADDRESS_MISMATCH');
 const releaseBytes=await publicBytes(path.join(root,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST));
 need(createHash('sha256').update(releaseBytes).digest('hex')===RC3_RELEASE_SHA256,'RECOVERY_CONTINUATION_RELEASE_MISMATCH');
 const release=JSON.parse(releaseBytes);
 need(release.chainId===4663&&/^[a-f0-9]{64}$/.test(release.coreArtifactSHA256),'RECOVERY_CONTINUATION_RELEASE_MISMATCH');
 return {directory:path.join(checked.directory,'.phase1-private/phase2-mainnet/deployments',planId),artifactSHA256:release.coreArtifactSHA256};
}
export async function recoverMainnetBroadcast({root=ROOT,hash,rebroadcast=false,client,
 validateSnapshot=checkDeploymentSnapshot,validateContinuationSnapshot=checkRC3Deployment,validateLimits=verifyMainnetRecoveryLimits}={}){
 need(/^0x[0-9a-fA-F]{64}$/.test(hash??'')&&typeof rebroadcast==='boolean','USAGE_RECOVER_MAINNET_BROADCAST');
 hash=hash.toLowerCase();
 root=await fs.realpath(root);
 const snapshot=await validateSnapshot({root}),address=snapshot.address,directory=mainnetSignerDirectory({root:snapshot.directory,address});
 const initial=await readSigner(directory,address),matching=initial?.entries?.filter(entry=>same(entry.hash,hash));
 // A pending amendment must finish explicitly before receipt reconciliation can
 // change its preimage. New limits require the applied approved-policy proof.
 const limitState=await validateLimits({root,state:initial});
 need(limitState&&['budgetWei','maxFeePerGasWei','reserveWei'].every(key=>limitState.limits?.[key]===initial[key]),'RECOVERY_LIMITS_MISMATCH');
 need(matching?.length===1,'RECOVERY_HASH_NOT_IN_LEDGER');
 const original=matching[0],match=/^deploy:([0-9a-f]{64}):(.+)$/.exec(original.id);
 need(match,'RECOVERY_DEPLOYMENT_INTENT_REQUIRED');
 const planId=match[1];
 // Only the one original plan belongs to the RC.2 journal tree. All later plans
 // must validate the RC.3 snapshot and still point to the same physical ledger.
 const continuation=planId===PARENT_PLAN_ID?null:await continuationJournal({root,planId,directory,address,initial,validateContinuationSnapshot});
 const deploymentDirectory=continuation?.directory??path.join(snapshot.directory,'.phase1-private/phase2-mainnet/deployments',planId);
 await existingPrivateFile(path.join(deploymentDirectory,'deployment.json'));
 client??=createPublicClient({transport:http(MAINNET_RPC,{retryCount:0,timeout:20000})});
 // The original signer validates chain, canonical receipts, ledger integrity and
 // the original limits. Only its receipt bookkeeping may change here.
 const signer=createMainnetSigner({client,address,root:snapshot.directory,budgetWei:initial.budgetWei,
  maxFeePerGasWei:initial.maxFeePerGasWei,reserveWei:initial.reserveWei,expectedGenesisHash:initial.genesisHash});
 const reconciled=await signer.reconcile(),resolved=reconciled.entries.find(entry=>same(entry.hash,hash));
 need(resolved,'RECOVERY_HASH_NOT_IN_LEDGER');
 // Match the deployment engine's lock order. Refuse concurrent deployment;
 // never delete an existing lock or copy the ledger to another directory.
 const deploymentStore=await openServiceStore({directory:deploymentDirectory,identity:`lincoln-mainnet-deployment:${planId}`,filename:'deployment.json'});
 let store;
 try{
  store=await openServiceStore({directory,identity:`lincoln-mainnet-signer:4663:${address.toLowerCase()}`,filename:'signer.json'});
  const state=await store.read(),journal=await deploymentStore.read(),entry=state.entries.find(e=>same(e.hash,hash));
  const journalLimits=planId===PARENT_PLAN_ID?limitState.originalLimits:limitState.limits;
  need(state.schema==='phase2-mainnet-signer/v1'&&state.chainId===4663&&same(state.address,address)
   &&state.genesisHash===initial.genesisHash&&state.budgetWei===initial.budgetWei
   &&state.maxFeePerGasWei===initial.maxFeePerGasWei&&state.reserveWei===initial.reserveWei,'RECOVERY_LEDGER_CHANGED');
  need(entry&&journal?.schema==='phase2-mainnet-deployment/v1'&&journal.pins?.planId===planId
   &&same(journal.pins.deployer,address)&&journal.pins.genesisHash===state.genesisHash
   &&journal.pins.budgetWei===journalLimits.budgetWei&&journal.pins.maxFeePerGasWei===journalLimits.maxFeePerGasWei
   &&journal.pins.reserveWei===journalLimits.reserveWei,'RECOVERY_JOURNAL_MISMATCH');
  if(continuation)need(journal.pins.artifactSHA256===continuation.artifactSHA256
   &&journal.pins.signerDirectory===directory,'RECOVERY_CONTINUATION_JOURNAL_MISMATCH');
  const step=journal.steps.find(s=>s.reservationId===entry.id);
  need(step&&step.id===match[2]&&same(step.deployer,address)&&step.nonce===entry.nonce
   &&step.data===entry.data&&same(step.address,getContractAddress({from:address,nonce:BigInt(entry.nonce)}))
   &&(!step.hash||same(step.hash,hash)),'RECOVERY_JOURNAL_MISMATCH');
  if(['confirmed','reverted'].includes(entry.status)){
   // An old ledger confirmation is not fresh canonical chain evidence. Check
   // the correct journal and RC.3 artifact binding before returning any status.
   let receipt;try{receipt=await client.getTransactionReceipt({hash});}
   catch(error){if(notFound(error))throw Object.assign(new Error('RECOVERY_CONFIRMED_RECEIPT_UNAVAILABLE'),{code:'RECOVERY_CONFIRMED_RECEIPT_UNAVAILABLE'});throw error;}
   need(same(receipt.transactionHash,hash)&&same(receipt.from,address)&&receipt.blockNumber.toString()===entry.blockNumber
    &&same(receipt.blockHash,entry.blockHash)&&receipt.status===(entry.status==='confirmed'?'success':'reverted')
    &&same((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash),'RECOVERY_CONFIRMED_RECEIPT_NONCANONICAL');
   return {transactionHash:hash,status:entry.status,feeWei:entry.feeWei,blockNumber:entry.blockNumber,contractAddress:entry.contractAddress,
    rebroadcast:false,transactionsSigned:0,next:entry.status==='confirmed'?'Continue with the RC.3 deployment command and original limits after the deployment pause is lifted; do not resume RC.2.':'Review the reverted receipt; no replacement was signed.'};
  }
  const verified=await verifyRecoveryTransaction({entry,address,expectedHash:hash,budgetWei:state.budgetWei,
   maxFeePerGasWei:state.maxFeePerGasWei,reserveWei:state.reserveWei});
  need(state.entries.filter(e=>!settled(e)).length===1,'RECOVERY_CONCURRENT_RESERVATION');
  const committed=state.entries.reduce((sum,e)=>sum+(e.status==='cancelled'?0n:BigInt(settled(e)?e.feeWei:e.feeCeilingWei)),0n);
  need(committed<=BigInt(state.budgetWei),'RECOVERY_BUDGET_EXCEEDED');
  let known;
  try{known=await client.getTransaction({hash});}catch(error){if(!notFound(error))throw error;}
  if(known)return {transactionHash:hash,status:known.blockNumber===null?'pending':'mined-awaiting-reconciliation',rebroadcast:false,transactionsSigned:0};
  const [latest,pending,balance]=await Promise.all([client.getTransactionCount({address,blockTag:'latest'}),
   client.getTransactionCount({address,blockTag:'pending'}),client.getBalance({address,blockTag:'pending'})]);
  need(BigInt(latest)===BigInt(entry.nonce)&&latest===pending,'RECOVERY_NONCE_CHANGED');
  need(balance>=BigInt(entry.feeCeilingWei)+BigInt(state.reserveWei),'RECOVERY_BALANCE_RESERVE_LOW');
  if(!rebroadcast)return {...verified,status:'not-found-at-node',rebroadcast:false,transactionsSigned:0,
   next:'Explicit --rebroadcast may submit only these identical signed bytes; it cannot change gas price, nonce or budget.'};
  // HTTP transport retries are disabled. Exactly one explicit request; the
  // original hash/raw bytes are retained even if the response is lost.
  entry.status='broadcasting';await store.write(state);
  try{
   const actual=await client.request({method:'eth_sendRawTransaction',params:[entry.rawTransaction]});
   need(same(actual,hash),'RECOVERY_BROADCAST_HASH_MISMATCH');
   entry.status='submitted';await store.write(state);
   return {...verified,status:'submitted',rebroadcast:true,transactionsSigned:0,automaticResend:false};
  }catch(error){
   entry.status='unknown';await store.write(state);
   return {error:'MAINNET_REBROADCAST_UNKNOWN',transactionHash:hash,automaticResend:false,transactionsSigned:0,rpc:sanitizeBroadcastError(error)};
  }
 }finally{try{await store?.close();}finally{await deploymentStore.close();}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);need((args.length===2||args.length===3)&&args[0]==='--hash'
   &&(args.length===2||args[2]==='--rebroadcast'),'USAGE_RECOVER_MAINNET_BROADCAST');
  await checkPublicReview();const result=await recoverMainnetBroadcast({hash:args[1],rebroadcast:args.length===3});
  console.log(JSON.stringify(result));if(result.error)process.exitCode=1;
 }catch(error){console.error(JSON.stringify({error:error.code??'MAINNET_RECOVERY_FAILED',rpc:sanitizeBroadcastError(error),automaticResend:false}));process.exitCode=1;}
}
