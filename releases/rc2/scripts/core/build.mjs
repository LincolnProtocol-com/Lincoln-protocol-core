#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline byte-for-byte reconstruction, including mathematical final-key checks.
import {checkCore} from './check.mjs';
import {buildMainnetRelease} from '../phase2-mainnet/build.mjs';
import {buildMainnetFeeRelease} from '../phase2-fees/build-mainnet.mjs';
try{
  if(process.argv.length!==2)throw new Error('USAGE_CORE_BUILD');
  await checkCore();
  console.log(JSON.stringify({stage:'core',...await buildMainnetRelease()}));
  console.log(JSON.stringify({stage:'fees',...await buildMainnetFeeRelease({checkOnly:true})}));
  await checkCore();
  process.exit(0);
}catch(error){console.error(error.code??error.message);process.exit(1);}
