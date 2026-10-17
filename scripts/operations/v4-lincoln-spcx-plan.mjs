#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Design-only typed intents. Uses declared viem for Ethereum Keccak; SHA3-256 is not PoolId hashing.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {encodeAbiParameters,keccak256} from 'viem';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const V4_POLICY='config/v4-lincoln-spcx-mainnet-proposal.json';
export const V4_POOL_ID='0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55';
export const V4_MANAGER='0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const V4_KEY=Object.freeze({currency0:'0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE',currency1:'0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',fee:2000,tickSpacing:60,hooks:'0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC'});
const SAFE='0x9CF17a6E3c75D200f58283A165C442a8A3994555';
const MAX128=(1n<<128n)-1n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const address=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)&&!/^0x0{40}$/i.test(x);
const sha=b=>createHash('sha256').update(b).digest('hex');
const quantity=(v,zero=false)=>{need(typeof v==='bigint'&&(zero?v>=0n:v>0n)&&v<=MAX128,'V4_PLAN_AMOUNT_INVALID');return v;};

export function poolKeyEncoding(key){
  need(key&&address(key.currency0)&&address(key.currency1)&&address(key.hooks)&&BigInt(key.currency0)<BigInt(key.currency1),'V4_PLAN_CURRENCY_ORDER');
  need(Number.isInteger(key.fee)&&key.fee>0&&key.fee<1000000&&Number.isInteger(key.tickSpacing)&&key.tickSpacing>0&&key.tickSpacing<(1<<23),'V4_PLAN_POOL_PARAMETERS');
  return encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],
    [key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]);
}
export const poolId=key=>keccak256(poolKeyEncoding(key));

export function validateV4Proposal(p){
  need(p?.schema==='lincoln-mainnet-v4-route-proposal/v1'&&p.chainId===4663&&p.status==='design-only-not-approved'
    &&p.signingEnabled===false&&p.executionEnabled===false&&p.adapterDeployed===false,'V4_PLAN_NOT_APPROVED');
  need(same(p.poolManager,V4_MANAGER)&&p.poolId===V4_POOL_ID&&Object.keys(V4_KEY).every(k=>typeof V4_KEY[k]==='string'?same(p.poolKey?.[k],V4_KEY[k]):p.poolKey?.[k]===V4_KEY[k])
    &&poolId(p.poolKey)===p.poolId,'V4_PLAN_KEY_CHANGED');
  need(Array.isArray(p.assets)&&p.assets.length===2&&p.assets[0].id==='lincoln'&&same(p.assets[0].address,V4_KEY.currency0)
    &&p.assets[1].id==='spcx'&&same(p.assets[1].address,V4_KEY.currency1)&&p.assets.every(a=>a.decimals===null&&a.depositCaps===null&&a.profile===null),'V4_PLAN_TOKEN_CAPS_UNAPPROVED');
  const d=p.adapterDesign;
  need(d?.kind==='immutable-single-pool-v4-exact-input'&&d.preferredExecution==='dedicated-poolmanager-unlock'
    &&d.exactInputOnly===true&&d.allowPartialFill===false&&d.nativeAssets===false&&d.arbitraryCalldata===false&&d.hookData==='0x'
    &&d.serviceFeeBps===30&&same(d.treasury,SAFE)&&d.gasLimit===null&&d.maxFeePerGasWei===null&&d.budgetWei===null&&d.approval===null,'V4_PLAN_ADAPTER_SCOPE_CHANGED');
  need(p.hookEconomics?.expectedFlatHookTaxBps===100&&p.hookEconomics.taxAsset==='SPCX'&&p.hookEconomics.buyTaxSide==='input'
    &&p.hookEconomics.sellTaxSide==='output'&&p.hookEconomics.lpFeePips===2000&&p.hookEconomics.erc20TransferTax===false
    &&p.hookEconomics.snipeTaxExpected===false&&p.hookEconomics.sellSpikeMayChangeEffectiveRate===true
    &&p.hookEconomics.requireOnchainRateAndVaultVerification===true,'V4_PLAN_HOOK_ECONOMICS_CHANGED');
  return p;
}

