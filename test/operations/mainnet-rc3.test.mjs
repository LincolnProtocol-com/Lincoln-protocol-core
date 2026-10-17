// SPDX-License-Identifier: Apache-2.0
// Synthetic public capsules and local journals only. No RPC, wallet or mainnet I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getAddress,getContractAddress,encodeDeployData} from 'viem';
import {deploymentSpecs,linkMainnetBytecode,normalizeAdoptedDeployments} from '../../releases/rc3/scripts/phase2-mainnet/deploy.mjs';
import {createMainnetRC3Operator,configureRC3Operations,readRC3Archive,RC3_CANDIDATE_TAG,RC3_RELEASE_DIRECTORY,
  RC3_RELEASE_MANIFEST,RC3_OPERATIONS_FILE,DEFAULT_RC3_DEPLOYMENT_DIRECTORY,PARENT_PLAN_ID} from '../../scripts/operations/mainnet-rc3.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const encode=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const address=()=>getAddress('0x'+randomBytes(20).toString('hex'));
const envelope=(identity,value)=>{const body={schema:'phase1-service-store/v1',identity,value};return encode({...body,digest:sha(JSON.stringify(body))});};
async function fixture({fullCapsule=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-rc3-operator-test-'))),deployer=address();
  const buildBytes=fullCapsule?await fs.readFile(path.join(ROOT,RC3_RELEASE_DIRECTORY,'artifacts/phase2-mainnet/contracts.json')):null;
  const config=fullCapsule?JSON.parse(await fs.readFile(path.join(ROOT,RC3_RELEASE_DIRECTORY,'config/phase2-mainnet.json'))):
    {chain:{id:4663},deployer:{address:null,signingAccount:null},guardian:{address:address()},provider:{address:address()},limits:{gasBudgetWei:null}};
  const manifest=encode({schema:'synthetic-capsule-for-operator-tests',productionReady:false,...(buildBytes?{coreArtifactSHA256:sha(buildBytes)}:{})}),releaseSHA256=sha(manifest);
  const base='.phase1-private/mainnet-deployments/rc2-eth-usdg/.phase1-private/phase2-mainnet';
  const operations={schema:'lincoln-mainnet-operations/v2',chainId:4663,
    candidate:{tag:RC3_CANDIDATE_TAG,manifest:RC3_RELEASE_MANIFEST,sha256:releaseSHA256},
    deployer:{address:deployer,signingAccount:'synthetic-operator',addressSource:'user-supplied',keystoreOwnershipVerified:false},signingEnabled:false,
    continuation:{parentTag:'v0.1.0-rc.2',planId:PARENT_PLAN_ID,genesisHash:'0x'+randomBytes(32).toString('hex'),
      sharedSignerRelativePath:`${base}/signers/4663-${deployer.toLowerCase()}`,sourceJournalRelativePath:`${base}/deployments/${PARENT_PLAN_ID}/deployment.json`,
      limits:{budgetWei:'1100000000000000',maxFeePerGasWei:'40000000',reserveWei:'3000000000000000'},
      adoptedDeployments:['PoseidonT3','PoseidonT4'].map((id,i)=>({id,sourceReservationId:`deploy:${PARENT_PLAN_ID}:${id}`,
        hash:'0x'+randomBytes(32).toString('hex'),address:getContractAddress({from:deployer,nonce:BigInt(i)}),nonce:String(i)}))}};
  const sources=new Map([['config/phase2-mainnet.json',encode(config)],[RC3_RELEASE_MANIFEST,manifest],['src/public-marker.mjs',Buffer.from('export const publicMarker=true;\n')]]);
  if(buildBytes)sources.set(config.productionArtifacts.build,buildBytes);
  const put=async(file,bytes,mode=0o644)=>{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{mode});await fs.chmod(file,mode);};
  for(const [relative,bytes]of sources)await put(path.join(root,RC3_RELEASE_DIRECTORY,relative),bytes);
  await put(path.join(root,RC3_OPERATIONS_FILE),encode(operations));
  const marker='SYNTHETIC_RAW_MARKER_'+randomBytes(8).toString('hex');
  const state={schema:'phase2-mainnet-signer/v1',chainId:4663,address:deployer,genesisHash:operations.continuation.genesisHash,...operations.continuation.limits,
    entries:operations.continuation.adoptedDeployments.map((anchor,i)=>{
      const artifact=buildBytes?JSON.parse(buildBytes)[anchor.id]:null;
      const intent={to:null,data:artifact?encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,{}),args:[]}):'0x600'+String(i),value:'0'};
      return {id:anchor.sourceReservationId,...intent,intentDigest:sha(JSON.stringify(intent)),hash:anchor.hash,nonce:anchor.nonce,chainId:4663,
        gas:'100',gasPrice:'20000000',feeCeilingWei:'2000000000',status:i?'unknown':'confirmed',rawTransaction:marker,
        ...(i?{}:{contractAddress:anchor.address})};})};
  const journal={schema:'phase2-mainnet-deployment/v1',pins:{planId:PARENT_PLAN_ID,deployer,genesisHash:state.genesisHash,...operations.continuation.limits},
    steps:operations.continuation.adoptedDeployments.map((anchor,i)=>({id:anchor.id,reservationId:anchor.sourceReservationId,nonce:anchor.nonce,deployer,data:state.entries[i].data,
      address:anchor.address,...(i?{}:{hash:anchor.hash}),status:i?'prepared':'verified'}))};
  const signer=path.join(root,operations.continuation.sharedSignerRelativePath,'signer.json'),journalPath=path.join(root,operations.continuation.sourceJournalRelativePath);
  const writeState=()=>put(signer,envelope(`lincoln-mainnet-signer:4663:${deployer.toLowerCase()}`,state),0o600);
  const writeJournal=()=>put(journalPath,envelope(`lincoln-mainnet-deployment:${PARENT_PLAN_ID}`,journal),0o600);
  await writeState();await writeJournal();
  const files=[...sources].map(([relative,bytes])=>({path:relative,mode:'100644',blob:blob(bytes)}));
  let checks=0,extracts=0;
  const archive={commit:'12'.repeat(20),tree:'34'.repeat(20),files,async extract(output){extracts++;for(const [relative,bytes]of sources)await put(path.join(output,relative),bytes);}};
  const operator=createMainnetRC3Operator({verifyCandidate:async()=>{checks++;},archiveProvider:async()=>archive,releaseSHA256});
  return {root,config,operations,state,journal,signer,journalPath,marker,archive,sources,operator,releaseSHA256,put,writeState,writeJournal,
    counts:()=>({checks,extracts}),cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
async function use(fn){const f=await fixture();try{await fn(f);}finally{await f.cleanup();}}

async function unsignedFixture(){
  const f=await fixture({fullCapsule:true});
  f.state.entries[1].status='confirmed';f.state.entries[1].contractAddress=f.operations.continuation.adoptedDeployments[1].address;await f.writeState();
  const prepared=await f.operator.prepare({root:f.root});
  const effective=configureRC3Operations({config:f.config,operations:f.operations,releaseSHA256:f.releaseSHA256});
  const artifacts=JSON.parse(f.sources.get(f.config.productionArtifacts.build)),artifactSHA256=sha(f.sources.get(f.config.productionArtifacts.build));
  const adopted=normalizeAdoptedDeployments(f.operations.continuation.adoptedDeployments);
  const planId=sha(JSON.stringify({artifactSHA256,config:effective,routes:[],relayer:null,adoptedDeployments:adopted}));
  const spec=deploymentSpecs({config:effective,routes:[]})[2],artifact=artifacts[spec.contract];
  const data=encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,{}),args:[]});
  const entry={id:`deploy:${planId}:${spec.id}`,to:null,data,value:'0',intentDigest:sha(JSON.stringify({to:null,data,value:'0'})),
    chainId:4663,nonce:'2',gas:spec.gasCap,gasPrice:'20000000',feeCeilingWei:String(BigInt(spec.gasCap)*20000000n),status:'prepared'};
  f.state.entries.push(entry);await f.writeState();
  const journal={schema:'phase2-mainnet-deployment/v1',status:'deploying',pins:{planId,artifactSHA256,sourceSetSHA256:artifacts._meta.sourceSetSHA256,
    genesisHash:f.operations.continuation.genesisHash,deployer:effective.deployer.address,provider:effective.provider.address,relayer:null,
    ...f.operations.continuation.limits,signerDirectory:path.dirname(f.signer),adoptedDeployments:adopted},
    steps:adopted.map((a,i)=>({id:a.id,kind:'reused',reservationId:a.sourceReservationId,sourceReservationId:a.sourceReservationId,sourcePlanId:PARENT_PLAN_ID,
      deployer:effective.deployer.address,data:f.state.entries[i].data,nonce:a.nonce,address:a.address,hash:a.hash,status:'verified',runtime:{synthetic:true}}))};
  journal.steps.push({id:spec.id,reservationId:entry.id,deployer:effective.deployer.address,data,nonce:'2',address:getContractAddress({from:effective.deployer.address,nonce:2n}),status:'prepared'});
  const file=path.join(prepared.directory,'.phase1-private/phase2-mainnet/deployments',planId,'deployment.json');
  const writeCurrentJournal=()=>f.put(file,envelope(`lincoln-mainnet-deployment:${planId}`,journal),0o600);await writeCurrentJournal();
  return {...f,entry,currentJournal:journal,writeCurrentJournal};
}
async function useUnsigned(fn){const f=await unsignedFixture();try{await fn(f);}finally{await f.cleanup();}}

