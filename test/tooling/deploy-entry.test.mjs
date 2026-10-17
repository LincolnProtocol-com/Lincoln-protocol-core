// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const run=promisify(execFile),script=fileURLToPath(new URL('../../scripts/deploy.sh',import.meta.url));
async function rejected(args,pattern){await assert.rejects(()=>run('bash',[script,...args],{timeout:10000}),error=>error.code===1&&pattern.test(error.stderr));}
test('deployment entry rejects absent or malformed limits before any key or RPC',async()=>{
 await rejected(['--deploy'],/Explicit/);await rejected(['--deploy','--budget-wei','0','--max-fee-per-gas-wei','1','--reserve-wei','0'],/Explicit/);
 await rejected(['--deploy','--budget-wei','1e18','--max-fee-per-gas-wei','1','--reserve-wei','0'],/Explicit/);
});
test('deployment requires a real operator terminal even with valid numerical limits',async()=>{
 await rejected(['--deploy','--budget-wei','1100000000000000','--max-fee-per-gas-wei','40000000','--reserve-wei','3000000000000000'],/interactive terminal/);
});
test('preparation cannot silently accept budget authorization or another execution mode',async()=>{
 await rejected(['--prepare','--budget-wei','1'],/accepts no spending limits/);await rejected(['--go'],/Use --prepare or --deploy/);await rejected(['--prepare','--private-key','synthetic'],/Unknown deployment option/);
});
test('the operator script parses in the bundled bash without running it',async()=>{await run('bash',['-n',script],{timeout:10000});});
