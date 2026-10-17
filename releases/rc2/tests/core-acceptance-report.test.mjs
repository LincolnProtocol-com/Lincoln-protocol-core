import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAcceptanceReport,ACCEPTANCE_COUNTS,REQUIRED_NATIVE_CAP_CHECKS} from '../scripts/core/acceptance-report.mjs';
const digest=n=>n.toString(16).padStart(64,'0');
const release={coreArtifactSHA256:digest(1),feeArtifactSHA256:digest(2),circuitManifestSHA256:{joinsplit:digest(3),'holder-exit':digest(4)}};
const uuid=n=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const feeProofNames=['up-native-in:A-final-fee-swap-proof','up-native-in:B-final-normal-withdrawal-proof',
  'router02-native-out:A-final-fee-swap-proof','router02-native-out:B-final-normal-withdrawal-proof'];
function fixture(mode,seed=1){
  const counts=ACCEPTANCE_COUNTS[mode],critical=mode==='native'?REQUIRED_NATIVE_CAP_CHECKS:[];
  const checks=Array.from({length:counts.checks},(_,i)=>({name:critical[i]??`check-${i}`,passed:true}));
  const proof=(circuit,name)=>({circuit,manifestSHA256:release.circuitManifestSHA256[circuit],offchainVerified:true,onchainVerified:true,...(name?{name}:{})});
  const proofs=mode==='native'?Array.from({length:11},(_,i)=>proof(i<6?'joinsplit':'holder-exit')):feeProofNames.map(name=>proof('joinsplit',name));
  const report={schema:mode==='native'?'phase2-final-parameter-acceptance/v1':'phase2-final-fee-parameter-acceptance/v1',
    passed:true,chainId:4663,localOnly:true,publicTransactions:0,mainnetDeployed:false,productionReady:false,runId:uuid(seed),
    artifactSHA256:release.coreArtifactSHA256,production:{build:{sha256:release.coreArtifactSHA256}},checks,proofs,
    transactions:Array.from({length:counts.transactions},(_,i)=>({hash:'0x'+digest(seed*1000+i)}))};
  if(mode==='native')Object.assign(report,{profile:{artifactSHA256:release.coreArtifactSHA256,production:report.production},finalReserve:'0',finalBalance:'0'});
  else Object.assign(report,{feeArtifactSHA256:release.feeArtifactSHA256,realGroth16:true,finalProductionParameterAcceptance:true,
    provingParameterKind:'final-production',publicChainTransactions:0,actualDEX:false,mockRouter:true,mockSourcePool:false,mockTargetPool:false,
    usesKeystore:false,usesFork:false,scenarios:['up-native-in','router02-native-out'].map(id=>({id,passed:true,feeBps:30,serviceFee:'30',
      BRecoveredAmount:'9970',BWithdrawnAmount:'9938',withdrawalFee:'32',sourceReserve:'0',targetReserve:'0'}))});
  return report;
}
const validate=(mode,report,extra={})=>validateAcceptanceReport({mode,report,release,...extra});

test('valid native and fee evidence binds the selected release and compares fresh current-release reruns',()=>{
  for(const mode of ['native','fees']){
    assert.equal(validate(mode,fixture(mode)).passed,true);
    assert.equal(validate(mode,fixture(mode,2),{reference:fixture(mode)}).referenceCompared,true);
  }
  const listed={coreArtifactSHA256:release.coreArtifactSHA256,feeArtifactSHA256:release.feeArtifactSHA256,
    files:Object.entries(release.circuitManifestSHA256).map(([name,sha256])=>({path:`protocol/phase2-mainnet/build/${name}/manifest.json`,sha256}))};
  assert.equal(validate('fees',fixture('fees'),{release:listed}).passed,true);
});

test('a previous-release passed fee report cannot become current evidence by changing its run ID',()=>{
  const old=fixture('fees',2);old.artifactSHA256=digest(50);old.feeArtifactSHA256=digest(51);
  assert.throws(()=>validate('fees',old),/CORE_ACCEPTANCE_ARTIFACT_MISMATCH/);
  const same=fixture('fees');same.runId=uuid(2);
  assert.throws(()=>validate('fees',same,{reference:fixture('fees')}),/CORE_ACCEPTANCE_REUSED_TRANSACTION/);
  assert.throws(()=>validate('fees',fixture('fees'),{reference:fixture('fees')}),/CORE_ACCEPTANCE_REUSED_RUN/);
  const upper=fixture('fees',2);upper.runId=uuid(10).toUpperCase();
  assert.throws(()=>validate('fees',upper,{reference:fixture('fees',10)}),/CORE_ACCEPTANCE_REUSED_RUN/);
});

