#!/usr/bin/env node
// Offline CREATE plans only: no RPC, signing, deployment or service-config mutation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { encodeDeployData, isAddress, keccak256 } from 'viem';
import { normalizeProfile, normalizeSwapRoute, NATIVE_ASSET } from '../../src/phase2-asp/sdk.mjs';
import { phase2Identity } from '../../src/phase2-asp/state.mjs';
import {MAINNET_FEE_ARTIFACT} from '../../src/phase2-fees/mainnet-release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_PATH = 'artifacts/phase2-fees/contracts.json';
const TYPES = Object.freeze({ Phase2RouteAdapter: 'Phase2FeeRouteAdapter', Phase2Router02Adapter: 'Phase2FeeRouter02Adapter' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function must(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function addr(value) { must(typeof value === 'string' && isAddress(value) && value.toLowerCase() !== NATIVE_ASSET, 'INVALID_PLAN_ADDRESS'); return value.toLowerCase(); }
function hash(value) { must(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value), 'INVALID_PLAN_HASH'); return value.toLowerCase(); }
function artifactHash(value) { must(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_PLAN_ARTIFACT_HASH'); return value; }

/** Produces reviewable unsigned initcode, never a runnable service routes array. */
export function planFeeAdapters({ sourceProfile, routes, treasury, feeBps = 20, feeArtifactBytes }) {
  must(Number.isSafeInteger(feeBps) && feeBps >= 1 && feeBps <= 100, 'INVALID_SERVICE_FEE_BPS');
  const payee = addr(treasury), source = normalizeProfile(sourceProfile);
  const sourceIdentity = phase2Identity(sourceProfile), genesisHash = hash(sourceProfile.genesisHash);
  const poolArtifactSHA256 = artifactHash(sourceProfile.artifactSHA256);
  must(Buffer.isBuffer(feeArtifactBytes) || feeArtifactBytes instanceof Uint8Array, 'FEE_ARTIFACT_BYTES_REQUIRED');
  const artifacts = JSON.parse(Buffer.from(feeArtifactBytes).toString('utf8')), meta = artifacts._meta;
  const mainnet=source.chainId===4663;
  must(mainnet?meta?.schema==='phase2-fees-production-build/v1'&&meta.releaseCandidate===true&&meta.experimental===false
    &&meta.testOnly===false&&meta.productionReady===false&&meta.deployed===false&&JSON.stringify(meta.allowedChainIds)==='[4663]'
    &&meta.coreRelease?.build?.sha256===poolArtifactSHA256
    :meta?.experimental === true && meta.productionReady === false && meta.deployed === false&&meta.allowedChainIds?.includes(source.chainId), 'UNSUPPORTED_FEE_ARTIFACT');
  if(mainnet)for(const name of ['joinsplit','holder-exit'])must(sourceProfile.production?.manifests?.[name]?.sha256===meta.coreRelease.manifests?.[name]?.sha256,'FEE_CORE_MANIFEST_MISMATCH');
  const entries = Object.entries(meta.sourceDigests ?? {}).sort(([a], [b]) => a.localeCompare(b));
  must(entries.length > 0 && entries.every(([filename, digest]) => typeof filename === 'string' && /^[a-f0-9]{64}$/.test(digest))
    && sha(JSON.stringify(entries)) === meta.sourceSetSHA256, 'FEE_SOURCE_SET_MISMATCH');
  must(Array.isArray(routes) && routes.length >= 1 && routes.length <= 64, 'INVALID_PLAN_ROUTES');
  const ids = new Set();
  const plannedAdapters = routes.map(entry => {
    must(entry && typeof entry.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(entry.id) && !ids.has(entry.id), 'INVALID_PLAN_ROUTE_ID');
    ids.add(entry.id);
    must(entry.executionEnabled !== false && (entry.route?.executionEnabled === undefined || entry.route.executionEnabled === true), 'ROUTE_EXECUTION_DISABLED');
    const previousType = entry.route?.adapterType ?? 'Phase2RouteAdapter';
    must(Object.hasOwn(TYPES, previousType), 'UNSUPPORTED_PLAN_ADAPTER');
    const target = normalizeProfile(entry.targetProfile), targetIdentity = phase2Identity(entry.targetProfile);
    must(target.chainId === source.chainId && hash(entry.targetProfile.genesisHash) === genesisHash
      && artifactHash(entry.targetProfile.artifactSHA256) === poolArtifactSHA256, 'ROUTE_PROFILE_MISMATCH');
    if(mainnet)for(const name of ['joinsplit','holder-exit'])must(entry.targetProfile.production?.manifests?.[name]?.sha256===meta.coreRelease.manifests?.[name]?.sha256,'FEE_CORE_MANIFEST_MISMATCH');
    const geometry = normalizeSwapRoute({ sourceProfile, targetProfile: entry.targetProfile, route: entry.route });
    must(previousType !== 'Phase2Router02Adapter' || geometry.protocol === 0, 'ROUTER02_REQUIRES_UNISWAP_V3');
    const excludedTreasuries = new Set([source.pool, target.pool, geometry.adapter, geometry.router, geometry.wrappedNative,
      geometry.factory, ...geometry.tokens, ...(entry.route.hops ?? []).map(hop => addr(hop.pool))]);
    must(!excludedTreasuries.has(payee), 'UNSAFE_FEE_TREASURY');
    const adapterType = TYPES[previousType], contract = artifacts[adapterType];
    must(Array.isArray(contract?.abi) && /^0x[0-9a-f]+$/i.test(contract.bytecode)
      && Object.keys(contract.linkReferences ?? {}).length === 0, 'INVALID_FEE_ADAPTER_ARTIFACT');
    const constructorArguments = [source.pool, target.pool, geometry.router, geometry.wrappedNative,
      geometry.protocol, geometry.path, feeBps, payee];
    const data = encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode, args: constructorArguments });
    // Do not spread the original route: that would accidentally retain the old
    // adapter address/runtime pin in a shape a relayer could consume.
    return {
      id: entry.id, adapterType, sourceProfileIdentity: sourceIdentity, targetProfileIdentity: targetIdentity,
      previousAdapter: { address: geometry.adapter, adapterType: previousType,
        runtimeCodeHash: entry.route.runtimeCodeHashes?.adapter === undefined ? null : hash(entry.route.runtimeCodeHashes.adapter) },
      newAdapter: { address: null, runtimeCodeHash: null, status: 'awaitDeployment' },
      executionEnabled: false, constructorArguments, initcodeHash: keccak256(data),
      unsignedCreateTransaction: { chainId: source.chainId, from: null, to: null, data, value: '0', nonce: null, gas: null },
      requiredBeforeActivation: ['Deploy the reviewed initcode with an explicitly authorized signer and budget.',
        'Verify the receipt, actual address, runtime code, immutable fee/treasury, pools, router and path on the intended chain.',
        'Create a separate pinned service route entry using the NEW verified address and runtime hash; run end-to-end acceptance.'],
    };
  });
  return { schema: 'phase2-fee-adapter-deployment-plan/v1', planOnly: true, executionEnabled: false,
    signing: false, productionReady: false, deployableServiceConfig: false, rpcRequests: 0, broadcasts: 0,
    chainId: source.chainId, genesisHash, poolArtifactSHA256, treasury: payee, feeBps,
    feeArtifact: { path: mainnet?MAINNET_FEE_ARTIFACT:ARTIFACT_PATH, sha256: sha(feeArtifactBytes), sourceSetSHA256: meta.sourceSetSHA256 },
    plannedAdapters,
    limitations: ['Offline validation does not establish current on-chain code, pool existence, balances, liquidity, gas or fees.',
      'No deployer or nonce was selected; new adapter addresses and runtime hashes deliberately remain null.',
      'Existing free adapters and service configurations are not changed by this plan.',
      'The separate disabled 1inch experiment is not an available deployment target.'] };
}

async function readJSON(filename) {
  const bytes = await fs.readFile(filename); must(bytes.length <= 2 * 1024 * 1024, 'PLAN_INPUT_TOO_LARGE');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
export async function runPlanCLI(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    must(['--profile', '--routes', '--treasury', '--fee-bps', '--output'].includes(flag)
      && typeof argv[i + 1] === 'string' && argv[i + 1].length > 0 && !argv[i + 1].startsWith('--')
      && !Object.hasOwn(options, flag), 'INVALID_PLAN_ARGUMENTS');
    options[flag] = argv[i + 1];
  }
  must(options['--profile'] && options['--routes'] && options['--treasury'], 'PROFILE_ROUTES_TREASURY_REQUIRED');
  const rate = options['--fee-bps'] ?? '20'; must(/^(?:[1-9]|[1-9][0-9]|100)$/.test(rate), 'INVALID_SERVICE_FEE_BPS');
  const profilePath = path.resolve(options['--profile']), routesPath = path.resolve(options['--routes']);
  const profile = await readJSON(profilePath), routes = await readJSON(routesPath);
  const feeArtifactBytes = await fs.readFile(path.join(ROOT, ARTIFACT_PATH));
  const plan = planFeeAdapters({ sourceProfile: profile.value, routes: routes.value, treasury: options['--treasury'],
    feeBps: Number(rate), feeArtifactBytes });
  plan.inputs = { profile: { path: profilePath, sha256: sha(profile.bytes) }, routes: { path: routesPath, sha256: sha(routes.bytes) } };
  const content = JSON.stringify(plan, null, 2) + '\n';
  if (options['--output']) {
    const output = path.resolve(options['--output']);
    // A plan never overwrites an input, live config, or existing deployment file.
    await fs.writeFile(output, content, { flag: 'wx', mode: 0o644 });
    return { planOnly: true, plannedAdapters: plan.plannedAdapters.length, output };
  }
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runPlanCLI(), null, 2)); }
  catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
