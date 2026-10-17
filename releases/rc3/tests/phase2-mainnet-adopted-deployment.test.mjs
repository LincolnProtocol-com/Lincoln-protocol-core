// SPDX-License-Identifier: Apache-2.0
// Mock chain orchestration only. No public RPC, keystore or real broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeAbiParameters,encodeAbiParameters,encodeDeployData,getContractAddress,keccak256,parseAbi,parseTransaction,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openServiceStore} from '../src/phase1-service/store.mjs';
import {createMainnetSigner,mainnetSignerDirectory} from '../src/phase2-mainnet/signer.mjs';
import {CAP_INCREASE_DELAY_SECONDS} from '../src/phase2-mainnet/caps.mjs';
import {runMainnetDeployment,normalizeAdoptedDeployments,readMainnetDeploymentContinuation,requireExistingMainnetSignerDirectory} from '../scripts/phase2-mainnet/deploy.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url)));
const GENESIS='0x'+'11'.repeat(32),BLOCK='0x'+'22'.repeat(32),OLD_PLAN='ab'.repeat(32);
const names=['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry','Phase2ASPPool'];
const limits={budgetWei:'80000000',maxFeePerGasWei:'4',reserveWei:'0'};
const missing=name=>Object.assign(new Error('Missing mock transaction'),{name});
const scope=address=>BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'}],
  [keccak256(toHex('CHENG_PHASE2_ASP_V1')),4663n,address])))%21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function artifacts(){return Object.fromEntries(names.map((name,i)=>[name,{source:name.startsWith('Poseidon')?`node_modules/poseidon-solidity/${name}.sol`:`mock/${name}.sol`,
  abi:name==='Phase2ASPRegistry'?parseAbi(['constructor(address provider,address guardian)']):name==='Phase2ASPPool'?parseAbi([
    'constructor(address verifier,address exitVerifier,address registry,address asset,uint128 maxDeposit,uint128 maxTotal)',
    'event CapsUpdated(uint128 maxDeposit,uint128 maxTotal)']):[],
  bytecode:'0x60'+(16+i).toString(16)+'6000f3',deployedBytecode:name.startsWith('Poseidon')?'0x73'+'00'.repeat(20)+'6000':'0x60'+(32+i).toString(16)+'6000',
  linkReferences:{},deployedLinkReferences:{},immutableReferences:{}}]));}
