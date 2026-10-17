#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Public, dependency-free preparation only. No RPC, wallet, signer journal or broadcast imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const POLICY_PATH='config/new-pools-mainnet-20261017.json';
export const REVIEW_SCHEMA='lincoln-mainnet-four-pool-review/v1';
export const GENESIS='0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c';
export const BUILD_SHA256='26ccf2f48a1ec45673091e2c4276c8e4d657da59cdbc3a7585fcd2358c45f747';
export const DEPLOYER='0x555998Ba2B2723C97d91FB20Da0ddb896749797e';
export const SAFE='0x9CF17a6E3c75D200f58283A165C442a8A3994555';
export const WETH='0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const DEX=Object.freeze({factory:'0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',router:'0xCaf681a66D020601342297493863E78C959E5cb2',quoter:'0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',wrappedNative:WETH});
export const SHARED=Object.freeze({PoseidonT3:'0x4781B6D29Dd0CeFEf101049E23f31D2165a553fa',PoseidonT4:'0x9096D809dc96BCeE1F9c7b64BAd8F79FA6dCF165',Phase2ASPJoinSplitVerifier:'0xA5bC542708D7fEBD706E7fD78caD2ACa785B9dF4',Phase2ASPExitVerifier:'0xF430E5d1aa6d970de10C745DC04cb7e7E1F53Ab5',Phase2ASPRegistry:'0x89ad7Cce6c161A21323BE234d9924fEe915b2660'});
const PINS=Object.freeze({core:{path:'deployments/robinhood-mainnet/rc3-eth-usdg.json',sha256:'1a21465491f1036546383d812deb408a7dbe37bf4f9b2c0eabcd8e943263de1b'},release:{path:'releases/rc3/artifacts/phase2-mainnet/release-candidate-20261017-r3.json',sha256:'dea4a351f51a78e773ed37543b533bf7d0fdac31b81ad166bd4b1ac2692f9c1d'},build:{path:'releases/rc3/artifacts/phase2-mainnet/contracts.json',sha256:BUILD_SHA256},fee:{path:'releases/rc3/artifacts/phase2-fees-mainnet/contracts.json',sha256:'1ea5a17f5de66c7933087833297a4e2cfcdc969be844d78bab18a179b9d1c997'}});
const IDS=['aapl','usde','pons','cashcat'];
const EXPECTED=[['aapl','AAPL','0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9','7.2','100'],['usde','USDe','0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34','2500','50000'],['pons','PONS','0x39dBED3a2bd333467115dE45665cC57F813C4571','7900','110000'],['cashcat','CASHCAT','0x020bfC650A365f8BB26819deAAbF3E21291018b4','22000','300000']];
const UINT128=(1n<<128n)-1n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const address=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)&&!/^0x0{40}$/i.test(x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/.test(x);
const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const decimal=x=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=4096;
export const sha256=x=>createHash('sha256').update(x).digest('hex');

/** Exact decimal parsing. Floating point, exponent notation, excess precision and uint128 overflow are rejected. */
export function tokenUnits(value,decimals){
  need(Number.isInteger(decimals)&&decimals>=0&&decimals<=38,'NEW_POOL_DECIMALS_INVALID');
  need(typeof value==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value),'NEW_POOL_DECIMAL_INVALID');
  const [whole,fraction='']=value.split('.');
  need(fraction.length<=decimals,'NEW_POOL_DECIMAL_PRECISION');
  const units=BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0');
  need(units>0n&&units<=UINT128,'NEW_POOL_UINT128_RANGE');
  return units.toString();
}

