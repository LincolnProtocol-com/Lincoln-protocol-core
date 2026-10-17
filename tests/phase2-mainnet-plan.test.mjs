// Audit-package adaptation: inspect final MPC records instead of an omitted
// development zkey. See audit/test-adaptations.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {keccak256} from 'viem';
import {buildMainnetPlan,readMainnetPlan,checkMainnetReadOnly} from '../scripts/phase2-mainnet/plan.mjs';
import {buildMainnetSourcePlan,loadFinalProductionCircuit,buildMainnetRelease,compileMainnetSources,validateEmbeddedMPC,readEmbeddedMPC} from '../scripts/phase2-mainnet/build.mjs';

const config=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url),'utf8'));
test('mainnet target is actually enabled without claiming production build or parameter readiness',async()=>{
  const plan=buildMainnetPlan({config});
  assert.equal(plan.chain.id,4663);assert.equal(plan.mainnetTargetEnabled,true);
  assert.equal(plan.deployer.address.toLowerCase(),'0x36437b878415eda1a24186cf79afffbc9eced298');
  assert.equal(plan.readiness.productionReady,false);assert.equal(plan.readiness.broadcastImplemented,true);
  assert.equal(plan.transactionsBroadcast,0);assert.equal(plan.audit.blocking,false);
  assert.equal(plan.policyMode,'asp');assert.equal(plan.selected,'aspSelfHosted');assert.equal(plan.deploymentBuildEnabled,true);
  assert.equal(plan.provider.bootstrapPolicy,'all-current-notes');assert.equal(plan.provider.sourceScreening,false);
  assert.equal(plan.provider.signerAccountName,null);assert.equal(plan.provider.dedicated,true);assert.equal(plan.provider.address.toLowerCase(),'0xce6770154d793df78fbfa0d3615b2946366e6612');assert.equal(plan.provider.hotRotationSupported,false);
  assert.equal(plan.provider.providerAddressImmutable,false);assert.equal(plan.provider.delayedRotationSupported,true);
  assert.equal(plan.provider.rotationDelaySeconds,259200);
  assert.ok(plan.pending.some(item=>item.code==='PRODUCTION_BUILD_MISSING'));
  assert.ok(plan.pending.some(item=>item.code==='PRODUCTION_CIRCUIT_MISSING'));
});
test('actual builder refuses absent final parameters before any output is written',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-mainnet-absent-')));
  try{
    await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/phase2-mainnet.json'),JSON.stringify(config));
    await assert.rejects(()=>buildMainnetRelease({root}),{code:'MAINNET_FINAL_PARAMETER_MISSING'});
    assert.deepEqual(await fs.readdir(root),['config']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('actual parameter loader rejects development manifests without compiling or adopting their keys',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-mainnet-dev-reject-')));
  try{
    const directory=path.join(root,'protocol/phase2-mainnet/build/joinsplit');await fs.mkdir(directory,{recursive:true});
    const dev=await fs.readFile(new URL('../artifacts/phase2-asp/circuits/joinsplit/manifest.json',import.meta.url));
    await fs.writeFile(path.join(directory,'manifest.json'),dev);
    await assert.rejects(()=>loadFinalProductionCircuit({root,name:'joinsplit'}),{code:'MAINNET_DEVELOPMENT_PARAMETERS_REJECTED'});
    assert.deepEqual(await fs.readdir(root),['protocol']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('MPC validation rejects initial zero-contribution and non-finalized keys without creating setup entropy',()=>{
  const context={name:'joinsplit',r1csSHA256:'a'.repeat(64),ptauSHA256:'b'.repeat(64),zkeySHA256:'c'.repeat(64)};
  const records=[{type:0,name:'operator-one',transcriptHex:'0x'+'11'.repeat(64)},
    {type:0,name:'operator-two',transcriptHex:'0x'+'22'.repeat(64)},
    {type:1,name:'final-beacon',transcriptHex:'0x'+'33'.repeat(64),beaconHash:'0x'+'44'.repeat(32),numIterationsExp:10}];
  const transcript={schema:'phase2-asp-ceremony-transcript/v1',circuit:'joinsplit',r1csSHA256:context.r1csSHA256,
    ptauSHA256:context.ptauSHA256,finalZkeySHA256:context.zkeySHA256,contributions:records};
  assert.throws(()=>validateEmbeddedMPC([],transcript,context),{code:'MAINNET_MPC_CONTRIBUTIONS_REQUIRED'});
  assert.throws(()=>validateEmbeddedMPC(records.slice(0,2),transcript,context),{code:'MAINNET_MPC_CONTRIBUTIONS_REQUIRED'});
  assert.throws(()=>validateEmbeddedMPC([...records.slice(0,2),{...records[2],type:0}],transcript,context),{code:'MAINNET_FINAL_BEACON_REQUIRED'});
  const result=validateEmbeddedMPC(records,transcript,context);
  assert.equal(result.nonBeaconContributors,2);assert.equal(result.finalBeacon,true);assert.equal(result.independentOperatorIdentityAuthenticated,false);
  assert.throws(()=>validateEmbeddedMPC(records,{...transcript,finalZkeySHA256:'d'.repeat(64)},context),{code:'MAINNET_CEREMONY_TRANSCRIPT_BINDING_MISMATCH'});
  assert.throws(()=>validateEmbeddedMPC(records,{...transcript,contributions:[...records.slice(0,2),{...records[2],numIterationsExp:11}]},context),{code:'MAINNET_EMBEDDED_MPC_TRANSCRIPT_MISMATCH'});
});
test('MPC reader inspects the final public binary and rejects a single-contribution truncation',async()=>{
  const manifest=JSON.parse(await fs.readFile(new URL('../protocol/phase2-mainnet/build/holder-exit/manifest.json',import.meta.url),'utf8'));
  const records=await readEmbeddedMPC({zkeyPath:new URL('../'+manifest.artifacts.zkey.path,import.meta.url).pathname});
  assert.equal(records.length,3);assert.deepEqual(records.map(record=>record.type),[0,0,1]);
  assert.match(records[0].transcriptHex,/^0x[0-9a-f]{128}$/);
  assert.throws(()=>validateEmbeddedMPC(records.slice(0,1),null,{}),{code:'MAINNET_MPC_CONTRIBUTIONS_REQUIRED'});
});
test('real Solidity compiler builds all eight candidate contracts in memory with synthetic always-reject verifiers',async()=>{
  const plan=await buildMainnetSourcePlan(),sources={};
  for(const item of plan.sources){const original=await fs.readFile(new URL('../'+item.source,import.meta.url),'utf8');sources[item.target]=original.replace(item.oldGuard,item.newGuard);}
  for(const [name,count]of [['Phase2ASPJoinSplitVerifier',9],['Phase2ASPExitVerifier',5]])
    sources[`protocol/phase2-mainnet/generated/${name}.sol`]=`// SPDX-License-Identifier: GPL-3.0\npragma solidity 0.8.28; contract ${name}{function verifyProof(uint256[2] calldata,uint256[2][2] calldata,uint256[2] calldata,uint256[${count}] calldata) external pure returns(bool){return false;}}`;
  const result=await compileMainnetSources({sources});
  assert.equal(Object.keys(result.contracts).length,8);
  assert.ok(result.contracts.Phase2ASPPool.bytecode.startsWith('0x'));
  assert.ok(result.contracts.Phase2Router02Adapter.abi.some(entry=>entry.type==='function'&&entry.name==='swap'));
  assert.ok(Object.keys(result.contracts.Phase2ASPPool.linkReferences).length>0);
});
test('mainnet source plan derives four new guard hashes without editing deployed development source',async()=>{
  const plan=await buildMainnetSourcePlan();assert.equal(plan.sources.length,4);assert.equal(plan.filesWritten,0);assert.equal(plan.compiled,false);
  for(const source of plan.sources){assert.notEqual(source.sourceSHA256,source.derivedGuardSourceSHA256);assert.match(source.newGuard,/4663/);
    const current=await fs.readFile(new URL('../'+source.source,import.meta.url),'utf8');assert.ok(current.includes(source.oldGuard));}
  assert.equal(plan.finalVerifierBindings.joinsplit.generatedSource,'protocol/phase2-mainnet/generated/Phase2ASPJoinSplitVerifier.sol');
});
test('wrong target chain and development circuit/build labels are rejected for production planning',()=>{
  assert.throws(()=>buildMainnetPlan({config:{...config,chain:{...config.chain,id:46630}}}),{code:'MAINNET_TARGET_CHAIN_MISMATCH'});
  const dev={schema:'phase2-asp-dev-circuits/v1',testOnly:true,allowedChainIds:[31341,46630],setup:{kind:'self-generated-test-development-phase2'}};
  const plan=buildMainnetPlan({config,productionBuild:{_meta:{testOnly:true,allowedChainIds:[31341,46630]}},joinManifest:dev,exitManifest:dev});
  assert.equal(plan.build.status,'rejected');assert.equal(plan.circuits.joinsplit.status,'rejected');
  assert.ok(plan.pending.some(item=>item.code==='DEVELOPMENT_BUILD_REJECTED'));
  assert.equal(plan.pending.filter(item=>item.code==='DEVELOPMENT_PARAMETERS_REJECTED').length,2);
});
test('the planner never chooses permissionless or ASP implicitly and audit deferral is advisory',()=>{
  const unselected={...config,deployment:{...config.deployment,policyMode:null}};
  const plan=buildMainnetPlan({config:unselected});
  assert.equal(plan.policyMode,null);assert.deepEqual(plan.policyOptions,['asp','permissionless']);
  assert.ok(plan.pending.some(item=>item.code==='POLICY_SELECTION_PENDING'));
  assert.ok(!plan.pending.some(item=>/AUDIT/.test(item.code)));assert.equal(plan.audit.blocking,false);
});
function readClient(){const code='0x6000',hash='0x'+'ab'.repeat(32),calls=[];
  const client={async getChainId(){calls.push('chain');return 4663;},async getBlockNumber(){calls.push('head');return 100n;},
    async getBlock(){calls.push('block');return {number:100n,hash};},async getBalance(){calls.push('balance');return 123n;},
    async getTransactionCount(){calls.push('nonce');return 4;},async getCode(){calls.push('code');return code;},
    sendTransaction(){throw new Error('SIGNER_FORBIDDEN');},request(){throw new Error('RAW_RPC_FORBIDDEN');}};
  const plan=buildMainnetPlan({config});plan.codePins=[{role:'fixture',address:config.codePins[0].address,runtimeCodeHash:keccak256(code)}];
  return {client,calls,plan};}
test('optional onchain check only reads fixed-chain balance nonce and code with no signer',async()=>{
  const f=readClient(),result=await checkMainnetReadOnly(f);
  assert.equal(result.allCodePinsMatched,true);assert.equal(result.deployer.balanceWei,'123');assert.equal(result.deployer.pendingNonce,'4');
  assert.equal(result.transactionsBroadcast,0);assert.equal(result.readOnly,true);
  assert.ok(f.calls.every(method=>['chain','head','block','balance','nonce','code'].includes(method)));
});
test('wrong RPC chain fails before reading account state or code; source snapshot change also rejects',async()=>{
  const f=readClient();f.client.getChainId=async()=>1;
  await assert.rejects(()=>checkMainnetReadOnly(f),{code:'MAINNET_RPC_WRONG_CHAIN'});assert.deepEqual(f.calls,[]);
  const other=readClient();let n=0;other.client.getBlock=async()=>({number:100n,hash:++n===1?'0x'+'ab'.repeat(32):'0x'+'cd'.repeat(32)});
  await assert.rejects(()=>checkMainnetReadOnly(other),{code:'MAINNET_RPC_SNAPSHOT_CHANGED'});
});
test('bytecode mismatches remain visible rather than being silently accepted as a successful pin',async()=>{
  const f=readClient();f.client.getCode=async()=> '0x6001';const result=await checkMainnetReadOnly(f);
  assert.equal(result.allCodePinsMatched,false);assert.equal(result.pins[0].matched,false);
});
