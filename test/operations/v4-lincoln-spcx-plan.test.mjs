// SPDX-License-Identifier: BUSL-1.1
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {encodeFunctionData,decodeFunctionData,keccak256} from 'viem';
import {V4_KEY,V4_POOL_ID,V4_POLICY,poolKeyEncoding,poolId,validateV4Proposal,createV4RouteIntent,
  accountV4Quote,minimumOutputBeforeServiceFee,checkV4FullFill} from '../../scripts/operations/v4-lincoln-spcx-plan.mjs';

const policy=JSON.parse(await fs.readFile(new URL('../../'+V4_POLICY,import.meta.url)));
const candidate=JSON.parse(await fs.readFile(new URL('../../config/v4-lincoln-spcx-candidate-abi.json',import.meta.url)));

test('canonical ABI-encoded PoolKey commits currencies, fee, spacing and hook',()=>{
  assert.equal(poolId(V4_KEY),V4_POOL_ID);
  assert.equal(keccak256(poolKeyEncoding(V4_KEY)),V4_POOL_ID);
  assert.equal((poolKeyEncoding(V4_KEY).length-2)/2,160);
  assert.equal(BigInt(V4_KEY.hooks)&0x3fffn,0x28ccn);
  for(const changed of [{...V4_KEY,fee:3000},{...V4_KEY,tickSpacing:200},{...V4_KEY,hooks:V4_KEY.currency0}])assert.notEqual(poolId(changed),V4_POOL_ID);
  assert.throws(()=>poolId({...V4_KEY,currency0:V4_KEY.currency1,currency1:V4_KEY.currency0}),{code:'V4_PLAN_CURRENCY_ORDER'});
});

test('typed unsigned directions keep currencies fixed and never claim deployment or token caps',async()=>{
  const plan=await createV4RouteIntent();assert.equal(plan.computedPoolId,V4_POOL_ID);
  assert.equal(plan.routes.length,2);
  const [sell,buy]=plan.routes;assert.equal(sell.source,'lincoln');assert.equal(sell.zeroForOne,true);
  assert.equal(buy.source,'spcx');assert.equal(buy.zeroForOne,false);
  for(const r of plan.routes){assert.deepEqual(r.poolKey,V4_KEY);assert.equal(r.constructorIntent.values[3][0],V4_KEY.currency0);
    assert.equal(r.constructorIntent.values[3][1],V4_KEY.currency1);assert.equal(r.allowPartialFill,false);assert.equal(r.hookData,'0x');
    assert.equal(r.adapter,null);assert.equal(r.executionEnabled,false);assert.equal(r.unsignedExecutionIntent.to,null);}
  for(const a of plan.assets){assert.equal(a.decimals,null);assert.equal(a.depositCaps,null);assert.equal(a.profile,null);}
  assert.equal(plan.signingEnabled,false);assert.equal(plan.publicTransactions,0);assert.equal(plan.networkRequests,0);assert.equal(plan.readyForExecution,false);
});

test('proposal refuses invented capacities, gas approval, dynamic fee or a substituted PoolKey',()=>{
  assert.equal(validateV4Proposal(policy),policy);
  const p=structuredClone(policy);p.assets[0].depositCaps={maxTotalUnits:'1000000000'};
  assert.throws(()=>validateV4Proposal(p),{code:'V4_PLAN_TOKEN_CAPS_UNAPPROVED'});
  const q=structuredClone(policy);q.adapterDesign.budgetWei='1000000';
  assert.throws(()=>validateV4Proposal(q),{code:'V4_PLAN_ADAPTER_SCOPE_CHANGED'});
  const r=structuredClone(policy);r.poolKey.hooks=V4_KEY.currency0;
  assert.throws(()=>validateV4Proposal(r),{code:'V4_PLAN_KEY_CHANGED'});
});

test('hook buy tax is on stock input; output service fee never subtracts it twice',()=>{
  // A hypothetical same-unit quote after input hook tax and LP fee, not a price oracle.
  const x=accountV4Quote({direction:'buy-lincoln',amountIn:100000n,ammGrossOutput:98802n});
  assert.equal(x.hookStockTax,1000n);assert.equal(x.ammInput,99000n);
  assert.equal(x.grossOutputAfterHook,98802n);assert.equal(x.serviceFee,296n);assert.equal(x.netReshieldedOutput,98506n);
  assert.equal(x.hookTaxAsset,'SPCX');assert.equal(x.serviceFeeAsset,'LINCOLN');assert.equal(x.lpFeeAlreadyIncludedInAmmQuote,true);
});

