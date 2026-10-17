// SPDX-License-Identifier: Apache-2.0
// Bounded RPC diagnostics only; never serializes signed transaction payloads.
// Read only literal data properties. Never invoke error accessors or serialize an
// error object: viem errors can carry signed bytes inside request bodies/details.
function ownValue(object,key){
  if(!object||typeof object!=='object')return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
function safeMessage(value){
  if(typeof value!=='string')return null;
  // Bound work before matching potentially huge error messages.
  let result=value.slice(0,2048).split(/[\r\n\u2028\u2029]/,1)[0];
  result=result.split(/\b(?:request\s+body|request\s+arguments|raw\s+transaction|stack\s+trace|details)\s*:/i,1)[0];
  result=result.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi,'[url removed]')
    .replace(/\b(?:private[-_ ]?key|password|passphrase|mnemonic|seed|secret|authorization|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'[credential removed]')
    .replace(/0x[0-9a-f]*/gi,'[hex removed]')
    .replace(/\b[0-9a-f]{32,}\b/gi,'[hex removed]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ')
    .replace(/\s+/g,' ').trim();
  if(!result||/^[{\[]\s*["']?(?:jsonrpc|method|params|body|request|data|rawTransaction)["']?\s*:/i.test(result))return null;
  return result.slice(0,240);
}

/** Return a bounded diagnostic object; no stack, body, details or hex payloads. */
export function sanitizeBroadcastError(error){
  const chain=[];let current=error;
  for(let depth=0;depth<4&&current&&typeof current==='object'&&!chain.includes(current);depth++){
    chain.push(current);current=ownValue(current,'cause');
  }
  let code;
  // A numeric nested RPC code is more useful than a generic wrapper label.
  for(const item of chain){
    const value=ownValue(item,'code');
    if(typeof value==='number'&&Number.isSafeInteger(value)){code=value;break;}
    if(typeof value==='string'&&/^-?[0-9]{1,10}$/.test(value)){code=value;break;}
  }
  if(code===undefined)for(const item of chain){
    const value=ownValue(item,'code');if(typeof value==='string'&&/^[A-Z][A-Z0-9_-]{0,63}$/.test(value)){code=value;break;}
  }
  // Generic viem wrappers must not hide a nested node reason such as nonce too
  // low. Never inspect `details` or a request object to find that reason.
  const generic=/^(?:an? (?:unknown|internal) (?:RPC )?error (?:occurred|was received)|RPC request failed|HTTP request failed|request failed|unknown error)[.!]?$/i;
  const candidates=[...chain.map(item=>safeMessage(ownValue(item,'shortMessage'))),
    ...chain.slice(1).map(item=>safeMessage(ownValue(item,'message'))),safeMessage(ownValue(error,'message'))].filter(Boolean);
  const shortMessage=candidates.find(message=>!generic.test(message))??candidates[0]??'Broadcast RPC failed; outcome is unknown.';
  return {...(code===undefined?{}:{code}),shortMessage};
}
