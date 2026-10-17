// SPDX-License-Identifier: Apache-2.0
// Pure cap parsing and pre-signing gates; no node, wallet or chain is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {POOL_CAPS_SCHEMA,CAP_INCREASE_DELAY_SECONDS,poolDeploymentCaps} from '../src/phase2-mainnet/caps.mjs';
import {deploymentSpecs,runMainnetDeployment} from '../scripts/phase2-mainnet/deploy.mjs';

const config=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url)));
const routes=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet-routes-example.json',import.meta.url))).routes;
const UINT128_MAX=(1n<<128n)-1n;
const rawCaps=(maxDepositUnits='1',maxTotalUnits='2')=>({schema:POOL_CAPS_SCHEMA,unit:'asset-base-units',status:'configured',maxDepositUnits,maxTotalUnits});
const parse=(caps,options)=>poolDeploymentCaps({depositCaps:caps},options);

test('cap integers accept exact one-unit and uint128 boundaries without number conversion or input mutation',()=>{
  assert.equal(CAP_INCREASE_DELAY_SECONDS,43200);
  for(const [deposit,total]of [[1n,1n],[1n,UINT128_MAX],[UINT128_MAX,UINT128_MAX]]){
    const input=Object.freeze(rawCaps(String(deposit),String(total))),before=JSON.stringify(input);
    assert.deepEqual(parse(input,{required:true}),{maxDeposit:deposit,maxTotal:total});
    assert.equal(JSON.stringify(input),before);
  }
});

test('both raw cap fields reject noncanonical, rounded, missing and overflowing values',()=>{
  const values=[undefined,null,0,1,1n,{},[],true,'','0','00','01','-1','+1',' 1','1 ','1\n','1\r\n','1\t','1.0','1e18','0x10',
    String(UINT128_MAX+1n),'9'.repeat(1000)];
  for(const field of ['maxDepositUnits','maxTotalUnits'])for(const value of values){
    const caps=rawCaps('1',String(UINT128_MAX));caps[field]=value;
    assert.throws(()=>parse(caps),{code:'MAINNET_POOL_CAPS_INVALID'},`${field}: ${String(value).slice(0,50)}`);
  }
});

test('cap schema, unit, status and ordering are mandatory',()=>{
  for(const change of [{schema:undefined},{schema:'lincoln-pool-deposit-caps/v2'},{unit:'shares'},{unit:'USD'},{status:undefined},{status:'unlimited'}]){
    assert.throws(()=>parse({...rawCaps(),...change}),{code:'MAINNET_POOL_CAPS_INVALID'});
  }
  assert.throws(()=>parse(rawCaps('3','2')),{code:'MAINNET_POOL_CAPS_INVALID'});
});

test('unresolved valuations never become caps merely because dollar targets or raw-looking numbers exist',()=>{
  for(const asset of [undefined,{}, {symbol:'ETH',decimals:18},
    {symbol:'NVDA',depositCaps:{status:'valuation-required',maxDepositUnits:'2500',maxTotalUnits:'25000',
      valuationTargets:{singleDepositUsd:'2500',poolTotalUsd:'25000'}}}]){
    assert.equal(poolDeploymentCaps(asset),null);
    assert.throws(()=>poolDeploymentCaps(asset,{required:true}),{code:'MAINNET_POOL_CAPS_UNSET'});
  }
});

test('launch configuration preserves exact ETH/USDG units and fixes seven stock caps without enabling stock deployment',async()=>{
  const eth=config.assets.find(asset=>asset.symbol==='ETH'),usdg=config.assets.find(asset=>asset.symbol==='USDG');
  assert.equal(eth.decimals,18);assert.equal(usdg.decimals,6);
  assert.deepEqual(poolDeploymentCaps(eth,{required:true}),{maxDeposit:1000000000000000000n,maxTotal:20000000000000000000n});
  assert.deepEqual(poolDeploymentCaps(usdg,{required:true}),{maxDeposit:2500000000n,maxTotal:50000000000n});
  const source=await fs.readFile(new URL('../'+config.stockCapSource.path,import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),config.stockCapSource.sha256);
  const stocks=JSON.parse(source);
  assert.deepEqual(config.assets.slice(2).map(asset=>asset.symbol),['NVDA','SPY','META','TSLA','GOOGL','QQQ','MSTR']);
  assert.equal(config.assets.some(asset=>asset.symbol==='AAPL'),false);
  for(const stock of stocks.assets){
    const asset=config.assets.find(item=>item.symbol===stock.symbol);
    assert.equal(asset.address,stock.token);assert.equal(asset.decimals,18);
    assert.deepEqual(poolDeploymentCaps(asset,{required:true}),{maxDeposit:BigInt(stock.maxDepositRaw),maxTotal:BigInt(stock.maxTotalRaw)});
    assert.equal(asset.depositCaps.valuation.tokenAsk,stock.tokenAsk);
    assert.equal(asset.depositCaps.valuation.quotedAt,stock.quotedAt);
    assert.equal(asset.stockPoolEnabled,false);
    assert.equal(asset.depositCaps.valuation.liveLiquidityAccepted,false);
    assert.equal(asset.depositCaps.valuation.mainnetForkAccepted,false);
  }
  assert.equal(config.deployment.stockPoolsEnabled,false);
  assert.equal(config.deployment.stocksRouteActivationPending,true);
  assert.equal(config.deployer.address,null);
  for(const key of ['gasBudgetWei','maxTotalFundingWei','maxDepositWei','maxFeePerGasWei'])assert.equal(config.limits[key],null);
});

