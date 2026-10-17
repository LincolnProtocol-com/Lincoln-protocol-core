// SPDX-License-Identifier: Apache-2.0
// Pure structural/provenance validation for local acceptance evidence. This
// does not turn operator-produced JSON into an independently signed attestation.
export const ACCEPTANCE_COUNTS=Object.freeze({
  native:Object.freeze({checks:48,proofs:11,transactions:51}),
  fees:Object.freeze({checks:22,proofs:4,transactions:73}),
});
export const REQUIRED_NATIVE_CAP_CHECKS=Object.freeze([
  'real-pool-constructor-binds-explicit-raw-unit-deposit-caps',
  'full-accounted-pool-rejects-another-public-deposit',
  'non-guardian-cannot-pause-new-deposits',
  'paused-pool-rejects-new-deposits',
  'paused-and-lowered-caps-do-not-restrict-the-following-real-proof-spends-and-exits',
  'cap-increase-delay-is-twelve-hours-and-proposal-binds-exact-eta',
  'cap-increase-rejected-at-eleven-hours-fifty-nine-minutes-fifty-nine-seconds',
  'cap-increase-accepts-at-exact-twelve-hour-boundary',
  'replacement-cap-increase-rejected-at-original-proposal-eta',
  'replacement-cap-increase-rejected-one-second-before-own-twelve-hour-eta',
  'replacement-cap-increase-accepts-at-exact-own-twelve-hour-boundary',
  'independent-guardian-delayed-cap-increase-preserves-exit-accounting',
]);
const FEE_PROOFS=Object.freeze(['up-native-in:A-final-fee-swap-proof','up-native-in:B-final-normal-withdrawal-proof',
  'router02-native-out:A-final-fee-swap-proof','router02-native-out:B-final-normal-withdrawal-proof']);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const transactionHash=value=>typeof value==='string'&&/^0x[a-f0-9]{64}$/i.test(value)&&!/^0x0{64}$/i.test(value);
const nonempty=value=>typeof value==='string'&&value.length>0;
const multiset=values=>JSON.stringify([...values].sort());

/** release accepts the frozen release object (coreArtifactSHA256,
 * feeArtifactSHA256, files) or an explicit circuitManifestSHA256 map so the
 * freeze builder can validate reports before constructing its final inventory.
 */
function releaseBinding(release){
  need(release&&digest(release.coreArtifactSHA256)&&digest(release.feeArtifactSHA256)
    &&(release.chainId===undefined||release.chainId===4663),'CORE_ACCEPTANCE_RELEASE_INVALID');
  const manifests={};
  for(const circuit of ['joinsplit','holder-exit']){
    const matches=(release.files??[]).filter(ref=>ref.path===`protocol/phase2-mainnet/build/${circuit}/manifest.json`);
    need(matches.length<=1,'CORE_ACCEPTANCE_RELEASE_INVALID');
    const explicit=release.circuitManifestSHA256?.[circuit],listed=matches[0]?.sha256;
    need((explicit===undefined||listed===undefined||explicit===listed)&&digest(explicit??listed),'CORE_ACCEPTANCE_RELEASE_INVALID');
    manifests[circuit]=explicit??listed;
  }
  return {core:release.coreArtifactSHA256,fees:release.feeArtifactSHA256,manifests};
}
function proofIdentity(proof){return `${proof.circuit}:${proof.name??''}:${proof.manifestSHA256}`;}

/** Fresh report validation with optional current-release historical reference.
 * Counts intentionally live in one export for reviewed acceptance scope changes.
 */
