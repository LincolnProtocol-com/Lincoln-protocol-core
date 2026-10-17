// SPDX-License-Identifier: Apache-2.0
// Pure validation helpers. They never read a keystore, touch a journal or use RPC.
import {createHash} from 'node:crypto';
import {getAddress,isAddress,keccak256,parseTransaction,recoverTransactionAddress} from 'viem';

const HASH=/^0x[0-9a-f]{64}$/;
const HEX=/^0x(?:[0-9a-fA-F]{2})+$/;
const OPEN_STATES=new Set(['signed','broadcasting','submitted','unknown']);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
function integer(value,code,{zero=false}={}){
  need(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),code);
  const result=BigInt(value);
  need(result<2n**256n&&(zero?result>=0n:result>0n),code);
  return result;
}
const sameAddress=(a,b)=>a===null&&b===null||typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

/** Validate the exact already-signed transaction, without authorizing a replacement.
 * The caller must separately validate the whole ledger, cumulative spending,
 * canonical chain state, nonce availability and balance before sending anything.
 */
export async function verifyRecoveryTransaction({entry,address,expectedHash,budgetWei,maxFeePerGasWei,reserveWei}={}){
  need(entry&&typeof entry==='object'&&!Array.isArray(entry),'MAINNET_RECOVERY_ENTRY_INVALID');
  need(isAddress(address)&&address.toLowerCase()!=='0x'+'00'.repeat(20),'MAINNET_RECOVERY_ADDRESS_INVALID');
  need(typeof expectedHash==='string'&&HASH.test(expectedHash),'MAINNET_RECOVERY_HASH_INVALID');
  const budget=integer(budgetWei,'MAINNET_RECOVERY_BUDGET_REQUIRED');
  const maximumPrice=integer(maxFeePerGasWei,'MAINNET_RECOVERY_GAS_PRICE_REQUIRED');
  integer(reserveWei,'MAINNET_RECOVERY_RESERVE_REQUIRED',{zero:true});
  need(OPEN_STATES.has(entry.status),'MAINNET_RECOVERY_STATE_INVALID');
  need(entry.chainId===4663,'MAINNET_RECOVERY_CHAIN_MISMATCH');
  need(entry.value==='0','MAINNET_RECOVERY_VALUE_MISMATCH');
  need(entry.to===null||isAddress(entry.to),'MAINNET_RECOVERY_TO_INVALID');
  need(typeof entry.data==='string'&&HEX.test(entry.data),'MAINNET_RECOVERY_DATA_INVALID');
  const nonce=integer(entry.nonce,'MAINNET_RECOVERY_NONCE_INVALID',{zero:true});
  need(nonce<=BigInt(Number.MAX_SAFE_INTEGER),'MAINNET_RECOVERY_NONCE_INVALID');
  const gas=integer(entry.gas,'MAINNET_RECOVERY_GAS_INVALID');
  const price=integer(entry.gasPrice,'MAINNET_RECOVERY_GAS_PRICE_INVALID');
  const fee=integer(entry.feeCeilingWei,'MAINNET_RECOVERY_FEE_INVALID');
  need(fee===gas*price&&fee<=budget&&price<=maximumPrice,'MAINNET_RECOVERY_FEE_LIMIT_EXCEEDED');
  // Settlement metadata on an allegedly open reservation must not be discarded.
  need(['feeWei','gasUsed','effectiveGasPrice','blockNumber','blockHash','contractAddress'].every(key=>entry[key]===undefined),
    'MAINNET_RECOVERY_ALREADY_SETTLED');
  const digest=createHash('sha256').update(JSON.stringify({to:entry.to,data:entry.data,value:entry.value})).digest('hex');
  need(entry.intentDigest===digest,'MAINNET_RECOVERY_INTENT_DIGEST_MISMATCH');
  need(entry.hash===expectedHash&&typeof entry.rawTransaction==='string'&&HEX.test(entry.rawTransaction),
    'MAINNET_RECOVERY_HASH_MISMATCH');
  need(keccak256(entry.rawTransaction)===expectedHash,'MAINNET_RECOVERY_HASH_MISMATCH');
  let transaction,sender;
  try{
    transaction=parseTransaction(entry.rawTransaction);
    sender=await recoverTransactionAddress({serializedTransaction:entry.rawTransaction});
  }catch{throw Object.assign(new Error('MAINNET_RECOVERY_SIGNATURE_INVALID'),{code:'MAINNET_RECOVERY_SIGNATURE_INVALID'});}
  need(transaction.type==='legacy','MAINNET_RECOVERY_TRANSACTION_TYPE_INVALID');
  need(Number(transaction.chainId)===4663,'MAINNET_RECOVERY_CHAIN_MISMATCH');
  need(sender.toLowerCase()===address.toLowerCase(),'MAINNET_RECOVERY_SENDER_MISMATCH');
  need(BigInt(transaction.nonce??0)===nonce,'MAINNET_RECOVERY_NONCE_MISMATCH');
  need(sameAddress(transaction.to??null,entry.to),'MAINNET_RECOVERY_TO_MISMATCH');
  need(typeof transaction.data==='string'&&transaction.data.toLowerCase()===entry.data.toLowerCase(),'MAINNET_RECOVERY_DATA_MISMATCH');
  need(BigInt(transaction.value??0)===0n,'MAINNET_RECOVERY_VALUE_MISMATCH');
  need(BigInt(transaction.gas)===gas,'MAINNET_RECOVERY_GAS_MISMATCH');
  need(BigInt(transaction.gasPrice)===price,'MAINNET_RECOVERY_GAS_PRICE_MISMATCH');
  return {transactionHash:expectedHash,chainId:4663,address:getAddress(address),to:entry.to===null?null:getAddress(entry.to),
    nonce:nonce.toString(),gas:gas.toString(),gasPrice:price.toString(),feeCeilingWei:fee.toString(),
    budgetWei,maxFeePerGasWei,reserveWei,status:entry.status,transactionType:'legacy'};
}