test('default specs remain ETH/USDG only while explicit NVDA route plans use its approved integer caps',()=>{
  const core=deploymentSpecs({config});
  assert.deepEqual(core.filter(spec=>spec.asset).map(spec=>spec.assetId),['eth','usdg']);
  assert.deepEqual(core.find(spec=>spec.assetId==='usdg').depositCaps,{maxDepositUnits:'2500000000',maxTotalUnits:'50000000000'});
  const planned=deploymentSpecs({config,routes});
  assert.deepEqual(planned.find(spec=>spec.assetId==='nvda').depositCaps,{maxDepositUnits:'11400000000000000000',maxTotalUnits:'114000000000000000000'});
  assert.equal(config.deployer.address,null);
});

function forbiddenIO(){
  const touched=[];
  const poison=kind=>new Proxy({},{get(_target,key){touched.push(`${kind}.${String(key)}`);throw new Error('UNEXPECTED_IO_BEFORE_CAP_GATE');}});
  return {client:poison('client'),signer:poison('signer'),touched};
}
// Sufficient synthetic fixture limits only. The guarded calls must never read
// signer/client properties, create a signer ledger, or attempt a transaction.
const fixtureLimits={budgetWei:'10000000000000000000',maxFeePerGasWei:'1000000000',reserveWei:'0'};
async function rejectBeforeIO(configuration,{expected,routes:selected=[]}){
  const io=forbiddenIO(),release={config:configuration,artifacts:{},artifactSHA256:'a'.repeat(64),sourceSetSHA256:'b'.repeat(64),production:{}};
  await assert.rejects(()=>runMainnetDeployment({release,client:io.client,signer:io.signer,routes:selected,...fixtureLimits}),{code:expected});
  assert.deepEqual(io.touched,[]);
}
const withSyntheticDeployer=()=>{const copy=structuredClone(config);copy.deployer.address='0x'+'19'.repeat(20);return copy;};

test('missing, zero or malformed mainnet deployer rejects before any signer or RPC access',async()=>{
  for(const address of [null,undefined,'','not-an-address','0x'+'00'.repeat(20)]){
    const copy=structuredClone(config);copy.deployer.address=address;
    await rejectBeforeIO(copy,{expected:'MAINNET_DEPLOYER_UNSET'});
  }
});

test('selecting unresolved NVDA routes rejects before any signer or RPC access',async()=>{
  const copy=withSyntheticDeployer();
  const nvda=copy.assets.find(asset=>asset.symbol==='NVDA');
  nvda.depositCaps={...nvda.depositCaps,status:'valuation-required',maxDepositUnits:null,maxTotalUnits:null};
  await rejectBeforeIO(copy,{routes,expected:'MAINNET_POOL_CAPS_UNSET'});
});

test('missing required core caps and malformed selected caps reject before signer or RPC access',async()=>{
  for(const symbol of ['ETH','USDG']){
    const copy=withSyntheticDeployer();delete copy.assets.find(asset=>asset.symbol===symbol).depositCaps;
    await rejectBeforeIO(copy,{expected:'MAINNET_POOL_CAPS_UNSET'});
  }
  const copy=withSyntheticDeployer();copy.assets.find(asset=>asset.symbol==='ETH').depositCaps=rawCaps('100','1');
  await rejectBeforeIO(copy,{expected:'MAINNET_POOL_CAPS_INVALID'});
});
