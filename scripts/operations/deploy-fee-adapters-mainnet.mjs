#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Explicit 30 bps fee adapter extension. Frozen RC.3 fee component, deployed pools and account ledger are reused.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createPublicClient,http,encodeDeployData,getAddress,getContractAddress,keccak256,parseAbi} from 'viem';
import {checkPublicReview} from '../review/run.mjs';
import {checkRC3Deployment,DEFAULT_RC3_DEPLOYMENT_DIRECTORY} from './mainnet-rc3.mjs';
import {readMainnetGasPolicy} from './mainnet-limits.mjs';
import {normalizeMainnetBroadcastTransport,mainnetGasPriceWithHeadroom} from './deploy-mainnet.mjs';
import {openServiceStore} from '../../releases/rc3/src/phase1-service/store.mjs';
import {createMainnetSigner} from '../../releases/rc3/src/phase2-mainnet/signer.mjs';
import {loadVerifiedMainnetRelease} from '../../releases/rc3/src/phase2-mainnet/release.mjs';
import {deploymentSpecs,checkMainnetDependencies,linkMainnetBytecode,verifyMainnetDeployment} from '../../releases/rc3/scripts/phase2-mainnet/deploy.mjs';
import {verifyMainnetFeeComponent,MAINNET_FEE_ARTIFACT} from '../../releases/rc3/src/phase2-fees/mainnet-release.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const RPC='https://rpc.mainnet.chain.robinhood.com/';
const ADDRESS='0x555998Ba2B2723C97d91FB20Da0ddb896749797e',ACCOUNT='lincoln-deployer';
const GENESIS='0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c';
const CORE='deployments/robinhood-mainnet/rc3-eth-usdg.json',CORE_SHA256='1a21465491f1036546383d812deb408a7dbe37bf4f9b2c0eabcd8e943263de1b';
const STOCKS='deployments/robinhood-mainnet/stocks-100-tokens.json',STOCKS_SHA256='4aa933e43dc58409489935cd609425d8baf51d4890779b6854f33a3d177400d9';
const SELECTION='config/mainnet-fee-routes-20261017.json';
const OUTPUT='deployments/robinhood-mainnet/fee-adapters-30bps.json';
const BUILD_SHA256='26ccf2f48a1ec45673091e2c4276c8e4d657da59cdbc3a7585fcd2358c45f747';
// Selected treasury: the already verified 2-of-3 Robinhood mainnet Safe that is also the registry guardian.
const TREASURY='0x9CF17a6E3c75D200f58283A165C442a8A3994555',FEE_BPS=30;
const LIMITS={budgetWei:'65000000000000000',maxFeePerGasWei:'2800000000',reserveWei:'3000000000000000'};
// Adapters are small CREATEs: cap 4M gas each, price = quote x10 capped at 0.3 gwei (base fee is ~0.02 gwei).
const ADAPTER_GAS='4000000',ADAPTER_PRICE='300000000',MULTIPLIER={numerator:10n,denominator:1n};
const FEE_TYPES={Phase2RouteAdapter:'Phase2FeeRouteAdapter',Phase2Router02Adapter:'Phase2FeeRouter02Adapter'};
const POOL_IDS=['eth','usdg','nvda','spy','meta','tsla','googl','qqq','mstr'];
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const terminal=entry=>['confirmed','reverted','cancelled'].includes(entry.status);

