#!/usr/bin/env node
// Positive acceptance of finalized parameters on a newly spawned, isolated chain.
// No RPC URL, wallet, keystore, mainnet profile or public-chain writer is accepted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createPublicClient,createWalletClient,http,encodeFunctionData,encodeDeployData,keccak256,ExecutionRevertedError} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import * as sdk from '../../src/phase2-mainnet/sdk.mjs';
import {syncPhase2State} from '../../src/phase2-asp/state.mjs';
import {loadVerifiedMainnetRelease} from '../../src/phase2-mainnet/release.mjs';
import {linkMainnetBytecode} from './deploy.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),ZERO=sdk.NATIVE_ASSET;
const REPORT='artifacts/phase2-mainnet/final-parameter-acceptance.json';
const wire=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
const need=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
export function parseFinalParameterAcceptanceArgs(args){
  need(Array.isArray(args)&&args.every(a=>['--plan','--verify'].includes(a))&&new Set(args).size===args.length&&args.length<=1,'FINAL_ACCEPTANCE_ARGUMENT_INVALID');
  return {verify:args[0]==='--verify'};
}
export function finalParameterAcceptancePlan(){
  return {schema:'phase2-final-parameter-acceptance-plan/v1',localOnly:true,chainId:4663,
    publicTransactions:0,usesLocalDeployer:false,usesPublicRPC:false,parameters:'final-production-only',
    checks:['cryptographic-release-and-reproducible-build','production-SDK-final-parameter-loading',
      'real-final-verifiers-deployed-to-isolated-Anvil','A-two-note-merge-and-private-payment-to-B',
      'B-encrypted-backup-recovery-and-private-respend','approved-public-withdrawal',
      'excluded-holder-exit-and-original-deposit-ragequit','tampered-proof-context-epoch-and-replay-rejected',
      'independent-guardian-suspension-and-delayed-provider-rotation'],
    report:REPORT};
}
// A transport outage or encoding error is not evidence of contract rejection.
export function isFinalAcceptanceExecutionRevert(error){
  return error instanceof ExecutionRevertedError
    ||typeof error?.walk==='function'&&error.walk(cause=>cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
}
async function isolatedChain(){
  const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  const rpcUrl=`http://127.0.0.1:${port}`;
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--hardfork','cancun','--accounts','0','--silent'],{stdio:'ignore'});
  let spawnError;child.on('error',error=>{spawnError=error;});
  const exit=new Promise(resolve=>child.once('exit',resolve));
  const client=createPublicClient({transport:http(rpcUrl,{retryCount:0,timeout:2000}),cacheTime:0,pollingInterval:50});
  async function close(){if(!spawnError&&child.exitCode===null&&!child.killed){child.kill('SIGTERM');await exit;}}
  try{
    let ready=false;
    for(let i=0;i<100;i++){
      if(spawnError)throw spawnError;
      need(child.exitCode===null,'FINAL_ACCEPTANCE_ANVIL_EXITED');
      try{ready=await client.getChainId()===4663;if(ready)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    need(ready,'FINAL_ACCEPTANCE_ANVIL_NOT_READY');
    need(/anvil/i.test(await client.request({method:'web3_clientVersion'})),'FINAL_ACCEPTANCE_ANVIL_REQUIRED');
    const info=await client.request({method:'anvil_nodeInfo'});
    need(!info.forkConfig?.forkUrl&&!info.forkConfig?.forkBlockNumber,'FINAL_ACCEPTANCE_FORK_FORBIDDEN');
    need(await client.getBlockNumber()===0n&&(await client.request({method:'eth_accounts'})).length===0&&child.exitCode===null,'FINAL_ACCEPTANCE_FRESH_CHAIN_REQUIRED');
    return {client,rpcUrl,close};
  }catch(error){await close();throw error;}
}

export async function runFinalParameterAcceptance({root=ROOT,onProgress=()=>{}}={}){
  root=await fs.realpath(root);
  // Fail before starting a node, creating EOAs or touching reports when final
  // parameters, contribution/beacon binding or compiler reproduction fail.
  const release=await loadVerifiedMainnetRelease({root});
  onProgress('final-release-cryptography-and-reproducible-bytecode-verified');
  const local=await isolatedChain(),{client,rpcUrl}=local;
  const report={schema:'phase2-final-parameter-acceptance/v1',runId:randomUUID(),localOnly:true,
    chainId:4663,publicTransactions:0,mainnetDeployed:false,productionReady:false,passed:false,
    artifactSHA256:release.artifactSHA256,production:release.production,
    checks:[],transactions:[],proofs:[],limitations:[
      'This is local acceptance with real final parameters, not public mainnet execution.',
      'It is not an independent audit, an anonymity measurement or authentication of participant identities.',
      'DEX, bridge and ERC20 integration are covered separately; this run accepts the final native-pool circuits.',
      'The local guardian is an independent synthetic EOA; the configured mainnet Safe is verified separately on its public chain.']};
  const pass=(name,detail)=>{report.checks.push({name,passed:true,...(detail?{detail:wire(detail)}:{})});onProgress(name);};
  const {artifacts}=release,abi=artifacts.Phase2ASPPool.abi,registryABI=artifacts.Phase2ASPRegistry.abi;
  const chain={id:4663,name:'isolated final-parameter acceptance',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}};
  const actors=Object.fromEntries(['deployer','provider','guardian','nextProvider','A','B','C','R'].map(name=>[name,privateKeyToAccount(generatePrivateKey())]));
  const accounts=Object.fromEntries(['A','B','C'].map(name=>[name,sdk.createAccount()]));
  let profile,currentSet=null;
  async function send(name,request,who='deployer'){
    assert.equal(await client.getChainId(),4663);
    const actor=actors[who],wallet=createWalletClient({account:actor,chain,transport:http(rpcUrl,{retryCount:0})});
    const gas=await client.estimateGas({...request,account:actor.address});
    const hash=await wallet.sendTransaction({...request,gas:gas*12n/10n+10000n,gasPrice:await client.getGasPrice(),type:'legacy'});
    const receipt=await client.waitForTransactionReceipt({hash,timeout:30000,pollingInterval:50});assert.equal(receipt.status,'success',name);
    report.transactions.push({name,hash,from:actor.address,to:receipt.to,contractAddress:receipt.contractAddress,
      blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),feeWei:String(receipt.gasUsed*receipt.effectiveGasPrice)});
    return receipt;
  }
  const libraries={};
  async function deploy(name,args=[]){
    const artifact=artifacts[name],receipt=await send('deploy-'+name,{data:encodeDeployData({abi:artifact.abi,bytecode:linkMainnetBytecode(artifact,libraries),args})});
    return {address:receipt.contractAddress,receipt};
  }
  const snapshot=()=>syncPhase2State({client,profile,artifacts,...(currentSet?{associationSet:currentSet}:{})});
  const recover=async who=>sdk.recoverAccount(accounts[who],profile,await snapshot());
  const ext=(out=0n,recipient=ZERO)=>({processor:actors.R.address,recipient,feeRecipient:ZERO,publicIn:0n,publicOut:out,fee:0n});
  const exitData=who=>({processor:actors.R.address,recipient:actors[who].address,feeRecipient:ZERO,fee:0n});
  async function publish(name,commitments){
    currentSet=sdk.buildAssociationSet({commitments,profile});
    await send(name,{to:profile.registry.address,data:encodeFunctionData({abi:registryABI,functionName:'updateRoot',args:[BigInt(currentSet.root),currentSet.digest,(await client.getBlock()).timestamp+3600n]})},'provider');
  }
  const transactCall=t=>encodeFunctionData({abi,functionName:'transact',args:[t.pA.map(BigInt),t.pB.map(row=>row.map(BigInt)),t.pC.map(BigInt),t.pubSignals.map(BigInt),
    {...t.extData,publicIn:BigInt(t.extData.publicIn),publicOut:BigInt(t.extData.publicOut),fee:BigInt(t.extData.fee)},t.encryptedOutputs]});
  const exitCall=(t,method='holderExit')=>encodeFunctionData({abi,functionName:method,args:[{...t.data,fee:BigInt(t.data.fee)},
    {pA:t.pA.map(BigInt),pB:t.pB.map(row=>row.map(BigInt)),pC:t.pC.map(BigInt),pubSignals:t.pubSignals.map(BigInt)}]});
  const simulate=data=>client.call({account:actors.R.address,to:profile.pool.address,data});
  const reject=async(name,call)=>{await assert.rejects(call,isFinalAcceptanceExecutionRevert);pass(name);};
  const registryInputs=registryABI.find(item=>item.type==='constructor').inputs.length;
  const accept=async(name,call)=>{await call();pass(name);};
  async function passGrace(){
    const grace=await client.readContract({address:profile.registry.address,abi:registryABI,functionName:'SUPERSEDED_POLICY_GRACE'});
    await client.request({method:'evm_increaseTime',params:[Number(grace)+1]});await client.request({method:'evm_mine',params:[]});
  }
  async function deposit(name,who,value){
    const receive=sdk.createDynamicReceive(accounts[who],profile);
    await send(name,{to:profile.pool.address,value,data:encodeFunctionData({abi,functionName:'depositDynamic',args:[value,receive.precommitment,receive.encryptedTemplate]})},who);
    const note=(await recover(who)).notes.find(note=>sdk.notePrecommitment(note,profile)===receive.precommitment&&note.value===value);assert.ok(note);return note;
  }
  async function proveNormal(who,outputs=[],externalData=ext(),inputs){
    const prepared=sdk.prepareJoinSplit({account:accounts[who],profile,state:await snapshot(),outputs,externalData,inputs});
    const result=await sdk.proveJoinSplit(prepared,{rootDirectory:root,profile});
    assert.equal(result.manifestSHA256,release.production.manifests.joinsplit.sha256);
    assert.equal(await client.readContract({address:profile.pool.address,abi,functionName:'hashContext',args:[prepared.extData,prepared.encryptedOutputs]}),BigInt(result.transaction.pubSignals[3]));
    assert.equal(await client.readContract({address:profile.verifier.address,abi:artifacts.Phase2ASPJoinSplitVerifier.abi,functionName:'verifyProof',args:[result.transaction.pA.map(BigInt),result.transaction.pB.map(row=>row.map(BigInt)),result.transaction.pC.map(BigInt),result.transaction.pubSignals.map(BigInt)]}),true);
    report.proofs.push({circuit:'joinsplit',manifestSHA256:result.manifestSHA256,offchainVerified:true,onchainVerified:true,inputNoteCount:prepared.inputNotes.length});
    return {prepared,transaction:result.transaction};
  }
  async function proveExit(who,note,method='holderExit'){
    const options={account:accounts[who],profile,state:await snapshot(),note,externalData:exitData(who)};
    const prepared=method==='ragequit'?sdk.prepareRagequit(options):sdk.prepareHolderExit(options);
    const result=await sdk.proveHolderExit(prepared,{rootDirectory:root,profile});
    assert.equal(result.manifestSHA256,release.production.manifests['holder-exit'].sha256);
    assert.equal(await client.readContract({address:profile.exitVerifier.address,abi:artifacts.Phase2ASPExitVerifier.abi,functionName:'verifyProof',args:[result.transaction.pA.map(BigInt),result.transaction.pB.map(row=>row.map(BigInt)),result.transaction.pC.map(BigInt),result.transaction.pubSignals.map(BigInt)]}),true);
    report.proofs.push({circuit:'holder-exit',manifestSHA256:result.manifestSHA256,offchainVerified:true,onchainVerified:true});return result.transaction;
  }
  try{
    // Current release acceptance must never silently downgrade to the old registry.
    need(registryInputs===2&&registryABI.some(item=>item.type==='function'&&item.name==='ACCEPTED_POLICY_WINDOW'),
      'FINAL_ACCEPTANCE_GUARDIAN_REGISTRY_REQUIRED');
    for(const actor of Object.values(actors))await client.request({method:'anvil_setBalance',params:[actor.address,'0x56bc75e2d63100000']});
    pass('independent-synthetic-EOAs-and-private-note-seeds');
    for(const name of ['PoseidonT3','PoseidonT4'])libraries[name]=(await deploy(name)).address;
    const verifier=await deploy('Phase2ASPJoinSplitVerifier'),exitVerifier=await deploy('Phase2ASPExitVerifier');
    const registry=await deploy('Phase2ASPRegistry',[actors.provider.address,actors.guardian.address]);
    assert.equal(await client.readContract({address:registry.address,abi:registryABI,functionName:'GUARDIAN'}),actors.guardian.address);
    assert.equal(await client.readContract({address:registry.address,abi:registryABI,functionName:'PROVIDER'}),actors.provider.address);
    assert.equal(await client.readContract({address:registry.address,abi:registryABI,functionName:'ACCEPTED_POLICY_WINDOW'}),16n);
    await reject('deployer-cannot-use-guardian-authority',()=>client.call({account:actors.deployer.address,to:registry.address,
      data:encodeFunctionData({abi:registryABI,functionName:'suspendProvider'})}));
    const pool=await deploy('Phase2ASPPool',[verifier.address,exitVerifier.address,registry.address,ZERO]);
    const pin=async item=>({address:item.address,runtimeCodeHash:keccak256(await client.getCode({address:item.address}))});
    profile={schema:sdk.PRODUCTION_PROFILE_SCHEMA,releaseCandidate:true,testOnly:false,productionReady:false,
      chain:{id:4663,rpcUrl},genesisHash:(await client.getBlock({blockNumber:0n})).hash,
      artifactSHA256:release.artifactSHA256,sourceSetSHA256:release.sourceSetSHA256,production:release.production,relayer:actors.R.address,
      pool:{...await pin(pool),asset:ZERO,noteModel:sdk.NOTE_MODEL,treeDepth:20,startBlock:String(pool.receipt.blockNumber)},
      verifier:await pin(verifier),exitVerifier:await pin(exitVerifier),registry:{...await pin(registry),provider:actors.provider.address,
        guardian:actors.guardian.address,startBlock:String(registry.receipt.blockNumber)}};
    profile.pool.scope=String(sdk.normalizeProfile(profile).scope);report.profile=profile;
    const loaded=await sdk.loadProductionRelease({rootDirectory:root,profile});assert.equal(loaded.artifactSHA256,release.artifactSHA256);
    pass('production-loader-accepts-actual-final-parameters-and-recompiled-build');
    const a3=await deposit('A-public-deposit-3','A',3n),a4=await deposit('A-public-deposit-4','A',4n),c5=await deposit('C-public-unapproved-deposit-5','C',5n);
    pass('public-deposits-and-canonical-note-recovery');
    assert.equal((await snapshot()).asp.epoch,'0');
    await assert.rejects(()=>proveNormal('A',[{receiver:sdk.receiverAddress(accounts.B,profile),value:6n}]),{message:'Integer outside allowed range.'});
    pass('normal-spending-fails-without-ASP');
    await publish('approve-A-notes',[a3.commitment,a4.commitment]);
    const originalRefund=await proveExit('A',a3,'ragequit'),oldPayment=await proveNormal('A',[{receiver:sdk.receiverAddress(accounts.B,profile),value:6n}]);
    assert.equal(oldPayment.prepared.inputNotes.length,2);
    await publish('advance-ASP-epoch',[a3.commitment,a4.commitment]);
    await accept('superseded-epoch-proof-accepted-within-grace',()=>simulate(transactCall(oldPayment.transaction)));
    for(let i=0;i<14;i++)await publish('advance-to-policy-window-boundary-'+i,[a3.commitment,a4.commitment]);
    const oldestGas=await client.estimateGas({account:actors.R.address,to:profile.pool.address,data:transactCall(oldPayment.transaction)});
    const oldestPaddedGas=oldestGas*12n/10n+10000n;
    assert.ok(oldestPaddedGas<=5000000n,'oldest accepted epoch with relay padding must fit the mainnet cap');
    pass('oldest-of-sixteen-epochs-accepts-real-proof-under-relay-gas-cap',{
      gasEstimate:String(oldestGas),paddedGas:String(oldestPaddedGas),relayGasCap:'5000000'});
    const gracePayment=await proveNormal('A',[{receiver:sdk.receiverAddress(accounts.B,profile),value:6n}]);
    await publish('evict-oldest-epoch',[a3.commitment,a4.commitment]);
    await reject('seventeenth-policy-evicts-original-proof-within-time-grace',()=>simulate(transactCall(oldPayment.transaction)));
    await accept('recent-proof-remains-valid-before-time-grace',()=>simulate(transactCall(gracePayment.transaction)));
    await passGrace();await publish('refresh-ASP-after-grace',[a3.commitment,a4.commitment]);
    await reject('superseded-epoch-proof-rejected-after-grace',()=>simulate(transactCall(gracePayment.transaction)));
    const payment=await proveNormal('A',[{receiver:sdk.receiverAddress(accounts.B,profile),value:6n}]);
    for(const [name,mutate]of [['proof',t=>t.pA[0]=String(BigInt(t.pA[0])+1n)],['recipient',t=>t.extData.recipient=actors.C.address],
      ['processor',t=>t.extData.processor=actors.C.address],['ciphertext',t=>t.encryptedOutputs[0]='0x'+'00'.repeat(256)],['scope',t=>t.pubSignals[4]=String(BigInt(t.pubSignals[4])+1n)]]){
      const changed=structuredClone(payment.transaction);mutate(changed);await reject('reject-joinsplit-'+name+'-mutation',()=>simulate(transactCall(changed)));
    }
    await send('A-merge-two-notes-private-payment-to-B',{to:profile.pool.address,data:transactCall(payment.transaction)},'R');
    pass('two-note-merge-private-payment-with-real-final-joinsplit-proof');
    await reject('private-payment-proof-replay-rejected',()=>simulate(transactCall(payment.transaction)));
    await reject('spent-original-note-ragequit-rejected',()=>simulate(exitCall(originalRefund,'ragequit')));
    const password=randomBytes(32).toString('hex'),backup=sdk.sealAccount(accounts.B,password);
    accounts.B=sdk.openAccount(backup,password);assert.equal(accounts.B.notes.length,0);
    let b=await recover('B');assert.equal(b.balance,6n);assert.equal((await recover('A')).balance,1n);
    assert.ok(b.notes.every(note=>!Object.hasOwn(note,'originalDepositor')&&!Object.hasOwn(note,'label')));
    pass('B-encrypted-backup-only-recovery-without-input-note-identifiers');
    await publish('approve-B-recovered-note',[b.notes[0].commitment]);
    const bPayment=await proveNormal('B',[{receiver:sdk.receiverAddress(accounts.A,profile),value:2n}]);
    await send('B-restored-private-respend',{to:profile.pool.address,data:transactCall(bPayment.transaction)},'R');
    b=await recover('B');assert.equal(b.balance,4n);pass('B-recovered-note-private-respend');
    await publish('approve-B-change',[b.notes[0].commitment]);
    const withdrawal=await proveNormal('B',[],ext(1n,actors.B.address)),before=await client.getBalance({address:actors.B.address});
    await send('B-approved-public-withdrawal',{to:profile.pool.address,data:transactCall(withdrawal.transaction)},'R');
    assert.equal(await client.getBalance({address:actors.B.address}),before+1n);pass('approved-public-withdrawal-exact-payout');
    b=await recover('B');assert.equal(b.balance,3n);
    await publish('approve-B-final-change',[b.notes[0].commitment]);
    const pending=await proveNormal('B',[],ext(1n,actors.B.address));
    await publish('exclude-all-current-notes',[]);
    // An exclusion alone leaves the superseded epoch usable for the grace period;
    // the guardian's emergency suspension revokes it immediately.
    await accept('excluded-note-proof-accepted-within-grace',()=>simulate(transactCall(pending.transaction)));
    const guardianCall=functionName=>send('guardian-'+functionName,{to:profile.registry.address,data:encodeFunctionData({abi:registryABI,functionName})},'guardian');
    await guardianCall('suspendProvider');
    await reject('revoked-current-note-normal-proof-rejected',()=>simulate(transactCall(pending.transaction)));
    await guardianCall('resumeProvider');
    await reject('suspension-revocation-survives-resume',()=>simulate(transactCall(pending.transaction)));
    const bExit=await proveExit('B',b.notes[0]);
    for(const [name,mutate]of [['proof',t=>t.pA[0]=String(BigInt(t.pA[0])+1n)],['recipient',t=>t.data.recipient=actors.C.address],
      ['value',t=>t.pubSignals[2]=String(BigInt(t.pubSignals[2])+1n)],['context',t=>t.pubSignals[4]=String(BigInt(t.pubSignals[4])+1n)]]){
      const changed=structuredClone(bExit);mutate(changed);await reject('reject-holder-exit-'+name+'-mutation',()=>simulate(exitCall(changed)));
    }
    await reject('received-private-output-cannot-ragequit',()=>simulate(exitCall(bExit,'ragequit')));
    const balanceBefore=await client.getBalance({address:actors.B.address});
    await send('B-excluded-holder-exit',{to:profile.pool.address,data:exitCall(bExit)},'R');
    assert.equal(await client.getBalance({address:actors.B.address}),balanceBefore+3n);pass('excluded-holder-exit-with-real-final-exit-proof');
    await reject('holder-exit-proof-replay-rejected',()=>simulate(exitCall(bExit)));
    const cExit=await proveExit('C',c5,'ragequit'),cBefore=await client.getBalance({address:actors.C.address});
    await send('C-original-depositor-ragequit',{to:profile.pool.address,data:exitCall(cExit,'ragequit')},'R');
    assert.equal(await client.getBalance({address:actors.C.address}),cBefore+5n);pass('excluded-original-depositor-full-refund');
    for(const note of (await recover('A')).notes){
      const tx=await proveExit('A',note);await send('A-holder-exit-'+note.value,{to:profile.pool.address,data:exitCall(tx)},'R');
    }
    const state=await snapshot();assert.equal(state.reserve,'0');assert.equal(state.actualBalance,'0');
    for(const who of ['A','B','C'])assert.equal(sdk.recoverAccount(accounts[who],profile,state).balance,0n);
    pass('all-private-wallet-balances-and-native-pool-reserve-zero');
    await send('guardian-propose-provider',{to:profile.registry.address,
      data:encodeFunctionData({abi:registryABI,functionName:'proposeProvider',args:[actors.nextProvider.address]})},'guardian');
    const claim=encodeFunctionData({abi:registryABI,functionName:'acceptProvider'});
    await reject('new-provider-cannot-claim-before-delay',()=>client.call({account:actors.nextProvider.address,to:profile.registry.address,data:claim}));
    const delay=await client.readContract({address:profile.registry.address,abi:registryABI,functionName:'PROVIDER_ROTATION_DELAY'});
    await client.request({method:'evm_increaseTime',params:[Number(delay)+1]});await client.request({method:'evm_mine',params:[]});
    await send('new-provider-accept-after-delay',{to:profile.registry.address,data:claim},'nextProvider');
    const update=encodeFunctionData({abi:registryABI,functionName:'updateRoot',args:[1n,currentSet.digest,(await client.getBlock()).timestamp+3600n]});
    await reject('rotated-out-provider-cannot-publish',()=>client.call({account:actors.provider.address,to:profile.registry.address,data:update}));
    await send('new-provider-publish',{to:profile.registry.address,data:update},'nextProvider');
    assert.equal(await client.readContract({address:profile.registry.address,abi:registryABI,functionName:'PROVIDER'}),actors.nextProvider.address);
    pass('independent-guardian-delayed-provider-rotation');
    assert.deepEqual([...new Set(report.proofs.map(p=>p.circuit))].sort(),['holder-exit','joinsplit']);
    report.finalReserve='0';report.finalBalance='0';report.passed=true;
    return report;
  }catch(error){report.error={name:error.name,message:String(error.code??error.message).slice(0,500)};throw error;}
  finally{
    await local.close();
    const filename=path.join(root,REPORT);await fs.mkdir(path.dirname(filename),{recursive:true});
    await fs.writeFile(filename,JSON.stringify(wire(report),null,2)+'\n',{mode:0o644});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options=parseFinalParameterAcceptanceArgs(process.argv.slice(2));
    if(!options.verify)console.log(JSON.stringify(finalParameterAcceptancePlan(),null,2));
    else{
      const result=await runFinalParameterAcceptance({onProgress:name=>console.log('Passed: '+name)});
      console.log(JSON.stringify({passed:result.passed,localOnly:true,publicTransactions:0,checks:result.checks.length,proofs:result.proofs.length,transactions:result.transactions.length,report:REPORT}));
    }
    process.exit(0);
  }catch(error){console.error(error.code??error.message);process.exit(1);}
}
