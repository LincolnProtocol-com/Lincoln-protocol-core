// SPDX-License-Identifier: BUSL-1.1
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessNewPoolReview,createNewPoolPlan,validateNewPoolPolicy,tokenUnits,newPoolRoutes,encodeV3Path,
  REVIEW_SCHEMA,POLICY_PATH,GENESIS,SHARED,DEX,WETH,sha256} from '../../scripts/operations/new-pools-mainnet-plan.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const bytes=await fs.readFile(path.join(root,POLICY_PATH));
const policy=JSON.parse(bytes),policySHA256=sha256(bytes);
const core=JSON.parse(await fs.readFile(path.join(root,'deployments/robinhood-mainnet/rc3-eth-usdg.json')));
const code='0x'+'11'.repeat(32),sha='22'.repeat(32);
const refs={...core.profiles.eth.libraries,Phase2ASPJoinSplitVerifier:core.profiles.eth.verifier,
  Phase2ASPExitVerifier:core.profiles.eth.exitVerifier,Phase2ASPRegistry:core.profiles.eth.registry};
function fixture(){
  return {schema:REVIEW_SCHEMA,chainId:4663,genesisHash:GENESIS,policySHA256,
    observation:{blockNumber:'90800000',blockHash:code,observedAt:'2026-10-17T09:30:00Z'},transactionsBroadcast:0,
    sharedComponents:Object.fromEntries(Object.entries(refs).map(([id,r])=>[id,{address:r.address,runtimeCodeHash:r.runtimeCodeHash,
      startBlock:r.startBlock,blockHash:r.blockHash,creationReceiptMatched:true,creationInputMatched:true}])),
    assets:policy.assets.map(a=>({id:a.id,address:a.address,symbol:a.symbol,decimals:a.decimals,runtimeCodeHash:code,
      sourceReview:{complete:true,sourceURL:'https://example.invalid/synthetic-test-only',sourceSHA256:sha,
        runtimeMatchesReviewedSource:true,upgradeable:false,implementations:[]},
      transferBehavior:{forkTestPassed:true,evidenceSHA256:sha,transferExact:true,transferFromExact:true,noTransferFee:true,noRebase:true},
      controls:{freezeAuthority:false,blacklistAuthority:false,pauseAuthority:false,bridgeAuthority:false,
        poolAddressBlocking:'absent',description:'Synthetic test fixture, no claim about a deployed token.'}})),
    markets:policy.markets.map(m=>({id:m.id,address:m.pool,fee:m.fee,...DEX,runtimeCodeHash:code,
      factoryGetPoolMatched:true,routerBindingsMatched:true,tokens:newPoolRoutes(policy).find(r=>r.source===m.source).tokens,
      swapSimulationPassed:true,swapEvidenceSHA256:sha}))};
}
const assess=review=>assessNewPoolReview({review,policy,policySHA256,core});

test('decimal normalization preserves all 18 places without floating point',()=>{
  assert.equal(tokenUnits('7.2',18),'7200000000000000000');
  assert.equal(tokenUnits('0.000000000000000001',18),'1');
  assert.equal(tokenUnits('50000',18),'50000000000000000000000');
  assert.equal(tokenUnits('2500',6),'2500000000');
  for(const bad of ['1e3','+1','01','1.','-1','NaN'])assert.throws(()=>tokenUnits(bad,18),{code:'NEW_POOL_DECIMAL_INVALID'});
  assert.throws(()=>tokenUnits('0.0000000000000000001',18),{code:'NEW_POOL_DECIMAL_PRECISION'});
  assert.throws(()=>tokenUnits('0',18),{code:'NEW_POOL_UINT128_RANGE'});
  assert.throws(()=>tokenUnits(((1n<<128n)).toString(),0),{code:'NEW_POOL_UINT128_RANGE'});
});

test('candidate fixed quantities and USDG-equivalent USDe token capacity are bound',()=>{
  assert.equal(validateNewPoolPolicy(policy),policy);
  const p=structuredClone(policy);p.assets[1].depositCaps.maxTotalUnits='50000000000';
  assert.throws(()=>validateNewPoolPolicy(p),{code:'NEW_POOL_CAP_UNITS_MISMATCH'});
  const q=structuredClone(policy);q.assets[2].maxTotalTokens='1000000';
  assert.throws(()=>validateNewPoolPolicy(q),{code:'NEW_POOL_PROPOSED_QUANTITY_CHANGED'});
  const approved=structuredClone(policy);approved.approval={reference:'invented'};
  assert.throws(()=>validateNewPoolPolicy(approved),{code:'NEW_POOL_NO_APPROVAL_IN_PREPARATION'});
});

test('each market produces two inverse fixed-fee paths, ETH uses WETH and USDe has none',()=>{
  const routes=newPoolRoutes(policy);assert.equal(routes.length,6);
  for(let i=0;i<routes.length;i+=2){
    const a=routes[i],b=routes[i+1];
    assert.equal(a.source,b.target);assert.equal(a.target,b.source);
    assert.deepEqual(a.tokens,[...b.tokens].reverse());assert.deepEqual(a.parameters,b.parameters);
    assert.equal(a.hops[0].address,b.hops[0].address);
    assert.equal(a.path,'0x'+a.tokens[0].slice(2).toLowerCase()+a.parameters[0].toString(16).padStart(6,'0')+a.tokens[1].slice(2).toLowerCase());
    assert.equal(a.sourceNative,a.source==='eth');assert.equal(a.targetNative,a.target==='eth');
  }
  for(const r of routes){assert.ok(![r.source,r.target].includes('usde'));if(r.source==='eth')assert.equal(r.tokens[0],WETH);if(r.target==='eth')assert.equal(r.tokens[1],WETH);}
  assert.throws(()=>encodeV3Path([WETH,WETH],[3000]),{code:'NEW_POOL_PATH_INVALID'});
  assert.throws(()=>encodeV3Path([policy.assets[0].address,WETH],[16777216]),{code:'NEW_POOL_PATH_FEE_INVALID'});
});