async function regular(root,relative){
  const file=path.join(root,relative),stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file&&stat.size<128*1024*1024,'FEE_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(file);
}
async function publishExact(root,relative,value){
  const file=path.join(root,relative),directory=path.dirname(file);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  need(await fs.realpath(directory)===directory,'FEE_OUTPUT_DIRECTORY_INVALID');
  try{need(isDeepStrictEqual(JSON.parse(await regular(root,relative)),value),'FEE_PUBLIC_OUTPUT_CONFLICT');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(file,json(value),{flag:'wx',mode:0o644});
}
export function adapterGasPrice(quote){return mainnetGasPriceWithHeadroom(quote,BigInt(ADAPTER_PRICE),MULTIPLIER);}

function adapterArguments(spec,pools){
  const r=spec.route;return [pools[r.source],pools[r.target],r.router,r.wrappedNative,r.protocol,r.path,FEE_BPS,TREASURY];
}
function adapterData(spec,pools,artifact){
  need(Object.keys(artifact.linkReferences??{}).length===0,'FEE_ADAPTER_ARTIFACT_LINKED');
  return encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,{}),args:adapterArguments(spec,pools)});
}
function adapterGetters(spec,pools,config){
  const r=spec.route,asset=id=>config.assets.find(a=>a.symbol.toLowerCase()===id).address;
  return {SOURCE_POOL:pools[r.source],TARGET_POOL:pools[r.target],ROUTER:r.router,WRAPPED_NATIVE:r.wrappedNative,FACTORY:r.factory,
    SOURCE_ASSET:asset(r.source),TARGET_ASSET:asset(r.target),SOURCE_NATIVE:r.source==='eth',TARGET_NATIVE:r.target==='eth',
    TOKEN_IN:r.tokens[0],TOKEN_OUT:r.tokens.at(-1),PROTOCOL:r.protocol,HOPS:BigInt(r.parameters.length),PATH:r.path,PATH_HASH:keccak256(r.path),
    FEE_BPS,TREASURY,routeTokens:r.tokens.map(t=>getAddress(t)),hopPools:r.hops.map(h=>getAddress(h.address))};
}

async function inputs(root){
  root=await fs.realpath(root);
  const coreBytes=await regular(root,CORE),core=JSON.parse(coreBytes),stockBytes=await regular(root,STOCKS),stocks=JSON.parse(stockBytes);
  need(sha(coreBytes)===CORE_SHA256&&core.schema==='phase2-mainnet-deployed/v1'&&core.chainId===4663&&core.genesisHash===GENESIS&&core.releaseId===BUILD_SHA256,'FEE_CORE_MANIFEST_MISMATCH');
  need(sha(stockBytes)===STOCKS_SHA256&&stocks.schema==='phase2-mainnet-stock-extension-deployed/v1'&&stocks.chainId===4663&&stocks.genesisHash===GENESIS
    &&stocks.releaseId===BUILD_SHA256&&stocks.coreManifest?.sha256===CORE_SHA256&&stocks.coreManifest.planId===core.planId,'FEE_STOCK_MANIFEST_MISMATCH');
  for(const [id,address]of Object.entries(core.addresses))need(same(stocks.addresses[id],address),'FEE_STOCK_CORE_ADDRESS_MISMATCH');
  const pools={},profiles={...core.profiles,...stocks.profiles};
  for(const id of POOL_IDS){
    const address=stocks.addresses[`pool:${id}`];need(typeof address==='string'&&same(profiles[id]?.pool?.address,address),'FEE_POOL_ADDRESS_MISSING');
    pools[id]=getAddress(address);
  }
  const selectionBytes=await regular(root,SELECTION),selection=JSON.parse(selectionBytes);
  need(selection.schema==='phase2-mainnet-route-selection/v1'&&selection.chainId===4663&&Array.isArray(selection.routes)&&selection.routes.length>0,'FEE_ROUTE_SELECTION_INVALID');
  const identity={schema:'lincoln-fee-adapter-extension-intent/v1',chainId:4663,genesisHash:GENESIS,deployer:ADDRESS,
    coreManifestSHA256:CORE_SHA256,stockManifestSHA256:STOCKS_SHA256,artifactSHA256:BUILD_SHA256,selectionSHA256:sha(selectionBytes),
    treasury:TREASURY,feeBps:FEE_BPS,pools,adapterGasCap:ADAPTER_GAS,adapterPriceCapWei:ADAPTER_PRICE,limits:LIMITS};
  return {root,core,stocks,pools,profiles,selection,identity,planId:sha(JSON.stringify(identity))};
}

