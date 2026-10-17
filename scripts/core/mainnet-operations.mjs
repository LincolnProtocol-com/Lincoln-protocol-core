#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Public metadata planning only: no RPC, signer, keystore or file mutation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getAddress,isAddress} from 'viem';
import {checkCore,RELEASE,EXPECTED_RELEASE_SHA256} from './check.mjs';
import {readPublicFile} from '../../src/phase2-mainnet/release.mjs';
import {buildMainnetPlan} from '../phase2-mainnet/plan.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
function exact(value,keys){
  need(value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length
    &&Reflect.ownKeys(value).every(k=>keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')),'MAINNET_OPERATIONS_SHAPE_INVALID');
}
/** Overlay only the public deployer identity, preserving the frozen input. */
export function configureMainnetOperations({config,operations}={}){
  exact(operations,['schema','chainId','candidate','deployer','signingEnabled','limits']);
  exact(operations.candidate,['tag','manifest','sha256']);
  exact(operations.deployer,['address','signingAccount','addressSource','keystoreOwnershipVerified']);
  exact(operations.limits,['gasBudgetWei','maxTotalFundingWei','maxDepositWei','maxFeePerGasWei','reserveWei']);
  need(operations.schema==='lincoln-mainnet-operations/v1'&&operations.chainId===4663&&config?.chain?.id===4663,'MAINNET_OPERATIONS_CHAIN_INVALID');
  need(operations.candidate.tag==='v0.1.0-rc.2'&&operations.candidate.manifest===RELEASE
    &&operations.candidate.sha256===EXPECTED_RELEASE_SHA256,'MAINNET_OPERATIONS_CANDIDATE_MISMATCH');
  need(operations.signingEnabled===false&&Object.values(operations.limits).every(value=>value===null),'MAINNET_OPERATIONS_SIGNING_DISABLED_REQUIRED');
  const {address,signingAccount,addressSource,keystoreOwnershipVerified}=operations.deployer;
  need(isAddress(address,{strict:true})&&!/^0x0{40}$/i.test(address)&&typeof signingAccount==='string'
    &&/^[A-Za-z0-9_-]{1,80}$/.test(signingAccount),'MAINNET_OPERATIONS_DEPLOYER_INVALID');
  need(addressSource==='user-supplied'&&keystoreOwnershipVerified===false,'MAINNET_OPERATIONS_OWNERSHIP_NOT_VERIFIED');
  need(config.deployer?.address===null&&config.deployer.signingAccount===null,'MAINNET_OPERATIONS_FROZEN_DEPLOYER_REQUIRED');
  need(![config.guardian?.address,config.provider?.address].some(role=>role?.toLowerCase()===address.toLowerCase()),'MAINNET_OPERATIONS_ROLE_COLLISION');
  const effective=structuredClone(config);
  effective.deployer={...effective.deployer,address:getAddress(address),signingAccount,
    signerLocation:'local-foundry-keystore-user-managed',status:'public-account-registered-signing-disabled'};
  return effective;
}
export async function mainnetOperationsPlan({root=ROOT}={}){
  root=await fs.realpath(root);await checkCore({root});
  const json=async relative=>JSON.parse(await readPublicFile(root,relative));
  const operations=await json('config/phase2-mainnet-operations.json');
  const config=configureMainnetOperations({config:await json('config/phase2-mainnet.json'),operations});
  const paths=config.productionArtifacts;
  const plan=buildMainnetPlan({config,productionBuild:await json(paths.build),joinManifest:await json(paths.joinsplitManifest),exitManifest:await json(paths.holderExitManifest)});
  return {schema:'lincoln-mainnet-operations-plan/v1',candidate:operations.candidate,deployer:plan.deployer,
    signingEnabled:false,keystoreOwnershipVerified:false,readiness:{...plan.readiness,broadcastImplemented:false},pending:plan.pending,
    unresolvedStockCaps:config.assets.filter(asset=>asset.depositCaps?.status==='valuation-required').map(asset=>asset.symbol),
    limits:operations.limits,readOnly:true,offline:true,filesWritten:0,keysAccessed:false,transactionsSigned:0,transactionsBroadcast:0,
    frozenConfigurationUnchanged:true,deploymentExecutorEnabled:false,
    next:'Prepare a separately reviewed operations/deployment snapshot and explicit budget before any signing; the original RC.2 deploy CLI still reads its frozen unset-deployer config.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--plan','USAGE_MAINNET_OPERATIONS_PLAN');
    console.log(JSON.stringify(await mainnetOperationsPlan(),null,2));
  }catch(error){console.error(error.code??error.message);process.exitCode=1;}
}