test('hook sell tax is on stock output before measured-output service fee',()=>{
  const x=accountV4Quote({direction:'sell-lincoln',amountIn:100000n,ammGrossOutput:99800n});
  assert.equal(x.ammInput,100000n);assert.equal(x.hookStockTax,998n);assert.equal(x.grossOutputAfterHook,98802n);
  assert.equal(x.serviceFee,296n);assert.equal(x.netReshieldedOutput,98506n);assert.equal(x.serviceFeeAsset,'SPCX');
  const dust=accountV4Quote({direction:'sell-lincoln',amountIn:1n,ammGrossOutput:1n});
  assert.equal(dust.hookStockTax,0n);assert.equal(dust.serviceFee,0n);assert.equal(dust.netReshieldedOutput,1n);
});

test('minimum gross before Lincoln output fee is exact at every rounding boundary',()=>{
  for(const n of [1n,2n,333n,334n,997n,9970n,10000n,1000000000000000001n]){
    const gross=minimumOutputBeforeServiceFee(n);
    assert.ok(gross-gross*30n/10000n>=n);
    if(gross>1n)assert.ok(gross-1n-(gross-1n)*30n/10000n<n);
  }
});

test('full input settlement, hook-rate cap and absolute post-fee min cannot be prorated',()=>{
  const p={amountIn:1000n,settledInput:1000n,settleReturn:1000n,netOutput:800n,minNet:800n,effectiveHookBps:100,maxHookTaxBps:100};
  assert.equal(checkV4FullFill(p),true);
  assert.throws(()=>checkV4FullFill({...p,settledInput:999n,settleReturn:999n}),{code:'V4_PLAN_PARTIAL_FILL_REFUSED'});
  assert.throws(()=>checkV4FullFill({...p,settleReturn:999n}),{code:'V4_PLAN_SETTLEMENT_MISMATCH'});
  assert.throws(()=>checkV4FullFill({...p,netOutput:799n}),{code:'V4_PLAN_MINIMUM_NET_NOT_MET'});
  assert.throws(()=>checkV4FullFill({...p,effectiveHookBps:101}),{code:'V4_PLAN_HOOK_RATE_ABOVE_LIMIT'});
});

test('candidate swap ABI preserves frozen pool ExtData layout and binds added V4 limits',async()=>{
  const core=JSON.parse(await fs.readFile(new URL('../../releases/rc3/artifacts/phase2-mainnet/contracts.json',import.meta.url)));
  const frozen=core.Phase2ASPPool.abi.find(x=>x.name==='transact').inputs[4].components.map(({name,type})=>({name,type}));
  const swap=candidate.abi.find(x=>x.name==='swap');assert.deepEqual(swap.inputs[2].components,frozen);
  assert.equal(swap.inputs[0].components.at(-2).name,'sqrtPriceLimitX96');assert.equal(swap.inputs[0].components.at(-1).name,'maxHookTaxBps');
  const action={processor:V4_KEY.currency0,amountIn:1000n,minAmountOut:900n,deadline:1790000000n,targetPrecommitment:1n,
    encryptedTemplate:'0x'+'00'.repeat(256),maxServiceFee:10n,sqrtPriceLimitX96:4295128740n,maxHookTaxBps:100};
  const data=encodeFunctionData({abi:candidate.abi,functionName:'actionHash',args:[action]});
  const decoded=decodeFunctionData({abi:candidate.abi,data});assert.equal(decoded.args[0].maxHookTaxBps,100);
  assert.equal(decoded.args[0].minAmountOut,900n);
  assert.equal(candidate.source,null);assert.equal(candidate.runtimeCodeHash,null);assert.equal(candidate.status,'design-only-not-deployed');
  assert.ok(!candidate.abi.some(f=>['execute','multicall','delegatecall','sweep'].includes(f.name)));
});
