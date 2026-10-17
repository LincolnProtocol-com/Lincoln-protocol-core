// SPDX-License-Identifier: Apache-2.0
// Canonical public-log fixtures only; actual final proofs are covered separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,encodeEventTopics,keccak256,parseAbi,toHex} from 'viem';
import {poseidon} from 'maci-crypto/build/ts/hashing.js';
import {createAccount,createDynamicReceive,normalizeProfile,NOTE_MODEL} from '../src/phase2-asp/sdk.mjs';
import {syncPhase2State,phase2Tree} from '../src/phase2-asp/state.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0'),blockHash=n=>keccak256(toHex(`cap-block-${n}`));
const POOL=addr(10),REGISTRY=addr(11),PROVIDER=addr(12),PAYER=addr(13),VERIFIER=addr(14),EXIT=addr(15),ZERO=addr(0),CODE='0x6000',PIN=keccak256(CODE);
const BASE_POOL_ABI=parseAbi([
  'event NewCommitment(uint256 indexed commitment, uint256 indexed index, bytes encryptedOutput)',
  'event DynamicDeposited(address indexed processor, uint256 value, uint256 precommitment, uint256 commitment, bytes encryptedTemplate)',
  'event HolderExited(address indexed processor, address indexed recipient, uint256 indexed commitment, uint256 nullifier, uint256 value, uint256 fee, address feeRecipient)',
  'function currentRoot() view returns (uint256)','function nextLeafIndex() view returns (uint256)',
  'function SCOPE() view returns (uint256)','function VERIFIER() view returns (address)',
  'function HOLDER_EXIT_VERIFIER() view returns (address)','function ASSET() view returns (address)',
  'function ASP_REGISTRY() view returns (address)',
]);
const CAP_ABI=parseAbi([
  'event CapsUpdated(uint128 maxDeposit, uint128 maxTotal)',
  'event CapIncreaseProposed(uint128 maxDeposit, uint128 maxTotal, uint64 eta)',
  'event CapIncreaseCancelled()','event DepositsPaused(bool paused)',
  'function maxDeposit() view returns (uint128)','function maxTotal() view returns (uint128)',
  'function accountedBalance() view returns (uint256)',
  'function pendingCaps() view returns (uint128 maxDeposit, uint128 maxTotal, uint64 eta)',
  'function depositsPaused() view returns (bool)','function CAP_INCREASE_DELAY() view returns (uint64)',
]);
const REGISTRY_ABI=parseAbi([
  'event PolicyUpdated(uint64 indexed epoch, uint256 indexed root, bytes32 cidDigest, uint64 validUntil)',
  'function PROVIDER() view returns (address)',
  'function latestPolicy() view returns (uint256 root, uint64 epoch, uint64 validUntil)',
  'function cidDigest() view returns (bytes32)',
]);
function fixture({legacy=false}={}) {
  const profile={schema:'phase2-asp-test-profile/v1',experimental:true,testOnly:true,productionReady:false,
    chain:{id:31341},genesisHash:blockHash(0),artifactSHA256:'a'.repeat(64),
    pool:{address:POOL,asset:ZERO,noteModel:NOTE_MODEL,startBlock:'1',runtimeCodeHash:PIN},
    verifier:{address:VERIFIER,runtimeCodeHash:PIN},exitVerifier:{address:EXIT,runtimeCodeHash:PIN},
    registry:{address:REGISTRY,provider:PROVIDER,startBlock:'1',runtimeCodeHash:PIN}};
  const scope=normalizeProfile(profile).scope;
  const invoice=createDynamicReceive(createAccount(),profile),value=30n,commitment=poseidon([value,invoice.precommitment]);
  const poolABI=[...BASE_POOL_ABI,...(legacy?[]:CAP_ABI)],logs=[],calls=[];
  function add(eventName,types,values,block,indexed={}) {
    const receiptLogs=logs.filter(log=>log.blockNumber===BigInt(block));
    const log={address:POOL,blockHash:blockHash(block),blockNumber:BigInt(block),transactionHash:keccak256(toHex(`cap-tx-${block}`)),
      transactionIndex:0,logIndex:receiptLogs.length,removed:false,
      topics:encodeEventTopics({abi:poolABI,eventName,args:indexed}),data:encodeAbiParameters(types.map(type=>({type})),values)};
    logs.push(log);return log;
  }
  if(!legacy)add('CapsUpdated',['uint128','uint128'],[100n,1000n],1);
  add('NewCommitment',['bytes'],[invoice.encryptedTemplate],2,{commitment,index:'0'});
  add('DynamicDeposited',['uint256','uint256','uint256','bytes'],[value,invoice.precommitment,commitment,invoice.encryptedTemplate],2,{processor:PAYER});
  const capValues={maxDeposit:100n,maxTotal:1000n,accountedBalance:30n,pendingCaps:[0n,0n,0n],depositsPaused:false,CAP_INCREASE_DELAY:43200n};
  const artifacts={Phase2ASPPool:{abi:poolABI},Phase2ASPRegistry:{abi:REGISTRY_ABI}};
  const client={
    async getChainId(){return 31341;},async getBlockNumber(){return 10n;},
    async getBlock({blockNumber}){return {number:blockNumber,hash:blockHash(blockNumber),timestamp:1000n};},
    async getCode(){return CODE;},async getBalance(){return 40n;},
    async getLogs(o){calls.push(o);return o.address===POOL?logs.filter(log=>log.blockNumber>=o.fromBlock&&log.blockNumber<=o.toBlock):[];},
    async getTransactionReceipt({hash}){const matching=logs.filter(log=>log.transactionHash===hash);return {
      status:'success',transactionHash:hash,blockHash:matching[0].blockHash,blockNumber:matching[0].blockNumber,logs:matching};},
    async readContract(o){calls.push(o);
      if(o.address===REGISTRY)return {PROVIDER,latestPolicy:[0n,0n,0n],cidDigest:'0x'+'00'.repeat(32)}[o.functionName];
      if(Object.hasOwn(capValues,o.functionName))return capValues[o.functionName];
      return {currentRoot:phase2Tree([commitment]).root,nextLeafIndex:1n,SCOPE:scope,VERIFIER,HOLDER_EXIT_VERIFIER:EXIT,ASSET:ZERO,ASP_REGISTRY:REGISTRY}[o.functionName];},
  };
  return {client,profile,artifacts,logs,calls,capValues,add,sync:options=>syncPhase2State({client,profile,artifacts,...options})};
}

