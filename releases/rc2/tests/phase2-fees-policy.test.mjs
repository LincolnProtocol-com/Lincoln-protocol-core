import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeServiceFeePolicy,createLaunchServiceFeePolicy,quoteServiceFee,validateCommercialFee,
  DEFAULT_SERVICE_FEE_BPS,MAINNET_FEE_TREASURY} from '../src/phase2-fees/policy.mjs';
const legacy={schema:'lincoln-service-fees/v1',id:'launch-20bps-v1',serviceFeeBps:20,gasFeeUnits:'3',transferServiceFeeUnits:'2'};
const launch=()=>createLaunchServiceFeePolicy({asset:'ETH',gasFeeUnits:'3'});
const quote=(kind,grossAmount='0',policy=launch())=>quoteServiceFee({policy,kind,grossAmount});
const swap=(bps=30,treasury=MAINNET_FEE_TREASURY)=>({kind:'swap',routeEntry:{route:{adapterType:'Phase2FeeRouteAdapter',feeBps:bps,treasury}}});

test('v1 defaults and historical testnet quotes keep their original 20bps semantics',()=>{
  assert.equal(DEFAULT_SERVICE_FEE_BPS,30);assert.equal(normalizeServiceFeePolicy().schema,'lincoln-service-fees/v1');
  assert.equal(normalizeServiceFeePolicy().serviceFeeBps,20);
  const q=quote('withdrawal','100000',legacy);assert.equal(q.percentageServiceFee,'200');assert.equal(q.quotedGasFee,'3');assert.equal(q.totalFee,'203');assert.equal(q.netRecipientAmount,'99797');
  assert.equal(quote('private-transfer','0',legacy).totalFee,'5');assert.equal(quote('holder-exit','100000',legacy).totalFee,'3');
  for(const kind of ['ragequit','deposit'])assert.equal(quote(kind,'0',legacy).totalFee,'0');
  assert.equal(q.schema,'lincoln-service-fee-quote/v1');
  validateCommercialFee({kind:'transact',extData:{publicOut:100000n,fee:203n}},legacy);
  validateCommercialFee(swap(20),legacy);
  assert.throws(()=>validateCommercialFee(swap(30),legacy),/SWAP_SERVICE_FEE_POLICY_MISMATCH/);
});

test('launch withdrawal and holder exit each cost 30bps plus the same fixed asset-unit quote',()=>{
  const p=launch();assert.equal(p.schema,'lincoln-service-fees/v2');assert.equal(p.swap.treasury,MAINNET_FEE_TREASURY);
  for(const kind of ['withdrawal','holder-exit']){
    const q=quote(kind,'100000',p);assert.equal(q.serviceFeeBps,30);assert.equal(q.percentageServiceFee,'300');
    assert.equal(q.quotedGasFee,'3');assert.equal(q.totalFee,'303');assert.equal(q.netRecipientAmount,'99697');
    assert.equal(q.schema,'lincoln-service-fee-quote/v2');assert.equal(q.feeAsset,'current-pool-asset');
    assert.equal(q.protocolFeeMandatory,false);assert.equal(q.transactionsSent,false);
  }
});

test('launch private payments, deposits and original ragequit charge zero including relayer gas',()=>{
  for(const kind of ['private-transfer','ragequit','deposit']){
    const q=quote(kind);assert.equal(q.totalFee,'0');assert.equal(q.quotedGasFee,'0');assert.equal(q.percentageServiceFee,'0');
  }
  assert.throws(()=>quote('private-transfer','1000'),/PRIVATE_PAYMENT_AMOUNT_NOT_REQUIRED/);
  validateCommercialFee({kind:'transact',extData:{publicOut:'0',fee:'0'}},launch());
  validateCommercialFee({kind:'ragequit',extData:{fee:'0'},signals:['1','2','100000']},launch());
  validateCommercialFee({kind:'deposit',extData:{fee:'0'}},launch());
});

test('swap percentage is on measured output, independent of the withdrawal policy and fixed gas',()=>{
  const p=normalizeServiceFeePolicy({...launch(),withdrawal:{bps:75,includesGas:false},holderExit:{bps:40,includesGas:false}});
  const q=quote('swap','10000',p);assert.equal(q.totalFee,'30');assert.equal(q.netRecipientAmount,'9970');
  assert.equal(q.quotedGasFee,'0');assert.equal(q.feeAsset,'swap-output-asset');
  validateCommercialFee(swap(),p);
  assert.throws(()=>validateCommercialFee(swap(75),p),/SWAP_SERVICE_FEE_POLICY_MISMATCH/);
  assert.throws(()=>validateCommercialFee(swap(30,'0x'+'12'.repeat(20)),p),/SWAP_SERVICE_FEE_TREASURY_MISMATCH/);
  assert.throws(()=>validateCommercialFee({kind:'swap',routeEntry:{route:{adapterType:'Phase2RouteAdapter',feeBps:30}}},p),/PAID_SWAP_ADAPTER_REQUIRED/);
});

