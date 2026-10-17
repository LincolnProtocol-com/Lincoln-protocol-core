// SPDX-License-Identifier: BUSL-1.1
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createNewPoolPlan,GENESIS,DEPLOYER} from '../../scripts/operations/new-pools-mainnet-plan.mjs';
import {APPROVAL_SCHEMA,EXTENSION_LIMITS,NEW_PRICE_CAP,extensionGasPrice,validateDeploymentApproval,validateExtensionLedger,
  validateOutputPreflight,extensionAuthorizationHistory,initialPublicApproval,validateDeploymentBindingFlags,parseNewPoolDeploymentArguments,planNewPoolDeployment} from '../../scripts/operations/deploy-new-pools-mainnet.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
function fixture(){
  const plan={planId:'1'.repeat(64),identity:{policy:{sha256:'2'.repeat(64)},review:{sha256:'3'.repeat(64)}},
    pools:[{asset:{id:'aapl',depositCaps:{maxDepositUnits:'7200000000000000000',maxTotalUnits:'100000000000000000000'}}}],
    maximumProposedNewGasWei:'4800000000000000',verification:{issuerControlledAssets:['aapl'],blockers:['EXPLICIT_ISSUER_CONTROL_RISK_APPROVAL_REQUIRED:aapl']}};
  const approval={schema:APPROVAL_SCHEMA,status:'approved',chainId:4663,genesisHash:GENESIS,deployer:DEPLOYER,account:'lincoln-deployer',planId:plan.planId,
    policySHA256:plan.identity.policy.sha256,reviewSHA256:plan.identity.review.sha256,approvedAt:'2026-10-17T12:00:00Z',expiresAt:'2026-10-17T13:00:00Z',
    caps:[{id:'aapl',maxDepositUnits:'7200000000000000000',maxTotalUnits:'100000000000000000000'}],acceptedIssuerControls:['aapl'],limits:{...EXTENSION_LIMITS},
    newTransactionPriceCapWei:NEW_PRICE_CAP.toString(),maximumNewGasWei:plan.maximumProposedNewGasWei,scope:'four-pools-and-six-uniswap-v3-fee-adapters-only'};
  return {plan,approval,acceptedIssuerControls:['aapl'],now:Date.parse('2026-10-17T12:05:00Z')};
}

test('scoped approval binds exact intent, quantities, lower price cap and existing cumulative limits',()=>{
  assert.ok(validateDeploymentApproval(fixture()));
  for(const field of ['planId','policySHA256','reviewSHA256']){const f=fixture();f.approval[field]='4'.repeat(64);assert.throws(()=>validateDeploymentApproval(f),{code:'EXTENSION_APPROVAL_BINDING'});}
  for(const mutate of [a=>a.caps[0].maxTotalUnits='101',a=>a.limits.budgetWei='100000000000000000',a=>a.newTransactionPriceCapWei='1000000000',a=>a.maximumNewGasWei='999']){
    const f=fixture();mutate(f.approval);assert.throws(()=>validateDeploymentApproval(f),{code:'EXTENSION_APPROVAL_SCOPE_OR_CAP_CHANGED'});
  }
});

test('issuer control acknowledgment cannot waive incomplete source/transfer/market review',()=>{
  for(const mutate of [f=>f.acceptedIssuerControls=[],f=>f.approval.acceptedIssuerControls=[],f=>f.approval.acceptedIssuerControls=['aapl','aapl']]){
    const f=fixture();mutate(f);assert.throws(()=>validateDeploymentApproval(f),{code:'EXTENSION_ISSUER_RISK_NOT_APPROVED'});
  }
  const f=fixture();f.plan.verification.blockers.push('TOKEN_SOURCE_REVIEW_REQUIRED:usde');assert.throws(()=>validateDeploymentApproval(f),{code:'EXTENSION_REVIEW_INCOMPLETE'});
});

test('approval expiration, future approval and unknown fields fail closed',()=>{
  const f=fixture();f.now=Date.parse(f.approval.expiresAt);assert.throws(()=>validateDeploymentApproval(f),{code:'EXTENSION_APPROVAL_EXPIRED_OR_INVALID'});
  const g=fixture();g.approval.approvedAt='2026-10-18T12:00:00Z';assert.throws(()=>validateDeploymentApproval(g),{code:'EXTENSION_APPROVAL_EXPIRED_OR_INVALID'});
  const h=fixture();h.approval.ignoreBudget=true;assert.throws(()=>validateDeploymentApproval(h),{code:'EXTENSION_APPROVAL_SHAPE'});
});