test('false proof checks, unknown circuit and wrong final manifest are rejected',()=>{
  for(const [key,value]of [['offchainVerified',false],['onchainVerified',false],['manifestSHA256',digest(77)],['circuit','fake']]){
    const report=fixture('native');report.proofs[0][key]=value;
    assert.throws(()=>validate('native',report),/CORE_ACCEPTANCE_PROOF_INVALID/);
  }
  const report=fixture('fees');report.proofs[0].name='unrelated-proof';
  assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_PROOF_SCOPE_MISMATCH/);
});

test('schema, chain, public transaction and release metadata must agree',()=>{
  for(const [key,value]of [['schema','old-schema'],['chainId',46630],['publicTransactions',1],['passed',false],['localOnly',false],['mainnetDeployed',true],['productionReady',true]]){
    const report=fixture('fees');report[key]=value;assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_REPORT_INVALID/);
  }
  const report=fixture('fees');report.production.build.sha256=digest(55);
  assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_ARTIFACT_MISMATCH/);
  assert.throws(()=>validate('native',fixture('native'),{release:{...release,coreArtifactSHA256:'invalid'}}),/CORE_ACCEPTANCE_RELEASE_INVALID/);
  assert.throws(()=>validate('native',fixture('native'),{release:{...release,chainId:46630}}),/CORE_ACCEPTANCE_RELEASE_INVALID/);
});

test('counts, unique passed check names and mandatory real-proof cap checks cannot be omitted',()=>{
  const omitted=fixture('native');omitted.checks.pop();assert.throws(()=>validate('native',omitted),/CORE_ACCEPTANCE_SCOPE_MISMATCH/);
  const failed=fixture('native');failed.checks[0].passed=false;assert.throws(()=>validate('native',failed),/CORE_ACCEPTANCE_CHECKS_INVALID/);
  const duplicate=fixture('native');duplicate.checks[1].name=duplicate.checks[0].name;assert.throws(()=>validate('native',duplicate),/CORE_ACCEPTANCE_CHECKS_INVALID/);
  for(const name of REQUIRED_NATIVE_CAP_CHECKS){const missing=fixture('native');missing.checks.find(check=>check.name===name).name='substituted-cap-check';assert.throws(()=>validate('native',missing),/CORE_ACCEPTANCE_CAP_CHECKS_MISSING/);}
});

test('transaction hashes must be valid and unique, including case-insensitive duplicates and historical reuse',()=>{
  for(const hash of ['0x1234','0x'+'00'.repeat(32),'0x'+'gg'.repeat(32),undefined]){
    const report=fixture('fees');report.transactions[0].hash=hash;assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_TRANSACTIONS_INVALID/);
  }
  const duplicate=fixture('fees');duplicate.transactions[0].hash='0x'+'ab'.repeat(32);duplicate.transactions[1].hash='0x'+'AB'.repeat(32);
  assert.throws(()=>validate('fees',duplicate),/CORE_ACCEPTANCE_TRANSACTIONS_INVALID/);
  const report=fixture('fees',2);report.transactions[0].hash=fixture('fees').transactions[5].hash;
  assert.throws(()=>validate('fees',report,{reference:fixture('fees')}),/CORE_ACCEPTANCE_REUSED_TRANSACTION/);
});

test('current-release reruns preserve the exact check and proof scenario multisets',()=>{
  const checks=fixture('native',2);checks.checks.at(-1).name='different-successful-test';
  assert.throws(()=>validate('native',checks,{reference:fixture('native')}),/CORE_ACCEPTANCE_CHECK_SCOPE_CHANGED/);
  const proofs=fixture('native',2);proofs.proofs[0].name='unexpected-scenario';
  assert.throws(()=>validate('native',proofs,{reference:fixture('native')}),/CORE_ACCEPTANCE_PROOF_SCOPE_CHANGED/);
});

test('fee evidence rejects legacy economics, unsupported execution claims and unexited reserves',()=>{
  for(const [key,value]of [['feeBps',20],['serviceFee','20'],['BRecoveredAmount','9980'],['BWithdrawnAmount','9970'],['withdrawalFee','0'],['targetReserve','1']]){
    const report=fixture('fees');report.scenarios[0][key]=value;assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_FEE_SCENARIO_MISMATCH/);
  }
  for(const [key,value]of [['realGroth16',false],['usesFork',true],['usesKeystore',true],['actualDEX',true],['mockSourcePool',true],['mockTargetPool',true]]){
    const report=fixture('fees');report[key]=value;assert.throws(()=>validate('fees',report),/CORE_ACCEPTANCE_FEE_ASSURANCE_INVALID/);
  }
  const native=fixture('native');native.finalReserve='1';assert.throws(()=>validate('native',native),/CORE_ACCEPTANCE_FINAL_RESERVE_MISMATCH/);
});
