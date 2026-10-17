// Public-chain verification only. Never accepts a wallet or sends transactions.
import {parseAbi,keccak256,encodeAbiParameters,isAddress,getAddress} from 'viem';

const ABI=parseAbi(['function getOwners() view returns(address[])','function getThreshold() view returns(uint256)',
  'function VERSION() view returns(string)','function nonce() view returns(uint256)']);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};

export async function verifyMainnetSafe({client,guardian}){
  need(guardian?.kind==='safe'&&guardian.chainId===4663&&isAddress(guardian.address),'MAINNET_SAFE_CONFIG_INVALID');
  need(await client.getChainId()===4663,'MAINNET_SAFE_WRONG_CHAIN');
  const block=await client.getBlock(),address=getAddress(guardian.address);
  const code=await client.getCode({address,blockNumber:block.number});
  need(code&&code!=='0x','MAINNET_SAFE_CODE_MISSING');
  const runtimeCodeHash=keccak256(code);
  need(runtimeCodeHash===guardian.runtimeCodeHash,'MAINNET_SAFE_CODE_MISMATCH');
  const [owners,threshold,version,nonce]=await Promise.all(['getOwners','getThreshold','VERSION','nonce'].map(functionName=>
    client.readContract({address,abi:ABI,functionName,blockNumber:block.number})));
  need(Array.isArray(owners)&&owners.length===guardian.ownerCount&&owners.every(isAddress)
    &&new Set(owners.map(a=>a.toLowerCase())).size===owners.length,'MAINNET_SAFE_OWNERS_INVALID');
  need(threshold===BigInt(guardian.threshold)&&threshold>=2n&&threshold<=BigInt(owners.length),'MAINNET_SAFE_THRESHOLD_MISMATCH');
  need(version===guardian.version,'MAINNET_SAFE_VERSION_MISMATCH');
  need(await client.getChainId()===4663&&(await client.getBlock({blockNumber:block.number})).hash===block.hash,'MAINNET_SAFE_SNAPSHOT_CHANGED');
  return {schema:'lincoln-mainnet-safe-verification/v1',verified:true,chainId:4663,address,
    blockNumber:String(block.number),blockHash:block.hash,blockTimestamp:String(block.timestamp),
    runtimeCodeHash,codeBytes:(code.length-2)/2,version,ownerCount:owners.length,threshold:Number(threshold),nonce:String(nonce),
    ownerSetHash:keccak256(encodeAbiParameters([{type:'address[]'}],[owners])),
    readOnly:true,transactionsSigned:0,transactionsBroadcast:0,
    limitations:['Point-in-time public RPC verification; rechecked before deployment.',
      'A Safe threshold does not authenticate owner independence or verify who controls their keys.']};
}