test('no review is pending and cannot produce a ready-for-broadcast plan',async()=>{
  const plan=await createNewPoolPlan({root});assert.equal(plan.verification.complete,false);
  assert.ok(plan.verification.blockers.includes('TOKEN_AND_ROUTE_REVIEW_MISSING'));
  assert.equal(plan.readyForBroadcast,false);assert.equal(plan.signingEnabled,false);
  assert.equal(plan.networkRequests,0);assert.equal(plan.privateFilesRead,false);assert.equal(plan.transactionsBroadcast,0);
  assert.equal(plan.pools.length,4);assert.equal(plan.adapters.length,6);
  assert.equal(plan.maximumProposedNewGasWei,'4800000000000000');
  assert.deepEqual(plan.sharedComponentsToReuse,SHARED);
  const dataPlan=await createNewPoolPlan({root,includeCalldata:true});
  assert.equal(dataPlan.planId,plan.planId);
  for(const p of dataPlan.pools){
    assert.match(p.unsignedCreate.data,/^0x[0-9a-f]+$/i);
    assert.equal(sha256(Buffer.from(p.unsignedCreate.data.slice(2),'hex')),p.unsignedCreate.dataSHA256);
    assert.equal(p.unsignedCreate.nonce,null);assert.equal(p.unsignedCreate.gasPrice,null);
    assert.equal(p.unsignedCreate.data.slice(-128),BigInt(p.constructorArguments[4]).toString(16).padStart(64,'0')+BigInt(p.constructorArguments[5]).toString(16).padStart(64,'0'));
  }
});

test('complete synthetic evidence requires shared anchors, source and exact-transfer/fork results',()=>{
  assert.equal(assess(fixture()).complete,true);
  const a=fixture();a.sharedComponents.PoseidonT3.creationInputMatched=false;
  assert.ok(assess(a).blockers.includes('SHARED_COMPONENT_RECHECK_REQUIRED:PoseidonT3'));
  const b=fixture();b.assets[2].transferBehavior.noTransferFee=false;
  assert.ok(assess(b).blockers.includes('TOKEN_EXACT_BALANCE_TEST_REQUIRED:pons'));
  const c=fixture();c.assets[1].sourceReview.complete=false;
  assert.ok(assess(c).blockers.includes('TOKEN_SOURCE_REVIEW_REQUIRED:usde'));
});

test('issuer freeze/blacklist/pause and upgrade powers remain explicit approval blockers',()=>{
  for(const field of ['freezeAuthority','blacklistAuthority','pauseAuthority']){
    const r=fixture();r.assets[0].controls[field]=true;
    assert.ok(assess(r).blockers.includes('EXPLICIT_ISSUER_CONTROL_RISK_APPROVAL_REQUIRED:aapl'));
  }
  const r=fixture();r.assets[0].sourceReview.upgradeable=true;r.assets[0].sourceReview.implementations=[{address:SHARED.PoseidonT3,runtimeCodeHash:code}];
  r.assets[0].sourceReview.upgradeAuthority=SHARED.Phase2ASPRegistry;
  assert.ok(assess(r).blockers.includes('EXPLICIT_ISSUER_CONTROL_RISK_APPROVAL_REQUIRED:aapl'));
  const broken=fixture();broken.assets[0].sourceReview={upgradeable:true};
  assert.ok(assess(broken).blockers.includes('TOKEN_PROXY_AUTHORITY_REVIEW_REQUIRED:aapl'));
});

test('wrong chain, policy, token decimals and market binding cannot satisfy evidence review',()=>{
  const r=fixture();r.policySHA256=sha;
  assert.throws(()=>assess(r),{code:'NEW_POOL_REVIEW_IDENTITY'});
  const a=fixture();a.assets[1].decimals=6;
  assert.throws(()=>assess(a),{code:'NEW_POOL_REVIEW_TOKEN_BINDING'});
  const b=fixture();b.markets[0].fee=10000;
  assert.throws(()=>assess(b),{code:'NEW_POOL_REVIEW_MARKET_BINDING'});
  const c=fixture();c.markets[0].tokens=[WETH,policy.assets[0].address];
  assert.ok(assess(c).blockers.includes('DEX_MARKET_REVIEW_REQUIRED:aapl-usdg'));
  const d=fixture();d.markets[1].factoryGetPoolMatched=false;
  assert.ok(assess(d).blockers.includes('DEX_MARKET_REVIEW_REQUIRED:pons-eth'));
});

test('CLI refuses deploy and private or escaping review paths before reading them',()=>{
  const script=path.join(root,'scripts/operations/new-pools-mainnet-plan.mjs');
  for(const args of [['--deploy'],['--plan','--review','.phase1-private/signers/foo.json'],['--plan','--review','../elsewhere.json']]){
    assert.throws(()=>execFileSync(process.execPath,[script,...args],{cwd:root,stdio:['ignore','pipe','pipe']}),error=>{
      const result=JSON.parse(error.stderr);assert.equal(result.signingEnabled,false);assert.equal(result.transactionsSigned,0);
      assert.ok(['NEW_POOL_DEPLOYMENT_NOT_IMPLEMENTED_OR_AUTHORIZED','NEW_POOL_PUBLIC_PATH_REQUIRED'].includes(result.error));return true;
    });
  }
});
