#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Operational RC.3 wrapper. Frozen contracts, parameters and signer stay intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPublicClient,http,isAddress} from 'viem';
import {checkRC3Deployment,DEFAULT_RC3_DEPLOYMENT_DIRECTORY} from './mainnet-rc3.mjs';
import {sanitizeBroadcastError} from './recovery-validation.mjs';
import {readMainnetGasPolicy} from './mainnet-limits.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const MAINNET_DEPLOYMENT_RPC='https://rpc.mainnet.chain.robinhood.com/';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const FROZEN_MODULES={deployment:'scripts/phase2-mainnet/deploy.mjs',release:'src/phase2-mainnet/release.mjs',signer:'src/phase2-mainnet/signer.mjs'};
const CORE_STEPS=['PoseidonT3','PoseidonT4','Phase2ASPJoinSplitVerifier','Phase2ASPExitVerifier','Phase2ASPRegistry','pool:eth','pool:usdg'];

/** Only the existing account, password file and three approved limits are accepted. */
export function parseMainnetRunnerArgs(args){
  need(Array.isArray(args)&&args[0]==='--deploy','MAINNET_RUNNER_ARGUMENT_INVALID');
  const values={},allowed=new Set(['--account','--password-file','--budget-wei','--max-fee-per-gas-wei','--reserve-wei']);
  for(let i=1;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    need(allowed.has(key)&&!Object.hasOwn(values,key)&&typeof value==='string'&&!value.startsWith('--'),'MAINNET_RUNNER_ARGUMENT_INVALID');
    values[key]=value;
  }
  need(Object.keys(values).length===allowed.size,'MAINNET_RUNNER_EXPLICIT_OPTIONS_REQUIRED');
  need(/^[A-Za-z0-9_-]{1,80}$/.test(values['--account']),'MAINNET_RUNNER_ACCOUNT_INVALID');
  need(path.isAbsolute(values['--password-file']),'MAINNET_PASSWORD_FILE_REQUIRED');
  for(const key of ['--budget-wei','--max-fee-per-gas-wei'])need(/^[1-9][0-9]*$/.test(values[key]),'MAINNET_EXPLICIT_LIMIT_REQUIRED');
  need(/^(0|[1-9][0-9]*)$/.test(values['--reserve-wei']),'MAINNET_EXPLICIT_LIMIT_REQUIRED');
  return {account:values['--account'],passwordFile:values['--password-file'],limits:{budgetWei:values['--budget-wei'],
    maxFeePerGasWei:values['--max-fee-per-gas-wei'],reserveWei:values['--reserve-wei']}};
}

/** Buffer only newly quoted prices. Existing signed/prepared entries stay frozen. */
export function mainnetGasPriceWithHeadroom(quote,maximum,{numerator=100n,denominator=1n}={}){
  need(typeof quote==='bigint'&&typeof maximum==='bigint'&&quote>0n&&maximum>0n&&quote<=maximum,'MAINNET_GAS_PRICE_EXCEEDED');
  need(typeof numerator==='bigint'&&typeof denominator==='bigint'&&numerator>0n&&denominator>0n,'MAINNET_GAS_MULTIPLIER_INVALID');
  const buffered=(quote*numerator+denominator-1n)/denominator;
  return buffered>maximum?maximum:buffered;
}

/** Wrap AFTER viem's request mapping so its generic -32000 text cannot mask the node. */
export function normalizeMainnetBroadcastTransport(factory){
  return parameters=>{
    const original=factory({...parameters,retryCount:0});
    return {...original,request:async(request,options)=>{
      try{return await original.request(request,{...options,retryCount:0});}
      catch(error){
        if(request.method!=='eth_sendRawTransaction')throw error;
        const diagnostic=sanitizeBroadcastError(error),clean=new Error(diagnostic.shortMessage);
        clean.shortMessage=diagnostic.shortMessage;
        if(diagnostic.code!==undefined)clean.code=diagnostic.code;
        // Do not retain cause, details, body, metadata or the original request.
        throw clean;
      }
    }};
  };
}

/** Dependency injection is for pure tests; the CLI exposes no RPC/bypass options. */
export function createMainnetDeploymentClient({maxFeePerGasWei,gasPrice,httpFactory=http,publicClientFactory=createPublicClient}={}){
  const maximum=BigInt(maxFeePerGasWei);
  const multiplier={numerator:BigInt(gasPrice?.multiplierNumerator??'100'),denominator:BigInt(gasPrice?.multiplierDenominator??'1')};
  const client=publicClientFactory({cacheTime:0,transport:normalizeMainnetBroadcastTransport(httpFactory(MAINNET_DEPLOYMENT_RPC,{retryCount:0,timeout:30000}))});
  return {...client,getGasPrice:async()=>mainnetGasPriceWithHeadroom(await client.getGasPrice(),maximum,multiplier)};
}

