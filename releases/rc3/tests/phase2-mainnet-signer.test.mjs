import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {parseTransaction,keccak256} from 'viem';
import {createMainnetSigner,createCastKeystoreSigner} from '../src/phase2-mainnet/signer.mjs';

const GENESIS='0x'+'11'.repeat(32),BLOCK='0x'+'22'.repeat(32),TO='0x'+'33'.repeat(20);
async function fixture(options={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-mainnet-signer-')));
  const account=privateKeyToAccount(generatePrivateKey()),records=new Map(),calls={sign:0,send:0},chain={id:4663,genesis:GENESIS,nonce:0,pending:0,mode:'mined'};
  const client={async getChainId(){return chain.id;},async getBlock({blockNumber}){return {hash:blockNumber===0n?chain.genesis:BLOCK};},
    async getTransactionCount({blockTag}){return blockTag==='pending'?chain.pending:chain.nonce;},async getGasPrice(){return 2n;},async estimateGas(){return 21000n;},async getBalance(){return 10000000n;},
    async request({method,params}){assert.equal(method,'eth_sendRawTransaction');calls.send++;const raw=params[0],hash=keccak256(raw),tx=parseTransaction(raw);
      const transaction={...tx,nonce:tx.nonce??0,from:account.address,to:tx.to??null,input:tx.data,value:tx.value??0n};
      chain.pending=Number(tx.nonce??0)+1;
      if(chain.mode!=='unknown'){
        chain.nonce=chain.pending;
        records.set(hash,{transaction,receipt:{transactionHash:hash,from:account.address,to:tx.to??null,status:'success',gasUsed:21000n,effectiveGasPrice:2n,blockNumber:1n,blockHash:BLOCK,contractAddress:null}});
      }
      if(chain.mode.startsWith('unknown'))throw new Error('RPC_TIMEOUT');return hash;
    },
    async getTransactionReceipt({hash}){if(!records.has(hash))throw Object.assign(new Error('missing'),{code:'RECEIPT_NOT_FOUND'});return records.get(hash).receipt;},
    async getTransaction({hash}){return records.get(hash).transaction;},
  };
  const opts={client,address:account.address,directory,budgetWei:'1000000',maxFeePerGasWei:'2',reserveWei:'0',expectedGenesisHash:GENESIS,
    signRawTransaction:async e=>{calls.sign++;return account.signTransaction({chainId:4663,type:'legacy',to:e.to??undefined,data:e.data,value:0n,nonce:Number(e.nonce),gas:BigInt(e.gas),gasPrice:BigInt(e.gasPrice)});},...options};
  return {signer:createMainnetSigner(opts),client,chain,calls,records,opts,cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
}
const intent=id=>({id,to:TO,data:'0x1234',value:'0'});
test('mainnet signer demands explicit budgets/reserve and rejects wrong chain or genesis before signing',async()=>{
  const f=await fixture();try{
    for(const key of ['budgetWei','maxFeePerGasWei','reserveWei'])assert.throws(()=>createMainnetSigner({...f.opts,[key]:undefined}),/MAINNET_EXPLICIT/);
    f.chain.id=46630;await assert.rejects(()=>f.signer.prepare(intent('a')),{code:'MAINNET_SIGNER_WRONG_CHAIN'});
    f.chain.id=4663;f.chain.genesis=BLOCK;await assert.rejects(()=>f.signer.prepare(intent('a')),{code:'MAINNET_SIGNER_GENESIS_MISMATCH'});
    assert.equal(f.calls.sign,0);assert.equal(f.calls.send,0);
  }finally{await f.cleanup();}
});
test('same intent is idempotent; known hash never resends, confirmed actual fee replaces ceiling',async()=>{
  const f=await fixture();try{
    assert.equal(await f.signer.recoverHash('new'),null);
    const p=await f.signer.prepare(intent('a'));assert.equal(p.nonce,'0');assert.equal(p.feeCeilingWei,'52500');
    assert.equal((await f.signer.unsignedEvidence('a')).unsigned,true);assert.equal(await f.signer.unsignedEvidence('missing'),null);
    assert.deepEqual(await f.signer.prepare(intent('a')),p);
    await assert.rejects(()=>f.signer.prepare({...intent('a'),data:'0x2222'}),{code:'MAINNET_INTENT_ID_REUSED'});
    const hash=await f.signer.broadcast(p);assert.equal(await f.signer.broadcast('a'),hash);
    assert.equal(await f.signer.unsignedEvidence('a'),null);
    const status=await f.signer.reconcile();assert.equal(status.entries[0].status,'confirmed');assert.equal(status.committedWei,'42000');
    assert.equal(f.calls.sign,1);assert.equal(f.calls.send,1);assert.ok(!JSON.stringify(status).includes('rawTransaction'));
    assert.equal((await f.signer.prepare(intent('b'))).nonce,'1');
  }finally{await f.cleanup();}
});
test('unknown broadcast is durably recoverable and blocks all new nonces without resend after restart',async()=>{
  const f=await fixture();try{
    f.chain.mode='unknown';const p=await f.signer.prepare(intent('a'));
    await assert.rejects(()=>f.signer.broadcast(p),e=>e.code==='MAINNET_BROADCAST_UNKNOWN'&&/^0x[0-9a-f]{64}$/.test(e.transactionHash)&&e.rpcDiagnostic?.shortMessage==='RPC_TIMEOUT');
    const fresh=createMainnetSigner(f.opts),hash=await fresh.recoverHash('a');assert.ok(hash);
    assert.equal(await fresh.broadcast('a'),hash);
    await assert.rejects(()=>fresh.prepare(intent('b')),{code:'MAINNET_ACCOUNT_PENDING_TRANSACTION'});
    const unresolved=(await fresh.reconcile()).entries[0];assert.equal(unresolved.status,'unknown');assert.equal(unresolved.rpcDiagnostic.shortMessage,'RPC_TIMEOUT');assert.equal(f.calls.sign,1);assert.equal(f.calls.send,1);
    await assert.rejects(()=>fresh.cancelPrepared('a'),{code:'MAINNET_RESERVATION_ALREADY_SIGNED'});
  }finally{await f.cleanup();}
});
test('timeout after mined transaction reconciles its original hash and settles without a second send',async()=>{
  const f=await fixture();try{
    f.chain.mode='unknown-mined';await f.signer.prepare(intent('a'));await assert.rejects(()=>f.signer.broadcast('a'),{code:'MAINNET_BROADCAST_UNKNOWN'});
    assert.equal((await f.signer.reconcile()).entries[0].status,'confirmed');
    assert.equal((await f.signer.prepare(intent('b'))).nonce,'1');assert.equal(f.calls.send,1);
  }finally{await f.cleanup();}
});
test('shared account lock covers beforeBroadcast policy hook; failed policy leaves unsigned cancellable reservation',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  const f=await fixture({beforeBroadcast:async()=>{entered();await gate;throw Object.assign(new Error('POLICY_MOVED'),{code:'POLICY_MOVED'});}});
  try{
    await f.signer.prepare(intent('a'));const send=f.signer.broadcast('a');await ready;
    await assert.rejects(()=>createMainnetSigner(f.opts).prepare(intent('b')),{code:'STORE_LOCKED'});
    release();await assert.rejects(()=>send,{code:'POLICY_MOVED'});assert.equal(f.calls.sign,0);assert.equal(f.calls.send,0);
    assert.equal((await f.signer.cancelPrepared('a')).status,'cancelled');assert.equal((await f.signer.unsignedEvidence('a')).status,'cancelled');assert.equal((await f.signer.prepare(intent('b'))).nonce,'0');
  }finally{release();await f.cleanup();}
});
test('explicit cumulative cap, balance reserve and external pending nonce fail before signing',async()=>{
  const f=await fixture({budgetWei:'53000'});try{
    await f.signer.prepare(intent('a'));await f.signer.broadcast('a');await f.signer.reconcile();
    await assert.rejects(()=>f.signer.prepare(intent('b')),{code:'MAINNET_SIGNER_BUDGET_EXCEEDED'});assert.equal(f.calls.sign,1);
    await assert.rejects(()=>createMainnetSigner({...f.opts,budgetWei:'60000'}).status(),{code:'MAINNET_SIGNER_BUDGET_CHANGED'});
  }finally{await f.cleanup();}
  const low=await fixture({reserveWei:'9999999'});try{await assert.rejects(()=>low.signer.prepare(intent('a')),{code:'MAINNET_SIGNER_BALANCE_LOW'});}finally{await low.cleanup();}
  const pending=await fixture();try{pending.chain.pending=1;await assert.rejects(()=>pending.signer.prepare(intent('a')),{code:'MAINNET_EXTERNAL_PENDING_NONCE'});}finally{await pending.cleanup();}
});
test('receipt from a different intent or noncanonical block never frees reserved budget',async()=>{
  const f=await fixture();try{
    await f.signer.prepare(intent('a'));const hash=await f.signer.broadcast('a'),record=f.records.get(hash);
    record.transaction.input='0xeeee';await assert.rejects(()=>f.signer.reconcile(),{code:'MAINNET_RECEIPT_INTENT_MISMATCH'});
    record.transaction.input='0x1234';record.receipt.blockHash=GENESIS;await assert.rejects(()=>f.signer.reconcile(),{code:'MAINNET_RECEIPT_REORG'});
    assert.equal((await f.signer.status()).entries[0].status,'submitted');
  }finally{await f.cleanup();}
});
test('cast signer rejects symlink or exposed password file without invoking keystore tools',async()=>{
  const f=await fixture();try{
    const file=path.join(f.opts.directory,'password'),link=path.join(f.opts.directory,'password-link');
    await fs.writeFile(file,'',{mode:0o644});await fs.symlink(file,link);
    const data={chainId:4663,value:'0'};
    await assert.rejects(()=>createCastKeystoreSigner({address:f.opts.address,account:'deployer',passwordFile:file})(data),{code:'MAINNET_PASSWORD_FILE_INVALID'});
    await assert.rejects(()=>createCastKeystoreSigner({address:f.opts.address,account:'deployer',passwordFile:link})(data),{code:'MAINNET_PASSWORD_FILE_INVALID'});
    assert.throws(()=>createCastKeystoreSigner({address:f.opts.address,account:'deployer',keystoreFile:file,passwordFile:file}),{code:'MAINNET_KEYSTORE_OPTIONS_INVALID'});
    await fs.chmod(file,0o600);const keystore=path.join(f.opts.directory,'encrypted-keystore');await fs.writeFile(keystore,'{}',{mode:0o644});
    await assert.rejects(()=>createCastKeystoreSigner({address:f.opts.address,keystoreFile:keystore,passwordFile:file})(data),{code:'MAINNET_KEYSTORE_FILE_INVALID'});
    await fs.chmod(keystore,0o600);const keystoreLink=keystore+'-link';await fs.symlink(keystore,keystoreLink);
    await assert.rejects(()=>createCastKeystoreSigner({address:f.opts.address,keystoreFile:keystoreLink,passwordFile:file})(data),{code:'MAINNET_KEYSTORE_FILE_INVALID'});
  }finally{await f.cleanup();}
});
