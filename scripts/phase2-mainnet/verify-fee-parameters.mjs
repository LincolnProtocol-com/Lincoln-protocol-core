#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Final production fee/core bytecode + real final Groth16 proofs on our own Anvil.
// Routers/liquidity are explicitly synthetic. No public RPC, wallet or fork input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import solc from 'solc';
import {createPublicClient,createWalletClient,http,encodeDeployData,encodeFunctionData,decodeEventLog,keccak256,toFunctionSelector,ExecutionRevertedError} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import * as sdk from '../../src/phase2-mainnet/sdk.mjs';
import * as fees from '../../src/phase2-fees/sdk.mjs';
import {syncPhase2State} from '../../src/phase2-asp/state.mjs';
import {loadVerifiedMainnetRelease} from '../../src/phase2-mainnet/release.mjs';
import {verifyMainnetFeeComponent,MAINNET_FEE_ARTIFACT} from '../../src/phase2-fees/mainnet-release.mjs';
import {linkMainnetBytecode,verifyMainnetDeployment} from './deploy.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),ZERO=sdk.NATIVE_ASSET,CHAIN_ID=4663;
const REPORT='artifacts/phase2-mainnet/final-fee-parameter-acceptance.json';
const sha=value=>createHash('sha256').update(value).digest('hex');
const wire=value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item));
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
export function parseFinalFeeParameterAcceptanceArgs(args){
  need(Array.isArray(args)&&args.length<=1&&args.every(a=>['--plan','--verify'].includes(a)),'FINAL_FEE_ACCEPTANCE_ARGUMENT_INVALID');
  return {verify:args[0]==='--verify'};
}
export function finalFeeParameterAcceptancePlan(){
  return {schema:'phase2-final-fee-acceptance-plan/v1',localOnly:true,chainId:CHAIN_ID,publicTransactions:0,
    usesPublicRPC:false,usesLocalDeployer:false,usesKeystore:false,usesFork:false,parameters:'final-production-only',
    realCoreAndFeeArtifacts:true,actualDEX:false,mockRouter:true,mockSourcePool:false,feeBps:20,relayMaxGas:'5000000',
    checks:['verify-final-core-and-reproduce-production-fee-component','independent-local-provider-guardian-and-A-B-wallets',
      'UP-Slipstream-two-hop-native-input-wrap','Router02-two-hop-native-output-unwrap',
      'proof-bound-action-cap-and-treasury-reverts','oldest-of-16-epoch-fee-route-padded-gas-cap','measured-output-fee-and-net-B-note',
      'B-encrypted-backup-only-recovery','B-current-note-ASP-approval-and-final-proof-withdrawal',
      'zero-private-pool-reserves-adapter-balances-and-allowances'],report:REPORT};
}
// A matching selector attached to a transport/encoding failure is not a revert.
export function isFinalFeeAcceptanceRevert(error,signature){
  const reverted=error instanceof ExecutionRevertedError
    ||typeof error?.walk==='function'&&error.walk(e=>e instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
  if(!reverted)return false;
  const selector=toFunctionSelector(signature).toLowerCase();
  for(let cause=error,depth=0;cause&&depth<20;cause=cause.cause,depth++)
    if(typeof cause.data==='string'&&cause.data.slice(0,10).toLowerCase()===selector)return true;
  return false;
}
async function publicFile(root,relative){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.')),'FINAL_FEE_ACCEPTANCE_PUBLIC_FILE_REQUIRED');
  const file=path.join(root,relative),h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await h.stat();need(stat.isFile()&&stat.size<=8*1024*1024&&await fs.realpath(file)===file,'FINAL_FEE_ACCEPTANCE_REGULAR_FILE_REQUIRED');return await h.readFile();}finally{await h.close();}
}
async function isolatedChain(){
  const work=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-final-fee-anvil-'))),socket=net.createServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise((resolve,reject)=>socket.close(e=>e?reject(e):resolve()));
  const rpcUrl=`http://127.0.0.1:${port}`;
  // Fresh cwd/HOME and a minimal environment avoid inherited RPC/fork/wallet settings.
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id',String(CHAIN_ID),'--hardfork','cancun','--accounts','0','--silent'],
    {cwd:work,env:{PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:work,LANG:'C',NO_COLOR:'1'},stdio:'ignore'});
  let spawnError;child.on('error',error=>{spawnError=error;});const exit=new Promise(resolve=>child.once('exit',resolve));
  const client=createPublicClient({transport:http(rpcUrl,{retryCount:0,timeout:2000}),cacheTime:0,pollingInterval:25});
  async function close(){
    if(!spawnError&&child.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);if(child.exitCode===null){child.kill('SIGKILL');await exit;}}
    await fs.rm(work,{recursive:true,force:true});
  }
  try{
    let ready=false;
    for(let i=0;i<100;i++){
      if(spawnError)throw spawnError;need(child.exitCode===null,'FINAL_FEE_ACCEPTANCE_ANVIL_EXITED');
      try{ready=await client.getChainId()===CHAIN_ID;if(ready)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    need(ready,'FINAL_FEE_ACCEPTANCE_ANVIL_NOT_READY');const clientVersion=await client.request({method:'web3_clientVersion'});
    need(/anvil/i.test(clientVersion),'FINAL_FEE_ACCEPTANCE_ANVIL_REQUIRED');const info=await client.request({method:'anvil_nodeInfo'});
    need(!info.forkConfig?.forkUrl&&!info.forkConfig?.forkBlockNumber,'FINAL_FEE_ACCEPTANCE_FORK_FORBIDDEN');
    need(await client.getBlockNumber()===0n&&(await client.request({method:'eth_accounts'})).length===0&&child.exitCode===null,'FINAL_FEE_ACCEPTANCE_FRESH_CHAIN_REQUIRED');
    return {client,rpcUrl,clientVersion,close};
  }catch(error){await close();throw error;}
}
async function compileFixtures(root){
  need(solc.version().startsWith('0.8.28+'),'FINAL_FEE_ACCEPTANCE_FIXTURE_COMPILER_MISMATCH');
  const filename='protocol/phase2-fees/test/FeeFixtures.sol',source=(await publicFile(root,filename)).toString('utf8'),imports=new Map();
  for(const name of ['token/ERC20/IERC20.sol','token/ERC20/ERC20.sol','token/ERC20/extensions/IERC20Metadata.sol','utils/Context.sol','interfaces/draft-IERC6093.sol'])
    imports.set(`@openzeppelin/contracts/${name}`,(await publicFile(root,`node_modules/@openzeppelin/contracts/${name}`)).toString('utf8'));
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{[filename]:{content:source}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}),
    {import:name=>imports.has(name)?{contents:imports.get(name)}:{error:'Outside fixture import allowlist.'}}));
  need(!(output.errors??[]).some(item=>item.severity==='error'),'FINAL_FEE_ACCEPTANCE_FIXTURE_COMPILATION_FAILED');
  // Only token/router/factory fixtures are used. Neither fake source nor fake target is returned.
  const names=['FeeTestToken','FeeTestWrapped','FeeTestHopPool','FeeTestFactory','FeeTestRouter'];
  return {sourceSHA256:sha(source),contracts:Object.fromEntries(names.map(name=>{const c=output.contracts[filename][name];return [name,{abi:c.abi,bytecode:'0x'+c.evm.bytecode.object}];}))};
}

