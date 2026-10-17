import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createPublicClient,http,keccak256,parseAbi} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {compileMainnetSources,buildMainnetSourcePlan} from '../scripts/phase2-mainnet/build.mjs';
import {createMainnetSigner} from '../src/phase2-mainnet/signer.mjs';
import {loadVerifiedMainnetRelease} from '../src/phase2-mainnet/release.mjs';
import {normalizeProfile} from '../src/phase2-asp/sdk.mjs';
import {deploymentSpecs,mainnetDeploymentPlan,parseMainnetDeployArgs,checkMainnetDependencies,linkMainnetBytecode,runMainnetDeployment,verifyMainnetDeployment} from '../scripts/phase2-mainnet/deploy.mjs';

const config=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url)));
const routes=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet-routes-example.json',import.meta.url))).routes;
let compiledFixture;
function fixtureContracts(){return compiledFixture??= (async()=>{
  const sourcePlan=await buildMainnetSourcePlan(),sources={};
  for(const item of sourcePlan.sources){const old=await fs.readFile(new URL('../'+item.source,import.meta.url),'utf8');sources[item.target]=old.replace(item.oldGuard,item.newGuard);}
  for(const [name,count]of [['Phase2ASPJoinSplitVerifier',9],['Phase2ASPExitVerifier',5]])sources[`protocol/phase2-mainnet/generated/${name}.sol`]=
    `// SPDX-License-Identifier: GPL-3.0\npragma solidity 0.8.28;contract ${name}{function verifyProof(uint256[2] calldata,uint256[2][2] calldata,uint256[2] calldata,uint256[${count}] calldata) external pure returns(bool){return false;}}`;
  return compileMainnetSources({sources});
})();}
test('default deployment CLI is offline core-only with no implicit real ETH allowance',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-deploy-plan-no-params-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/phase2-mainnet.json'),JSON.stringify(config));
  const parsed=parseMainnetDeployArgs([]);assert.equal(parsed.deploy,false);assert.deepEqual(parsed.values,{});
  const plan=await mainnetDeploymentPlan({root});assert.equal(plan.transactionsSigned,0);assert.equal(plan.transactionsBroadcast,0);
  assert.equal(plan.steps.length,7);assert.deepEqual(plan.steps.filter(s=>s.asset).map(s=>s.asset.symbol),['ETH','USDG']);
  assert.equal(plan.steps.some(s=>s.route),false);assert.ok(plan.pending.some(p=>p.code==='PRODUCTION_CIRCUIT_MISSING'));
  assert.deepEqual(plan.outputs.profiles,['config/phase2-mainnet-profiles/eth.json','config/phase2-mainnet-profiles/usdg.json']);assert.equal(plan.outputs.aspSigningEnabled,false);
  for(const args of [['--deploy'],['--deploy','--plan'],['--deploy','--budget-wei','1'],['--rpc-url','http://127.0.0.1:1'],['--private-key','secret']])assert.throws(()=>parseMainnetDeployArgs(args),/MAINNET_/);
});
test('explicit fixed routes retain both DEXes, native wrapping and NVDA two-hop path without claiming deployment',async()=>{
  const plan=await mainnetDeploymentPlan({routes}),specs=deploymentSpecs({config,routes});
  assert.equal(plan.steps.length,14);assert.equal(specs.filter(s=>s.asset).length,3);
  assert.ok(specs.some(s=>s.contract==='Phase2Router02Adapter'));assert.ok(specs.some(s=>s.contract==='Phase2RouteAdapter'));
  assert.equal(specs.find(s=>s.id==='route:uniswap-eth-to-nvda').route.path.length,2+(20+23*2)*2);
  assert.ok(plan.steps.every(s=>s.status==='not-deployed'));
  const bad=structuredClone(routes);bad[0].tokens.reverse();assert.throws(()=>deploymentSpecs({config,routes:bad}),{code:'MAINNET_ROUTE_ENDPOINT_INVALID'});
  assert.throws(()=>deploymentSpecs({config:{...config,chain:{...config.chain,id:1}}}),{code:'MAINNET_DEPLOYMENT_TARGET_INVALID'});
  assert.throws(()=>deploymentSpecs({config:{...config,chain:{...config.chain,rpcUrl:'http://127.0.0.1:8545'}}}),{code:'MAINNET_OFFICIAL_RPC_REQUIRED'});
});
test('deployment final-release gate refuses missing final parameters, never adopting development keys',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-deploy-no-params-'));
  try{
    await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/phase2-mainnet.json'),JSON.stringify(config));
    await assert.rejects(()=>loadVerifiedMainnetRelease({root}),{code:'MAINNET_FINAL_PARAMETER_MISSING'});
    assert.deepEqual(await fs.readdir(root),['config']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('dependency chain and code pins reject before any key use; unresolved library placeholders cannot deploy',async()=>{
  let codeCalls=0;const specs=deploymentSpecs({config});
  await assert.rejects(()=>checkMainnetDependencies({client:{getChainId:async()=>46630,getCode:async()=>{codeCalls++;}},config,specs}),{code:'MAINNET_DEPLOYMENT_WRONG_CHAIN'});
  assert.equal(codeCalls,0);
  await assert.rejects(()=>checkMainnetDependencies({client:{getChainId:async()=>4663,getCode:async()=>'0x6000'},config:{...config,guardian:{address:config.guardian.address}},specs}),{code:'MAINNET_DEPENDENCY_CODE_MISMATCH'});
  assert.throws(()=>linkMainnetBytecode({bytecode:'0x'+'_'.repeat(40),linkReferences:{x:{PoseidonT3:[{start:0,length:20}]}}},{}),{code:'MAINNET_LIBRARY_LINK_MISSING'});
});

async function localChain(){
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--hardfork','cancun','--silent'],{stdio:'ignore'});
  let startError;child.on('error',e=>{startError=e;});
  const client=createPublicClient({transport:http(`http://127.0.0.1:${port}`,{retryCount:0,timeout:1000})});
  let ready=false;
  for(let n=0;n<100;n++){if(startError)throw startError;try{if(await client.getChainId()===4663){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.equal(ready,true,'isolated Anvil 4663 started');
  return {client,close:async()=>{const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}};
}
test('isolated local 4663 executes seven real CREATE transactions and validates links, immutables, receipts, recovery and profiles', {timeout:120000},async()=>{
  const local=await localChain(),{client}=local,root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-deploy-4663-')));
  try{
    // Test-only always-reject verifiers, compiled only in memory. Never a final release.
    const compiled=await fixtureContracts(),account=privateKeyToAccount(generatePrivateKey());
    await client.request({method:'anvil_setBalance',params:[account.address,'0x56bc75e2d63100000']});
    // Isolated fake USDG only supplies its decimals getter. No public chain state is written.
    const tokenCode='0x600660005260206000f3',fixtureConfig=structuredClone(config),token=config.assets.find(a=>a.symbol==='USDG');
    await client.request({method:'anvil_setCode',params:[token.address,tokenCode]});
    fixtureConfig.deployer.address=account.address;fixtureConfig.provider.address=account.address;fixtureConfig.guardian={address:privateKeyToAccount(generatePrivateKey()).address};
    fixtureConfig.codePins=fixtureConfig.codePins.map(p=>p.role==='usdg'?{...p,runtimeCodeHash:keccak256(tokenCode)}:p);
    const sha='aa'.repeat(32),production={releaseId:sha,build:{path:'artifacts/phase2-mainnet/contracts.json',sha256:sha},manifests:{joinsplit:{path:'protocol/phase2-mainnet/build/joinsplit/manifest.json',sha256:sha},'holder-exit':{path:'protocol/phase2-mainnet/build/holder-exit/manifest.json',sha256:sha}},parameters:{}};
    const release={config:fixtureConfig,artifacts:compiled.contracts,artifactSHA256:sha,sourceSetSHA256:compiled.sourceSetSHA256,production};
    const limits={budgetWei:'3000000000000000000',maxFeePerGasWei:'100000000000',reserveWei:'0'};
    let signed=0,sent=0;const tracked=Object.create(client);tracked.request=async call=>{if(call.method==='eth_sendRawTransaction')sent++;return client.request(call);};
    const signer=createMainnetSigner({client:tracked,address:account.address,root,...limits,signRawTransaction:async e=>{
      signed++;return account.signTransaction({chainId:4663,type:'legacy',nonce:Number(e.nonce),gas:BigInt(e.gas),gasPrice:BigInt(e.gasPrice),value:0n,data:e.data});
    }});
    const publisherFile=path.join(root,'config/phase2-asp-publisher-mainnet.json');await fs.mkdir(path.dirname(publisherFile),{recursive:true});
    await fs.writeFile(publisherFile,JSON.stringify({schema:'phase2-asp-operator-config/v1',deployment:{planId:'a-different-plan'}}));
    for(const guardian of [undefined,{address:account.address}]){
      const unguarded={...release,config:{...fixtureConfig,guardian}};
      await assert.rejects(()=>runMainnetDeployment({root,release:unguarded,client,signer,...limits,relayer:account.address}),{code:'MAINNET_GUARDIAN_INVALID'});
    }
    await assert.rejects(()=>runMainnetDeployment({root,release,client,signer,...limits,relayer:account.address}),{code:'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS'});assert.equal(sent,0);assert.equal(signed,0);
    await fs.unlink(publisherFile);
    const output=await runMainnetDeployment({root,release,client,signer,...limits,relayer:account.address});
    assert.equal(sent,7);assert.equal(signed,7);assert.equal(Object.keys(output.profiles).length,2);
    assert.equal(output.profiles.eth.pool.asset,'0x'+'00'.repeat(20));assert.equal(output.profiles.usdg.asset.decimals,6);
    assert.equal(output.profiles.eth.registry.provider,account.address);assert.equal(output.profiles.eth.registry.guardian,fixtureConfig.guardian.address);assert.equal(output.profiles.eth.relayer,account.address);
    assert.equal(output.profiles.eth.productionReady,false);assert.equal(output.profiles.eth.testOnly,false);assert.deepEqual(output.routesByPool,{eth:[],usdg:[]});
    assert.ok(BigInt(output.feeWei)>0n);assert.equal((await signer.status()).entries.every(e=>e.status==='confirmed'),true);
    assert.deepEqual(await runMainnetDeployment({root,release,client,signer,...limits,relayer:account.address}),output);assert.equal(sent,7);
    await assert.rejects(()=>runMainnetDeployment({root,release,client,signer,...limits,relayer:null}),{code:'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS'});assert.equal(sent,7);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'config/phase2-mainnet-deployed.json'))),output);
    const publisher=JSON.parse(await fs.readFile(publisherFile)),network=publisher.networks.mainnet;
    assert.equal(publisher.schema,'phase2-asp-operator-config/v1');assert.equal(publisher.policy,'all-current-notes');assert.equal(publisher.originScreening,false);assert.equal(publisher.artifactsPath,production.build.path);
    assert.equal(publisher.networks.testnet,null);assert.deepEqual(network.profiles,['config/phase2-mainnet-profiles/eth.json','config/phase2-mainnet-profiles/usdg.json']);
    assert.deepEqual(network.requiredPools,Object.values(output.profiles).map(p=>p.pool.address.toLowerCase()));assert.equal(network.publisher.signing.enabled,false);assert.equal(network.publisher.signing.address,account.address);
    for(const limit of ['budgetWei','maxGas','maxFeePerGasWei','reserveWei'])assert.equal(network.publisher.signing[limit],null);
    assert.deepEqual(network.publisher.mirrors,[{directory:'docker/runtime/phase2-mainnet-public/association',activeFile:'current.json'}]);
    assert.ok(network.directory.includes('/mainnet-publisher/'+output.planId));assert.ok(network.outputDirectory.endsWith(output.planId));
    for(const [i,file]of network.profiles.entries()){
      const profile=JSON.parse(await fs.readFile(path.join(root,file)));assert.deepEqual(profile,Object.values(output.profiles)[i]);
      assert.equal(normalizeProfile(profile).chainId,4663);assert.equal(profile.deployment.planId,output.planId);
    }
    const changed=structuredClone(publisher);changed.networks.mainnet.publisher.signing.enabled=true;await fs.writeFile(publisherFile,JSON.stringify(changed));
    await assert.rejects(()=>runMainnetDeployment({root,release,client,signer,...limits,relayer:account.address}),{code:'MAINNET_DEPLOYED_PROFILE_ALREADY_DIFFERS'});assert.equal(sent,7);
    await fs.writeFile(publisherFile,JSON.stringify(publisher));await fs.unlink(path.join(root,network.profiles[1]));
    assert.deepEqual(await runMainnetDeployment({root,release,client,signer,...limits,relayer:account.address}),output);assert.equal(sent,7);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,network.profiles[1]))),output.profiles.usdg);
    const entry=(await signer.status()).entries.find(e=>e.id.endsWith('pool:eth'));
    const step={hash:entry.hash,address:output.profiles.eth.pool.address,deployer:account.address,nonce:entry.nonce,data:entry.data};
    await assert.rejects(()=>verifyMainnetDeployment({client,step,artifact:compiled.contracts.Phase2ASPPool,
      libraries:Object.fromEntries(Object.entries(output.profiles.eth.libraries).map(([n,v])=>[n,v.address])),expectedGetters:{ASSET:token.address}}),{code:'MAINNET_DEPLOYED_IMMUTABLE_MISMATCH'});
    await client.request({method:'anvil_setCode',params:[step.address,'0x6000']});
    await assert.rejects(()=>verifyMainnetDeployment({client,step,artifact:compiled.contracts.Phase2ASPPool,
      libraries:Object.fromEntries(Object.entries(output.profiles.eth.libraries).map(([n,v])=>[n,v.address]))}),{code:'MAINNET_DEPLOYED_CODE_MISMATCH'});
    const libEntry=(await signer.status()).entries.find(e=>e.id.endsWith(':PoseidonT3')),libAddress=output.profiles.eth.libraries.PoseidonT3.address;
    const libraryCode=await client.getCode({address:libAddress});assert.ok(libraryCode.startsWith('0x73'));
    await client.request({method:'anvil_setCode',params:[libAddress,'0x73'+'00'.repeat(20)+libraryCode.slice(44)]});
    await assert.rejects(()=>verifyMainnetDeployment({client,step:{hash:libEntry.hash,address:libAddress,deployer:account.address,nonce:libEntry.nonce,data:libEntry.data},
      artifact:compiled.contracts.PoseidonT3,libraries:{}}),{code:'MAINNET_DEPLOYED_CODE_MISMATCH'});
  }finally{await local.close();await fs.rm(root,{recursive:true,force:true});}
});
test('optional UP/Router02 adapters and NVDA multi-hop actually deploy and publish usable route metadata on isolated 4663', {timeout:120000},async()=>{
  const local=await localChain(),{client}=local,root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-routes-4663-')));
  try{
    const compiled=await fixtureContracts(),account=privateKeyToAccount(generatePrivateKey()),fixtureConfig=structuredClone(config),selected=structuredClone(routes);
    await client.request({method:'anvil_setBalance',params:[account.address,'0x56bc75e2d63100000']});
    fixtureConfig.deployer.address=account.address;fixtureConfig.provider.address=account.address;fixtureConfig.guardian={address:privateKeyToAccount(generatePrivateKey()).address};
    fixtureConfig.assets.find(a=>a.symbol==='NVDA').depositCaps={schema:'lincoln-pool-deposit-caps/v1',unit:'asset-base-units',status:'configured',maxDepositUnits:'1000000000000000000',maxTotalUnits:'10000000000000000000'};
    const {default:solc}=await import('solc'),literal=address=>`address(bytes20(hex"${address.slice(2)}"))`;
    const role=name=>fixtureConfig.codePins.find(p=>p.role===name),weth=role('weth').address,usd=role('usdg').address,nvda=fixtureConfig.assets.find(a=>a.symbol==='NVDA').address;
    const unihop=selected[0].hops[0].address,uphop=selected[2].hops[0].address,nvhop=selected[4].hops[1].address;
    const pair=(a,b)=>`((a==${literal(a)}&&b==${literal(b)})||(a==${literal(b)}&&b==${literal(a)}))`;
    const source=`pragma solidity 0.8.28;
      contract UniRouter {function factory() external pure returns(address){return ${literal(role('uniFactory').address)};}function WETH9() external pure returns(address){return ${literal(weth)};}}
      contract UPRouter {function factory() external pure returns(address){return ${literal(role('upFactory').address)};}function WETH9() external pure returns(address){return ${literal(weth)};}}
      contract UniFactory {function getPool(address a,address b,uint24) external pure returns(address){if(${pair(weth,usd)})return ${literal(unihop)};if(${pair(usd,nvda)})return ${literal(nvhop)};return address(0);}}
      contract UPFactory {function getPool(address a,address b,int24) external pure returns(address){if(${pair(weth,usd)})return ${literal(uphop)};return address(0);}}`;
    const result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'fixtures.sol':{content:source}},settings:{outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));
    assert.ok(!result.errors?.some(e=>e.severity==='error'));
    const custom={uniRouter:result.contracts['fixtures.sol'].UniRouter.evm.deployedBytecode.object,upRouter:result.contracts['fixtures.sol'].UPRouter.evm.deployedBytecode.object,
      uniFactory:result.contracts['fixtures.sol'].UniFactory.evm.deployedBytecode.object,upFactory:result.contracts['fixtures.sol'].UPFactory.evm.deployedBytecode.object};
    for(const pin of fixtureConfig.codePins){
      if(!['usdg','weth','uniRouter','uniFactory','uniQuoter','upRouter','upFactory','upQuoter','stock-NVDA'].includes(pin.role))continue;
      const code='0x'+(custom[pin.role]??(pin.role==='usdg'?'600660005260206000f3':pin.role==='stock-NVDA'||pin.role==='weth'?'601260005260206000f3':'60006000f3'));
      await client.request({method:'anvil_setCode',params:[pin.address,code]});pin.runtimeCodeHash=keccak256(code);
    }
    for(const r of selected)for(const hop of r.hops){const code='0x60006000f3';await client.request({method:'anvil_setCode',params:[hop.address,code]});hop.runtimeCodeHash=keccak256(code);}
    const sha='bb'.repeat(32),production={releaseId:sha,build:{path:'fixture-only.json',sha256:sha},manifests:{joinsplit:{path:'fixture-j.json',sha256:sha},'holder-exit':{path:'fixture-e.json',sha256:sha}},parameters:{}};
    const release={config:fixtureConfig,artifacts:compiled.contracts,artifactSHA256:sha,sourceSetSHA256:compiled.sourceSetSHA256,production};
    const limits={budgetWei:'10000000000000000000',maxFeePerGasWei:'100000000000',reserveWei:'0'};
    const signer=createMainnetSigner({client,address:account.address,root,...limits,signRawTransaction:e=>account.signTransaction({chainId:4663,type:'legacy',nonce:Number(e.nonce),gas:BigInt(e.gas),gasPrice:BigInt(e.gasPrice),value:0n,data:e.data})});
    const output=await runMainnetDeployment({root,release,client,signer,routes:selected,...limits});
    assert.equal((await signer.status()).entries.length,14);assert.equal(output.routes.length,6);assert.ok(output.profiles.nvda);
    assert.equal(output.routesByPool.eth.length,3);assert.equal(output.routesByPool.usdg.length,2);assert.equal(output.routesByPool.nvda.length,1);
    const multi=output.routes.find(r=>r.id==='uniswap-eth-to-nvda');assert.equal(multi.hops.length,2);assert.equal(multi.adapterType,'Phase2Router02Adapter');
    assert.equal(multi.hops[1].tokenOut.toLowerCase(),nvda.toLowerCase());assert.equal(output.routes.find(r=>r.venue==='up').adapterType,'Phase2RouteAdapter');
    for(const route of output.routes)assert.ok(route.runtimeCodeHashes.adapter&&route.runtimeCodeHashes.quoter&&route.quoter&&route.sourcePool&&route.targetPool);
    const native=output.routesByPool.eth.find(r=>r.id===multi.id);assert.equal(native.targetProfile.pool.address,output.profiles.nvda.pool.address);
    // This test validates deployment, not swap execution or a mainnet release ceremony.
  }finally{await local.close();await fs.rm(root,{recursive:true,force:true});}
});
