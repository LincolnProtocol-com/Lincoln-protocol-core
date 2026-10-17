// SPDX-License-Identifier: Apache-2.0
// Raw asset-unit deployment limits. Dollar targets are not on-chain price oracles.
export const POOL_CAPS_SCHEMA='lincoln-pool-deposit-caps/v1';
export const CAP_INCREASE_DELAY_SECONDS=43200;
const MAX=(1n<<128n)-1n;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
export function poolDeploymentCaps(asset,{required=false}={}){
  const caps=asset?.depositCaps;
  if(!caps||caps.status==='valuation-required'){
    need(!required,'MAINNET_POOL_CAPS_UNSET');return null;
  }
  need(caps.schema===POOL_CAPS_SCHEMA&&caps.unit==='asset-base-units'&&caps.status==='configured','MAINNET_POOL_CAPS_INVALID');
  for(const value of [caps.maxDepositUnits,caps.maxTotalUnits])
    need(typeof value==='string'&&/^[1-9][0-9]{0,38}$/.test(value)&&BigInt(value)<=MAX,'MAINNET_POOL_CAPS_INVALID');
  const maxDeposit=BigInt(caps.maxDepositUnits),maxTotal=BigInt(caps.maxTotalUnits);
  need(maxDeposit<=maxTotal,'MAINNET_POOL_CAPS_INVALID');
  return {maxDeposit,maxTotal};
}
