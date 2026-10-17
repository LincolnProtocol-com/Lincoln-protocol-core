#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Separate, explicitly approved extension. Never changes a frozen release or resets an account journal.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createNewPoolPlan,sha256,DEPLOYER,SAFE,GENESIS,BUILD_SHA256,SHARED,DEX,WETH,USDG} from './new-pools-mainnet-plan.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const EXTENSION_LIMITS=Object.freeze({budgetWei:'65000000000000000',maxFeePerGasWei:'2800000000',reserveWei:'3000000000000000'});
export const NEW_PRICE_CAP=100000000n;
export const APPROVAL_SCHEMA='lincoln-mainnet-four-pool-approval/v1';
const RPC='https://rpc.mainnet.chain.robinhood.com/';
const ACCOUNT='lincoln-deployer',POOL_OUTPUT='deployments/robinhood-mainnet/four-pools-20261017.json';
const ROUTE_OUTPUT='deployments/robinhood-mainnet/four-pools-fee-adapters-30bps.json';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const terminal=e=>['confirmed','reverted','cancelled'].includes(e.status);
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n';
const exact=(v,keys)=>v&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');

async function publicFile(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.startsWith('.')&&!['node_modules','signers','keystore'].includes(x)),'EXTENSION_PUBLIC_PATH_REQUIRED');
  const file=path.join(root,relative),s=await fs.lstat(file);
  need(s.isFile()&&!s.isSymbolicLink()&&s.size<=128*1024*1024&&await fs.realpath(file)===file,'EXTENSION_REGULAR_PUBLIC_FILE_REQUIRED');
  return fs.readFile(file);
}
async function publishExact(root,relative,value){
  const file=path.join(root,relative),dir=path.dirname(file);await fs.mkdir(dir,{recursive:true});
  need(await fs.realpath(dir)===dir,'EXTENSION_OUTPUT_DIRECTORY_INVALID');
  try{need(isDeepStrictEqual(JSON.parse(await publicFile(root,relative)),value),'EXTENSION_OUTPUT_CONFLICT');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(file,json(value),{flag:'wx',mode:0o644});
}

/** These are artifacts of an approval, not an alternative to the human granting it. */
export function validateDeploymentApproval({approval,plan,acceptedIssuerControls=[],now=Date.now()}={}){
  need(exact(approval,['schema','status','chainId','genesisHash','deployer','account','planId','policySHA256','reviewSHA256','approvedAt','expiresAt','caps','acceptedIssuerControls','limits','newTransactionPriceCapWei','maximumNewGasWei','scope']),'EXTENSION_APPROVAL_SHAPE');
  need(approval.schema===APPROVAL_SCHEMA&&approval.status==='approved'&&approval.chainId===4663&&approval.genesisHash===GENESIS
    &&same(approval.deployer,DEPLOYER)&&approval.account===ACCOUNT&&approval.planId===plan.planId
    &&approval.policySHA256===plan.identity.policy.sha256&&approval.reviewSHA256===plan.identity.review?.sha256,'EXTENSION_APPROVAL_BINDING');
  const approved=Date.parse(approval.approvedAt),expires=Date.parse(approval.expiresAt);
  need(Number.isFinite(approved)&&Number.isFinite(expires)&&approved<=now+300000&&now<expires&&expires>approved&&expires-approved<=86400000,'EXTENSION_APPROVAL_EXPIRED_OR_INVALID');
  need(isDeepStrictEqual(approval.caps,plan.pools.map(p=>({id:p.asset.id,maxDepositUnits:p.asset.depositCaps.maxDepositUnits,maxTotalUnits:p.asset.depositCaps.maxTotalUnits})))
    &&isDeepStrictEqual(approval.limits,EXTENSION_LIMITS)&&approval.newTransactionPriceCapWei===NEW_PRICE_CAP.toString()
    &&approval.maximumNewGasWei===plan.maximumProposedNewGasWei
    &&approval.scope==='four-pools-and-six-uniswap-v3-fee-adapters-only','EXTENSION_APPROVAL_SCOPE_OR_CAP_CHANGED');
  const expected=[...plan.verification.issuerControlledAssets].sort();
  need(Array.isArray(approval.acceptedIssuerControls)&&new Set(approval.acceptedIssuerControls).size===approval.acceptedIssuerControls.length
    &&isDeepStrictEqual([...approval.acceptedIssuerControls].sort(),expected)&&isDeepStrictEqual([...acceptedIssuerControls].sort(),expected),'EXTENSION_ISSUER_RISK_NOT_APPROVED');
  const remaining=plan.verification.blockers.filter(x=>!expected.some(id=>x===`EXPLICIT_ISSUER_CONTROL_RISK_APPROVAL_REQUIRED:${id}`));
  need(remaining.length===0,'EXTENSION_REVIEW_INCOMPLETE');
  return approval;
}

export function extensionGasPrice(baseFee,quote){
  need(typeof baseFee==='bigint'&&baseFee>=0n&&typeof quote==='bigint'&&quote>0n,'EXTENSION_GAS_QUOTE_INVALID');
  const price=[baseFee*2n,baseFee+20000000n,quote].reduce((a,b)=>a>b?a:b);
  need(baseFee<=NEW_PRICE_CAP&&quote<=NEW_PRICE_CAP,'EXTENSION_GAS_PRICE_EXCEEDED');
  return price>NEW_PRICE_CAP?NEW_PRICE_CAP:price;
}

export function validateDeploymentBindingFlags(options){
  need(options&&typeof options.reviewPath==='string'&&typeof options.approvalPath==='string'
    &&['approvalSHA256','planId','policySHA256','reviewSHA256'].every(k=>typeof options[k]==='string'&&/^[0-9a-f]{64}$/.test(options[k]))
    &&Array.isArray(options.acceptedIssuerControls)&&options.acceptedIssuerControls.includes('aapl'),'EXTENSION_EXPLICIT_DEPLOY_BINDINGS_REQUIRED');
  return options;
}

export function validateExtensionLedger({state,plan,specs,dataFor,journal}){
  need(journal?.schema==='phase2-mainnet-deployment/v1'&&Array.isArray(journal.steps)&&journal.steps.length<=specs.length
    &&journal.steps.every((s,i)=>s.id===specs[i].id),'EXTENSION_JOURNAL_ORDER');
  const ownPrefix=`deploy:${plan.planId}:`;
  for(const entry of state.entries){
    if(!terminal(entry))need(entry.id.startsWith(ownPrefix)&&entry.status==='prepared'&&!entry.hash,'ACCOUNT_UNKNOWN_BROADCAST');
    if(entry.id.startsWith(ownPrefix)){
      const spec=specs.find(s=>entry.id===ownPrefix+s.id);
      need(spec&&entry.data.toLowerCase()===dataFor(spec).toLowerCase()&&entry.to===null&&entry.value==='0'
        &&entry.gas===spec.gasCap&&BigInt(entry.gasPrice)>0n&&BigInt(entry.gasPrice)<=NEW_PRICE_CAP
        &&!['reverted','cancelled'].includes(entry.status),'EXTENSION_LEDGER_INTENT_MISMATCH');
      if(entry.status==='confirmed')need(journal.steps.some(s=>s.reservationId===entry.id),'EXTENSION_CONFIRMED_STEP_MISSING');
    }
  }
}

export function validateOutputPreflight({existing,journal,state,plan,specs}){
  if(!existing.length)return;
  // A pre-existing output is only permitted after all ten transactions were already
  // verified. In this case re-publication cannot cause any new deployment expense.
  need(journal.steps.length===specs.length&&journal.steps.every(s=>s.status==='verified')&&specs.every(s=>
    state.entries.some(e=>e.id===`deploy:${plan.planId}:${s.id}`&&e.status==='confirmed')),'EXTENSION_OUTPUT_EXISTS_BEFORE_COMPLETION');
  for(const output of existing)need(output.value.planId===plan.planId||output.value.deployment?.planId===plan.planId,'EXTENSION_FOREIGN_OUTPUT_EXISTS');
}

/** Renewing a deadline appends authorization evidence; it never creates a new intent or nonce ledger. */
export function extensionAuthorizationHistory({history=[],initialApprovalSHA256,approval,approvalSHA256,approvalPath,plan}){
  const out=structuredClone(history);let previousSHA256=null;
  for(const entry of out){
    need(exact(entry,['schema','planId','policySHA256','reviewSHA256','approvalSHA256','approvalPath','approvedAt','expiresAt','previousSHA256','digest'])
      &&entry.schema==='lincoln-mainnet-extension-authorization/v1'&&entry.planId===plan.planId&&entry.policySHA256===plan.identity.policy.sha256
      &&entry.reviewSHA256===plan.identity.review.sha256&&/^[0-9a-f]{64}$/.test(entry.approvalSHA256)&&entry.previousSHA256===previousSHA256,'EXTENSION_APPROVAL_HISTORY_INVALID');
    const {digest,...body}=entry;need(sha256(JSON.stringify(body))===digest,'EXTENSION_APPROVAL_HISTORY_INVALID');previousSHA256=digest;
  }
  need(/^[0-9a-f]{64}$/.test(initialApprovalSHA256)&&(!out.length||out[0].approvalSHA256===initialApprovalSHA256),'EXTENSION_INITIAL_APPROVAL_CHANGED');
  need(out.length>0||initialApprovalSHA256===approvalSHA256,'EXTENSION_INITIAL_APPROVAL_CHANGED');
  if(out.at(-1)?.approvalSHA256===approvalSHA256)return out;
  need(!out.some(x=>x.approvalSHA256===approvalSHA256),'EXTENSION_APPROVAL_HISTORY_ROLLBACK');
  const body={schema:'lincoln-mainnet-extension-authorization/v1',planId:plan.planId,policySHA256:plan.identity.policy.sha256,reviewSHA256:plan.identity.review.sha256,
    approvalSHA256,approvalPath,approvedAt:approval.approvedAt,expiresAt:approval.expiresAt,previousSHA256};
  out.push({...body,digest:sha256(JSON.stringify(body))});
  return out;
}

export function initialPublicApproval(journal){
  const first=journal?.authorizationHistory?.[0];
  need(first&&first.approvalSHA256===journal.pins.initialApprovalSHA256,'EXTENSION_INITIAL_APPROVAL_CHANGED');
  // Publication must remain byte-for-byte reproducible if a later approval
  // renews the deadline between writing two otherwise identical public files.
  return {path:first.approvalPath,sha256:first.approvalSHA256};
}

async function publicContext({root=ROOT,reviewPath,approvalPath,approvalSHA256,planId,policySHA256,reviewSHA256,acceptedIssuerControls=[]}={}){
  root=await fs.realpath(root);
  const plan=await createNewPoolPlan({root,reviewPath,includeCalldata:true});
  const review=reviewPath?JSON.parse(await publicFile(root,reviewPath)):null;
  let approval=null;
  if(approvalPath){
    const bytes=await publicFile(root,approvalPath);
    need(sha256(bytes)===approvalSHA256&&plan.planId===planId&&plan.identity.policy.sha256===policySHA256&&plan.identity.review?.sha256===reviewSHA256,'EXTENSION_EXPLICIT_HASH_MISMATCH');
    approval=validateDeploymentApproval({approval:JSON.parse(bytes),plan,acceptedIssuerControls});
  }
  return {root,plan,review,approvalPath,approvalSHA256,approval,acceptedIssuerControls};
}

/** Offline: no signing modules imported, no RPC or private state read. */
export async function planNewPoolDeployment(options={}){
  const {plan}=await publicContext(options);
  return {...plan,runner:'scripts/operations/deploy-new-pools-mainnet.mjs',runnerReviewRequired:true,
    deploymentApprovalValidated:Boolean(options.approvalPath),readyForBroadcast:false,
    requiredApprovalSchema:APPROVAL_SCHEMA,outputs:{pools:POOL_OUTPUT,adapters:ROUTE_OUTPUT},
    limitations:[...plan.limitations,'A validated public approval file does not start deployment. Only explicit --deploy can import signer code.','Ten sequential transactions are resumable; this is not one atomic blockchain transaction.']};
}

export async function deployNewPoolsMainnet(options={}){
  need(options.account===ACCOUNT&&typeof options.passwordFile==='string'&&path.isAbsolute(options.passwordFile)
    &&options.reviewPath&&options.approvalPath,'EXTENSION_EXPLICIT_DEPLOY_ARGUMENTS_REQUIRED');
  validateDeploymentBindingFlags(options);
  const ctx=await publicContext(options),{root,plan,review}=ctx;
  // Imports below are unreachable from --plan and from incomplete/unapproved preparation.
  const v=await import('viem');
  const [{checkPublicReview},{checkRC3Deployment},{readMainnetGasPolicy},{normalizeMainnetBroadcastTransport},
    {createMainnetSigner},{openServiceStore},{loadVerifiedMainnetRelease},deploy,{verifyMainnetFeeComponent,MAINNET_FEE_ARTIFACT}]=await Promise.all([
    import('../review/run.mjs'),import('./mainnet-rc3.mjs'),import('./mainnet-limits.mjs'),import('./deploy-mainnet.mjs'),
    import('../../releases/rc3/src/phase2-mainnet/signer.mjs'),import('../../releases/rc3/src/phase1-service/store.mjs'),
    import('../../releases/rc3/src/phase2-mainnet/release.mjs'),import('../../releases/rc3/scripts/phase2-mainnet/deploy.mjs'),
    import('../../releases/rc3/src/phase2-fees/mainnet-release.mjs')]);
  await checkPublicReview({root});
  const checked=await checkRC3Deployment({root,limits:EXTENSION_LIMITS}),gasPolicy=await readMainnetGasPolicy({root});
  need(checked.account===ACCOUNT&&isDeepStrictEqual(checked.limits,EXTENSION_LIMITS)&&isDeepStrictEqual(gasPolicy.effectiveLimits,EXTENSION_LIMITS)
    &&checked.readiness?.code!=='MAINNET_LIMITS_AMENDMENT_INCOMPLETE','EXTENSION_PHYSICAL_LEDGER_LIMITS_MISMATCH');
  // Never initialize a replacement signer journal, including when run from a fresh worktree.
  const ledgerFile=path.join(checked.sharedSignerDirectory,'signer.json'),ledgerStat=await fs.lstat(ledgerFile);
  need(ledgerStat.isFile()&&!ledgerStat.isSymbolicLink()&&await fs.realpath(ledgerFile)===ledgerFile&&(ledgerStat.mode&0o077)===0,'EXTENSION_EXISTING_SIGNER_REQUIRED');
  const release=await loadVerifiedMainnetRelease({root:checked.directory});
  const core=JSON.parse(await publicFile(root,plan.identity.pinnedInputs.core.path));
  need(release.artifactSHA256===BUILD_SHA256&&same(release.config.deployer.address,DEPLOYER)&&release.config.deployer.signingAccount===ACCOUNT
    &&isDeepStrictEqual(release.production,core.production)&&same(release.config.guardian.address,SAFE),'EXTENSION_RELEASE_MISMATCH');
  const feeBytes=await fs.readFile(path.join(checked.directory,MAINNET_FEE_ARTIFACT));
  verifyMainnetFeeComponent({rootDirectory:checked.directory,artifactBytes:feeBytes,coreRelease:release});
  need(sha256(feeBytes)===plan.identity.pinnedInputs.fee.sha256,'EXTENSION_FEE_ARTIFACT_MISMATCH');
  const feeArtifact=JSON.parse(feeBytes).Phase2FeeRouter02Adapter;
  const poolArtifact=release.artifacts.Phase2ASPPool;
  const client=v.createPublicClient({cacheTime:0,transport:normalizeMainnetBroadcastTransport(v.http(RPC,{retryCount:0,timeout:30000}))});
  const pools={eth:core.addresses['pool:eth'],usdg:core.addresses['pool:usdg']};
  const specs=[...plan.pools.map(p=>({id:p.id,contract:'Phase2ASPPool',pool:p,gasCap:'6000000'})),
    ...plan.routes.map(route=>({id:`route:${route.id}`,contract:'Phase2FeeRouter02Adapter',route,gasCap:'4000000'}))];
  const dataFor=spec=>spec.pool?spec.pool.unsignedCreate.data:v.encodeDeployData({abi:feeArtifact.abi,bytecode:deploy.linkMainnetBytecode(feeArtifact,{}),
    args:[pools[spec.route.source],pools[spec.route.target],DEX.router,WETH,0,spec.route.path,30,SAFE]});
  const field=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const scopeFor=address=>BigInt(v.keccak256(v.encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],
    [v.keccak256(v.toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%field;
  const poolGetters=(address,asset)=>({ASSET:asset,VERIFIER:SHARED.Phase2ASPJoinSplitVerifier,HOLDER_EXIT_VERIFIER:SHARED.Phase2ASPExitVerifier,ASP_REGISTRY:SHARED.Phase2ASPRegistry,
    SCOPE:scopeFor(address),TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,CAP_INCREASE_DELAY:43200n});
  const abi=v.parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)','function paused() view returns(bool)',
    'function isBlocked(address) view returns(bool)','function implementation() view returns(address)','function ACCESS_CONTROLLED_REGISTRY() view returns(address)',
    'function restrictionEndBlock() view returns(uint256)','function owner() view returns(address)','function pendingOwner() view returns(address)',
    'function endpoint() view returns(address)','function rateLimiter() view returns(address)','function factory() view returns(address)',
    'function WETH9() view returns(address)','function token0() view returns(address)','function token1() view returns(address)',
    'function fee() view returns(uint24)','function getPool(address,address,uint24) view returns(address)',
    'function PROVIDER() view returns(address)','function providerSuspended() view returns(bool)',
    'function maxDeposit() view returns(uint128)','function maxTotal() view returns(uint128)',
    'function getOwners() view returns(address[])','function getThreshold() view returns(uint256)']);
  const codeHash=async(address,expected,blockNumber)=>{const code=await client.getCode({address,blockNumber});need(code&&code!=='0x'&&v.keccak256(code)===expected,'EXTENSION_LIVE_RUNTIME_CHANGED');};
  async function live({extraAddress}={}){
    await publicContext(options); // Detect approval/review/policy mutation before every signature.
    need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:0n})).hash===GENESIS,'EXTENSION_WRONG_CHAIN');
    const head=await client.getBlock(),n=head.number;
    need(n!==null&&Math.abs(Date.now()/1000-Number(head.timestamp))<60,'EXTENSION_RPC_HEAD_STALE');
    need((await client.getBlock({blockNumber:BigInt(review.observation.blockNumber)})).hash===review.observation.blockHash,'EXTENSION_REVIEW_BLOCK_REORG');
    const read=(address,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:n});
    await deploy.checkMainnetDependencies({client,config:release.config,specs:[]});
    for(const ref of Object.values(plan.identity.sharedAnchors))await codeHash(ref.address,ref.runtimeCodeHash,n);
    for(const profile of Object.values(core.profiles))await codeHash(profile.pool.address,profile.pool.runtimeCodeHash,n);
    await codeHash(SAFE,release.config.guardian.runtimeCodeHash,n);
    const safe=review.safeBindings;
    need(safe&&/^0x[0-9a-f]{64}$/.test(safe.singletonRuntimeCodeHash),'EXTENSION_SAFE_SINGLETON_BINDING_REQUIRED');
    const singleton=await client.getStorageAt({address:SAFE,slot:'0x'+'0'.repeat(64),blockNumber:n});
    need(singleton&&same('0x'+singleton.slice(-40),safe.singleton),'EXTENSION_SAFE_SINGLETON_CHANGED');
    await codeHash(safe.singleton,safe.singletonRuntimeCodeHash,n);
    const owners=await read(SAFE,'getOwners'),threshold=await read(SAFE,'getThreshold');
    need(v.keccak256(v.encodeAbiParameters([{type:'address[]'}],[owners]))==='0x793c28b343a41f2376fc69f42937812bcdcd926831a4b6dd152d62f6751adcd7'
      &&threshold===2n&&owners.length===3,'EXTENSION_SAFE_OWNER_OR_THRESHOLD_CHANGED');
    need(same(await read(SHARED.Phase2ASPRegistry,'PROVIDER'),core.profiles.eth.registry.provider)
      &&await read(SHARED.Phase2ASPRegistry,'providerSuspended')===false,'EXTENSION_ASP_PROVIDER_CHANGED_OR_SUSPENDED');
    const usde=plan.pools.find(p=>p.asset.id==='usde').asset;
    need(await read(pools.usdg,'maxDeposit')*10n**12n===BigInt(usde.depositCaps.maxDepositUnits)
      &&await read(pools.usdg,'maxTotal')*10n**12n===BigInt(usde.depositCaps.maxTotalUnits),'EXTENSION_USDE_USDG_CAP_MIRROR_CHANGED');
    for(const role of ['weth','uniRouter','uniFactory','uniQuoter','usdg']){
      const pin=release.config.codePins.find(x=>x.role===role);need(pin,'EXTENSION_DEPENDENCY_PIN_MISSING');await codeHash(pin.address,pin.runtimeCodeHash,n);
    }
    need(same(await read(DEX.router,'factory'),DEX.factory)&&same(await read(DEX.router,'WETH9'),WETH),'EXTENSION_ROUTER_BINDING_CHANGED');
    for(const asset of review.assets){
      await codeHash(asset.address,asset.runtimeCodeHash,n);
      need(await read(asset.address,'symbol')===asset.symbol&&await read(asset.address,'decimals')===asset.decimals,'EXTENSION_TOKEN_IDENTITY_CHANGED');
      const b=asset.liveBindings;need(b&&typeof b==='object','EXTENSION_LIVE_BINDINGS_REQUIRED');
      if(asset.id==='aapl'){
        need(same(b.beacon,b.registry)&&/^0x[0-9a-f]{64}$/.test(b.registryRuntimeCodeHash)&&/^0x[0-9a-f]{64}$/.test(b.implementationRuntimeCodeHash),'EXTENSION_STOCK_BINDINGS_INVALID');
        await codeHash(b.registry,b.registryRuntimeCodeHash,n);await codeHash(b.implementation,b.implementationRuntimeCodeHash,n);
        const slot='0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
        const stored=await client.getStorageAt({address:asset.address,slot,blockNumber:n});
        need(stored&&same('0x'+stored.slice(-40),b.beacon)&&same(await read(b.beacon,'implementation'),b.implementation)
          &&same(await read(asset.address,'ACCESS_CONTROLLED_REGISTRY'),b.registry)&&await read(asset.address,'paused')===false&&await read(b.registry,'paused')===false,'EXTENSION_STOCK_PROXY_OR_PAUSE_CHANGED');
        for(const address of [DEPLOYER,SAFE,DEX.router,DEX.factory,...Object.values(pools),...review.markets.map(m=>m.address),...(extraAddress?[extraAddress]:[])])
          need(await read(b.registry,'isBlocked',[address])===false,'EXTENSION_STOCK_ADDRESS_BLOCKED');
      }else if(asset.id==='usde'){
        for(const name of ['owner','pendingOwner','endpoint','rateLimiter'])need(same(await read(asset.address,name),b[name]),'EXTENSION_USDE_BRIDGE_ADMIN_CHANGED');
      }else need(/^\d+$/.test(b.restrictionEndBlock)&&await read(asset.address,'restrictionEndBlock')===BigInt(b.restrictionEndBlock)&&n>BigInt(b.restrictionEndBlock),'EXTENSION_LAUNCH_RESTRICTIONS_ACTIVE_OR_CHANGED');
      for(const implementation of asset.sourceReview.implementations)await codeHash(implementation.address,implementation.runtimeCodeHash,n);
    }
    for(const m of review.markets){
      await codeHash(m.address,m.runtimeCodeHash,n);
      const tokens=[await read(m.address,'token0'),await read(m.address,'token1')];
      need(isDeepStrictEqual(tokens.map(t=>t.toLowerCase()).sort(),m.tokens.map(t=>t.toLowerCase()).sort())&&same(await read(m.address,'factory'),DEX.factory)
        &&await read(m.address,'fee')===m.fee&&same(await read(DEX.factory,'getPool',[m.tokens[0],m.tokens[1],m.fee]),m.address),'EXTENSION_MARKET_BINDING_CHANGED');
    }
    need((await client.getBlock({blockNumber:n})).hash===head.hash,'EXTENSION_LIVE_CHECK_REORG');
    return head;
  }
  // Establish original CREATE/receipt/runtime anchors, not only public metadata or code hashes.
  await live();
  for(const [id,ref]of Object.entries(plan.identity.sharedAnchors)){
    const block=await client.getBlock({blockNumber:BigInt(ref.startBlock),includeTransactions:true});need(block.hash===ref.blockHash,'EXTENSION_ANCHOR_BLOCK_CHANGED');
    const matches=block.transactions.filter(tx=>typeof tx==='object'&&tx.to===null&&same(tx.from,DEPLOYER)&&same(v.getContractAddress({from:DEPLOYER,nonce:BigInt(tx.nonce)}),ref.address));
    need(matches.length===1,'EXTENSION_ANCHOR_CREATE_MISSING');const tx=matches[0],artifact=release.artifacts[id];
    const args=id==='Phase2ASPRegistry'?[release.config.provider.address,SAFE]:[];
    const data=v.encodeDeployData({abi:artifact.abi,bytecode:deploy.linkMainnetBytecode(artifact,core.addresses),args});
    const result=await deploy.verifyMainnetDeployment({client,step:{id,address:ref.address,deployer:DEPLOYER,nonce:String(tx.nonce),hash:tx.hash,data},artifact,libraries:core.addresses,
      expectedGetters:id==='Phase2ASPRegistry'?{GUARDIAN:SAFE,ACCEPTED_POLICY_WINDOW:16n}:{}});
    need(result.runtimeCodeHash===ref.runtimeCodeHash&&result.startBlock===ref.startBlock,'EXTENSION_ANCHOR_RECEIPT_MISMATCH');
  }
  const signer=createMainnetSigner({client,address:DEPLOYER,account:ACCOUNT,passwordFile:options.passwordFile,directory:checked.sharedSignerDirectory,
    ...EXTENSION_LIMITS,expectedGenesisHash:GENESIS,beforeBroadcast:async entry=>{
      need(BigInt(entry.gasPrice)<=NEW_PRICE_CAP,'EXTENSION_NEW_PRICE_CAP_EXCEEDED');
      const address=v.getAddress(v.getContractAddress({from:DEPLOYER,nonce:BigInt(entry.nonce)})),head=await live({extraAddress:address});
      need(BigInt(entry.gasPrice)>=BigInt(head.baseFeePerGas??0n),'EXTENSION_PREPARED_PRICE_BELOW_BASE_FEE');
    }});
  const store=await openServiceStore({directory:path.join(checked.directory,'.phase1-private/phase2-mainnet/deployments',plan.planId),identity:`lincoln-mainnet-deployment:${plan.planId}`,filename:'deployment.json'});
  const immutablePins={planId:plan.planId,artifactSHA256:BUILD_SHA256,sourceSetSHA256:release.sourceSetSHA256,genesisHash:GENESIS,deployer:DEPLOYER,
    provider:release.config.provider.address,relayer:null,...EXTENSION_LIMITS,signerDirectory:checked.sharedSignerDirectory,
    extensionIdentity:plan.identity};
  try{
    let journal=await store.read();
    const pins={...immutablePins,initialApprovalSHA256:journal?.pins?.initialApprovalSHA256??ctx.approvalSHA256};
    journal??={schema:'phase2-mainnet-deployment/v1',pins,steps:[],status:'deploying',authorizationHistory:[]};
    need(isDeepStrictEqual(journal.pins,pins)&&['deploying','complete'].includes(journal.status),'EXTENSION_JOURNAL_PINS_CHANGED');
    journal.authorizationHistory=extensionAuthorizationHistory({history:journal.authorizationHistory,initialApprovalSHA256:pins.initialApprovalSHA256,
      approval:ctx.approval,approvalSHA256:ctx.approvalSHA256,approvalPath:ctx.approvalPath,plan});
    for(const step of journal.steps)if(step.id.startsWith('pool:'))pools[step.id.slice(5)]=step.address;
    let state=await signer.reconcile();validateExtensionLedger({state,plan,specs,dataFor,journal});
    // Validate every saved CREATE address against the original physical account
    // reservation before any saved address can become an adapter destination.
    for(const step of journal.steps){const entry=state.entries.find(e=>e.id===step.reservationId),spec=specs.find(s=>s.id===step.id);
      need(entry&&spec&&step.reservationId===`deploy:${plan.planId}:${spec.id}`&&step.nonce===entry.nonce&&same(step.deployer,DEPLOYER)
        &&same(step.address,v.getContractAddress({from:DEPLOYER,nonce:BigInt(entry.nonce)}))&&same(step.data,dataFor(spec))
        &&(!step.hash||step.hash===entry.hash),'EXTENSION_SAVED_CREATE_BINDING_CHANGED');}
    const existing=[];
    for(const [directory,relative]of [[root,POOL_OUTPUT],[root,ROUTE_OUTPUT],...plan.pools.map(p=>[checked.directory,`config/phase2-mainnet-profiles/${p.asset.id}.json`])]){
      try{existing.push({path:relative,value:JSON.parse(await publicFile(directory,relative))});}catch(error){if(error.code!=='ENOENT')throw error;}}
    validateOutputPreflight({existing,journal,state,plan,specs});
    for(const entry of state.entries.filter(e=>!terminal(e)))need((await signer.unsignedEvidence(entry.id))?.unsigned===true,'ACCOUNT_UNKNOWN_BROADCAST');
    const remaining=specs.filter(s=>!state.entries.some(e=>e.id===`deploy:${plan.planId}:${s.id}`));
    const maximum=remaining.reduce((s,x)=>s+BigInt(x.gasCap)*NEW_PRICE_CAP,0n),pending=state.entries.filter(e=>!terminal(e)).reduce((s,e)=>s+BigInt(e.feeCeilingWei),0n);
    need(BigInt(state.committedWei)+maximum<=BigInt(EXTENSION_LIMITS.budgetWei),'EXTENSION_CUMULATIVE_BUDGET_LOW');
    need(await client.getBalance({address:DEPLOYER,blockTag:'pending'})>=maximum+pending+BigInt(EXTENSION_LIMITS.reserveWei),'EXTENSION_BALANCE_RESERVE_LOW');
    await store.write(journal);
    for(const spec of specs){
      const id=`deploy:${plan.planId}:${spec.id}`,data=dataFor(spec),artifact=spec.pool?poolArtifact:feeArtifact;
      let entry=(await signer.status()).entries.find(e=>e.id===id),step=journal.steps.find(s=>s.id===spec.id);
      if(!entry){const head=await live();const price=extensionGasPrice(BigInt(head.baseFeePerGas??0n),await client.getGasPrice());
        entry=await signer.prepare({id,to:null,data,value:'0',gas:spec.gasCap,gasPrice:price.toString()});}
      const address=v.getAddress(v.getContractAddress({from:DEPLOYER,nonce:BigInt(entry.nonce)}));
      if(step)need(step.reservationId===id&&same(step.address,address)&&step.nonce===entry.nonce&&same(step.data,data)&&same(step.deployer,DEPLOYER)&&(!step.hash||step.hash===entry.hash),'EXTENSION_STEP_CHANGED');
      else{need(journal.steps.length===specs.indexOf(spec)&&entry.status==='prepared','EXTENSION_JOURNAL_ORDER');
        step={id:spec.id,contract:spec.contract,kind:'created',reservationId:id,deployer:DEPLOYER,data,nonce:entry.nonce,address,status:'prepared'};journal.steps.push(step);await store.write(journal);}
      let hash=entry.hash;
      if(!hash){try{hash=await signer.broadcast(id);}catch(error){if(error.transactionHash){step.hash=error.transactionHash;step.status='unknown';await store.write(journal);}throw error;}
        step.hash=hash;step.status='submitted';await store.write(journal);
        try{await client.waitForTransactionReceipt({hash,timeout:60000,pollingInterval:1000});}catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_PENDING_NO_RESEND'),{code:'MAINNET_DEPLOYMENT_PENDING_NO_RESEND',transactionHash:hash});}}
      const settled=(await signer.reconcile()).entries.find(e=>e.id===id);need(settled?.status==='confirmed','EXTENSION_NOT_CONFIRMED');
      step.hash=hash;let getters;
      if(spec.pool){getters=poolGetters(address,spec.pool.asset.address);pools[spec.pool.asset.id]=address;}
      else{const r=spec.route,asset=id=>plan.pools.find(p=>p.asset.id===id)?.asset.address??(id==='eth'?'0x0000000000000000000000000000000000000000':USDG);
        getters={SOURCE_POOL:pools[r.source],TARGET_POOL:pools[r.target],ROUTER:DEX.router,WRAPPED_NATIVE:WETH,FACTORY:DEX.factory,SOURCE_ASSET:asset(r.source),TARGET_ASSET:asset(r.target),
          SOURCE_NATIVE:r.source==='eth',TARGET_NATIVE:r.target==='eth',TOKEN_IN:r.tokens[0],TOKEN_OUT:r.tokens.at(-1),PROTOCOL:0,HOPS:1n,PATH:r.path,PATH_HASH:v.keccak256(r.path),FEE_BPS:30,TREASURY:SAFE,
          routeTokens:r.tokens.map(t=>v.getAddress(t)),hopPools:r.hops.map(h=>v.getAddress(h.address))};}
      step.runtime=await deploy.verifyMainnetDeployment({client,step,artifact,libraries:core.addresses,expectedGetters:getters,
        expectedInitialCaps:spec.pool?{maxDeposit:BigInt(spec.pool.asset.depositCaps.maxDepositUnits),maxTotal:BigInt(spec.pool.asset.depositCaps.maxTotalUnits)}:null});
      step.feeWei=settled.feeWei;step.status='verified';await store.write(journal);
      console.error(json({id:spec.id,address,transactionHash:hash,status:'confirmed',feeWei:step.feeWei}).trim());
    }
    const profiles=Object.fromEntries(plan.pools.map(p=>{const step=journal.steps.find(s=>s.id===p.id);return[p.asset.id,{...structuredClone(core.profiles.eth),productionReady:false,
      deployment:{planId:plan.planId,extension:'four-pools-20261017',corePlanId:core.planId},asset:{symbol:p.asset.symbol,decimals:18},
      pool:{...step.runtime,asset:p.asset.address,noteModel:'factorized-asp-v1',scope:scopeFor(step.address).toString(),treeDepth:20},depositCaps:{...p.asset.depositCaps,status:'configured'},
      limitations:[...core.profiles.eth.limitations,'Independent new-asset end-to-end acceptance, indexer, ASP and protected relays are not enabled by deployment.']}];}));
    const targetProfiles={...core.profiles,...profiles};
    const adapters=plan.routes.map(r=>{const step=journal.steps.find(s=>s.id===`route:${r.id}`);return{...r,adapterType:'Phase2FeeRouter02Adapter',adapter:step.address,...step.runtime,
      transactionHash:step.hash,nonce:step.nonce,feeWei:step.feeWei,sourcePool:pools[r.source],targetPool:pools[r.target],pathHash:v.keccak256(r.path),executionEnabled:false,
      verificationStatus:'deployed-bytecode-and-getters-verified',deployment:'mainnet-fee-adapter-30bps',
      hops:r.hops.map((h,i)=>({pool:h.address,parameter:r.parameters[i],tokenIn:r.tokens[i],tokenOut:r.tokens[i+1],runtimeCodeHash:h.runtimeCodeHash})),
      runtimeCodeHashes:{adapter:step.runtime.runtimeCodeHash,router:release.config.codePins.find(x=>x.role==='uniRouter').runtimeCodeHash,factory:release.config.codePins.find(x=>x.role==='uniFactory').runtimeCodeHash,
        quoter:release.config.codePins.find(x=>x.role==='uniQuoter').runtimeCodeHash,wrappedNative:release.config.codePins.find(x=>x.role==='weth').runtimeCodeHash}};});
    const routesByPool=Object.fromEntries(Object.keys(targetProfiles).map(id=>[id,adapters.filter(a=>a.source===id).map(route=>({id:route.id,route,targetProfile:targetProfiles[route.target]}))]));
    const common={chainId:4663,genesisHash:GENESIS,planId:plan.planId,releaseId:BUILD_SHA256,production:release.production,coreManifest:{...plan.identity.pinnedInputs.core,planId:core.planId},
      policy:plan.identity.policy,review:plan.identity.review,approval:initialPublicApproval(journal),gasPolicy:{globalLimits:EXTENSION_LIMITS,newTransactionPriceCapWei:NEW_PRICE_CAP.toString()},productionReady:false};
    const output={schema:'phase2-mainnet-stock-extension-deployed/v1',...common,profiles,addresses:{...core.addresses,...Object.fromEntries(journal.steps.filter(s=>s.id.startsWith('pool:')).map(s=>[s.id,s.address]))},
      stockPoolsDeployed:true,stockTradingEnabled:false,routes:[],routesByPool:Object.fromEntries(Object.keys(profiles).map(id=>[id,[]])),audit:core.audit};
    const fees={schema:'phase2-mainnet-fee-adapters-deployed/v1',...common,feeBps:30,treasury:SAFE,pools,adapters,routesByPool,dexRoutesDeployed:true,serviceRoutesConfigured:false,
      feeArtifact:{path:plan.identity.pinnedInputs.fee.path,sha256:sha256(feeBytes),sourceSetSHA256:JSON.parse(feeBytes)._meta.sourceSetSHA256},
      feeWei:adapters.reduce((s,a)=>s+BigInt(a.feeWei),0n).toString()};
    await publishExact(root,POOL_OUTPUT,output);await publishExact(root,ROUTE_OUTPUT,fees);
    for(const[id,profile]of Object.entries(profiles))await publishExact(checked.directory,`config/phase2-mainnet-profiles/${id}.json`,profile);
    journal.status='complete';await store.write(journal);
    return{planId:plan.planId,pools:Object.fromEntries(Object.entries(profiles).map(([id,p])=>[id,p.pool.address])),adapters:Object.fromEntries(adapters.map(a=>[a.id,a.adapter])),manifests:[POOL_OUTPUT,ROUTE_OUTPUT],
      feeWei:journal.steps.reduce((s,x)=>s+BigInt(x.feeWei),0n).toString(),productionReady:false,backendActivated:false};
  }finally{await store.close();}
}