test('gas headroom uses base times two or base plus 0.02 gwei, capped at 0.1 gwei',()=>{
  assert.equal(extensionGasPrice(20000000n,20000000n),40000000n);
  assert.equal(extensionGasPrice(30000000n,30000000n),60000000n);
  assert.equal(extensionGasPrice(60000000n,60000000n),100000000n);
  assert.throws(()=>extensionGasPrice(100000001n,100000001n),{code:'EXTENSION_GAS_PRICE_EXCEEDED'});
});

function ledgerFixture(){
  const plan={planId:'1'.repeat(64)},specs=[{id:'pool:aapl',gasCap:'6000000'}];
  const entry={id:`deploy:${plan.planId}:pool:aapl`,data:'0x1234',to:null,value:'0',gas:'6000000',gasPrice:'40000000',nonce:'40',status:'prepared'};
  return {plan,specs,state:{entries:[entry]},journal:{schema:'phase2-mainnet-deployment/v1',steps:[]},dataFor:()=> '0x1234'};
}
test('unknown, signed, submitted and foreign reservations cannot be resumed or resent',()=>{
  assert.doesNotThrow(()=>validateExtensionLedger(ledgerFixture()));
  for(const status of ['unknown','signed','submitted','broadcasting']){const f=ledgerFixture();f.state.entries[0].status=status;assert.throws(()=>validateExtensionLedger(f),{code:'ACCOUNT_UNKNOWN_BROADCAST'});}
  const foreign=ledgerFixture();foreign.state.entries[0].id='other-intent';assert.throws(()=>validateExtensionLedger(foreign),{code:'ACCOUNT_UNKNOWN_BROADCAST'});
  const signed=ledgerFixture();signed.state.entries[0].hash='0x'+'a'.repeat(64);assert.throws(()=>validateExtensionLedger(signed),{code:'ACCOUNT_UNKNOWN_BROADCAST'});
});
test('ledger intents and step order cannot be silently changed on resume',()=>{
  for(const [key,value]of [['gasPrice','100000001'],['gas','5000000'],['data','0xabcd'],['value','1'],['status','reverted']]){
    const f=ledgerFixture();f.state.entries[0][key]=value;assert.throws(()=>validateExtensionLedger(f),{code:'EXTENSION_LEDGER_INTENT_MISMATCH'});
  }
  const f=ledgerFixture();f.journal.steps=[{id:'pool:usde'}];assert.throws(()=>validateExtensionLedger(f),{code:'EXTENSION_JOURNAL_ORDER'});
  const g=ledgerFixture();g.state.entries[0].status='confirmed';assert.throws(()=>validateExtensionLedger(g),{code:'EXTENSION_CONFIRMED_STEP_MISSING'});
});

test('a foreign or prematurely existing output is rejected before any new transaction',()=>{
  const f=ledgerFixture();f.existing=[{value:{planId:f.plan.planId}}];
  assert.throws(()=>validateOutputPreflight(f),{code:'EXTENSION_OUTPUT_EXISTS_BEFORE_COMPLETION'});
  f.journal.steps=[{id:'pool:aapl',status:'verified'}];f.state.entries[0].status='confirmed';assert.doesNotThrow(()=>validateOutputPreflight(f));
  f.existing[0].value.planId='f'.repeat(64);assert.throws(()=>validateOutputPreflight(f),{code:'EXTENSION_FOREIGN_OUTPUT_EXISTS'});
});

test('approval renewal appends a digest chain without changing initial intent or permitting history rollback',()=>{
  const f=fixture(),first='a'.repeat(64),second='b'.repeat(64);
  const args={initialApprovalSHA256:first,approval:f.approval,approvalPath:'config/approval.json',plan:f.plan};
  const h1=extensionAuthorizationHistory({...args,history:[],approvalSHA256:first});
  const h2=extensionAuthorizationHistory({...args,history:h1,approvalSHA256:second});
  assert.equal(h1.length,1);assert.equal(h2.length,2);assert.deepEqual(h2[0],h1[0]);assert.equal(h2[1].previousSHA256,h1[0].digest);
  assert.deepEqual(extensionAuthorizationHistory({...args,history:h2,approvalSHA256:second}),h2);
  assert.throws(()=>extensionAuthorizationHistory({...args,history:h2,approvalSHA256:first}),{code:'EXTENSION_APPROVAL_HISTORY_ROLLBACK'});
  const broken=structuredClone(h2);broken[0].approvalSHA256='c'.repeat(64);
  assert.throws(()=>extensionAuthorizationHistory({...args,history:broken,approvalSHA256:second}),{code:'EXTENSION_APPROVAL_HISTORY_INVALID'});
});