test('caps events preserve note sequences, allow donation surplus and lowered caps below liabilities',async()=>{
  const f=fixture();
  f.add('CapIncreaseProposed',['uint128','uint128','uint64'],[200n,2000n,90000n],3);
  f.add('CapIncreaseCancelled',[],[],4);
  f.add('CapIncreaseProposed',['uint128','uint128','uint64'],[300n,3000n,91000n],5);
  f.add('CapsUpdated',['uint128','uint128'],[10n,20n],6);
  f.add('DepositsPaused',['bool'],[true],7);
  Object.assign(f.capValues,{maxDeposit:10n,maxTotal:20n,depositsPaused:true});
  const state=await f.sync();
  assert.equal(state.reserve,'30');assert.equal(state.actualBalance,'40');assert.equal(state.commitments.length,1);
  assert.deepEqual(state.depositCaps,{maxDeposit:'10',maxTotal:'20',accountedBalance:'30',
    pendingCaps:{maxDeposit:'0',maxTotal:'0',eta:'0'},depositsPaused:true,capIncreaseDelaySeconds:'43200'});
  assert.ok(f.calls.filter(call=>Object.hasOwn(f.capValues,call.functionName)).every(call=>call.blockNumber===10n));
  const resumed=await f.sync({checkpoint:state.checkpoint});assert.equal(resumed.resumed,true);assert.deepEqual(resumed.depositCaps,state.depositCaps);
});

