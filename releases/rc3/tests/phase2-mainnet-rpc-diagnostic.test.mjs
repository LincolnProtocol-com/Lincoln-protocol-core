// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';import assert from 'node:assert/strict';
import {sanitizeBroadcastError} from '../src/phase2-mainnet/rpc-diagnostic.mjs';
test('RPC diagnostics prefer the nested rejection over a generic wrapper',()=>{
 const result=sanitizeBroadcastError({shortMessage:'An unknown RPC error occurred.',cause:{code:-32000,message:'nonce too low'}});
 assert.deepEqual(result,{code:-32000,shortMessage:'nonce too low'});
});
test('RPC diagnostics exclude signed bytes, credentials, URLs, body and stack',()=>{
 const result=sanitizeBroadcastError({code:-32000,message:'rejected 0xabcdef password=example https://rpc.invalid/x\nRequest body: secret',
  details:'private payload',body:'private payload',stack:'private payload'});
 assert.equal(result.code,-32000);assert.doesNotMatch(JSON.stringify(result),/abcdef|example|rpc.invalid|private payload|Request body/);
 assert.ok(result.shortMessage.length<=240);
});
test('RPC diagnostics do not invoke untrusted accessors',()=>{
 const error={};Object.defineProperty(error,'message',{get(){throw new Error('getter invoked');}});
 assert.deepEqual(sanitizeBroadcastError(error),{shortMessage:'Broadcast RPC failed; outcome is unknown.'});
});
