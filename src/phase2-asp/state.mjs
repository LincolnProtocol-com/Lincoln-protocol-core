// SPDX-License-Identifier: Apache-2.0
// Public logs only. A pinned RPC remains a trust assumption, not a completeness proof.
import { createHash } from 'node:crypto';
import { setTimeout as retryDelay } from 'node:timers/promises';
import { poseidon } from 'maci-crypto/build/ts/hashing.js';
import { BlockNotFoundError, decodeEventLog, keccak256, parseAbi } from 'viem';
import { openServiceStore } from '../phase1-service/store.mjs';
import { normalizeProfile, NOTE_MODEL, associationSetDigest, profileReleaseFlags } from './sdk.mjs';

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO = '0x0000000000000000000000000000000000000000';
const balanceABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
// Guardian registry surface (audit M1/M2). Merged into the artifact ABI so these
// events decode even with an artifact built before the guardian registry.
const GOVERNANCE_ABI = parseAbi([
  'event ProviderRotationProposed(address indexed currentProvider, address indexed nextProvider, uint64 readyAt)',
  'event ProviderRotationCancelled(address indexed nextProvider)',
  'event ProviderRotated(address indexed previousProvider, address indexed nextProvider)',
  'event ProviderSuspended(address indexed provider, uint64 revokedThroughEpoch)',
  'event ProviderResumed(address indexed provider)',
  'function ACCEPTED_POLICY_WINDOW() view returns (uint64)',
  'function SUPERSEDED_POLICY_GRACE() view returns (uint256)',
  'function providerSuspended() view returns (bool)',
  'function revokedThroughEpoch() view returns (uint64)',
  'function policyAt(uint64 epoch) view returns (uint256 root, uint64 validUntil, uint64 supersededAt)',
  'function acceptedPolicy(uint64 epoch) view returns (uint256 root, uint64 validUntil)',
]);
const withGovernance = abi => {
  const present = new Set(abi.map(item => `${item.type}:${item.name}`));
  return [...abi, ...GOVERNANCE_ABI.filter(item => !present.has(`${item.type}:${item.name}`))];
};
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wire = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const qty = value => { check(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'INVALID_STATE_QUANTITY'); const n = BigInt(value); check(n >= 0n, 'INVALID_STATE_QUANTITY'); return n; };

async function readPinnedBlock(client,blockNumber){
  // Load-balanced RPC backends can learn a numbered head at different times.
  // Retry only this read at exactly the same height, at most three attempts;
  // never pick another head or relax the final canonical-hash comparison.
  const waits=[100,250];
  for(let attempt=0;;attempt++){
    try{return await client.getBlock({blockNumber});}
    catch(error){if(!(error instanceof BlockNotFoundError)||attempt>=waits.length)throw error;await retryDelay(waits[attempt]);}
  }
}

export function phase2Tree(leaves, depth = 20) {
  check(depth === 20 && Array.isArray(leaves) && leaves.length <= 2 ** depth, 'INVALID_TREE');
  const zeros = [0n];
  for (let i = 0; i < depth; i++) zeros.push(poseidon([zeros[i], zeros[i]]));
  const levels = [leaves.map(value => { const n = qty(value); check(n > 0n && n < FIELD, 'INVALID_COMMITMENT'); return n; })];
  for (let i = 0; i < depth; i++) {
    const layer = levels[i], parents = [];
    for (let j = 0; j < layer.length; j += 2) parents.push(poseidon([layer[j], layer[j + 1] ?? zeros[i]]));
    levels.push(parents);
  }
  return { root: levels[depth][0] ?? zeros[depth], zeros, proof(index) {
    check(Number.isSafeInteger(index) && index >= 0 && index < leaves.length, 'INVALID_LEAF_INDEX');
    let cursor = index; const siblings = [], pathIndices = [];
    for (let i = 0; i < depth; i++) { siblings.push(levels[i][cursor ^ 1] ?? zeros[i]); pathIndices.push(cursor & 1); cursor = Math.floor(cursor / 2); }
    return { siblings, pathIndices };
  } };
}