test('the current frozen ETH/USDG plan can resume its exact unsigned prepared reservation without mutating either ledger',()=>useUnsigned(async f=>{
  const before=await fs.readFile(f.signer),originalJournal=await fs.readFile(f.journalPath);
  const checked=await f.operator.check({root:f.root});
  assert.equal(checked.readiness.blocked,false);assert.equal(checked.readiness.unsignedPreparedResume,true);
  assert.equal(checked.keysAccessed,false);assert.equal(checked.transactionsBroadcast,0);
  assert.deepEqual(await fs.readFile(f.signer),before);assert.deepEqual(await fs.readFile(f.journalPath),originalJournal);
}));

test('foreign prepared reservations remain blocked even when an unrelated current-plan journal exists',()=>useUnsigned(async f=>{
  f.entry.id=`deploy:${'ef'.repeat(32)}:Phase2ASPJoinSplitVerifier`;await f.writeState();
  const checked=await f.operator.check({root:f.root});
  assert.equal(checked.readiness.blocked,true);assert.equal(checked.readiness.unsignedPreparedResume,false);
  assert.equal(checked.readiness.unsignedResumeBlockedReason,'RC3_UNSIGNED_RESUME_FOREIGN_PLAN');
}));

test('a same-plan prepared reservation with changed CREATE intent or journal pins remains blocked',()=>useUnsigned(async f=>{
  const originalData=f.entry.data;f.entry.data='0xdeadbeef';f.entry.intentDigest=sha(JSON.stringify({to:null,data:f.entry.data,value:'0'}));
  f.currentJournal.steps.at(-1).data=f.entry.data;await f.writeState();await f.writeCurrentJournal();
  let checked=await f.operator.check({root:f.root});assert.equal(checked.readiness.blocked,true);
  assert.equal(checked.readiness.unsignedResumeBlockedReason,'RC3_UNSIGNED_RESUME_INTENT_MISMATCH');
  f.entry.data=originalData;f.entry.intentDigest=sha(JSON.stringify({to:null,data:originalData,value:'0'}));f.currentJournal.steps.at(-1).data=originalData;
  f.currentJournal.pins.reserveWei='0';await f.writeState();await f.writeCurrentJournal();
  checked=await f.operator.check({root:f.root});assert.equal(checked.readiness.blocked,true);
  assert.equal(checked.readiness.unsignedResumeBlockedReason,'RC3_UNSIGNED_RESUME_JOURNAL_MISMATCH');
}));

