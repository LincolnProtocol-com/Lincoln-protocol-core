#!/usr/bin/env node
// Unsigned offline helpers for a separate, untested candidate. No RPC or wallet imports.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {encodeAbiParameters,getAddress,keccak256,toBytes,zeroAddress} from 'viem';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const abiFile='config/hedgefun-v4-candidate-abi.json';
const FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const INT128_MAX=(1n<<127n)-1n;
const UINT128_MAX=(1n<<128n)-1n;
const need=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const address=value=>{need(typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value),'V4_CANDIDATE_ADDRESS');const a=getAddress(value);need(a!==zeroAddress,'V4_CANDIDATE_ZERO_ADDRESS');return a;};
const integer=(value,max,code)=>{need(typeof value==='bigint'||typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),code);const n=BigInt(value);need(n>=0n&&n<=max,code);return n;};
const types=values=>values.map(type=>({type}));
const hash=(t,v)=>keccak256(encodeAbiParameters(types(t),v));

export const HEDGEFUN_V4_CANDIDATE=Object.freeze({
  chainId:4663,domain:keccak256(toBytes('LINCOLN_HEDGEFUN_FIXED_V4_FEE_V1')),
  strategyId:2n,feeBps:30n,hookTaxBps:100n,
  lincoln:'0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE',spcx:'0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
  router:'0x5f3e9D177231527D56fB62aCc398f22cc8F2c328',factory:'0xC78b6A83d75C5612a1A7323702B56038254a6459',
  manager:'0x8366a39CC670B4001A1121B8F6A443A643e40951',hook:'0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC',
  curve:'0x2C27b7Fb50D85567760487010A827039711D2A66',strategyTreasury:'0x72aBbC490A18B5c0c61A9BeA4Ed091a74Eef991F',
  strategyImplementation:'0xfF608632AF7621AA0c84607385056bBA9B547616',upgradeController:'0xEdAb12AB7B673648d2D2c79d37565032E1a23Bbf',
  treasury:'0x9CF17a6E3c75D200f58283A165C442a8A3994555',poolId:'0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55',
  lincolnToSpcxLimit:4295128740n,spcxToLincolnLimit:1461446703485210103287273052203988822378723970341n,
});

export function minimumGrossOutput(minimumNet){
  const net=integer(minimumNet,INT128_MAX,'V4_CANDIDATE_NET_AMOUNT');need(net>0n,'V4_CANDIDATE_NET_AMOUNT');
  const gross=(net-1n)*10000n/(10000n-HEDGEFUN_V4_CANDIDATE.feeBps)+1n;
  need(gross<=INT128_MAX,'V4_CANDIDATE_IMPOSSIBLE_OUTPUT');return gross;
}

/** Build the exact action envelope for the future frozen source-pool proof.
 * Does not prove the source/target addresses are deployed or approved.
 * This must remain unavailable in a live SDK until deployment evidence exists.
 */
export function prepareCandidateAction({adapter,sourcePool,targetPool,direction,action}){
  const c=HEDGEFUN_V4_CANDIDATE,a=address(adapter),source=address(sourcePool),target=address(targetPool);
  need(new Set([a.toLowerCase(),source.toLowerCase(),target.toLowerCase()]).size===3,'V4_CANDIDATE_POOL_IDENTITY');
  need(['lincoln-to-spcx','spcx-to-lincoln'].includes(direction),'V4_CANDIDATE_DIRECTION');
  need(action&&Object.getPrototypeOf(action)===Object.prototype,'V4_CANDIDATE_ACTION');
  const isBuy=direction==='spcx-to-lincoln';
  const normalized={processor:address(action.processor),amountIn:integer(action.amountIn,INT128_MAX,'V4_CANDIDATE_AMOUNT'),
    minAmountOut:integer(action.minAmountOut,INT128_MAX,'V4_CANDIDATE_NET_AMOUNT'),
    deadline:integer(action.deadline,(1n<<256n)-1n,'V4_CANDIDATE_DEADLINE'),
    targetPrecommitment:integer(action.targetPrecommitment,FIELD-1n,'V4_CANDIDATE_PRECOMMITMENT'),
    encryptedTemplate:action.encryptedTemplate,maxServiceFee:integer(action.maxServiceFee,UINT128_MAX,'V4_CANDIDATE_FEE'),
    sqrtPriceLimitX96:integer(action.sqrtPriceLimitX96,(1n<<160n)-1n,'V4_CANDIDATE_PRICE_LIMIT'),
    maxHookTaxBps:integer(action.maxHookTaxBps,10000n,'V4_CANDIDATE_TAX')};
  need(normalized.amountIn>0n&&normalized.targetPrecommitment>0n&&normalized.deadline>0n,'V4_CANDIDATE_ACTION');
  need(typeof normalized.encryptedTemplate==='string'&&/^0x[0-9a-fA-F]{512}$/.test(normalized.encryptedTemplate),'V4_CANDIDATE_TEMPLATE');
  need(normalized.sqrtPriceLimitX96===(isBuy?c.spcxToLincolnLimit:c.lincolnToSpcxLimit),'V4_CANDIDATE_PRICE_LIMIT');
  need(normalized.maxHookTaxBps>=c.hookTaxBps,'V4_CANDIDATE_TAX');
  const minimumGross=minimumGrossOutput(normalized.minAmountOut);
  const venueHash=hash(['address','address','uint256','address','address','address','address','address','bytes32','bool','uint16','address'],
    [c.router,c.factory,c.strategyId,c.curve,c.strategyTreasury,c.strategyImplementation,c.upgradeController,c.manager,c.poolId,isBuy,c.feeBps,c.treasury]);
  const actionHash=hash(['bytes32','uint256','address','address','address','bytes32','address','uint128','uint128','uint256','uint256','bytes32','uint128','uint160','uint16'],
    [c.domain,BigInt(c.chainId),a,source,target,venueHash,normalized.processor,normalized.amountIn,normalized.minAmountOut,
      normalized.deadline,normalized.targetPrecommitment,keccak256(normalized.encryptedTemplate),normalized.maxServiceFee,
      normalized.sqrtPriceLimitX96,normalized.maxHookTaxBps]);
  return {action:normalized,actionHash,venueHash,actionEnvelope:actionHash+'00'.repeat(224),minimumGrossOutput:minimumGross,
    extData:{recipient:a,feeRecipient:zeroAddress,processor:a,publicIn:0n,publicOut:normalized.amountIn,fee:0n},
    requiredPublicSignals:{1:0n,2:normalized.amountIn,8:0n},
    encryptedOutput1:'Use actionEnvelope verbatim in the proof-bound second output slot.',
    executionEnabled:false,deploymentApproval:null,networkRequests:0,transactionsSigned:0};
}

