// SPDX-License-Identifier: Apache-2.0
// One durable nonce/fee ledger per Robinhood mainnet signing address. No key export.
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getAddress,isAddress,keccak256,parseTransaction,recoverTransactionAddress} from 'viem';
import {openServiceStore} from '../phase1-service/store.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const MAINNET_RPC='https://rpc.mainnet.chain.robinhood.com/';
const run=promisify(execFile),HASH=/^0x[0-9a-fA-F]{64}$/,HEX=/^0x(?:[0-9a-fA-F]{2})*$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer=(value,code,{zero=false}={})=>{need(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),code);const n=BigInt(value);need((zero?n>=0n:n>0n)&&n<2n**256n,code);return n;};
const clone=value=>JSON.parse(JSON.stringify(value));
const live=entry=>!['confirmed','reverted','cancelled'].includes(entry.status);
const cost=entry=>['confirmed','reverted'].includes(entry.status)?BigInt(entry.feeWei):live(entry)?BigInt(entry.feeCeilingWei):0n;
const publicEntry=entry=>{const {rawTransaction,...result}=entry;return clone(result);};
function cleanEnv(){return Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(ETH_|CAST_|FOUNDRY_|PRIVATE_KEY|MNEMONIC|CHAIN$|TEMPO_|TURNKEY_|AWS_|GCP_)/.test(key)));}

/** Only cast decrypts the local keystore. Never call wallet private-key or export. */
export function createCastKeystoreSigner({address,account,keystoreFile,passwordFile}={}){
  need(isAddress(address)&&((typeof account==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(account)&&keystoreFile===undefined)
    ||account===undefined&&typeof keystoreFile==='string'&&path.isAbsolute(keystoreFile)),'MAINNET_KEYSTORE_OPTIONS_INVALID');
  need(typeof passwordFile==='string'&&path.isAbsolute(passwordFile),'MAINNET_PASSWORD_FILE_REQUIRED');
  return async intent=>{
    need(intent.chainId===4663&&intent.value==='0','MAINNET_SIGNING_INTENT_INVALID');
    const passwordStat=await fs.lstat(passwordFile);
    need(passwordStat.isFile()&&!passwordStat.isSymbolicLink()&&await fs.realpath(passwordFile)===passwordFile
      &&passwordStat.size<=1024&&(passwordStat.mode&0o077)===0
      &&(typeof process.getuid!=='function'||passwordStat.uid===process.getuid()),'MAINNET_PASSWORD_FILE_INVALID');
    if(keystoreFile){const stat=await fs.lstat(keystoreFile);
      need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(keystoreFile)===keystoreFile&&stat.size>0&&stat.size<=64*1024
        &&(stat.mode&0o077)===0&&(typeof process.getuid!=='function'||stat.uid===process.getuid()),'MAINNET_KEYSTORE_FILE_INVALID');}
    const args=['mktx','--rpc-url',MAINNET_RPC,'--chain','4663',...(keystoreFile?['--keystore',keystoreFile]:['--account',account]),'--password-file',passwordFile,
      '--legacy','--nonce',intent.nonce,'--gas-limit',intent.gas,'--gas-price',intent.gasPrice,'--value','0'];
    if(intent.to)args.push(intent.to,'--data',intent.data);else args.push('--create',intent.data);
    let stdout;try{({stdout}=await run('cast',args,{env:cleanEnv(),timeout:60000,maxBuffer:2*1024*1024}));}
    catch{throw Object.assign(new Error('MAINNET_KEYSTORE_SIGN_FAILED'),{code:'MAINNET_KEYSTORE_SIGN_FAILED'});}
    const raw=stdout.trim();need(HEX.test(raw)&&raw.length>2,'MAINNET_SIGNED_TRANSACTION_INVALID');
    need((await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase()===address.toLowerCase(),'MAINNET_KEYSTORE_ADDRESS_MISMATCH');
    return raw;
  };
}

export function mainnetSignerDirectory({root=ROOT,address}={}){
  need(isAddress(address),'MAINNET_SIGNER_ADDRESS_INVALID');
  return path.join(root,'.phase1-private/phase2-mainnet/signers',`4663-${address.toLowerCase()}`);
}

/** prepare persists intent+nonce+ceiling; broadcast persists the signed hash before RPC.
 * Each operation obtains the same address lock. A crash leaves a lock that requires
 * explicit operator recovery, never automatic stale-lock deletion.
 */
