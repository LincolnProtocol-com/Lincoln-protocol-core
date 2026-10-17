// SPDX-License-Identifier: Apache-2.0
// Real CREATE/state transitions on a fresh local chain; no public-chain writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createPublicClient,createWalletClient,http,encodeFunctionData,keccak256} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createMainnetSigner} from '../src/phase2-mainnet/signer.mjs';
import {runMainnetDeployment,verifyMainnetDeployment} from '../scripts/phase2-mainnet/deploy.mjs';
import {poolDeploymentCaps} from '../src/phase2-mainnet/caps.mjs';

async function localChain(){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lincoln-caps-resume-')));
  const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const url=`http://127.0.0.1:${port}`,child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--hardfork','cancun','--accounts','0','--silent'],
    {cwd:directory,stdio:'ignore',env:{PATH:process.env.PATH,HOME:directory,LANG:'C'}});
  let failed;child.once('error',error=>failed=error);const exited=new Promise(resolve=>child.once('exit',resolve));
  const client=createPublicClient({transport:http(url,{retryCount:0,timeout:1000}),cacheTime:0,pollingInterval:25});
  const close=async()=>{if(!failed&&child.exitCode===null){child.kill('SIGTERM');await exited;}await fs.rm(directory,{recursive:true,force:true});};
  try{
    let ready=false;for(let attempt=0;attempt<100;attempt++){
      if(failed)throw failed;assert.equal(child.exitCode,null);
      try{ready=await client.getChainId()===4663;if(ready)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(ready,true);assert.equal(await client.getBlockNumber(),0n);
    assert.deepEqual(await client.request({method:'eth_accounts'}),[]);
    const info=await client.request({method:'anvil_nodeInfo'});assert.ok(!info.forkConfig?.forkUrl&&!info.forkConfig?.forkBlockNumber);
    return {client,url,directory,close};
  }catch(error){await close();throw error;}
}

test('deployment resume accepts live pool changes and provider rotation while rejecting forged constructor caps',{timeout:120000},async()=>{
  const local=await localChain(),{client,url,directory}=local;
  try{
    const config=JSON.parse(await fs.readFile(new URL('../config/phase2-mainnet.json',import.meta.url)));
    const artifacts=JSON.parse(await fs.readFile(new URL('../artifacts/phase2-mainnet/contracts.json',import.meta.url)));
    assert.equal(artifacts.Phase2ASPPool.abi.find(item=>item.type==='constructor').inputs.length,6);
    const actors=Object.fromEntries(['deployer','guardian','payer','nextProvider'].map(name=>[name,privateKeyToAccount(generatePrivateKey())]));
    for(const actor of Object.values(actors))await client.request({method:'anvil_setBalance',params:[actor.address,'0x56bc75e2d63100000']});
    config.deployer.address=actors.deployer.address;config.guardian={address:actors.guardian.address};
    const token=config.assets.find(asset=>asset.symbol==='USDG'),tokenCode='0x600660005260206000f3';
    await client.request({method:'anvil_setCode',params:[token.address,tokenCode]});
    config.codePins=config.codePins.map(pin=>pin.role==='usdg'?{...pin,runtimeCodeHash:keccak256(tokenCode)}:pin);
    const sha='aa'.repeat(32),production={releaseId:sha,build:{path:'artifacts/phase2-mainnet/contracts.json',sha256:sha},
      manifests:Object.fromEntries(['joinsplit','holder-exit'].map(name=>[name,{path:`protocol/phase2-mainnet/build/${name}/manifest.json`,sha256:sha}])),parameters:{}};
    const release={config,artifacts,artifactSHA256:sha,sourceSetSHA256:sha,production};
    const limits={budgetWei:'3000000000000000000',maxFeePerGasWei:'100000000000',reserveWei:'0'};
    let signed=0;
    const signer=createMainnetSigner({client,address:actors.deployer.address,root:directory,...limits,signRawTransaction:async intent=>{
      signed++;return actors.deployer.signTransaction({chainId:4663,type:'legacy',nonce:Number(intent.nonce),gas:BigInt(intent.gas),gasPrice:BigInt(intent.gasPrice),value:0n,data:intent.data});
    }});
    const args={root:directory,release,client,signer,...limits};
    const deployed=await runMainnetDeployment(args);assert.equal(signed,7);
    const pool=deployed.profiles.eth.pool.address,registry=deployed.profiles.eth.registry.address;
    const abi=artifacts.Phase2ASPPool.abi,registryABI=artifacts.Phase2ASPRegistry.abi;
    const chain={id:4663,name:'local caps resume',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[url]}}};
    async function write(who,to,contractABI,functionName,values=[],value=0n){
      const wallet=createWalletClient({account:actors[who],chain,transport:http(url)});
      const hash=await wallet.sendTransaction({to,data:encodeFunctionData({abi:contractABI,functionName,args:values}),value});
      assert.equal((await client.waitForTransactionReceipt({hash,pollingInterval:25})).status,'success');
    }
    await write('payer',pool,abi,'depositDynamic',[5n,1n,'0x'+'00'.repeat(256)],5n);
    await write('guardian',pool,abi,'pauseDeposits');
    await write('guardian',pool,abi,'setCaps',[1n,1n]);
    await write('guardian',pool,abi,'proposeCapIncrease',[2n,2n]);
    assert.equal(await client.readContract({address:pool,abi,functionName:'accountedBalance'}),5n);
    assert.deepEqual(await runMainnetDeployment(args),deployed);assert.equal(signed,7);
    await write('guardian',registry,registryABI,'proposeProvider',[actors.nextProvider.address]);
    await client.request({method:'evm_increaseTime',params:[259201]});await client.request({method:'evm_mine',params:[]});
    await write('nextProvider',registry,registryABI,'acceptProvider');
    assert.deepEqual(await runMainnetDeployment(args),deployed);assert.equal(signed,7);
    // Profiles retain their historical provider binding; rotation requires an
    // explicit runtime/profile change, not silent deployment-output mutation.
    assert.equal(deployed.profiles.eth.registry.provider,config.provider.address);
    const entry=(await signer.status()).entries.find(item=>item.id.endsWith('pool:eth'));
    const step={hash:entry.hash,address:pool,deployer:config.deployer.address,nonce:entry.nonce,data:entry.data};
    const libraries=Object.fromEntries(Object.entries(deployed.profiles.eth.libraries).map(([name,pin])=>[name,pin.address]));
    const initial=poolDeploymentCaps(config.assets.find(asset=>asset.symbol==='ETH'),{required:true});
    const verify={client,step,artifact:artifacts.Phase2ASPPool,libraries,expectedInitialCaps:initial};
    await verifyMainnetDeployment(verify);
    await assert.rejects(()=>verifyMainnetDeployment({...verify,expectedInitialCaps:{...initial,maxDeposit:initial.maxDeposit+1n}}),{code:'MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH'});
    for(const mode of ['missing','duplicate']){
      const poisoned=Object.create(client);poisoned.getTransactionReceipt=async options=>{
        const receipt=await client.getTransactionReceipt(options),own=receipt.logs.filter(log=>log.address.toLowerCase()===pool.toLowerCase());
        return {...receipt,logs:mode==='missing'?receipt.logs.filter(log=>!own.includes(log)):[...receipt.logs,...own]};
      };
      await assert.rejects(()=>verifyMainnetDeployment({...verify,client:poisoned}),{code:'MAINNET_DEPLOYMENT_INITIAL_CAPS_MISMATCH'});
    }
    await assert.rejects(()=>verifyMainnetDeployment({...verify,step:{...step,data:step.data.slice(0,-2)+'ff'}}),{code:'MAINNET_DEPLOYMENT_TRANSACTION_MISMATCH'});
  }finally{await local.close();}
});
