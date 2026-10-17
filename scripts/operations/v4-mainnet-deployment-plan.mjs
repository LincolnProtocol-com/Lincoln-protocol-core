#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Public files only. No RPC, private stores, keystores or signing modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {encodeDeployData} from 'viem';
import {GENESIS,BUILD_SHA256,DEPLOYER,SAFE,SHARED,sha256} from './new-pools-mainnet-plan.mjs';
import {HEDGEFUN_V4_CANDIDATE as V4} from './hedgefun-v4-candidate-plan.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const V4_POLICY='config/v4-mainnet-deployment-policy.json';
export const V4_REVIEW='deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json';
export const V4_BUILD='config/hedgefun-v4-candidate-build.json';
export const V4_ABI='config/hedgefun-v4-candidate-abi.json';
export const V4_BUILD_SHA='36fb4b20a05f8a67a85fa897b04f5a162b05b1bd5ad8a16b449c7e63592be3c1';
export const V4_SOURCE_SHA='edc4de2de41e3daadb9d86b0d8d2fe026afcca1d624c3e6745fee3ca84cb8490';
export const UINT128_MAX='340282366920938463463374607431768211455';
export const V4_SCOPE='two-lincoln-spcx-pools-and-two-fixed-typed-v4-adapters-only';
export const V4_APPROVAL_SCHEMA='lincoln-mainnet-typed-v4-approval/v1';
export const V4_RISKS=Object.freeze(['spcx-issuer-controls','new-v4-adapter-untested-unaudited']);
export const V4_CORE_PINS=Object.freeze({
  core:{path:'deployments/robinhood-mainnet/rc3-eth-usdg.json',sha256:'1a21465491f1036546383d812deb408a7dbe37bf4f9b2c0eabcd8e943263de1b'},
  release:{path:'releases/rc3/artifacts/phase2-mainnet/release-candidate-20261017-r3.json',sha256:'dea4a351f51a78e773ed37543b533bf7d0fdac31b81ad166bd4b1ac2692f9c1d'},
  build:{path:'releases/rc3/artifacts/phase2-mainnet/contracts.json',sha256:BUILD_SHA256}});
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export async function v4PublicFile(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.startsWith('.')&&!['node_modules','signers','keystore'].includes(x)),'V4_PUBLIC_PATH_REQUIRED');
  const file=path.join(root,relative),s=await fs.lstat(file);
  need(s.isFile()&&!s.isSymbolicLink()&&s.size<=128*1024*1024&&await fs.realpath(file)===file,'V4_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(file);
}
export function v4AdapterArtifact(build){return {abi:build.abi,bytecode:build.creationBytecode,deployedBytecode:build.runtimeTemplate,
  immutableReferences:build.immutableReferences,linkReferences:{},deployedLinkReferences:{},source:build.source};}