export function createMainnetSigner({client,address,account,keystoreFile,passwordFile,budgetWei,maxFeePerGasWei,reserveWei,
  root=ROOT,directory,signRawTransaction,beforeBroadcast,expectedGenesisHash}={}){
  need(client&&isAddress(address),'MAINNET_SIGNER_OPTIONS_INVALID');address=getAddress(address);
  const budget=integer(budgetWei,'MAINNET_EXPLICIT_BUDGET_REQUIRED'),maxPrice=integer(maxFeePerGasWei,'MAINNET_EXPLICIT_GAS_PRICE_REQUIRED');
  const reserve=integer(reserveWei,'MAINNET_EXPLICIT_RESERVE_REQUIRED',{zero:true});
  directory??=mainnetSignerDirectory({root,address});
  let sign=signRawTransaction;
  const identity=`lincoln-mainnet-signer:4663:${address.toLowerCase()}`;
  const connect=async()=>{
    need(await client.getChainId()===4663,'MAINNET_SIGNER_WRONG_CHAIN');
    const genesisHash=(await client.getBlock({blockNumber:0n})).hash;need(HASH.test(genesisHash),'MAINNET_SIGNER_GENESIS_INVALID');
    if(expectedGenesisHash!==undefined)need(HASH.test(expectedGenesisHash)&&genesisHash===expectedGenesisHash,'MAINNET_SIGNER_GENESIS_MISMATCH');
    const store=await openServiceStore({directory,identity,filename:'signer.json'});
    try{
      let state=await store.read();
      if(!state)state={schema:'phase2-mainnet-signer/v1',chainId:4663,address,genesisHash,budgetWei,maxFeePerGasWei,reserveWei,entries:[]};
      need(state.schema==='phase2-mainnet-signer/v1'&&state.chainId===4663&&state.address.toLowerCase()===address.toLowerCase()
        &&state.genesisHash===genesisHash,'MAINNET_SIGNER_IDENTITY_MISMATCH');
      need(state.budgetWei===budgetWei&&state.maxFeePerGasWei===maxFeePerGasWei&&state.reserveWei===reserveWei,'MAINNET_SIGNER_BUDGET_CHANGED');
      need(Array.isArray(state.entries)&&new Set(state.entries.map(e=>e.id)).size===state.entries.length,'MAINNET_SIGNER_LEDGER_CORRUPT');
      for(const e of state.entries){
        need(typeof e.id==='string'&&e.intentDigest===digest({to:e.to,data:e.data,value:e.value})&&e.value==='0'
          &&HEX.test(e.data)&&(!e.to||isAddress(e.to))&&e.chainId===4663,'MAINNET_SIGNER_LEDGER_CORRUPT');
        integer(e.nonce,'MAINNET_SIGNER_LEDGER_CORRUPT',{zero:true});integer(e.gas,'MAINNET_SIGNER_LEDGER_CORRUPT');integer(e.gasPrice,'MAINNET_SIGNER_LEDGER_CORRUPT');
        need(BigInt(e.gas)*BigInt(e.gasPrice)===BigInt(e.feeCeilingWei)&&BigInt(e.gasPrice)<=maxPrice,'MAINNET_SIGNER_LEDGER_CORRUPT');
        need(['prepared','signed','broadcasting','submitted','unknown','confirmed','reverted','cancelled'].includes(e.status),'MAINNET_SIGNER_LEDGER_CORRUPT');
        if(e.rawTransaction)need(keccak256(e.rawTransaction)===e.hash,'MAINNET_SIGNER_LEDGER_CORRUPT');
        if(['confirmed','reverted'].includes(e.status))need(HASH.test(e.hash)&&HASH.test(e.blockHash)&&BigInt(e.feeWei)<=BigInt(e.feeCeilingWei),'MAINNET_SIGNER_LEDGER_CORRUPT');
      }
      need(state.entries.filter(live).length<=1,'MAINNET_SIGNER_LEDGER_CORRUPT');
      need(state.entries.reduce((sum,e)=>sum+cost(e),0n)<=budget,'MAINNET_SIGNER_BUDGET_EXCEEDED');
      return {store,state};
    }catch(error){await store.close();throw error;}
  };
  const withStore=async fn=>{const {store,state}=await connect();try{return await fn(state,store);}finally{await store.close();}};
  const summary=state=>({schema:state.schema,address,chainId:4663,genesisHash:state.genesisHash,budgetWei,maxFeePerGasWei,reserveWei,
    committedWei:state.entries.reduce((sum,e)=>sum+cost(e),0n).toString(),entries:state.entries.map(publicEntry)});
  const transactionMatches=(tx,e)=>{
    need(tx.from?.toLowerCase()===address.toLowerCase()&&(tx.to??null)?.toLowerCase()===(e.to??null)?.toLowerCase()
      &&Number(tx.chainId)===4663&&BigInt(tx.nonce)===BigInt(e.nonce)&&BigInt(tx.value)===0n
      &&tx.input?.toLowerCase()===e.data.toLowerCase()&&BigInt(tx.gas)===BigInt(e.gas)
      &&BigInt(tx.gasPrice)===BigInt(e.gasPrice),'MAINNET_RECEIPT_INTENT_MISMATCH');
  };
  const settle=async(state,store,e)=>{
    if(!e.hash||['cancelled','prepared','signed'].includes(e.status))return;
    let receipt;try{receipt=await client.getTransactionReceipt({hash:e.hash});}
    catch(error){if(error.name==='TransactionReceiptNotFoundError'||error.code==='RECEIPT_NOT_FOUND')return;throw Object.assign(new Error('MAINNET_RECEIPT_LOOKUP_FAILED'),{code:'MAINNET_RECEIPT_LOOKUP_FAILED'});}
    need(receipt.transactionHash?.toLowerCase()===e.hash.toLowerCase()&&receipt.from?.toLowerCase()===address.toLowerCase(),'MAINNET_RECEIPT_IDENTITY_MISMATCH');
    const tx=await client.getTransaction({hash:e.hash});transactionMatches(tx,e);
    need((await client.getBlock({blockNumber:receipt.blockNumber})).hash===receipt.blockHash,'MAINNET_RECEIPT_REORG');
    const fee=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice);
    need(fee<=BigInt(e.feeCeilingWei)&&BigInt(receipt.gasUsed)<=BigInt(e.gas)&&BigInt(receipt.effectiveGasPrice)<=BigInt(e.gasPrice),'MAINNET_RECEIPT_FEE_EXCEEDED');
    need(['success','reverted'].includes(receipt.status),'MAINNET_RECEIPT_STATUS_INVALID');
    Object.assign(e,{status:receipt.status==='success'?'confirmed':'reverted',feeWei:fee.toString(),gasUsed:receipt.gasUsed.toString(),
      effectiveGasPrice:receipt.effectiveGasPrice.toString(),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,contractAddress:receipt.contractAddress??null});
    await store.write(state);
  };
  return {
    address,chainId:4663,directory,
    async status(){return withStore(async state=>summary(state));},
    async prepare(intent){
      need(intent&&typeof intent.id==='string'&&/^[a-zA-Z0-9:_.-]{1,200}$/.test(intent.id),'MAINNET_INTENT_ID_INVALID');
      need((intent.to===undefined||intent.to===null||isAddress(intent.to))&&HEX.test(intent.data)&&intent.data.length>2
        &&(intent.value===undefined||intent.value==='0'),'MAINNET_INTENT_INVALID');
      const normalized={to:intent.to?getAddress(intent.to):null,data:intent.data.toLowerCase(),value:'0'},intentDigest=digest(normalized);
      return withStore(async(state,store)=>{
        const old=state.entries.find(e=>e.id===intent.id);
        if(old){need(old.intentDigest===intentDigest,'MAINNET_INTENT_ID_REUSED');need(old.status!=='cancelled','MAINNET_RESERVATION_CANCELLED');return publicEntry(old);}
        for(const e of state.entries)if(live(e))await settle(state,store,e);
        need(!state.entries.some(live),'MAINNET_ACCOUNT_PENDING_TRANSACTION');
        const latest=await client.getTransactionCount({address,blockTag:'latest'}),pending=await client.getTransactionCount({address,blockTag:'pending'});
        need(latest===pending,'MAINNET_EXTERNAL_PENDING_NONCE');
        const previous=state.entries.filter(e=>e.status!=='cancelled').at(-1);
        need(!previous||BigInt(pending)>BigInt(previous.nonce),'MAINNET_SIGNER_NONCE_REGRESSION');
        const price=intent.gasPrice===undefined?await client.getGasPrice():integer(intent.gasPrice,'MAINNET_GAS_PRICE_INVALID');
        need(price>0n&&price<=maxPrice,'MAINNET_GAS_PRICE_EXCEEDED');
        const estimate=await client.estimateGas({account:address,...(normalized.to?{to:normalized.to}:{}),data:normalized.data,value:0n});
        const gas=intent.gas===undefined?(estimate*125n+99n)/100n:integer(intent.gas,'MAINNET_GAS_LIMIT_INVALID');
        need(estimate>0n&&gas>=estimate,'MAINNET_GAS_LIMIT_TOO_LOW');
        const fee=gas*price,spent=state.entries.reduce((sum,e)=>sum+cost(e),0n);
        need(spent+fee<=budget,'MAINNET_SIGNER_BUDGET_EXCEEDED');
        need(await client.getBalance({address,blockTag:'pending'})>=fee+reserve,'MAINNET_SIGNER_BALANCE_LOW');
        const entry={id:intent.id,chainId:4663,...normalized,intentDigest,nonce:pending.toString(),gas:gas.toString(),gasPrice:price.toString(),feeCeilingWei:fee.toString(),status:'prepared'};
        state.entries.push(entry);await store.write(state);return publicEntry(entry);
      });
    },
    async cancelPrepared(id){return withStore(async(state,store)=>{
      const e=state.entries.find(e=>e.id===id);need(e,'MAINNET_RESERVATION_UNKNOWN');need(e.status==='prepared','MAINNET_RESERVATION_ALREADY_SIGNED');
      e.status='cancelled';await store.write(state);return publicEntry(e);
    });},
    async recoverHash(id){return withStore(async state=>{
      const e=state.entries.find(e=>e.id===(typeof id==='string'?id:id?.id));return e?.hash??null;
    });},
    async unsignedEvidence(id){return withStore(async state=>{
      const e=state.entries.find(e=>e.id===id);
      if(!e||!['prepared','cancelled'].includes(e.status)||e.hash||e.rawTransaction)return null;
      return {id:e.id,chainId:4663,from:address,to:e.to,data:e.data,value:'0',status:e.status,unsigned:true};
    });},
    async reconcile(){return withStore(async(state,store)=>{for(const e of state.entries)if(e.hash&&e.status!=='cancelled')await settle(state,store,e);return summary(state);});},
    async broadcast(reservation){return withStore(async(state,store)=>{
      const id=typeof reservation==='string'?reservation:reservation?.id,e=state.entries.find(e=>e.id===id);need(e,'MAINNET_RESERVATION_UNKNOWN');
      need(e.status!=='cancelled','MAINNET_RESERVATION_CANCELLED');
      if(e.hash&&['broadcasting','submitted','unknown','confirmed','reverted'].includes(e.status))return e.hash;
      need(e.status==='prepared'||e.status==='signed','MAINNET_RESERVATION_INVALID');
      const pending=await client.getTransactionCount({address,blockTag:'pending'}),latest=await client.getTransactionCount({address,blockTag:'latest'});
      need(BigInt(pending)===BigInt(e.nonce)&&pending===latest,'MAINNET_SIGNER_NONCE_CHANGED');
      need(await client.getBalance({address,blockTag:'pending'})>=BigInt(e.feeCeilingWei)+reserve,'MAINNET_SIGNER_BALANCE_LOW');
      if(beforeBroadcast)await beforeBroadcast(publicEntry(e));
      if(e.status==='prepared'){
        sign??=createCastKeystoreSigner({address,account,keystoreFile,passwordFile});
        const raw=await sign(clone({...e,chainId:4663})),tx=parseTransaction(raw);
        need(Number(tx.chainId)===4663&&BigInt(tx.nonce??0)===BigInt(e.nonce)&&BigInt(tx.value??0)===0n
          &&(tx.to??null)?.toLowerCase()===(e.to??null)?.toLowerCase()&&tx.data?.toLowerCase()===e.data
          &&BigInt(tx.gas)===BigInt(e.gas)&&BigInt(tx.gasPrice)===BigInt(e.gasPrice)
          &&(await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase()===address.toLowerCase(),'MAINNET_SIGNED_INTENT_MISMATCH');
        Object.assign(e,{status:'signed',rawTransaction:raw,hash:keccak256(raw)});await store.write(state);
      }
      e.status='broadcasting';await store.write(state);
      try{
        const actual=await client.request({method:'eth_sendRawTransaction',params:[e.rawTransaction]});
        need(actual?.toLowerCase()===e.hash.toLowerCase(),'MAINNET_BROADCAST_HASH_MISMATCH');e.status='submitted';await store.write(state);return e.hash;
      }catch{e.status='unknown';await store.write(state);throw Object.assign(new Error('MAINNET_BROADCAST_UNKNOWN'),{code:'MAINNET_BROADCAST_UNKNOWN',transactionHash:e.hash});}
    });},
  };
}
