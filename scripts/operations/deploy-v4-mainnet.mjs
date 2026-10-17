#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Four exact CREATE intents. Uses the existing physical deployer journal. No auto resend.
import fs from 'node:fs/promises';
import {constants as FS_CONSTANTS} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as eq} from 'node:util';
import {GENESIS,BUILD_SHA256,DEPLOYER,SAFE,SHARED,sha256} from './new-pools-mainnet-plan.mjs';
import {createV4DeploymentPlan,v4PublicFile,v4AdapterArtifact,v4ApprovalTemplate,V4_BUILD_SHA,V4_APPROVAL_SCHEMA,V4_RISKS,V4_SCOPE} from './v4-mainnet-deployment-plan.mjs';
import {EXTENSION_LIMITS,NEW_PRICE_CAP,extensionGasPrice,validateExtensionLedger,validateOutputPreflight,extensionAuthorizationHistory,initialPublicApproval} from './deploy-new-pools-mainnet.mjs';
import {HEDGEFUN_V4_CANDIDATE as V4,prepareCandidateAction} from './hedgefun-v4-candidate-plan.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),RPC='https://rpc.mainnet.chain.robinhood.com/';
const ACCOUNT='lincoln-deployer',SCOPE_BUDGET=2200000000000000n;
const POOL_OUTPUT='deployments/robinhood-mainnet/lincoln-spcx-pools-20261017.json';
const ROUTE_OUTPUT='deployments/robinhood-mainnet/lincoln-spcx-v4-adapters-30bps.json';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const terminal=e=>['confirmed','reverted','cancelled'].includes(e.status);
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n';
const exact=(v,k)=>v&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
/** Deploy-only. Never log the URL or import it into the public plan/approval. */
export async function readV4DeploymentRPC({rpcFile}={}){
  const explicit=rpcFile!==undefined,filename=rpcFile??path.join(os.homedir(),'.config/lincoln/mainnet-rpc-url');
  need(typeof filename==='string'&&path.isAbsolute(filename)&&!/[\x00-\x1f\x7f]/.test(filename),'V4_RPC_FILE_ABSOLUTE_REQUIRED');
  let handle;
  try{
    handle=await fs.open(filename,FS_CONSTANTS.O_RDONLY|FS_CONSTANTS.O_NOFOLLOW);
    const stat=await handle.stat();
    need(stat.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=4096&&(stat.mode&0o777)===0o600
      &&(typeof process.getuid!=='function'||stat.uid===process.getuid())&&await fs.realpath(filename)===filename,'V4_RPC_FILE_PERMISSIONS_INVALID');
    const value=(await handle.readFile('utf8')).trim();
    need(value.length>0&&!/\s/.test(value),'V4_RPC_FILE_INVALID');
    let parsed;try{parsed=new URL(value);}catch{throw Object.assign(new Error('V4_RPC_FILE_INVALID'),{code:'V4_RPC_FILE_INVALID'});}
    need(parsed.protocol==='https:'&&parsed.hostname.length>0&&!parsed.username&&!parsed.password&&!parsed.hash,'V4_RPC_FILE_INVALID');
    return{url:value,source:'private-file',privateRPCUsed:true};
  }catch(error){
    if(!explicit&&error.code==='ENOENT')return{url:RPC,source:'official-public-default-file-absent',privateRPCUsed:false};
    if(/^V4_RPC_[A-Z_]+$/.test(error.code??''))throw error;
    throw Object.assign(new Error('V4_RPC_FILE_READ_FAILED'),{code:'V4_RPC_FILE_READ_FAILED'});
  }finally{if(handle)await handle.close();}
}
async function publish(root,relative,value){
  const file=path.join(root,relative),directory=path.dirname(file);await fs.mkdir(directory,{recursive:true});need(await fs.realpath(directory)===directory,'V4_OUTPUT_DIRECTORY_INVALID');
  try{need(eq(JSON.parse(await v4PublicFile(root,relative)),value),'V4_OUTPUT_CONFLICT');return;}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(file,json(value),{flag:'wx',mode:0o644});
}
export function validateV4BindingFlags(o){
  need(o&&typeof o.reviewPath==='string'&&typeof o.approvalPath==='string'
    &&['approvalSHA256','planId','policySHA256','reviewSHA256'].every(k=>/^[0-9a-f]{64}$/.test(o[k]??''))
    &&eq(o.acceptedIssuerControls,['spcx'])&&o.acceptUntestedV4===true,'V4_EXPLICIT_DEPLOY_BINDINGS_REQUIRED');
  if(o.rpcFile!==undefined)need(path.isAbsolute(o.rpcFile)&&!/[\x00-\x1f\x7f]/.test(o.rpcFile),'V4_RPC_FILE_ABSOLUTE_REQUIRED');return o;
}
export function validateV4Approval({approval:a,plan,options,now=Date.now()}){
  const t=v4ApprovalTemplate(plan,{now});
  need(exact(a,Object.keys(t))&&a.schema===V4_APPROVAL_SCHEMA&&a.status==='approved'
    &&['chainId','genesisHash','deployer','account','planId','policySHA256','reviewSHA256','candidateBuildSHA256','scope','capsMode','caps','steps','limits','scopeBudgetWei','newTransactionPriceCapWei','maximumNewGasWei'].every(k=>eq(a[k],t[k])),'V4_APPROVAL_BINDING_OR_SCOPE_CHANGED');
  const issued=Date.parse(a.approvedAt),expires=Date.parse(a.expiresAt);
  need(Number.isFinite(issued)&&Number.isFinite(expires)&&issued<=now+300000&&now<expires&&expires>issued&&expires-issued<=86400000,'V4_APPROVAL_EXPIRED_OR_INVALID');
  need(eq(a.acceptedRisks,[...V4_RISKS])&&eq(options.acceptedIssuerControls,['spcx'])&&options.acceptUntestedV4===true,'V4_RISKS_NOT_APPROVED');return a;
}
async function context(options={}){
  const root=await fs.realpath(options.root??ROOT),plan=await createV4DeploymentPlan({root,reviewPath:options.reviewPath,includeCalldata:true});
  let approval=null;
  if(options.approvalPath){validateV4BindingFlags(options);const b=await v4PublicFile(root,options.approvalPath);
    need(sha256(b)===options.approvalSHA256&&plan.planId===options.planId&&plan.identity.policy.sha256===options.policySHA256&&plan.identity.review.sha256===options.reviewSHA256,'V4_EXPLICIT_HASH_MISMATCH');
    approval=validateV4Approval({approval:JSON.parse(b),plan,options});}
  return{root,plan,review:JSON.parse(await v4PublicFile(root,plan.identity.review.path)),approval};
}
export async function planV4Mainnet(options={}){
  const{plan,approval}=await context(options),{coreManifest,adapterBuild,...out}=plan;
  return{...out,approvalValidated:Boolean(approval),approvalTemplate:v4ApprovalTemplate(plan),
    outputs:{pools:POOL_OUTPUT,v4Adapters:ROUTE_OUTPUT},runnerReviewRequired:true,readyForBroadcast:false,
    limitations:['Four sequential CREATE transactions, not one atomic blockchain transaction.','Compilation is not testing or an audit; explicit new-code and issuer risk approval is required.',
      'Unknown signed hashes block this account; recover identical bytes with the existing recovery procedure. Never choose a new plan to evade it.']};
}
export function v4ScopeCost(state,planId){return state.entries.filter(e=>e.id.startsWith(`deploy:${planId}:`)).reduce((sum,e)=>sum+(['confirmed','reverted'].includes(e.status)?BigInt(e.feeWei):terminal(e)?0n:BigInt(e.feeCeilingWei)),0n);}

