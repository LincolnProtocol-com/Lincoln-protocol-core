import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CallExecutionError,ExecutionRevertedError} from 'viem';
import {parseFinalParameterAcceptanceArgs,finalParameterAcceptancePlan,runFinalParameterAcceptance,isFinalAcceptanceExecutionRevert} from '../scripts/phase2-mainnet/verify-final-parameters.mjs';

test('final-parameter acceptance cannot select an existing RPC, wallet or alternate proving key',()=>{
  assert.deepEqual(parseFinalParameterAcceptanceArgs([]),{verify:false});
  assert.deepEqual(parseFinalParameterAcceptanceArgs(['--verify']),{verify:true});
  for(const args of [['--verify','--plan'],['--verify','--verify'],['--rpc-url','https://rpc.mainnet.chain.robinhood.com/'],['--account','deployer'],['--zkey','0000.zkey'],['--private-key','secret']]){
    assert.throws(()=>parseFinalParameterAcceptanceArgs(args),{code:'FINAL_ACCEPTANCE_ARGUMENT_INVALID'});
  }
  const plan=finalParameterAcceptancePlan();assert.equal(plan.localOnly,true);assert.equal(plan.publicTransactions,0);assert.equal(plan.usesLocalDeployer,false);assert.equal(plan.parameters,'final-production-only');
});

test('final proof tampering checks require actual execution reverts, not transport or encoding failures',()=>{
  const revert=new ExecutionRevertedError({message:'execution reverted'});
  assert.equal(isFinalAcceptanceExecutionRevert(revert),true);
  assert.equal(isFinalAcceptanceExecutionRevert(new CallExecutionError(revert,{to:'0x'+'01'.repeat(20)})),true);
  for(const error of [new Error('HTTP request failed'),new Error('execution reverted'),new RangeError('invalid bigint'),null]){
    assert.equal(isFinalAcceptanceExecutionRevert(error),false);
  }
});

test('missing final parameters fail before a node, wallet or positive acceptance report is created',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-final-acceptance-missing-')));
  try{
    await fs.mkdir(path.join(root,'config'));
    await fs.copyFile(new URL('../config/phase2-mainnet.json',import.meta.url),path.join(root,'config/phase2-mainnet.json'));
    let progress=false;
    await assert.rejects(()=>runFinalParameterAcceptance({root,onProgress:()=>{progress=true;}}),{code:'MAINNET_FINAL_PARAMETER_MISSING'});
    assert.equal(progress,false);assert.deepEqual(await fs.readdir(root),['config']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