async function fixture(){
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-adopted-deploy-'))),root=path.join(parent,'rc3'),oldRoot=path.join(parent,'old-rc2');
  await fs.mkdir(root);const account=privateKeyToAccount(generatePrivateKey()),config=structuredClone(base),build=artifacts();
  config.deployer.address=account.address;config.guardian={address:privateKeyToAccount(generatePrivateKey()).address};
  const token=config.assets.find(asset=>asset.symbol==='USDG'),tokenCode='0x600660005260206000f3';
  config.codePins=config.codePins.map(pin=>pin.role==='usdg'?{...pin,runtimeCodeHash:keccak256(tokenCode)}:pin);
  const signerDirectory=mainnetSignerDirectory({root:oldRoot,address:account.address});
  const records=new Map(),deployed=new Map(),overrides=new Map(),calls={send:0,sign:0},state={nonce:1,balance:1000000000n};
  function register({hash,data,nonce,gas=7000000n,gasPrice=2n,gasUsed=21000n,name}){
    name??=names.find(name=>data.startsWith(build[name].bytecode));assert.ok(name,'recognized mock CREATE');
    const address=getContractAddress({from:account.address,nonce:BigInt(nonce)});
    const runtime=build[name].deployedBytecode.startsWith('0x73')?'0x73'+address.slice(2).toLowerCase()+build[name].deployedBytecode.slice(44):build[name].deployedBytecode;
    const suffix='0x'+data.slice(build[name].bytecode.length),args=name==='Phase2ASPPool'?decodeAbiParameters(build[name].abi[0].inputs,suffix):null;
    const logs=args?[{address,removed:false,topics:[keccak256(toHex('CapsUpdated(uint128,uint128)'))],data:encodeAbiParameters([{type:'uint128'},{type:'uint128'}],[args[4],args[5]])}]:[];
    records.set(hash,{transaction:{hash,chainId:4663,from:account.address,to:null,nonce,value:0n,input:data,gas,gasPrice,blockNumber:1n},
      receipt:{transactionHash:hash,from:account.address,to:null,status:'success',gasUsed,effectiveGasPrice:gasPrice,blockNumber:1n,blockHash:BLOCK,contractAddress:address,logs}});
    deployed.set(address.toLowerCase(),{name,runtime,args});return address;
  }
  const data=encodeDeployData({abi:build.PoseidonT3.abi,bytecode:build.PoseidonT3.bytecode,args:[]});
  const raw=await account.signTransaction({chainId:4663,type:'legacy',nonce:0,gas:7000000n,gasPrice:2n,value:0n,data});
  const hash=keccak256(raw),address=register({hash,data,nonce:0,name:'PoseidonT3'});
  const entry={id:`deploy:${OLD_PLAN}:PoseidonT3`,chainId:4663,to:null,data,value:'0',nonce:'0',gas:'7000000',gasPrice:'2',feeCeilingWei:'14000000',
    rawTransaction:raw,hash,status:'confirmed',feeWei:'42000',gasUsed:'21000',effectiveGasPrice:'2',blockNumber:'1',blockHash:BLOCK,contractAddress:address};
  entry.intentDigest=createHash('sha256').update(JSON.stringify({to:entry.to,data:entry.data,value:entry.value})).digest('hex');
  const ledger={schema:'phase2-mainnet-signer/v1',chainId:4663,address:account.address,genesisHash:GENESIS,...limits,entries:[entry]};
  const identity=`lincoln-mainnet-signer:4663:${account.address.toLowerCase()}`;
  async function writeLedger(){const store=await openServiceStore({directory:signerDirectory,identity,filename:'signer.json'});try{await store.write(ledger);}finally{await store.close();}}
  await writeLedger();
  const client={async getChainId(){return 4663;},async getBlock({blockNumber}){return {hash:blockNumber===0n?GENESIS:BLOCK};},
    async getTransactionReceipt({hash}){if(!records.has(hash))throw missing('TransactionReceiptNotFoundError');return records.get(hash).receipt;},
    async getTransaction({hash}){if(!records.has(hash))throw missing('TransactionNotFoundError');return records.get(hash).transaction;},
    async waitForTransactionReceipt({hash}){return client.getTransactionReceipt({hash});},
    async getTransactionCount(){return state.nonce;},async getBalance(){return state.balance;},async getGasPrice(){return 2n;},async estimateGas(){return 21000n;},
    async getCode({address}){return overrides.get(address.toLowerCase())??(address.toLowerCase()===token.address.toLowerCase()?tokenCode:deployed.get(address.toLowerCase())?.runtime??'0x');},
    async readContract({address,functionName}){
      if(address.toLowerCase()===token.address.toLowerCase()&&functionName==='decimals')return 6;
      const item=deployed.get(address.toLowerCase());
      if(item?.name==='Phase2ASPRegistry'&&functionName==='GUARDIAN')return config.guardian.address;
      if(item?.name==='Phase2ASPPool'){
        const values={ASSET:item.args[3],VERIFIER:item.args[0],HOLDER_EXIT_VERIFIER:item.args[1],ASP_REGISTRY:item.args[2],SCOPE:scope(address),
          TREE_DEPTH:20n,ROOT_HISTORY_SIZE:100n,CIPHERTEXT_BYTES:256n,CAP_INCREASE_DELAY:BigInt(CAP_INCREASE_DELAY_SECONDS)};
        assert.ok(Object.hasOwn(values,functionName));return values[functionName];
      }throw new Error('Unexpected mock getter '+functionName);
    },
    async request({method,params}){
      assert.equal(method,'eth_sendRawTransaction');calls.send++;const tx=parseTransaction(params[0]),hash=keccak256(params[0]);
      assert.equal(Number(tx.nonce??0),state.nonce);register({hash,data:tx.data,nonce:state.nonce,gas:tx.gas,gasPrice:tx.gasPrice});state.nonce++;state.balance-=42000n;return hash;
    }};
  const signer=createMainnetSigner({client,address:account.address,directory:signerDirectory,...limits,signRawTransaction:async intent=>{
    calls.sign++;return account.signTransaction({chainId:4663,type:'legacy',nonce:Number(intent.nonce),gas:BigInt(intent.gas),gasPrice:BigInt(intent.gasPrice),value:0n,data:intent.data});}});
  const production={releaseId:'cd'.repeat(32),build:{path:'artifacts/phase2-mainnet/contracts.json',sha256:'12'.repeat(32)},manifests:{}};
  const release={config,artifacts:build,artifactSHA256:'aa'.repeat(32),sourceSetSHA256:'bb'.repeat(32),production};
  const adoptedDeployments=[{id:'PoseidonT3',sourceReservationId:entry.id,hash,address,nonce:'0'}];
  return {root,signerDirectory,client,signer,ledger,entry,records,overrides,calls,release,adoptedDeployments,writeLedger,register,state,account,
    options:{root,release,client,signer,...limits,signerDirectory,adoptedDeployments},cleanup:()=>fs.rm(parent,{recursive:true,force:true})};
}
test('confirmed T3 reuse creates only the other six contracts and preserves the sole account history and nonce',async()=>{
  const f=await fixture();try{
    const output=await runMainnetDeployment(f.options),state=await f.signer.status();
    assert.equal(f.calls.send,6);assert.equal(f.calls.sign,6);assert.equal(state.entries.length,7);
    assert.equal(state.entries[0].hash,f.entry.hash);assert.equal(state.entries[0].id,f.entry.id);assert.equal(state.entries[1].nonce,'1');
    assert.equal(output.addresses.PoseidonT3,f.adoptedDeployments[0].address);assert.equal(output.feeWei,String(6*42000));assert.equal(output.accountFeeWei,String(7*42000));
    assert.deepEqual(output.reusedDeployments,f.adoptedDeployments);assert.equal(output.profiles.eth.pool.address,output.addresses['pool:eth']);
    const journalFile=path.join(f.root,'.phase1-private/phase2-mainnet/deployments',output.planId,'deployment.json');
    const journal=JSON.parse(await fs.readFile(journalFile)).value;
    assert.equal(journal.steps[0].kind,'reused');assert.equal(journal.steps[0].sourceReservationId,f.entry.id);assert.equal(journal.steps[0].sourcePlanId,OLD_PLAN);
    assert.deepEqual(await runMainnetDeployment(f.options),output);assert.equal(f.calls.send,6);assert.equal(f.calls.sign,6);
  }finally{await f.cleanup();}
});
test('an old unknown T4 blocks the new plan without signing, cancelling or broadcasting',async()=>{
  const f=await fixture();try{
    const data=f.release.artifacts.PoseidonT4.bytecode,raw=await f.account.signTransaction({chainId:4663,type:'legacy',nonce:1,gas:4000000n,gasPrice:2n,value:0n,data});
    const unknown={id:`deploy:${OLD_PLAN}:PoseidonT4`,chainId:4663,to:null,data,value:'0',nonce:'1',gas:'4000000',gasPrice:'2',feeCeilingWei:'8000000',status:'unknown',rawTransaction:raw,hash:keccak256(raw)};
    unknown.intentDigest=createHash('sha256').update(JSON.stringify({to:null,data,value:'0'})).digest('hex');f.ledger.entries.push(unknown);await f.writeLedger();
    await assert.rejects(()=>runMainnetDeployment(f.options),error=>error.code==='ACCOUNT_UNKNOWN_BROADCAST'&&error.transactionHash===unknown.hash&&error.nonce==='1');
    const state=await f.signer.status();assert.equal(state.entries.length,2);assert.equal(state.entries[1].status,'unknown');assert.equal(state.committedWei,'8042000');
    assert.equal(f.calls.send,0);assert.equal(f.calls.sign,0);
  }finally{await f.cleanup();}
});
test('T4 may be reused only after canonical confirmation, preserving both old fees and starting at nonce two',async()=>{
  const f=await fixture();try{
    const data=f.release.artifacts.PoseidonT4.bytecode,raw=await f.account.signTransaction({chainId:4663,type:'legacy',nonce:1,gas:4000000n,gasPrice:2n,value:0n,data}),hash=keccak256(raw);
    const address=f.register({hash,data,nonce:1,gas:4000000n,name:'PoseidonT4'});
    const entry={id:`deploy:${OLD_PLAN}:PoseidonT4`,chainId:4663,to:null,data,value:'0',nonce:'1',gas:'4000000',gasPrice:'2',feeCeilingWei:'8000000',status:'confirmed',
      rawTransaction:raw,hash,feeWei:'42000',gasUsed:'21000',effectiveGasPrice:'2',blockNumber:'1',blockHash:BLOCK,contractAddress:address};
    entry.intentDigest=createHash('sha256').update(JSON.stringify({to:null,data,value:'0'})).digest('hex');
    f.ledger.entries.push(entry);await f.writeLedger();f.state.nonce=2;
    f.adoptedDeployments.push({id:'PoseidonT4',sourceReservationId:entry.id,hash,address,nonce:'1'});
    const output=await runMainnetDeployment(f.options),state=await f.signer.status();
    assert.equal(f.calls.send,5);assert.equal(f.calls.sign,5);assert.equal(state.entries.length,7);assert.equal(state.entries[2].nonce,'2');
    assert.equal(output.addresses.PoseidonT4,address);assert.equal(output.feeWei,String(5*42000));assert.equal(output.accountFeeWei,String(7*42000));
    assert.equal(state.entries[1].hash,hash);assert.equal(output.reusedDeployments.length,2);
  }finally{await f.cleanup();}
});
test('the reused source must match the historical hash, nonce, exact initcode and canonical runtime',async()=>{
  for(const mutate of [f=>f.options.adoptedDeployments[0].hash='0x'+'ff'.repeat(32),f=>f.options.adoptedDeployments[0].nonce='1',
    f=>f.release.artifacts.PoseidonT3.bytecode='0x60026000f3',f=>f.overrides.set(f.adoptedDeployments[0].address.toLowerCase(),'0x6000'),
    f=>f.records.get(f.entry.hash).receipt.blockHash=GENESIS]){
    const f=await fixture();try{mutate(f);await assert.rejects(()=>runMainnetDeployment(f.options));assert.equal(f.calls.send,0);assert.equal(f.calls.sign,0);}
    finally{await f.cleanup();}
  }
});
test('old actual fees remain charged against the unchanged cumulative budget',async()=>{
  const f=await fixture();try{
    Object.assign(f.entry,{feeWei:'3000000',gasUsed:'1500000'});f.records.get(f.entry.hash).receipt.gasUsed=1500000n;await f.writeLedger();
    await assert.rejects(()=>runMainnetDeployment(f.options),{code:'MAINNET_DEPLOYMENT_BUDGET_HEADROOM_LOW'});assert.equal(f.calls.send,0);assert.equal(f.calls.sign,0);
    assert.equal((await f.signer.status()).committedWei,'3000000');
  }finally{await f.cleanup();}
});
test('only T3/T4 may be adopted, and an empty or different ledger cannot silently replace the original',async()=>{
  const f=await fixture();try{
    for(const adoption of [{...f.adoptedDeployments[0],id:'Phase2ASPPool'},...f.adoptedDeployments.map(a=>({...a,privateKey:'synthetic-not-a-key'}))]){
      assert.throws(()=>normalizeAdoptedDeployments([adoption]),{code:'MAINNET_ADOPTED_DEPLOYMENTS_INVALID'});
    }
    assert.throws(()=>normalizeAdoptedDeployments([...f.adoptedDeployments,...f.adoptedDeployments]),{code:'MAINNET_ADOPTED_DEPLOYMENTS_INVALID'});
    await assert.rejects(()=>runMainnetDeployment({...f.options,signerDirectory:undefined}),{code:'MAINNET_SHARED_SIGNER_REQUIRED'});
    await assert.rejects(()=>runMainnetDeployment({...f.options,signer:{...f.signer,directory:f.root}}),{code:'MAINNET_SHARED_SIGNER_MISMATCH'});
    await assert.rejects(()=>requireExistingMainnetSignerDirectory(path.join(f.root,'missing')));assert.equal(f.calls.send,0);
    assert.equal(await fs.stat(path.join(f.root,'missing')).catch(error=>error.code),'ENOENT');
  }finally{await f.cleanup();}
});
test('an existing but reset account ledger fails the original confirmed-source anchor before signing',async()=>{
  const f=await fixture();try{
    f.ledger.entries=[];await f.writeLedger();
    await assert.rejects(()=>runMainnetDeployment(f.options),{code:'MAINNET_ADOPTED_SOURCE_MISMATCH'});
    assert.equal(f.calls.send,0);assert.equal(f.calls.sign,0);
  }finally{await f.cleanup();}
});
test('CLI continuation metadata requires an existing shared ledger and a nonempty reuse anchor',async()=>{
  const f=await fixture();try{
    const metadata=path.join(f.root,'operations-snapshot.json');
    await fs.writeFile(metadata,JSON.stringify({sharedSignerDirectory:f.signerDirectory,adoptedDeployments:f.adoptedDeployments}));
    assert.deepEqual(await readMainnetDeploymentContinuation({root:f.root}),{signerDirectory:f.signerDirectory,adoptedDeployments:f.adoptedDeployments});
    await fs.writeFile(metadata,JSON.stringify({sharedSignerDirectory:f.signerDirectory,adoptedDeployments:[]}));
    await assert.rejects(()=>readMainnetDeploymentContinuation({root:f.root}),{code:'MAINNET_SHARED_SIGNER_ANCHOR_REQUIRED'});
    assert.equal(f.calls.send,0);assert.equal(f.calls.sign,0);
  }finally{await f.cleanup();}
});