export async function deployV4Mainnet(options={}){
  validateV4BindingFlags(options);
  need(options.account===ACCOUNT&&typeof options.passwordFile==='string'&&path.isAbsolute(options.passwordFile),'V4_LOCAL_KEYSTORE_ARGUMENTS_REQUIRED');
  const ctx=await context(options),{root,plan,review}=ctx;
  need(ctx.approval,'V4_APPROVAL_REQUIRED');
  // The public approval has already passed. --plan never calls this reader.
  const rpc=await readV4DeploymentRPC({rpcFile:options.rpcFile});
  console.error(json({stage:'rpc-configured',rpcSource:rpc.source,privateRPCUsed:rpc.privateRPCUsed,urlOmitted:true}).trim());
  // --plan cannot reach these imports or any private file/account journal.
  const v=await import('viem');
  const[{checkPublicReview},{checkRC3Deployment},{readMainnetGasPolicy},{normalizeMainnetBroadcastTransport},{createMainnetSigner},{openServiceStore},{loadVerifiedMainnetRelease},deploy]=await Promise.all([
    import('../review/run.mjs'),import('./mainnet-rc3.mjs'),import('./mainnet-limits.mjs'),import('./deploy-mainnet.mjs'),
    import('../../releases/rc3/src/phase2-mainnet/signer.mjs'),import('../../releases/rc3/src/phase1-service/store.mjs'),
    import('../../releases/rc3/src/phase2-mainnet/release.mjs'),import('../../releases/rc3/scripts/phase2-mainnet/deploy.mjs')]);
  await checkPublicReview({root});
  const checked=await checkRC3Deployment({root,limits:EXTENSION_LIMITS}),gasPolicy=await readMainnetGasPolicy({root});
  need(checked.account===ACCOUNT&&eq(checked.limits,EXTENSION_LIMITS)&&eq(gasPolicy.effectiveLimits,EXTENSION_LIMITS)
    &&checked.readiness?.code!=='MAINNET_LIMITS_AMENDMENT_INCOMPLETE','V4_PHYSICAL_LEDGER_LIMITS_CHANGED');
  const ledgerFile=path.join(checked.sharedSignerDirectory,'signer.json'),stat=await fs.lstat(ledgerFile);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(ledgerFile)===ledgerFile&&(stat.mode&0o077)===0,'V4_EXISTING_PHYSICAL_SIGNER_REQUIRED');
  const release=await loadVerifiedMainnetRelease({root:checked.directory}),core=plan.coreManifest;
  need(release.artifactSHA256===BUILD_SHA256&&same(release.config.deployer.address,DEPLOYER)&&release.config.deployer.signingAccount===ACCOUNT
    &&eq(release.production,core.production)&&same(release.config.guardian.address,SAFE),'V4_FROZEN_RELEASE_CHANGED');
  const client=v.createPublicClient({cacheTime:0,transport:normalizeMainnetBroadcastTransport(v.http(rpc.url,{retryCount:0,timeout:30000}))});
  const pools={},specs=[...plan.pools,...plan.adapters],adapterArtifact=v4AdapterArtifact(plan.adapterBuild),poolArtifact=release.artifacts.Phase2ASPPool;
  const dataFor=spec=>spec.asset?spec.data:v.encodeDeployData({abi:adapterArtifact.abi,bytecode:adapterArtifact.bytecode,args:[pools[spec.source],pools[spec.target]]});
  const field=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const scope=address=>BigInt(v.keccak256(v.encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],[v.keccak256(v.toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%field;
  const abi=v.parseAbi(['function implementation() view returns(address)','function treasuryUpgradeController() view returns(address)',
    'function factory() view returns(address)','function poolManager() view returns(address)','function curves(uint256) view returns(address)',
    'function strategies(uint256) view returns(address,address,address,address,address)','function status() view returns(uint8)',
    'function poolKey() view returns(address,address,uint24,int24,address)','function version() view returns(uint256)',
    'function isRegistered(bytes32) view returns(bool)','function poolConfig(bytes32) view returns(address,address,address,bool)',
    'function liquidityVaultOf(bytes32) view returns(address)','function rates(bytes32) view returns(uint16,uint16,uint32,uint16,uint16,uint16,uint16,uint8)',
    'function sellRateBps(bytes32) view returns(uint256)','function buyRateBps(bytes32) view returns(uint256)',
    'function PROVIDER() view returns(address)','function GUARDIAN() view returns(address)','function providerSuspended() view returns(bool)',
    'function ACCEPTED_POLICY_WINDOW() view returns(uint64)','function paused() view returns(bool)','function isBlocked(address) view returns(bool)',
    'function ACCESS_CONTROLLED_REGISTRY() view returns(address)','function symbol() view returns(string)','function decimals() view returns(uint8)',
    'function getOwners() view returns(address[])','function getThreshold() view returns(uint256)']);
  const codeHash=async(address,expected,n)=>{const code=await client.getCode({address,blockNumber:n});need(code&&code!=='0x'&&v.keccak256(code)===expected,'V4_LIVE_CODE_CHANGED');};
  async function live({newAddress}={}){
    await context(options);
    need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:0n})).hash===GENESIS,'V4_WRONG_CHAIN');
    const head=await client.getBlock(),n=head.number;need(n!==null&&Math.abs(Date.now()/1000-Number(head.timestamp))<90,'V4_RPC_STALE');
    need((await client.getBlock({blockNumber:BigInt(review.observation.blockNumber)})).hash===review.observation.blockHash,'V4_REVIEW_BLOCK_REORG');
    const read=(address,functionName,args=[],account)=>client.readContract({address,abi,functionName,args,blockNumber:n,...(account?{account}:{})});
    await deploy.checkMainnetDependencies({client,config:release.config,specs:[]});
    for(const pin of Object.values(plan.identity.sharedAnchors))await codeHash(pin.address,pin.runtimeCodeHash,n);
    for(const pin of Object.values(review.contracts))await codeHash(pin.address,pin.codeHash,n);
    await codeHash(SAFE,release.config.guardian.runtimeCodeHash,n);
    const safe=review.safeBindings;need(safe&&safe.ownerSetHash==='0x793c28b343a41f2376fc69f42937812bcdcd926831a4b6dd152d62f6751adcd7'&&safe.threshold===2&&safe.ownerCount===3,'V4_SAFE_REVIEW_MISSING');
    const slot=await client.getStorageAt({address:SAFE,slot:'0x'+'0'.repeat(64),blockNumber:n});need(slot&&same('0x'+slot.slice(-40),safe.singleton),'V4_SAFE_SINGLETON_CHANGED');
    await codeHash(safe.singleton,safe.singletonRuntimeCodeHash,n);
    const owners=await read(SAFE,'getOwners');need(owners.length===3&&await read(SAFE,'getThreshold')===2n&&v.keccak256(v.encodeAbiParameters([{type:'address[]'}],[owners]))===safe.ownerSetHash,'V4_SAFE_CONTROLS_CHANGED');
    need(same(await read(SHARED.Phase2ASPRegistry,'PROVIDER'),core.profiles.eth.registry.provider)&&same(await read(SHARED.Phase2ASPRegistry,'GUARDIAN'),SAFE)
      &&await read(SHARED.Phase2ASPRegistry,'providerSuspended')===false&&await read(SHARED.Phase2ASPRegistry,'ACCEPTED_POLICY_WINDOW')===16n,'V4_REGISTRY_CHANGED_OR_SUSPENDED');
    const refs=review.contracts;
    need(same(await read(V4.router,'factory'),V4.factory)&&same(await read(V4.router,'poolManager'),V4.manager)
      &&same(await read(V4.factory,'curves',[2n]),V4.curve)&&await read(V4.curve,'status')===2,'V4_ROUTER_STAGE_CHANGED');
    const strategy=await read(V4.factory,'strategies',[2n]);need(eq(strategy.map(x=>x.toLowerCase()),[V4.lincoln,V4.strategyTreasury,V4.hook,V4.spcx,'0xD7d7284FF95BAaD76167D331E803847DF0470577'].map(x=>x.toLowerCase())),'V4_STRATEGY_CHANGED');
    const key=await read(V4.strategyTreasury,'poolKey');need(same(key[0],V4.lincoln)&&same(key[1],V4.spcx)&&key[2]===2000&&key[3]===60&&same(key[4],V4.hook)
      &&v.keccak256(v.encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],key))===V4.poolId,'V4_POOL_KEY_CHANGED');
    need(same(await read(V4.strategyTreasury,'implementation'),V4.strategyImplementation)&&same(await read(V4.strategyTreasury,'treasuryUpgradeController'),V4.upgradeController),'V4_TREASURY_IMPLEMENTATION_CHANGED');
    const hookConfig=await read(V4.hook,'poolConfig',[V4.poolId]);
    need(await read(V4.hook,'version')===3n&&same(await read(V4.hook,'factory'),V4.factory)&&same(await read(V4.hook,'poolManager'),V4.manager)
      &&await read(V4.hook,'isRegistered',[V4.poolId])===true&&same(await read(V4.hook,'liquidityVaultOf',[V4.poolId]),refs.vault.address)
      &&same(hookConfig[0],V4.lincoln)&&same(hookConfig[1],V4.spcx)&&same(hookConfig[2],V4.strategyTreasury)&&hookConfig[3]===true
      &&!same(V4.router,V4.strategyTreasury)&&eq(await read(V4.hook,'rates',[V4.poolId]),[100,0,0,3000,5000,0,0,0])
      &&await read(V4.hook,'sellRateBps',[V4.poolId],V4.router)===100n&&await read(V4.hook,'buyRateBps',[V4.poolId],V4.router)===100n,'V4_HOOK_RULES_CHANGED');
    for(const[id,symbol]of [['lincoln','LINCOLN'],['spcx','SPCX']])need(await read(refs[id].address,'symbol')===symbol&&await read(refs[id].address,'decimals')===18,'V4_TOKEN_IDENTITY_CHANGED');
    const beacon=refs.spcxBeacon.address,impl=refs.spcxImplementation.address,beaconSlot='0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
    const beaconValue=await client.getStorageAt({address:V4.spcx,slot:beaconSlot,blockNumber:n});
    need(beaconValue&&same('0x'+beaconValue.slice(-40),beacon)&&same(await read(beacon,'implementation'),impl)
      &&same(await read(V4.spcx,'ACCESS_CONTROLLED_REGISTRY'),beacon)&&await read(V4.spcx,'paused')===false&&await read(beacon,'paused')===false,'V4_SPCX_PROXY_OR_PAUSE_CHANGED');
    for(const address of new Set([DEPLOYER,SAFE,...Object.values(refs).map(p=>p.address),...Object.values(pools),...(newAddress?[newAddress]:[])]))
      need(await read(beacon,'isBlocked',[address])===false,'V4_SPCX_ADDRESS_BLOCKED');
    if(newAddress){const code=await client.getCode({address:newAddress,blockNumber:n});need(!code||code==='0x','V4_CREATE_ADDRESS_ALREADY_HAS_CODE');}
    need((await client.getBlock({blockNumber:n})).hash===head.hash,'V4_LIVE_CHECK_REORG');return head;
  }
  await live();
  for(const[id,pin]of Object.entries(plan.identity.sharedAnchors)){
    const block=await client.getBlock({blockNumber:BigInt(pin.startBlock),includeTransactions:true});need(block.hash===pin.blockHash,'V4_SHARED_ANCHOR_REORG');
    const txs=block.transactions.filter(t=>typeof t==='object'&&t.to===null&&same(t.from,DEPLOYER)&&same(v.getContractAddress({from:DEPLOYER,nonce:BigInt(t.nonce)}),pin.address));
    need(txs.length===1,'V4_SHARED_CREATE_ANCHOR_MISSING');const tx=txs[0],artifact=release.artifacts[id];
    const data=v.encodeDeployData({abi:artifact.abi,bytecode:deploy.linkMainnetBytecode(artifact,core.addresses),args:id==='Phase2ASPRegistry'?[release.config.provider.address,SAFE]:[]});
    const runtime=await deploy.verifyMainnetDeployment({client,step:{id,address:pin.address,deployer:DEPLOYER,nonce:String(tx.nonce),hash:tx.hash,data},artifact,libraries:core.addresses,
      expectedGetters:id==='Phase2ASPRegistry'?{GUARDIAN:SAFE,ACCEPTED_POLICY_WINDOW:16n}:{}});
    need(runtime.runtimeCodeHash===pin.runtimeCodeHash&&runtime.startBlock===pin.startBlock,'V4_SHARED_RECEIPT_CHANGED');
  }
  const signer=createMainnetSigner({client,address:DEPLOYER,account:ACCOUNT,passwordFile:options.passwordFile,directory:checked.sharedSignerDirectory,
    ...EXTENSION_LIMITS,expectedGenesisHash:GENESIS,beforeBroadcast:async entry=>{
      need(entry.id.startsWith(`deploy:${plan.planId}:`)&&BigInt(entry.gasPrice)<=NEW_PRICE_CAP,'V4_NEW_PRICE_OR_SCOPE_CHANGED');
      const address=v.getAddress(v.getContractAddress({from:DEPLOYER,nonce:BigInt(entry.nonce)})),head=await live({newAddress:address});
      need(BigInt(entry.gasPrice)>=BigInt(head.baseFeePerGas??0n),'V4_PREPARED_PRICE_BELOW_BASE_FEE');}});
  const family=await openServiceStore({directory:path.join(checked.directory,'.phase1-private/phase2-mainnet/deployment-families/v4-lincoln-spcx-20261017'),identity:'lincoln-v4-lincoln-spcx-family:4663',filename:'family.json'});
  let store;
  try{
    const familyState=await family.read();need(!familyState||exact(familyState,['schema','planId','candidateBuildSHA256'])&&familyState.schema==='lincoln-v4-family/v1'
      &&familyState.planId===plan.planId&&familyState.candidateBuildSHA256===V4_BUILD_SHA,'V4_PRIOR_FAMILY_REQUIRES_MANUAL_RECOVERY');
    store=await openServiceStore({directory:path.join(checked.directory,'.phase1-private/phase2-mainnet/deployments',plan.planId),identity:`lincoln-mainnet-deployment:${plan.planId}`,filename:'deployment.json'});
    let journal=await store.read();const pins={planId:plan.planId,artifactSHA256:BUILD_SHA256,sourceSetSHA256:release.sourceSetSHA256,genesisHash:GENESIS,deployer:DEPLOYER,
      provider:release.config.provider.address,relayer:null,...EXTENSION_LIMITS,signerDirectory:checked.sharedSignerDirectory,v4Identity:plan.identity,
      scopeBudgetWei:SCOPE_BUDGET.toString(),initialApprovalSHA256:journal?.pins?.initialApprovalSHA256??options.approvalSHA256};
    journal??={schema:'phase2-mainnet-deployment/v1',pins,steps:[],status:'deploying',authorizationHistory:[]};
    need(eq(journal.pins,pins)&&['deploying','complete'].includes(journal.status),'V4_JOURNAL_PINS_CHANGED');
    journal.authorizationHistory=extensionAuthorizationHistory({history:journal.authorizationHistory,initialApprovalSHA256:pins.initialApprovalSHA256,approval:ctx.approval,
      approvalSHA256:options.approvalSHA256,approvalPath:options.approvalPath,plan});
    for(const step of journal.steps)if(step.id.startsWith('pool:'))pools[step.id.slice(5)]=step.address;
    let state=await signer.reconcile();validateExtensionLedger({state,plan,specs,dataFor,journal});
    for(const e of state.entries)if(e.to===null&&(plan.pools.some(p=>same(e.data,p.data))||e.data.toLowerCase().startsWith(adapterArtifact.bytecode.toLowerCase())))
      need(e.id.startsWith(`deploy:${plan.planId}:`),'V4_EXISTING_INTENT_FROM_OTHER_PLAN');
    for(const step of journal.steps){const e=state.entries.find(e=>e.id===step.reservationId),spec=specs.find(s=>s.id===step.id);
      need(e&&spec&&step.reservationId===`deploy:${plan.planId}:${spec.id}`&&step.nonce===e.nonce&&same(step.deployer,DEPLOYER)
        &&same(step.address,v.getContractAddress({from:DEPLOYER,nonce:BigInt(e.nonce)}))&&same(step.data,dataFor(spec))&&(!step.hash||step.hash===e.hash),'V4_SAVED_CREATE_BINDING_CHANGED');}
    const existing=[];for(const[directory,relative]of [[root,POOL_OUTPUT],[root,ROUTE_OUTPUT],...plan.pools.map(p=>[checked.directory,`config/phase2-mainnet-profiles/${p.asset.id}.json`])])
      try{existing.push({path:relative,value:JSON.parse(await v4PublicFile(directory,relative))});}catch(error){if(error.code!=='ENOENT')throw error;}
    validateOutputPreflight({existing,journal,state,plan,specs});
    for(const e of state.entries.filter(e=>!terminal(e)))need((await signer.unsignedEvidence(e.id))?.unsigned===true,'ACCOUNT_UNKNOWN_BROADCAST');
    const remaining=specs.filter(s=>!state.entries.some(e=>e.id===`deploy:${plan.planId}:${s.id}`)),maximum=remaining.reduce((s,x)=>s+BigInt(x.gasCap)*NEW_PRICE_CAP,0n);
    const pending=state.entries.filter(e=>!terminal(e)).reduce((s,e)=>s+BigInt(e.feeCeilingWei),0n);
    need(v4ScopeCost(state,plan.planId)+maximum<=SCOPE_BUDGET,'V4_SCOPE_BUDGET_EXCEEDED');
    need(BigInt(state.committedWei)+maximum<=BigInt(EXTENSION_LIMITS.budgetWei),'V4_CUMULATIVE_BUDGET_LOW');
    need(await client.getBalance({address:DEPLOYER,blockTag:'pending'})>=maximum+pending+BigInt(EXTENSION_LIMITS.reserveWei),'V4_BALANCE_RESERVE_LOW');
    await family.write(familyState??{schema:'lincoln-v4-family/v1',planId:plan.planId,candidateBuildSHA256:V4_BUILD_SHA});await store.write(journal);
    for(const spec of specs){
      const id=`deploy:${plan.planId}:${spec.id}`,data=dataFor(spec),artifact=spec.asset?poolArtifact:adapterArtifact;
      let entry=(await signer.status()).entries.find(e=>e.id===id),step=journal.steps.find(s=>s.id===spec.id);
      if(!entry){const head=await live(),price=extensionGasPrice(BigInt(head.baseFeePerGas??0n),await client.getGasPrice());
        state=await signer.status();need(v4ScopeCost(state,plan.planId)+BigInt(spec.gasCap)*price<=SCOPE_BUDGET,'V4_SCOPE_BUDGET_EXCEEDED');
        entry=await signer.prepare({id,to:null,data,value:'0',gas:spec.gasCap,gasPrice:price.toString()});}
      const address=v.getAddress(v.getContractAddress({from:DEPLOYER,nonce:BigInt(entry.nonce)}));
      if(step)need(step.reservationId===id&&step.nonce===entry.nonce&&same(step.address,address)&&same(step.data,data)&&(!step.hash||step.hash===entry.hash),'V4_STEP_CHANGED');
      else{need(journal.steps.length===specs.indexOf(spec)&&entry.status==='prepared','V4_JOURNAL_ORDER');step={id:spec.id,contract:spec.contract,kind:'created',reservationId:id,deployer:DEPLOYER,data,nonce:entry.nonce,address,status:'prepared'};journal.steps.push(step);await store.write(journal);}
      let hash=entry.hash;
      if(!hash){try{hash=await signer.broadcast(id);}catch(error){if(error.transactionHash){step.hash=error.transactionHash;step.status='unknown';await store.write(journal);}throw error;}
        step.hash=hash;step.status='submitted';await store.write(journal);
        try{await client.waitForTransactionReceipt({hash,timeout:60000,pollingInterval:1000});}catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_PENDING_NO_RESEND'),{code:'MAINNET_DEPLOYMENT_PENDING_NO_RESEND',transactionHash:hash});}}
      state=await signer.reconcile();const settled=state.entries.find(e=>e.id===id);need(settled?.status==='confirmed','V4_NOT_CONFIRMED');need(v4ScopeCost(state,plan.planId)<=SCOPE_BUDGET,'V4_SCOPE_BUDGET_EXCEEDED');
      step.hash=hash;let getters;
      if(spec.asset){getters={ASSET:spec.asset.address,VERIFIER:SHARED.Phase2ASPJoinSplitVerifier,HOLDER_EXIT_VERIFIER:SHARED.Phase2ASPExitVerifier,ASP_REGISTRY:SHARED.Phase2ASPRegistry,
          SCOPE:scope(address),TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,CAP_INCREASE_DELAY:43200n};pools[spec.asset.id]=address;}
      else{const sourceHash=v.keccak256(await client.getCode({address:pools[spec.source]})),targetHash=v.keccak256(await client.getCode({address:pools[spec.target]}));
        getters={SOURCE_POOL:pools[spec.source],TARGET_POOL:pools[spec.target],TOKEN_IN:spec.isBuy?V4.spcx:V4.lincoln,TOKEN_OUT:spec.isBuy?V4.lincoln:V4.spcx,IS_BUY:spec.isBuy,
          SOURCE_POOL_CODE_HASH:sourceHash,TARGET_POOL_CODE_HASH:targetHash,ROUTER:V4.router,FACTORY:V4.factory,POOL_MANAGER:V4.manager,HOOK:V4.hook,POOL_ID:V4.poolId,STRATEGY_ID:2n,
          STRATEGY_TREASURY:V4.strategyTreasury,STRATEGY_IMPLEMENTATION:V4.strategyImplementation,STRATEGY_UPGRADE_CONTROLLER:V4.upgradeController,CURVE:V4.curve,
          FEE_BPS:30,HOOK_TAX_BPS:100,LP_FEE_PIPS:2000,TICK_SPACING:60,GRADUATED:2,TREASURY:SAFE,SWAP_DOMAIN:V4.domain,
          fixedSqrtPriceLimitX96:spec.isBuy?V4.spcxToLincolnLimit:V4.lincolnToSpcxLimit};}
      step.runtime=await deploy.verifyMainnetDeployment({client,step,artifact,libraries:core.addresses,expectedGetters:getters,
        expectedInitialCaps:spec.asset?{maxDeposit:BigInt(spec.asset.depositCaps.maxDepositUnits),maxTotal:BigInt(spec.asset.depositCaps.maxTotalUnits)}:null});
      if(!spec.asset){const action={processor:DEPLOYER,amountIn:'1',minAmountOut:'1',deadline:'4102444800',targetPrecommitment:'1',encryptedTemplate:'0x'+'00'.repeat(256),maxServiceFee:'1',
          sqrtPriceLimitX96:String(spec.isBuy?V4.spcxToLincolnLimit:V4.lincolnToSpcxLimit),maxHookTaxBps:'100'};
        const prepared=prepareCandidateAction({adapter:address,sourcePool:pools[spec.source],targetPool:pools[spec.target],direction:spec.source+'-to-'+spec.target,action});
        need(await client.readContract({address,abi:artifact.abi,functionName:'actionHash',args:[prepared.action]})===prepared.actionHash
          &&await client.readContract({address,abi:artifact.abi,functionName:'actionEnvelope',args:[prepared.action]})===prepared.actionEnvelope,'V4_DEPLOYED_ENVELOPE_RULE_CHANGED');}
      step.feeWei=settled.feeWei;step.status='verified';await store.write(journal);console.error(json({id:spec.id,address,transactionHash:hash,feeWei:step.feeWei,status:'verified'}).trim());
    }
    const profiles=Object.fromEntries(plan.pools.map(p=>{const s=journal.steps.find(s=>s.id===p.id);return[p.asset.id,{...structuredClone(core.profiles.eth),productionReady:false,
      deployment:{planId:plan.planId,extension:'v4-lincoln-spcx-20261017',corePlanId:core.planId},asset:{symbol:p.asset.symbol,decimals:18},
      pool:{...s.runtime,asset:p.asset.address,noteModel:'factorized-asp-v1',scope:scope(s.address).toString(),treeDepth:20},depositCaps:p.asset.depositCaps,
      limitations:[...core.profiles.eth.limitations,'V4 adapter candidate is untested/unaudited; deployment does not enable routes or backend services.','SPCX issuer controls can block, burn or change pooled collateral.']}];}));
    const common={chainId:4663,genesisHash:GENESIS,planId:plan.planId,releaseId:BUILD_SHA256,production:release.production,coreManifest:{...plan.identity.pinnedInputs.core,planId:core.planId},
      policy:plan.identity.policy,review:plan.identity.review,approval:initialPublicApproval(journal),productionReady:false,gasPolicy:{globalLimits:EXTENSION_LIMITS,scopeBudgetWei:SCOPE_BUDGET.toString(),newTransactionPriceCapWei:NEW_PRICE_CAP.toString()}};
    const output={schema:'phase2-mainnet-stock-extension-deployed/v1',...common,profiles,addresses:{...core.addresses,...Object.fromEntries(journal.steps.filter(s=>s.id.startsWith('pool:')).map(s=>[s.id,s.address]))},
      stockPoolsDeployed:true,stockTradingEnabled:false,routes:[],routesByPool:{lincoln:[],spcx:[]},audit:core.audit};
    const adapters=plan.adapters.map(r=>{const s=journal.steps.find(s=>s.id===r.id);return{id:r.id.slice(6),source:r.source,target:r.target,adapterType:'Phase2FeeHedgeFunV4Adapter',kind:'hedgefun-v4-fixed-fee',
      adapter:s.address,...s.runtime,sourcePool:pools[r.source],targetPool:pools[r.target],transactionHash:s.hash,nonce:s.nonce,feeWei:s.feeWei,
      router:V4.router,factory:V4.factory,poolManager:V4.manager,poolId:V4.poolId,poolKey:{currency0:V4.lincoln,currency1:V4.spcx,fee:2000,tickSpacing:60,hooks:V4.hook},
      strategyId:'2',isBuy:r.isBuy,feeBps:30,treasury:SAFE,hookFlatTaxBps:100,fixedSqrtPriceLimitX96:String(r.isBuy?V4.spcxToLincolnLimit:V4.lincolnToSpcxLimit),
      sourceProfile:profiles[r.source],targetProfile:profiles[r.target],executionEnabled:false,verificationStatus:'deployed-bytecode-getters-and-envelope-verified-not-tested'};});
    const fees={schema:'phase2-mainnet-v4-fee-adapters-deployed/v1',...common,pools,adapters,feeBps:30,treasury:SAFE,feeArtifact:plan.identity.candidate,
      routesByPool:Object.fromEntries(['lincoln','spcx'].map(id=>[id,adapters.filter(a=>a.source===id).map(route=>({id:route.id,route,targetProfile:profiles[route.target]}))])),
      dexRoutesDeployed:true,serviceRoutesConfigured:false,existingV3ManifestChanged:false,
      feeWei:adapters.reduce((sum,a)=>sum+BigInt(a.feeWei),0n).toString()};
    await publish(root,POOL_OUTPUT,output);await publish(root,ROUTE_OUTPUT,fees);
    for(const[id,p]of Object.entries(profiles))await publish(checked.directory,`config/phase2-mainnet-profiles/${id}.json`,p);
    journal.status='complete';await store.write(journal);
    return{planId:plan.planId,pools,adapters:Object.fromEntries(adapters.map(a=>[a.id,a.adapter])),manifests:[POOL_OUTPUT,ROUTE_OUTPUT],feeWei:v4ScopeCost(await signer.status(),plan.planId).toString(),privateRPCUsed:rpc.privateRPCUsed,backendActivated:false,productionReady:false};
  }finally{if(store)await store.close();await family.close();}
}

