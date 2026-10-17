#!/usr/bin/env node
// Offline public contract-candidate inventory. Never authorizes deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateAcceptanceReport} from '../core/acceptance-report.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const OUTPUT='artifacts/phase2-mainnet/release-candidate-20261016-r2.json';
const sha=x=>createHash('sha256').update(x).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
export async function contractReleaseCandidate({root=ROOT}={}){
  root=await fs.realpath(root);const files=new Map();
  async function add(relative){
    need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')
      &&relative.split('/').every(p=>p&&!p.startsWith('.')),'RELEASE_PUBLIC_PATH_REQUIRED');
    const file=path.join(root,relative),stat=await fs.lstat(file);
    need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'RELEASE_REGULAR_FILE_REQUIRED');
    const bytes=await fs.readFile(file);files.set(relative,{path:relative,bytes:bytes.length,sha256:sha(bytes)});return bytes;
  }
  const json=async relative=>JSON.parse(await add(relative));
  const config=await json('config/phase2-mainnet.json');
  const corePath='artifacts/phase2-mainnet/contracts.json',feePath='artifacts/phase2-fees-mainnet/contracts.json';
  const core=await json(corePath),fee=await json(feePath),coreSHA=files.get(corePath).sha256,feeSHA=files.get(feePath).sha256;
  need(core._meta?.testOnly===false&&fee._meta?.testOnly===false
    &&isDeepStrictEqual(core._meta.allowedChainIds,[4663])&&isDeepStrictEqual(fee._meta.allowedChainIds,[4663])
    &&fee._meta.coreRelease?.build?.sha256===coreSHA,'RELEASE_BUILD_BINDING_INVALID');
  const registry=await add('protocol/phase2-mainnet/contracts/Phase2ASPRegistry.sol');
  need(/ACCEPTED_POLICY_WINDOW = 16;/.test(registry.toString()),'RELEASE_WINDOW_NOT_FINAL');
  for(const meta of [core._meta,fee._meta]){
    for(const [file,digest]of Object.entries(meta.sourceDigests))need(sha(await add(file))===digest,'RELEASE_SOURCE_CHANGED');
    for(const source of Array.isArray(meta.sourceDerivation)?meta.sourceDerivation:[meta.sourceDerivation]){
      need(sha(await add(source.source))===source.sourceSHA256,'RELEASE_DERIVATION_CHANGED');
      need(sha(await add(source.target))===source.derivedSourceSHA256,'RELEASE_DERIVATION_CHANGED');
    }
  }
  for(const name of ['joinsplit','holder-exit']){
    const binding=core._meta.circuits[name],manifest=await json(binding.manifest);
    need(files.get(binding.manifest).sha256===binding.manifestSHA256,'RELEASE_MANIFEST_CHANGED');
    for(const ref of [...Object.values(manifest.artifacts),manifest.phase1,...Object.values(manifest.beaconEvidence).filter(v=>v?.path)])
      need(sha(await add(ref.path))===ref.sha256,'RELEASE_PARAMETERS_CHANGED');
    const commitment=await json(manifest.beaconEvidence.commitment.path);
    for(const c of Object.values(commitment.body.circuits))need(sha(await add(c.zkey.path))===c.zkey.sha256,'RELEASE_PARENT_KEY_CHANGED');
  }
  for(const file of ['contracts/phase2-fees-mainnet.manifest.json','contracts/phase2-fees-mainnet.standard-input.json',
    'artifacts/phase2-fees-mainnet/launch-plan.json'])await add(file);
  const launch=await json('artifacts/phase2-fees-mainnet/launch-plan.json');
  need(launch.coreArtifactSHA256===coreSHA&&launch.feeArtifact.sha256===feeSHA&&launch.feeBps===30
    &&launch.treasury.toLowerCase()===config.treasury.address.toLowerCase(),'RELEASE_FEE_PLAN_CHANGED');
  const catalog=await json('abi/manifest.json');
  const contracts=catalog.contracts.filter(c=>['phase2-mainnet','phase2-fees-mainnet'].includes(c.group));
  need(contracts.length===10,'RELEASE_CONTRACT_SET_CHANGED');
  for(const entry of contracts){
    need(entry.source.sha256===(entry.group==='phase2-mainnet'?coreSHA:feeSHA),'RELEASE_ABI_BUILD_CHANGED');
    need(sha(await add(entry.path))===entry.abiSHA256,'RELEASE_ABI_CHANGED');
  }
  const native=await json('artifacts/phase2-mainnet/final-parameter-acceptance.json');
  const paid=await json('artifacts/phase2-mainnet/final-fee-parameter-acceptance.json');
  const reportRelease={coreArtifactSHA256:coreSHA,feeArtifactSHA256:feeSHA,
    circuitManifestSHA256:Object.fromEntries(Object.entries(core._meta.circuits).map(([name,c])=>[name,c.manifestSHA256]))};
  validateAcceptanceReport({mode:'native',report:native,release:reportRelease});
  validateAcceptanceReport({mode:'fees',report:paid,release:reportRelease});
  for(const report of [native,paid])need(report.passed===true&&report.localOnly===true&&report.publicTransactions===0
    &&report.artifactSHA256===coreSHA,'RELEASE_ACCEPTANCE_MISSING_OR_STALE');
  need(paid.feeArtifactSHA256===feeSHA&&paid.finalProductionParameterAcceptance===true&&paid.actualDEX===false,
    'RELEASE_FEE_ACCEPTANCE_MISSING_OR_STALE');
  need(paid.scenarios.length===2&&paid.scenarios.every(s=>s.passed&&s.feeBps===30&&s.gas.relayMaxGas==='5000000'
    &&BigInt(s.gas.paddedGas)<=5000000n),'RELEASE_FEE_GAS_EXCEEDS_CAP');
  const oldest=native.checks.find(c=>c.name==='oldest-of-sixteen-epochs-accepts-real-proof-under-relay-gas-cap');
  const maxRelayGas=config.limits?.maxRelayGas;
  need(maxRelayGas==='5000000'&&oldest?.passed&&BigInt(oldest.detail.gasEstimate)*12n/10n+10000n<=BigInt(maxRelayGas),
    'RELEASE_OLDEST_PROOF_GAS_EXCEEDS_CAP');
  const governance=await json('artifacts/phase2-mainnet/caps-governance-acceptance-20261016-r2.json');
  need(governance.passed===true&&governance.coreRelease?.sha256===coreSHA&&governance.foundry?.passed===68
    &&governance.nativeReportSHA256===files.get('artifacts/phase2-mainnet/final-parameter-acceptance.json').sha256,
    'RELEASE_GOVERNANCE_ACCEPTANCE_REQUIRED');
  const foundry=await json(governance.foundry.report.path);
  need(files.get(governance.foundry.report.path).sha256===governance.foundry.report.sha256,'RELEASE_FOUNDRY_REPORT_CHANGED');
  const testResults=Object.values(foundry).flatMap(suite=>Object.values(suite.test_results??{}));
  need(testResults.length===68&&testResults.every(t=>t.status==='Success'),'RELEASE_FOUNDRY_REPORT_NOT_PASSED');
  need(config.deployer.address===null&&config.deployer.signingAccount===null,'RELEASE_DEPLOYER_MUST_REMAIN_UNSET');
  need(config.launchFees?.dexFeeBps===30&&config.launchFees.withdrawalBps===30&&config.launchFees.holderExitBps===30
    &&config.launchFees.privateTransferUnits==='0'&&config.launchFees.ragequitUnits==='0','RELEASE_FEE_CONFIG_CHANGED');
  need(governance.localOnly===true&&governance.publicTransactions===0&&governance.mainnetDeployed===false
    &&governance.foundry.proofSoundnessTested===false,'RELEASE_GOVERNANCE_SCOPE_INVALID');
  for(const [relative,ref]of Object.entries(governance.inputs))
    need(sha(await add(relative))===ref.sha256,'RELEASE_GOVERNANCE_INPUT_CHANGED');
  const safe=await json(config.guardian.verificationReport);
  need(safe.verified===true&&safe.chainId===4663&&safe.threshold===2&&safe.ownerCount===3
    &&safe.address.toLowerCase()===config.guardian.address.toLowerCase()
    &&config.treasury.address.toLowerCase()===safe.address.toLowerCase(),'RELEASE_SAFE_BINDING_INVALID');
  const selection=await json('config/phase2-mainnet-routes-example.json');
  for(const file of ['scripts/phase2-mainnet/build.mjs','scripts/phase2-mainnet/verify-final-parameters.mjs',
    'scripts/phase2-mainnet/verify-fee-parameters.mjs','scripts/phase2-fees/build-mainnet.mjs','scripts/phase2-fees/plan-mainnet.mjs',
    'src/phase2-mainnet/sdk.mjs','src/phase2-mainnet/release.mjs','src/phase2-mainnet/artifacts.mjs',
    'src/phase2-mainnet/safe.mjs','src/phase2-mainnet/caps.mjs','scripts/phase2-mainnet/deploy.mjs',
    'scripts/phase2-mainnet/plan.mjs','scripts/phase2-mainnet/freeze-release.mjs','scripts/core/sync-abi.mjs',
    'scripts/core/acceptance.mjs','scripts/core/acceptance-report.mjs','scripts/core/build.mjs',
    'scripts/core/check-circuits.mjs','tests/core-acceptance-report.test.mjs',
    'src/phase2-fees/mainnet-release.mjs','src/phase2-fees/sdk.mjs','src/phase2-fees/policy.mjs',
    'src/phase2-asp/sdk.mjs','src/phase2-asp/state.mjs','tests/phase2-mainnet-caps.test.mjs',
    'tests/phase2-deposit-caps-state.test.mjs','tests/phase2-fees-policy.test.mjs',
    'tests/phase2-mainnet-caps-deploy-resume.test.mjs','audit/test-adaptations.json',
    'tests/phase2-mainnet-plan.test.mjs','tests/phase2-mainnet-deploy.test.mjs',
    'tests/phase2-fees-mainnet.test.mjs','tests/phase2-fees-sdk.test.mjs',
    'protocol/phase2-mainnet/foundry.toml','protocol/phase2-mainnet/fuzz/README.md',
    ...['Base.sol','Pool.t.sol','Caps.t.sol','Registry.t.sol','Adapter.t.sol','FeeAdapter.t.sol','Invariant.t.sol'].map(n=>'protocol/phase2-mainnet/fuzz/test/'+n)])await add(file);
  return {schema:'phase2-mainnet-contract-candidate/v1',releaseCandidate:true,productionReady:false,chainId:4663,
    coreArtifactSHA256:coreSHA,feeArtifactSHA256:feeSHA,contractCount:10,
    parameters:{guardian:config.guardian.address,treasury:config.treasury.address,provider:config.provider.address,
      dexFeeBps:30,withdrawalFeeBps:30,holderExitFeeBps:30,privateTransferFeeUnits:'0',ragequitFeeUnits:'0',
      capIncreaseDelaySeconds:86400,capPauseScope:'deposits-only',acceptedPolicyWindow:16,supersededPolicyGraceSeconds:3600,providerRotationDelaySeconds:259200,
      noteInputs:2,noteOutputs:2,merkleDepth:20,maxDexHops:4,maxRelayGas},
    selectedRouteIds:selection.routes.map(r=>r.id),
    depositCaps:config.assets.map(a=>({symbol:a.symbol,...a.depositCaps})),
    mainnetDeployer:null,feeRuntimeConfigured:false,
    validation:{native:{checks:native.checks.length,proofs:native.proofs.length,localTransactions:native.transactions.length,
      oldestEpochGasEstimate:oldest.detail.gasEstimate,oldestEpochPaddedGas:String(BigInt(oldest.detail.gasEstimate)*12n/10n+10000n)},
      fee:{checks:paid.checks.length,proofs:paid.proofs.length,localTransactions:paid.transactions.length,actualDEX:false,
        routeGas:paid.scenarios.map(({id,gas})=>({id,...gas}))},
      governanceReport:'artifacts/phase2-mainnet/caps-governance-acceptance-20261016-r2.json'},
    files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),
    mainnetDeployed:false,deploymentAuthorized:false,publicTransactions:0,audit:config.audit,
    limitations:['This inventory binds tested contract candidates and public artifacts; it is not an independent audit or public-chain acceptance.',
      'Fee DEX acceptance uses explicit mock routers/liquidity with real production pools, adapters and final proofs.',
      'Operational budgets, backend performance changes, Docker deployment and live route activation are separate.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    need(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--check','USAGE_FREEZE_RELEASE_CHECK');
    const candidate=await contractReleaseCandidate(),bytes=JSON.stringify(candidate,null,2)+'\n',file=path.join(ROOT,OUTPUT);
    if(process.argv[2]==='--check')need((await fs.readFile(file,'utf8'))===bytes,'RELEASE_CANDIDATE_CHANGED');
    else await fs.writeFile(file,bytes,{flag:'wx',mode:0o644});
    console.log(JSON.stringify({passed:true,checkOnly:process.argv[2]==='--check',file:OUTPUT,sha256:sha(bytes),publicTransactions:0}));
  }catch(error){console.error(error.code??error.message);process.exitCode=1;}
}
