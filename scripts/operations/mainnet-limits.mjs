#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Explicit local limit amendment only. This module never signs, sends or uses RPC.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {getAddress} from 'viem';
import {openServiceStore} from '../../releases/rc3/src/phase1-service/store.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const MAINNET_GAS_POLICY_FILE='config/mainnet-gas-policy-20261017.json';
export const APPROVED_MAINNET_GAS_POLICY_SHA256='bf0401b295da43e7fda411c86b056246ca944e8ca2be92eff73932580c8bb770';
export const MAINNET_LIMITS_RECORD_DIRECTORY='.phase1-private/mainnet-limits/20261017-gas-100x';
const OPS='config/mainnet-operations-rc3.json',SNAPSHOT='.phase1-private/mainnet-deployments/rc3-eth-usdg';
const KEYS=['budgetWei','maxFeePerGasWei','reserveWei'],STAGES=['prepared','ledger-updated','journal-updated','applied'];
const sha=value=>createHash('sha256').update(value).digest('hex'),hash=value=>sha(JSON.stringify(value));
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const limits=value=>Object.fromEntries(KEYS.map(key=>[key,value?.[key]]));
const eq=(a,b)=>isDeepStrictEqual(a,b);
const validLimits=value=>value&&Object.keys(value).sort().join(',')===[...KEYS].sort().join(',')
  &&KEYS.every(key=>typeof value[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(value[key])
    &&BigInt(value[key])<2n**256n&&(key==='reserveWei'||BigInt(value[key])>0n));
const identity=address=>`lincoln-mainnet-signer:4663:${address.toLowerCase()}`;
const journalIdentity=plan=>`lincoln-mainnet-deployment:${plan}`;
const digest=(name,value)=>hash({schema:'phase1-service-store/v1',identity:name,value});
const recordIdentity=policy=>`lincoln-mainnet-limits:4663:${policy.policy.deployer.toLowerCase()}:${policy.policySHA256}`;
async function regular(file,{privateFile=false,optional=false}={}){
  let stat;try{stat=await fs.lstat(file);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file&&stat.size<=128*1024*1024,'MAINNET_LIMITS_FILE_INVALID');
  if(privateFile)need((stat.mode&0o077)===0&&(typeof process.getuid!=='function'||stat.uid===process.getuid()),'MAINNET_LIMITS_PRIVATE_PERMISSIONS_INVALID');
  return fs.readFile(file);
}
async function readStore(file,name,{optional=false}={}){
  const bytes=await regular(file,{privateFile:true,optional});if(bytes===null)return null;
  let envelope;try{envelope=JSON.parse(bytes);}catch{throw Object.assign(new Error('MAINNET_LIMITS_STORE_CORRUPT'),{code:'MAINNET_LIMITS_STORE_CORRUPT'});}
  need(envelope&&Object.keys(envelope).sort().join(',')==='digest,identity,schema,value'&&envelope.schema==='phase1-service-store/v1'
    &&envelope.identity===name&&envelope.digest===digest(name,envelope.value),'MAINNET_LIMITS_STORE_CORRUPT');
  return {value:envelope.value,digest:envelope.digest};
}
function entryAnchor(entry,index){
  const immutable={};
  for(const key of ['id','chainId','to','data','value','intentDigest','nonce','gas','gasPrice','feeCeilingWei'])immutable[key]=entry[key]??null;
  return {index,id:entry.id,intentSHA256:hash(immutable),hash:entry.hash??null,rawSHA256:entry.rawTransaction===undefined?null:sha(entry.rawTransaction)};
}
function assertEntryAnchors(state,anchors){
  need(Array.isArray(state.entries)&&Array.isArray(anchors)&&state.entries.length>=anchors.length,'MAINNET_LIMITS_ENTRY_REWRITE');
  for(const [index,anchor]of anchors.entries()){
    const current=entryAnchor(state.entries[index],index);
    need(anchor.index===index&&current.id===anchor.id&&current.intentSHA256===anchor.intentSHA256
      &&(anchor.hash===null||current.hash===anchor.hash)&&(anchor.rawSHA256===null||current.rawSHA256===anchor.rawSHA256),'MAINNET_LIMITS_ENTRY_REWRITE');
  }
}
function stepAnchors(journal){
  return journal.steps.map((step,index)=>({index,id:step.id,sha256:hash(Object.fromEntries(['id','kind','reservationId','sourceReservationId','sourcePlanId','deployer','data','nonce','address']
    .map(key=>[key,step[key]??null]))),hash:step.hash??null}));
}
function assertStepAnchors(journal,anchors){
  need(Array.isArray(journal.steps)&&journal.steps.length>=anchors.length,'MAINNET_LIMITS_JOURNAL_REWRITE');
  const current=stepAnchors(journal);
  for(const [index,anchor]of anchors.entries())need(eq({...current[index],hash:anchor.hash===null?null:current[index].hash},anchor),'MAINNET_LIMITS_JOURNAL_REWRITE');
}
const pinsWithoutLimits=pins=>Object.fromEntries(Object.entries(pins).filter(([key])=>!KEYS.includes(key)));
function reference(record){return {schema:'lincoln-mainnet-limit-amendment-reference/v1',id:record.id,policySHA256:record.policySHA256,
  beforeSignerStoreDigest:record.before.signerStoreDigest,beforeJournalStoreDigest:record.before.journalStoreDigest,
  entryAnchorsSHA256:hash(record.entryAnchors),originalLimits:record.originalLimits,effectiveLimits:record.effectiveLimits};}
function targetState(state,record){return {...state,...record.effectiveLimits,limitAmendments:[reference(record)]};}
function targetJournal(journal,record){return {...journal,pins:{...journal.pins,...record.effectiveLimits},limitAmendments:[reference(record)]};}
function originalState(state,record){const original={...state,...record.originalLimits};delete original.limitAmendments;return original;}
function originalJournal(journal,record){const original={...journal,pins:{...journal.pins,...record.originalLimits}};delete original.limitAmendments;return original;}
function assertSource(operations,sourceJournal){
  need(sourceJournal?.schema==='phase2-mainnet-deployment/v1'&&sourceJournal.pins?.planId===operations.continuation.planId
    &&same(sourceJournal.pins.deployer,operations.deployer.address)&&sourceJournal.pins.genesisHash===operations.continuation.genesisHash
    &&eq(limits(sourceJournal.pins),operations.continuation.limits),'RC3_SOURCE_LIMITS_MISMATCH');
}

/** Alternate hash/check hooks exist only for isolated synthetic-file tests. */
export function createMainnetLimitsManager({approvedPolicySHA256=APPROVED_MAINNET_GAS_POLICY_SHA256,
  checkSnapshot=async options=>(await import('./mainnet-rc3.mjs')).checkRC3Deployment(options),afterWrite=async()=>{}}={}){
  async function readPolicy({root=ROOT}={}){
    root=await fs.realpath(root);const bytes=await regular(path.join(root,MAINNET_GAS_POLICY_FILE));
    need(sha(bytes)===approvedPolicySHA256,'MAINNET_GAS_POLICY_NOT_APPROVED');const policy=JSON.parse(bytes);
    need(policy.schema==='lincoln-mainnet-gas-policy/v1'&&policy.id==='20261017-gas-100x'&&policy.chainId===4663
      &&policy.approval==='user-explicit-20261017'&&eq(policy.scope,['eth','usdg'])&&policy.existingSignedTransactions==='preserve-identical-raw-and-hash'
      &&validLimits(policy.originalLimits)&&validLimits(policy.effectiveLimits)&&policy.gasPrice?.multiplierNumerator==='100'
      &&policy.gasPrice.multiplierDenominator==='1'&&policy.gasPrice.maxFeePerGasWei===policy.effectiveLimits.maxFeePerGasWei
      &&policy.effectiveLimits.budgetWei==='65000000000000000'&&policy.effectiveLimits.maxFeePerGasWei==='4000000000'
      &&policy.effectiveLimits.reserveWei===policy.originalLimits.reserveWei,'MAINNET_GAS_POLICY_INVALID');
    return {policy,policySHA256:approvedPolicySHA256,originalLimits:structuredClone(policy.originalLimits),
      effectiveLimits:structuredClone(policy.effectiveLimits),gasPrice:structuredClone(policy.gasPrice)};
  }
  async function verifyState({root=ROOT,operations,ledger,sourceJournal,ledgerDigest=digest(identity(ledger.address),ledger),
    sourceJournalDigest=digest(journalIdentity(operations.continuation.planId),sourceJournal),allowPending=false}={}){
    root=await fs.realpath(root);assertSource(operations,sourceJournal);
    const recordFile=path.join(root,MAINNET_LIMITS_RECORD_DIRECTORY,'amendment.json');
    const marker=await regular(recordFile,{privateFile:true,optional:true});
    if(marker===null){
      need(eq(limits(ledger),operations.continuation.limits)&&ledger.limitAmendments===undefined,'RC3_SOURCE_LIMITS_MISMATCH');
      return {limits:structuredClone(operations.continuation.limits),originalLimits:structuredClone(operations.continuation.limits),amendment:null,pending:false};
    }
    const approved=await readPolicy({root}),p=approved.policy;
    need(same(p.deployer,operations.deployer.address)&&same(p.deployer,ledger.address)&&p.genesisHash===operations.continuation.genesisHash
      &&ledger.genesisHash===p.genesisHash&&ledger.chainId===4663&&p.parentPlanId===operations.continuation.planId
      &&p.releaseManifestSHA256===operations.candidate.sha256&&eq(p.originalLimits,operations.continuation.limits),'MAINNET_LIMITS_POLICY_BINDING_MISMATCH');
    const stored=await readStore(recordFile,recordIdentity(approved)),record=stored.value;
    need(record.schema==='lincoln-mainnet-limits-amendment/v1'&&record.policySHA256===approved.policySHA256
      &&eq(record.originalLimits,p.originalLimits)&&eq(record.effectiveLimits,p.effectiveLimits)
      &&record.id===hash({policySHA256:approved.policySHA256,bindings:record.bindings,before:record.before,entryAnchors:record.entryAnchors,stepAnchors:record.stepAnchors})
      &&record.bindings?.chainId===4663&&same(record.bindings.address,p.deployer)&&record.bindings.genesisHash===p.genesisHash
      &&record.bindings.signerRelativePath===operations.continuation.sharedSignerRelativePath
      &&record.bindings.sourceJournalRelativePath===operations.continuation.sourceJournalRelativePath
      &&record.bindings.snapshotRelativePath===SNAPSHOT&&/^[a-f0-9]{64}$/.test(record.bindings.planId)
      &&record.before.sourceJournalStoreDigest===sourceJournalDigest,'MAINNET_LIMITS_AMENDMENT_INVALID');
    assertEntryAnchors(ledger,record.entryAnchors);
    const journalFile=path.join(root,SNAPSHOT,'.phase1-private/phase2-mainnet/deployments',record.bindings.planId,'deployment.json');
    const current=await readStore(journalFile,journalIdentity(record.bindings.planId)),journal=current.value;
    need(journal.schema==='phase2-mainnet-deployment/v1'&&journal.pins?.planId===record.bindings.planId
      &&hash(pinsWithoutLimits(journal.pins))===record.before.journalPinsWithoutLimitsSHA256,'MAINNET_LIMITS_JOURNAL_REWRITE');
    assertStepAnchors(journal,record.stepAnchors);
    need(Array.isArray(record.history)&&record.history.length>0&&record.history.length<=STAGES.length,'MAINNET_LIMITS_AMENDMENT_INVALID');
    for(const [index,item]of record.history.entries())need(eq(item,{stage:STAGES[index],signerStoreDigest:index?record.after.signerStoreDigest:record.before.signerStoreDigest,
      journalStoreDigest:index>=2?record.after.journalStoreDigest:record.before.journalStoreDigest}),'MAINNET_LIMITS_AMENDMENT_INVALID');
    need(record.stage===STAGES[record.history.length-1],'MAINNET_LIMITS_AMENDMENT_INVALID');
    const targetRef=reference(record),newLedger=eq(limits(ledger),p.effectiveLimits)&&eq(ledger.limitAmendments,[targetRef]);
    const newJournal=eq(limits(journal.pins),p.effectiveLimits)&&eq(journal.limitAmendments,[targetRef]);
    if(record.stage==='applied'){
      need(newLedger&&newJournal,'MAINNET_LIMITS_AMENDMENT_NOT_APPLIED');
      return {limits:structuredClone(p.effectiveLimits),originalLimits:structuredClone(p.originalLimits),
        amendment:{id:record.id,policySHA256:approved.policySHA256,stage:'applied',planId:record.bindings.planId},pending:false};
    }
    need(allowPending,'MAINNET_LIMITS_AMENDMENT_INCOMPLETE');
    const oldLedger=eq(limits(ledger),p.originalLimits)&&ledger.limitAmendments===undefined;
    const oldJournal=eq(limits(journal.pins),p.originalLimits)&&journal.limitAmendments===undefined;
    need((oldLedger||newLedger)&&(oldJournal||newJournal)&&(!newJournal||newLedger)
      &&ledgerDigest===(newLedger?record.after.signerStoreDigest:record.before.signerStoreDigest)
      &&current.digest===(newJournal?record.after.journalStoreDigest:record.before.journalStoreDigest)
      &&digest(identity(p.deployer),targetState(originalState(ledger,record),record))===record.after.signerStoreDigest
      &&digest(journalIdentity(record.bindings.planId),targetJournal(originalJournal(journal,record),record))===record.after.journalStoreDigest,
      'MAINNET_LIMITS_PARTIAL_STATE_INVALID');
    need((record.history.length<2||newLedger)&&(record.history.length<3||newJournal),'MAINNET_LIMITS_PARTIAL_STATE_INVALID');
    return {limits:limits(ledger),originalLimits:structuredClone(p.originalLimits),amendment:{id:record.id,policySHA256:approved.policySHA256,
      stage:record.stage,planId:record.bindings.planId},pending:true};
  }
  async function context(root){
    root=await fs.realpath(root);const approved=await readPolicy({root}),operations=JSON.parse(await regular(path.join(root,OPS)));
    const p=approved.policy,c=operations.continuation;
    need(same(operations.deployer?.address,p.deployer)&&operations.chainId===4663&&c?.planId===p.parentPlanId
      &&c.genesisHash===p.genesisHash&&operations.candidate?.sha256===p.releaseManifestSHA256&&eq(c.limits,p.originalLimits),'MAINNET_LIMITS_POLICY_BINDING_MISMATCH');
    const snapshot=path.join(root,SNAPSHOT),config=JSON.parse(await regular(path.join(snapshot,'config/phase2-mainnet.json')));
    const manifest=JSON.parse(await regular(path.join(snapshot,operations.candidate.manifest)));
    const adopted=c.adoptedDeployments.map(value=>({...value,address:getAddress(value.address)})).sort((a,b)=>a.id.localeCompare(b.id));
    const planId=hash({artifactSHA256:manifest.coreArtifactSHA256,config,routes:[],relayer:null,adoptedDeployments:adopted});
    const signerDirectory=path.join(root,c.sharedSignerRelativePath),sourceFile=path.join(root,c.sourceJournalRelativePath);
    const journalDirectory=path.join(snapshot,'.phase1-private/phase2-mainnet/deployments',planId);
    const signer=await readStore(path.join(signerDirectory,'signer.json'),identity(p.deployer));
    const source=await readStore(sourceFile,journalIdentity(c.planId)),journal=await readStore(path.join(journalDirectory,'deployment.json'),journalIdentity(planId));
    need(signer.value.schema==='phase2-mainnet-signer/v1'&&same(signer.value.address,p.deployer)&&signer.value.chainId===4663
      &&signer.value.genesisHash===p.genesisHash&&journal.value.schema==='phase2-mainnet-deployment/v1'&&journal.value.pins.planId===planId
      &&journal.value.pins.signerDirectory===signerDirectory&&same(journal.value.pins.deployer,p.deployer)
      &&journal.value.pins.genesisHash===p.genesisHash&&Array.isArray(journal.value.steps),'MAINNET_LIMITS_CONTEXT_INVALID');
    return {root,approved,operations,planId,signerDirectory,sourceFile,journalDirectory,signer,source,journal};
  }
  async function amend({root=ROOT,apply=false}={}){
    need(typeof apply==='boolean','USAGE_MAINNET_LIMITS');root=await fs.realpath(root);
    // Ordinary check rejects partial markers; only this explicit recovery path
    // requests complete validation while allowing the marker to remain pending.
    await checkSnapshot({root,allowPendingAmendment:true});
    let ctx=await context(root),status=await verifyState({root,operations:ctx.operations,ledger:ctx.signer.value,sourceJournal:ctx.source.value,
      ledgerDigest:ctx.signer.digest,sourceJournalDigest:ctx.source.digest,allowPending:true});
    if(!apply)return {policySHA256:ctx.approved.policySHA256,originalLimits:ctx.approved.originalLimits,effectiveLimits:ctx.approved.effectiveLimits,
      currentLimits:status.limits,applied:status.amendment?.stage==='applied',pending:status.pending,transactionsSigned:0,transactionsBroadcast:0};
    let journalStore,signerStore,recordStore;
    try{
      // Same lock order as the deployment engine. No lock is ever auto-cleared.
      journalStore=await openServiceStore({directory:ctx.journalDirectory,identity:journalIdentity(ctx.planId),filename:'deployment.json'});
      signerStore=await openServiceStore({directory:ctx.signerDirectory,identity:identity(ctx.approved.policy.deployer),filename:'signer.json'});
      recordStore=await openServiceStore({directory:path.join(root,MAINNET_LIMITS_RECORD_DIRECTORY),identity:recordIdentity(ctx.approved),filename:'amendment.json'});
      ctx=await context(root);
      status=await verifyState({root,operations:ctx.operations,ledger:ctx.signer.value,sourceJournal:ctx.source.value,
        ledgerDigest:ctx.signer.digest,sourceJournalDigest:ctx.source.digest,allowPending:true});
      let record=await recordStore.read();
      if(status.amendment?.stage==='applied')return {applied:true,idempotent:true,amendmentId:status.amendment.id,
        limits:status.limits,transactionsSigned:0,transactionsBroadcast:0};
      if(!record){
        need(ctx.signer.value.entries.every(entry=>['confirmed','reverted','cancelled'].includes(entry.status)),
          'MAINNET_LIMITS_ACCOUNT_PENDING_TRANSACTION');
        need(eq(limits(ctx.journal.value.pins),ctx.approved.originalLimits)&&ctx.journal.value.limitAmendments===undefined,'MAINNET_LIMITS_JOURNAL_REWRITE');
        const bindings={chainId:4663,address:ctx.approved.policy.deployer,genesisHash:ctx.approved.policy.genesisHash,
          signerRelativePath:ctx.operations.continuation.sharedSignerRelativePath,sourceJournalRelativePath:ctx.operations.continuation.sourceJournalRelativePath,
          snapshotRelativePath:SNAPSHOT,planId:ctx.planId};
        const before={signerStoreDigest:ctx.signer.digest,journalStoreDigest:ctx.journal.digest,sourceJournalStoreDigest:ctx.source.digest,
          entriesSHA256:hash(ctx.signer.value.entries),journalPinsWithoutLimitsSHA256:hash(pinsWithoutLimits(ctx.journal.value.pins))};
        const entryAnchors=ctx.signer.value.entries.map(entryAnchor),steps=stepAnchors(ctx.journal.value);
        record={schema:'lincoln-mainnet-limits-amendment/v1',policySHA256:ctx.approved.policySHA256,bindings,before,entryAnchors,stepAnchors:steps,
          originalLimits:ctx.approved.originalLimits,effectiveLimits:ctx.approved.effectiveLimits};
        record.id=hash({policySHA256:record.policySHA256,bindings,before,entryAnchors,stepAnchors:steps});
        record.after={signerStoreDigest:digest(identity(record.bindings.address),targetState(ctx.signer.value,record)),
          journalStoreDigest:digest(journalIdentity(ctx.planId),targetJournal(ctx.journal.value,record))};
        record.stage='prepared';record.history=[{stage:'prepared',signerStoreDigest:record.before.signerStoreDigest,journalStoreDigest:record.before.journalStoreDigest}];
        await recordStore.write(record);await afterWrite('prepared');
      }
      const advance=async stage=>{
        const index=STAGES.indexOf(stage);if(record.history.length>index)return;
        need(record.history.length===index,'MAINNET_LIMITS_AMENDMENT_INVALID');record.stage=stage;
        record.history.push({stage,signerStoreDigest:record.after.signerStoreDigest,journalStoreDigest:index>=2?record.after.journalStoreDigest:record.before.journalStoreDigest});
        await recordStore.write(record);await afterWrite(stage);
      };
      if(eq(limits(ctx.signer.value),record.originalLimits)){
        const next=targetState(ctx.signer.value,record);need(hash(next.entries)===record.before.entriesSHA256,'MAINNET_LIMITS_ENTRY_REWRITE');
        await signerStore.write(next);await afterWrite('signer-written');
      }
      await advance('ledger-updated');
      if(eq(limits(ctx.journal.value.pins),record.originalLimits)){await journalStore.write(targetJournal(ctx.journal.value,record));await afterWrite('journal-written');}
      await advance('journal-updated');await advance('applied');
      const final=await context(root);const verified=await verifyState({root,operations:final.operations,ledger:final.signer.value,sourceJournal:final.source.value,
        ledgerDigest:final.signer.digest,sourceJournalDigest:final.source.digest});
      return {applied:true,idempotent:false,amendmentId:record.id,limits:verified.limits,transactionsSigned:0,transactionsBroadcast:0};
    }finally{try{await recordStore?.close();}finally{try{await signerStore?.close();}finally{await journalStore?.close();}}}
  }
  async function verifyRecoveryContext({root=ROOT,state}={}){
    const operations=JSON.parse(await regular(path.join(root,OPS))),source=await readStore(path.join(root,operations.continuation.sourceJournalRelativePath),journalIdentity(operations.continuation.planId));
    return verifyState({root,operations,ledger:state,sourceJournal:source.value,sourceJournalDigest:source.digest});
  }
  return {readPolicy,verifyState,amend,verifyRecoveryContext};
}
const manager=createMainnetLimitsManager();
export const readMainnetGasPolicy=manager.readPolicy,verifyMainnetLimitsState=manager.verifyState,
  amendMainnetLimits=manager.amend,verifyMainnetRecoveryLimits=manager.verifyRecoveryContext;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2);need(args.length===1&&['--status','--apply'].includes(args[0]),'USAGE_MAINNET_LIMITS');
    console.log(JSON.stringify(await amendMainnetLimits({apply:args[0]==='--apply'}),null,2));}
  catch(error){console.error(JSON.stringify({error:error.code??'MAINNET_LIMITS_FAILED',transactionsSigned:0,transactionsBroadcast:0}));process.exitCode=1;}
}