/** Fee arithmetic after a real hook-aware AMM quote; this does not simulate price impact or LP fee rounding. */
export function accountV4Quote({direction,amountIn,ammGrossOutput,effectiveHookBps=100,serviceFeeBps=30}){
  quantity(amountIn);quantity(ammGrossOutput);
  need(amountIn<=(1n<<127n)-1n&&ammGrossOutput<=(1n<<127n)-1n,'V4_PLAN_MANAGER_INT128_RANGE');
  need(['buy-lincoln','sell-lincoln'].includes(direction),'V4_PLAN_DIRECTION_INVALID');
  need(Number.isInteger(effectiveHookBps)&&effectiveHookBps>=0&&effectiveHookBps<10000&&serviceFeeBps===30,'V4_PLAN_FEE_INVALID');
  const buy=direction==='buy-lincoln';
  const stockTaxBase=buy?amountIn:ammGrossOutput;
  const hookStockTax=stockTaxBase*BigInt(effectiveHookBps)/10000n;
  const ammInput=buy?amountIn-hookStockTax:amountIn;
  const grossOutputAfterHook=buy?ammGrossOutput:ammGrossOutput-hookStockTax;
  const serviceFee=grossOutputAfterHook*30n/10000n;
  return {ammInput,hookStockTax,grossOutputAfterHook,serviceFee,netReshieldedOutput:grossOutputAfterHook-serviceFee,
    hookTaxAsset:'SPCX',serviceFeeAsset:buy?'LINCOLN':'SPCX',lpFeeAlreadyIncludedInAmmQuote:true};
}
export function minimumOutputBeforeServiceFee(minNet){quantity(minNet);return (minNet-1n)*10000n/9970n+1n;}
export function checkV4FullFill({amountIn,settledInput,settleReturn,netOutput,minNet,effectiveHookBps,maxHookTaxBps}){
  quantity(amountIn);quantity(settledInput,true);quantity(netOutput,true);quantity(minNet);
  need(amountIn<=(1n<<127n)-1n,'V4_PLAN_MANAGER_INT128_RANGE');
  need(typeof settleReturn==='bigint'&&settleReturn===settledInput,'V4_PLAN_SETTLEMENT_MISMATCH');
  need(settledInput===amountIn,'V4_PLAN_PARTIAL_FILL_REFUSED');
  need(Number.isInteger(effectiveHookBps)&&Number.isInteger(maxHookTaxBps)&&effectiveHookBps>=0&&maxHookTaxBps>=0
    &&maxHookTaxBps<10000&&effectiveHookBps<=maxHookTaxBps,'V4_PLAN_HOOK_RATE_ABOVE_LIMIT');
  need(netOutput>=minNet,'V4_PLAN_MINIMUM_NET_NOT_MET');
  return true;
}
async function publicBytes(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!s.startsWith('.')),'V4_PLAN_PUBLIC_PATH_REQUIRED');
  const f=path.join(root,relative),s=await fs.lstat(f);need(s.isFile()&&!s.isSymbolicLink()&&await fs.realpath(f)===f&&s.size<=2*1024*1024,'V4_PLAN_REGULAR_FILE_REQUIRED');
  return fs.readFile(f);
}
export async function createV4RouteIntent({root=ROOT}={}){
  root=await fs.realpath(root);
  const bytes=await publicBytes(root,V4_POLICY),p=validateV4Proposal(JSON.parse(bytes));
  const abiBytes=await publicBytes(root,p.adapterDesign.candidateABI),candidate=JSON.parse(abiBytes);
  need(candidate.status==='design-only-not-deployed'&&candidate.source===null&&candidate.runtimeCodeHash===null
    &&candidate.contract===p.adapterDesign.candidateContract&&Array.isArray(candidate.abi),'V4_PLAN_CANDIDATE_ABI_CHANGED');
  const key=Object.values(p.poolKey),routes=[['lincoln','spcx',true],['spcx','lincoln',false]].map(([source,target,zeroForOne])=>({
    id:`hedgefun-v4-${source}-to-${target}`,venue:'hedgefun-v4',source,target,poolManager:p.poolManager,poolId:p.poolId,poolKey:p.poolKey,
    zeroForOne,amountSpecifiedSign:'negative-exact-input',hookData:'0x',allowPartialFill:false,nativeAssets:false,
    adapterType:p.adapterDesign.candidateContract,adapter:null,
    constructorIntent:{types:['address','address','address','(address,address,uint24,int24,address)','uint16','address'],
      values:[`pending:privacy-pool:${source}`,`pending:privacy-pool:${target}`,p.poolManager,key,30,SAFE]},
    unsignedExecutionIntent:{to:null,value:'0',action:{processor:null,amountIn:null,minAmountOut:null,deadline:null,targetPrecommitment:null,
      encryptedTemplate:null,maxServiceFee:null,sqrtPriceLimitX96:null,maxHookTaxBps:null},proof:null,data:null,encryptedOutputs:null},
    executionEnabled:false,status:'blocked-missing-pools-adapter-and-approval'
  }));
  const identity={schema:'lincoln-v4-route-design-identity/v1',policySHA256:sha(bytes),candidateABISHA256:sha(abiBytes),poolId:p.poolId,routes};
  return {schema:'lincoln-mainnet-v4-typed-route-intent/v1',chainId:4663,planId:sha(JSON.stringify(identity)),identity,
    poolKeyABIEncoded:poolKeyEncoding(p.poolKey),computedPoolId:poolId(p.poolKey),routes,assets:p.assets,
    blockerDetails:p.requiredEvidence,readyForBroadcast:false,readyForExecution:false,signingEnabled:false,adapterDeployed:false,
    publicTransactions:0,transactionsSigned:0,networkRequests:0,
    feeDisclosure:{lpFeePips:2000,expectedHookStockTaxBps:100,hookStockTaxMaySpike:true,serviceFeeBps:30,serviceFeeBasis:'measured output after AMM and hook',
      pricingRule:'Use a live hook-aware quote with the same sender, PoolKey, exact input and price limit. Never apply a second hook or LP deduction to a quote that already includes them.'}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===3&&process.argv[2]==='--plan','USAGE_V4_DESIGN_PLAN_ONLY');console.log(JSON.stringify(await createV4RouteIntent(),null,2));}
  catch(error){console.error(JSON.stringify({error:error.code??'V4_ROUTE_DESIGN_FAILED',signingEnabled:false,transactionsSigned:0,publicTransactions:0}));process.exitCode=1;}
}