test('a pending cap increase may have matured without being accepted',async()=>{
  const f=fixture();f.add('CapIncreaseProposed',['uint128','uint128','uint64'],[200n,2000n,500n],3);
  f.capValues.pendingCaps=[200n,2000n,500n];
  const state=await f.sync();assert.equal(state.depositCaps.pendingCaps.eta,'500');assert.equal(state.depositCaps.maxDeposit,'100');
});

test('legacy ABI never probes caps and a partial or malformed new surface fails closed',async()=>{
  const legacy=fixture({legacy:true}),state=await legacy.sync();assert.equal(state.depositCaps,null);
  assert.ok(!legacy.calls.some(call=>Object.hasOwn(legacy.capValues,call.functionName)));
  for(const mode of ['missing','signature']){
    const f=fixture(),abi=f.artifacts.Phase2ASPPool.abi;
    if(mode==='missing')f.artifacts.Phase2ASPPool.abi=abi.filter(item=>item.name!=='pendingCaps');
    else f.artifacts.Phase2ASPPool.abi=abi.map(item=>item.name==='maxDeposit'?{...item,outputs:[{type:'uint256'}]}:item);
    await assert.rejects(f.sync(),{code:'POOL_CAPS_ARTIFACT_ABI_INVALID'});
  }
});

test('caps RPC errors, mismatched liabilities and malformed values never degrade to no caps',async()=>{
  const changes=[
    [{accountedBalance:31n},'POOL_ACCOUNTED_BALANCE_MISMATCH'],[{maxDeposit:0n},'INVALID_POOL_CAPS'],
    [{maxDeposit:1001n},'INVALID_POOL_CAPS'],[{maxTotal:1n<<128n},'INVALID_POOL_CAPS'],
    [{depositsPaused:'false'},'INVALID_POOL_CAPS'],[{CAP_INCREASE_DELAY:0n},'INVALID_POOL_CAPS'],
    [{pendingCaps:[1n,1n,0n]},'INVALID_POOL_CAPS'],[{pendingCaps:[200n,2000n,1n<<64n]},'INVALID_POOL_CAPS'],
    [{pendingCaps:[90n,2000n,100n]},'INVALID_POOL_CAPS'],[{maxTotal:999n},'POOL_CAPS_STATE_MISMATCH'],
    [{pendingCaps:[200n,2000n,100n]},'POOL_CAPS_STATE_MISMATCH'],
  ];
  for(const [change,code]of changes){const f=fixture();Object.assign(f.capValues,change);await assert.rejects(f.sync(),{code});}
  const f=fixture(),read=f.client.readContract;f.client.readContract=async o=>{
    if(o.functionName==='accountedBalance')throw Object.assign(new Error('RPC_UNAVAILABLE'),{code:'RPC_UNAVAILABLE'});return read(o);};
  await assert.rejects(f.sync(),{code:'RPC_UNAVAILABLE'});
});

test('cap events remain subject to complete receipts and replay/storage consistency',async()=>{
  const f=fixture(),receipt=f.client.getTransactionReceipt;
  f.client.getTransactionReceipt=async o=>{const r=await receipt(o);return r.blockNumber===1n?{...r,logs:[]}:r;};
  await assert.rejects(f.sync(),{code:'INCOMPLETE_TRANSACTION_LOGS'});
  const omitted=fixture(),logs=omitted.client.getLogs;
  omitted.client.getLogs=async o=>(await logs(o)).filter(log=>log.blockNumber!==1n);
  await assert.rejects(omitted.sync(),{code:'POOL_CAPS_STATE_MISMATCH'});
  const warm=fixture(),state=await warm.sync();warm.capValues.accountedBalance=29n;
  await assert.rejects(warm.sync({checkpoint:state.checkpoint}),{code:'POOL_ACCOUNTED_BALANCE_MISMATCH'});
});