export function validateNewPoolPolicy(policy){
  need(policy?.schema==='lincoln-mainnet-four-pool-policy/v1'&&policy.chainId===4663&&policy.contractCandidate==='v0.1.0-rc.3','NEW_POOL_POLICY_IDENTITY');
  need(policy.status==='proposal-not-approved'&&policy.approval===null&&policy.acceptance?.signingEnabled===false
    &&policy.acceptance.transactionsBroadcast===0&&policy.acceptance.productionReady===false&&policy.acceptance.usdeSwapEnabled===false,'NEW_POOL_NO_APPROVAL_IN_PREPARATION');
  need(same(policy.guardian,SAFE)&&same(policy.treasury,SAFE)&&same(policy.registry,SHARED.Phase2ASPRegistry)
    &&policy.capIncreaseDelaySeconds===43200&&policy.feeBps===30,'NEW_POOL_GOVERNANCE_CHANGED');
  need(Array.isArray(policy.assets)&&policy.assets.length===4,'NEW_POOL_ASSETS_INVALID');
  for(let i=0;i<EXPECTED.length;i++){
    const [id,symbol,token,deposit,total]=EXPECTED[i],a=policy.assets[i];
    need(a?.id===id&&a.symbol===symbol&&same(a.address,token)&&a.decimals===18,'NEW_POOL_ASSET_CHANGED');
    need(a.maxDepositTokens===deposit&&a.maxTotalTokens===total,'NEW_POOL_PROPOSED_QUANTITY_CHANGED');
    need(a.depositCaps?.schema==='lincoln-pool-deposit-caps/v1'&&a.depositCaps.unit==='asset-base-units'&&a.depositCaps.status==='proposed'
      &&a.depositCaps.maxDepositUnits===tokenUnits(deposit,18)&&a.depositCaps.maxTotalUnits===tokenUnits(total,18)
      &&BigInt(a.depositCaps.maxDepositUnits)<=BigInt(a.depositCaps.maxTotalUnits),'NEW_POOL_CAP_UNITS_MISMATCH');
  }
  const m=policy.markets;
  need(Array.isArray(m)&&m.length===3&&m.every(x=>x&&address(x.pool))&&isDeepStrictEqual(m.map(x=>[x.id,x.source,x.target,x.fee,x.pool.toLowerCase()]),[
    ['aapl-usdg','aapl','usdg',500,'0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d'],
    ['pons-eth','pons','eth',3000,'0xed50bdeea8adc232f159486192a4157281d722ff'],
    ['cashcat-eth','cashcat','eth',3000,'0xd42a491087a15e5afd51feb3606066cc152d2b09']]),'NEW_POOL_ROUTE_SELECTION_CHANGED');
  need(isDeepStrictEqual(policy.proposedTransactionPolicy,{status:'proposal-not-approved',poolGasLimit:'6000000',adapterGasLimit:'4000000',newTransactionPriceCapWei:'100000000',existingCumulativeBudgetWei:'65000000000000000',existingGlobalPriceCapWei:'2800000000',reserveWei:'3000000000000000',ledgerPolicy:'Preserve the physical lincoln-deployer cumulative signer journal; never reset, copy or infer remaining budget from this proposal.'}),'NEW_POOL_GAS_PROPOSAL_CHANGED');
  return policy;
}

export function encodeV3Path(tokens,fees){
  need(Array.isArray(tokens)&&tokens.length>=2&&tokens.length<=5&&tokens.every(address)
    &&new Set(tokens.map(t=>t.toLowerCase())).size===tokens.length&&Array.isArray(fees)&&fees.length===tokens.length-1,'NEW_POOL_PATH_INVALID');
  need(fees.every(f=>Number.isInteger(f)&&f>0&&f<1000000),'NEW_POOL_PATH_FEE_INVALID');
  return '0x'+tokens[0].slice(2).toLowerCase()+fees.map((f,i)=>f.toString(16).padStart(6,'0')+tokens[i+1].slice(2).toLowerCase()).join('');
}

