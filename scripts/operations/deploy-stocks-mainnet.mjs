#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Explicit stock-only extension. Frozen RC.3 contracts, proofs and account ledger are reused.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createPublicClient,http,encodeDeployData,encodeAbiParameters,getAddress,getContractAddress,keccak256,parseAbi,toHex} from 'viem';
import {checkPublicReview} from '../review/run.mjs';
import {checkRC3Deployment} from './mainnet-rc3.mjs';
import {readMainnetGasPolicy} from './mainnet-limits.mjs';
import {normalizeMainnetBroadcastTransport} from './deploy-mainnet.mjs';
import {stockCapacityPlan} from './stock-capacity-plan.mjs';
import {openServiceStore} from '../../releases/rc3/src/phase1-service/store.mjs';
import {createMainnetSigner} from '../../releases/rc3/src/phase2-mainnet/signer.mjs';
import {loadVerifiedMainnetRelease} from '../../releases/rc3/src/phase2-mainnet/release.mjs';
import {checkMainnetDependencies,linkMainnetBytecode,verifyMainnetDeployment} from '../../releases/rc3/scripts/phase2-mainnet/deploy.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const RPC='https://rpc.mainnet.chain.robinhood.com/';
const ADDRESS='0x555998Ba2B2723C97d91FB20Da0ddb896749797e',ACCOUNT='lincoln-deployer';
const GENESIS='0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c';
const CORE='deployments/robinhood-mainnet/rc3-eth-usdg.json';
const CORE_SHA256='1a21465491f1036546383d812deb408a7dbe37bf4f9b2c0eabcd8e943263de1b';
const POLICY_SHA256='e4ad691a78d95a26b883411a7e464f9ff94c877ad52273bf4ac70bbc2f1263d8';
const BUILD_SHA256='26ccf2f48a1ec45673091e2c4276c8e4d657da59cdbc3a7585fcd2358c45f747';
const LIMITS={budgetWei:'65000000000000000',maxFeePerGasWei:'2800000000',reserveWei:'3000000000000000'};
const STOCK_GAS='6000000',STOCK_PRICE='1000000000';
const SHARED=['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry'];
const CORE_IDS=[...SHARED,'pool:eth','pool:usdg'];
const FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const terminal=entry=>['confirmed','reverted','cancelled'].includes(entry.status);
const scopeFor=address=>BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],
  [keccak256(toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%FIELD;

async function regular(root,relative){
  const file=path.join(root,relative),stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file&&stat.size<128*1024*1024,'STOCK_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(file);
}
async function publishExact(root,relative,value){
  const file=path.join(root,relative),directory=path.dirname(file);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  need(await fs.realpath(directory)===directory,'STOCK_OUTPUT_DIRECTORY_INVALID');
  try{need(isDeepStrictEqual(JSON.parse(await regular(root,relative)),value),'STOCK_PUBLIC_OUTPUT_CONFLICT');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(file,json(value),{flag:'wx',mode:0o644});
}

export function stockGasPrice(quote){
  need(typeof quote==='bigint'&&quote>0n&&quote<=BigInt(STOCK_PRICE),'STOCK_GAS_PRICE_EXCEEDED');
  return quote*100n>BigInt(STOCK_PRICE)?BigInt(STOCK_PRICE):quote*100n;
}

function poolGetters(address,asset,core){
  return {ASSET:asset.address,VERIFIER:core.addresses.Phase2ASPJoinSplitVerifier,
    HOLDER_EXIT_VERIFIER:core.addresses.Phase2ASPExitVerifier,ASP_REGISTRY:core.addresses.Phase2ASPRegistry,
    SCOPE:scopeFor(address),TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,CAP_INCREASE_DELAY:43200n};
}
function poolArguments(asset,core){
  return [core.addresses.Phase2ASPJoinSplitVerifier,core.addresses.Phase2ASPExitVerifier,core.addresses.Phase2ASPRegistry,
    asset.address,BigInt(asset.depositCaps.maxDepositUnits),BigInt(asset.depositCaps.maxTotalUnits)];
}
function poolData(asset,core,artifact){
  return encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,core.addresses),args:poolArguments(asset,core)});
}

