// Audit-package adaptation: the last artifact test targets the final production
// materials instead of development keys omitted from this repository.
// See audit/test-adaptations.json for the exact upstream source binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {poseidon} from 'maci-crypto/build/ts/hashing.js';
import {encodeAbiParameters,keccak256,stringToHex} from 'viem';
import * as sdk from '../src/phase2-asp/sdk.mjs';
import * as routed from '../src/phase2-routes/sdk.mjs';
import {loadFinalProductionCircuit} from '../scripts/phase2-mainnet/build.mjs';
const Z='0x'+'00'.repeat(20),P='0x'+'11'.repeat(20),EOA='0x'+'22'.repeat(20),OTHER='0x'+'33'.repeat(20),REGISTRY='0x'+'44'.repeat(20),PROVIDER='0x'+'55'.repeat(20);
const profile={schema:'phase2-asp-test-profile/v1',experimental:true,testOnly:true,productionReady:false,chain:{id:31341},pool:{address:P,asset:Z,noteModel:sdk.NOTE_MODEL},registry:{address:REGISTRY,provider:PROVIDER}};
const ext=(changes={})=>({processor:EOA,recipient:Z,feeRecipient:Z,publicIn:0n,publicOut:0n,fee:0n,...changes});
const exit=(changes={})=>({processor:EOA,recipient:OTHER,feeRecipient:Z,fee:0n,...changes});
const state=(notes=[],receipts=[],nullifiers=[])=>({noteModel:sdk.NOTE_MODEL,commitments:notes.map(n=>String(n.commitment)),root:String(sdk.buildMerkleTree(notes.map(n=>n.commitment)).root),receipts,nullifiers:nullifiers.map(String),blockTimestamp:'1000',deposits:[]});
function funded(values=[30n,40n]) {
  const a=sdk.createAccount(),b=sdk.createAccount(),notes=values.map(value=>sdk.createNote({value,receiver:sdk.receiverAddress(a,profile)},profile));
  a.notes=notes.map(n=>sdk.serializeNote(n,profile));const before=state(notes);
  const set=sdk.buildAssociationSet({commitments:notes.map(n=>n.commitment),profile});
  before.asp={...set,cidDigest:set.digest,epoch:'1',validUntil:'2000',expired:false};return {a,b,notes,before,set};
}
function transfer() {
  const f=funded(),prepared=sdk.prepareJoinSplit({account:f.a,profile,state:f.before,outputs:[{receiver:sdk.receiverAddress(f.b,profile),value:60n}],externalData:ext()});
  const outputs=prepared.outputNotes.filter(n=>n.value>0n),events=outputs.map((n,i)=>({commitment:String(n.commitment),index:f.notes.length+i,encryptedOutput:prepared.encryptedOutputs[i]}));
  const after=state([...f.notes,...outputs],events,prepared.inputSignals.inputNullifiers);after.asp=f.before.asp;return {...f,prepared,after};
}

test('ASP account, profile, backup and receipt domains are isolated from routed pools',()=>{
  const a=sdk.createAccount('11'.repeat(32)),old={...profile,schema:'phase2-routes-test-profile/v1',pool:{...profile.pool,noteModel:routed.NOTE_MODEL}};
  assert.notEqual(sdk.spendingSecret(a,profile),routed.spendingSecret(a,old));
  assert.notEqual(sdk.normalizeProfile(profile).scope,routed.normalizeProfile(old).scope);
  assert.throws(()=>sdk.normalizeProfile(old));assert.throws(()=>sdk.normalizeProfile({...profile,chain:{id:1}}));
  assert.throws(()=>sdk.normalizeProfile({...profile,registry:{...profile.registry,provider:Z}}));
  const receiver=sdk.receiverAddress(a,profile),note=sdk.createNote({value:1n,receiver,blinding:9n},profile);
  assert.equal(note.commitment,poseidon([1n,poseidon([BigInt(receiver.ownerPublicKey),9n])]));
  const cipher=sdk.encryptReceipt(receiver,note,profile);assert.equal(cipher.length,514);
  assert.deepEqual(sdk.decryptReceipt(a,profile,note.commitment,cipher),note);
  const password='long-asp-test-backup-password',sealed=sdk.sealAccount(a,password);
  assert.deepEqual(sdk.openAccount(sealed,password),a);assert.throws(()=>routed.openAccount(sealed,password));
});