export async function candidatePlan(){
  const candidate=JSON.parse(await fs.readFile(path.join(ROOT,abiFile),'utf8'));
  const bytes=await fs.readFile(path.join(ROOT,candidate.source));
  need(createHash('sha256').update(bytes).digest('hex')===candidate.sourceSHA256,'V4_CANDIDATE_SOURCE_HASH_CHANGED');
  const c=HEDGEFUN_V4_CANDIDATE;
  return {schema:'lincoln-v4-typed-router-offline-plan/v1',chainId:c.chainId,status:candidate.status,
    candidateContract:candidate.contract,source:candidate.source,sourceSHA256:candidate.sourceSHA256,abi:abiFile,
    deployedRouter:c.router,strategyId:String(c.strategyId),poolManager:c.manager,poolId:c.poolId,
    poolKey:{currency0:c.lincoln,currency1:c.spcx,fee:2000,tickSpacing:60,hooks:c.hook},
    serviceFeeBps:30,hookFlatStockTaxBps:100,lpFeePips:2000,treasury:c.treasury,
    constructorIntents:[
      {direction:'lincoln-to-spcx',sourcePool:null,targetPool:null,sourceProfile:'lincoln',targetProfile:'spcx',sqrtPriceLimitX96:String(c.lincolnToSpcxLimit)},
      {direction:'spcx-to-lincoln',sourcePool:null,targetPool:null,sourceProfile:'spcx',targetProfile:'lincoln',sqrtPriceLimitX96:String(c.spcxToLincolnLimit)}],
    assets:[
      {id:'lincoln',asset:c.lincoln,decimals:18,maxDeposit:String(UINT128_MAX),maxTotal:String(UINT128_MAX)},
      {id:'spcx',asset:c.spcx,decimals:18,maxDeposit:String(UINT128_MAX),maxTotal:String(UINT128_MAX)}],
    capsMode:'protocol-uint128-maximum-no-additional-business-cap',
    capSelectionStatus:'Prepared from latest user steering; final deployment scope approval pending.',
    capsUnits:'raw ERC20 base units; not a claim of exact underlying share count',
    supersededCapProposal:[
      {id:'lincoln',maxDeposit:'48000000000000000000000000',maxTotal:'670000000000000000000000000',status:'superseded-do-not-deploy'},
      {id:'spcx',maxDeposit:'17000000000000000000',maxTotal:'100000000000000000000',status:'superseded-do-not-deploy'}],
    guardianControls:{emergencyDepositPause:true,lowerCaps:true,increaseDelayHours:12},
    issuerRiskApproval:null,deploymentApproval:null,
    gasBudgetProposal:{scopeBudgetWei:'2200000000000000',maxFeePerGasWei:'100000000',
      lifetimeBudgetWei:'65000000000000000',reserveWei:'3000000000000000',approved:false,
      scope:'Two new frozen-RC3 privacy pools plus two typed V4 adapters; cumulative deployer history preserved.',
      gasLimitHints:{privacyPool:'5500000',adapter:'5500000',sumGas:'22000000'},
      ceilingAtProposedPriceWei:'2200000000000000',
      limitations:'Gas limits are conservative proposals, not eth_estimateGas results. Adapter constructor needs the two deployed privacy-pool addresses. Actual RPC estimates and approval are required before signing.'},
    exactInputOnly:true,partialFill:false,nativeAssets:false,newManagerCallback:false,arbitraryCalldata:false,
    quote:null,quoteStatus:'No live quote is implied by this offline plan. Quote must include V4 LP and hook economics with a non-exempt router sender.',
    fixedLimitOnly:true,proofBoundMinimumNetOutput:true,
    signingEnabled:false,executionEnabled:false,compiled:candidate.status.startsWith('compiled-'),tested:false,keysAccessed:false,networkRequests:0,transactionsSigned:0,transactionsBroadcast:0};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    need(process.argv.slice(2).every(arg=>arg==='--plan')&&process.argv.length<=3,'V4_CANDIDATE_PLAN_ONLY');
    console.log(JSON.stringify(await candidatePlan(),null,2));
  }catch(error){console.error(JSON.stringify({error:error.code??'V4_CANDIDATE_PLAN_FAILED',transactionsSigned:0}));process.exitCode=1;}
}
