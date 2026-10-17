// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {configureMainnetOperations} from '../scripts/core/mainnet-operations.mjs';
const config=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url)));
const operations=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet-operations.json',import.meta.url)));
const clone=value=>structuredClone(value);
test('registers the public account without changing frozen config or enabling spending',()=>{
  const before=clone(config),result=configureMainnetOperations({config,operations});
  assert.equal(result.deployer.address,'0x555998Ba2B2723C97d91FB20Da0ddb896749797e');assert.equal(result.deployer.signingAccount,'lincoln-deployer');
  assert.deepEqual(config,before);assert.deepEqual(result.limits,config.limits);assert.deepEqual(result.assets,config.assets);
  assert.deepEqual({...result,deployer:config.deployer},config);
});
test('rejects signing and funding authorizations in a metadata-only target',()=>{
  for(const mutate of [o=>o.signingEnabled=true,...Object.keys(operations.limits).map(key=>o=>o.limits[key]='1')]){
    const o=clone(operations);mutate(o);assert.throws(()=>configureMainnetOperations({config,operations:o}),{code:'MAINNET_OPERATIONS_SIGNING_DISABLED_REQUIRED'});
  }
});
test('rejects wrong release, chain and extra secret or override fields',()=>{
  for(const mutate of [o=>o.chainId=46630,o=>o.candidate.sha256='00'.repeat(32),o=>o.candidate.tag='v0.1.0-rc.1',o=>o.candidate.manifest='../other.json',o=>o.privateKey='example',o=>o.deployer.passwordFile='/example',o=>o.deployer.keystoreOwnershipVerified=true]){
    const o=clone(operations);mutate(o);assert.throws(()=>configureMainnetOperations({config,operations:o}));
  }
});
test('rejects invalid deployer identities, role collisions and replacing a configured signer',()=>{
  for(const address of ['0x'+'00'.repeat(20),'invalid',config.guardian.address,config.provider.address]){
    const o=clone(operations);o.deployer.address=address;assert.throws(()=>configureMainnetOperations({config,operations:o}));
  }
  const c=clone(config);c.deployer.address=operations.deployer.address;assert.throws(()=>configureMainnetOperations({config:c,operations}),{code:'MAINNET_OPERATIONS_FROZEN_DEPLOYER_REQUIRED'});
  const o=clone(operations);o.deployer.signingAccount='../other';assert.throws(()=>configureMainnetOperations({config,operations:o}));
});