/** Verified release, fee component and route specs from the RC.3 snapshot. No signer is touched. */
async function prepare({directory,ctx}){
  const release=await loadVerifiedMainnetRelease({root:directory});
  need(release.artifactSHA256===BUILD_SHA256&&same(release.config.deployer.address,ADDRESS)&&release.config.deployer.signingAccount===ACCOUNT
    &&isDeepStrictEqual(release.production,ctx.core.production),'FEE_RELEASE_MISMATCH');
  need(same(release.config.guardian?.address,TREASURY)&&release.config.guardian.kind==='safe'&&release.config.guardian.threshold>=2,'FEE_TREASURY_NOT_VERIFIED_SAFE');
  const feeBytes=await regular(directory,MAINNET_FEE_ARTIFACT);
  verifyMainnetFeeComponent({rootDirectory:directory,artifactBytes:feeBytes,coreRelease:release});
  const feeArtifact=JSON.parse(feeBytes);
  const specs=deploymentSpecs({config:release.config,routes:ctx.selection.routes}).filter(s=>s.route).map(s=>({...s,feeContract:FEE_TYPES[s.contract],gasCap:ADAPTER_GAS}));
  need(specs.length===ctx.selection.routes.length&&specs.every(s=>feeArtifact[s.feeContract]?.abi),'FEE_ADAPTER_ARTIFACT_MISSING');
  for(const s of specs){
    const r=s.route,excluded=[ctx.pools[r.source],ctx.pools[r.target],r.router,r.wrappedNative,r.factory,...r.tokens,...r.hops.map(h=>h.address)];
    need(!excluded.some(x=>same(x,TREASURY)),'UNSAFE_FEE_TREASURY');
  }
  return {release,feeArtifact,feeSHA256:sha(feeBytes),specs};
}
async function verifyChain({client,release,ctx,specs}){
  need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:0n})).hash===GENESIS,'FEE_WRONG_CHAIN');
  await checkMainnetDependencies({client,config:release.config,specs});
  const safeCode=await client.getCode({address:TREASURY});
  need(safeCode&&keccak256(safeCode)===release.config.guardian.runtimeCodeHash,'FEE_TREASURY_CODE_CHANGED');
  const poolABI=release.artifacts.Phase2ASPPool.abi;
  for(const id of POOL_IDS){
    const asset=release.config.assets.find(a=>a.symbol.toLowerCase()===id);need(asset,'FEE_POOL_ASSET_MISSING');
    const runtime=await client.getCode({address:ctx.pools[id]});
    need(runtime&&keccak256(runtime)===ctx.profiles[id].pool.runtimeCodeHash,'FEE_POOL_CODE_CHANGED');
    need(same(await client.readContract({address:ctx.pools[id],abi:poolABI,functionName:'ASSET'}),asset.address),'FEE_POOL_ASSET_MISMATCH');
  }
  const stockABI=parseAbi(['function paused() view returns(bool)']);
  for(const id of POOL_IDS.filter(id=>!['eth','usdg'].includes(id)))
    need(await client.readContract({address:release.config.assets.find(a=>a.symbol.toLowerCase()===id).address,abi:stockABI,functionName:'paused'})===false,'FEE_STOCK_TOKEN_PAUSED');
}

export async function planFeeAdapters({root=ROOT}={}){
  const ctx=await inputs(root);root=ctx.root;
  const directory=path.join(root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY);
  const {release,feeArtifact,feeSHA256,specs}=await prepare({directory,ctx});
  const client=createPublicClient({cacheTime:0,transport:http(RPC,{retryCount:0,timeout:30000})});
  await verifyChain({client,release,ctx,specs});
  const quote=await client.getGasPrice(),price=adapterGasPrice(quote);
  const steps=[];let estimatedGas=0n;
  for(const spec of specs){
    const data=adapterData(spec,ctx.pools,feeArtifact[spec.feeContract]);
    const estimate=await client.estimateGas({account:ADDRESS,data});estimatedGas+=estimate;
    need(estimate<=BigInt(ADAPTER_GAS),'FEE_ADAPTER_GAS_CAP_TOO_LOW');
    steps.push({id:spec.id,contract:spec.feeContract,source:spec.route.source,target:spec.route.target,venue:spec.route.venue,
      sourcePool:ctx.pools[spec.route.source],targetPool:ctx.pools[spec.route.target],hops:spec.route.hops.map(h=>h.address),
      initcodeHash:keccak256(data),estimatedGas:estimate.toString(),status:'not-deployed'});
  }
  const balance=await client.getBalance({address:ADDRESS,blockTag:'pending'});
  return {mode:'offline-fee-adapter-plan-with-readonly-rpc',chainId:4663,planId:ctx.planId,treasury:TREASURY,feeBps:FEE_BPS,
    feeArtifact:{path:MAINNET_FEE_ARTIFACT,sha256:feeSHA256,sourceSetSHA256:feeArtifact._meta.sourceSetSHA256},
    selection:SELECTION,adapters:steps.length,steps,limits:LIMITS,adapterGasCap:ADAPTER_GAS,adapterPriceCapWei:ADAPTER_PRICE,
    gasQuoteWei:quote.toString(),selectedGasPriceWei:price.toString(),
    estimatedTotalGas:estimatedGas.toString(),estimatedCostWei:(estimatedGas*price).toString(),
    maximumCeilingWei:(BigInt(steps.length)*BigInt(ADAPTER_GAS)*BigInt(ADAPTER_PRICE)).toString(),
    requiredBalanceWithReserveWei:(BigInt(steps.length)*BigInt(ADAPTER_GAS)*BigInt(ADAPTER_PRICE)+BigInt(LIMITS.reserveWei)).toString(),
    deployerBalanceWei:balance.toString(),transactionsSigned:0,transactionsBroadcast:0,keysAccessed:false};
}