async function inputs(root){
  root=await fs.realpath(root);
  const plan=await stockCapacityPlan({root}),coreBytes=await regular(root,CORE),core=JSON.parse(coreBytes);
  need(plan.policy.sha256===POLICY_SHA256,'STOCK_APPROVED_POLICY_MISMATCH');
  need(sha(coreBytes)===CORE_SHA256&&core.schema==='phase2-mainnet-deployed/v1'&&core.chainId===4663
    &&core.genesisHash===GENESIS&&core.releaseId===BUILD_SHA256&&Object.keys(core.addresses).length===7
    &&CORE_IDS.every(id=>typeof core.addresses[id]==='string'),'STOCK_CORE_MANIFEST_MISMATCH');
  const specs=plan.pools.map(pool=>({id:pool.id,contract:'Phase2ASPPool',assetId:pool.asset.symbol.toLowerCase(),
    asset:{...pool.asset,depositCaps:pool.depositCaps},gasCap:STOCK_GAS}));
  const identity={schema:'lincoln-stock-extension-intent/v1',chainId:4663,genesisHash:GENESIS,deployer:ADDRESS,
    coreManifestSHA256:CORE_SHA256,artifactSHA256:BUILD_SHA256,policySHA256:plan.policy.sha256,
    pools:specs,sharedAddresses:core.addresses,stockGasCap:STOCK_GAS,stockPriceCapWei:STOCK_PRICE,limits:LIMITS};
  return {root,plan,core,specs,identity,planId:sha(JSON.stringify(identity))};
}

/** Read only. The seven old deployments are each bound to their canonical CREATE and runtime. */
async function verifyCore({client,core,release}){
  const {artifacts,config}=release,profile=core.profiles.eth;
  const references={...profile.libraries,Phase2ASPJoinSplitVerifier:profile.verifier,Phase2ASPExitVerifier:profile.exitVerifier,
    Phase2ASPRegistry:profile.registry,'pool:eth':profile.pool,'pool:usdg':core.profiles.usdg.pool};
  const anchors={};
  for(const id of CORE_IDS){
    const ref=references[id],address=core.addresses[id];
    need(ref&&same(ref.address,address)&&/^\d+$/.test(ref.startBlock),'STOCK_CORE_REFERENCE_INVALID');
    const block=await client.getBlock({blockNumber:BigInt(ref.startBlock),includeTransactions:true});
    need(block.hash===ref.blockHash,'STOCK_CORE_CREATION_BLOCK_CHANGED');
    const matches=block.transactions.filter(tx=>typeof tx==='object'&&tx.to===null&&same(tx.from,ADDRESS)
      &&same(getContractAddress({from:ADDRESS,nonce:BigInt(tx.nonce)}),address));
    need(matches.length===1,'STOCK_CORE_CREATION_TRANSACTION_MISSING');
    const tx=matches[0],contract=id.startsWith('pool:')?'Phase2ASPPool':id,artifact=artifacts[contract];
    let args=[],getters={},caps=null;
    if(id==='Phase2ASPRegistry'){args=[config.provider.address,config.guardian.address];getters={GUARDIAN:config.guardian.address,ACCEPTED_POLICY_WINDOW:16n};}
    if(id.startsWith('pool:')){
      const symbol=id.slice(5).toUpperCase(),asset=config.assets.find(a=>a.symbol===symbol);
      need(asset,'STOCK_CORE_ASSET_MISSING');args=poolArguments(asset,core);getters=poolGetters(address,asset,core);
      caps={maxDeposit:BigInt(asset.depositCaps.maxDepositUnits),maxTotal:BigInt(asset.depositCaps.maxTotalUnits)};
    }
    const data=encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,core.addresses),args});
    const step={id,address,deployer:ADDRESS,nonce:String(tx.nonce),hash:tx.hash,data};
    const runtime=await verifyMainnetDeployment({client,step,artifact,libraries:core.addresses,expectedGetters:getters,expectedInitialCaps:caps});
    need(runtime.runtimeCodeHash===ref.runtimeCodeHash&&runtime.startBlock===ref.startBlock,'STOCK_CORE_RUNTIME_REFERENCE_MISMATCH');
    anchors[id]={...runtime,hash:tx.hash,nonce:String(tx.nonce)};
  }
  return anchors;
}

