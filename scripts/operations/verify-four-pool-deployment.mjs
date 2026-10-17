#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Read-only operational verification of already deployed contracts. No wallet or transaction submission.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPublicClient,http,getContractAddress,getAddress,encodeDeployData,encodeAbiParameters,keccak256,toHex,parseAbi} from 'viem';
import {createNewPoolPlan,sha256,DEPLOYER,SAFE,GENESIS,BUILD_SHA256,SHARED,DEX,WETH,USDG} from './new-pools-mainnet-plan.mjs';
import {linkMainnetBytecode,verifyMainnetDeployment} from '../../releases/rc3/scripts/phase2-mainnet/deploy.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const MANIFEST='deployments/robinhood-mainnet/four-pools-20261017.json';
const FEES='deployments/robinhood-mainnet/four-pools-fee-adapters-30bps.json';
const OUTPUT='deployments/robinhood-mainnet/verification/four-pools-deployment-20261017.json';
const RPC='https://rpc.mainnet.chain.robinhood.com/';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
async function read(root,relative){const f=path.join(root,relative),s=await fs.lstat(f);need(s.isFile()&&!s.isSymbolicLink()&&await fs.realpath(f)===f,'READONLY_REGULAR_PUBLIC_FILE_REQUIRED');return fs.readFile(f);}
const field=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const scopeFor=address=>BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],[keccak256(toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%field;

export async function verifyFourPoolDeployment({root=ROOT}={}){
  root=await fs.realpath(root);
  const poolBytes=await read(root,MANIFEST),feeBytes=await read(root,FEES),deployed=JSON.parse(poolBytes),fees=JSON.parse(feeBytes);
  const plan=await createNewPoolPlan({root,reviewPath:deployed.review.path,includeCalldata:true});
  need(deployed.schema==='phase2-mainnet-stock-extension-deployed/v1'&&deployed.stockPoolsDeployed===true&&deployed.chainId===4663
    &&deployed.genesisHash===GENESIS&&deployed.releaseId===BUILD_SHA256&&deployed.planId===plan.planId
    &&fees.schema==='phase2-mainnet-fee-adapters-deployed/v1'&&fees.chainId===4663&&fees.planId===plan.planId
    &&fees.releaseId===BUILD_SHA256&&fees.adapters.length===6&&fees.feeBps===30&&same(fees.treasury,SAFE),'READONLY_DEPLOYMENT_MANIFEST_MISMATCH');
  const artifactBytes=await read(root,plan.identity.pinnedInputs.build.path),feeArtifactBytes=await read(root,plan.identity.pinnedInputs.fee.path);
  need(sha256(artifactBytes)===BUILD_SHA256&&sha256(feeArtifactBytes)===plan.identity.pinnedInputs.fee.sha256,'READONLY_FROZEN_ARTIFACT_MISMATCH');
  const artifact=JSON.parse(artifactBytes).Phase2ASPPool,feeArtifact=JSON.parse(feeArtifactBytes).Phase2FeeRouter02Adapter;
  const client=createPublicClient({cacheTime:0,transport:http(RPC,{retryCount:2,retryDelay:250,timeout:30000})});
  need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:0n})).hash===GENESIS,'READONLY_WRONG_CHAIN');
  const head=await client.getBlock();
  const reads=new Map();
  const readContract=args=>{const key=json({...args,blockNumber:head.number});if(!reads.has(key))reads.set(key,client.readContract({...args,blockNumber:head.number}));return reads.get(key);};
  const observed={...client,readContract,getCode:args=>client.getCode({...args,blockNumber:head.number})};
  const tokenABI=parseAbi(['function decimals() view returns(uint8)','function symbol() view returns(string)','function balanceOf(address) view returns(uint256)']);
  const results=[];
  for(let offset=0;offset<plan.pools.length;offset+=2)await Promise.all(plan.pools.slice(offset,offset+2).map(async p=>{
    const id=p.asset.id,profile=deployed.profiles[id],address=deployed.addresses[p.id];
    need(profile&&same(address,profile.pool.address)&&same(profile.pool.asset,p.asset.address)&&profile.asset.decimals===18
      &&isDeepStrictEqual(profile.depositCaps,{...p.asset.depositCaps,status:'configured'}),'READONLY_POOL_PROFILE_MISMATCH');
    const creation=await client.getBlock({blockNumber:BigInt(profile.pool.startBlock),includeTransactions:true});
    need(creation.hash===profile.pool.blockHash,'READONLY_CREATION_BLOCK_CHANGED');
    const matches=creation.transactions.filter(tx=>typeof tx==='object'&&tx.to===null&&same(tx.from,DEPLOYER)
      &&same(getContractAddress({from:DEPLOYER,nonce:BigInt(tx.nonce)}),address));need(matches.length===1,'READONLY_CREATE_NOT_UNIQUE');
    const tx=matches[0],step={id:p.id,address,deployer:DEPLOYER,nonce:String(tx.nonce),hash:tx.hash,data:p.unsignedCreate.data};
    const getters={ASSET:p.asset.address,VERIFIER:SHARED.Phase2ASPJoinSplitVerifier,HOLDER_EXIT_VERIFIER:SHARED.Phase2ASPExitVerifier,ASP_REGISTRY:SHARED.Phase2ASPRegistry,
      SCOPE:scopeFor(address),TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,CAP_INCREASE_DELAY:43200n};
    await Promise.all(Object.keys(getters).map(functionName=>readContract({address,abi:artifact.abi,functionName})));
    const runtime=await verifyMainnetDeployment({client:observed,step,artifact,libraries:SHARED,expectedGetters:getters,
      expectedInitialCaps:{maxDeposit:BigInt(p.asset.depositCaps.maxDepositUnits),maxTotal:BigInt(p.asset.depositCaps.maxTotalUnits)}});
    need(runtime.runtimeCodeHash===profile.pool.runtimeCodeHash&&runtime.startBlock===profile.pool.startBlock&&runtime.blockHash===profile.pool.blockHash,'READONLY_POOL_RUNTIME_REFERENCE_CHANGED');
    const [maxDeposit,maxTotal,accountedBalance,nextLeafIndex,depositsPaused,decimals,symbol,custody,receipt]=await Promise.all([
      ...['maxDeposit','maxTotal','accountedBalance','nextLeafIndex','depositsPaused'].map(functionName=>readContract({address,abi:artifact.abi,functionName})),
      readContract({address:p.asset.address,abi:tokenABI,functionName:'decimals'}),readContract({address:p.asset.address,abi:tokenABI,functionName:'symbol'}),
      readContract({address:p.asset.address,abi:tokenABI,functionName:'balanceOf',args:[address]}),client.getTransactionReceipt({hash:tx.hash})]);
    need(maxDeposit===BigInt(p.asset.depositCaps.maxDepositUnits)&&maxTotal===BigInt(p.asset.depositCaps.maxTotalUnits)&&decimals===18&&symbol===p.asset.symbol,'READONLY_CURRENT_CAP_OR_TOKEN_IDENTITY_CHANGED');
    results.push({id,symbol,address,token:p.asset.address,transactionHash:tx.hash,nonce:String(tx.nonce),...runtime,
      checks:{canonicalReceipt:true,exactFrozenCreationCalldata:true,linkedRuntime:true,immutableGetters:true,constructorCapsEvent:true,currentCaps:true,tokenIdentity:true},
      maxDepositRaw:String(maxDeposit),maxTotalRaw:String(maxTotal),accountedBalance:String(accountedBalance),custody:String(custody),nextLeafIndex:String(nextLeafIndex),depositsPaused,
      feeWei:(receipt.gasUsed*receipt.effectiveGasPrice).toString()});
    console.error(json({id,status:'verified',address}).trim());
  }));
  const routeResults=[];
  for(let offset=0;offset<fees.adapters.length;offset+=2)await Promise.all(fees.adapters.slice(offset,offset+2).map(async r=>{
    const source=fees.pools[r.source],target=fees.pools[r.target];need(source&&target&&r.adapterType==='Phase2FeeRouter02Adapter'&&r.feeBps===30&&same(r.treasury,SAFE),'READONLY_ADAPTER_BINDING_MISMATCH');
    const data=encodeDeployData({abi:feeArtifact.abi,bytecode:linkMainnetBytecode(feeArtifact,{}),args:[source,target,DEX.router,WETH,0,r.path,30,SAFE]});
    const asset=id=>plan.pools.find(p=>p.asset.id===id)?.asset.address??(id==='eth'?'0x0000000000000000000000000000000000000000':USDG);
    const getters={SOURCE_POOL:source,TARGET_POOL:target,ROUTER:DEX.router,WRAPPED_NATIVE:WETH,FACTORY:DEX.factory,SOURCE_ASSET:asset(r.source),TARGET_ASSET:asset(r.target),SOURCE_NATIVE:r.source==='eth',TARGET_NATIVE:r.target==='eth',
      TOKEN_IN:r.tokens[0],TOKEN_OUT:r.tokens.at(-1),PROTOCOL:0,HOPS:1n,PATH:r.path,PATH_HASH:keccak256(r.path),FEE_BPS:30,TREASURY:SAFE,routeTokens:r.tokens.map(t=>getAddress(t)),hopPools:r.hops.map(h=>getAddress(h.pool))};
    await Promise.all(Object.keys(getters).map(functionName=>readContract({address:r.adapter,abi:feeArtifact.abi,functionName})));
    const step={id:r.id,address:r.adapter,deployer:DEPLOYER,nonce:r.nonce,hash:r.transactionHash,data};
    const runtime=await verifyMainnetDeployment({client:observed,step,artifact:feeArtifact,libraries:{},expectedGetters:getters});
    need(runtime.runtimeCodeHash===r.runtimeCodeHash&&runtime.startBlock===r.startBlock&&runtime.blockHash===r.blockHash,'READONLY_ADAPTER_RUNTIME_REFERENCE_CHANGED');
    const receipt=await client.getTransactionReceipt({hash:r.transactionHash}),feeWei=(receipt.gasUsed*receipt.effectiveGasPrice).toString();need(feeWei===r.feeWei,'READONLY_ADAPTER_ACTUAL_FEE_CHANGED');
    routeResults.push({id:r.id,address:r.adapter,transactionHash:r.transactionHash,nonce:r.nonce,...runtime,feeWei,feeBps:30,treasury:SAFE,sourcePool:source,targetPool:target,
      checks:{canonicalReceipt:true,exactFrozenCreationCalldata:true,linkedRuntime:true,immutableGetters:true,routeTokensAndPools:true,feeAndTreasury:true}});
    console.error(json({id:r.id,status:'verified',address:r.adapter}).trim());
  }));
  need((await client.getBlock({blockNumber:head.number})).hash===head.hash,'READONLY_OBSERVATION_REORG');
  const feeWei=routeResults.reduce((s,r)=>s+BigInt(r.feeWei),0n);need(feeWei.toString()===fees.feeWei,'READONLY_ADAPTER_FEE_SUM_MISMATCH');
  results.sort((a,b)=>plan.pools.findIndex(p=>p.asset.id===a.id)-plan.pools.findIndex(p=>p.asset.id===b.id));
  routeResults.sort((a,b)=>fees.adapters.findIndex(r=>r.id===a.id)-fees.adapters.findIndex(r=>r.id===b.id));
  const report={schema:'lincoln-four-pool-deployment-readonly-verification/v1',verifiedAt:new Date().toISOString(),chainId:4663,genesisHash:GENESIS,
    planId:plan.planId,releaseId:BUILD_SHA256,observation:{blockNumber:String(head.number),blockHash:head.hash,blockTimestamp:String(head.timestamp)},
    source:{pools:{path:MANIFEST,sha256:sha256(poolBytes)},feeAdapters:{path:FEES,sha256:sha256(feeBytes)},frozenArtifactSHA256:BUILD_SHA256,feeArtifactSHA256:sha256(feeArtifactBytes)},
    pools:results,adapters:routeResults,totalActualDeploymentFeeWei:(results.reduce((s,r)=>s+BigInt(r.feeWei),0n)+feeWei).toString(),passed:true,
    currentCapsMatched:true,contractsVerified:10,transactionsSigned:0,transactionsBroadcast:0,privateFilesRead:false,operationalReadOnly:true,
    newForksRun:0,newProofsGenerated:0,testSuitesRun:0,backendActivated:false,
    limitations:['This observes existing public-chain deployments; it is not an additional test suite, proof ceremony or transaction.',
      'New-pool relay, ASP, indexer, fee-policy and Access activation are separate operational work, not attested by this report.',
      'Issuer powers and future token implementation/control changes remain the accepted disclosed asset risks.']};
  await fs.writeFile(path.join(root,OUTPUT),json(report),{mode:0o644});
  return {passed:true,contractsVerified:10,pools:results.map(p=>({id:p.id,address:p.address})),adapters:routeResults.length,totalActualDeploymentFeeWei:report.totalActualDeploymentFeeWei,report:OUTPUT,transactionsBroadcast:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===2,'USAGE_VERIFY_FOUR_POOL_DEPLOYMENT');console.log(json(await verifyFourPoolDeployment()));}
  catch(error){console.error(JSON.stringify({error:error.code??error.shortMessage??error.message??'READONLY_DEPLOYMENT_CHECK_FAILED',transactionsBroadcast:0}));process.exitCode=1;}
}