export function phase2Identity(profile) {
  const p=normalizeProfile(profile);
  check(hash(profile.genesisHash) && [profile.pool,profile.verifier,profile.exitVerifier,profile.registry].every(pin=>hash(pin?.runtimeCodeHash)), 'PINNED_ASP_DEPLOYMENT_REQUIRED');
  check(profile.registry.provider.toLowerCase()===p.provider,'ASP_PROVIDER_MISMATCH');
  return sha(wire({chain:p.chainId,noteModel:NOTE_MODEL,genesis:profile.genesisHash,pool:profile.pool,verifier:profile.verifier,exitVerifier:profile.exitVerifier,registry:profile.registry,artifactSHA256:profile.artifactSHA256}));
}
function sortedLogs(logs) {
  return logs.sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.transactionIndex)-BigInt(b.transactionIndex))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
}
function logIdentity(log,address,start,head) {
  check(log.address.toLowerCase()===address.toLowerCase() && log.removed!==true && qty(log.blockNumber)<=head && qty(log.blockNumber)>=start,'INVALID_LOG');
  check(hash(log.blockHash)&&hash(log.transactionHash)&&/^(0|[1-9][0-9]*)$/.test(String(log.logIndex))&&/^(0|[1-9][0-9]*)$/.test(String(log.transactionIndex)),'INVALID_LOG_IDENTITY');
}
function metadata(log) {return {transactionHash:log.transactionHash,blockNumber:String(log.blockNumber),blockHash:log.blockHash};}
function addGroup(groups,log,event) {
  let group=groups.get(log.transactionHash);
  if(!group){group={logs:[],events:[],meta:metadata(log)};groups.set(log.transactionHash,group);}
  check(group.meta.blockHash===log.blockHash&&group.meta.blockNumber===String(log.blockNumber),'INCONSISTENT_TRANSACTION_LOGS');
  group.logs.push(log);group.events.push(event);
}
async function verifyReceipts(client,streams) {
  // Retain independent RPC verification of every historical transaction. Bound
  // concurrency across both streams, and reuse a receipt only within this sync.
  const jobs=streams.flatMap(([address,groups])=>Array.from(groups,([transactionHash,group])=>({address,transactionHash,group})));
  const receipts=new Map();let cursor=0;
  await Promise.all(Array.from({length:Math.min(8,jobs.length)},async()=>{
    for(;;){
      const job=jobs[cursor++];if(!job)return;
      const {address,transactionHash,group}=job;
      if(!receipts.has(transactionHash))receipts.set(transactionHash,client.getTransactionReceipt({hash:transactionHash}));
      const receipt=await receipts.get(transactionHash);
      check(receipt.status==='success'&&receipt.transactionHash===transactionHash&&receipt.blockHash===group.meta.blockHash&&String(receipt.blockNumber)===group.meta.blockNumber,'NONCANONICAL_RECEIPT');
      const logs=receipt.logs.filter(log=>log.address.toLowerCase()===address.toLowerCase());
      check(logs.length===group.logs.length&&logs.every((log,i)=>String(log.logIndex)===String(group.logs[i].logIndex)&&log.data.toLowerCase()===group.logs[i].data.toLowerCase()&&JSON.stringify(log.topics.map(t=>t.toLowerCase()))===JSON.stringify(group.logs[i].topics.map(t=>t.toLowerCase()))),'INCOMPLETE_TRANSACTION_LOGS');
    }
  }));
}
function validatePoolSequences(groups,deposits) {
  for(const group of groups.values()) {
    let cursor=0;
    while(cursor<group.events.length) {
      const first=group.events[cursor];
      if(first.eventName==='NewCommitment') {
        const dynamic=group.events[cursor+1];
        check(dynamic?.eventName==='DynamicDeposited'&&first.args.commitment===dynamic.args.commitment&&first.args.encryptedOutput===dynamic.args.encryptedTemplate,'INCOMPLETE_DYNAMIC_DEPOSIT_EVENTS');cursor+=2;
      } else {
        check(first.eventName==='NewNullifier','INCOMPLETE_TRANSACTION_EVENTS');
        const second=group.events[cursor+1];
        if(second?.eventName==='HolderExited') {
          check(first.args.nullifier===second.args.nullifier,'HOLDER_EXIT_NULLIFIER_MISMATCH');cursor+=2;
          if(group.events[cursor]?.eventName==='Ragequit') {
            const a=group.events[cursor++].args,b=second.args,deposit=deposits.find(d=>d.commitment===String(a.commitment));
            check(a.commitment===b.commitment&&a.nullifier===b.nullifier&&a.value===b.value&&deposit&&deposit.originalDepositor.toLowerCase()===a.depositor.toLowerCase()&&b.recipient.toLowerCase()===a.depositor.toLowerCase()&&b.fee===0n,'INVALID_RAGEQUIT_EVENTS');
          }
        } else {
          check(second?.eventName==='NewNullifier','INCOMPLETE_TRANSACTION_EVENTS');cursor+=2;
          let inserted=0;while(group.events[cursor]?.eventName==='NewCommitment'){cursor++;inserted++;}
          const transaction=group.events[cursor++],flow=group.events[cursor++];
          check(inserted<=2&&transaction?.eventName==='Transacted'&&flow?.eventName==='PublicFlow','INCOMPLETE_TRANSACTION_EVENTS');
          const a=transaction.args,b=flow.args;
          check(a.processor.toLowerCase()===b.processor.toLowerCase()&&a.publicIn===b.publicIn&&a.publicOut===b.publicOut&&a.fee===b.fee,'PUBLIC_FLOW_MISMATCH');
        }
      }
    }
  }
}

