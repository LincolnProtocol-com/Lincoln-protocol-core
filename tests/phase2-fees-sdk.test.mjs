import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,keccak256 as ethersHash} from 'ethers';
import {keccak256} from 'viem';
import * as sdk from '../src/phase2-asp/sdk.mjs';
import {FEE_SWAP_DOMAIN,normalizeFeeSwapRoute,normalizeFeeSwapAction,feeSwapActionHash,feeSwapActionEnvelope,
  prepareFeeSwap,feeSwapTransaction,minimumGrossOutput,serviceFee} from '../src/phase2-fees/sdk.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
function fixture(){
  const sourceProfile={schema:sdk.PROFILE_SCHEMA,experimental:true,testOnly:true,productionReady:false,chain:{id:31341},
    pool:{address:addr(1),asset:sdk.NATIVE_ASSET,noteModel:sdk.NOTE_MODEL},registry:{address:addr(2),provider:addr(3)}};
  const targetProfile={...structuredClone(sourceProfile),pool:{address:addr(4),asset:addr(5),noteModel:sdk.NOTE_MODEL}};
  const route={adapterType:'Phase2FeeRouteAdapter',adapter:addr(6),router:addr(7),factory:addr(8),wrappedNative:addr(9),
    protocol:0,path:addr(9)+'000bb8'+addr(5).slice(2),feeBps:20,treasury:addr(10)};
  const a=sdk.createAccount(),b=sdk.createAccount(),notes=[3000n,4000n].map(value=>sdk.createNote({value,receiver:sdk.receiverAddress(a,sourceProfile)},sourceProfile));
  a.notes=notes.map(note=>sdk.serializeNote(note,sourceProfile));
  const tree=sdk.buildMerkleTree(notes.map(note=>note.commitment)),set=sdk.buildAssociationSet({commitments:notes.map(n=>n.commitment),profile:sourceProfile});
  const sourceState={commitments:notes.map(n=>String(n.commitment)),root:String(tree.root),nullifiers:[],receipts:[],blockTimestamp:'1000',
    asp:{root:set.root,leaves:set.leaves,cidDigest:set.digest,epoch:'1',validUntil:'2000',expired:false}};
  const invoice=sdk.createDynamicReceive(b,targetProfile),action={processor:addr(11),amountIn:6000n,minAmountOut:9980n,deadline:1500n,
    targetPrecommitment:invoice.precommitment,encryptedTemplate:invoice.encryptedTemplate,maxServiceFee:20n};
  return {sourceProfile,targetProfile,route,action,a,b,sourceState,notes,invoice};
}

test('fee-route hash exactly matches independent Solidity ABI encoding and uses a new domain',()=>{
  const f=fixture(),r=normalizeFeeSwapRoute(f),a=normalizeFeeSwapAction(f.action);
  const expected=ethersHash(AbiCoder.defaultAbiCoder().encode([
    'bytes32','uint256','address','address','address','address','address','address','uint8','bytes32','uint16','address',
    'address','uint128','uint128','uint256','uint256','bytes32','uint128',
  ],[FEE_SWAP_DOMAIN,31341,r.adapter,r.sourcePool,r.targetPool,r.router,r.wrappedNative,r.factory,r.protocol,r.pathHash,
    20,r.treasury,a.processor,a.amountIn,a.minAmountOut,a.deadline,a.targetPrecommitment,keccak256(a.encryptedTemplate),a.maxServiceFee]));
  assert.equal(feeSwapActionHash(f),expected);assert.equal(feeSwapActionEnvelope(f).length,514);
  const {maxServiceFee,...legacyAction}=f.action;
  assert.notEqual(sdk.swapActionHash({...f,action:legacyAction}),expected);
});

test('treasury, immutable rate, fee cap, net minimum and processor all change the proof-bound action',()=>{
  const f=fixture(),original=feeSwapActionHash(f);
  for(const change of [{treasury:addr(12)},{feeBps:25},{adapter:addr(13)}])assert.notEqual(feeSwapActionHash({...f,route:{...f.route,...change}}),original);
  for(const change of [{maxServiceFee:21n},{minAmountOut:9979n},{amountIn:6001n},{processor:addr(14)},{deadline:1501n}])assert.notEqual(feeSwapActionHash({...f,action:{...f.action,...change}}),original);
});