test('prepared reservations containing any signed hash or raw bytes cannot use unsigned continuation',()=>useUnsigned(async f=>{
  for(const field of ['hash','rawTransaction']){
    f.entry[field]=field==='hash'?'0x'+'42'.repeat(32):'SYNTHETIC_RAW_DO_NOT_BROADCAST';await f.writeState();
    const checked=await f.operator.check({root:f.root});assert.equal(checked.readiness.blocked,true);
    assert.equal(checked.readiness.unsignedResumeBlockedReason,'RC3_UNSIGNED_RESUME_SIGNED_OR_FOREIGN');
    delete f.entry[field];
  }
}));

test('offline RC.3 plan does not read a private ledger or materialize a snapshot',()=>use(async f=>{
  await fs.rm(path.join(f.root,'.phase1-private'),{recursive:true});
  const result=await f.operator.plan({root:f.root});
  assert.equal(result.privateFilesRead,false);assert.equal(result.transactionsBroadcast,0);assert.equal(f.counts().extracts,0);
  assert.deepEqual(result.scope,['ETH','USDG']);assert.equal(result.candidate.tag,'v0.1.0-rc.3');
}));

test('preparation retains the same physical account journal, never copies signed bytes, and preserves unknown T4 as blocked',()=>use(async f=>{
  const before=await fs.readFile(f.signer),journalBefore=await fs.readFile(f.journalPath);
  const prepared=await f.operator.prepare({root:f.root});
  assert.equal(prepared.sharedSignerDirectory,path.dirname(f.signer));assert.equal(prepared.readiness.code,'ACCOUNT_UNKNOWN_BROADCAST');
  assert.equal(prepared.originalLedgerCopied,false);assert.equal(prepared.rawSignedTransactionsCopied,false);assert.equal(prepared.transactionsBroadcast,0);
  assert.deepEqual(prepared.adoptedDeployments,f.operations.continuation.adoptedDeployments);
  assert.equal(JSON.stringify(prepared).includes(f.marker),false);
  assert.deepEqual(await fs.readFile(f.signer),before);assert.deepEqual(await fs.readFile(f.journalPath),journalBefore);
  await assert.rejects(fs.access(path.join(prepared.directory,'.phase1-private')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(prepared.directory,'signer.json')),{code:'ENOENT'});
  const effective=JSON.parse(await fs.readFile(path.join(prepared.directory,'config/phase2-mainnet.json')));
  const expected=structuredClone(f.config);expected.deployer=effective.deployer;assert.deepEqual(effective,expected);
  const checked=await f.operator.check({root:f.root});assert.equal(checked.readiness.blocked,true);assert.equal(checked.checkedPublicFiles,3);
}));