/** Validate the tagged snapshot and original limits before executing snapshot modules. */
export function createMainnetRC3DeploymentRunner({checkSnapshot=checkRC3Deployment,importModule=specifier=>import(specifier),
  makeClient=createMainnetDeploymentClient,loadGasPolicy=readMainnetGasPolicy}={}){
  return async function deploy({root=ROOT,args}={}){
    const options=parseMainnetRunnerArgs(args);root=await fs.realpath(root);
    const checked=await checkSnapshot({root,limits:options.limits});
    need(checked.directory===path.join(root,DEFAULT_RC3_DEPLOYMENT_DIRECTORY),'MAINNET_RUNNER_SNAPSHOT_MISMATCH');
    need(isDeepStrictEqual(checked.limits,options.limits),'RC3_EXPLICIT_LIMITS_MUST_MATCH_ORIGINAL');
    need(checked.account===options.account,'MAINNET_RUNNER_ACCOUNT_MISMATCH');
    need(checked.readiness?.blocked===false,'ACCOUNT_UNKNOWN_BROADCAST');
    const gasPolicy=await loadGasPolicy({root});
    need(isDeepStrictEqual(gasPolicy.effectiveLimits,checked.limits)
      &&gasPolicy.gasPrice?.maxFeePerGasWei===checked.limits.maxFeePerGasWei
      &&gasPolicy.gasPrice.multiplierNumerator==='100'&&gasPolicy.gasPrice.multiplierDenominator==='1',
      'MAINNET_GAS_POLICY_LIMITS_MISMATCH');
    const loaded=await Promise.all(Object.entries(FROZEN_MODULES).map(async([kind,relative])=>
      [kind,await importModule(pathToFileURL(path.join(checked.directory,relative)).href)]));
    const {deployment,release:releaseModule,signer:signerModule}=Object.fromEntries(loaded);
    need(deployment.parseMainnetDeployArgs(args).deploy===true,'MAINNET_RUNNER_ARGUMENT_INVALID');
    const release=await releaseModule.loadVerifiedMainnetRelease({root:checked.directory}),config=release.config;
    need(config.chain?.id===4663&&config.network==='mainnet'&&config.chain.rpcUrl===MAINNET_DEPLOYMENT_RPC
      &&signerModule.MAINNET_RPC===MAINNET_DEPLOYMENT_RPC,'MAINNET_OFFICIAL_RPC_REQUIRED');
    need(isAddress(config.deployer?.address)&&!/^0x0{40}$/i.test(config.deployer.address)
      &&config.deployer.signingAccount===options.account,'MAINNET_RUNNER_ACCOUNT_MISMATCH');
    need(isDeepStrictEqual(deployment.deploymentSpecs({config,routes:[]}).map(spec=>spec.id),CORE_STEPS),'MAINNET_RUNNER_SCOPE_INVALID');
    const continuation=await deployment.readMainnetDeploymentContinuation({root:checked.directory});
    need(continuation.signerDirectory===checked.sharedSignerDirectory
      &&isDeepStrictEqual(continuation.adoptedDeployments,checked.adoptedDeployments),'MAINNET_SHARED_SIGNER_MISMATCH');
    const client=makeClient({maxFeePerGasWei:options.limits.maxFeePerGasWei,gasPrice:gasPolicy.gasPrice});
    const signer=signerModule.createMainnetSigner({client,address:config.deployer.address,account:options.account,passwordFile:options.passwordFile,
      ...options.limits,directory:continuation.signerDirectory});
    return deployment.runMainnetDeployment({root:checked.directory,release,client,signer,routes:[],relayer:null,
      ...options.limits,...continuation});
  };
}

export const deployMainnetRC3=createMainnetRC3DeploymentRunner();
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await deployMainnetRC3({args:process.argv.slice(2)}),null,2));}
  catch(error){console.error(JSON.stringify({error:error.code??'MAINNET_DEPLOYMENT_FAILED',
    ...(error.transactionHash?{transactionHash:error.transactionHash}:{}),...(error.rpcDiagnostic?{rpcDiagnostic:error.rpcDiagnostic}:{}),automaticResend:false}));process.exitCode=1;}
}
