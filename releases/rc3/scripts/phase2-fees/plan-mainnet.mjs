#!/usr/bin/env node
// Offline review only. No mainnet wallet, nonce, RPC, signing or execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isAddress,keccak256} from 'viem';
import {loadVerifiedMainnetRelease,readPublicFile} from '../../src/phase2-mainnet/release.mjs';
import {deploymentSpecs} from '../phase2-mainnet/deploy.mjs';
import {planFeeAdapters} from './plan-adapters.mjs';
import {feeSHA256,verifyMainnetFeeComponent,MAINNET_FEE_ARTIFACT,MAINNET_FEE_TYPES} from '../../src/phase2-fees/mainnet-release.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const SAFE='0x9cf17a6e3c75d200f58283a165c442a8a3994555';
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const types={Phase2RouteAdapter:'Phase2FeeRouteAdapter',Phase2Router02Adapter:'Phase2FeeRouter02Adapter'};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const json=x=>JSON.stringify(x,null,2)+'\n';

/** A missing core deployment is represented explicitly, never as dummy pool addresses. */
export function planMainnetFeeDeployment({coreRelease,feeArtifactBytes,selection,coreDeployment=null,treasury,feeBps=30}={}){
  check(isAddress(treasury)&&treasury.toLowerCase()!== '0x'+'00'.repeat(20),'MAINNET_FEE_TREASURY_REQUIRED');
  check(Number.isInteger(feeBps)&&feeBps>=1&&feeBps<=100,'INVALID_SERVICE_FEE_BPS');
  const payee=treasury.toLowerCase(),artifact=JSON.parse(Buffer.from(feeArtifactBytes)),meta=artifact._meta;
  check(meta?.schema==='phase2-fees-production-build/v1'&&meta.testOnly===false&&meta.releaseCandidate===true&&meta.productionReady===false
    &&meta.coreRelease?.build?.sha256===coreRelease.artifactSHA256,'MAINNET_FEE_CORE_RELEASE_MISMATCH');
  check(selection?.schema==='phase2-mainnet-route-selection/v1'&&selection.chainId===4663&&Array.isArray(selection.routes)&&selection.routes.length>0,'MAINNET_FEE_SELECTION_REQUIRED');
  const selected=deploymentSpecs({config:coreRelease.config,routes:selection.routes}).filter(s=>s.route);
  const describe=spec=>{
    const route=spec.route,type=types[spec.contract],contract=artifact[type];
    const asset=id=>coreRelease.config.assets.find(a=>a.symbol.toLowerCase()===id).address;
    const sourceAsset=asset(route.source),targetAsset=asset(route.target),native='0x'+'00'.repeat(20);
    check(MAINNET_FEE_TYPES.includes(type)&&contract?.abi,'MAINNET_FEE_ADAPTER_REQUIRED');
    check(![route.router,route.wrappedNative,route.factory,...route.tokens,...route.hops.map(h=>h.address)].some(x=>equal(payee,x)),'UNSAFE_FEE_TREASURY');
    return {id:route.id,sourceAssetId:route.source,targetAssetId:route.target,adapterType:type,feeBps,treasury:payee,
      routerABIStyle:type==='Phase2FeeRouter02Adapter'?'router02-exactInput-without-deadline':'exactInput-with-deadline',
      constructorABI:contract.abi.find(a=>a.type==='constructor').inputs,
      abiSHA256:feeSHA256(json(contract.abi)),runtimeTemplateSHA256:feeSHA256(contract.deployedBytecode),
      immutableReferences:contract.immutableReferences,
      requiredImmutableGetters:{ROUTER:route.router,WRAPPED_NATIVE:route.wrappedNative,FACTORY:route.factory,
        SOURCE_ASSET:sourceAsset,TARGET_ASSET:targetAsset,SOURCE_NATIVE:equal(sourceAsset,native),TARGET_NATIVE:equal(targetAsset,native),
        TOKEN_IN:route.tokens[0],TOKEN_OUT:route.tokens.at(-1),HOPS:route.hops.length,PATH_HASH:keccak256(route.path),
        PROTOCOL:route.protocol,PATH:route.path,FEE_BPS:feeBps,TREASURY:payee},
      executionEnabled:false,initcodeHash:null,unsignedCreateTransaction:null,newAdapter:{address:null,runtimeCodeHash:null,status:'awaitCoreDeployment'}};
  };
  let adapters=selected.map(describe);
  if(coreDeployment!==null){
    check(coreDeployment.schema==='phase2-mainnet-deployed/v1'&&coreDeployment.chainId===4663&&coreDeployment.testOnly===false
      &&coreDeployment.releaseId===coreRelease.artifactSHA256&&coreDeployment.production?.build?.sha256===coreRelease.artifactSHA256,'MAINNET_FEE_DEPLOYMENT_RELEASE_MISMATCH');
    adapters=selected.map((spec,index)=>{
      const route=spec.route,sourceProfile=coreDeployment.profiles?.[route.source],entry=coreDeployment.routesByPool?.[route.source]?.find(x=>x.id===route.id);
      check(sourceProfile&&entry&&equal(entry.route.router,route.router)&&equal(entry.route.wrappedNative,route.wrappedNative)
        &&equal(entry.route.factory,route.factory)&&equal(entry.route.path,route.path)&&entry.route.adapterType===spec.contract
        &&entry.route.protocol===route.protocol&&equal(entry.targetProfile?.pool?.address,coreDeployment.profiles?.[route.target]?.pool?.address),'MAINNET_FEE_DEPLOYED_ROUTE_MISMATCH');
      const planned=planFeeAdapters({sourceProfile,routes:[entry],treasury:payee,feeBps,feeArtifactBytes}).plannedAdapters[0];
      return {...adapters[index],...planned,requiredImmutableGetters:{...adapters[index].requiredImmutableGetters,
        SOURCE_POOL:sourceProfile.pool.address,TARGET_POOL:entry.targetProfile.pool.address}};
    });
  }
  return {schema:'phase2-fees-mainnet-deployment-plan/v1',chainId:4663,planOnly:true,executionEnabled:false,productionReady:false,
    releaseCandidate:true,coreArtifactSHA256:coreRelease.artifactSHA256,feeArtifact:{path:MAINNET_FEE_ARTIFACT,sha256:feeSHA256(feeArtifactBytes)},
    treasury:payee,feeBps,coreDeploymentRequired:coreDeployment===null,plannedAdapters:adapters,
    pending:coreDeployment===null?[{code:'MAINNET_CORE_DEPLOYMENT_REQUIRED',detail:'Deploy and verify the final core pools before materializing constructor initcode; no pool addresses are invented.'}]:[],
    deploymentExecutorImplemented:false,activationImplemented:false,rpcRequests:0,transactionsSigned:0,transactionsBroadcast:0,keysAccessed:false,
    requiredBeforeActivation:['Explicit mainnet signing and gas budget approval; use one durable per-account nonce/fee ledger.',
      'Verify canonical deployment receipts, actual runtime and every immutable getter before creating NEW fee routes.',
      'Configure per-asset service policies and treasury accounting, then exercise final-proof A/B and real DEX acceptance.',
      'This offline plan neither installs a service route nor claims the Safe is verified or callable.'],
    limitations:['No live liquidity, issuer, Safe configuration or bytecode is checked by this offline plan.',
      'Unsigned create initcode is prepared only when real core deployment profiles are supplied. Nonce, gas and predicted addresses remain unset.',
      'Current free adapters and existing testnet services remain unchanged.']};
}

