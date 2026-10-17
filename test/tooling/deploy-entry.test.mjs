// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const run=promisify(execFile),script=fileURLToPath(new URL('../../scripts/deploy.sh',import.meta.url));
test('the obsolete RC.2 entry cannot resume signing under any execution mode',async()=>{
 for(const args of [[],['--prepare'],['--deploy'],['--deploy','--budget-wei','1100000000000000','--max-fee-per-gas-wei','40000000','--reserve-wei','3000000000000000']]){
  await assert.rejects(()=>run('bash',[script,...args],{timeout:10000}),error=>error.code===1&&error.stderr.includes('RC2_MAINNET_DEPLOYMENT_PAUSED'));
 }
});
test('the paused entry does not echo arbitrary credential-shaped arguments',async()=>{
 await assert.rejects(()=>run('bash',[script,'--private-key','synthetic-secret'],{timeout:10000}),error=>error.code===1&&!error.stderr.includes('synthetic-secret'));
});
test('the paused entry parses without accessing a wallet or RPC',async()=>{await run('bash',['-n',script],{timeout:10000});});
