// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {keccak256} from 'viem';
import {verifyRecoveryTransaction,sanitizeBroadcastError} from '../../scripts/operations/recovery-validation.mjs';

const account=privateKeyToAccount(generatePrivateKey());
const other=privateKeyToAccount(generatePrivateKey());
const limits={budgetWei:'1000000',maxFeePerGasWei:'4',reserveWei:'0'};
const digest=entry=>createHash('sha256').update(JSON.stringify({to:entry.to,data:entry.data,value:entry.value})).digest('hex');
async function fixture({tx={},entry={}}={}){
  const original={chainId:4663,type:'legacy',nonce:0,gas:50000n,gasPrice:2n,value:0n,data:'0x60006000f3',...tx};
  const rawTransaction=await account.signTransaction(original),hash=keccak256(rawTransaction);
  const value={chainId:4663,status:'unknown',to:null,data:'0x60006000f3',value:'0',nonce:'0',gas:'50000',gasPrice:'2',feeCeilingWei:'100000',
    hash,rawTransaction,...entry};
  value.intentDigest=digest(value);
  return {entry:value,address:account.address,expectedHash:hash,...limits};
}
const rejects=async(options,code)=>assert.rejects(()=>verifyRecoveryTransaction(options),{code});

test('verifies the original signed transaction and returns metadata without signed bytes or calldata',async()=>{
  for(const status of ['signed','broadcasting','submitted','unknown']){
    const options=await fixture({entry:{status}}),before=structuredClone(options);
    const result=await verifyRecoveryTransaction(options);
    assert.equal(result.transactionHash,options.expectedHash);assert.equal(result.address,account.address);assert.equal(result.status,status);
    assert.equal(result.feeCeilingWei,'100000');assert.equal(result.transactionType,'legacy');
    assert.equal(Object.hasOwn(result,'rawTransaction'),false);assert.equal(Object.hasOwn(result,'data'),false);
    assert.equal(JSON.stringify(result).includes(options.entry.rawTransaction),false);assert.equal(JSON.stringify(result).includes(options.entry.data),false);
    assert.deepEqual(options,before);
  }
});
test('hash, valid signature sender and chain identity must all match',async()=>{
  const options=await fixture();
  await rejects({...options,expectedHash:'0x'+'aa'.repeat(32)},'MAINNET_RECOVERY_HASH_MISMATCH');
  await rejects({...options,entry:{...options.entry,hash:'0x'+'bb'.repeat(32)}},'MAINNET_RECOVERY_HASH_MISMATCH');
  await rejects({...options,entry:{...options.entry,rawTransaction:options.entry.rawTransaction.slice(0,-2)+'00'}},'MAINNET_RECOVERY_HASH_MISMATCH');
  await rejects({...options,address:other.address},'MAINNET_RECOVERY_SENDER_MISMATCH');
  await rejects(await fixture({tx:{chainId:46630}}),'MAINNET_RECOVERY_CHAIN_MISMATCH');
  await rejects(await fixture({entry:{chainId:46630}}),'MAINNET_RECOVERY_CHAIN_MISMATCH');
  await rejects({...options,address:'0x'+'00'.repeat(20)},'MAINNET_RECOVERY_ADDRESS_INVALID');
});
test('nonce, recipient, input and zero value are bound to the signed transaction',async()=>{
  for(const [tx,code]of [[{nonce:1},'MAINNET_RECOVERY_NONCE_MISMATCH'],[{to:other.address},'MAINNET_RECOVERY_TO_MISMATCH'],
    [{data:'0x60016000f3'},'MAINNET_RECOVERY_DATA_MISMATCH'],[{value:1n},'MAINNET_RECOVERY_VALUE_MISMATCH']])await rejects(await fixture({tx}),code);
  await rejects(await fixture({entry:{value:'1'}}),'MAINNET_RECOVERY_VALUE_MISMATCH');
  const options=await fixture();await rejects({...options,entry:{...options.entry,intentDigest:'00'.repeat(32)}},'MAINNET_RECOVERY_INTENT_DIGEST_MISMATCH');
  await rejects(await fixture({entry:{nonce:'9007199254740992'}}),'MAINNET_RECOVERY_NONCE_INVALID');
  await rejects(await fixture({entry:{to:undefined}}),'MAINNET_RECOVERY_TO_INVALID');
});
test('gas, price and ceiling must agree, respect explicit limits and use legacy fees',async()=>{
  await rejects(await fixture({tx:{gas:50001n}}),'MAINNET_RECOVERY_GAS_MISMATCH');
  await rejects(await fixture({tx:{gasPrice:3n}}),'MAINNET_RECOVERY_GAS_PRICE_MISMATCH');
  await rejects(await fixture({entry:{feeCeilingWei:'99999'}}),'MAINNET_RECOVERY_FEE_LIMIT_EXCEEDED');
  await rejects({...await fixture(),budgetWei:'99999'},'MAINNET_RECOVERY_FEE_LIMIT_EXCEEDED');
  await rejects({...await fixture(),maxFeePerGasWei:'1'},'MAINNET_RECOVERY_FEE_LIMIT_EXCEEDED');
  const options=await fixture();
  for(const [field,code]of [['budgetWei','MAINNET_RECOVERY_BUDGET_REQUIRED'],['maxFeePerGasWei','MAINNET_RECOVERY_GAS_PRICE_REQUIRED'],['reserveWei','MAINNET_RECOVERY_RESERVE_REQUIRED']]){
    for(const value of [undefined,'-1','01','1.1',(2n**256n).toString()])await rejects({...options,[field]:value},code);
  }
  const raw=await account.signTransaction({chainId:4663,type:'eip2930',nonce:0,gas:50000n,gasPrice:2n,value:0n,data:options.entry.data,accessList:[]});
  const hash=keccak256(raw);await rejects({...options,expectedHash:hash,entry:{...options.entry,hash,rawTransaction:raw}},'MAINNET_RECOVERY_TRANSACTION_TYPE_INVALID');
});
test('settled, cancelled and unsigned reservations cannot be recovered as open broadcasts',async()=>{
  for(const status of ['prepared','confirmed','reverted','cancelled',undefined,'other'])await rejects(await fixture({entry:{status}}),'MAINNET_RECOVERY_STATE_INVALID');
  for(const field of ['feeWei','gasUsed','effectiveGasPrice','blockNumber','blockHash','contractAddress']){
    await rejects(await fixture({entry:{[field]:'0'}}),'MAINNET_RECOVERY_ALREADY_SETTLED');
  }
});
test('broadcast diagnostics retain an RPC reason but strip hex, credentials, URLs, body and stack',()=>{
  const raw='0x'+'a1'.repeat(1000),hash='0x'+'bb'.repeat(32),secret='unique-sensitive-password';
  const error=Object.assign(new Error('outer error'),{code:-32000,cause:new Error(`nonce too low; tx ${hash}; password=${secret}; https://rpc.example/?token=hidden\nRequest body: ${raw}`),
    body:raw,stack:`SECRET STACK ${secret}`,details:raw});
  const result=sanitizeBroadcastError(error),encoded=JSON.stringify(result);
  assert.equal(result.code,-32000);assert.match(result.shortMessage,/nonce too low/);assert.ok(result.shortMessage.length<=240);
  for(const hidden of [raw,hash,secret,'hidden','Request body','SECRET STACK','0x'])assert.equal(encoded.includes(hidden),false);
  assert.deepEqual(Object.keys(result).sort(),['code','shortMessage']);
  const short=sanitizeBroadcastError({shortMessage:`insufficient funds ${'a'.repeat(64)}\n${raw}`,message:raw});
  assert.match(short.shortMessage,/insufficient funds/);assert.equal(JSON.stringify(short).includes('a'.repeat(64)),false);
});
test('diagnostic sanitization bounds output and avoids getters, recursive objects and arbitrary error fields',()=>{
  let invoked=false;const error={};
  Object.defineProperty(error,'shortMessage',{get(){invoked=true;throw new Error('must not read');}});
  error.cause=error;error.code='0x'+'aa'.repeat(32);error.message='x'.repeat(10000);error.request={rawTransaction:'DO NOT COPY'};
  const result=sanitizeBroadcastError(error);assert.equal(invoked,false);assert.equal(result.shortMessage.length,240);assert.equal(Object.hasOwn(result,'code'),false);
  assert.deepEqual(sanitizeBroadcastError({message:'Request body: {"params":["0x1234"]}'}),{shortMessage:'Broadcast RPC failed; outcome is unknown.'});
  assert.deepEqual(sanitizeBroadcastError(null),{shortMessage:'Broadcast RPC failed; outcome is unknown.'});
  assert.deepEqual(sanitizeBroadcastError({code:'RPC_TIMEOUT',shortMessage:'connection timed out'}),{code:'RPC_TIMEOUT',shortMessage:'connection timed out'});
});