test('existing snapshot is never overwritten or deleted',()=>use(async f=>{
  const result=await f.operator.prepare({root:f.root}),sentinel=path.join(result.directory,'preserve-existing-journal');
  await fs.writeFile(sentinel,'existing operator history');
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SNAPSHOT_ALREADY_EXISTS'});
  assert.equal(await fs.readFile(sentinel,'utf8'),'existing operator history');assert.equal(f.counts().extracts,1);
}));

test('stable adoption metadata remains valid when the original account recovery confirms T4',()=>use(async f=>{
  const result=await f.operator.prepare({root:f.root}),metadata=await fs.readFile(path.join(result.directory,'operations-snapshot.json'));
  f.state.entries[1].status='confirmed';f.state.entries[1].contractAddress=f.operations.continuation.adoptedDeployments[1].address;
  await f.writeState();
  const checked=await f.operator.check({root:f.root});assert.equal(checked.readiness.blocked,false);
  assert.deepEqual(await fs.readFile(path.join(result.directory,'operations-snapshot.json')),metadata);
}));

test('explicit cumulative budget, gas price and reserve must match the original ledger verbatim',()=>use(async f=>{
  await f.operator.prepare({root:f.root});
  const limits=f.operations.continuation.limits;
  await f.operator.check({root:f.root,limits});
  for(const change of [{budgetWei:'1100000000000001'},{maxFeePerGasWei:'40000001'},{reserveWei:'2999999999999999'},{budgetWei:'01100000000000000'}])
    await assert.rejects(()=>f.operator.check({root:f.root,limits:{...limits,...change}}),{code:'RC3_EXPLICIT_LIMITS_MUST_MATCH_ORIGINAL'});
  f.state.reserveWei='0';await f.writeState();
  await assert.rejects(()=>f.operator.check({root:f.root,limits}),{code:'RC3_SOURCE_LIMITS_MISMATCH'});
}));

test('store corruption, a mismatched signed hash and an altered original journal fail before creating a snapshot',()=>use(async f=>{
  const before=await fs.readFile(f.signer),value=JSON.parse(before);value.value.reserveWei='1';await fs.writeFile(f.signer,encode(value));
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_STORE_CORRUPT'});await fs.writeFile(f.signer,before);
  f.state.entries[1].hash='0x'+'ab'.repeat(32);await f.writeState();
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_ANCHOR_MISMATCH'});
  f.state.entries[1].hash=f.operations.continuation.adoptedDeployments[1].hash;await f.writeState();
  f.journal.pins.maxFeePerGasWei='1';await f.writeJournal();
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_LIMITS_MISMATCH'});
  await assert.rejects(fs.access(path.join(f.root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY)),{code:'ENOENT'});
}));

test('an altered journal deployer, creation calldata or duplicate adopted step fails closed',()=>use(async f=>{
  const saved=structuredClone(f.journal.steps);
  for(const change of [{deployer:address()},{data:'0xdeadbeef'}]){
    Object.assign(f.journal.steps[0],change);await f.writeJournal();
    await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_JOURNAL_MISMATCH'});
    f.journal.steps=structuredClone(saved);
  }
  f.journal.steps.push(structuredClone(f.journal.steps[0]));await f.writeJournal();
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_ENTRIES_INVALID'});
}));

test('a held original service lock and a symlinked ledger are rejected without changing either journal',()=>use(async f=>{
  const lock=path.join(path.dirname(f.signer),'.service.lock');await fs.writeFile(lock,'synthetic held lock');
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_SOURCE_STORE_LOCKED'});await fs.unlink(lock);
  const saved=f.signer+'.synthetic-source';await fs.rename(f.signer,saved);await fs.symlink(saved,f.signer);
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_REGULAR_FILE_REQUIRED'});
}));