/** Only this explicit method can invoke the existing local keystore signer. */
export async function deployFeeAdapters({root=ROOT,account,passwordFile}={}){
  need(account===ACCOUNT&&typeof passwordFile==='string'&&path.isAbsolute(passwordFile),'FEE_LOCAL_KEYSTORE_REQUIRED');
  const ctx=await inputs(root);root=ctx.root;
  console.error('Checking frozen RC.3 integrity, fee component reproduction and account ledger before adapter deployment...');
  await checkPublicReview({root});
  const checked=await checkRC3Deployment({root,limits:LIMITS}),policy=await readMainnetGasPolicy({root});
  need(checked.account===ACCOUNT&&isDeepStrictEqual(checked.limits,LIMITS)&&isDeepStrictEqual(policy.effectiveLimits,LIMITS)
    &&checked.readiness?.code!=='MAINNET_LIMITS_AMENDMENT_INCOMPLETE','FEE_GLOBAL_LIMITS_MISMATCH');
  const {release,feeArtifact,feeSHA256,specs}=await prepare({directory:checked.directory,ctx});
  const client=createPublicClient({cacheTime:0,transport:normalizeMainnetBroadcastTransport(http(RPC,{retryCount:0,timeout:30000}))});
  await verifyChain({client,release,ctx,specs});
  const signer=createMainnetSigner({client,address:ADDRESS,account:ACCOUNT,passwordFile,directory:checked.sharedSignerDirectory,...LIMITS,expectedGenesisHash:GENESIS});
  const directory=path.join(checked.directory,'.phase1-private/phase2-mainnet/deployments',ctx.planId);
  const store=await openServiceStore({directory,identity:`lincoln-mainnet-deployment:${ctx.planId}`,filename:'deployment.json'});
  const pins={planId:ctx.planId,artifactSHA256:BUILD_SHA256,feeArtifactSHA256:feeSHA256,sourceSetSHA256:release.sourceSetSHA256,genesisHash:GENESIS,
    deployer:ADDRESS,provider:release.config.provider.address,relayer:null,...LIMITS,signerDirectory:checked.sharedSignerDirectory,extensionIdentity:ctx.identity};
  const dataFor=spec=>adapterData(spec,ctx.pools,feeArtifact[spec.feeContract]);
  try{
    let journal=await store.read();
    journal??={schema:'phase2-mainnet-deployment/v1',pins,steps:[],status:'deploying'};
    need(journal.schema==='phase2-mainnet-deployment/v1'&&isDeepStrictEqual(journal.pins,pins)&&['deploying','complete'].includes(journal.status)
      &&Array.isArray(journal.steps)&&journal.steps.length<=specs.length&&journal.steps.every((step,i)=>step.id===specs[i].id),'FEE_JOURNAL_MISMATCH');
    const state=await signer.reconcile();
    for(const entry of state.entries.filter(e=>!terminal(e))){
      const spec=specs.find(s=>entry.id===`deploy:${ctx.planId}:${s.id}`);
      const evidence=entry.status==='prepared'?await signer.unsignedEvidence(entry.id):null;
      need(spec&&evidence?.unsigned===true&&entry.data===dataFor(spec)&&entry.gas===ADAPTER_GAS&&BigInt(entry.gasPrice)<=BigInt(ADAPTER_PRICE),'ACCOUNT_UNKNOWN_BROADCAST');
    }
    for(const entry of state.entries.filter(e=>e.id.startsWith(`deploy:${ctx.planId}:`))){
      const spec=specs.find(s=>entry.id===`deploy:${ctx.planId}:${s.id}`);
      need(spec&&entry.data===dataFor(spec)&&entry.to===null&&entry.value==='0'&&entry.gas===ADAPTER_GAS
        &&BigInt(entry.gasPrice)<=BigInt(ADAPTER_PRICE)&&!['reverted','cancelled'].includes(entry.status),'FEE_LEDGER_INTENT_MISMATCH');
    }
    const remaining=specs.filter(s=>!state.entries.some(e=>e.id===`deploy:${ctx.planId}:${s.id}`));
    const maximum=BigInt(remaining.length)*BigInt(ADAPTER_GAS)*BigInt(ADAPTER_PRICE);
    const liveMaximum=state.entries.filter(e=>!terminal(e)).reduce((sum,e)=>sum+BigInt(e.feeCeilingWei),0n);
    need(BigInt(state.committedWei)+maximum<=BigInt(LIMITS.budgetWei),'FEE_GLOBAL_BUDGET_HEADROOM_LOW');
    need(await client.getBalance({address:ADDRESS,blockTag:'pending'})>=maximum+liveMaximum+BigInt(LIMITS.reserveWei),'FEE_BALANCE_RESERVE_LOW');
    await store.write(journal);
    for(const spec of specs){
      const id=`deploy:${ctx.planId}:${spec.id}`,data=dataFor(spec),artifact=feeArtifact[spec.feeContract];
      let step=journal.steps.find(s=>s.id===spec.id),entry=(await signer.status()).entries.find(e=>e.id===id);
      if(entry?.status==='confirmed')need(step,'FEE_CONFIRMED_JOURNAL_STEP_MISSING');
      if(!entry){
        const estimate=await client.estimateGas({account:ADDRESS,data});need(estimate<=BigInt(ADAPTER_GAS),'FEE_ADAPTER_GAS_CAP_TOO_LOW');
        const price=adapterGasPrice(await client.getGasPrice());
        entry=await signer.prepare({id,to:null,data,value:'0',gas:ADAPTER_GAS,gasPrice:price.toString()});
      }
      const address=getAddress(getContractAddress({from:ADDRESS,nonce:BigInt(entry.nonce)}));
      if(step)need(step.reservationId===id&&same(step.deployer,ADDRESS)&&step.data===data&&step.nonce===entry.nonce&&same(step.address,address)&&(!step.hash||step.hash===entry.hash),'FEE_JOURNAL_INTENT_CHANGED');
      else{
        need(journal.steps.length===specs.indexOf(spec)&&entry.status==='prepared','FEE_JOURNAL_ORDER_INVALID');
        step={id:spec.id,kind:'created',contract:spec.feeContract,reservationId:id,deployer:ADDRESS,data,nonce:entry.nonce,address,status:'prepared'};
        journal.steps.push(step);await store.write(journal);
      }
      let hash=entry.hash;
      if(!hash){
        try{hash=await signer.broadcast(id);}
        catch(error){if(error.transactionHash){step.hash=error.transactionHash;step.status='unknown';await store.write(journal);}throw error;}
        step.hash=hash;step.status='submitted';await store.write(journal);
        try{await client.waitForTransactionReceipt({hash,timeout:60000,pollingInterval:1000});}
        catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_PENDING_NO_RESEND'),{code:'MAINNET_DEPLOYMENT_PENDING_NO_RESEND',transactionHash:hash});}
      }
      const settled=(await signer.reconcile()).entries.find(e=>e.id===id);
      need(settled?.status==='confirmed','FEE_DEPLOYMENT_NOT_CONFIRMED');
      step.hash=hash;
      step.runtime=await verifyMainnetDeployment({client,step,artifact,libraries:{},expectedGetters:adapterGetters(spec,ctx.pools,release.config)});
      step.feeWei=settled.feeWei;step.status='verified';await store.write(journal);
      console.error(JSON.stringify({adapter:spec.id,status:'confirmed',transactionHash:hash,address,feeWei:settled.feeWei}));
    }
    const pinsByRole=Object.fromEntries(release.config.codePins.map(p=>[p.role,p]));
    const adapters=specs.map(spec=>{
      const r=spec.route,step=journal.steps.find(s=>s.id===spec.id),prefix=r.venue==='up'?'up':'uni';
      return {id:r.id,adapterType:spec.feeContract,adapter:step.address,runtimeCodeHash:step.runtime.runtimeCodeHash,startBlock:step.runtime.startBlock,
        blockHash:step.runtime.blockHash,transactionHash:step.hash,nonce:step.nonce,feeWei:step.feeWei,feeBps:FEE_BPS,treasury:TREASURY,
        venue:r.venue,source:r.source,target:r.target,sourcePool:ctx.pools[r.source],targetPool:ctx.pools[r.target],
        protocol:r.protocol,router:r.router,factory:r.factory,quoter:r.quoter,wrappedNative:r.wrappedNative,tokens:r.tokens,parameters:r.parameters,path:r.path,pathHash:keccak256(r.path),
        hops:r.hops.map((h,i)=>({pool:h.address,parameter:r.parameters[i],tokenIn:r.tokens[i],tokenOut:r.tokens[i+1],runtimeCodeHash:h.runtimeCodeHash})),
        runtimeCodeHashes:{adapter:step.runtime.runtimeCodeHash,router:pinsByRole[prefix+'Router'].runtimeCodeHash,factory:pinsByRole[prefix+'Factory'].runtimeCodeHash,
          quoter:pinsByRole[prefix+'Quoter'].runtimeCodeHash,wrappedNative:pinsByRole.weth.runtimeCodeHash},
        executionEnabled:false,deployment:'mainnet-fee-adapter-30bps'};
    });
    const routesByPool=Object.fromEntries(POOL_IDS.map(id=>[id,adapters.filter(a=>a.source===id).map(route=>({id:route.id,route,targetProfile:ctx.profiles[route.target]}))]));
    const output={schema:'phase2-mainnet-fee-adapters-deployed/v1',chainId:4663,genesisHash:GENESIS,planId:ctx.planId,
      coreManifest:{path:CORE,sha256:CORE_SHA256,planId:ctx.core.planId},stockManifest:{path:STOCKS,sha256:STOCKS_SHA256,planId:ctx.stocks.planId},
      releaseId:BUILD_SHA256,feeArtifact:{path:MAINNET_FEE_ARTIFACT,sha256:feeSHA256,sourceSetSHA256:feeArtifact._meta.sourceSetSHA256},
      selection:{path:SELECTION,sha256:ctx.identity.selectionSHA256},treasury:TREASURY,feeBps:FEE_BPS,pools:ctx.pools,adapters,routesByPool,
      feeWei:adapters.reduce((sum,a)=>sum+BigInt(a.feeWei??0),0n).toString(),productionReady:false,dexRoutesDeployed:true,serviceRoutesConfigured:false,
      gasPolicy:{globalLimits:LIMITS,adapterGasCap:ADAPTER_GAS,adapterPriceCapWei:ADAPTER_PRICE,multiplierNumerator:MULTIPLIER.numerator.toString(),multiplierDenominator:MULTIPLIER.denominator.toString()},
      limitations:['Fee rate and treasury are immutable per adapter; a different rate or payee needs a new adapter.',
        'Deployment verifies bytecode and immutable getters only; live liquidity, slippage and end-to-end acceptance with real DEX swaps remain separate steps.',
        'Service routes still have to be configured per asset with gas quotes before any relay offers these adapters.']};
    await publishExact(root,OUTPUT,output);
    journal.status='complete';await store.write(journal);
    return {planId:ctx.planId,adaptersDeployed:adapters.length,feeWei:output.feeWei,manifest:OUTPUT,
      adapters:Object.fromEntries(adapters.map(a=>[a.id,a.adapter]))};
  }finally{await store.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==='--plan')console.log(json(await planFeeAdapters({root:ROOT})));
    else{
      need(args.length===5&&args[0]==='--deploy'&&args[1]==='--account'&&args[2]===ACCOUNT&&args[3]==='--password-file','USAGE_DEPLOY_FEE_ADAPTERS');
      console.log(json(await deployFeeAdapters({account:args[2],passwordFile:args[4]})));
    }
  }catch(error){console.error(JSON.stringify({error:error.code??'FEE_ADAPTER_DEPLOYMENT_FAILED',message:error.code?undefined:error.message,
    ...(error.transactionHash?{transactionHash:error.transactionHash}:{}),automaticResend:false}));process.exitCode=1;}
}