test('new-job validation rejects underpayment and overpayment before any signing',()=>{
  const p=launch(),normal={kind:'transact',extData:{publicOut:'100000',fee:'303'}};
  validateCommercialFee(normal,p);validateCommercialFee({kind:'holderExit',extData:{fee:'303'},signals:['1','2','100000']},p);
  for(const fee of ['0','302','304'])assert.throws(()=>validateCommercialFee({...normal,extData:{...normal.extData,fee}},p),/SERVICE_FEE_QUOTE_MISMATCH/);
  for(const kind of ['ragequit','deposit'])assert.throws(()=>validateCommercialFee({kind,extData:{fee:'1'}},p),/SERVICE_FEE_QUOTE_MISMATCH/);
  validateCommercialFee({kind:'transact',extData:{publicOut:'0',fee:'0'}},null);
});

test('gas quote must be explicitly selected per asset; only ETH has a preset and an ETH cap',()=>{
  assert.equal(createLaunchServiceFeePolicy({asset:'ETH'}).gasFeeUnits,'20000000000000');
  assert.equal(createLaunchServiceFeePolicy({asset:'ETH',gasFeeUnits:'200000000000000'}).gasFeeUnits,'200000000000000');
  assert.throws(()=>createLaunchServiceFeePolicy({asset:'ETH',gasFeeUnits:'200000000000001'}),/SERVICE_FEE_GAS_QUOTE_ABOVE_ETH_CAP/);
  for(const asset of ['USDG','NVDA']){
    assert.throws(()=>createLaunchServiceFeePolicy({asset}),/SERVICE_FEE_GAS_QUOTE_REQUIRED/);
    assert.equal(createLaunchServiceFeePolicy({asset,gasFeeUnits:'7'}).gasFeeUnits,'7');
  }
  assert.throws(()=>createLaunchServiceFeePolicy(),/SERVICE_FEE_ASSET_REQUIRED/);
  const p=launch();assert.throws(()=>{delete p.gasFeeUnits;},TypeError);
});

test('configurable operation rates and gas inclusion do not alter launch defaults',()=>{
  const p=normalizeServiceFeePolicy({...launch(),withdrawal:{bps:0,includesGas:false},
    holderExit:{bps:50,includesGas:true},privateTransfer:{fixedUnits:'7',includesGas:true}});
  assert.equal(quote('withdrawal','100000',p).totalFee,'0');
  assert.equal(quote('holder-exit','100000',p).totalFee,'503');assert.equal(quote('private-transfer','0',p).totalFee,'10');
  assert.equal(launch().withdrawal.bps,30);assert.equal(launch().privateTransfer.includesGas,false);
  for(const value of [p,p.withdrawal,p.holderExit,p.ragequit,p.swap,p.privateTransfer,p.deposit])assert.equal(Object.isFrozen(value),true);
});

test('integer arithmetic rounds down and rejects confiscating or overflowing charges',()=>{
  const noGas=normalizeServiceFeePolicy({...launch(),gasFeeUnits:'0'});
  assert.equal(quote('withdrawal','333',noGas).percentageServiceFee,'0');
  assert.equal(quote('withdrawal','334',noGas).percentageServiceFee,'1');
  assert.throws(()=>quote('withdrawal','3'),/SERVICE_FEE_EXCEEDS_OUTPUT/);
  const p=normalizeServiceFeePolicy({...launch(),gasFeeUnits:((1n<<128n)-1n).toString()});
  assert.throws(()=>quote('withdrawal',((1n<<128n)-1n).toString(),p),/SERVICE_FEE_OVERFLOW/);
  for(const bad of ['01','-1','1.2',1,(1n<<128n).toString()])assert.throws(()=>normalizeServiceFeePolicy({...launch(),gasFeeUnits:bad}),/INVALID_SERVICE_FEE_UNITS/);
});

test('malformed policies, accessors, unknown fields and unsupported protocol charges fail closed',()=>{
  for(const bps of [-1,101,0.3,'30'])assert.throws(()=>normalizeServiceFeePolicy({...launch(),withdrawal:{bps,includesGas:true}}),/INVALID_SERVICE_FEE_BPS/);
  assert.throws(()=>normalizeServiceFeePolicy({...legacy,serviceFeeBps:0}),/INVALID_SERVICE_FEE_BPS/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),privateKey:'unused'}),/INVALID_SERVICE_FEE_POLICY/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),schema:'lincoln-service-fees/v3'}),/INVALID_SERVICE_FEE_POLICY/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),gasFeeUnits:undefined}),/SERVICE_FEE_GAS_QUOTE_REQUIRED/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),feeAsset:'ETH'}),/INVALID_SERVICE_FEE_ASSET/);
  for(const op of ['ragequit','deposit']){
    assert.throws(()=>normalizeServiceFeePolicy({...launch(),[op]:{bps:0,includesGas:true}}),/SERVICE_FEE_FREE_OPERATION_REQUIRED/);
    assert.throws(()=>normalizeServiceFeePolicy({...launch(),[op]:{bps:1,includesGas:false}}),/SERVICE_FEE_FREE_OPERATION_REQUIRED/);
  }
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),swap:{...launch().swap,includesGas:true}}),/INVALID_SWAP_FEE_POLICY/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),swap:{...launch().swap,immutable:false}}),/INVALID_SWAP_FEE_POLICY/);
  const nested={bps:30};Object.defineProperty(nested,'includesGas',{enumerable:true,get(){throw new Error('accessor executed');}});
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),withdrawal:nested}),/INVALID_SERVICE_FEE_POLICY/);
  assert.throws(()=>normalizeServiceFeePolicy({...launch(),swap:{...launch().swap,treasury:'0x'+'00'.repeat(20)}}),/INVALID_FEE_TREASURY/);
});