test('Association sets commit the ordered scoped leaf list and reject duplicates',()=>{
  const f=funded(),leaves=f.notes.map(n=>poseidon([n.commitment,sdk.normalizeProfile(profile).scope]));
  assert.deepEqual(f.set.leaves,leaves.map(String));
  assert.equal(f.set.digest,keccak256(encodeAbiParameters([{type:'uint256[]'}],[leaves])));
  assert.notEqual(sdk.associationSetDigest([...leaves].reverse()),f.set.digest);
  assert.notEqual(sdk.associationLeaf(f.notes[0].commitment,{...profile,pool:{...profile.pool,address:OTHER}}),leaves[0]);
  assert.throws(()=>sdk.associationSetDigest([leaves[0],leaves[0]]));
  assert.throws(()=>sdk.associationSetDigest(['01']));assert.throws(()=>sdk.associationSetDigest([0n]));
  assert.throws(()=>sdk.associationSetDigest([sdk.FIELD]));
});

test('Normal JoinSplit merges two approved notes and exposes no inherited source label',()=>{
  const {a,b,prepared,after,before}=transfer(),w=prepared.inputSignals;
  assert.deepEqual(w.inputValues,[30n,40n]);assert.deepEqual(w.outputValues,[60n,10n]);assert.equal(w.publicIn,0n);
  assert.equal(w.aspRoot,BigInt(before.asp.root));assert.equal(w.aspEpoch,1n);assert.equal(w.aspValidUntil,2000n);
  assert.equal(w.inputASPPathElements[0].length,20);assert.equal(w.inputASPPathElements[1].length,20);
  for(let i=0;i<2;i++) {
    let node=sdk.associationLeaf(prepared.inputNotes[i].commitment,profile),cursor=Number(w.inputASPPathIndices[i]);
    for(const sibling of w.inputASPPathElements[i]){node=cursor&1?poseidon([sibling,node]):poseidon([node,sibling]);cursor=Math.floor(cursor/2);}
    assert.equal(node,w.aspRoot);
  }
  assert.equal(w.context,poseidon([w.contextBase,poseidon([w.aspRoot,w.aspEpoch,w.aspValidUntil])]));
  assert.equal(sdk.recoverAccount(sdk.createAccount(b.seed),profile,after).balance,60n);
  assert.equal(sdk.recoverAccount(sdk.createAccount(a.seed),profile,after).balance,10n);
  for(const key of ['label','origin','depositor','sender','inputs'])assert.ok(!Object.hasOwn(prepared.outputNotes[0],key));
});

test('New private outputs remain pending until a later provider root explicitly approves them',()=>{
  const {b,after,prepared}=transfer(),restored=sdk.createAccount(b.seed),received=sdk.recoverAccount(restored,profile,after).notes[0];
  const args={account:restored,profile,state:after,inputs:[received],externalData:ext({recipient:EOA,publicOut:60n})};
  assert.throws(()=>sdk.prepareJoinSplit(args),/pending ASP approval/);
  const set=sdk.buildAssociationSet({commitments:[prepared.outputNotes[0].commitment],profile});
  const approved={...after,asp:{...set,cidDigest:set.digest,epoch:'2',validUntil:'2500'}};
  const spend=sdk.prepareJoinSplit({...args,state:approved});assert.equal(spend.inputSignals.inputValues[1],0n);
  assert.equal(spend.inputSignals.aspEpoch,2n);assert.equal(spend.inputSignals.outputCommitments[0],0n);
});

test('Normal preparation refuses missing, forged, expired or unscoped approval sets',()=>{
  const f=funded(),args={account:f.a,profile,state:f.before,inputs:[f.notes[0]],externalData:ext({recipient:EOA,publicOut:30n})};
  for(const asp of [undefined,{...f.before.asp,leaves:null},{...f.before.asp,root:'1'},{...f.before.asp,cidDigest:'0x'+'aa'.repeat(32)},
    {...f.before.asp,epoch:'0'},{...f.before.asp,validUntil:'1000'},{...f.before.asp,expired:true}])assert.throws(()=>sdk.prepareJoinSplit({...args,state:{...f.before,asp}}));
  const raw={leaves:f.notes.map(n=>String(n.commitment)),epoch:'1',validUntil:'2000'};raw.root=String(sdk.buildMerkleTree(raw.leaves).root);raw.cidDigest=sdk.associationSetDigest(raw.leaves);
  assert.throws(()=>sdk.prepareJoinSplit({...args,state:{...f.before,asp:raw}}),/pending ASP approval/);
  assert.throws(()=>sdk.prepareJoinSplit({...args,externalData:ext({publicIn:1n})}),/depositDynamic/);
});

