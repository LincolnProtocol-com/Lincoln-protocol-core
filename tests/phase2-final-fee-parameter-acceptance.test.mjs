import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CallExecutionError,ExecutionRevertedError,toFunctionSelector} from 'viem';
import {parseFinalFeeParameterAcceptanceArgs,finalFeeParameterAcceptancePlan,runFinalFeeParameterAcceptance,isFinalFeeAcceptanceRevert} from '../scripts/phase2-mainnet/verify-fee-parameters.mjs';

test('final fee acceptance is local and cannot select an RPC, wallet, fork, account or key',()=>{
  assert.deepEqual(parseFinalFeeParameterAcceptanceArgs([]),{verify:false});assert.deepEqual(parseFinalFeeParameterAcceptanceArgs(['--verify']),{verify:true});
  for(const args of [['--verify','--plan'],['--verify','--verify'],['--rpc-url','https://rpc.mainnet.chain.robinhood.com/'],['--account','deployer'],['--fork-url','http://localhost:8545'],['--zkey','final.zkey'],['--private-key','do-not-print-this']])
    assert.throws(()=>parseFinalFeeParameterAcceptanceArgs(args),{code:'FINAL_FEE_ACCEPTANCE_ARGUMENT_INVALID'});
  const plan=finalFeeParameterAcceptancePlan();assert.equal(plan.publicTransactions,0);assert.equal(plan.parameters,'final-production-only');assert.equal(plan.usesPublicRPC,false);assert.equal(plan.usesKeystore,false);assert.equal(plan.usesLocalDeployer,false);assert.equal(plan.usesFork,false);
  assert.equal(plan.realCoreAndFeeArtifacts,true);assert.equal(plan.actualDEX,false);assert.equal(plan.mockSourcePool,false);
});

test('the programmatic entry rejects external client/signer/RPC injection before reading artifacts',async()=>{
  for(const options of [{rpcUrl:'https://rpc.mainnet.chain.robinhood.com/'},{client:{}},{signer:{}},{account:'deployer'},{fork:true},{keystore:'/secret'},{zkey:'/alternate'}])
    await assert.rejects(()=>runFinalFeeParameterAcceptance(options),{code:'FINAL_FEE_ACCEPTANCE_OPTIONS_INVALID'});
});

test('tampering acceptance requires the expected selector AND a genuine execution revert',()=>{
  const signature='ServiceFeeAboveLimit()',selector=toFunctionSelector(signature),revert=Object.assign(new ExecutionRevertedError({message:'execution reverted'}),{data:selector});
  assert.equal(isFinalFeeAcceptanceRevert(revert,signature),true);assert.equal(isFinalFeeAcceptanceRevert(new CallExecutionError(revert,{to:'0x'+'01'.repeat(20)}),signature),true);
  assert.equal(isFinalFeeAcceptanceRevert(revert,'ContextMismatch()'),false);
  for(const error of [Object.assign(new Error('transport unavailable'),{data:selector}),new Error('execution reverted'),new RangeError('invalid encoding'),new ExecutionRevertedError({message:'execution reverted'}),null])
    assert.equal(isFinalFeeAcceptanceRevert(error,signature),false);
});

test('missing final parameters fail before spawning a node, generating wallets or creating reports',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-final-fee-missing-')));
  try{
    await fs.mkdir(path.join(root,'config'));await fs.copyFile(new URL('../config/phase2-mainnet.json',import.meta.url),path.join(root,'config/phase2-mainnet.json'));
    let progress=false;await assert.rejects(()=>runFinalFeeParameterAcceptance({root,onProgress:()=>{progress=true;}}),{code:'MAINNET_FINAL_PARAMETER_MISSING'});
    assert.equal(progress,false);assert.deepEqual(await fs.readdir(root),['config']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('CLI rejects a supplied private key without echoing it or starting acceptance',async()=>{
  const run=promisify(execFile),secret='fake-secret-must-not-appear';
  await assert.rejects(()=>run(process.execPath,[new URL('../scripts/phase2-mainnet/verify-fee-parameters.mjs',import.meta.url).pathname,'--private-key',secret]),error=>{
    assert.equal(error.code,1);assert.match(error.stderr,/FINAL_FEE_ACCEPTANCE_ARGUMENT_INVALID/);assert.ok(!error.stdout.includes(secret)&&!error.stderr.includes(secret));return true;
  });
});