async function verifyStockDependencies({client,release,specs}){
  await checkMainnetDependencies({client,config:release.config,specs});
  for(const role of ['stock-issuer-registry','stock-issuer-implementation']){
    const pin=release.config.codePins.find(pin=>pin.role===role);need(pin,'STOCK_ISSUER_PIN_MISSING');
    const code=await client.getCode({address:pin.address});need(code&&keccak256(code)===pin.runtimeCodeHash,'STOCK_ISSUER_CODE_CHANGED');
  }
  const abi=parseAbi(['function symbol() view returns(string)','function paused() view returns(bool)']);
  for(const spec of specs){
    need(await client.readContract({address:spec.asset.address,abi,functionName:'symbol'})===spec.asset.symbol,'STOCK_SYMBOL_MISMATCH');
    need(await client.readContract({address:spec.asset.address,abi,functionName:'paused'})===false,'STOCK_TOKEN_PAUSED');
  }
}

function profileFor({core,spec,runtime,planId}){
  const base=structuredClone(core.profiles.eth);
  return {...base,productionReady:false,deployment:{planId,extension:'stock-100-tokens',corePlanId:core.planId},
    asset:{symbol:spec.asset.symbol,decimals:spec.asset.decimals},
    pool:{...runtime,asset:spec.asset.address,noteModel:'factorized-asp-v1',scope:scopeFor(runtime.address).toString(),treeDepth:20},
    depositCaps:spec.asset.depositCaps,
    limitations:[...base.limitations,'Stock pools are deployed separately; DEX routes and asset-specific end-to-end acceptance are pending.']};
}