export function newPoolRoutes(policy){
  validateNewPoolPolicy(policy);
  need(Object.values(DEX).every(address),'NEW_POOL_DEX_ADDRESS_INVALID');
  const assets=Object.fromEntries(policy.assets.map(a=>[a.id,a.address]));Object.assign(assets,{eth:WETH,usdg:USDG});
  return policy.markets.flatMap(m=>[[m.source,m.target],[m.target,m.source]].map(([source,target])=>({
    id:`uniswap-${source}-to-${target}`,venue:'uniswap',source,target,protocol:0,...DEX,
    tokens:[assets[source],assets[target]],parameters:[m.fee],path:encodeV3Path([assets[source],assets[target]],[m.fee]),
    hops:[{address:m.pool,runtimeCodeHash:null}],feeBps:30,treasury:SAFE,selected:true,executionEnabled:false,
    sourceNative:source==='eth',targetNative:target==='eth',verificationStatus:'pending-live-pool-and-source-review'
  })));
}

async function readPublic(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')
    &&relative.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.startsWith('.')&&!['node_modules','keystore','signers'].includes(x)),'NEW_POOL_PUBLIC_PATH_REQUIRED');
  const file=path.join(root,relative),s=await fs.lstat(file);
  need(s.isFile()&&!s.isSymbolicLink()&&await fs.realpath(file)===file&&s.size<=64*1024*1024,'NEW_POOL_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(file);
}

function coreReferences(core){
  const p=core.profiles?.eth;
  need(p?.schema==='phase2-asp-production-profile/v1'&&p.chain?.id===4663&&p.genesisHash===GENESIS
    &&p.artifactSHA256===BUILD_SHA256,'NEW_POOL_CORE_PROFILE_INVALID');
  return {...p.libraries,Phase2ASPJoinSplitVerifier:p.verifier,Phase2ASPExitVerifier:p.exitVerifier,Phase2ASPRegistry:p.registry};
}