export async function runMainnetFeePlan({rootDirectory=ROOT,selectionPath='config/phase2-mainnet-routes-example.json',deploymentPath=null,treasury=SAFE,feeBps=30}={}){
  const root=await fs.realpath(rootDirectory),coreRelease=await loadVerifiedMainnetRelease({root});
  const bytes=await readPublicFile(root,MAINNET_FEE_ARTIFACT);
  verifyMainnetFeeComponent({rootDirectory:root,artifactBytes:bytes,coreRelease});
  const selection=JSON.parse(await readPublicFile(root,selectionPath)),coreDeployment=deploymentPath?JSON.parse(await readPublicFile(root,deploymentPath)):null;
  return planMainnetFeeDeployment({coreRelease,feeArtifactBytes:bytes,selection,coreDeployment,treasury,feeBps});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const options={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];check(['--selection','--core-deployment','--treasury','--fee-bps','--output'].includes(k)&&v&&!v.startsWith('--')&&!Object.hasOwn(options,k),'USAGE_MAINNET_FEE_PLAN');options[k]=v;}
    check(options['--fee-bps']===undefined||/^(?:[1-9]|[1-9][0-9]|100)$/.test(options['--fee-bps']),'INVALID_SERVICE_FEE_BPS');
    const plan=await runMainnetFeePlan({...(options['--selection']?{selectionPath:options['--selection']}:{}),...(options['--core-deployment']?{deploymentPath:options['--core-deployment']}:{}),...(options['--treasury']?{treasury:options['--treasury']}:{}),...(options['--fee-bps']?{feeBps:Number(options['--fee-bps'])}:{})});
    if(options['--output']){const output=path.resolve(options['--output']);await fs.writeFile(output,json(plan),{flag:'wx',mode:0o644});console.log(JSON.stringify({planOnly:true,output,coreDeploymentRequired:plan.coreDeploymentRequired,adapters:plan.plannedAdapters.length}));}
    else console.log(json(plan));
  }catch(error){console.error(/^[A-Z][A-Z0-9_]{1,90}$/.test(error.code??error.message)?error.code??error.message:'MAINNET_FEE_PLAN_FAILED');process.exitCode=1;}
}