export function parseV4Arguments(args){
  need(['--plan','--deploy'].includes(args[0]),'USAGE_V4_DEPLOY');const options={acceptedIssuerControls:[]};
  const names={'--review':'reviewPath','--approval':'approvalPath','--approval-sha256':'approvalSHA256','--plan-id':'planId','--policy-sha256':'policySHA256','--review-sha256':'reviewSHA256','--account':'account','--password-file':'passwordFile','--rpc-file':'rpcFile'};
  for(let i=1;i<args.length;i++){const arg=args[i];if(arg==='--accept-untested-v4'){need(!options.acceptUntestedV4,'V4_DUPLICATE_ARGUMENT');options.acceptUntestedV4=true;continue;}
    need(typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'USAGE_V4_DEPLOY');
    if(arg==='--accept-issuer-controls'){need(!options.acceptedIssuerControls.includes(args[i+1]),'V4_DUPLICATE_ARGUMENT');options.acceptedIssuerControls.push(args[++i]);}
    else{const name=names[arg];need(name&&options[name]===undefined,'USAGE_V4_DEPLOY');options[name]=args[++i];
      if(name==='rpcFile')need(path.isAbsolute(options.rpcFile)&&!/[\x00-\x1f\x7f]/.test(options.rpcFile),'V4_RPC_FILE_ABSOLUTE_REQUIRED');}}
  if(args[0]==='--plan')need(!options.account&&!options.passwordFile,'V4_PLAN_NO_PRIVATE_ARGUMENTS');return{mode:args[0],options};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const{mode,options}=parseV4Arguments(process.argv.slice(2));console.log(json(await(mode==='--plan'?planV4Mainnet(options):deployV4Mainnet(options))));}
  catch(error){console.error(JSON.stringify({error:error.code??'V4_DEPLOYMENT_FAILED',...(error.transactionHash?{transactionHash:error.transactionHash}:{}),automaticResend:false}));process.exitCode=1;}
}
