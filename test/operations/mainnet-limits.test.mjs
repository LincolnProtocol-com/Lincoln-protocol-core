// SPDX-License-Identifier: Apache-2.0
// Synthetic journals only. No RPC, keystore, signing or broadcasts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {getAddress} from 'viem';
import {createMainnetLimitsManager,readMainnetGasPolicy,MAINNET_GAS_POLICY_FILE,MAINNET_LIMITS_RECORD_DIRECTORY} from '../../scripts/operations/mainnet-limits.mjs';
import {createMainnetRC3Operator,configureRC3Operations,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST,RC3_RELEASE_SHA256,
  RC3_OPERATIONS_FILE,DEFAULT_RC3_DEPLOYMENT_DIRECTORY} from '../../scripts/operations/mainnet-rc3.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hash=value=>sha(JSON.stringify(value));
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const envelope=(identity,value)=>{const body={schema:'phase1-service-store/v1',identity,value};return encode({...body,digest:hash(body)});};
const blob=bytes=>sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]));
const fileBlob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const LIMIT_KEYS=['budgetWei','maxFeePerGasWei','reserveWei'];
const limits=value=>Object.fromEntries(LIMIT_KEYS.map(key=>[key,value[key]]));
async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-limits-amendment-')));
  const operations=JSON.parse(await fs.readFile(path.join(ROOT,RC3_OPERATIONS_FILE)));
  const config=JSON.parse(await fs.readFile(path.join(ROOT,RC3_RELEASE_DIRECTORY,'config/phase2-mainnet.json')));
  const manifest=await fs.readFile(path.join(ROOT,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST));
  const policyBytes=await fs.readFile(path.join(ROOT,MAINNET_GAS_POLICY_FILE)),policy=JSON.parse(policyBytes);
  const sourceMap=new Map([['config/phase2-mainnet.json',encode(config)],[RC3_RELEASE_MANIFEST,manifest],['src/public-marker.mjs',Buffer.from('export const synthetic=true;\n')]]);
  async function put(file,bytes,mode=0o600){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{mode});await fs.chmod(file,mode);}
  for(const [relative,bytes]of sourceMap)await put(path.join(root,RC3_RELEASE_DIRECTORY,relative),bytes,0o644);
  await put(path.join(root,RC3_OPERATIONS_FILE),encode(operations),0o644);await put(path.join(root,MAINNET_GAS_POLICY_FILE),policyBytes,0o644);
  const c=operations.continuation,signerDirectory=path.join(root,c.sharedSignerRelativePath),signerFile=path.join(signerDirectory,'signer.json');
  const signerIdentity=`lincoln-mainnet-signer:4663:${operations.deployer.address.toLowerCase()}`;
  const entries=c.adoptedDeployments.map((anchor,index)=>{
    const intent={to:null,data:'0x600'+String(index),value:'0'};
    return {id:anchor.sourceReservationId,...intent,intentDigest:hash(intent),hash:anchor.hash,nonce:anchor.nonce,chainId:4663,
      gas:'100',gasPrice:'20000000',feeCeilingWei:'2000000000',feeWei:'1000000000',status:'confirmed',
      rawTransaction:'SYNTHETIC_RAW_DO_NOT_COPY_'+String(index),contractAddress:anchor.address};
  });
  const state={schema:'phase2-mainnet-signer/v1',chainId:4663,address:operations.deployer.address,genesisHash:c.genesisHash,...c.limits,entries};
  const source={schema:'phase2-mainnet-deployment/v1',pins:{planId:c.planId,deployer:operations.deployer.address,genesisHash:c.genesisHash,...c.limits},
    status:'deploying',steps:c.adoptedDeployments.map((anchor,index)=>({id:anchor.id,reservationId:anchor.sourceReservationId,nonce:anchor.nonce,
      deployer:operations.deployer.address,data:entries[index].data,address:anchor.address,hash:anchor.hash,status:'verified'}))};
  const sourceFile=path.join(root,c.sourceJournalRelativePath),sourceIdentity=`lincoln-mainnet-deployment:${c.planId}`;
  await put(signerFile,envelope(signerIdentity,state));await put(sourceFile,envelope(sourceIdentity,source));
  const fault={stage:null,triggered:false},manager=createMainnetLimitsManager({checkSnapshot:options=>operator.check(options),
    afterWrite:async stage=>{if(fault.stage===stage&&!fault.triggered){fault.triggered=true;throw Object.assign(new Error('SYNTHETIC_CRASH'),{code:'SYNTHETIC_CRASH'});}}});
  const archive={commit:'12'.repeat(20),tree:'34'.repeat(20),files:[...sourceMap].map(([relative,bytes])=>({path:relative,mode:'100644',blob:fileBlob(bytes)})),
    extract:async output=>{for(const [relative,bytes]of sourceMap)await put(path.join(output,relative),bytes,0o644);}};
  const operator=createMainnetRC3Operator({verifyCandidate:async()=>{},archiveProvider:async()=>archive,verifyLimitsState:manager.verifyState});
  const prepared=await operator.prepare({root}),snapshot=prepared.directory;
  const effective=configureRC3Operations({config,operations}),adopted=c.adoptedDeployments.map(value=>({...value,address:getAddress(value.address)})).sort((a,b)=>a.id.localeCompare(b.id));
  const planId=hash({artifactSHA256:JSON.parse(manifest).coreArtifactSHA256,config:effective,routes:[],relayer:null,adoptedDeployments:adopted});
  const intent={to:null,data:'0x60026000f3',value:'0'},entry={id:`deploy:${planId}:Phase2ASPJoinSplitVerifier`,...intent,intentDigest:hash(intent),
    hash:'0x'+'44'.repeat(32),nonce:'2',chainId:4663,gas:'1000000',gasPrice:'20082000',feeCeilingWei:'20082000000000',feeWei:'7000000000000',
    status:'confirmed',rawTransaction:'SYNTHETIC_RAW_DO_NOT_COPY_2'};
  state.entries.push(entry);await put(signerFile,envelope(signerIdentity,state));
  const journal={schema:'phase2-mainnet-deployment/v1',status:'deploying',pins:{planId,artifactSHA256:JSON.parse(manifest).coreArtifactSHA256,
    sourceSetSHA256:'77'.repeat(32),genesisHash:c.genesisHash,deployer:operations.deployer.address,provider:effective.provider.address,relayer:null,
    ...c.limits,signerDirectory,adoptedDeployments:adopted},steps:[...adopted.map((anchor,index)=>({id:anchor.id,kind:'reused',reservationId:anchor.sourceReservationId,
      sourceReservationId:anchor.sourceReservationId,sourcePlanId:c.planId,deployer:operations.deployer.address,data:entries[index].data,nonce:anchor.nonce,
      address:anchor.address,hash:anchor.hash,status:'verified'})),{id:'Phase2ASPJoinSplitVerifier',reservationId:entry.id,deployer:operations.deployer.address,
      data:entry.data,nonce:'2',address:'0x'+'56'.repeat(20),status:'prepared'}]};
  const journalFile=path.join(snapshot,'.phase1-private/phase2-mainnet/deployments',planId,'deployment.json'),journalIdentity=`lincoln-mainnet-deployment:${planId}`;
  await put(journalFile,envelope(journalIdentity,journal));
  const recordFile=path.join(root,MAINNET_LIMITS_RECORD_DIRECTORY,'amendment.json');
  const read=async file=>JSON.parse(await fs.readFile(file)),readValue=async file=>(await read(file)).value;
  const rewrite=async(file,mutate)=>{const old=await read(file);mutate(old.value);await put(file,envelope(old.identity,old.value));};
  return {root,operations,config,policy,policyBytes,state,journal,source,entry,manager,operator,signerFile,sourceFile,journalFile,recordFile,snapshot,
    metadataFile:path.join(snapshot,'operations-snapshot.json'),fault,read,readValue,rewrite,put,
    verify:async()=>manager.verifyRecoveryContext({root,state:await readValue(signerFile)}),cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
async function use(action){const f=await fixture();try{return await action(f);}finally{await f.cleanup();}}

test('approved policy is fixed to user-authorized 100x, 0.065 ETH cumulative budget, 4 gwei cap and unchanged reserve',async()=>{
  const result=await readMainnetGasPolicy({root:ROOT});
  assert.deepEqual(result.gasPrice,{multiplierNumerator:'100',multiplierDenominator:'1',maxFeePerGasWei:'4000000000'});
  assert.deepEqual(result.effectiveLimits,{budgetWei:'65000000000000000',maxFeePerGasWei:'4000000000',reserveWei:'3000000000000000'});
});
test('status is read-only and leaves the original ledger, both journals and snapshot untouched',()=>use(async f=>{
  const before=await Promise.all([f.signerFile,f.sourceFile,f.journalFile,f.metadataFile].map(file=>fs.readFile(file)));
  const status=await f.manager.amend({root:f.root});assert.equal(status.applied,false);assert.equal(status.pending,false);
  assert.deepEqual(status.currentLimits,f.policy.originalLimits);assert.equal(status.transactionsBroadcast,0);assert.equal(status.transactionsSigned,0);
  assert.deepEqual(await Promise.all([f.signerFile,f.sourceFile,f.journalFile,f.metadataFile].map(file=>fs.readFile(file))),before);
  await assert.rejects(fs.access(f.recordFile),{code:'ENOENT'});
}));
test('explicit apply changes only current limits and records durable before/after history without copying signed bytes',()=>use(async f=>{
  const entries=structuredClone(f.state.entries),source=await fs.readFile(f.sourceFile),metadata=await fs.readFile(f.metadataFile),ops=await fs.readFile(path.join(f.root,RC3_OPERATIONS_FILE));
  const beforeSigner=await f.read(f.signerFile),beforeJournal=await f.read(f.journalFile);
  const applied=await f.manager.amend({root:f.root,apply:true});assert.equal(applied.applied,true);assert.equal(applied.idempotent,false);
  const state=await f.readValue(f.signerFile),journal=await f.readValue(f.journalFile),record=await f.readValue(f.recordFile);
  assert.deepEqual(limits(state),f.policy.effectiveLimits);assert.deepEqual(limits(journal.pins),f.policy.effectiveLimits);assert.deepEqual(state.entries,entries);
  assert.deepEqual(await fs.readFile(f.sourceFile),source);assert.deepEqual(await fs.readFile(f.metadataFile),metadata);assert.deepEqual(await fs.readFile(path.join(f.root,RC3_OPERATIONS_FILE)),ops);
  assert.equal(record.before.signerStoreDigest,beforeSigner.digest);assert.equal(record.before.journalStoreDigest,beforeJournal.digest);
  assert.equal(record.after.signerStoreDigest,(await f.read(f.signerFile)).digest);assert.equal(record.after.journalStoreDigest,(await f.read(f.journalFile)).digest);
  assert.deepEqual(record.history.map(item=>item.stage),['prepared','ledger-updated','journal-updated','applied']);
  assert.equal(JSON.stringify(record).includes('SYNTHETIC_RAW_DO_NOT_COPY'),false);assert.equal(record.before.entriesSHA256,hash(entries));
  const expected={...f.journal,pins:{...f.journal.pins,...f.policy.effectiveLimits},limitAmendments:journal.limitAmendments};assert.deepEqual(journal,expected);
  const checked=await f.operator.check({root:f.root,limits:f.policy.effectiveLimits});assert.equal(checked.readiness.blocked,false);
  assert.deepEqual(checked.limits,f.policy.effectiveLimits);assert.deepEqual(checked.originalLimits,f.policy.originalLimits);assert.equal(checked.limitsAmendment.stage,'applied');
  await assert.rejects(()=>f.operator.check({root:f.root,limits:f.policy.originalLimits}),{code:'RC3_EXPLICIT_LIMITS_MUST_MATCH_ORIGINAL'});
}));
test('reapplying the same completed policy is a byte-for-byte no-op',()=>use(async f=>{
  await f.manager.amend({root:f.root,apply:true});
  const files=[f.signerFile,f.sourceFile,f.journalFile,f.recordFile,f.metadataFile],before=await Promise.all(files.map(file=>fs.readFile(file)));
  const result=await f.manager.amend({root:f.root,apply:true});assert.equal(result.idempotent,true);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);assert.equal((await f.manager.amend({root:f.root})).applied,true);
}));
test('every write boundary is explicitly recoverable, while normal deployment and recovery fail closed on partial markers',async()=>{
  for(const stage of ['prepared','signer-written','ledger-updated','journal-written','journal-updated','applied'])await use(async f=>{
    const entries=structuredClone(f.state.entries),source=await fs.readFile(f.sourceFile);f.fault.stage=stage;
    await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'SYNTHETIC_CRASH'});
    const record=await f.readValue(f.recordFile),alreadyApplied=record.stage==='applied';
    if(!alreadyApplied){
      await assert.rejects(()=>f.operator.check({root:f.root}),{code:'MAINNET_LIMITS_AMENDMENT_INCOMPLETE'});
      await assert.rejects(()=>f.verify(),{code:'MAINNET_LIMITS_AMENDMENT_INCOMPLETE'});
      assert.equal((await f.manager.amend({root:f.root})).pending,true);
    }
    const result=await f.manager.amend({root:f.root,apply:true});assert.equal(result.applied,true);
    assert.deepEqual((await f.readValue(f.signerFile)).entries,entries);assert.deepEqual(await fs.readFile(f.sourceFile),source);
    assert.equal((await f.readValue(f.recordFile)).history.length,4);assert.deepEqual((await f.verify()).limits,f.policy.effectiveLimits);
  });
});
test('pending transactions cannot start a fresh amendment or change any ledger limits',()=>use(async f=>{
  await f.rewrite(f.signerFile,state=>{state.entries[2].status='unknown';});const before=await fs.readFile(f.signerFile);
  await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'MAINNET_LIMITS_ACCOUNT_PENDING_TRANSACTION'});
  assert.deepEqual(await fs.readFile(f.signerFile),before);await assert.rejects(fs.access(f.recordFile),{code:'ENOENT'});
}));
test('unapproved policy bytes, changed account or source history cannot authorize a budget amendment',async()=>{
  for(const [mutate,code]of [
    [async f=>{const p=structuredClone(f.policy);p.effectiveLimits.budgetWei='999999999999999999';await f.put(path.join(f.root,MAINNET_GAS_POLICY_FILE),encode(p),0o644);},'MAINNET_GAS_POLICY_NOT_APPROVED'],
    [async f=>{await f.rewrite(f.signerFile,state=>{state.address='0x'+'19'.repeat(20);});},'RC3_SOURCE_IDENTITY_MISMATCH'],
    [async f=>{await f.rewrite(f.sourceFile,journal=>{journal.pins.budgetWei='9';});},'RC3_SOURCE_LIMITS_MISMATCH']
  ])await use(async f=>{await mutate(f);await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code});await assert.rejects(fs.access(f.recordFile),{code:'ENOENT'});});
});
test('applied proofs reject removed, reordered or rewritten original signed intents and payloads',async()=>{
  for(const mutate of [state=>{state.entries[2].gasPrice='20083000';},state=>{state.entries[2].rawTransaction='REWRITTEN';},
    state=>{state.entries[2].hash='0x'+'aa'.repeat(32);},state=>{state.entries.pop();},state=>{[state.entries[1],state.entries[2]]=[state.entries[2],state.entries[1]];},
    state=>{state.entries[2].data='0xdeadbeef';state.entries[2].intentDigest=hash({to:null,data:state.entries[2].data,value:'0'});}])await use(async f=>{
      await f.manager.amend({root:f.root,apply:true});await f.rewrite(f.signerFile,mutate);
      await assert.rejects(()=>f.operator.check({root:f.root}),{code:'MAINNET_LIMITS_ENTRY_REWRITE'});
    });
});
test('new limits require the exact completed proof and current journal amendment, while original journal bytes remain bound',async()=>{
  for(const [mutate,code]of [
    [f=>fs.rm(f.recordFile),'RC3_SOURCE_LIMITS_MISMATCH'],
    [f=>f.rewrite(f.journalFile,journal=>{journal.pins.reserveWei='0';}),'MAINNET_LIMITS_AMENDMENT_NOT_APPLIED'],
    [f=>f.rewrite(f.journalFile,journal=>{journal.pins.provider='0x'+'19'.repeat(20);}),'MAINNET_LIMITS_JOURNAL_REWRITE'],
    [f=>f.rewrite(f.journalFile,journal=>{journal.steps[2].data='0xdeadbeef';}),'MAINNET_LIMITS_JOURNAL_REWRITE'],
    [f=>f.rewrite(f.sourceFile,journal=>{journal.extra='source history changed';}),'MAINNET_LIMITS_AMENDMENT_INVALID'],
    [f=>f.rewrite(f.recordFile,record=>{record.before.signerStoreDigest='99'.repeat(32);}),'MAINNET_LIMITS_AMENDMENT_INVALID'],
    [f=>f.rewrite(f.signerFile,state=>{delete state.limitAmendments;}),'MAINNET_LIMITS_AMENDMENT_NOT_APPLIED']
  ])await use(async f=>{await f.manager.amend({root:f.root,apply:true});await mutate(f);await assert.rejects(()=>f.operator.check({root:f.root}),{code});});
});
test('an unrecognized partial limit state cannot be automatically repaired or accepted',()=>use(async f=>{
  f.fault.stage='signer-written';await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'SYNTHETIC_CRASH'});
  await f.rewrite(f.signerFile,state=>{state.budgetWei='65000000000000001';});
  await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'MAINNET_LIMITS_PARTIAL_STATE_INVALID'});
}));
test('completed proof permits later settlement metadata and append-only new entries without freezing the entire ledger digest',()=>use(async f=>{
  await f.manager.amend({root:f.root,apply:true});
  await f.rewrite(f.signerFile,state=>{
    state.entries[2].blockNumber='123';state.entries[2].blockHash='0x'+'88'.repeat(32);state.entries[2].gasUsed='300000';
    const intent={to:null,data:'0x60036000f3',value:'0'};state.entries.push({id:'subsequent-synthetic-intent',...intent,intentDigest:hash(intent),nonce:'3',chainId:4663,
      gas:'100',gasPrice:'2000000000',feeCeilingWei:'200000000000',feeWei:'100000000000',status:'confirmed'});
  });
  assert.equal((await f.operator.check({root:f.root,limits:f.policy.effectiveLimits})).readiness.blocked,false);
  assert.deepEqual((await f.verify()).limits,f.policy.effectiveLimits);
}));
test('held deployment locks and linked amendment records are never auto-cleared or followed',async()=>{
  await use(async f=>{
    const lock=path.join(path.dirname(f.journalFile),'.service.lock');await f.put(lock,Buffer.from('OPERATOR_OWNED_LOCK'));
    await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'STORE_LOCKED'});assert.equal(await fs.readFile(lock,'utf8'),'OPERATOR_OWNED_LOCK');
  });
  await use(async f=>{
    await fs.mkdir(path.dirname(f.recordFile),{recursive:true,mode:0o700});await fs.symlink(f.signerFile,f.recordFile);
    await assert.rejects(()=>f.manager.amend({root:f.root,apply:true}),{code:'MAINNET_LIMITS_FILE_INVALID'});
  });
});
