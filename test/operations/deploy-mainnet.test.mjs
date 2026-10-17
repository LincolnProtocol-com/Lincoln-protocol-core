// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicClient,RpcRequestError,InvalidInputRpcError} from 'viem';
import {createMainnetSigner} from '../../releases/rc3/src/phase2-mainnet/signer.mjs';
import {sanitizeBroadcastError as frozenSanitize} from '../../releases/rc3/src/phase2-mainnet/rpc-diagnostic.mjs';
import {MAINNET_DEPLOYMENT_RPC,parseMainnetRunnerArgs,mainnetGasPriceWithHeadroom,normalizeMainnetBroadcastTransport,
  createMainnetDeploymentClient,createMainnetRC3DeploymentRunner} from '../../scripts/operations/deploy-mainnet.mjs';
import {DEFAULT_RC3_DEPLOYMENT_DIRECTORY} from '../../scripts/operations/mainnet-rc3.mjs';

const LIMITS={budgetWei:'65000000000000000',maxFeePerGasWei:'4000000000',reserveWei:'3000000000000000'};
const GAS_PRICE={multiplierNumerator:'100',multiplierDenominator:'1',maxFeePerGasWei:LIMITS.maxFeePerGasWei};
const ADDRESS='0x'+'12'.repeat(20),GENESIS='0x'+'11'.repeat(32);
const args=(overrides={})=>['--deploy',...Object.entries({'--account':'synthetic-deployer','--password-file':'/synthetic/private/password',
  '--budget-wei':LIMITS.budgetWei,'--max-fee-per-gas-wei':LIMITS.maxFeePerGasWei,'--reserve-wei':LIMITS.reserveWei,...overrides}).flat()];