/** This checks public evidence structure and bindings; it never substitutes for live pre-broadcast verification. */
export function assessNewPoolReview({review,policy,policySHA256,core}){
  const blockers=[];
  if(!review)return {complete:false,blockers:['TOKEN_AND_ROUTE_REVIEW_MISSING'],issuerControlledAssets:[]};
  need(review.schema===REVIEW_SCHEMA&&review.chainId===4663&&review.genesisHash===GENESIS&&review.policySHA256===policySHA256,'NEW_POOL_REVIEW_IDENTITY');
  need(decimal(review.observation?.blockNumber)&&hash(review.observation?.blockHash)&&text(review.observation?.observedAt)
    &&review.transactionsBroadcast===0,'NEW_POOL_REVIEW_OBSERVATION');
  const refs=coreReferences(core);
  for(const [id,ref]of Object.entries(refs)){
    const r=review.sharedComponents?.[id];
    if(!(r&&same(r.address,ref.address)&&r.runtimeCodeHash===ref.runtimeCodeHash&&r.startBlock===ref.startBlock
      &&r.blockHash===ref.blockHash&&r.creationReceiptMatched===true&&r.creationInputMatched===true))blockers.push(`SHARED_COMPONENT_RECHECK_REQUIRED:${id}`);
  }
  need(Array.isArray(review.assets)&&review.assets.length===4&&new Set(review.assets.map(a=>a.id)).size===4,'NEW_POOL_REVIEW_ASSETS');
  const issuerControlledAssets=[];
  for(const a of policy.assets){
    const r=review.assets.find(x=>x.id===a.id);
    need(r&&same(r.address,a.address)&&r.symbol===a.symbol&&r.decimals===a.decimals&&hash(r.runtimeCodeHash),'NEW_POOL_REVIEW_TOKEN_BINDING');
    const s=r.sourceReview,t=r.transferBehavior,c=r.controls;
    if(!(s?.complete===true&&text(s.sourceURL)&&digest(s.sourceSHA256)&&s.runtimeMatchesReviewedSource===true
      &&typeof s.upgradeable==='boolean'&&Array.isArray(s.implementations)&&s.implementations.every(i=>address(i.address)&&hash(i.runtimeCodeHash))))blockers.push(`TOKEN_SOURCE_REVIEW_REQUIRED:${a.id}`);
    if(s?.upgradeable===true&&(!Array.isArray(s.implementations)||!s.implementations.length||!address(s.upgradeAuthority)))blockers.push(`TOKEN_PROXY_AUTHORITY_REVIEW_REQUIRED:${a.id}`);
    if(!(t?.forkTestPassed===true&&digest(t.evidenceSHA256)&&t.transferExact===true&&t.transferFromExact===true
      &&t.noTransferFee===true&&t.noRebase===true))blockers.push(`TOKEN_EXACT_BALANCE_TEST_REQUIRED:${a.id}`);
    if(!(c&&typeof c.freezeAuthority==='boolean'&&typeof c.blacklistAuthority==='boolean'&&typeof c.pauseAuthority==='boolean'&&typeof c.bridgeAuthority==='boolean'
      &&text(c.description)&&['absent','issuer-controlled'].includes(c.poolAddressBlocking)))blockers.push(`TOKEN_CONTROL_DISCLOSURE_REQUIRED:${a.id}`);
    else if(c.freezeAuthority||c.blacklistAuthority||c.pauseAuthority||c.poolAddressBlocking==='issuer-controlled'||s?.upgradeable===true){
      issuerControlledAssets.push(a.id);
      // Known issuer powers are disclosed, never silently interpreted as no blacklist/freeze.
      blockers.push(`EXPLICIT_ISSUER_CONTROL_RISK_APPROVAL_REQUIRED:${a.id}`);
    }
  }
  const routes=newPoolRoutes(policy);
  need(Array.isArray(review.markets)&&review.markets.length===3&&new Set(review.markets.map(m=>m.id)).size===3,'NEW_POOL_REVIEW_MARKETS');
  for(const m of policy.markets){
    const r=review.markets.find(x=>x.id===m.id),route=routes.find(x=>x.source===m.source&&x.target===m.target);
    need(r&&same(r.address,m.pool)&&r.fee===m.fee,'NEW_POOL_REVIEW_MARKET_BINDING');
    if(!(same(r.factory,DEX.factory)&&same(r.router,DEX.router)&&same(r.quoter,DEX.quoter)&&same(r.wrappedNative,WETH)
      &&hash(r.runtimeCodeHash)&&r.factoryGetPoolMatched===true&&r.routerBindingsMatched===true
      &&Array.isArray(r.tokens)&&r.tokens.length===2&&r.tokens.every(address)
      &&isDeepStrictEqual([...r.tokens].map(x=>x.toLowerCase()).sort(),route.tokens.map(x=>x.toLowerCase()).sort())
      &&r.swapSimulationPassed===true&&digest(r.swapEvidenceSHA256)))blockers.push(`DEX_MARKET_REVIEW_REQUIRED:${m.id}`);
  }
  return {complete:blockers.length===0,blockers,issuerControlledAssets};
}

function staticArgument(value,type){
  if(type==='address'){need(address(value),'NEW_POOL_ABI_ADDRESS');return value.slice(2).toLowerCase().padStart(64,'0');}
  need(type==='uint128'&&decimal(value)&&BigInt(value)<=UINT128,'NEW_POOL_ABI_UINT128');return BigInt(value).toString(16).padStart(64,'0');
}
function poolInitcode(artifact,args){
  need(artifact.abi.find(a=>a.type==='constructor')?.inputs?.map(i=>i.type).join(',')==='address,address,address,address,uint128,uint128','NEW_POOL_POOL_CONSTRUCTOR_CHANGED');
  let code=artifact.bytecode.slice(2);
  for(const groups of Object.values(artifact.linkReferences))for(const [name,refs]of Object.entries(groups)){
    need(address(SHARED[name]),'NEW_POOL_LIBRARY_MISSING');
    for(const r of refs){need(r.length===20&&Number.isSafeInteger(r.start)&&r.start>=0&&(r.start+r.length)*2<=code.length,'NEW_POOL_LIBRARY_REFERENCE');code=code.slice(0,r.start*2)+SHARED[name].slice(2).toLowerCase()+code.slice((r.start+r.length)*2);}
  }
  need(/^[0-9a-f]+$/i.test(code),'NEW_POOL_UNLINKED_BYTECODE');
  return '0x'+code+args.map((a,i)=>staticArgument(a,i<4?'address':'uint128')).join('');
}