/** Public pool and ASP logs, with an optional independently supplied public set. */
export async function syncPhase2State({client,profile,artifacts,checkpoint=null,associationSet,associationSetLoader}) {
  const identity=phase2Identity(profile),p=normalizeProfile(profile),pool=p.pool,registry=p.registry;
  const poolABI=artifacts?.Phase2ASPPool?.abi,artifactRegistryABI=artifacts?.Phase2ASPRegistry?.abi;
  check(Array.isArray(poolABI)&&poolABI.some(a=>a.type==='event'&&a.name==='HolderExited')&&Array.isArray(artifactRegistryABI),'ASP_ARTIFACT_ABI_REQUIRED');
  const registryABI=withGovernance(artifactRegistryABI);
  const [chainId,genesis,head]=await Promise.all([client.getChainId(),readPinnedBlock(client,0n),client.getBlockNumber()]);
  check(chainId===p.chainId,'CHAIN_ID_MISMATCH');check(genesis.hash===profile.genesisHash,'GENESIS_MISMATCH');
  const block=await readPinnedBlock(client,head),timestamp=qty(block.timestamp);
  await Promise.all([profile.pool,profile.verifier,profile.exitVerifier,profile.registry].map(async pin=>{
    const code=await client.getCode({address:pin.address,blockNumber:head});
    check(code&&code!=='0x'&&keccak256(code)===pin.runtimeCodeHash,'RUNTIME_CODE_MISMATCH');
  }));
  const poolStart=qty(profile.pool.startBlock),registryStart=qty(profile.registry.startBlock);
  let poolFrom=poolStart,registryFrom=registryStart,logs=[],registryLogs=[],resumed=false;
  if(checkpoint) {
    const {digest,...body}=checkpoint;
    check(body.schema==='phase2-asp-public-checkpoint/v1'&&body.identity===identity&&sha(body)===digest&&Array.isArray(body.logs)&&Array.isArray(body.registryLogs),'INVALID_CHECKPOINT');
    const previous=qty(body.blockNumber);
    if(previous<=head&&(await readPinnedBlock(client,previous)).hash===body.blockHash){
      // Fetch/sort into fresh arrays. A failed attempt must not append to the
      // last committed checkpoint and invalidate its digest for the retry.
      logs=[...body.logs];registryLogs=[...body.registryLogs];poolFrom=previous+1n;registryFrom=previous+1n;resumed=true;
    }
  }
  async function fetch(address,from,target) {
    for(let cursor=from;cursor<=head;cursor+=2000n){const toBlock=cursor+1999n<head?cursor+1999n:head;target.push(...wire(await client.getLogs({address,fromBlock:cursor,toBlock})));}
  }
  await Promise.all([fetch(pool,poolFrom,logs),fetch(registry,registryFrom,registryLogs)]);
  sortedLogs(logs);sortedLogs(registryLogs);
  const positions=new Set(),commitments=[],receipts=[],nullifiers=[],deposits=[],exits=[],flows=[],seen=new Set(),nfs=new Set(),groups=new Map(),policyGroups=new Map();
  let reserve=0n;
  for(const log of logs) {
    logIdentity(log,pool,poolStart,head);const key=`${log.blockNumber}:${log.logIndex}`;check(!positions.has(key),'DUPLICATE_LOG');positions.add(key);
    let event;try{event=decodeEventLog({abi:poolABI,topics:log.topics,data:log.data,strict:true});}catch{throw new Error('UNKNOWN_POOL_LOG');}
    addGroup(groups,log,event);
    const a=event.args,meta=metadata(log);
    if(event.eventName==='NewCommitment') {
      const c=String(a.commitment),index=Number(a.index);
      check(index===commitments.length&&!seen.has(c)&&BigInt(c)>0n&&BigInt(c)<FIELD&&/^0x[0-9a-f]{512}$/i.test(a.encryptedOutput),'INVALID_COMMITMENT_EVENT');
      seen.add(c);commitments.push(c);receipts.push({commitment:c,index,encryptedOutput:a.encryptedOutput,...meta});
    } else if(event.eventName==='NewNullifier') {
      const nf=String(a.nullifier);check(!nfs.has(nf)&&BigInt(nf)>0n&&BigInt(nf)<FIELD,'DUPLICATE_NULLIFIER');nfs.add(nf);nullifiers.push(nf);
    } else if(event.eventName==='DynamicDeposited') {
      const value=BigInt(a.value),precommitment=BigInt(a.precommitment),commitment=BigInt(a.commitment),output=receipts.at(-1);
      check(value>0n&&value<(1n<<128n)&&precommitment>0n&&precommitment<FIELD&&poseidon([value,precommitment])===commitment,'INVALID_DYNAMIC_DEPOSIT');
      check(output&&output.commitment===String(commitment)&&output.transactionHash===log.transactionHash&&output.encryptedOutput===a.encryptedTemplate,'DYNAMIC_DEPOSIT_RECEIPT_MISMATCH');
      Object.assign(output,{kind:'dynamic',value:String(value),precommitment:String(precommitment),encryptedTemplate:a.encryptedTemplate,originalDepositor:a.processor.toLowerCase()});
      const deposit={commitment:String(commitment),value:String(value),precommitment:String(precommitment),originalDepositor:a.processor.toLowerCase(),...meta};deposits.push(deposit);
      reserve+=value;flows.push({kind:'dynamic',processor:a.processor,publicIn:String(value),publicOut:'0',fee:'0',...meta});
    } else if(event.eventName==='PublicFlow') {
      check(a.publicIn===0n,'NORMAL_PUBLIC_FUNDING_FORBIDDEN');reserve-=BigInt(a.publicOut);check(reserve>=0n,'NEGATIVE_RESERVE');flows.push({...wire(a),kind:'normal',...meta});
    } else if(event.eventName==='HolderExited') {
      const value=BigInt(a.value),fee=BigInt(a.fee);
      check(value>0n&&value<(1n<<128n)&&fee>=0n&&fee<=value&&seen.has(String(a.commitment))&&nfs.has(String(a.nullifier)),'INVALID_HOLDER_EXIT_EVENT');
      reserve-=value;check(reserve>=0n,'NEGATIVE_RESERVE');exits.push({...wire(a),kind:'holder-exit',...meta});flows.push({kind:'holder-exit',processor:a.processor,recipient:a.recipient,publicIn:'0',publicOut:String(value),fee:String(fee),...meta});
    } else if(event.eventName==='Ragequit') {
      const exit=exits.at(-1);check(exit&&exit.commitment===String(a.commitment)&&exit.transactionHash===log.transactionHash,'INVALID_RAGEQUIT_EVENTS');exit.kind='ragequit';
    } else check(event.eventName==='Transacted','UNEXPECTED_POOL_EVENT');
  }
  validatePoolSequences(groups,deposits);
  let latest={root:'0',epoch:'0',validUntil:'0',cidDigest:'0x'+'00'.repeat(32)};
  const policies=[];
  // Provider governance replayed from logs, then cross-checked against storage.
  const gov={provider:null,pending:null,suspended:false,revokedThroughEpoch:0n,rotated:false,events:0};
  const adopt=address=>{const a=address.toLowerCase();if(gov.provider===null)gov.provider=a;check(gov.provider===a,'INVALID_PROVIDER_EVENT');};
  for(const log of registryLogs) {
    logIdentity(log,registry,registryStart,head);const key=`${log.blockNumber}:${log.logIndex}`;check(!positions.has(key),'DUPLICATE_LOG');positions.add(key);
    let event;try{event=decodeEventLog({abi:registryABI,topics:log.topics,data:log.data,strict:true});}catch{throw new Error('UNKNOWN_REGISTRY_LOG');}
    addGroup(policyGroups,log,event);const a=event.args;
    if(event.eventName==='PolicyUpdated') {
      const root=qty(a.root),epoch=qty(a.epoch),validUntil=qty(a.validUntil);
      check(!gov.suspended&&root>0n&&root<FIELD&&epoch===BigInt(latest.epoch)+1n&&epoch<(1n<<64n)&&validUntil>0n&&validUntil<(1n<<64n)&&hash(a.cidDigest)&&!/^0x0{64}$/i.test(a.cidDigest),'INVALID_ASP_POLICY_EVENT');
      latest={root:String(root),epoch:String(epoch),validUntil:String(validUntil),cidDigest:a.cidDigest.toLowerCase()};policies.push({...latest,...metadata(log)});
      continue;
    }
    gov.events++;
    if(event.eventName==='ProviderRotationProposed') {
      adopt(a.currentProvider);const next=a.nextProvider.toLowerCase();check(next!==ZERO&&next!==gov.provider,'INVALID_PROVIDER_EVENT');gov.pending=next;
    } else if(event.eventName==='ProviderRotationCancelled') {
      check(gov.pending!==null&&gov.pending===a.nextProvider.toLowerCase(),'INVALID_PROVIDER_EVENT');gov.pending=null;
    } else if(event.eventName==='ProviderRotated') {
      adopt(a.previousProvider);const next=a.nextProvider.toLowerCase();check(gov.pending===next,'INVALID_PROVIDER_EVENT');
      Object.assign(gov,{provider:next,pending:null,suspended:false,rotated:true});
    } else if(event.eventName==='ProviderSuspended') {
      adopt(a.provider);const revoked=qty(a.revokedThroughEpoch);check(revoked===BigInt(latest.epoch),'INVALID_PROVIDER_EVENT');
      Object.assign(gov,{suspended:true,revokedThroughEpoch:revoked});
    } else if(event.eventName==='ProviderResumed') {
      adopt(a.provider);gov.suspended=false;
    } else check(false,'UNEXPECTED_REGISTRY_EVENT');
  }
  const tree=phase2Tree(commitments),read=functionName=>client.readContract({address:pool,abi:poolABI,functionName,blockNumber:head});
  const readRegistry=(functionName,args)=>client.readContract({address:registry,abi:registryABI,functionName,args,blockNumber:head});
  const [,poolValues,registryValues,actualBalance]=await Promise.all([
    verifyReceipts(client,[[pool,groups],[registry,policyGroups]]),
    Promise.all(['currentRoot','nextLeafIndex','SCOPE','VERIFIER','HOLDER_EXIT_VERIFIER','ASSET','ASP_REGISTRY'].map(read)),
    Promise.all(['PROVIDER','latestPolicy','cidDigest'].map(name=>readRegistry(name))),
    p.asset===ZERO?client.getBalance({address:pool,blockNumber:head}):client.readContract({address:p.asset,abi:balanceABI,functionName:'balanceOf',args:[pool],blockNumber:head}),
  ]);
  const [root,index,scope,verifier,exitVerifier,asset,aspRegistry]=poolValues;
  check(root===tree.root&&BigInt(index)===BigInt(commitments.length),'INCOMPLETE_OR_INCONSISTENT_LOGS');
  check(String(scope)===String(p.scope)&&verifier.toLowerCase()===profile.verifier.address.toLowerCase()&&exitVerifier.toLowerCase()===profile.exitVerifier.address.toLowerCase()&&asset.toLowerCase()===p.asset&&aspRegistry.toLowerCase()===registry,'POOL_IDENTITY_MISMATCH');
  const [provider,onchainPolicy,cidDigest]=registryValues;
  // The pinned provider may only differ after a rotation observed in canonical logs.
  const liveProvider=provider.toLowerCase(),providerCurrent=liveProvider===p.provider;
  check((gov.provider===null||gov.provider===liveProvider)&&(providerCurrent||gov.rotated),'ASP_POLICY_IDENTITY_MISMATCH');
  check(Array.isArray(onchainPolicy)&&onchainPolicy.length===3&&String(onchainPolicy[0])===latest.root&&String(onchainPolicy[1])===latest.epoch&&String(onchainPolicy[2])===latest.validUntil&&cidDigest.toLowerCase()===latest.cidDigest,'ASP_POLICY_IDENTITY_MISMATCH');
  // Policies a pool accepts at this block, read from the registry itself (audit M2):
  // the latest plus recently superseded epochs in their grace period, minus revoked ones.
  // The registry generation comes only from the artifact ABI, which must match the
  // deployment; a legacy ABI never triggers the new getters. Governance events under a
  // legacy ABI prove a mismatch. A guardian registry with a legacy ABI and no events
  // yet is handled as legacy: latest epoch only, which is stricter, never looser.
  const guardianRegistry=artifactRegistryABI.some(item=>item.type==='function'&&item.name==='ACCEPTED_POLICY_WINDOW');
  check(guardianRegistry||gov.events===0,'ASP_ARTIFACT_ABI_OUTDATED');
  let acceptedPolicies=[],suspended=false,revokedThroughEpoch=0n;
  if(guardianRegistry) {
    const [window,grace,liveSuspended,liveRevoked]=await Promise.all(['ACCEPTED_POLICY_WINDOW','SUPERSEDED_POLICY_GRACE','providerSuspended','revokedThroughEpoch'].map(name=>readRegistry(name)));
    suspended=liveSuspended;revokedThroughEpoch=qty(liveRevoked);
    check(suspended===gov.suspended&&revokedThroughEpoch===gov.revokedThroughEpoch,'ASP_GOVERNANCE_STATE_MISMATCH');
    for(let epoch=BigInt(latest.epoch);epoch>0n&&BigInt(latest.epoch)-epoch<qty(window);epoch--) {
      const [[root,validUntil],[storedRoot,storedUntil,supersededAt]]=await Promise.all([readRegistry('acceptedPolicy',[epoch]),readRegistry('policyAt',[epoch])]);
      const logged=policies[Number(epoch)-1];
      check(String(storedRoot)===logged.root&&String(storedUntil)===logged.validUntil,'ASP_POLICY_IDENTITY_MISMATCH');
      if(qty(root)===0n)continue;
      check(String(root)===logged.root&&String(validUntil)===logged.validUntil,'ASP_POLICY_IDENTITY_MISMATCH');
      const graceEnd=qty(supersededAt)===0n?qty(validUntil):qty(supersededAt)+qty(grace);
      acceptedPolicies.push({root:logged.root,epoch:String(epoch),validUntil:logged.validUntil,
        acceptedUntil:String(graceEnd<qty(validUntil)?graceEnd:qty(validUntil))});
    }
  } else if(BigInt(latest.epoch)>0n&&BigInt(latest.validUntil)>timestamp) {
    acceptedPolicies.push({root:latest.root,epoch:latest.epoch,validUntil:latest.validUntil,acceptedUntil:latest.validUntil});
  }
  // Contexts bind the pinned provider, so after a rotation no spend can match.
  if(!providerCurrent)acceptedPolicies=[];
  const asp={...latest,provider:liveProvider,leaves:null,expired:BigInt(latest.epoch)===0n||BigInt(latest.validUntil)<=timestamp,
    providerRotated:!providerCurrent,suspended,revokedThroughEpoch:String(revokedThroughEpoch),acceptedPolicies,
    spendable:acceptedPolicies.some(policy=>policy.epoch===latest.epoch)};
  let providedSet=associationSet;
  if(providedSet===undefined&&associationSetLoader){check(typeof associationSetLoader==='function','INVALID_ASSOCIATION_SET_LOADER');providedSet=await associationSetLoader({...asp,blockNumber:String(head),blockHash:block.hash});}
  if(providedSet!==undefined&&providedSet!==null) {
    check(providedSet&&Array.isArray(providedSet.leaves),'INVALID_ASSOCIATION_SET');
    const leaves=providedSet.leaves.map(value=>String(qty(value)));
    check(associationSetDigest(leaves).toLowerCase()===latest.cidDigest&&String(phase2Tree(leaves).root)===latest.root,'ASSOCIATION_SET_POLICY_MISMATCH');asp.leaves=leaves;
  }
  check(actualBalance>=reserve,'POOL_UNDERFUNDED');
  const [finalBlock,finalChainId]=await Promise.all([readPinnedBlock(client,head),client.getChainId()]);
  check(finalBlock.hash===block.hash&&finalChainId===p.chainId,'SNAPSHOT_REORGANIZED');
  const body={schema:'phase2-asp-public-checkpoint/v1',identity,blockNumber:String(head),blockHash:block.hash,logs,registryLogs};
  return {schema:'phase2-asp-public-state/v1',noteModel:NOTE_MODEL,chainId:p.chainId,pool,scope:String(p.scope),...profileReleaseFlags(profile),identity,
    blockNumber:String(head),blockHash:block.hash,blockTimestamp:String(timestamp),root:String(tree.root),commitments,receipts,nullifiers,deposits,exits,flows,policies,asp,
    reserve:String(reserve),actualBalance:String(actualBalance),resumed,checkpoint:{...body,digest:sha(body)},
    trustAssumptions:['Pinned RPC supplies complete canonical logs; no independent storage proof.','Association-set root and ABI digest match the pinned registry; provider policy remains a trust assumption.','Checkpoints are trusted local files, not HTTP imports.']};
}
export async function createPhase2Indexer({client,profile,artifacts,directory,associationSet,associationSetLoader}) {
  const store=await openServiceStore({directory,identity:phase2Identity(profile),filename:'state.json'});
  let current=await store.read(),inFlight=null,closed=false,closePromise=null;
  return {async sync(){
    check(!closed,'INDEXER_CLOSED');
    // Overlapping state/readiness polls share one fresh, verified snapshot.
    // The next completed sync always reads a new head: no stale TTL cache.
    if(!inFlight){
      const run=Promise.resolve().then(async()=>{
        const next=await syncPhase2State({client,profile,artifacts,checkpoint:current?.checkpoint,associationSet,associationSetLoader});
        await store.write(next);current=next;return next;
      });
      inFlight=run;
      run.then(()=>{if(inFlight===run)inFlight=null;},()=>{if(inFlight===run)inFlight=null;});
    }
    return structuredClone(await inFlight);
  },snapshot(){return current?structuredClone(current):null;},close(){
    if(!closePromise){closed=true;closePromise=(async()=>{await inFlight?.catch(()=>{});await store.close();})();}
    return closePromise;
  }};
}
export const syncPhase2ASPState=syncPhase2State;
export const createPhase2ASPIndexer=createPhase2Indexer;
