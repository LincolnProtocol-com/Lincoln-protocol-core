#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline public configuration only. No signer, RPC, keystore or private files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const POLICY='config/stock-capacity-mainnet-100-tokens-20261017.json';
const SOURCE='config/stock-caps-mainnet-20261017.json';
const SOURCE_SHA256='45ad4a3d5beaabbd057726e67d5e9af4eab1a7612905e713b40e850155c70e43';
const SYMBOLS=['NVDA','SPY','META','TSLA','GOOGL','QQQ','MSTR'];
const MAX_UINT128=(1n<<128n)-1n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function regular(root,relative){
  const filename=path.join(root,relative),stat=await fs.lstat(filename);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<1024*1024&&await fs.realpath(filename)===filename,'STOCK_POLICY_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(filename);
}

export async function stockCapacityPlan({root=ROOT}={}){
  root=await fs.realpath(root);
  const [bytes,sourceBytes]=await Promise.all([regular(root,POLICY),regular(root,SOURCE)]);
  const policy=JSON.parse(bytes),source=JSON.parse(sourceBytes);
  need(sha(sourceBytes)===SOURCE_SHA256&&policy.replaces?.sourcePath===SOURCE&&policy.replaces?.sourceSHA256===SOURCE_SHA256,'STOCK_POLICY_SOURCE_MISMATCH');
  need(policy.schema==='lincoln-stock-capacity-policy/v1'&&policy.chainId===4663&&policy.contractCandidate==='v0.1.0-rc.3'
    &&policy.status==='prepared-not-deployed'&&policy.stockPoolsEnabled===false&&policy.stocksDeployed===false,'STOCK_POLICY_STATUS_INVALID');
  need(policy.policy?.maxTotalTokens==='100'&&policy.policy.unit==='robinhood-erc20-token'
    &&policy.policy.capIncreaseDelaySeconds===43200&&policy.policy.priceUpdatesChangeCaps===false
    &&policy.policy.issuerMultiplierUpdatesChangeCaps===false,'STOCK_POLICY_RULE_INVALID');
  need(policy.acceptance?.signingEnabled===false&&policy.acceptance.stockDeploymentEntry==='scripts/deploy-stocks-mainnet.sh --deploy','STOCK_POLICY_SIGNING_FORBIDDEN');
  need(policy.assets.length===7&&source.assets.length===7&&policy.assets.every((asset,i)=>asset.symbol===SYMBOLS[i]),'STOCK_POLICY_ASSETS_INVALID');
  const observation=policy.verification;
  need(observation?.chainId===4663&&observation.assets.length===7&&observation.transactionsBroadcast===0,'STOCK_POLICY_PRECISION_OBSERVATION_INVALID');
  const pools=policy.assets.map((asset,i)=>{
    const prior=source.assets[i],observed=observation.assets[i];
    need(asset.token===prior.token&&asset.decimals===prior.decimals&&observed.symbol===asset.symbol
      &&observed.token===asset.token&&observed.decimals===asset.decimals&&observed.codePresent===true,'STOCK_POLICY_ASSET_BINDING_INVALID');
    const total=100n*10n**BigInt(asset.decimals),deposit=BigInt(prior.maxDepositRaw)>total?total:BigInt(prior.maxDepositRaw);
    need(total<=MAX_UINT128&&deposit>0n&&deposit<=total&&asset.maxTotalTokens==='100'
      &&asset.maxTotalRaw===total.toString()&&asset.maxDepositRaw===deposit.toString(),'STOCK_POLICY_CAP_INVALID');
    need(asset.referenceTokenAsk===prior.tokenAsk&&asset.referenceQuotedAt===prior.quotedAt,'STOCK_POLICY_QUOTE_INVALID');
    return {id:`pool:${asset.symbol.toLowerCase()}`,contract:'Phase2ASPPool',asset:{symbol:asset.symbol,address:asset.token,decimals:asset.decimals},
      depositCaps:{schema:'lincoln-pool-deposit-caps/v1',unit:'asset-base-units',status:'configured',maxDepositUnits:asset.maxDepositRaw,maxTotalUnits:asset.maxTotalRaw},
      constructorArguments:{VERIFIER:'existing:Phase2ASPJoinSplitVerifier',HOLDER_EXIT_VERIFIER:'existing:Phase2ASPExitVerifier',ASP_REGISTRY:'existing:Phase2ASPRegistry',
        ASSET:asset.token,initialMaxDeposit:asset.maxDepositRaw,initialMaxTotal:asset.maxTotalRaw},
      linkedLibraries:['existing:PoseidonT3','existing:PoseidonT4'],deploymentStatus:'not-deployed'};
  });
  return {schema:'lincoln-stock-extension-plan/v1',mode:'offline-plan',chainId:4663,policy:{path:POLICY,sha256:sha(bytes)},
    contractCandidate:policy.contractCandidate,signingEnabled:false,networkRequests:0,privateFilesRead:false,transactionsSigned:0,transactionsBroadcast:0,
    sharedComponentsToReuse:['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry'],
    existingPoolsToPreserve:['pool:eth','pool:usdg'],pools,routes:[],readyForBroadcast:false,
    blockers:['The explicit stock-extension command must complete its live shared-core, token and funding checks; the ETH/USDG runner remains unchanged.',
      'Bind and reverify all five reused shared components against the confirmed core deployment manifest and frozen runtime/getter/receipt expectations.',
      'Recheck current official token identity, precision, issuer status, pause state and implementation before deployment.',
      'Add independently verified two-way USDG routes and asset-specific acceptance before enabling stock trading.',
      'Register new pools and deployment blocks with the indexer, ASP publisher, relayer and client configuration.']};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    need(process.argv.length===3&&process.argv[2]==='--plan','USAGE_STOCK_CAPACITY_PLAN');
    console.log(JSON.stringify(await stockCapacityPlan(),null,2));
  }catch(error){console.error(JSON.stringify({error:error.code??'STOCK_CAPACITY_PLAN_FAILED',signingEnabled:false,transactionsBroadcast:0}));process.exitCode=1;}
}
