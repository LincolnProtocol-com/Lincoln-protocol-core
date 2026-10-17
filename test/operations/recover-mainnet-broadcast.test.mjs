// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getContractAddress,keccak256,parseTransaction} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openServiceStore} from '../../releases/rc2/src/phase1-service/store.mjs';
import {mainnetSignerDirectory} from '../../releases/rc2/src/phase2-mainnet/signer.mjs';
import {recoverMainnetBroadcast} from '../../scripts/operations/recover-mainnet-broadcast.mjs';
import {PARENT_PLAN_ID,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST} from '../../scripts/operations/mainnet-rc3.mjs';

const GENESIS='0x'+'11'.repeat(32),BLOCK='0x'+'22'.repeat(32),PLAN=PARENT_PLAN_ID,NEW_PLAN='cd'.repeat(32);
const rc3ManifestBytes=await fs.readFile(new URL('../../releases/rc3/'+RC3_RELEASE_MANIFEST,import.meta.url));
const rc3ArtifactSHA256=JSON.parse(rc3ManifestBytes).coreArtifactSHA256;
const notFound=name=>Object.assign(new Error('Not found.'),{name});
async function fixture({continuation=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-recovery-orchestration-')));
  const snapshot=path.join(root,'snapshot'),account=privateKeyToAccount(generatePrivateKey()),address=account.address;
  const rawTransaction=await account.signTransaction({chainId:4663,type:'legacy',nonce:0,gas:50000n,gasPrice:2n,value:0n,data:'0x60006000f3'});
  const planId=continuation?NEW_PLAN:PLAN;
  const hash=keccak256(rawTransaction),entry={id:`deploy:${planId}:PoseidonT3`,chainId:4663,to:null,data:'0x60006000f3',value:'0',nonce:'0',gas:'50000',
    gasPrice:'2',feeCeilingWei:'100000',status:'unknown',rawTransaction,hash};
  entry.intentDigest=createHash('sha256').update(JSON.stringify({to:entry.to,data:entry.data,value:entry.value})).digest('hex');
  const limits={budgetWei:'1000000',maxFeePerGasWei:'4',reserveWei:'0'};
  const signerDirectory=mainnetSignerDirectory({root:snapshot,address});
  const ledger={schema:'phase2-mainnet-signer/v1',chainId:4663,address,genesisHash:GENESIS,...limits,entries:[entry]};
  const deploymentRoot=continuation?path.join(root,'rc3-snapshot'):snapshot;
  const deploymentDirectory=path.join(deploymentRoot,'.phase1-private/phase2-mainnet/deployments',planId);
  const journal={schema:'phase2-mainnet-deployment/v1',pins:{planId,deployer:address,genesisHash:GENESIS,...limits,
      ...(continuation?{artifactSHA256:rc3ArtifactSHA256,signerDirectory}:{})},
    steps:[{id:'PoseidonT3',reservationId:entry.id,deployer:address,data:entry.data,nonce:'0',address:getContractAddress({from:address,nonce:0n}),status:'prepared'}],status:'deploying'};
  async function write(directory,identity,filename,value){
    const store=await openServiceStore({directory,identity,filename});try{await store.write(value);}finally{await store.close();}
  }
  async function read(directory,identity,filename){
    const store=await openServiceStore({directory,identity,filename});try{return await store.read();}finally{await store.close();}
  }
  const signerIdentity=`lincoln-mainnet-signer:4663:${address.toLowerCase()}`,deploymentIdentity=`lincoln-mainnet-deployment:${planId}`;
  await write(signerDirectory,signerIdentity,'signer.json',ledger);await write(deploymentDirectory,deploymentIdentity,'deployment.json',journal);
  const continuationSnapshot={directory:deploymentRoot,sharedSignerDirectory:signerDirectory,limits:{...limits}};
  if(continuation){
    await fs.mkdir(path.join(deploymentRoot,'config'),{recursive:true});
    await fs.writeFile(path.join(deploymentRoot,'config/phase2-mainnet.json'),JSON.stringify({chain:{id:4663},deployer:{address}}));
    const releaseFile=path.join(root,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST);await fs.mkdir(path.dirname(releaseFile),{recursive:true});await fs.writeFile(releaseFile,rc3ManifestBytes);
  }
  const state={latest:0,pending:0,balance:10000000n,known:null,receipt:null,sendError:null,sendResult:hash};
  const calls={requests:[],receipt:0,transaction:0,continuation:0};
  const client={
    async getChainId(){return 4663;},
    async getBlock({blockNumber}){return {hash:blockNumber===0n?GENESIS:BLOCK};},
    async getTransactionReceipt({hash:requested}){calls.receipt++;assert.equal(requested,hash);if(!state.receipt)throw notFound('TransactionReceiptNotFoundError');return state.receipt;},
    async getTransaction({hash:requested}){calls.transaction++;assert.equal(requested,hash);if(!state.known)throw notFound('TransactionNotFoundError');return state.known;},
    async getTransactionCount({blockTag}){return blockTag==='pending'?state.pending:state.latest;},
    async getBalance(){return state.balance;},
    async request(request){calls.requests.push(structuredClone(request));if(state.sendError)throw state.sendError;return state.sendResult;},
  };
  const options={root,hash,client,validateSnapshot:async({root:received})=>{assert.equal(received,root);return {directory:snapshot,address};}};
  if(continuation)options.validateContinuationSnapshot=async({root:received})=>{assert.equal(received,root);calls.continuation++;return continuationSnapshot;};
  return {options,state,calls,ledger,journal,hash,rawTransaction,address,continuationSnapshot,deploymentRoot,signerDirectory,
    readLedger:()=>read(signerDirectory,signerIdentity,'signer.json'),
    writeLedger:()=>write(signerDirectory,signerIdentity,'signer.json',ledger),
    writeJournal:()=>write(deploymentDirectory,deploymentIdentity,'deployment.json',journal),
    writeLegacyDecoy:()=>write(path.join(snapshot,'.phase1-private/phase2-mainnet/deployments',planId),deploymentIdentity,'deployment.json',journal),
    cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
test('read-only recovery status never sends and keeps the original unknown reservation',async()=>{
  const f=await fixture();try{
    const result=await recoverMainnetBroadcast(f.options);
    assert.equal(result.status,'not-found-at-node');assert.equal(result.rebroadcast,false);assert.equal(result.transactionsSigned,0);
    assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'unknown');
    assert.equal(JSON.stringify(result).includes(f.rawTransaction),false);assert.equal(Object.hasOwn(result,'data'),false);
  }finally{await f.cleanup();}
});
test('one explicit rebroadcast submits exactly the original bytes once without signing or changing nonce',async()=>{
  const f=await fixture();try{
    const result=await recoverMainnetBroadcast({...f.options,rebroadcast:true});
    assert.equal(result.status,'submitted');assert.equal(result.rebroadcast,true);assert.equal(result.transactionsSigned,0);
    assert.deepEqual(f.calls.requests,[{method:'eth_sendRawTransaction',params:[f.rawTransaction]}]);
    const entry=(await f.readLedger()).entries[0];assert.equal(entry.status,'submitted');assert.equal(entry.hash,f.hash);
    assert.equal(entry.nonce,'0');assert.equal(entry.rawTransaction,f.rawTransaction);
  }finally{await f.cleanup();}
});
test('a known pending original hash is never rebroadcast even with the explicit flag',async()=>{
  const f=await fixture();try{
    f.state.known={hash:f.hash,blockNumber:null};
    const result=await recoverMainnetBroadcast({...f.options,rebroadcast:true});
    assert.equal(result.status,'pending');assert.equal(result.rebroadcast,false);assert.equal(f.calls.requests.length,0);
  }finally{await f.cleanup();}
});
test('changed or externally pending nonce prevents sending the original bytes',async()=>{
  for(const [latest,pending]of [[1,1],[0,1]]){
    const f=await fixture();try{
      Object.assign(f.state,{latest,pending});
      await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'RECOVERY_NONCE_CHANGED'});
      assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'unknown');
    }finally{await f.cleanup();}
  }
});
test('RPC rejection retains unknown plus the original hash and provides only a sanitized diagnostic',async()=>{
  const f=await fixture();try{
    const sensitive='do-not-output-this-password';
    f.state.sendError=Object.assign(new Error('RPC request failed.'),{shortMessage:'An unknown RPC error occurred.',code:'RPC_ERROR',
      cause:Object.assign(new Error(`nonce too low password=${sensitive}; tx ${f.rawTransaction}\nRequest body: ${f.rawTransaction}`),{code:-32000}),body:f.rawTransaction});
    const result=await recoverMainnetBroadcast({...f.options,rebroadcast:true}),encoded=JSON.stringify(result);
    assert.equal(result.error,'MAINNET_REBROADCAST_UNKNOWN');assert.equal(result.transactionHash,f.hash);assert.equal(result.automaticResend,false);
    assert.equal(result.rpc.code,-32000);assert.match(result.rpc.shortMessage,/nonce too low/);
    for(const hidden of [f.rawTransaction,sensitive,'Request body'])assert.equal(encoded.includes(hidden),false);
    assert.equal(f.calls.requests.length,1);const entry=(await f.readLedger()).entries[0];assert.equal(entry.status,'unknown');assert.equal(entry.hash,f.hash);assert.equal(entry.rawTransaction,f.rawTransaction);
  }finally{await f.cleanup();}
});
test('mismatching deployment journal cannot authorize rebroadcast of a signer entry',async()=>{
  const f=await fixture();try{
    f.journal.steps[0].data='0x60016000f3';await f.writeJournal();
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'RECOVERY_JOURNAL_MISMATCH'});
    assert.equal(f.calls.requests.length,0);
  }finally{await f.cleanup();}
});
test('a canonical confirmed original transaction reconciles its actual fee and returns without sending',async()=>{
  const f=await fixture();try{
    const transaction=parseTransaction(f.rawTransaction),contractAddress=getContractAddress({from:f.address,nonce:0n});
    f.state.known={...transaction,from:f.address,to:null,nonce:0,input:f.ledger.entries[0].data,value:0n,blockNumber:1n};
    f.state.receipt={transactionHash:f.hash,from:f.address,to:null,status:'success',gasUsed:21000n,effectiveGasPrice:2n,blockNumber:1n,blockHash:BLOCK,contractAddress};
    f.state.latest=1;f.state.pending=1;
    const result=await recoverMainnetBroadcast({...f.options,rebroadcast:true});
    assert.equal(result.status,'confirmed');assert.equal(result.feeWei,'42000');assert.equal(result.contractAddress,contractAddress);
    assert.equal(result.rebroadcast,false);assert.equal(f.calls.requests.length,0);
    const entry=(await f.readLedger()).entries[0];assert.equal(entry.status,'confirmed');assert.equal(entry.feeWei,'42000');
  }finally{await f.cleanup();}
});
test('a receipt in a noncanonical block cannot release the reservation or cause a new send',async()=>{
  const f=await fixture();try{
    const transaction=parseTransaction(f.rawTransaction);
    f.state.known={...transaction,from:f.address,to:null,nonce:0,input:f.ledger.entries[0].data,value:0n};
    f.state.receipt={transactionHash:f.hash,from:f.address,status:'success',gasUsed:21000n,effectiveGasPrice:2n,blockNumber:1n,blockHash:GENESIS,contractAddress:null};
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'MAINNET_RECEIPT_REORG'});
    assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'unknown');
  }finally{await f.cleanup();}
});
test('historical confirmation without a currently available receipt fails closed and never sends',async()=>{
  const f=await fixture();try{
    Object.assign(f.ledger.entries[0],{status:'confirmed',feeWei:'42000',gasUsed:'21000',effectiveGasPrice:'2',
      blockNumber:'1',blockHash:BLOCK,contractAddress:getContractAddress({from:f.address,nonce:0n})});
    await f.writeLedger();
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'RECOVERY_CONFIRMED_RECEIPT_UNAVAILABLE'});
    assert.equal(f.calls.requests.length,0);assert.equal(f.calls.receipt,2);
    assert.equal((await f.readLedger()).entries[0].status,'confirmed');
  }finally{await f.cleanup();}
});
test('a new RC.3 journal is checked in its own snapshot while status reads the original physical signer ledger',async()=>{
  const f=await fixture({continuation:true});try{
    const result=await recoverMainnetBroadcast(f.options);
    assert.equal(result.status,'not-found-at-node');assert.equal(result.rebroadcast,false);assert.equal(f.calls.continuation,1);
    assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].hash,f.hash);
    assert.equal(await fs.stat(path.join(f.deploymentRoot,'.phase1-private/phase2-mainnet/signers')).catch(error=>error.code),'ENOENT');
  }finally{await f.cleanup();}
});
test('explicit RC.3 recovery sends the same raw bytes exactly once and updates only the original account ledger',async()=>{
  const f=await fixture({continuation:true});try{
    const result=await recoverMainnetBroadcast({...f.options,rebroadcast:true});
    assert.equal(result.status,'submitted');assert.equal(result.transactionsSigned,0);assert.equal(f.calls.continuation,1);
    assert.deepEqual(f.calls.requests,[{method:'eth_sendRawTransaction',params:[f.rawTransaction]}]);
    const entry=(await f.readLedger()).entries[0];assert.equal(entry.status,'submitted');assert.equal(entry.hash,f.hash);assert.equal(entry.nonce,'0');
    assert.equal(await fs.stat(path.join(f.deploymentRoot,'.phase1-private/phase2-mainnet/signers')).catch(error=>error.code),'ENOENT');
  }finally{await f.cleanup();}
});
test('RC.3 continuation cannot substitute another shared directory, account or any original budget limit',async()=>{
  const mutations=[
    [f=>f.continuationSnapshot.sharedSignerDirectory=f.deploymentRoot,'RECOVERY_CONTINUATION_SIGNER_MISMATCH'],
    [async f=>fs.writeFile(path.join(f.deploymentRoot,'config/phase2-mainnet.json'),JSON.stringify({chain:{id:4663},deployer:{address:privateKeyToAccount(generatePrivateKey()).address}})),
      'RECOVERY_CONTINUATION_ADDRESS_MISMATCH'],
    ...['budgetWei','maxFeePerGasWei','reserveWei'].map(key=>[f=>f.continuationSnapshot.limits[key]='9999','RECOVERY_CONTINUATION_LIMITS_MISMATCH'])];
  for(const [mutate,code]of mutations){
    const f=await fixture({continuation:true});try{
      await mutate(f);await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code});
      assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'unknown');
    }finally{await f.cleanup();}
  }
});
test('RC.3 recovery requires the matching new plan, pinned artifact and journal signer locator',async()=>{
  for(const [mutate,code]of [
    [f=>f.journal.pins.planId=PLAN,'RECOVERY_JOURNAL_MISMATCH'],
    [f=>f.journal.pins.artifactSHA256='ff'.repeat(32),'RECOVERY_CONTINUATION_JOURNAL_MISMATCH'],
    [f=>f.journal.pins.signerDirectory=f.deploymentRoot,'RECOVERY_CONTINUATION_JOURNAL_MISMATCH']]){
    const f=await fixture({continuation:true});try{
      mutate(f);await f.writeJournal();await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code});
      assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'unknown');
    }finally{await f.cleanup();}
  }
});
test('a new-plan journal placed in the RC.2 tree cannot bypass the RC.3 snapshot checker',async()=>{
  const f=await fixture({continuation:true});try{
    await f.writeLegacyDecoy();let checked=0;
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true,validateContinuationSnapshot:async()=>{
      checked++;throw Object.assign(new Error('RC3_SNAPSHOT_FILE_MISMATCH'),{code:'RC3_SNAPSHOT_FILE_MISMATCH'});
    }}),{code:'RC3_SNAPSHOT_FILE_MISMATCH'});
    assert.equal(checked,1);assert.equal(f.calls.requests.length,0);assert.equal(f.calls.receipt,0);
  }finally{await f.cleanup();}
});
test('RC.3 manifest drift cannot change the artifact hash accepted by recovery',async()=>{
  const f=await fixture({continuation:true});try{
    const manifest=JSON.parse(rc3ManifestBytes);manifest.coreArtifactSHA256='ff'.repeat(32);
    await fs.writeFile(path.join(f.options.root,RC3_RELEASE_DIRECTORY,RC3_RELEASE_MANIFEST),JSON.stringify(manifest));
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'RECOVERY_CONTINUATION_RELEASE_MISMATCH'});
    assert.equal(f.calls.requests.length,0);assert.equal(f.calls.receipt,0);
  }finally{await f.cleanup();}
});
test('a freshly confirmed RC.3 transaction still cannot bypass the new journal artifact binding',async()=>{
  const f=await fixture({continuation:true});try{
    const transaction=parseTransaction(f.rawTransaction);
    f.state.known={...transaction,from:f.address,to:null,nonce:0,input:f.ledger.entries[0].data,value:0n,blockNumber:1n};
    f.state.receipt={transactionHash:f.hash,from:f.address,to:null,status:'success',gasUsed:21000n,effectiveGasPrice:2n,
      blockNumber:1n,blockHash:BLOCK,contractAddress:getContractAddress({from:f.address,nonce:0n})};
    f.journal.pins.artifactSHA256='ff'.repeat(32);await f.writeJournal();
    await assert.rejects(()=>recoverMainnetBroadcast({...f.options,rebroadcast:true}),{code:'RECOVERY_CONTINUATION_JOURNAL_MISMATCH'});
    assert.equal(f.calls.requests.length,0);assert.equal((await f.readLedger()).entries[0].status,'confirmed');
  }finally{await f.cleanup();}
});