export function validateAcceptanceReport({mode,report,release,reference}={}){
  need(Object.hasOwn(ACCEPTANCE_COUNTS,mode),'CORE_ACCEPTANCE_MODE_INVALID');
  const bound=releaseBinding(release),counts=ACCEPTANCE_COUNTS[mode];
  need(report&&report.schema===(mode==='native'?'phase2-final-parameter-acceptance/v1':'phase2-final-fee-parameter-acceptance/v1')
    &&report.chainId===4663&&report.passed===true&&report.localOnly===true&&report.publicTransactions===0
    &&report.mainnetDeployed===false&&report.productionReady===false,'CORE_ACCEPTANCE_REPORT_INVALID');
  need(typeof report.runId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(report.runId),'CORE_ACCEPTANCE_RUN_ID_INVALID');
  need(report.artifactSHA256===bound.core&&report.production?.build?.sha256===bound.core,'CORE_ACCEPTANCE_ARTIFACT_MISMATCH');
  for(const [key,count]of Object.entries(counts))need(Array.isArray(report[key])&&report[key].length===count,'CORE_ACCEPTANCE_SCOPE_MISMATCH');
  const checkNames=report.checks.map(check=>check?.name);
  need(checkNames.every(nonempty)&&new Set(checkNames).size===checkNames.length&&report.checks.every(check=>check.passed===true),'CORE_ACCEPTANCE_CHECKS_INVALID');
  for(const proof of report.proofs){
    need(proof&&Object.hasOwn(bound.manifests,proof.circuit)&&proof.offchainVerified===true&&proof.onchainVerified===true
      &&proof.manifestSHA256===bound.manifests[proof.circuit]
      &&(proof.name===undefined||nonempty(proof.name)),'CORE_ACCEPTANCE_PROOF_INVALID');
  }
  const hashes=report.transactions.map(tx=>tx?.hash);
  need(hashes.every(transactionHash)&&new Set(hashes.map(hash=>hash.toLowerCase())).size===hashes.length,'CORE_ACCEPTANCE_TRANSACTIONS_INVALID');
  if(mode==='native'){
    need(REQUIRED_NATIVE_CAP_CHECKS.every(name=>checkNames.includes(name)),'CORE_ACCEPTANCE_CAP_CHECKS_MISSING');
    need(report.proofs.filter(proof=>proof.circuit==='joinsplit').length===6
      &&report.proofs.filter(proof=>proof.circuit==='holder-exit').length===5,'CORE_ACCEPTANCE_PROOF_SCOPE_MISMATCH');
    need(report.profile?.artifactSHA256===bound.core&&report.profile.production?.build?.sha256===bound.core,
      'CORE_ACCEPTANCE_ARTIFACT_MISMATCH');
    need(report.finalReserve==='0'&&report.finalBalance==='0','CORE_ACCEPTANCE_FINAL_RESERVE_MISMATCH');
  }else{
    need(report.feeArtifactSHA256===bound.fees,'CORE_ACCEPTANCE_ARTIFACT_MISMATCH');
    need(report.realGroth16===true&&report.finalProductionParameterAcceptance===true&&report.provingParameterKind==='final-production'
      &&report.publicChainTransactions===0&&report.actualDEX===false&&report.mockRouter===true
      &&report.mockSourcePool===false&&report.mockTargetPool===false&&report.usesKeystore===false&&report.usesFork===false,
      'CORE_ACCEPTANCE_FEE_ASSURANCE_INVALID');
    need(report.proofs.every(proof=>proof.circuit==='joinsplit')
      &&multiset(report.proofs.map(proof=>proof.name))===multiset(FEE_PROOFS),'CORE_ACCEPTANCE_PROOF_SCOPE_MISMATCH');
    need(Array.isArray(report.scenarios)&&report.scenarios.length===2
      &&multiset(report.scenarios.map(scenario=>scenario.id))===multiset(['up-native-in','router02-native-out'])
      &&report.scenarios.every(scenario=>scenario.passed===true&&scenario.feeBps===30&&scenario.serviceFee==='30'
        &&scenario.BRecoveredAmount==='9970'&&scenario.BWithdrawnAmount==='9938'&&scenario.withdrawalFee==='32'
        &&scenario.sourceReserve==='0'&&scenario.targetReserve==='0'),'CORE_ACCEPTANCE_FEE_SCENARIO_MISMATCH');
  }
  if(reference!==undefined){
    validateAcceptanceReport({mode,report:reference,release});
    need(report.runId.toLowerCase()!==reference.runId.toLowerCase(),'CORE_ACCEPTANCE_REUSED_RUN');
    const priorHashes=new Set(reference.transactions.map(tx=>tx.hash.toLowerCase()));
    need(hashes.every(hash=>!priorHashes.has(hash.toLowerCase())),'CORE_ACCEPTANCE_REUSED_TRANSACTION');
    need(multiset(checkNames)===multiset(reference.checks.map(check=>check.name)),'CORE_ACCEPTANCE_CHECK_SCOPE_CHANGED');
    need(multiset(report.proofs.map(proofIdentity))===multiset(reference.proofs.map(proofIdentity)),'CORE_ACCEPTANCE_PROOF_SCOPE_CHANGED');
  }
  return {passed:true,mode,chainId:4663,runId:report.runId,coreArtifactSHA256:bound.core,
    ...(mode==='fees'?{feeArtifactSHA256:bound.fees}:{}),checks:counts.checks,proofs:counts.proofs,transactions:counts.transactions,
    referenceCompared:reference!==undefined,localOnly:true,publicTransactions:0};
}