test('Normal context exactly binds registry, provider, payouts, receipts and policy version',()=>{
  const f=transfer(),data=ext({recipient:EOA,publicOut:20n}),p=sdk.normalizeProfile(profile),cipher=f.prepared.encryptedOutputs;
  const expected=BigInt(keccak256(encodeAbiParameters([
    {type:'bytes32'},{type:'uint256'},{type:'address'},{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'address'},{type:'address'},
    {type:'uint128'},{type:'uint128'},{type:'uint128'},{type:'bytes32'},{type:'bytes32'},
  ],[keccak256(stringToHex('CHENG_PHASE2_ASP_V1')),31341n,P,p.scope,REGISTRY,PROVIDER,EOA,EOA,Z,0n,20n,0n,...cipher.map(keccak256)])))%sdk.FIELD;
  assert.equal(sdk.joinSplitContextBase(profile,data,cipher),expected);
  const context=sdk.joinSplitContext(profile,data,cipher,f.before.asp);
  for(const policy of [{...f.before.asp,epoch:'2'},{...f.before.asp,validUntil:'2001'},{...f.before.asp,root:'1',leaves:null}])assert.notEqual(sdk.joinSplitContext(profile,data,cipher,policy),context);
  assert.notEqual(sdk.joinSplitContextBase({...profile,registry:{...profile.registry,provider:OTHER}},data,cipher),expected);
  assert.notEqual(sdk.joinSplitContextBase(profile,{...data,recipient:OTHER},cipher),expected);
});

test('Holder exit needs ownership and canonical unspent commitment but no ASP policy',()=>{
  const f=funded(),withoutPolicy={...f.before,asp:{root:'0',epoch:'0',validUntil:'0',leaves:null,expired:true}},note=f.notes[0];
  const prepared=sdk.prepareHolderExit({account:f.a,profile,note,state:withoutPolicy,externalData:exit({feeRecipient:EOA,fee:1n})});
  assert.deepEqual(prepared.publicSignals,[note.commitment,sdk.nullifier(note,sdk.spendingSecret(f.a,profile),profile),note.value,sdk.normalizeProfile(profile).scope,sdk.holderExitContext(profile,prepared.data)].map(String));
  assert.deepEqual(Object.keys(prepared.inputSignals).sort(),['blinding','commitment','context','nullifier','scope','secret','value']);
  assert.throws(()=>sdk.prepareHolderExit({account:f.b,profile,note,state:withoutPolicy,externalData:exit()}),/does not own/);
  assert.throws(()=>sdk.prepareHolderExit({account:f.a,profile,note,state:{...withoutPolicy,nullifiers:[prepared.publicSignals[1]]},externalData:exit()}),/already been spent/);
  assert.throws(()=>sdk.prepareHolderExit({account:f.a,profile,note,state:state(),externalData:exit()}),/absent/);
  assert.throws(()=>sdk.prepareHolderExit({account:f.a,profile,note,externalData:exit({fee:31n,feeRecipient:EOA})}));
  assert.throws(()=>sdk.prepareHolderExit({account:f.a,profile,note,externalData:exit({recipient:P})}));
});

test('Holder exit payout context and API body bind all authorization data without secrets',()=>{
  const f=funded(),prepared=sdk.prepareHolderExit({account:f.a,profile,note:f.notes[0],externalData:exit({feeRecipient:EOA,fee:1n})});
  const p=sdk.normalizeProfile(profile),data=prepared.data;
  const expected=BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'address'},{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'uint128'}],
    [keccak256(stringToHex('CHENG_PHASE2_ASP_EXIT_V1')),31341n,P,p.scope,data.processor,data.recipient,data.feeRecipient,1n])))%sdk.FIELD;
  assert.equal(prepared.inputSignals.context,expected);
  for(const change of [{processor:OTHER},{recipient:EOA},{feeRecipient:OTHER},{fee:2n}])assert.notEqual(sdk.holderExitContext(profile,{...data,...change}),expected);
  const proof={pi_a:['1','2','1'],pi_b:[['3','4'],['5','6'],['1','0']],pi_c:['7','8','1']},body=sdk.publicHolderExitTransaction(prepared,proof);
  assert.deepEqual(Object.keys(body).sort(),['data','pA','pB','pC','pubSignals']);assert.equal(body.pubSignals.length,5);
  assert.ok(!JSON.stringify(body).includes(f.a.seed));assert.ok(!JSON.stringify(body).includes('secret'));assert.ok(!JSON.stringify(body).includes('blinding'));
});

