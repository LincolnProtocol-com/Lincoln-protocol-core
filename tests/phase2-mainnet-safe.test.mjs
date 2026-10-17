import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {verifyMainnetSafe} from '../src/phase2-mainnet/safe.mjs';

function fixture(){
  const code='0x6000',hash='0x'+'ab'.repeat(32),calls=[];
  const guardian={kind:'safe',chainId:4663,address:'0x'+'11'.repeat(20),version:'1.5.0',ownerCount:3,threshold:2,runtimeCodeHash:keccak256(code)};
  const owners=[1,2,3].map(n=>'0x'+String(n).repeat(40));
  const client={async getChainId(){calls.push('chain');return 4663;},async getBlock(){calls.push('block');return {number:1n,hash,timestamp:100n};},
    async getCode(){calls.push('code');return code;},async readContract({functionName}){calls.push(functionName);return {getOwners:owners,getThreshold:2n,VERSION:'1.5.0',nonce:0n}[functionName];}};
  return {guardian,client,calls};
}
test('Safe verification pins the chain and runtime and checks a canonical 2-of-3 public snapshot',async()=>{
  const f=fixture(),result=await verifyMainnetSafe(f);
  assert.equal(result.verified,true);assert.equal(result.threshold,2);assert.equal(result.ownerCount,3);
  assert.equal(result.transactionsBroadcast,0);assert.equal(result.transactionsSigned,0);
  assert.equal(result.owners,undefined);assert.match(result.ownerSetHash,/^0x[0-9a-f]{64}$/);
});
test('wrong chain, missing code, a changed Safe threshold and a reorg cannot pass',async()=>{
  const chain=fixture();chain.client.getChainId=async()=>1;
  await assert.rejects(()=>verifyMainnetSafe(chain),{code:'MAINNET_SAFE_WRONG_CHAIN'});assert.deepEqual(chain.calls,[]);
  const missing=fixture();missing.client.getCode=async()=>'0x';
  await assert.rejects(()=>verifyMainnetSafe(missing),{code:'MAINNET_SAFE_CODE_MISSING'});
  const single=fixture(),read=single.client.readContract;
  single.client.readContract=async args=>args.functionName==='getThreshold'?1n:read(args);
  await assert.rejects(()=>verifyMainnetSafe(single),{code:'MAINNET_SAFE_THRESHOLD_MISMATCH'});
  const fork=fixture();let n=0;fork.client.getBlock=async()=>({number:1n,timestamp:100n,hash:'0x'+(++n===1?'ab':'cd').repeat(32)});
  await assert.rejects(()=>verifyMainnetSafe(fork),{code:'MAINNET_SAFE_SNAPSHOT_CHANGED'});
});
