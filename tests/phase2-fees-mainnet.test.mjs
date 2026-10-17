import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {decodeAbiParameters} from 'viem';
import {deriveMainnetFeeSource,compileMainnetFeeComponent,verifyMainnetFeeComponent,mainnetFeeCoreBinding,MAINNET_FEE_SOURCE,AUDITED_FEE_SOURCE,feeSHA256} from '../src/phase2-fees/mainnet-release.mjs';
import {planMainnetFeeDeployment} from '../scripts/phase2-fees/plan-mainnet.mjs';
import {deploymentSpecs} from '../scripts/phase2-mainnet/deploy.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const a=n=>'0x'+n.toString(16).padStart(40,'0'),h=n=>'0x'+n.toString(16).padStart(64,'0');
const SAFE='0x9cf17a6e3c75d200f58283a165c442a8a3994555',j=x=>JSON.stringify(x,null,2)+'\n';
let built,core,selection;
test.before(async()=>{
  // Pure compiler tests inject synthetic verified-core metadata; they do not
  // assert final-key mathematics or produce a runnable mainnet release.
  const imported=['protocol/phase2-mainnet/contracts/Phase2RouteAdapter.sol','protocol/phase2-mainnet/contracts/Phase2Router02Adapter.sol'];
  const sourceDigests=Object.fromEntries(await Promise.all(imported.map(async p=>[p,feeSHA256(await fs.readFile(path.join(ROOT,p)))])));
  const circuits=Object.fromEntries(['joinsplit','holder-exit'].map(name=>[name,{manifest:`protocol/phase2-mainnet/build/${name}/manifest.json`,manifestSHA256:'b'.repeat(64),zkeySHA256:'c'.repeat(64),verifyFromR1cs:true,verificationKeyBound:true,solidityVerifierBound:true,finalBeacon:true,transcriptBound:true,nonBeaconContributors:2}]));
  const artifacts={_meta:{schema:'phase2-asp-production-build/v1',releaseCandidate:true,testOnly:false,productionReady:false,allowedChainIds:[4663],policyMode:'asp',sourceDigests,sourceSetSHA256:'d'.repeat(64),circuits},
    Phase2ASPRegistry:{abi:[{type:'constructor',inputs:[{type:'address',name:'provider'},{type:'address',name:'guardian'}]}]},Phase2ASPPool:{abi:[{type:'function',name:'holderExit'}]}};
  core={artifactSHA256:'a'.repeat(64),artifacts,config:JSON.parse(await fs.readFile(path.join(ROOT,'config/phase2-mainnet.json'),'utf8'))};
  selection=JSON.parse(await fs.readFile(path.join(ROOT,'config/phase2-mainnet-routes-example.json'),'utf8'));
  built=compileMainnetFeeComponent({rootDirectory:ROOT,coreRelease:core});
});
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mainnet-fee-release-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const relative of Object.keys(built.artifact._meta.sourceDigests)){
    const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,relative===MAINNET_FEE_SOURCE?built.derivedSource:await fs.readFile(path.join(ROOT,relative)));
  }
  return {rootDirectory:root,artifactBytes:built.artifactBytes,coreRelease:core};
}
test('production fee source derivation changes only chain guard and final core interface paths',async()=>{
  const original=await fs.readFile(path.join(ROOT,AUDITED_FEE_SOURCE),'utf8'),derived=deriveMainnetFeeSource(original);
  assert.equal(derived,built.derivedSource);assert.ok(derived.includes('if (block.chainid != 4663) revert UnsupportedChainId();'));
  assert.equal(derived.includes('block.chainid != 31341'),false);assert.ok(derived.includes('../../phase2-mainnet/contracts/Phase2RouteAdapter.sol'));
  const recovered=derived.replace('if (block.chainid != 4663) revert UnsupportedChainId();','if (block.chainid != 31341 && block.chainid != 46630 && block.chainid != 4663) revert UnsupportedChainId();')
    .replace('../../phase2-mainnet/contracts/Phase2RouteAdapter.sol','../../phase2-routes/contracts/Phase2RouteAdapter.sol')
    .replace('../../phase2-mainnet/contracts/Phase2Router02Adapter.sol','../../phase2-router02/contracts/Phase2Router02Adapter.sol');
  assert.equal(recovered,original);assert.throws(()=>deriveMainnetFeeSource(original+original),/MAINNET_FEE_SOURCE_GUARD_DRIFT/);
});
test('production fee compiler preserves exact public interface and binds final core release',()=>{
  const m=built.artifact._meta;assert.deepEqual(m.allowedChainIds,[4663]);assert.equal(m.testOnly,false);assert.equal(m.productionReady,false);assert.equal(m.releaseCandidate,true);
  assert.equal(m.coreRelease.build.sha256,core.artifactSHA256);assert.deepEqual(m.coreRelease,mainnetFeeCoreBinding(core));
  for(const name of m.adapters){const c=built.artifact[name];assert.equal(c.abi.find(x=>x.type==='constructor').inputs.length,8);
    const action=c.abi.find(x=>x.type==='function'&&x.name==='swap').inputs[0].components;
    assert.deepEqual(action.map(x=>x.name),['processor','amountIn','minAmountOut','deadline','targetPrecommitment','encryptedTemplate','maxServiceFee']);
    assert.ok(c.abi.some(x=>x.type==='event'&&x.name==='ServiceFeePaid'));assert.ok((c.deployedBytecode.length-2)/2<=24576);
  }
  const old=structuredClone(core);old.artifacts.Phase2ASPRegistry.abi=old.artifacts.Phase2ASPRegistry.abi.filter(x=>x.type!=='constructor').concat({type:'constructor',inputs:[{type:'address'}]});
  assert.throws(()=>mainnetFeeCoreBinding(old),/MAINNET_FEE_GUARDIAN_CORE_REQUIRED/);
});
test('production component verifies reproduced bytecode/ABI instead of trusting release flags',async t=>{
  const f=await fixture(t),result=verifyMainnetFeeComponent(f);assert.equal(result.releaseCandidate,true);assert.equal(result.productionReady,false);
  const changed=structuredClone(built.artifact);changed.Phase2FeeRouter02Adapter.bytecode+='00';
  assert.throws(()=>verifyMainnetFeeComponent({...f,artifactBytes:Buffer.from(j(changed))}),/MAINNET_FEE_COMPONENT_REBUILD_MISMATCH/);
  const flipped=structuredClone(built.artifact);flipped._meta.productionReady=true;
  assert.throws(()=>verifyMainnetFeeComponent({...f,artifactBytes:Buffer.from(j(flipped))}),/MAINNET_FEE_COMPONENT_NOT_PRODUCTION/);
});
test('cached production components still reject source changes and different core release hashes',async t=>{
  const f=await fixture(t);verifyMainnetFeeComponent(f);
  await fs.appendFile(path.join(f.rootDirectory,AUDITED_FEE_SOURCE),'\n// changed\n');
  assert.throws(()=>verifyMainnetFeeComponent(f),/MAINNET_FEE_COMPONENT_SOURCE_CHANGED/);
  assert.throws(()=>verifyMainnetFeeComponent({...f,coreRelease:{...core,artifactSHA256:'b'.repeat(64)}}),/MAINNET_FEE_CORE_RELEASE_MISMATCH/);
});
test('Safe 20bps mainnet plan keeps pool addresses and create calls unset before core deployment',()=>{
  const plan=planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:SAFE,feeBps:20});
  assert.equal(plan.coreDeploymentRequired,true);assert.equal(plan.transactionsBroadcast,0);assert.equal(plan.deploymentExecutorImplemented,false);assert.equal(plan.plannedAdapters.length,selection.routes.length);
  assert.equal(plan.treasury,SAFE);assert.equal(plan.feeBps,20);
  for(const item of plan.plannedAdapters){assert.equal(item.unsignedCreateTransaction,null);assert.equal(item.newAdapter.address,null);assert.equal(item.newAdapter.runtimeCodeHash,null);assert.equal(item.executionEnabled,false);assert.ok(item.runtimeTemplateSHA256);
    assert.equal(item.requiredImmutableGetters.FEE_BPS,20);assert.equal(item.requiredImmutableGetters.TREASURY,SAFE);
    assert.equal(item.requiredImmutableGetters.HOPS,selection.routes.find(r=>r.id===item.id).hops.length);
    assert.equal(Object.hasOwn(item.requiredImmutableGetters,'SOURCE_POOL'),false);
    assert.equal(item.routerABIStyle,item.adapterType==='Phase2FeeRouter02Adapter'?'router02-exactInput-without-deadline':'exactInput-with-deadline');
  }
  assert.throws(()=>planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:SAFE,feeBps:101}),/INVALID_SERVICE_FEE_BPS/);
});
async function deployedFixture(){
  const base=JSON.parse(await fs.readFile(path.join(ROOT,'config/phase2-asp-service-eth-testnet.json'),'utf8')),production=mainnetFeeCoreBinding(core),profiles={};
  for(const [index,id]of ['eth','usdg','nvda'].entries()){
    const p=structuredClone(base),asset=core.config.assets.find(x=>x.symbol.toLowerCase()===id);
    p.schema='phase2-asp-production-profile/v1';p.releaseCandidate=true;p.experimental=false;p.testOnly=false;p.productionReady=false;p.chain={id:4663};
    p.genesisHash=h(400);p.artifactSHA256=core.artifactSHA256;p.production=production;p.pool={...p.pool,address:a(10+index),asset:asset.address,startBlock:'1',runtimeCodeHash:h(10+index)};delete p.pool.scope;
    p.verifier={address:a(20),runtimeCodeHash:h(20)};p.exitVerifier={address:a(21),runtimeCodeHash:h(21)};p.registry={address:a(22),provider:a(23),runtimeCodeHash:h(22),startBlock:'1'};profiles[id]=p;
  }
  const routesByPool={};for(const [index,spec]of deploymentSpecs({config:core.config,routes:selection.routes}).filter(s=>s.route).entries()){
    const r=spec.route,entry={id:r.id,targetProfile:profiles[r.target],route:{...r,adapter:a(100+index),adapterType:spec.contract,
      sourcePool:profiles[r.source].pool.address,targetPool:profiles[r.target].pool.address,runtimeCodeHashes:{adapter:h(100+index)},
      hops:r.hops.map(x=>({...x,pool:x.address}))}};
    (routesByPool[r.source]??=[]).push(entry);
  }
  return {schema:'phase2-mainnet-deployed/v1',chainId:4663,testOnly:false,releaseId:core.artifactSHA256,production,profiles,routesByPool};
}
test('verified core deployment profiles materialize exact eight-argument unsigned fee CREATEs',async()=>{
  const coreDeployment=await deployedFixture(),plan=planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:SAFE,feeBps:20,coreDeployment});
  assert.equal(plan.coreDeploymentRequired,false);assert.deepEqual(plan.pending,[]);
  for(const p of plan.plannedAdapters){const c=built.artifact[p.adapterType],tx=p.unsignedCreateTransaction;assert.equal(tx.chainId,4663);assert.equal(tx.to,null);assert.equal(tx.nonce,null);assert.ok(tx.data.startsWith(c.bytecode));
    const args=decodeAbiParameters(c.abi.find(x=>x.type==='constructor').inputs,'0x'+tx.data.slice(c.bytecode.length));
    assert.equal(Number(args[6]),20);assert.equal(args[7].toLowerCase(),SAFE);assert.equal(args[0].toLowerCase(),coreDeployment.profiles[p.sourceAssetId].pool.address);assert.equal(p.newAdapter.address,null);
    assert.equal(p.requiredImmutableGetters.SOURCE_POOL,coreDeployment.profiles[p.sourceAssetId].pool.address);
    assert.equal(p.requiredImmutableGetters.TARGET_POOL,coreDeployment.profiles[p.targetAssetId].pool.address);
  }
  coreDeployment.releaseId='b'.repeat(64);assert.throws(()=>planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:SAFE,coreDeployment}),/MAINNET_FEE_DEPLOYMENT_RELEASE_MISMATCH/);
});
test('mainnet fee plans reject changed deployed adapter interfaces and treasury route collisions',async()=>{
  const coreDeployment=await deployedFixture();coreDeployment.routesByPool.eth[0].route.adapterType='Phase2RouteAdapter';
  assert.throws(()=>planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:SAFE,coreDeployment}),/MAINNET_FEE_DEPLOYED_ROUTE_MISMATCH/);
  assert.throws(()=>planMainnetFeeDeployment({coreRelease:core,feeArtifactBytes:built.artifactBytes,selection,treasury:selection.routes[0].tokens[0]}),/UNSAFE_FEE_TREASURY/);
});