export async function createNewPoolPlan({root=ROOT,reviewPath=null,includeCalldata=false}={}){
  root=await fs.realpath(root);
  const policyBytes=await readPublic(root,POLICY_PATH),policy=validateNewPoolPolicy(JSON.parse(policyBytes));
  const files={};
  for(const [id,pin]of Object.entries(PINS)){const b=await readPublic(root,pin.path);need(sha256(b)===pin.sha256,'NEW_POOL_FROZEN_INPUT_MISMATCH');files[id]=JSON.parse(b);}
  const {core,release,build,fee}=files,refs=coreReferences(core);
  need(core.schema==='phase2-mainnet-deployed/v1'&&core.chainId===4663&&core.genesisHash===GENESIS&&core.releaseId===BUILD_SHA256
    &&release.chainId===4663&&release.coreArtifactSHA256===BUILD_SHA256&&release.feeArtifactSHA256===PINS.fee.sha256,'NEW_POOL_CORE_RELEASE_MISMATCH');
  for(const [id,expected]of Object.entries(SHARED))need(same(core.addresses[id],expected)&&same(refs[id]?.address,expected)&&hash(refs[id]?.runtimeCodeHash)
    &&decimal(refs[id]?.startBlock)&&hash(refs[id]?.blockHash),'NEW_POOL_SHARED_ANCHOR_MISMATCH');
  for(const name of ['joinsplit','holder-exit']){
    const m=core.production?.manifests?.[name];need(m&&digest(m.sha256),'NEW_POOL_CIRCUIT_MANIFEST_MISSING');
    need(sha256(await readPublic(root,'releases/rc3/'+m.path))===m.sha256&&core.profiles.eth.circuitManifests[name]===m.sha256,'NEW_POOL_CIRCUIT_MANIFEST_CHANGED');
  }
  const policySHA256=sha256(policyBytes),reviewBytes=reviewPath?await readPublic(root,reviewPath):null;
  const review=reviewBytes?JSON.parse(reviewBytes):null,acceptance=assessNewPoolReview({review,policy,policySHA256,core});
  const pools=policy.assets.map(a=>{
    const args=[SHARED.Phase2ASPJoinSplitVerifier,SHARED.Phase2ASPExitVerifier,SHARED.Phase2ASPRegistry,a.address,a.depositCaps.maxDepositUnits,a.depositCaps.maxTotalUnits];
    const data=poolInitcode(build.Phase2ASPPool,args);
    return {id:`pool:${a.id}`,asset:a,contract:'Phase2ASPPool',linkedLibraries:{PoseidonT3:SHARED.PoseidonT3,PoseidonT4:SHARED.PoseidonT4},
      constructorArguments:args,unsignedCreate:{chainId:4663,from:DEPLOYER,to:null,value:'0',gasLimit:policy.proposedTransactionPolicy.poolGasLimit,
        dataSHA256:sha256(Buffer.from(data.slice(2),'hex')),...(includeCalldata?{data}:{}),nonce:null,gasPrice:null},status:'not-deployed'};
  });
  const routes=newPoolRoutes(policy).map(r=>{
    const observed=review?.markets.find(m=>same(m.address,r.hops[0].address));
    return {...r,hops:[{...r.hops[0],runtimeCodeHash:observed?.runtimeCodeHash??null}]};
  });
  const poolFor=id=>core.addresses[`pool:${id}`]??`created:pool:${id}`;
  need(fee.Phase2FeeRouter02Adapter?.abi.find(a=>a.type==='constructor')?.inputs.map(i=>i.type).join(',')==='address,address,address,address,uint8,bytes,uint16,address','NEW_POOL_ADAPTER_CONSTRUCTOR_CHANGED');
  const adapters=routes.map(r=>({id:`route:${r.id}`,contract:'Phase2FeeRouter02Adapter',constructorArguments:[poolFor(r.source),poolFor(r.target),r.router,WETH,0,r.path,30,SAFE],
    unresolvedCreatedPoolReferences:[r.source,r.target].filter(id=>IDS.includes(id)),gasLimit:policy.proposedTransactionPolicy.adapterGasLimit,status:'not-deployed'}));
  const identity={schema:'lincoln-mainnet-four-pool-intent/v1',chainId:4663,genesisHash:GENESIS,deployer:DEPLOYER,
    policy:{path:POLICY_PATH,sha256:policySHA256},pinnedInputs:PINS,review:reviewPath?{path:reviewPath,sha256:sha256(reviewBytes)}:null,
    sharedAnchors:refs,poolIntents:pools.map(p=>({id:p.id,constructorArguments:p.constructorArguments,dataSHA256:p.unsignedCreate.dataSHA256})),
    adapterIntents:adapters,proposedTransactionPolicy:policy.proposedTransactionPolicy};
  const maxGas=BigInt(pools.length)*BigInt(policy.proposedTransactionPolicy.poolGasLimit)+BigInt(adapters.length)*BigInt(policy.proposedTransactionPolicy.adapterGasLimit);
  return {schema:'lincoln-mainnet-four-pool-plan/v1',mode:'offline-preparation',planId:sha256(JSON.stringify(identity)),identity,
    sharedComponentsToReuse:SHARED,existingPoolsPreserved:['eth','usdg','nvda','spy','meta','tsla','googl','qqq','mstr'],pools,routes,adapters,
    verification:acceptance,releaseId:BUILD_SHA256,production:core.production,
    maximumProposedNewGasWei:(maxGas*BigInt(policy.proposedTransactionPolicy.newTransactionPriceCapWei)).toString(),
    reserveWei:policy.proposedTransactionPolicy.reserveWei,
    blockers:[...acceptance.blockers,'USER_CAP_AND_DEPLOYMENT_APPROVAL_REQUIRED','PROPOSED_NEW_TRANSACTION_PRICE_CAP_APPROVAL_REQUIRED',
      'LIVE_SHARED_SIGNER_BUDGET_NONCE_AND_BALANCE_CHECK_REQUIRED','DEPLOYMENT_RUNNER_REVIEW_REQUIRED','INDEXER_ASP_RELAY_ACCESS_ROSTER_ROLLOUT_REQUIRED'],
    readyForBroadcast:false,signingEnabled:false,networkRequests:0,privateFilesRead:false,transactionsSigned:0,transactionsBroadcast:0,
    intendedPublicOutput:'deployments/robinhood-mainnet/four-pools-20261017.json',
    intendedPublicOutputSchema:'phase2-mainnet-stock-extension-deployed/v1',
    limitations:['Preparation is not a deployed pool record or a mainnet approval. No CREATE address is guessed from an unchecked nonce.',
      'Public review evidence may become stale and must be checked again immediately before a future signed deployment.',
      'Token taxes or rebases are unsupported. Future issuer freeze, blacklist, pause or upgrade powers can make pooled assets unavailable.',
      'Caps are fixed token units, not live dollar limits. USDe has no swap route in this proposal.']};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    need(!args.includes('--deploy'),'NEW_POOL_DEPLOYMENT_NOT_IMPLEMENTED_OR_AUTHORIZED');
    need(args[0]==='--plan','USAGE_NEW_POOL_PLAN');let reviewPath=null,includeCalldata=false;
    for(let i=1;i<args.length;i++){
      if(args[i]==='--review'&&args[i+1]&&!reviewPath)reviewPath=args[++i];
      else if(args[i]==='--include-calldata'&&!includeCalldata)includeCalldata=true;
      else need(false,'USAGE_NEW_POOL_PLAN');
    }
    console.log(JSON.stringify(await createNewPoolPlan({reviewPath,includeCalldata}),null,2));
  }catch(error){console.error(JSON.stringify({error:error.code??'NEW_POOL_PLAN_FAILED',signingEnabled:false,transactionsSigned:0,transactionsBroadcast:0}));process.exitCode=1;}
}