const CORE_STEPS=['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry','pool:eth','pool:usdg'];
const modulePaths=['scripts/phase2-mainnet/deploy.mjs','src/phase2-mainnet/release.mjs','src/phase2-mainnet/signer.mjs'];
async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-mainnet-runner-'))),directory=path.join(root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY);
  const calls={checks:[],imports:[],release:[],continuation:[],clients:[],signers:[],engine:[]};
  const checked={directory,account:'synthetic-deployer',limits:{...LIMITS},readiness:{blocked:false},
    sharedSignerDirectory:path.join(root,'same-physical-account-ledger'),adoptedDeployments:[{id:'PoseidonT3',synthetic:true},{id:'PoseidonT4',synthetic:true}]};
  const config={chain:{id:4663,rpcUrl:MAINNET_DEPLOYMENT_RPC},network:'mainnet',deployer:{address:ADDRESS,signingAccount:checked.account}};
  const release={config},client={syntheticClient:true},signer={syntheticSigner:true};
  const modules={
    deployment:{parseMainnetDeployArgs:()=>({deploy:true}),deploymentSpecs:()=>CORE_STEPS.map(id=>({id})),
      readMainnetDeploymentContinuation:async value=>{calls.continuation.push(value);return {signerDirectory:checked.sharedSignerDirectory,adoptedDeployments:structuredClone(checked.adoptedDeployments)};},
      runMainnetDeployment:async value=>{calls.engine.push(value);return {complete:true,synthetic:true};}},
    release:{loadVerifiedMainnetRelease:async value=>{calls.release.push(value);return release;}},
    signer:{MAINNET_RPC:MAINNET_DEPLOYMENT_RPC,createMainnetSigner:value=>{calls.signers.push(value);return signer;}}
  };
  const gasPolicy={effectiveLimits:{...LIMITS},gasPrice:{...GAS_PRICE}};
  const runner=createMainnetRC3DeploymentRunner({loadGasPolicy:async()=>gasPolicy,checkSnapshot:async value=>{calls.checks.push(value);return checked;},
    importModule:async value=>{calls.imports.push(value);const relative=path.relative(directory,fileURLToPath(value)),index=modulePaths.indexOf(relative);
      assert.notEqual(index,-1);assert.equal(calls.checks.length,1);assert.equal(calls.signers.length,0);return modules[['deployment','release','signer'][index]];},
    makeClient:value=>{calls.clients.push(value);return client;}});
  return {root,checked,calls,config,release,modules,runner,client,signer,gasPolicy,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
async function use(action){const f=await fixture();try{return await action(f);}finally{await f.cleanup();}}

test('runner parses only the fixed deployment scope and explicit approved-limit options',()=>{
  assert.deepEqual(parseMainnetRunnerArgs(args()),{account:'synthetic-deployer',passwordFile:'/synthetic/private/password',limits:LIMITS});
  for(const forbidden of ['--routes','--relayer-address','--keystore-file','--rpc-url','--plan','--deploy'])
    assert.throws(()=>parseMainnetRunnerArgs([...args(),forbidden,'unapproved']),{code:'MAINNET_RUNNER_ARGUMENT_INVALID'});
  assert.throws(()=>parseMainnetRunnerArgs(args({'--password-file':'relative-password'})),{code:'MAINNET_PASSWORD_FILE_REQUIRED'});
  assert.throws(()=>parseMainnetRunnerArgs(args({'--budget-wei':'011'})),{code:'MAINNET_EXPLICIT_LIMIT_REQUIRED'});
  assert.throws(()=>parseMainnetRunnerArgs(args({'--account':'../different-wallet'})),{code:'MAINNET_RUNNER_ACCOUNT_INVALID'});
  assert.throws(()=>parseMainnetRunnerArgs(args().slice(0,-2)),{code:'MAINNET_RUNNER_EXPLICIT_OPTIONS_REQUIRED'});
});
test('100x gas pricing uses integer arithmetic, clips to the approved cap, and rejects an over-cap quote',()=>{
  for(const [quote,maximum,expected]of [[1n,100n,100n],[4n,1000n,400n],[20000000n,4000000000n,2000000000n],[40000001n,4000000000n,4000000000n],
    [4000000000n,4000000000n,4000000000n]])assert.equal(mainnetGasPriceWithHeadroom(quote,maximum),expected);
  assert.equal(mainnetGasPriceWithHeadroom(3n,100n,{numerator:125n,denominator:100n}),4n);
  for(const [quote,maximum]of [[41n,40n],[0n,40n],[-1n,40n],[1n,0n],[1,40n]])
    assert.throws(()=>mainnetGasPriceWithHeadroom(quote,maximum),{code:'MAINNET_GAS_PRICE_EXCEEDED'});
});
test('normalized transport sends once with retries disabled and real viem literal survives frozen sanitizer',async()=>{
  const calls=[],factories=[],sensitive='synthetic-secret-not-to-log';
  const factory=parameters=>{factories.push(parameters);return {config:{key:'synthetic',name:'synthetic',type:'http'},
    request:async(request,options)=>{calls.push({request,options});throw new InvalidInputRpcError(new RpcRequestError({
      body:{method:'eth_sendRawTransaction',params:['0x'+'ab'.repeat(1000)]},
      error:{code:-32000,message:`node policy refused; password=${sensitive}; tx 0xabcdef`},url:'https://synthetic.invalid/'}));}};};
  const client=createPublicClient({transport:normalizeMainnetBroadcastTransport(factory)});
  await assert.rejects(()=>client.request({method:'eth_sendRawTransaction',params:['SYNTHETIC_ALREADY_SIGNED']},{retryCount:9}),error=>{
    const diagnostic=frozenSanitize(error);assert.equal(diagnostic.code,-32000);assert.match(diagnostic.shortMessage,/^node policy refused/);
    for(const hidden of [sensitive,'0xabcdef','Missing or invalid parameters','synthetic.invalid','Request body'])assert.equal(JSON.stringify(diagnostic).includes(hidden),false);
    for(const hidden of ['cause','body','details','metaMessages'])assert.equal(Object.hasOwn(error,hidden),false);
    return true;
  });
  assert.equal(calls.length,1);assert.equal(calls[0].options.retryCount,0);assert.equal(factories[0].retryCount,0);
  assert.equal(calls[0].request.params[0],'SYNTHETIC_ALREADY_SIGNED');
});
test('normalization passes successful hashes and non-broadcast errors through unchanged',async()=>{
  const expected='0x'+'ab'.repeat(32),error=new Error('read-only RPC unavailable');let calls=0;
  const transport=normalizeMainnetBroadcastTransport(()=>({config:{},request:async request=>{calls++;if(request.method==='eth_sendRawTransaction')return expected;throw error;}}))({});
  assert.equal(await transport.request({method:'eth_sendRawTransaction',params:['SYNTHETIC']}),expected);
  await assert.rejects(()=>transport.request({method:'eth_getBalance',params:[]}),value=>value===error);assert.equal(calls,2);
});
test('client factory is pinned to official mainnet RPC and buffers only getGasPrice within its cap',async()=>{
  const calls=[],base={request:async()=>{},getBalance:async()=>123n,getGasPrice:async()=>20n};
  const client=createMainnetDeploymentClient({maxFeePerGasWei:'4000',httpFactory:(url,options)=>{calls.push({url,options});return ()=>({config:{},request:async()=>{}});},
    publicClientFactory:options=>{assert.equal(typeof options.transport,'function');return base;}});
  assert.deepEqual(calls,[{url:MAINNET_DEPLOYMENT_RPC,options:{retryCount:0,timeout:30000}}]);
  assert.equal(await client.getGasPrice(),2000n);assert.equal(client.getBalance,base.getBalance);assert.equal(client.request,base.request);
  base.getGasPrice=async()=>4001n;await assert.rejects(()=>client.getGasPrice(),{code:'MAINNET_GAS_PRICE_EXCEEDED'});
});
test('fixed runner verifies the entire snapshot before importing frozen modules and retains the shared ledger',()=>use(async f=>{
  assert.deepEqual(await f.runner({root:f.root,args:args()}),{complete:true,synthetic:true});
  assert.deepEqual(f.calls.checks,[{root:f.root,limits:LIMITS}]);assert.equal(f.calls.imports.length,3);
  assert.deepEqual(f.calls.release,[{root:f.checked.directory}]);assert.deepEqual(f.calls.continuation,[{root:f.checked.directory}]);
  assert.deepEqual(f.calls.clients,[{maxFeePerGasWei:LIMITS.maxFeePerGasWei,gasPrice:GAS_PRICE}]);
  assert.deepEqual(f.calls.signers,[{client:f.client,address:ADDRESS,account:f.checked.account,passwordFile:'/synthetic/private/password',
    ...LIMITS,directory:f.checked.sharedSignerDirectory}]);
  assert.deepEqual(f.calls.engine,[{root:f.checked.directory,release:f.release,client:f.client,signer:f.signer,routes:[],relayer:null,
    ...LIMITS,signerDirectory:f.checked.sharedSignerDirectory,adoptedDeployments:f.checked.adoptedDeployments}]);
}));
test('unknown readiness, changed account, snapshot and any limit fail before imports, client or signer creation',async()=>{
  for(const [mutate,code]of [
    [f=>{f.checked.readiness.blocked=true;},'ACCOUNT_UNKNOWN_BROADCAST'],
    [f=>{delete f.checked.readiness;},'ACCOUNT_UNKNOWN_BROADCAST'],
    [f=>{f.checked.account='different-account';},'MAINNET_RUNNER_ACCOUNT_MISMATCH'],
    [f=>{f.checked.directory=path.join(f.root,'another-snapshot');},'MAINNET_RUNNER_SNAPSHOT_MISMATCH'],
    ...Object.keys(LIMITS).map(key=>[f=>{f.checked.limits[key]='1';},'RC3_EXPLICIT_LIMITS_MUST_MATCH_ORIGINAL'])
  ])await use(async f=>{
    mutate(f);await assert.rejects(()=>f.runner({root:f.root,args:args()}),{code});
    assert.equal(f.calls.imports.length,0);assert.equal(f.calls.clients.length,0);assert.equal(f.calls.signers.length,0);assert.equal(f.calls.engine.length,0);
  });
});
test('gas policy must match the applied limits and approved 100x ratio before module imports',async()=>{
  for(const mutate of [f=>{f.gasPolicy.effectiveLimits.budgetWei='1';},f=>{f.gasPolicy.gasPrice.maxFeePerGasWei='1';},
    f=>{f.gasPolicy.gasPrice.multiplierNumerator='1000';},f=>{f.gasPolicy.gasPrice.multiplierDenominator='2';}])await use(async f=>{
    mutate(f);await assert.rejects(()=>f.runner({root:f.root,args:args()}),{code:'MAINNET_GAS_POLICY_LIMITS_MISMATCH'});
    assert.equal(f.calls.imports.length,0);assert.equal(f.calls.signers.length,0);assert.equal(f.calls.engine.length,0);
  });
});
test('unapproved scope, account, RPC and shared-ledger substitutions fail before signer creation',async()=>{
  for(const [mutate,code]of [
    [f=>{f.modules.deployment.deploymentSpecs=()=>[...CORE_STEPS,'pool:nvda'].map(id=>({id}));},'MAINNET_RUNNER_SCOPE_INVALID'],
    [f=>{f.config.deployer.signingAccount='another-account';},'MAINNET_RUNNER_ACCOUNT_MISMATCH'],
    [f=>{f.config.chain.rpcUrl='https://unapproved.invalid/';},'MAINNET_OFFICIAL_RPC_REQUIRED'],
    [f=>{f.modules.signer.MAINNET_RPC='https://unapproved.invalid/';},'MAINNET_OFFICIAL_RPC_REQUIRED'],
    [f=>{f.modules.deployment.readMainnetDeploymentContinuation=async()=>({signerDirectory:'/substituted-ledger',adoptedDeployments:f.checked.adoptedDeployments});},'MAINNET_SHARED_SIGNER_MISMATCH'],
    [f=>{f.modules.deployment.readMainnetDeploymentContinuation=async()=>({signerDirectory:f.checked.sharedSignerDirectory,adoptedDeployments:[]});},'MAINNET_SHARED_SIGNER_MISMATCH']
  ])await use(async f=>{
    mutate(f);await assert.rejects(()=>f.runner({root:f.root,args:args()}),{code});
    assert.equal(f.calls.clients.length,0);assert.equal(f.calls.signers.length,0);assert.equal(f.calls.engine.length,0);
  });
});
test('frozen signer buffers a new preparation once and never changes an existing prepared intent',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-new-price-')));let quote=20n,quotes=0;
  try{
    const base={getChainId:async()=>4663,getBlock:async()=>({hash:GENESIS}),getTransactionCount:async()=>0,
      getGasPrice:async()=>{quotes++;return quote;},estimateGas:async()=>21000n,getBalance:async()=>100000000n};
    const client=createMainnetDeploymentClient({maxFeePerGasWei:'4000',httpFactory:()=>()=>({config:{},request:async()=>{throw new Error('must not broadcast');}}),publicClientFactory:()=>base});
    const directory=path.join(root,'synthetic-shared-ledger'),signer=createMainnetSigner({client,address:ADDRESS,directory,
      budgetWei:'100000000',maxFeePerGasWei:'4000',reserveWei:'0',signRawTransaction:async()=>{throw new Error('must not sign');}});
    const intent={id:'synthetic:new',to:null,data:'0x60006000f3',value:'0'},first=await signer.prepare(intent);
    assert.equal(first.gasPrice,'2000');assert.equal(first.status,'prepared');assert.equal(quotes,1);
    const before=await fs.readFile(path.join(directory,'signer.json'));quote=39n;
    assert.deepEqual(await signer.prepare(intent),first);assert.equal(quotes,1);
    assert.deepEqual(await fs.readFile(path.join(directory,'signer.json')),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