export function parseNewPoolDeploymentArguments(args){
  need(args[0]==='--plan'||args[0]==='--deploy','USAGE_NEW_POOL_DEPLOYMENT');
  const options={acceptedIssuerControls:[]},names={'--review':'reviewPath','--approval':'approvalPath','--approval-sha256':'approvalSHA256','--plan-id':'planId',
    '--policy-sha256':'policySHA256','--review-sha256':'reviewSHA256','--account':'account','--password-file':'passwordFile'};
  for(let i=1;i<args.length;i++){
    const arg=args[i];need(typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'USAGE_NEW_POOL_DEPLOYMENT');
    if(arg==='--accept-issuer-controls'){need(!options.acceptedIssuerControls.includes(args[i+1]),'EXTENSION_DUPLICATE_ARGUMENT');options.acceptedIssuerControls.push(args[++i]);}
    else{const name=names[arg];need(name&&options[name]===undefined,'USAGE_NEW_POOL_DEPLOYMENT');options[name]=args[++i];}
  }
  if(args[0]==='--plan')need(!options.account&&!options.passwordFile,'EXTENSION_PLAN_NO_PRIVATE_ARGUMENTS');
  return {mode:args[0],options};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {mode,options}=parseNewPoolDeploymentArguments(process.argv.slice(2));console.log(json(await(mode==='--plan'?planNewPoolDeployment(options):deployNewPoolsMainnet(options))));}
  catch(error){console.error(JSON.stringify({error:error.code??'NEW_POOL_EXTENSION_FAILED',...(error.transactionHash?{transactionHash:error.transactionHash}:{}),automaticResend:false}));process.exitCode=1;}
}
