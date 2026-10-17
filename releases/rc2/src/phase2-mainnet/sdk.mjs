// SPDX-License-Identifier: Apache-2.0
// Shared note algorithms, with mandatory finalized production parameter loading.
export * from '../phase2-asp/sdk.mjs';
import {normalizeProfile,PRODUCTION_PROFILE_SCHEMA,proveJoinSplit as proveJoin,proveHolderExit as proveExit} from '../phase2-asp/sdk.mjs';
export {loadProductionRelease} from './artifacts.mjs';
import {loadProductionRelease} from './artifacts.mjs';
function optionsFor(options){const profile=structuredClone(options?.profile);normalizeProfile(profile);if(profile.schema!==PRODUCTION_PROFILE_SCHEMA)throw new Error('MAINNET_PRODUCTION_PROFILE_REQUIRED');return {...options,profile,productionProfile:profile};}
export async function proveJoinSplit(prepared,options){return proveJoin(prepared,optionsFor(options));}
export async function proveHolderExit(prepared,options){return proveExit(prepared,optionsFor(options));}
export async function verifyCircuitArtifacts(options){const {profile,rootDirectory,circuit='joinsplit'}=optionsFor(options);if(!['joinsplit','holder-exit'].includes(circuit))throw new Error('MAINNET_CIRCUIT_NAME_INVALID');const release=await loadProductionRelease({rootDirectory,profile}),final=release.circuits[circuit];return {manifest:final.manifest,manifestSHA256:final.manifestSHA256,wasm:final.files.wasm.absolute,zkey:final.files.zkey.absolute,vkey:JSON.parse(final.files.vkey.bytes.toString('utf8'))};}