test('Ragequit requires both current ownership and the original canonical public deposit',()=>{
  const f=funded(),note=f.notes[0],withDeposit={...f.before,deposits:[{commitment:String(note.commitment),value:String(note.value),originalDepositor:OTHER}]};
  const prepared=sdk.prepareRagequit({account:f.a,profile,note,state:withDeposit,processor:EOA});assert.equal(prepared.data.recipient,OTHER);assert.equal(prepared.data.fee,0n);
  assert.throws(()=>sdk.prepareRagequit({account:f.b,profile,note,state:withDeposit,processor:EOA}),/does not own/);
  assert.throws(()=>sdk.prepareRagequit({account:f.a,profile,note,state:f.before,processor:EOA}),/original-deposit record/);
  assert.throws(()=>sdk.prepareRagequit({account:f.a,profile,note,state:withDeposit,externalData:exit({recipient:EOA})}),/original deposit/);
  assert.throws(()=>sdk.prepareRagequit({account:f.a,profile,note,state:withDeposit,externalData:exit({feeRecipient:EOA,fee:1n})}),/zero fee/);
});

test('Dynamic receipt recovery still works before ASP approval and carries no lineage label',()=>{
  const a=sdk.createAccount(),invoice=sdk.createDynamicReceive(a,profile),value=77n,commitment=poseidon([value,invoice.precommitment]);
  const event={commitment:String(commitment),index:0,value:String(value),precommitment:String(invoice.precommitment),encryptedOutput:invoice.encryptedTemplate};
  const recovered=sdk.recoverAccount(sdk.createAccount(a.seed),profile,state([{commitment}],[event]));assert.equal(recovered.balance,value);
  assert.equal(recovered.notes[0].commitment,commitment);assert.ok(!Object.hasOwn(recovered.notes[0],'originalDepositor'));
});

test('ASP swap action envelope retains both private policy witnesses and rebinds context base',()=>{
  const f=funded(),TOKEN='0x'+'66'.repeat(20),WRAPPED='0x'+'77'.repeat(20),target={...profile,pool:{...profile.pool,address:OTHER,asset:TOKEN}};
  const route={adapter:'0x'+'88'.repeat(20),router:'0x'+'99'.repeat(20),factory:'0x'+'aa'.repeat(20),wrappedNative:WRAPPED,protocol:'UP Slipstream',path:WRAPPED+'000064'+TOKEN.slice(2)};
  const prepared=sdk.prepareSwap({account:f.a,sourceProfile:profile,targetProfile:target,sourceState:f.before,route,action:{processor:EOA,amountIn:60n,minAmountOut:1n,deadline:1900n}});
  assert.equal(prepared.publicSignals[8],'0');assert.equal(prepared.encryptedOutputs[1],prepared.actionEnvelope);
  assert.equal(prepared.inputSignals.contextBase,sdk.joinSplitContextBase(profile,prepared.extData,prepared.encryptedOutputs));
  assert.equal(prepared.inputSignals.context,sdk.joinSplitContext(profile,prepared.extData,prepared.encryptedOutputs,f.before.asp));
  assert.equal(prepared.inputSignals.inputASPPathElements.length,2);assert.equal(prepared.inputSignals.aspEpoch,1n);
});

test('final production artifact loader independently pins five- and nine-signal circuit keys',async()=>{
  const join=await loadFinalProductionCircuit({name:'joinsplit'}),holder=await loadFinalProductionCircuit({name:'holder-exit'});
  assert.equal(JSON.parse(join.files.vkey.bytes).nPublic,9);assert.equal(JSON.parse(holder.files.vkey.bytes).nPublic,5);
  assert.notEqual(join.manifestSHA256,holder.manifestSHA256);
  for(const circuit of [join,holder]){
    assert.equal(circuit.manifest.testOnly,false);assert.deepEqual(circuit.manifest.allowedChainIds,[4663]);
    assert.equal(circuit.manifest.setup.kind,'multi-party-phase2');
  }
});