function linkPool(artifact){
  let code=artifact.bytecode.slice(2);
  for(const groups of Object.values(artifact.linkReferences??{}))for(const[name,refs]of Object.entries(groups)){
    need(/^PoseidonT[34]$/.test(name)&&SHARED[name],'V4_POOL_LIBRARY_CHANGED');
    for(const ref of refs){need(ref.length===20&&Number.isInteger(ref.start)&&ref.start>=0&&ref.start*2+40<=code.length,'V4_POOL_LIBRARY_REFERENCE');
      code=code.slice(0,ref.start*2)+SHARED[name].slice(2).toLowerCase()+code.slice(ref.start*2+40);}}
  need(/^[0-9a-f]+$/i.test(code),'V4_POOL_UNLINKED');return '0x'+code;
}
export async function createV4DeploymentPlan({root=ROOT,reviewPath=V4_REVIEW,includeCalldata=false}={}){
  root=await fs.realpath(root);
  const policyBytes=await v4PublicFile(root,V4_POLICY),policy=JSON.parse(policyBytes);
  need(policy.schema==='lincoln-mainnet-typed-v4-policy/v1'&&policy.status==='proposal-not-approved'&&policy.approval===null
    &&policy.chainId===4663&&policy.account==='lincoln-deployer'&&same(policy.deployer,DEPLOYER)&&policy.scope===V4_SCOPE
    &&policy.capsMode==='protocol-uint128-maximum-no-additional-business-cap'&&policy.maxDeposit===UINT128_MAX&&policy.maxTotal===UINT128_MAX
    &&policy.poolGasLimit==='5500000'&&policy.adapterGasLimit==='5500000'&&policy.scopeBudgetWei==='2200000000000000'
    &&policy.newTransactionPriceCapWei==='100000000'&&policy.reserveWei==='3000000000000000'
    &&policy.feeBps===30&&same(policy.treasury,SAFE)&&policy.signingEnabled===false&&policy.executionEnabled===false,'V4_POLICY_CHANGED');
  const frozen={};for(const[id,pin]of Object.entries(V4_CORE_PINS)){const b=await v4PublicFile(root,pin.path);need(sha256(b)===pin.sha256,'V4_FROZEN_INPUT_CHANGED');frozen[id]=JSON.parse(b);}
  const{core,release,build:poolBuild}=frozen,profile=core.profiles.eth;
  need(core.chainId===4663&&core.genesisHash===GENESIS&&core.releaseId===BUILD_SHA256&&release.coreArtifactSHA256===BUILD_SHA256,'V4_CORE_IDENTITY_CHANGED');
  const anchors={...profile.libraries,Phase2ASPJoinSplitVerifier:profile.verifier,Phase2ASPExitVerifier:profile.exitVerifier,Phase2ASPRegistry:profile.registry};
  for(const[id,a]of Object.entries(SHARED))need(same(core.addresses[id],a)&&same(anchors[id].address,a)&&/^0x[0-9a-f]{64}$/.test(anchors[id].runtimeCodeHash),'V4_SHARED_ANCHOR_CHANGED');
  for(const name of ['joinsplit','holder-exit']){const m=core.production.manifests[name];need(sha256(await v4PublicFile(root,'releases/rc3/'+m.path))===m.sha256&&profile.circuitManifests[name]===m.sha256,'V4_PROOF_MANIFEST_CHANGED');}
  const buildBytes=await v4PublicFile(root,V4_BUILD),adapterBuild=JSON.parse(buildBytes),abiBytes=await v4PublicFile(root,V4_ABI),candidateABI=JSON.parse(abiBytes);
  need(sha256(buildBytes)===V4_BUILD_SHA&&adapterBuild.sourceSHA256===V4_SOURCE_SHA&&adapterBuild.compiled===true
    &&adapterBuild.tested===false&&adapterBuild.deployed===false&&adapterBuild.compiler.startsWith('0.8.28+')
    &&isDeepStrictEqual(adapterBuild.settings,{optimizer:{enabled:true,runs:10000},viaIR:true,evmVersion:'cancun'})
    &&adapterBuild.runtimeBytes<=24576&&adapterBuild.creationBytes<=49152&&Object.keys(adapterBuild.linkReferences).length===0
    &&isDeepStrictEqual(candidateABI.abi,adapterBuild.abi)&&candidateABI.sourceSHA256===V4_SOURCE_SHA,'V4_CANDIDATE_BUILD_CHANGED');
  for(const[ref,digest]of Object.entries(adapterBuild.sourceDigests))need(sha256(await v4PublicFile(root,ref))===digest,'V4_CANDIDATE_SOURCE_CHANGED');
  const candidateSource=(await v4PublicFile(root,adapterBuild.source)).toString();
  const reviewBytes=await v4PublicFile(root,reviewPath),review=JSON.parse(reviewBytes);
  need(review.schema==='lincoln-mainnet-v4-typed-router-review/v1'&&review.chainId===4663&&review.genesisHash===GENESIS
    &&/^0x[0-9a-f]{64}$/.test(review.observation?.blockHash)&&review.observation.blockNumber===review.blockNumber
    &&review.routerRuntimeSourceMatch?.matchesEntireRuntimeIncludingMetadata===true&&review.routerRuntimeSourceMatch.localSourceMatchesArtifactMetadata===true
    &&review.typedRouterReusable===true&&review.curveStatus===2&&review.strategyId==='2'&&review.poolId===V4.poolId
    &&review.candidateBuild?.sha256===V4_BUILD_SHA&&review.transactionsSigned===0&&review.transactionsBroadcast===0,'V4_REVIEW_CHANGED_OR_INCOMPLETE');
  for(const name of ['router','factory','manager','hook','treasury','treasuryImplementation','treasuryUpgradeController','curve','lincoln','spcx','spcxBeacon','spcxImplementation','vault'])
    need(/^0x[0-9a-fA-F]{40}$/.test(review.contracts[name]?.address)&&/^0x[0-9a-f]{64}$/.test(review.contracts[name]?.codeHash),'V4_REVIEW_DEPENDENCY_MISSING');
  const constantNames={router:'ROUTER',factory:'FACTORY',manager:'POOL_MANAGER',hook:'HOOK',treasury:'STRATEGY_TREASURY',treasuryImplementation:'STRATEGY_IMPLEMENTATION',treasuryUpgradeController:'STRATEGY_UPGRADE_CONTROLLER',curve:'CURVE',lincoln:'LINCOLN',spcx:'SPCX',spcxBeacon:'SPCX_BEACON',spcxImplementation:'SPCX_IMPLEMENTATION',vault:'LIQUIDITY_VAULT'};
  for(const[role,name]of Object.entries(constantNames)){
    const address=candidateSource.match(new RegExp('address public constant '+name+' = (0x[0-9a-fA-F]{40});'))?.[1];
    const codeHash=candidateSource.match(new RegExp(name+'\\.codehash != (0x[0-9a-f]{64})'))?.[1];
    need(address&&codeHash&&same(address,review.contracts[role].address)&&codeHash===review.contracts[role].codeHash,'V4_REVIEW_CONSTRUCTOR_DEPENDENCY_MISMATCH');
  }
  const pools=[['lincoln','LINCOLN',V4.lincoln],['spcx','SPCX',V4.spcx]].map(([id,symbol,asset])=>{
    const args=[SHARED.Phase2ASPJoinSplitVerifier,SHARED.Phase2ASPExitVerifier,SHARED.Phase2ASPRegistry,asset,BigInt(UINT128_MAX),BigInt(UINT128_MAX)];
    const data=encodeDeployData({abi:poolBuild.Phase2ASPPool.abi,bytecode:linkPool(poolBuild.Phase2ASPPool),args});
    return{id:'pool:'+id,asset:{id,symbol,address:asset,decimals:18,depositCaps:{schema:'lincoln-pool-deposit-caps/v1',unit:'asset-base-units',status:'configured',maxDepositUnits:UINT128_MAX,maxTotalUnits:UINT128_MAX}},
      contract:'Phase2ASPPool',gasCap:'5500000',constructorArguments:args.map(String),dataSHA256:sha256(Buffer.from(data.slice(2),'hex')),...(includeCalldata?{data}:{})};});
  const adapters=[{id:'route:hedgefun-lincoln-to-spcx',source:'lincoln',target:'spcx',isBuy:false},{id:'route:hedgefun-spcx-to-lincoln',source:'spcx',target:'lincoln',isBuy:true}]
    .map(r=>({...r,contract:'Phase2FeeHedgeFunV4Adapter',gasCap:'5500000',constructorArguments:['created:pool:'+r.source,'created:pool:'+r.target]}));
  const codePins={};for(const ref of ['scripts/operations/deploy-v4-mainnet.mjs','scripts/operations/v4-mainnet-deployment-plan.mjs','scripts/operations/hedgefun-v4-candidate-plan.mjs','scripts/operations/deploy-new-pools-mainnet.mjs','scripts/deploy-v4-mainnet.sh'])codePins[ref]=sha256(await v4PublicFile(root,ref));
  const identity={schema:'lincoln-mainnet-typed-v4-intent/v1',chainId:4663,genesisHash:GENESIS,deployer:DEPLOYER,
    policy:{path:V4_POLICY,sha256:sha256(policyBytes)},review:{path:reviewPath,sha256:sha256(reviewBytes)},pinnedInputs:V4_CORE_PINS,
    candidate:{path:V4_BUILD,sha256:V4_BUILD_SHA,abi:{path:V4_ABI,sha256:sha256(abiBytes)},sourceSHA256:V4_SOURCE_SHA,sourceSetSHA256:adapterBuild.sourceSetSHA256},
    codePins,sharedAnchors:anchors,poolIntents:pools.map(({data,...p})=>p),adapterIntents:adapters,policyLimits:{scopeBudgetWei:policy.scopeBudgetWei,newTransactionPriceCapWei:policy.newTransactionPriceCapWei,reserveWei:policy.reserveWei}};
  return {schema:'lincoln-mainnet-typed-v4-plan/v1',planId:sha256(JSON.stringify(identity)),identity,policy,pools,adapters,
    steps:[...pools,...adapters].map(({id,contract,gasCap})=>({id,contract,gasCap})),maximumProposedNewGasWei:'2200000000000000',
    coreManifest:core,adapterBuild,approvalRequired:V4_APPROVAL_SCHEMA,acceptedRisksRequired:V4_RISKS,
    readyForBroadcast:false,signingEnabled:false,executionEnabled:false,networkRequests:0,privateFilesRead:false,transactionsSigned:0,transactionsBroadcast:0};
}

export function v4ApprovalTemplate(plan,{now=Date.now()}={}){
  return {schema:V4_APPROVAL_SCHEMA,status:'pending-human-approval',chainId:4663,genesisHash:GENESIS,deployer:DEPLOYER,account:'lincoln-deployer',
    planId:plan.planId,policySHA256:plan.identity.policy.sha256,reviewSHA256:plan.identity.review.sha256,candidateBuildSHA256:V4_BUILD_SHA,
    approvedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),scope:V4_SCOPE,
    capsMode:plan.policy.capsMode,caps:plan.pools.map(p=>({id:p.asset.id,maxDepositUnits:UINT128_MAX,maxTotalUnits:UINT128_MAX})),
    steps:plan.steps,acceptedRisks:[],limits:{budgetWei:'65000000000000000',maxFeePerGasWei:'2800000000',reserveWei:'3000000000000000'},
    scopeBudgetWei:'2200000000000000',newTransactionPriceCapWei:'100000000',maximumNewGasWei:plan.maximumProposedNewGasWei};
}
