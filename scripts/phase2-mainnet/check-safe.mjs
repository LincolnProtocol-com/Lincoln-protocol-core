#!/usr/bin/env node
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPublicClient,http} from 'viem';
import {verifyMainnetSafe} from '../../src/phase2-mainnet/safe.mjs';

if(process.argv.length!==2)throw new Error('USAGE_CHECK_MAINNET_SAFE');
const root=new URL('../../',import.meta.url),config=JSON.parse(await fs.readFile(new URL('config/phase2-mainnet.json',root)));
const client=createPublicClient({transport:http(config.chain.rpcUrl,{retryCount:0,timeout:15000}),cacheTime:0});
const result=await verifyMainnetSafe({client,guardian:config.guardian});
const report=fileURLToPath(new URL(config.guardian.verificationReport,root));
await fs.writeFile(report,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