test('fee preparation keeps the existing circuit and binds net-output action without predicting the DEX fill',()=>{
  const f=fixture(),prepared=prepareFeeSwap({account:f.a,...f});
  assert.equal(prepared.inputNotes.length,2);assert.deepEqual(prepared.inputSignals.inputValues,[3000n,4000n]);
  assert.equal(prepared.outputNotes[0].value,1000n);assert.equal(prepared.outputNotes[1].value,0n);
  assert.equal(prepared.extData.publicOut,6000n);assert.equal(prepared.extData.fee,0n);
  assert.equal(prepared.action.minAmountOut,9980n);assert.equal(prepared.encryptedOutputs[1],feeSwapActionEnvelope(f));
  assert.equal(prepared.publicSignals.length,9);
  assert.equal(prepared.publicSignals[3],String(sdk.joinSplitContext(f.sourceProfile,prepared.extData,prepared.encryptedOutputs,f.sourceState.asp)));
  assert.ok(!Object.hasOwn(prepared.inputSignals,'serviceFee'));
});

test('fee transaction exposes only public proof/action data and preserves zero-fee pool withdrawal semantics',()=>{
  const f=fixture(),prepared=prepareFeeSwap({account:f.a,...f});
  const tx=feeSwapTransaction(prepared,{pA:[1n,2n],pB:[[3n,4n],[5n,6n]],pC:[7n,8n]});
  assert.equal(tx.action.maxServiceFee,'20');assert.equal(tx.action.minAmountOut,'9980');assert.equal(tx.extData.fee,'0');
  assert.deepEqual(Object.keys(tx).sort(),['action','encryptedOutputs','extData','pA','pB','pC','pubSignals']);
  assert.equal(JSON.stringify(tx).includes(f.a.seed),false);assert.equal(JSON.stringify(tx).includes(f.b.seed),false);
});

test('receiver invoice can be created locally for B and no account state is mutated by preparation',()=>{
  const f=fixture(),before=structuredClone(f.a),{targetPrecommitment,encryptedTemplate,...action}=f.action;
  const prepared=prepareFeeSwap({account:f.a,...f,action,receiver:sdk.receiverAddress(f.b,f.targetProfile)});
  assert.deepEqual(f.a,before);assert.ok(prepared.action.targetPrecommitment>0n);
  assert.equal(prepared.action.encryptedTemplate.slice(0,4),'0x02');
});

test('fee rate is explicit, capped and immutable route/treasury role collisions fail',()=>{
  const f=fixture();
  for(const feeBps of [undefined,0,-1,101,0.2,'20'])assert.throws(()=>normalizeFeeSwapRoute({...f,route:{...f.route,feeBps}}),/INVALID_SERVICE_FEE_BPS/);
  for(const treasury of [sdk.NATIVE_ASSET,f.route.adapter,f.route.router,f.route.wrappedNative,f.sourceProfile.pool.address,f.targetProfile.pool.address])assert.throws(()=>normalizeFeeSwapRoute({...f,route:{...f.route,treasury}}),/INVALID_FEE_TREASURY/);
  assert.throws(()=>normalizeFeeSwapRoute({...f,route:{...f.route,adapterType:'Phase2RouteAdapter'}}),/UNSUPPORTED_FEE_ADAPTER/);
  assert.throws(()=>normalizeFeeSwapAction({...f.action,feeBps:20}),/INVALID_FEE_SWAP_ACTION/);
  const action={...f.action};Object.defineProperty(action,'maxServiceFee',{get(){throw new Error('accessor executed');}});
  assert.throws(()=>normalizeFeeSwapAction(action),/INVALID_FEE_SWAP_ACTION/);
});

test('inverse net minimum is exact for floor fees including tiny fills and uint128 limits',()=>{
  for(const bps of [1,20,25,100])for(const net of [1n,2n,499n,500n,999n,9980n,10000n,999999999999999999n]){
    const gross=minimumGrossOutput(net,bps);
    assert.ok(gross-serviceFee(gross,bps)>=net);
    if(gross>0n)assert.ok(gross-1n-serviceFee(gross-1n,bps)<net);
  }
  assert.equal(minimumGrossOutput(1n,20),1n);
  assert.equal(minimumGrossOutput(9980n,20),9999n);
  assert.throws(()=>minimumGrossOutput(sdk.MAX_VALUE,100),/GROSS_OUTPUT_EXCEEDS_UINT128/);
});