/** Only this explicit method can invoke the existing local keystore signer. */
export async function deployStockPools({root=ROOT,account,passwordFile}={}){
  need(account===ACCOUNT&&typeof passwordFile==='string'&&path.isAbsolute(passwordFile),'STOCK_LOCAL_KEYSTORE_REQUIRED');
  const ctx=await inputs(root);root=ctx.root;
  console.error('Checking frozen RC.3 integrity, final parameters and reproducible bytecode before stock deployment...');
  await checkPublicReview({root});
  const checked=await checkRC3Deployment({root,limits:LIMITS}),policy=await readMainnetGasPolicy({root});
  // A stock-owned unsigned prepared intent is handled below. Hash-bearing and foreign live intents are never sent automatically.
  need(checked.account===ACCOUNT&&isDeepStrictEqual(checked.limits,LIMITS)&&isDeepStrictEqual(policy.effectiveLimits,LIMITS)
    &&checked.readiness?.code!=='MAINNET_LIMITS_AMENDMENT_INCOMPLETE','STOCK_GLOBAL_LIMITS_MISMATCH');
  const release=await loadVerifiedMainnetRelease({root:checked.directory});
  need(release.artifactSHA256===BUILD_SHA256&&same(release.config.deployer.address,ADDRESS)
    &&release.config.deployer.signingAccount===ACCOUNT&&isDeepStrictEqual(release.production,ctx.core.production),'STOCK_RELEASE_MISMATCH');
  const client=createPublicClient({cacheTime:0,transport:normalizeMainnetBroadcastTransport(http(RPC,{retryCount:0,timeout:30000}))});
  need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:0n})).hash===GENESIS,'STOCK_WRONG_CHAIN');
  const anchors=await verifyCore({client,core:ctx.core,release});
  await verifyStockDependencies({client,release,specs:ctx.specs});
  const signer=createMainnetSigner({client,address:ADDRESS,account:ACCOUNT,passwordFile,directory:checked.sharedSignerDirectory,
    ...LIMITS,expectedGenesisHash:GENESIS});
  const directory=path.join(checked.directory,'.phase1-private/phase2-mainnet/deployments',ctx.planId);
  const store=await openServiceStore({directory,identity:`lincoln-mainnet-deployment:${ctx.planId}`,filename:'deployment.json'});
  const pins={planId:ctx.planId,artifactSHA256:BUILD_SHA256,sourceSetSHA256:release.sourceSetSHA256,genesisHash:GENESIS,
    deployer:ADDRESS,provider:release.config.provider.address,relayer:null,...LIMITS,signerDirectory:checked.sharedSignerDirectory,
    extensionIdentity:ctx.identity,coreAnchors:anchors};
  try{
    let journal=await store.read();
    journal??={schema:'phase2-mainnet-deployment/v1',pins,steps:[],status:'deploying'};
    need(journal.schema==='phase2-mainnet-deployment/v1'&&isDeepStrictEqual(journal.pins,pins)
      &&['deploying','complete'].includes(journal.status)&&Array.isArray(journal.steps)&&journal.steps.length<=ctx.specs.length
      &&journal.steps.every((step,i)=>step.id===ctx.specs[i].id),'STOCK_JOURNAL_MISMATCH');
    const artifact=release.artifacts.Phase2ASPPool;
    const state=await signer.reconcile();
    for(const entry of state.entries.filter(e=>!terminal(e))){
      const spec=ctx.specs.find(s=>entry.id===`deploy:${ctx.planId}:${s.id}`);
      const evidence=entry.status==='prepared'?await signer.unsignedEvidence(entry.id):null;
      need(spec&&evidence?.unsigned===true&&entry.data===poolData(spec.asset,ctx.core,artifact)
        &&entry.gas===STOCK_GAS&&BigInt(entry.gasPrice)<=BigInt(STOCK_PRICE),'ACCOUNT_UNKNOWN_BROADCAST');
    }
    for(const entry of state.entries.filter(e=>e.id.startsWith(`deploy:${ctx.planId}:`))){
      const spec=ctx.specs.find(s=>entry.id===`deploy:${ctx.planId}:${s.id}`);
      need(spec&&entry.data===poolData(spec.asset,ctx.core,artifact)&&entry.to===null&&entry.value==='0'
        &&entry.gas===STOCK_GAS&&BigInt(entry.gasPrice)<=BigInt(STOCK_PRICE)&&!['reverted','cancelled'].includes(entry.status),'STOCK_LEDGER_INTENT_MISMATCH');
    }
    // Reserve the entire remaining scope at its stricter 1 gwei ceiling; include all historical committed fees.
    const remaining=ctx.specs.filter(s=>!state.entries.some(e=>e.id===`deploy:${ctx.planId}:${s.id}`));
    const maximum=BigInt(remaining.length)*BigInt(STOCK_GAS)*BigInt(STOCK_PRICE);
    const liveMaximum=state.entries.filter(e=>!terminal(e)).reduce((sum,e)=>sum+BigInt(e.feeCeilingWei),0n);
    need(BigInt(state.committedWei)+maximum<=BigInt(LIMITS.budgetWei),'STOCK_GLOBAL_BUDGET_HEADROOM_LOW');
    need(await client.getBalance({address:ADDRESS,blockTag:'pending'})>=maximum+liveMaximum+BigInt(LIMITS.reserveWei),'STOCK_BALANCE_RESERVE_LOW');
    await store.write(journal);
    for(const spec of ctx.specs){
      const id=`deploy:${ctx.planId}:${spec.id}`,data=poolData(spec.asset,ctx.core,artifact);
      let step=journal.steps.find(s=>s.id===spec.id),entry=(await signer.status()).entries.find(e=>e.id===id);
      if(entry?.status==='confirmed')need(step,'STOCK_CONFIRMED_JOURNAL_STEP_MISSING');
      if(!entry){
        const price=stockGasPrice(await client.getGasPrice());
        entry=await signer.prepare({id,to:null,data,value:'0',gas:STOCK_GAS,gasPrice:price.toString()});
      }
      const address=getAddress(getContractAddress({from:ADDRESS,nonce:BigInt(entry.nonce)}));
      if(step)need(step.reservationId===id&&same(step.deployer,ADDRESS)&&step.data===data&&step.nonce===entry.nonce
        &&same(step.address,address)&&(!step.hash||step.hash===entry.hash),'STOCK_JOURNAL_INTENT_CHANGED');
      else{
        need(journal.steps.length===ctx.specs.indexOf(spec)&&entry.status==='prepared','STOCK_JOURNAL_ORDER_INVALID');
        step={id:spec.id,kind:'created',reservationId:id,deployer:ADDRESS,data,nonce:entry.nonce,address,status:'prepared'};
        journal.steps.push(step);await store.write(journal);
      }
      let hash=entry.hash;
      if(!hash){
        try{hash=await signer.broadcast(id);}
        catch(error){
          if(error.transactionHash){step.hash=error.transactionHash;step.status='unknown';await store.write(journal);}
          throw error;
        }
        step.hash=hash;step.status='submitted';await store.write(journal);
        try{await client.waitForTransactionReceipt({hash,timeout:60000,pollingInterval:1000});}
        catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_PENDING_NO_RESEND'),{code:'MAINNET_DEPLOYMENT_PENDING_NO_RESEND',transactionHash:hash});}
      }
      const settled=(await signer.reconcile()).entries.find(e=>e.id===id);
      need(settled?.status==='confirmed','STOCK_DEPLOYMENT_NOT_CONFIRMED');
      step.hash=hash;
      step.runtime=await verifyMainnetDeployment({client,step,artifact,libraries:ctx.core.addresses,
        expectedGetters:poolGetters(address,spec.asset,ctx.core),expectedInitialCaps:{maxDeposit:BigInt(spec.asset.depositCaps.maxDepositUnits),maxTotal:BigInt(spec.asset.depositCaps.maxTotalUnits)}});
      step.status='verified';await store.write(journal);
      console.error(JSON.stringify({stock:spec.asset.symbol,status:'confirmed',transactionHash:hash,address,feeWei:settled.feeWei}));
    }
    const profiles=Object.fromEntries(ctx.specs.map(spec=>[spec.assetId,profileFor({core:ctx.core,spec,runtime:journal.steps.find(s=>s.id===spec.id).runtime,planId:ctx.planId})]));
    const output={schema:'phase2-mainnet-stock-extension-deployed/v1',chainId:4663,genesisHash:GENESIS,planId:ctx.planId,
      coreManifest:{path:CORE,sha256:CORE_SHA256,planId:ctx.core.planId},stockPolicy:ctx.plan.policy,releaseId:BUILD_SHA256,
      production:release.production,profiles,addresses:{...ctx.core.addresses,...Object.fromEntries(journal.steps.map(s=>[s.id,s.address]))},
      reusedCoreAnchors:anchors,routes:[],routesByPool:Object.fromEntries(ctx.specs.map(s=>[s.assetId,[]])),productionReady:false,
      stockPoolsDeployed:true,stockTradingEnabled:false,audit:ctx.core.audit,
      gasPolicy:{globalLimits:LIMITS,stockPriceCapWei:STOCK_PRICE,multiplierNumerator:'100',multiplierDenominator:'1'}};
    for(const [id,profile]of Object.entries(profiles))await publishExact(checked.directory,`config/phase2-mainnet-profiles/${id}.json`,profile);
    await publishExact(root,'deployments/robinhood-mainnet/stocks-100-tokens.json',output);
    journal.status='complete';await store.write(journal);
    return {planId:ctx.planId,stockPoolsDeployed:true,stockTradingEnabled:false,profiles:Object.fromEntries(Object.entries(profiles).map(([id,p])=>[id,p.pool])),
      manifest:'deployments/robinhood-mainnet/stocks-100-tokens.json',reusedCoreAddresses:ctx.core.addresses};
  }finally{await store.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==='--plan'){
      const ctx=await inputs(ROOT);
      console.log(json({mode:'offline-stock-deployment-plan',chainId:4663,planId:ctx.planId,pools:ctx.specs,
        reuseCoreAddresses:ctx.core.addresses,limits:LIMITS,stockPriceCapWei:STOCK_PRICE,totalGasCap:'42000000',
        maximumNewGasWei:'42000000000000000',requiredBalanceWithReserveWei:'45000000000000000',
        networkRequests:0,transactionsSigned:0,transactionsBroadcast:0}));
    }else{
      need(args.length===5&&args[0]==='--deploy'&&args[1]==='--account'&&args[2]===ACCOUNT&&args[3]==='--password-file','USAGE_DEPLOY_STOCK_POOLS');
      console.log(json(await deployStockPools({account:args[2],passwordFile:args[4]})));
    }
  }catch(error){console.error(JSON.stringify({error:error.code??'STOCK_DEPLOYMENT_FAILED',
    ...(error.transactionHash?{transactionHash:error.transactionHash}:{}),...(error.rpcDiagnostic?{rpcDiagnostic:error.rpcDiagnostic}:{}),automaticResend:false}));process.exitCode=1;}
}