test('every archived public file and the derived configuration are checked before deployment',()=>use(async f=>{
  const result=await f.operator.prepare({root:f.root}),target=path.join(result.directory,'src/public-marker.mjs');
  await fs.writeFile(target,'tampered');await assert.rejects(()=>f.operator.check({root:f.root}),{code:'RC3_SNAPSHOT_FILE_MISMATCH'});
  await fs.writeFile(target,f.sources.get('src/public-marker.mjs'));
  const configPath=path.join(result.directory,'config/phase2-mainnet.json'),config=JSON.parse(await fs.readFile(configPath));config.limits.gasBudgetWei='999';
  await fs.writeFile(configPath,encode(config));await assert.rejects(()=>f.operator.check({root:f.root}),{code:'RC3_SNAPSHOT_FILE_MISMATCH'});
}));

test('tag capsule drift, private archive entries and changed shared signer metadata cannot bypass fixed bindings',()=>use(async f=>{
  f.archive.files[0].blob='ff'.repeat(20);
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_TAG_CAPSULE_MISMATCH'});
  f.archive.files[0].blob=blob(f.sources.get(f.archive.files[0].path));
  f.archive.files.push({path:'.phase1-private/signer.json',mode:'100644',blob:'ab'.repeat(20)});
  await assert.rejects(()=>f.operator.prepare({root:f.root}),{code:'RC3_ARCHIVE_PRIVATE_PATH'});f.archive.files.pop();
  const result=await f.operator.prepare({root:f.root}),metadataPath=path.join(result.directory,'operations-snapshot.json'),metadata=JSON.parse(await fs.readFile(metadataPath));
  metadata.sharedSignerDirectory=result.directory;await fs.writeFile(metadataPath,encode(metadata));
  await assert.rejects(()=>f.operator.check({root:f.root}),{code:'RC3_SNAPSHOT_METADATA_MISMATCH'});
}));

test('the actual git archive provider extracts only the tagged public capsule in an isolated repository',()=>use(async f=>{
  const git=args=>{const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',f.root,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git(['init','-q']);git(['add','--',RC3_RELEASE_DIRECTORY]);
  git(['-c','user.name=Synthetic Operator','-c','user.email=synthetic@example.invalid','commit','-q','-m','Synthetic public capsule']);
  git(['tag',RC3_CANDIDATE_TAG]);
  const archive=await readRC3Archive({root:f.root});
  assert.equal(archive.files.length,3);assert.ok(archive.files.every(entry=>!entry.path.includes('.phase1-private')));
  const output=path.join(f.root,'synthetic-archive-output');await fs.mkdir(output);await archive.extract(output);
  for(const [relative,bytes]of f.sources)assert.deepEqual(await fs.readFile(path.join(output,relative)),bytes);
  await assert.rejects(fs.access(path.join(output,RC3_OPERATIONS_FILE)),{code:'ENOENT'});
}));

test('configuration overlay rejects signing enablement, role collisions and malformed adoption identity',()=>use(async f=>{
  const parse=operations=>configureRC3Operations({config:f.config,operations,releaseSHA256:f.releaseSHA256});
  const enabled=structuredClone(f.operations);enabled.signingEnabled=true;assert.throws(()=>parse(enabled),{code:'RC3_SIGNING_DISABLED_REQUIRED'});
  const collided=structuredClone(f.config);collided.guardian.address=f.operations.deployer.address;
  assert.throws(()=>configureRC3Operations({config:collided,operations:f.operations,releaseSHA256:f.releaseSHA256}),{code:'RC3_ROLE_COLLISION'});
  const adoption=structuredClone(f.operations);adoption.continuation.adoptedDeployments[1].nonce='2';
  assert.throws(()=>parse(adoption),{code:'RC3_ADOPTED_DEPLOYMENTS_INVALID'});
}));

test('shell validates flags and requires operator TTY before accessing any deployment state',()=>{
  const shell=path.join(ROOT,'scripts/deploy-mainnet.sh');assert.equal(spawnSync('bash',['-n',shell]).status,0);
  for(const args of [['--deploy'],['--deploy','--budget-wei','1','--max-fee-per-gas-wei','1','--reserve-wei','0'],
    ['--prepare','--budget-wei','1'],['--plan','--private-key','forbidden'],['--unknown']]){
    const result=spawnSync('bash',[shell,...args],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.equal(result.stdout.includes('Keystore password'),false);
    assert.equal(result.stderr.includes('MAINNET_BROADCAST_UNKNOWN'),false);
  }
});
