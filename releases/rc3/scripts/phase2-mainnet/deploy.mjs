#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Default is an offline plan. Only --deploy can invoke the local keystore signer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createPublicClient,http,getAddress,isAddress,encodeDeployData,encodeAbiParameters,encodePacked,getContractAddress,keccak256,toHex,parseAbi,decodeEventLog} from 'viem';
import {openServiceStore} from '../../src/phase1-service/store.mjs';
import {createMainnetSigner,MAINNET_RPC} from '../../src/phase2-mainnet/signer.mjs';
import {loadVerifiedMainnetRelease,readPublicFile,sha256} from '../../src/phase2-mainnet/release.mjs';
import {readMainnetPlan} from './plan.mjs';
import {verifyMainnetSafe} from '../../src/phase2-mainnet/safe.mjs';
import {poolDeploymentCaps,CAP_INCREASE_DELAY_SECONDS} from '../../src/phase2-mainnet/caps.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const ZERO='0x0000000000000000000000000000000000000000',FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const json=value=>JSON.stringify(value,null,2)+'\n';
const CAPS={PoseidonT3:7000000,PoseidonT4:4000000,Phase2ASPJoinSplitVerifier:1000000,Phase2ASPExitVerifier:1000000,Phase2ASPRegistry:1500000,Phase2ASPPool:6000000,Phase2RouteAdapter:5000000,Phase2Router02Adapter:5000000};
const numeric=(value,zero=false)=>{need(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&(zero?BigInt(value)>=0n:BigInt(value)>0n),'MAINNET_EXPLICIT_LIMIT_REQUIRED');return BigInt(value);};
const scopeFor=address=>BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],[keccak256(toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%FIELD;
const LIBRARIES=new Set(['PoseidonT3','PoseidonT4']);

export function normalizeAdoptedDeployments(values=[]){
  need(Array.isArray(values),'MAINNET_ADOPTED_DEPLOYMENTS_INVALID');const ids=new Set();
  return values.map(value=>{
    need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='address,hash,id,nonce,sourceReservationId',
      'MAINNET_ADOPTED_DEPLOYMENTS_INVALID');
    need(LIBRARIES.has(value.id)&&!ids.has(value.id)&&isAddress(value.address)&&value.address!==ZERO
      &&/^0x[0-9a-f]{64}$/.test(value.hash)&&typeof value.nonce==='string'&&/^(0|[1-9][0-9]*)$/.test(value.nonce)
      &&new RegExp(`^deploy:[0-9a-f]{64}:${value.id}$`).test(value.sourceReservationId),'MAINNET_ADOPTED_DEPLOYMENTS_INVALID');
    ids.add(value.id);return {...value,address:getAddress(value.address)};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}

/** A transition must keep the original physical account ledger, never a copy. */
export async function requireExistingMainnetSignerDirectory(directory){
  need(typeof directory==='string'&&path.isAbsolute(directory),'MAINNET_SHARED_SIGNER_REQUIRED');
  const stat=await fs.lstat(directory);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(directory)===directory&&(stat.mode&0o077)===0
    &&(typeof process.getuid!=='function'||stat.uid===process.getuid()),'MAINNET_SHARED_SIGNER_DIRECTORY_INVALID');
  const filename=path.join(directory,'signer.json'),file=await fs.lstat(filename);
  need(file.isFile()&&!file.isSymbolicLink()&&await fs.realpath(filename)===filename&&(file.mode&0o077)===0
    &&(typeof process.getuid!=='function'||file.uid===process.getuid()),'MAINNET_SHARED_SIGNER_LEDGER_INVALID');
  return directory;
}

/** Public snapshot metadata locates the existing private ledger; no key is read. */
export async function readMainnetDeploymentContinuation({root=ROOT}={}){
  const metadata=JSON.parse(await readPublicFile(root,'operations-snapshot.json'));
  const adoptedDeployments=normalizeAdoptedDeployments(metadata.adoptedDeployments);
  need(adoptedDeployments.length>0,'MAINNET_SHARED_SIGNER_ANCHOR_REQUIRED');
  const signerDirectory=await requireExistingMainnetSignerDirectory(metadata.sharedSignerDirectory);
  return {signerDirectory,adoptedDeployments};
}

/** Library addresses are linked into creation and runtime binaries from solc refs. */
export function linkMainnetBytecode(artifact,libraries,{runtime=false}={}){
  let code=(runtime?artifact.deployedBytecode:artifact.bytecode).slice(2);
  for(const groups of Object.values(runtime?artifact.deployedLinkReferences??{}:artifact.linkReferences??{}))
    for(const [name,refs]of Object.entries(groups)){
      need(isAddress(libraries[name]),'MAINNET_LIBRARY_LINK_MISSING');
      for(const ref of refs){need(ref.length===20,'MAINNET_LIBRARY_LINK_INVALID');code=code.slice(0,ref.start*2)+libraries[name].slice(2).toLowerCase()+code.slice((ref.start+ref.length)*2);}
    }
  need(/^[0-9a-f]*$/i.test(code),'MAINNET_UNLINKED_BYTECODE');return '0x'+code;
}
function comparableRuntime(code,artifact,address,{expected=false}={}){
  let out=code.slice(2).toLowerCase();
  // Solidity libraries patch their own address into the initial PUSH20 guard.
  if(expected&&artifact.source?.includes('poseidon-solidity/')&&out.startsWith('73'))out=out.slice(0,2)+address.slice(2).toLowerCase()+out.slice(42);
  for(const refs of Object.values(artifact.immutableReferences??{}))for(const ref of refs){
    need(ref.length===32,'MAINNET_IMMUTABLE_REFERENCE_INVALID');out=out.slice(0,ref.start*2)+'00'.repeat(ref.length)+out.slice((ref.start+ref.length)*2);
  }
  return out;
}
export async function verifyMainnetDeployment({client,step,artifact,libraries,expectedGetters={},expectedInitialCaps=null}){
  const receipt=await client.getTransactionReceipt({hash:step.hash}),tx=await client.getTransaction({hash:step.hash});
  need(receipt.status==='success'&&same(receipt.contractAddress,step.address)&&same(receipt.from,step.deployer)
    &&receipt.transactionHash===step.hash&&receipt.to===null,'MAINNET_DEPLOYMENT_RECEIPT_MISMATCH');
  need((await client.getBlock({blockNumber:receipt.blockNumber})).hash===receipt.blockHash,'MAINNET_DEPLOYMENT_REORG');
  need(Number(tx.chainId)===4663&&same(tx.from,step.deployer)&&tx.to===null&&BigInt(tx.value)===0n&&BigInt(tx.nonce)===BigInt(step.nonce)
    &&same(tx.input,step.data),'MAINNET_DEPLOYMENT_TRANSACTION_MISMATCH');
  if(expectedInitialCaps!==null){
    // Mutable storage may have legitimately changed before first verification
    // or recovery. Initial caps are instead bound to the exact CREATE calldata
    // above and the constructor's own canonical CapsUpdated receipt event.
    const expected=poolDeploymentCaps({depositCaps:{schema:'lincoln-pool-deposit-caps/v1',unit:'asset-base-units',status:'configured',
      maxDepositUnits:String(expectedInitialCaps.maxDeposit),maxTotalUnits:String(expectedInitialCaps.maxTotal)}},{required:true});
    const topic=keccak256(toHex('CapsUpdated(uint128,uint128)'));
    const events=receipt.logs.filter(log=>same(log.address,step.address)&&same(log.topics?.[0],topic));
    need(events.length===1&&events[0].removed!==true,'MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH');
    let event;try{event=decodeEventLog({abi:artifact.abi,topics:events[0].topics,data:events[0].data,strict:true});}
    catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH'),{code:'MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH'});}
    need(event.eventName==='CapsUpdated'&&event.args.maxDeposit===expected.maxDeposit&&event.args.maxTotal===expected.maxTotal,
      'MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH');
  }
  const code=await client.getCode({address:step.address});need(code&&code!=='0x','MAINNET_DEPLOYED_CODE_MISSING');
  const expected=linkMainnetBytecode(artifact,libraries,{runtime:true});
  need(comparableRuntime(code,artifact,step.address)===comparableRuntime(expected,artifact,step.address,{expected:true}),'MAINNET_DEPLOYED_CODE_MISMATCH');
  for(const [functionName,value]of Object.entries(expectedGetters)){
    const actual=await client.readContract({address:step.address,abi:artifact.abi,functionName});
    const match=typeof value==='string'&&isAddress(value)?same(actual,value):isDeepStrictEqual(actual,value);
    need(match,'MAINNET_DEPLOYED_IMMUTABLE_MISMATCH');
  }
  return {address:step.address,runtimeCodeHash:keccak256(code),startBlock:receipt.blockNumber.toString(),blockHash:receipt.blockHash};
}

// The guardian can suspend and (after a delay) rotate the ASP provider; it should be a multisig.
export function guardianReady(config){
  return isAddress(config.guardian?.address)&&!same(config.guardian.address,config.provider?.address)
    &&!same(config.guardian.address,config.deployer?.address);
}
export function deploymentSpecs({config,routes=[]}){
  need(config.enabled===true&&config.chain?.id===4663&&config.network==='mainnet'&&config.deployment?.policyMode==='asp'
    &&config.deployment.selected==='aspSelfHosted'&&(config.deployer?.address===null||isAddress(config.deployer?.address))
    &&isAddress(config.provider?.address),'MAINNET_DEPLOYMENT_TARGET_INVALID');
  need(new URL(config.chain.rpcUrl).href===MAINNET_RPC,'MAINNET_OFFICIAL_RPC_REQUIRED');
  const assets=new Map(config.assets.map(asset=>[asset.symbol.toLowerCase(),asset]));
  need(assets.get('eth')?.address===ZERO&&assets.get('eth').decimals===18&&assets.get('usdg')?.decimals===6,'MAINNET_CORE_ASSETS_INVALID');
  const pins=Object.fromEntries(config.codePins.map(pin=>[pin.role,pin]));
  need(same(assets.get('usdg').address,pins.usdg?.address),'MAINNET_CORE_ASSETS_INVALID');
  const selected=new Set(['eth','usdg']),ids=new Set();
  const normalized=routes.map(r=>{
    need(r&&typeof r.id==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(r.id)&&!ids.has(r.id),'MAINNET_ROUTE_ID_INVALID');ids.add(r.id);
    need(['uniswap','up'].includes(r.venue)&&assets.has(r.source)&&assets.has(r.target)&&r.source!==r.target,'MAINNET_ROUTE_TARGET_INVALID');
    need(Array.isArray(r.tokens)&&r.tokens.length>=2&&r.tokens.length<=5&&Array.isArray(r.parameters)&&r.parameters.length===r.tokens.length-1
      &&Array.isArray(r.hops)&&r.hops.length===r.parameters.length,'MAINNET_ROUTE_PATH_INVALID');
    const allowed=[...assets.values()].map(a=>a.address.toLowerCase()).concat(pins.weth.address.toLowerCase());
    need(r.tokens.every(t=>isAddress(t)&&allowed.includes(t.toLowerCase())&&t!==ZERO)&&new Set(r.tokens.map(t=>t.toLowerCase())).size===r.tokens.length,'MAINNET_ROUTE_TOKEN_INVALID');
    need(r.parameters.every(n=>Number.isInteger(n)&&n>0&&n<(r.venue==='up'?2**23:1000000)),'MAINNET_ROUTE_PARAMETER_INVALID');
    const endpoint=id=>assets.get(id).address===ZERO?pins.weth.address:assets.get(id).address;
    need(same(r.tokens[0],endpoint(r.source))&&same(r.tokens.at(-1),endpoint(r.target)),'MAINNET_ROUTE_ENDPOINT_INVALID');
    need(r.hops.every(h=>isAddress(h.address)&&/^0x[0-9a-f]{64}$/i.test(h.runtimeCodeHash)),'MAINNET_ROUTE_HOP_PIN_REQUIRED');
    const pathTypes=['address'],values=[r.tokens[0]];
    for(let i=0;i<r.parameters.length;i++){pathTypes.push('uint24','address');values.push(r.parameters[i],r.tokens[i+1]);}
    selected.add(r.source);selected.add(r.target);
    return {...r,path:encodePacked(pathTypes,values),protocol:r.venue==='up'?1:0,
      router:pins[r.venue==='up'?'upRouter':'uniRouter'].address,factory:pins[r.venue==='up'?'upFactory':'uniFactory'].address,
      quoter:pins[r.venue==='up'?'upQuoter':'uniQuoter'].address,
      wrappedNative:pins.weth.address,contract:r.venue==='up'?'Phase2RouteAdapter':'Phase2Router02Adapter'};
  });
  const specs=['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry'].map(name=>({id:name,contract:name}));
  for(const assetId of selected){const asset=assets.get(assetId),caps=poolDeploymentCaps(asset);
    specs.push({id:`pool:${assetId}`,contract:'Phase2ASPPool',assetId,asset,depositCaps:caps?{maxDepositUnits:String(caps.maxDeposit),maxTotalUnits:String(caps.maxTotal)}:null});}
  for(const route of normalized)specs.push({id:`route:${route.id}`,contract:route.contract,route});
  return specs.map(s=>({...s,gasCap:CAPS[s.contract].toString()}));
}
export async function checkMainnetDependencies({client,config,specs}){
  need(await client.getChainId()===4663,'MAINNET_DEPLOYMENT_WRONG_CHAIN');
  if(config.guardian?.kind==='safe')await verifyMainnetSafe({client,guardian:config.guardian});
  const roles=new Set(['usdg']);
  for(const spec of specs){
    if(spec.asset&&spec.assetId!=='eth'&&spec.assetId!=='usdg')roles.add('stock-'+spec.asset.symbol);
    if(spec.route)for(const role of ['weth',spec.route.venue==='up'?'upRouter':'uniRouter',spec.route.venue==='up'?'upFactory':'uniFactory',spec.route.venue==='up'?'upQuoter':'uniQuoter'])roles.add(role);
  }
  for(const role of roles){const pin=config.codePins.find(p=>p.role===role);need(pin,'MAINNET_DEPENDENCY_PIN_MISSING');
    const code=await client.getCode({address:pin.address});need(code&&code!=='0x'&&keccak256(code)===pin.runtimeCodeHash,'MAINNET_DEPENDENCY_CODE_MISMATCH');}
  const tokenABI=parseAbi(['function decimals() view returns(uint8)']);
  for(const s of specs)if(s.asset&&s.assetId!=='eth')need(await client.readContract({address:s.asset.address,abi:tokenABI,functionName:'decimals'})===s.asset.decimals,'MAINNET_ASSET_DECIMALS_MISMATCH');
  for(const s of specs)if(s.route){const r=s.route,abi=parseAbi([`function getPool(address,address,${r.venue==='up'?'int24':'uint24'}) view returns(address)`]);
    const routerABI=parseAbi(['function factory() view returns(address)','function WETH9() view returns(address)']);
    need(same(await client.readContract({address:r.router,abi:routerABI,functionName:'factory'}),r.factory)
      &&same(await client.readContract({address:r.router,abi:routerABI,functionName:'WETH9'}),r.wrappedNative),'MAINNET_ROUTER_BINDING_MISMATCH');
    for(let i=0;i<r.hops.length;i++){
      need(same(await client.readContract({address:r.factory,abi,functionName:'getPool',args:[r.tokens[i],r.tokens[i+1],r.parameters[i]]}),r.hops[i].address),'MAINNET_ROUTE_FACTORY_MISMATCH');
      const code=await client.getCode({address:r.hops[i].address});need(code&&keccak256(code)===r.hops[i].runtimeCodeHash,'MAINNET_ROUTE_POOL_CODE_MISMATCH');
    }
  }
}
function argumentsFor(spec,addresses,config){
  if(spec.contract==='Phase2ASPRegistry')return [config.provider.address,config.guardian.address];
  if(spec.contract==='Phase2ASPPool'){const caps=poolDeploymentCaps(spec.asset,{required:true});
    return [addresses.Phase2ASPJoinSplitVerifier,addresses.Phase2ASPExitVerifier,addresses.Phase2ASPRegistry,spec.asset.address,caps.maxDeposit,caps.maxTotal];}
  if(spec.route){const r=spec.route;return [addresses['pool:'+r.source],addresses['pool:'+r.target],r.router,r.wrappedNative,r.protocol,r.path];}
  return [];
}
function gettersFor(spec,addresses,config){
  // PROVIDER is deliberately mutable. Its initial value is bound by the exact
  // constructor calldata; current provider/policy identity belongs to indexing.
  if(spec.contract==='Phase2ASPRegistry')return {GUARDIAN:config.guardian.address};
  if(spec.contract==='Phase2ASPPool')return {ASSET:spec.asset.address,VERIFIER:addresses.Phase2ASPJoinSplitVerifier,HOLDER_EXIT_VERIFIER:addresses.Phase2ASPExitVerifier,
    ASP_REGISTRY:addresses.Phase2ASPRegistry,SCOPE:scopeFor(addresses[spec.id]),TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,
    CAP_INCREASE_DELAY:BigInt(CAP_INCREASE_DELAY_SECONDS)};
  if(spec.route){const r=spec.route;return {SOURCE_POOL:addresses['pool:'+r.source],TARGET_POOL:addresses['pool:'+r.target],ROUTER:r.router,WRAPPED_NATIVE:r.wrappedNative,
    FACTORY:r.factory,SOURCE_ASSET:config.assets.find(a=>a.symbol.toLowerCase()===r.source).address,TARGET_ASSET:config.assets.find(a=>a.symbol.toLowerCase()===r.target).address,
    SOURCE_NATIVE:r.source==='eth',TARGET_NATIVE:r.target==='eth',TOKEN_IN:r.tokens[0],TOKEN_OUT:r.tokens.at(-1),PROTOCOL:r.protocol,HOPS:BigInt(r.parameters.length),
    PATH:r.path,PATH_HASH:keccak256(r.path),routeTokens:r.tokens.map(t=>getAddress(t)),hopPools:r.hops.map(h=>getAddress(h.address))};}
  return {};
}

function productionProfiles({config,specs,runtimes,addresses,genesisHash,artifactSHA256,sourceSetSHA256,production,relayer,planId}){
  const profiles={};
  for(const spec of specs.filter(s=>s.asset))profiles[spec.assetId]={schema:'phase2-asp-production-profile/v1',releaseCandidate:true,experimental:false,testOnly:false,productionReady:false,
    chain:{id:4663,rpcUrl:MAINNET_RPC},genesisHash,artifactSHA256,sourceSetSHA256,production,deployment:{planId},
    circuitManifests:Object.fromEntries(Object.entries(production.manifests).map(([name,m])=>[name,m.sha256])),
    asset:{symbol:spec.asset.symbol,decimals:spec.asset.decimals},pool:{...runtimes[spec.id],asset:spec.asset.address,noteModel:'factorized-asp-v1',scope:scopeFor(addresses[spec.id]).toString(),treeDepth:20},
    verifier:runtimes.Phase2ASPJoinSplitVerifier,exitVerifier:runtimes.Phase2ASPExitVerifier,
    registry:{...runtimes.Phase2ASPRegistry,provider:config.provider.address,guardian:config.guardian.address},libraries:{PoseidonT3:runtimes.PoseidonT3,PoseidonT4:runtimes.PoseidonT4},relayer,
    audit:config.audit,policy:{mode:'asp',providerKind:'self-hosted',bootstrapPolicy:'all-current-notes',sourceScreening:false},
    limitations:['Release candidate; independent audit is deferred.','Current-note approval does not screen original-deposit provenance.','External DEX operations and public deposits/exits expose amounts and timing.']};
  return profiles;
}

/** Public metadata only. Generating this configuration never reads a keystore. */
export function mainnetPublisherConfiguration({config,profiles,planId,production}){
  const ids=Object.keys(profiles),provider=config.provider;
  const signing={enabled:false,address:provider.address,
    ...(typeof provider.signerAccountName==='string'?{account:provider.signerAccountName}:{}),
    ...(typeof provider.signerKeystoreFile==='string'?{keystoreFile:provider.signerKeystoreFile}:{}),
    ...(typeof provider.signerPasswordFile==='string'?{passwordFile:provider.signerPasswordFile}:{}),
    budgetWei:null,maxGas:null,maxFeePerGasWei:null,reserveWei:null};
  need(!(signing.account&&signing.keystoreFile),'MAINNET_PROVIDER_SIGNER_METADATA_AMBIGUOUS');
  return {schema:'phase2-asp-operator-config/v1',policy:'all-current-notes',originScreening:false,
    artifactsPath:production.build.path,deployment:{planId,releaseId:production.releaseId},
    networks:{testnet:null,mainnet:{chainId:4663,profiles:ids.map(id=>`config/phase2-mainnet-profiles/${id}.json`),
      requiredPools:ids.map(id=>profiles[id].pool.address.toLowerCase()),
      directory:`.phase1-private/asp-operator/mainnet-publisher/${planId}`,outputDirectory:`artifacts/phase2-mainnet/asp-publisher/${planId}`,
      publisher:{intervalSeconds:15,signing,mirrors:[{directory:'docker/runtime/phase2-mainnet-public/association',activeFile:'current.json'}]}}},
    publication:{lifetimeSeconds:604800,renewalWindowSeconds:86400,minPublishIntervalSeconds:60,confirmations:2,maxCommitments:10000},
    limitations:['Signing is disabled until the operator explicitly supplies budget, gas limits and enables it.','The complete shared-registry pool roster is pinned to this deployment; maintain it when adding pools.',
      'All-current-notes availability is not deposit-origin screening.','The registry guardian can suspend the provider at once and rotate it after a public delay; update the pinned provider profile after any rotation.']};
}
async function publishExact(root,relative,value){
  const filename=path.join(root,relative);await fs.mkdir(path.dirname(filename),{recursive:true});
  need(await fs.realpath(path.dirname(filename))===path.dirname(filename),'MAINNET_OUTPUT_DIRECTORY_INVALID');
  const temporary=filename+'.'+randomUUID()+'.tmp';let file;
  try{
    file=await fs.open(temporary,'wx',0o644);await file.writeFile(json(value));await file.sync();await file.close();file=null;
    try{await fs.link(temporary,filename);}
    catch(error){if(error.code!=='EEXIST')throw error;need(isDeepStrictEqual(JSON.parse(await readPublicFile(root,relative)),value),'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS');}
    const dir=await fs.open(path.dirname(filename),'r');try{await dir.sync();}finally{await dir.close();}
  }finally{await file?.close();await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

/** Low-level engine receives an already verified release. CLI always uses the final-key gate. */
export async function runMainnetDeployment({root=ROOT,release,client,signer,routes=[],budgetWei,maxFeePerGasWei,reserveWei,relayer=null,
  adoptedDeployments=[],signerDirectory}={}){
  root=await fs.realpath(root);const {config,artifacts,artifactSHA256,sourceSetSHA256,production}=release;
  const adopted=normalizeAdoptedDeployments(adoptedDeployments),adoptedById=new Map(adopted.map(item=>[item.id,item]));
  if(adopted.length||signerDirectory!==undefined){
    await requireExistingMainnetSignerDirectory(signerDirectory);
    need(signer?.directory===signerDirectory,'MAINNET_SHARED_SIGNER_MISMATCH');
  }
  need(isAddress(config.deployer?.address)&&config.deployer.address!==ZERO,'MAINNET_DEPLOYER_UNSET');
  need(guardianReady(config),'MAINNET_GUARDIAN_INVALID');const specs=deploymentSpecs({config,routes}),budget=numeric(budgetWei),price=numeric(maxFeePerGasWei);numeric(reserveWei,true);
  for(const spec of specs)if(spec.asset)poolDeploymentCaps(spec.asset,{required:true});
  need(relayer===null||isAddress(relayer)&&relayer!==ZERO,'MAINNET_RELAYER_ADDRESS_INVALID');
  const maximum=specs.filter(spec=>!adoptedById.has(spec.id)).reduce((s,spec)=>s+BigInt(spec.gasCap)*price,0n);
  need(budget>=maximum,'MAINNET_DEPLOYMENT_BUDGET_BELOW_GAS_CAPS');
  need(same(signer.address,config.deployer.address)&&signer.chainId===4663,'MAINNET_DEPLOYMENT_SIGNER_MISMATCH');
  await checkMainnetDependencies({client,config,specs});
  const genesisHash=(await client.getBlock({blockNumber:0n})).hash;
  const planId=sha256(JSON.stringify({artifactSHA256,config,routes,relayer,...(adopted.length?{adoptedDeployments:adopted}:{})}));
  try{const old=JSON.parse(await readPublicFile(root,'config/phase2-mainnet-deployed.json'));
    need(old.planId===planId&&old.releaseId===production.releaseId,'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const directory=path.join(root,'.phase1-private/phase2-mainnet/deployments',planId);
  const store=await openServiceStore({directory,identity:`lincoln-mainnet-deployment:${planId}`,filename:'deployment.json'});
  try{
    let journal=await store.read();
    const pins={planId,artifactSHA256,sourceSetSHA256,genesisHash,deployer:config.deployer.address,provider:config.provider.address,relayer,budgetWei,maxFeePerGasWei,reserveWei,
      ...(signerDirectory!==undefined?{signerDirectory}:{}),...(adopted.length?{adoptedDeployments:adopted}:{})};
    if(!journal)journal={schema:'phase2-mainnet-deployment/v1',pins,steps:[],status:'deploying'};
    need(journal.schema==='phase2-mainnet-deployment/v1'&&isDeepStrictEqual(journal.pins,pins)&&Array.isArray(journal.steps),'MAINNET_DEPLOYMENT_JOURNAL_MISMATCH');
    need(journal.steps.length<=specs.length&&journal.steps.every((s,i)=>s.id===specs[i].id),'MAINNET_DEPLOYMENT_JOURNAL_ORDER_INVALID');
    // Existing public files must come from a fully verified journal. This permits
    // finishing an interrupted publication, without discovering roster conflicts
    // only after spending deployment gas.
    const allRuntimes=journal.steps.length===specs.length&&journal.steps.every(s=>s.runtime&&s.hash);
    const expectedProfiles=allRuntimes?productionProfiles({config,specs,runtimes:Object.fromEntries(journal.steps.map(s=>[s.id,s.runtime])),
      addresses:Object.fromEntries(journal.steps.map(s=>[s.id,s.address])),genesisHash,artifactSHA256,sourceSetSHA256,production,relayer,planId}):null;
    const publisherPath='config/phase2-asp-publisher-mainnet.json',profilePaths=specs.filter(s=>s.asset).map(s=>[`config/phase2-mainnet-profiles/${s.assetId}.json`,s.assetId]);
    const profileDir=path.join(root,'config/phase2-mainnet-profiles');
    try{need((await fs.lstat(profileDir)).isDirectory()&&await fs.realpath(profileDir)===profileDir,'MAINNET_OUTPUT_DIRECTORY_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const [relative,expected]of [...profilePaths.map(([file,id])=>[file,expectedProfiles?.[id]]),[publisherPath,expectedProfiles?mainnetPublisherConfiguration({config,profiles:expectedProfiles,planId,production}):null]]){
      try{const old=JSON.parse(await readPublicFile(root,relative));need(expected&&isDeepStrictEqual(old,expected),'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    mainnetPublisherConfiguration({config,profiles:{},planId,production});
    const accountState=await signer.reconcile(),reservedIds=new Set(accountState.entries.map(e=>e.id));
    // The old account's unknown broadcast cannot be abandoned by selecting a new
    // plan/root. Recovery is a separate, explicit same-byte operation.
    const unresolved=accountState.entries.find(e=>['unknown','broadcasting','signed'].includes(e.status)
      ||!['confirmed','reverted','cancelled'].includes(e.status)&&!e.id.startsWith(`deploy:${planId}:`));
    if(unresolved)throw Object.assign(new Error('ACCOUNT_UNKNOWN_BROADCAST'),{code:'ACCOUNT_UNKNOWN_BROADCAST',
      ...(unresolved.hash?{transactionHash:unresolved.hash}:{}),nonce:unresolved.nonce});
    const reusedRuntimes=new Map();
    for(const adoption of adopted){
      const entry=accountState.entries.find(e=>e.id===adoption.sourceReservationId);
      need(entry&&entry.status==='confirmed'&&entry.hash===adoption.hash&&entry.nonce===adoption.nonce&&entry.to===null&&entry.value==='0'
        &&same(getContractAddress({from:config.deployer.address,nonce:BigInt(entry.nonce)}),adoption.address),'MAINNET_ADOPTED_SOURCE_MISMATCH');
      const artifact=artifacts[adoption.id];need(artifact,'MAINNET_CONTRACT_ARTIFACT_MISSING');
      const data=encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,{}),args:[]});
      need(data===entry.data,'MAINNET_ADOPTED_INITCODE_MISMATCH');
      const runtime=await verifyMainnetDeployment({client,artifact,libraries:{},step:{hash:adoption.hash,address:adoption.address,
        deployer:config.deployer.address,nonce:entry.nonce,data}});
      reusedRuntimes.set(adoption.id,{runtime,data});
    }
    const remainingMaximum=specs.filter(s=>!adoptedById.has(s.id)&&!reservedIds.has(`deploy:${planId}:${s.id}`)).reduce((sum,s)=>sum+BigInt(s.gasCap)*price,0n);
    need(BigInt(accountState.committedWei)+remainingMaximum<=budget,'MAINNET_DEPLOYMENT_BUDGET_HEADROOM_LOW');
    const unresolvedMaximum=accountState.entries.filter(e=>!['confirmed','reverted','cancelled'].includes(e.status)).reduce((sum,e)=>sum+BigInt(e.feeCeilingWei),0n);
    need(await client.getBalance({address:config.deployer.address,blockTag:'pending'})>=remainingMaximum+unresolvedMaximum+BigInt(reserveWei),'MAINNET_DEPLOYMENT_BALANCE_RESERVE_LOW');
    await store.write(journal);const addresses={},runtimes={};
    for(const spec of specs){
      const artifact=artifacts[spec.contract];need(artifact,'MAINNET_CONTRACT_ARTIFACT_MISSING');
      const libraries=Object.fromEntries(['PoseidonT3','PoseidonT4'].filter(n=>addresses[n]).map(n=>[n,addresses[n]]));
      const data=encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,libraries),args:argumentsFor(spec,addresses,config)});
      let step=journal.steps.find(s=>s.id===spec.id),reservation;
      const id=`deploy:${planId}:${spec.id}`;
      const adoption=adoptedById.get(spec.id);
      if(adoption){
        need(!reservedIds.has(id),'MAINNET_ADOPTED_DUPLICATE_RESERVATION');
        const reused=reusedRuntimes.get(spec.id),expected={id:spec.id,kind:'reused',reservationId:adoption.sourceReservationId,
          sourceReservationId:adoption.sourceReservationId,sourcePlanId:adoption.sourceReservationId.split(':')[1],deployer:config.deployer.address,
          data,nonce:adoption.nonce,address:adoption.address,hash:adoption.hash,status:'verified',runtime:reused.runtime};
        need(reused.data===data,'MAINNET_ADOPTED_INITCODE_MISMATCH');
        if(step)need(isDeepStrictEqual(step,expected),'MAINNET_DEPLOYMENT_INTENT_CHANGED');
        else{journal.steps.push(expected);await store.write(journal);}
        addresses[spec.id]=adoption.address;runtimes[spec.id]=reused.runtime;continue;
      }
      need(!step||step.kind!=='reused','MAINNET_DEPLOYMENT_INTENT_CHANGED');
      if(step)need(step.data===data&&step.deployer===config.deployer.address,'MAINNET_DEPLOYMENT_INTENT_CHANGED');
      else{
        reservation=await signer.prepare({id,data,value:'0',gas:spec.gasCap});
        step={id:spec.id,reservationId:id,deployer:config.deployer.address,data,nonce:reservation.nonce,
          address:getContractAddress({from:config.deployer.address,nonce:BigInt(reservation.nonce)}),status:'prepared'};
        journal.steps.push(step);await store.write(journal);
      }
      addresses[spec.id]=step.address;
      let hash=await signer.recoverHash(id);
      if(!hash)hash=await signer.broadcast(id);
      step.hash=hash;step.status='submitted';await store.write(journal);
      try{await client.waitForTransactionReceipt({hash,timeout:60000,pollingInterval:1000});}
      catch{throw Object.assign(new Error('MAINNET_DEPLOYMENT_PENDING_NO_RESEND'),{code:'MAINNET_DEPLOYMENT_PENDING_NO_RESEND',transactionHash:hash});}
      const settled=await signer.reconcile(),entry=settled.entries.find(e=>e.id===id);
      need(entry?.status==='confirmed','MAINNET_DEPLOYMENT_REVERTED');
      runtimes[spec.id]=await verifyMainnetDeployment({client,step,artifact,libraries,expectedGetters:gettersFor(spec,addresses,config),
        expectedInitialCaps:spec.contract==='Phase2ASPPool'?poolDeploymentCaps(spec.asset,{required:true}):null});
      step.status='verified';step.runtime=runtimes[spec.id];await store.write(journal);
    }
    const profiles=productionProfiles({config,specs,runtimes,addresses,genesisHash,artifactSHA256,sourceSetSHA256,production,relayer,planId});
    const pinsByRole=Object.fromEntries(config.codePins.map(p=>[p.role,p]));
    const deployedRoutes=specs.filter(s=>s.route).map(s=>{
      const r=s.route,prefix=r.venue==='up'?'up':'uni';
      return {...r,adapter:addresses[s.id],adapterType:s.contract,runtimeCodeHash:runtimes[s.id].runtimeCodeHash,startBlock:runtimes[s.id].startBlock,
        sourcePool:addresses['pool:'+r.source],targetPool:addresses['pool:'+r.target],
        hops:r.hops.map((h,i)=>({pool:h.address,parameter:r.parameters[i],tokenIn:r.tokens[i],tokenOut:r.tokens[i+1],runtimeCodeHash:h.runtimeCodeHash})),
        runtimeCodeHashes:{adapter:runtimes[s.id].runtimeCodeHash,router:pinsByRole[prefix+'Router'].runtimeCodeHash,factory:pinsByRole[prefix+'Factory'].runtimeCodeHash,
          quoter:pinsByRole[prefix+'Quoter'].runtimeCodeHash,wrappedNative:pinsByRole.weth.runtimeCodeHash},deployment:'mainnet-production-build-candidate'};
    });
    const routesByPool=Object.fromEntries(Object.keys(profiles).map(id=>[id,deployedRoutes.filter(r=>r.source===id).map(route=>({id:route.id,route,targetProfile:profiles[route.target]}))]));
    const output={schema:'phase2-mainnet-deployed/v1',releaseCandidate:true,testOnly:false,productionReady:false,chainId:4663,genesisHash,planId,releaseId:production.releaseId,
      production,profiles,routes:deployedRoutes,routesByPool,addresses,feeWei:(await signer.status()).entries.filter(e=>e.id.startsWith(`deploy:${planId}:`)).reduce((sum,e)=>sum+BigInt(e.feeWei??0),0n).toString(),audit:config.audit,
      ...(adopted.length?{reusedDeployments:adopted,accountFeeWei:(await signer.status()).entries.reduce((sum,e)=>sum+BigInt(e.feeWei??0),0n).toString()}:{}),};
    const publisherConfig=mainnetPublisherConfiguration({config,profiles,planId,production});
    // Publish profiles/config first and the aggregate manifest last as commit marker.
    for(const [relative,id]of profilePaths)await publishExact(root,relative,profiles[id]);
    await publishExact(root,publisherPath,publisherConfig);
    await publishExact(root,'config/phase2-mainnet-deployed.json',output);
    journal.status='complete';await store.write(journal);return output;
  }finally{await store.close();}
}

export async function mainnetDeploymentPlan({root=ROOT,routes=[]}={}){
  const plan=await readMainnetPlan({root}),config=JSON.parse(await readPublicFile(root,'config/phase2-mainnet.json')),specs=deploymentSpecs({config,routes});
  return {schema:'phase2-mainnet-deploy-plan/v1',mode:'offline-plan',chainId:4663,rpcUrl:MAINNET_RPC,transactionsSigned:0,transactionsBroadcast:0,
    deployer:config.deployer.address,provider:config.provider,productionReady:false,audit:config.audit,guardian:config.guardian??null,
    treasury:config.treasury??null,readiness:plan.readiness,
    pending:[...(guardianReady(config)?plan.pending:[...plan.pending,{code:'MAINNET_GUARDIAN_REQUIRED',detail:'Set config.guardian.address to a multisig distinct from the deployer and provider.'}]),
      ...specs.filter(s=>s.asset&&!s.depositCaps).map(s=>({code:'MAINNET_POOL_CAPS_UNSET',detail:s.asset.symbol+': fixed-block raw-asset cap valuation is required.'}))],
    productionArtifacts:config.productionArtifacts,steps:specs.map(({id,contract,gasCap,asset,route,depositCaps})=>({id,contract,gasCap,...(asset?{asset,depositCaps}:{}),...(route?{route}:{}),status:'not-deployed'})),
    outputs:{manifest:'config/phase2-mainnet-deployed.json',profiles:specs.filter(s=>s.asset).map(s=>`config/phase2-mainnet-profiles/${s.assetId}.json`),
      aspPublisherConfig:'config/phase2-asp-publisher-mainnet.json',aspSigningEnabled:false,associationMirror:'docker/runtime/phase2-mainnet-public/association/current.json'},
    totalGasCap:specs.reduce((sum,s)=>sum+BigInt(s.gasCap),0n).toString(),
    requiredExplicitOptions:['--budget-wei','--max-fee-per-gas-wei','--reserve-wei','--password-file'],
    execution:'--deploy revalidates final ceremony artifacts and reproducible build, then signs only via local cast keystore. No numeric ETH budget is assumed.',
    scope:routes.length?'Selected pools and fixed routes; ETH wrapping and up to four hops are retained.':'Core ETH/USDG pools only. No route or stock pool is represented as deployed.'};
}
export function parseMainnetDeployArgs(args){
  const values={},flags=new Set(),allowed=new Set(['--budget-wei','--max-fee-per-gas-wei','--reserve-wei','--password-file','--account','--keystore-file','--relayer-address','--routes']);
  for(let i=0;i<args.length;i++){
    const key=args[i];need(!flags.has(key)&&!Object.hasOwn(values,key),'MAINNET_DEPLOY_ARGUMENT_INVALID');
    if(['--plan','--deploy'].includes(key))flags.add(key);
    else{need(allowed.has(key)&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'MAINNET_DEPLOY_ARGUMENT_INVALID');values[key]=args[++i];}
  }
  need(!(flags.has('--plan')&&flags.has('--deploy')),'MAINNET_DEPLOY_ARGUMENT_INVALID');
  need(!(values['--account']&&values['--keystore-file']),'MAINNET_KEYSTORE_OPTIONS_INVALID');
  if(values['--keystore-file'])need(path.isAbsolute(values['--keystore-file']),'MAINNET_KEYSTORE_OPTIONS_INVALID');
  if(flags.has('--deploy')){for(const key of ['--budget-wei','--max-fee-per-gas-wei','--reserve-wei','--password-file'])need(values[key]!==undefined,'MAINNET_EXPLICIT_DEPLOY_OPTIONS_REQUIRED');
    numeric(values['--budget-wei']);numeric(values['--max-fee-per-gas-wei']);numeric(values['--reserve-wei'],true);need(path.isAbsolute(values['--password-file']),'MAINNET_PASSWORD_FILE_REQUIRED');}
  return {deploy:flags.has('--deploy'),values};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const {deploy,values}=parseMainnetDeployArgs(process.argv.slice(2));let routes=[];
    if(values['--routes']){const routeConfig=JSON.parse(await readPublicFile(ROOT,values['--routes']));need(routeConfig.schema==='phase2-mainnet-route-selection/v1'&&routeConfig.chainId===4663,'MAINNET_ROUTE_CONFIG_INVALID');routes=routeConfig.routes;}
    if(!deploy)console.log(json(await mainnetDeploymentPlan({routes})).trim());
    else{
      const release=await loadVerifiedMainnetRelease(),client=createPublicClient({transport:http(MAINNET_RPC,{retryCount:0,timeout:30000})});
      const {config}=release;need(new URL(config.chain.rpcUrl).href===MAINNET_RPC,'MAINNET_OFFICIAL_RPC_REQUIRED');
      need(isAddress(config.deployer?.address)&&config.deployer.address!==ZERO,'MAINNET_DEPLOYER_UNSET');
      const continuation=await readMainnetDeploymentContinuation();
      const budgetWei=values['--budget-wei'],maxFeePerGasWei=values['--max-fee-per-gas-wei'],reserveWei=values['--reserve-wei'];
      const signer=createMainnetSigner({client,address:config.deployer.address,account:values['--keystore-file']?undefined:values['--account']??config.deployer.signingAccount,
        keystoreFile:values['--keystore-file'],passwordFile:values['--password-file'],budgetWei,maxFeePerGasWei,reserveWei,directory:continuation.signerDirectory});
      const result=await runMainnetDeployment({release,client,signer,routes,budgetWei,maxFeePerGasWei,reserveWei,relayer:values['--relayer-address']??null,
        ...continuation});console.log(json(result).trim());
    }
  }catch(error){console.error(JSON.stringify({error:error.code??'MAINNET_DEPLOYMENT_FAILED',...(error.transactionHash?{transactionHash:error.transactionHash}:{}),
    ...(error.rpcDiagnostic?{rpcDiagnostic:error.rpcDiagnostic}:{}),automaticResend:false}));process.exitCode=1;}
}