export async function runFinalFeeParameterAcceptance(options={}){
  need(options&&Object.getPrototypeOf(options)===Object.prototype&&Object.keys(options).every(k=>['root','onProgress'].includes(k)),'FINAL_FEE_ACCEPTANCE_OPTIONS_INVALID');
  const {root:source=ROOT,onProgress=()=>{}}=options;need(typeof onProgress==='function','FINAL_FEE_ACCEPTANCE_OPTIONS_INVALID');const root=await fs.realpath(source);
  // Verify actual final keys, beacon chains and reproducible core/fee bytecode
  // BEFORE a local node, wallet, proof or report is created.
  const release=await loadVerifiedMainnetRelease({root});
  // This publication selects 5M after measured oldest-epoch padding exceeded 3M.
  // It is a gas-per-job limit, not any authorization to spend public-chain funds.
  need(release.config.limits?.maxRelayGas===5000000||release.config.limits?.maxRelayGas==='5000000','FINAL_FEE_ACCEPTANCE_EXPLICIT_RELEASE_GAS_CAP_REQUIRED');
  const relayMaxGas=BigInt(release.config.limits.maxRelayGas),feeBytes=await publicFile(root,MAINNET_FEE_ARTIFACT);
  const feeRelease=verifyMainnetFeeComponent({rootDirectory:root,artifactBytes:feeBytes,coreRelease:release});
  onProgress('final-core-and-production-fee-component-cryptographically-bound');
  const fixture=await compileFixtures(root),local=await isolatedChain(),{client,rpcUrl}=local;
  const artifacts=release.artifacts,adapters=feeRelease.contracts,libraries={},allPools=[],approvedLeaves=[];
  const report={schema:'phase2-final-fee-parameter-acceptance/v1',runId:randomUUID(),passed:false,localOnly:true,chainId:CHAIN_ID,
    publicTransactions:0,publicChainTransactions:0,mainnetDeployed:false,productionReady:false,actualDEX:false,mockRouter:true,mockSourcePool:false,mockTargetPool:false,
    realGroth16:true,finalProductionParameterAcceptance:true,usesKeystore:false,usesFork:false,provingParameterKind:'final-production',
    artifactSHA256:release.artifactSHA256,feeArtifactSHA256:feeRelease.artifactSHA256,coreSourceSetSHA256:release.sourceSetSHA256,
    feeSourceSetSHA256:feeRelease.sourceSetSHA256,production:release.production,fixtureSourceSHA256:fixture.sourceSHA256,clientVersion:local.clientVersion,
    checks:[],transactions:[],proofs:[],scenarios:[],gasChecks:[],relayMaxGas:String(relayMaxGas),limitations:[
      'Only a freshly spawned isolated local Anvil chain with ID 4663 is used; no public-chain transaction or keystore is involved.',
      'Actual final production verifiers/pools and production fee adapters are deployed; router, tokens, factory and liquidity are explicit mock DEX fixtures.',
      'UP/Router02 ABI compatibility, wrapping, accounting and proof binding are exercised; no real market prices, deployed DEX or production liquidity is validated.',
      'The independent synthetic guardian tests separation of roles; the configured mainnet Safe is verified separately.',
      'Each fee gas sample spends one positive input note plus a dummy and has no source change; it does not establish the gas maximum for every two-real-input or two-output shape.',
      'This is integration acceptance, not independent audit or an anonymity measurement.']};
  const pass=(name,detail={})=>{report.checks.push({name,passed:true,detail:wire(detail)});onProgress(name);};
  const chain={id:CHAIN_ID,name:'isolated final production fee acceptance',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}};
  const actors=Object.fromEntries(['deployer','provider','guardian','A','B','processor','treasury','otherTreasury'].map(name=>[name,privateKeyToAccount(generatePrivateKey())]));
  let activeSet=null;
  async function send(name,request,who='deployer',{mayRevert=false,gasLimit}={}){
    need(await client.getChainId()===CHAIN_ID,'FINAL_FEE_ACCEPTANCE_WRONG_CHAIN');
    const account=actors[who],wallet=createWalletClient({account,chain,transport:http(rpcUrl,{retryCount:0})});
    const gas=gasLimit??(mayRevert?5000000n:(await client.estimateGas({...request,account:account.address}))*12n/10n+10000n);
    const hash=await wallet.sendTransaction({...request,gas,gasPrice:await client.getGasPrice(),type:'legacy'});
    const receipt=await client.waitForTransactionReceipt({hash,timeout:30000,pollingInterval:25});
    report.transactions.push({name,hash,from:account.address,to:receipt.to,contractAddress:receipt.contractAddress,status:receipt.status,blockNumber:String(receipt.blockNumber),gasLimit:String(gas),gasUsed:String(receipt.gasUsed),feeWei:String(receipt.gasUsed*receipt.effectiveGasPrice)});
    assert.equal(receipt.status,mayRevert?'reverted':'success',name);return receipt;
  }
  async function deploy(name,artifact,args=[],expectedGetters){
    const data=encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,libraries),args}),receipt=await send('deploy-'+name,{data});
    const deployed={address:receipt.contractAddress,abi:artifact.abi,receipt};
    if(artifact.deployedBytecode){const tx=await client.getTransaction({hash:receipt.transactionHash});await verifyMainnetDeployment({client,artifact,libraries,
      step:{hash:receipt.transactionHash,address:deployed.address,deployer:actors.deployer.address,nonce:String(tx.nonce),data},expectedGetters:expectedGetters??{}});}
    return deployed;
  }
  const call=(contract,functionName,args=[])=>client.readContract({address:contract.address,abi:contract.abi,functionName,args});
  const write=(name,contract,functionName,args=[],who='deployer',value=0n)=>send(name,{to:contract.address,data:encodeFunctionData({abi:contract.abi,functionName,args}),value},who);
  const pin=async contract=>({address:contract.address,runtimeCodeHash:keccak256(await client.getCode({address:contract.address}))});
  const event=(receipt,contract,name)=>receipt.logs.filter(log=>log.address.toLowerCase()===contract.address.toLowerCase()).flatMap(log=>{
    try{return [decodeEventLog({abi:contract.abi,data:log.data,topics:log.topics})];}catch{return [];}
  }).find(e=>e.eventName===name)?.args;
  const proofArgs=t=>({pA:t.pA.map(BigInt),pB:t.pB.map(row=>row.map(BigInt)),pC:t.pC.map(BigInt),pubSignals:t.pubSignals.map(BigInt)});
  const extArgs=t=>({...t.extData,publicIn:BigInt(t.extData.publicIn),publicOut:BigInt(t.extData.publicOut),fee:BigInt(t.extData.fee)});
  const swapData=(contract,action,t)=>encodeFunctionData({abi:contract.abi,functionName:'swap',args:[action,proofArgs(t),extArgs(t),t.encryptedOutputs]});
  const snapshot=pool=>syncPhase2State({client,profile:pool.profile,artifacts,...(activeSet?{associationSet:activeSet}:{})});
  let verifier,exitVerifier,registry,genesisHash;
  async function pool(name,asset){
    const contract=await deploy(name,artifacts.Phase2ASPPool,[verifier.address,exitVerifier.address,registry.address,asset],{ASSET:asset,ASP_REGISTRY:registry.address});
    const profile={schema:sdk.PRODUCTION_PROFILE_SCHEMA,releaseCandidate:true,testOnly:false,productionReady:false,chain:{id:CHAIN_ID,rpcUrl},genesisHash,
      artifactSHA256:release.artifactSHA256,sourceSetSHA256:release.sourceSetSHA256,production:release.production,relayer:actors.processor.address,
      pool:{...await pin(contract),asset,noteModel:sdk.NOTE_MODEL,treeDepth:20,startBlock:String(contract.receipt.blockNumber)},
      verifier:await pin(verifier),exitVerifier:await pin(exitVerifier),registry:{...await pin(registry),provider:actors.provider.address,guardian:actors.guardian.address,startBlock:String(registry.receipt.blockNumber)}};
    profile.pool.scope=String(sdk.normalizeProfile(profile).scope);const result={...contract,profile};allPools.push(result);return result;
  }
  async function approve(name,pool,commitment){
    const leaf=String(sdk.associationLeaf(commitment,pool.profile));need(!approvedLeaves.includes(leaf),'FINAL_FEE_ACCEPTANCE_DUPLICATE_APPROVAL');approvedLeaves.push(leaf);
    activeSet={leaves:[...approvedLeaves],root:String(sdk.buildMerkleTree(approvedLeaves).root),digest:sdk.associationSetDigest(approvedLeaves)};
    await write(name,registry,'updateRoot',[BigInt(activeSet.root),activeSet.digest,(await client.getBlock()).timestamp+3600n],'provider');
  }
  async function prove(name,prepared,profile){
    const result=await sdk.proveJoinSplit(prepared,{rootDirectory:root,profile});
    assert.equal(result.manifestSHA256,release.production.manifests.joinsplit.sha256);
    assert.equal(await client.readContract({address:profile.verifier.address,abi:artifacts.Phase2ASPJoinSplitVerifier.abi,functionName:'verifyProof',args:[...Object.values(proofArgs(result.transaction))]}),true);
    assert.equal(await client.readContract({address:profile.pool.address,abi:artifacts.Phase2ASPPool.abi,functionName:'hashContext',args:[prepared.extData,prepared.encryptedOutputs]}),BigInt(result.transaction.pubSignals[3]));
    report.proofs.push({name,circuit:'joinsplit',manifestSHA256:result.manifestSHA256,offchainVerified:true,onchainVerified:true,inputNoteCount:prepared.inputNotes.length});
    return result;
  }
  try{
    for(const actor of Object.values(actors))await client.request({method:'anvil_setBalance',params:[actor.address,'0x56bc75e2d63100000']});
    assert.equal(new Set(Object.values(actors).map(a=>a.address)).size,Object.keys(actors).length);pass('independent-ephemeral-A-B-processor-provider-and-guardian');
    for(const name of ['PoseidonT3','PoseidonT4'])libraries[name]=(await deploy(name,artifacts[name])).address;
    verifier=await deploy('final-JoinSplit-verifier',artifacts.Phase2ASPJoinSplitVerifier);exitVerifier=await deploy('final-holder-exit-verifier',artifacts.Phase2ASPExitVerifier);
    registry=await deploy('final-guardian-registry',artifacts.Phase2ASPRegistry,[actors.provider.address,actors.guardian.address],{PROVIDER:actors.provider.address,GUARDIAN:actors.guardian.address,ACCEPTED_POLICY_WINDOW:16n});
    genesisHash=(await client.getBlock({blockNumber:0n})).hash;pass('real-final-core-runtime-bytecode-and-independent-guardian-verified');
    for(const scenario of [{id:'up-native-in',adapterType:'Phase2FeeRouteAdapter',protocol:1,nativeIn:true,nativeOut:false},{id:'router02-native-out',adapterType:'Phase2FeeRouter02Adapter',protocol:0,nativeIn:false,nativeOut:true}]){
      const label=name=>`${scenario.id}:${name}`,f=fixture.contracts;
      const W=await deploy(label('wrapped-native'),f.FeeTestWrapped),A=scenario.nativeIn?W:await deploy(label('token-A'),f.FeeTestToken,['FINAL-A']);
      const B=await deploy(label('intermediate-token-B'),f.FeeTestToken,['FINAL-B']),C=scenario.nativeOut?W:await deploy(label('token-C'),f.FeeTestToken,['FINAL-C']);
      const source=await pool(label('real-source-pool'),scenario.nativeIn?ZERO:A.address),target=await pool(label('real-target-pool'),scenario.nativeOut?ZERO:C.address);
      const first=await deploy(label('first-hop'),f.FeeTestHopPool),second=await deploy(label('second-hop'),f.FeeTestHopPool);
      const factory=await deploy(label('mock-factory'),f.FeeTestFactory,[A.address,B.address,C.address,first.address,second.address]);
      const router=await deploy(label('mock-router'),f.FeeTestRouter,[factory.address,W.address,A.address,B.address,C.address,first.address,second.address]);
      const packedPath=`0x${A.address.slice(2)}000bb8${B.address.slice(2)}000bb8${C.address.slice(2)}`;
      const args=[source.address,target.address,router.address,W.address,scenario.protocol,packedPath,20,actors.treasury.address];
      const adapter=await deploy(label('production-fee-adapter'),adapters[scenario.adapterType],args,{FEE_BPS:20,TREASURY:actors.treasury.address,SOURCE_NATIVE:scenario.nativeIn,TARGET_NATIVE:scenario.nativeOut,HOPS:2n});
      const twinArgs=[...args];twinArgs[7]=actors.otherTreasury.address;const twin=await deploy(label('different-treasury-adapter'),adapters[scenario.adapterType],twinArgs);
      const route={adapter:adapter.address,adapterType:scenario.adapterType,router:router.address,wrappedNative:W.address,factory:factory.address,protocol:scenario.protocol,path:packedPath,feeBps:20,treasury:actors.treasury.address};
      const a=sdk.createAccount();let b=sdk.createAccount();assert.notEqual(a.seed,b.seed);
      const password=randomBytes(24).toString('hex'),backup=sdk.sealAccount(b,password),receiver=sdk.receiverAddress(b,target.profile);b=null;
      if(scenario.nativeOut){await write(label('back-wrapped-output'),W,'deposit',[],'deployer',20000n);await write(label('fund-mock-output-liquidity'),W,'transfer',[second.address,20000n]);}
      else await write(label('fund-mock-output-liquidity'),C,'mint',[second.address,20000n]);
      if(!scenario.nativeIn){await write(label('fund-A-token'),A,'mint',[actors.A.address,1000n]);await write(label('A-approve-public-deposit'),A,'approve',[source.address,1000n],'A');}
      const invoice=sdk.createDynamicReceive(a,source.profile),deposit=await write(label('A-public-deposit'),source,'depositDynamic',[1000n,invoice.precommitment,invoice.encryptedTemplate],'A',scenario.nativeIn?1000n:0n);
      const deposited=event(deposit,source,'DynamicDeposited');assert.equal(deposited.value,1000n);await approve(label('ASP-approves-A'),source,deposited.commitment);
      const sourceState=await snapshot(source);assert.equal(sdk.recoverAccount(a,source.profile,sourceState).balance,1000n);
      const prepared=fees.prepareFeeSwap({account:a,sourceProfile:source.profile,targetProfile:target.profile,sourceState,route,receiver,
        action:{processor:actors.processor.address,amountIn:1000n,minAmountOut:9980n,maxServiceFee:20n,deadline:(await client.getBlock()).timestamp+3600n}});
      assert.equal(prepared.route.hops,2);assert.equal(prepared.route.wrapNative,scenario.nativeIn);assert.equal(prepared.route.unwrapNative,scenario.nativeOut);
      assert.equal(await call(adapter,'actionHash',[prepared.action]),prepared.actionHash);assert.equal(await call(adapter,'actionEnvelope',[prepared.action]),prepared.actionEnvelope);
      await write(label('configure-mock-output'),router,'configure',[0,10000n,99999n,ZERO]);
      const proved=await prove(label('A-final-fee-swap-proof'),prepared,source.profile),tx=fees.feeSwapTransaction(prepared,proved.proof);
      let oldestWindowProof=false;
      if(scenario.id==='up-native-in'){
        for(let i=0;i<15;i++)await write(label('advance-identical-set-'+(i+1)),registry,'updateRoot',[BigInt(activeSet.root),activeSet.digest,(await client.getBlock()).timestamp+3600n],'provider');
        const latest=await call(registry,'latestPolicy'),accepted=await call(registry,'acceptedPolicy',[BigInt(sourceState.asp.epoch)]);
        assert.equal(latest[1],BigInt(sourceState.asp.epoch)+15n);assert.equal(String(accepted[0]),sourceState.asp.root);assert.equal(String(accepted[1]),sourceState.asp.validUntil);
        oldestWindowProof=true;pass(label('fee-proof-is-oldest-still-accepted-of-16-epochs'),{proofEpoch:sourceState.asp.epoch,latestEpoch:String(latest[1]),window:16});
      }
      const sourceBalance=()=>scenario.nativeIn?client.getBalance({address:source.address}):call(A,'balanceOf',[source.address]);
      const targetBalance=()=>scenario.nativeOut?client.getBalance({address:target.address}):call(C,'balanceOf',[target.address]);
      async function rejection(name,contract,action,transaction,signature){
        const before=[await sourceBalance(),await targetBalance(),await call(C,'balanceOf',[actors.treasury.address]),await call(C,'balanceOf',[actors.otherTreasury.address])];
        const data=swapData(contract,action,transaction);
        await assert.rejects(()=>client.call({account:actors.processor.address,to:contract.address,data}),error=>isFinalFeeAcceptanceRevert(error,signature));
        await send(label(name),{to:contract.address,data},'processor',{mayRevert:true});
        assert.deepEqual([await sourceBalance(),await targetBalance(),await call(C,'balanceOf',[actors.treasury.address]),await call(C,'balanceOf',[actors.otherTreasury.address])],before);
        for(const nf of tx.pubSignals.slice(5,7))assert.equal(await call(source,'spentNullifiers',[BigInt(nf)]),false);
        pass(label(name),{executionRevert:signature,sourceUnspent:true,privateReservesAndTreasuriesUnchanged:true});
      }
      const changedCap={...prepared.action,maxServiceFee:21n};
      await rejection('original-envelope-rejects-fee-cap-tampering',adapter,changedCap,tx,'ActionMismatch()');
      const changedEnvelope=fees.feeSwapActionEnvelope({sourceProfile:source.profile,targetProfile:target.profile,route,action:changedCap});
      await rejection('original-proof-rejects-rebound-fee-cap',adapter,changedCap,{...tx,encryptedOutputs:[tx.encryptedOutputs[0],changedEnvelope]},'ContextMismatch()');
      await rejection('original-envelope-rejects-action-deadline-tampering',adapter,{...prepared.action,deadline:prepared.action.deadline+1n},tx,'ActionMismatch()');
      const twinRoute={...route,adapter:twin.address,treasury:actors.otherTreasury.address};
      const twinEnvelope=fees.feeSwapActionEnvelope({sourceProfile:source.profile,targetProfile:target.profile,route:twinRoute,action:prepared.action});
      await rejection('original-proof-rejects-treasury-and-adapter-substitution',twin,prepared.action,{...tx,extData:{...tx.extData,processor:twin.address,recipient:twin.address},encryptedOutputs:[tx.encryptedOutputs[0],twinEnvelope]},'ContextMismatch()');
      await write(label('configure-output-over-proof-bound-cap'),router,'configure',[0,10500n,99999n,ZERO]);
      await rejection('measured-output-fee-above-cap-reverts-atomically',adapter,prepared.action,tx,'ServiceFeeAboveLimit()');
      await write(label('restore-normal-mock-output'),router,'configure',[0,10000n,99999n,ZERO]);
      const treasuryBefore=await call(C,'balanceOf',[actors.treasury.address]);
      const actualSwapData=swapData(adapter,prepared.action,tx);
      await client.call({account:actors.processor.address,to:adapter.address,data:actualSwapData});
      const estimate=await client.estimateGas({account:actors.processor.address,to:adapter.address,data:actualSwapData}),paddedGas=estimate*12n/10n+10000n;
      const gasCheck={scenario:scenario.id,estimate:String(estimate),paddedGas:String(paddedGas),padding:'estimate * 12 / 10 + 10000',relayMaxGas:String(relayMaxGas),oldestWindowProof,positiveInputNoteCount:prepared.inputNotes.length,noSourceChange:true,exceedsPrevious3MCap:paddedGas>3000000n};
      report.gasChecks.push(gasCheck);
      assert.ok(paddedGas<=relayMaxGas,`Actual fee relay padding ${paddedGas} must fit explicit release ceiling ${relayMaxGas}.`);
      const swap=await send(label('A-private-fee-swap-to-B'),{to:adapter.address,data:actualSwapData},'processor',{gasLimit:paddedGas});
      pass(label('real-fee-swap-estimate-and-relay-padding-fit-cap'),{estimate:String(estimate),paddedGas:String(paddedGas),padding:'estimate * 12 / 10 + 10000',relayMaxGas:String(relayMaxGas),actualGasUsed:String(swap.gasUsed),oldestWindowProof});
      const feePaid=event(swap,adapter,'ServiceFeePaid'),received=event(swap,target,'DynamicDeposited');
      assert.equal(feePaid.grossAmountOut,10000n);assert.equal(feePaid.serviceFee,20n);assert.equal(feePaid.netAmountOut,9980n);assert.equal(received.value,9980n);
      assert.equal(await call(C,'balanceOf',[actors.treasury.address]),treasuryBefore+20n);assert.equal(await sourceBalance(),0n);
      assert.equal(await call(router,scenario.adapterType==='Phase2FeeRouter02Adapter'?'router02Calls':'deadlineCalls'),1n);
      pass(label('two-hop-measured-20bps-fee-and-net-private-output'),{gross:'10000',fee:'20',net:'9980',routerReported:'99999',wrapNative:scenario.nativeIn,unwrapNative:scenario.nativeOut,feeAsset:scenario.nativeOut?'wrapped-native':'output-ERC20'});
      const restored=sdk.openAccount(backup,password);assert.equal(restored.notes.length,0);
      const direct=sdk.decryptDynamicReceipt(restored,target.profile,wire(received));let targetState=await snapshot(target),recovered=sdk.recoverAccount(restored,target.profile,targetState);
      assert.equal(recovered.balance,9980n);assert.equal(recovered.notes.length,1);assert.equal(direct.commitment,recovered.notes[0].commitment);
      assert.ok(recovered.notes.every(note=>!Object.hasOwn(note,'originalDepositor')&&!Object.hasOwn(note,'label')));
      const withdrawalData={processor:actors.processor.address,recipient:actors.B.address,feeRecipient:ZERO,publicIn:0n,publicOut:9980n,fee:0n};
      assert.throws(()=>sdk.prepareJoinSplit({account:restored,profile:target.profile,state:targetState,inputs:[recovered.notes[0]],externalData:withdrawalData}),/pending ASP approval/);
      pass(label('B-backup-only-recovery-and-pending-current-note-ASP'),{recoveredNet:'9980',savedNotesBeforeRecovery:0});
      await approve(label('ASP-approves-B-recovered-note'),target,recovered.notes[0].commitment);targetState=await snapshot(target);
      const withdrawal=sdk.prepareJoinSplit({account:restored,profile:target.profile,state:targetState,inputs:[recovered.notes[0]],externalData:withdrawalData});
      const spent=await prove(label('B-final-normal-withdrawal-proof'),withdrawal,target.profile),t=spent.transaction,p=proofArgs(t);
      const bBalance=()=>scenario.nativeOut?client.getBalance({address:actors.B.address}):call(C,'balanceOf',[actors.B.address]),beforeB=await bBalance();
      await write(label('B-restored-note-normal-withdrawal'),target,'transact',[p.pA,p.pB,p.pC,p.pubSignals,extArgs(t),t.encryptedOutputs],'processor');
      assert.equal(await bBalance(),beforeB+9980n);assert.equal(await targetBalance(),0n);
      assert.equal(sdk.recoverAccount(restored,target.profile,await snapshot(target)).balance,0n);assert.equal(sdk.recoverAccount(a,source.profile,await snapshot(source)).balance,0n);
      for(const token of [A,B,C,W])for(const holder of [adapter.address,twin.address,router.address])assert.equal(await call(token,'balanceOf',[holder]),0n);
      for(const holder of [adapter.address,twin.address,router.address])assert.equal(await client.getBalance({address:holder}),0n);
      assert.equal(await call(A,'allowance',[adapter.address,router.address]),0n);assert.equal(await call(C,'allowance',[adapter.address,target.address]),0n);
      if(scenario.nativeOut)assert.equal(await call(W,'balanceOf',[actors.treasury.address]),20n);
      pass(label('B-final-proof-withdrawal-and-zero-private-reserves-allowances'),{withdrawal:'9980',privateReserves:'0',adapterAndRouterBalances:'0',allowances:'0'});
      report.scenarios.push({...scenario,feeBps:20,sourceProfile:source.profile,targetProfile:target.profile,route:wire(route),adapterRuntimeCodeHash:(await pin(adapter)).runtimeCodeHash,
        sourceReserve:'0',targetReserve:'0',BRecoveredAmount:'9980',BWithdrawnAmount:'9980',serviceFee:'20',gas:{estimate:String(estimate),paddedGas:String(paddedGas),actualGasUsed:String(swap.gasUsed),relayMaxGas:String(relayMaxGas),oldestWindowProof},passed:true});
    }
    for(const pool of allPools){const state=await snapshot(pool);assert.equal(state.reserve,'0');assert.equal(state.actualBalance,'0');}
    pass('all-four-production-private-pools-reconcile-to-zero-reserves');report.passed=true;
    return report;
  }catch(error){report.error={name:error.name,code:typeof error.code==='string'?error.code:null,message:String(error.shortMessage??error.message).slice(0,500)};throw error;}
  finally{
    await local.close();report.transactionCount=report.transactions.length;report.proofCount=report.proofs.length;
    const filename=path.join(root,REPORT);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,JSON.stringify(wire(report),null,2)+'\n',{mode:0o644});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const options=parseFinalFeeParameterAcceptanceArgs(process.argv.slice(2));
    if(!options.verify)console.log(JSON.stringify(finalFeeParameterAcceptancePlan(),null,2));
    else{const result=await runFinalFeeParameterAcceptance({onProgress:name=>console.log('Passed: '+name)});console.log(JSON.stringify({passed:result.passed,publicTransactions:0,checks:result.checks.length,proofs:result.proofs.length,transactions:result.transactions.length,report:REPORT}));}
    process.exit(0);
  }catch(error){console.error(error.code??error.shortMessage??error.message);process.exit(1);}
}