test('partial public output resumes byte-for-byte after an approval deadline renewal',()=>{
  const f=fixture(),first='a'.repeat(64),second='b'.repeat(64);
  const args={initialApprovalSHA256:first,approval:f.approval,plan:f.plan};
  const h1=extensionAuthorizationHistory({...args,history:[],approvalSHA256:first,approvalPath:'config/approval-initial.json'});
  const h2=extensionAuthorizationHistory({...args,history:h1,approvalSHA256:second,approvalPath:'config/approval-renewed.json'});
  const a={pins:{initialApprovalSHA256:first},authorizationHistory:h1},b={pins:{initialApprovalSHA256:first},authorizationHistory:h2};
  assert.deepEqual(initialPublicApproval(a),initialPublicApproval(b));
  assert.deepEqual(initialPublicApproval(b),{path:'config/approval-initial.json',sha256:first});
  assert.throws(()=>initialPublicApproval({pins:{initialApprovalSHA256:second},authorizationHistory:h2}),{code:'EXTENSION_INITIAL_APPROVAL_CHANGED'});
});

test('plan stays offline, lacks private file access and does not authorize deployment',async()=>{
  const a=await createNewPoolPlan({root}),b=await planNewPoolDeployment({root});
  assert.equal(a.planId,b.planId);assert.equal(b.pools.length,4);assert.equal(b.adapters.length,6);
  assert.equal(b.networkRequests,0);assert.equal(b.privateFilesRead,false);assert.equal(b.transactionsSigned,0);assert.equal(b.transactionsBroadcast,0);
  assert.equal(b.readyForBroadcast,false);assert.equal(b.deploymentApprovalValidated,false);
  assert.throws(()=>parseNewPoolDeploymentArguments(['--plan','--password-file','/tmp/password']),{code:'EXTENSION_PLAN_NO_PRIVATE_ARGUMENTS'});
});

test('deploy CLI rejects absent approval before imports, RPC or wallet access',()=>{
  const script=fileURLToPath(new URL('../../scripts/operations/deploy-new-pools-mainnet.mjs',import.meta.url));
  assert.throws(()=>execFileSync(process.execPath,[script,'--deploy'],{cwd:root,stdio:['ignore','pipe','pipe']}),error=>{
    assert.deepEqual(JSON.parse(error.stderr),{error:'EXTENSION_EXPLICIT_DEPLOY_ARGUMENTS_REQUIRED',automaticResend:false});return true;
  });
  assert.throws(()=>parseNewPoolDeploymentArguments(['--deploy','--account','lincoln-deployer','--account','different']),{code:'USAGE_NEW_POOL_DEPLOYMENT'});
  assert.throws(()=>parseNewPoolDeploymentArguments(['--plan','--arbitrary-rpc','https://example.invalid']),{code:'USAGE_NEW_POOL_DEPLOYMENT'});
});

test('shell deploy refuses missing approval bindings before TTY or password prompt',()=>{
  const wrapper=fileURLToPath(new URL('../../scripts/deploy-new-pools-mainnet.sh',import.meta.url));
  for(const args of [[],['--review','deployments/robinhood-mainnet/verification/four-pool-review.json'],
    ['--review','missing-review.json','--approval','missing-approval.json']]){
    assert.throws(()=>execFileSync('bash',[wrapper,'--deploy',...args],{cwd:root,stdio:['ignore','pipe','pipe']}),error=>{
      assert.deepEqual(JSON.parse(error.stderr),{error:'EXTENSION_EXPLICIT_DEPLOY_BINDINGS_REQUIRED',automaticResend:false});
      assert.equal(error.stdout.length,0);assert.ok(!error.stderr.toString().includes('Keystore password'));return true;
    });
  }
  assert.throws(()=>validateDeploymentBindingFlags({reviewPath:'x',approvalPath:'y',approvalSHA256:'a'.repeat(64),planId:'b'.repeat(64),policySHA256:'c'.repeat(64),reviewSHA256:'d'.repeat(64),acceptedIssuerControls:[]}),
    {code:'EXTENSION_EXPLICIT_DEPLOY_BINDINGS_REQUIRED'});
});