// Read only literal data properties. Never invoke error accessors or serialize an
// error object: viem errors can carry signed bytes inside request bodies/details.
function ownValue(object,key){
  if(!object||typeof object!=='object')return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
function safeMessage(value){
  if(typeof value!=='string')return null;
  // Bound work before matching potentially huge error messages.
  let result=value.slice(0,2048).split(/[\r\n\u2028\u2029]/,1)[0];
  result=result.split(/\b(?:request\s+body|request\s+arguments|raw\s+transaction|stack\s+trace|details)\s*:/i,1)[0];
  result=result.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi,'[url removed]')
    .replace(/\b(?:private[-_ ]?key|password|passphrase|mnemonic|seed|secret|authorization|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'[credential removed]')
    .replace(/0x[0-9a-f]*/gi,'[hex removed]')
    .replace(/\b[0-9a-f]{32,}\b/gi,'[hex removed]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ')
    .replace(/\s+/g,' ').trim();
  if(!result||/^[{\[]\s*["']?(?:jsonrpc|method|params|body|request|data|rawTransaction)["']?\s*:/i.test(result))return null;
  return result.slice(0,240);
}

/** Return a bounded diagnostic object; no stack, body, details or hex payloads. */
export function sanitizeBroadcastError(error){
  const chain=[];let current=error;
  for(let depth=0;depth<4&&current&&typeof current==='object'&&!chain.includes(current);depth++){
    chain.push(current);current=ownValue(current,'cause');
  }
  let code;
  // A numeric nested RPC code is more useful than a generic wrapper label.
  for(const item of chain){
    const value=ownValue(item,'code');
    if(typeof value==='number'&&Number.isSafeInteger(value)){code=value;break;}
    if(typeof value==='string'&&/^-?[0-9]{1,10}$/.test(value)){code=value;break;}
  }
  if(code===undefined)for(const item of chain){
    const value=ownValue(item,'code');if(typeof value==='string'&&/^[A-Z][A-Z0-9_-]{0,63}$/.test(value)){code=value;break;}
  }
  // Generic viem wrappers must not hide a nested node reason such as nonce too
  // low. Never inspect `details` or a request object to find that reason.
  const generic=/^(?:an? (?:unknown|internal) (?:RPC )?error (?:occurred|was received)|RPC request failed|HTTP request failed|request failed|unknown error)[.!]?$/i;
  const candidates=[...chain.map(item=>safeMessage(ownValue(item,'shortMessage'))),
    ...chain.slice(1).map(item=>safeMessage(ownValue(item,'message'))),safeMessage(ownValue(error,'message'))].filter(Boolean);
  const shortMessage=candidates.find(message=>!generic.test(message))??candidates[0]??'Broadcast RPC failed; outcome is unknown.';
  return {...(code===undefined?{}:{code}),shortMessage};
}
