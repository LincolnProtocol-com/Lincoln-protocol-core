# LINCOLN / SPCX: implemented typed-router candidate

The new `Phase2FeeHedgeFunV4Adapter` reuses the deployed HedgeFun V4 trade router.
It has been compiled with the repository's release compiler settings. It remains
**untested, unaudited, undeployed and disabled**. The latest candidate removes
additional business caps, subject to final deployment scope approval. The
deployment gas budget and issuer-risk acceptance remain pending.
No wallet, signature or transaction was used to prepare these files.

This is a separate implementation of the typed-router alternative discussed in
`mainnet-v4-lincoln-spcx-design.md`. The older
`v4-lincoln-spcx-mainnet-proposal.json`, candidate ABI and planner describe a
**different, dedicated-callback design**. They must not be used as constructor
arguments, call ABI or action hash for this new contract. Frozen RC.3 contracts,
ABI manifests, proving parameters and review manifests are unchanged.

## Files and build status

- Source: `contracts/adapters/HedgeFunV4Adapter.candidate.sol` (BUSL-1.1).
- Compiler-produced ABI: `config/hedgefun-v4-candidate-abi.json`.
- Compiler-produced creation/runtime template and immutable references:
  `config/hedgefun-v4-candidate-build.json`.
- Unsigned deployment/cap/fee intent: `config/hedgefun-v4-candidate-plan.json`.
- Offline action hash/envelope helper:
  `scripts/operations/hedgefun-v4-candidate-plan.mjs`.
- Public pinned chain and local-source/artifact evidence:
  `deployments/robinhood-mainnet/verification/v4-typed-router-20261017.json`.

The build uses solc `0.8.28+commit.7893614a`, optimizer 10,000 runs, `viaIR: true`
and Cancun, matching the RC.3 build settings. Creation bytecode is 27,246 bytes;
runtime template is 20,033 bytes, below the 24,576-byte EIP-170 limit. The build
has no library link references and seven immutable reference groups. The runtime
template hash is **not a deployed runtime hash**: both pool addresses, input/output
tokens, direction and the pool runtime hashes must be substituted during creation.
The initial hand-written ABI draft has been replaced with actual solc output.

Build reproducibly into a fresh temporary directory:

```sh
node scripts/operations/build-hedgefun-v4-candidate.mjs \
  --output-directory /private/tmp/lincoln-v4-candidate-build-REVIEW_ID
```

This command compiles only the candidate and its vendored OpenZeppelin imports;
it does not run tests, fork a chain, generate proofs or write frozen artifacts.
The build directory includes the complete compiler input/output, candidate build
record and compiler ABI. A directory containing existing output files is rejected.

## Deployed venue binding

Public reads at Robinhood mainnet block `90855909` confirmed:

| Identity | Address / value |
| --- | --- |
| Trade router | `0x5f3e9D177231527D56fB62aCc398f22cc8F2c328` |
| Factory | `0xC78b6A83d75C5612a1A7323702B56038254a6459` |
| Strategy | `2`, curve stage `GRADUATED = 2` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Strategy treasury | `0x72aBbC490A18B5c0c61A9BeA4Ed091a74Eef991F` |
| Treasury implementation | `0xfF608632AF7621AA0c84607385056bBA9B547616` |
| Treasury upgrade controller | `0xEdAb12AB7B673648d2D2c79d37565032E1a23Bbf` |
| Currency0: LINCOLN | `0x2796cdF7328916e0A6c04C296A72C5C6d70B3AEE` |
| Currency1: SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` |
| Pool fee / tick spacing | `2000` pips / `60` |
| Hook | `0xb5bAbc5609de876D56662d066a0B5f63eF90a8CC`, version `3` |
| PoolId | `0xec0d72f0c70983525d99f777303e92f82b3cbb2e89aede6d44c9f22f8abc3f55` |

The actual router runtime matches the recorded HedgeFun local Foundry artifact
**including metadata**, after substituting only its declared immutable factory
and PoolManager values. The current local router source also matches the source
Keccak in that artifact's metadata. This was a comparison against an existing
artifact, not a fresh build of the HedgeFun project. Exact file hashes and the
comparison limitation are preserved in the public evidence record.

The candidate checks venue code hashes, current factory strategy tuple, current
curve stage and the complete treasury PoolKey on every swap. It pins both the
treasury proxy and its current implementation/controller; pinning proxy code
alone would allow an upgraded implementation to return a different key to the
router. SPCX's proxy, immutable beacon, current implementation address and code
are also pinned. An implementation upgrade deliberately disables this candidate
rather than silently trusting new code.

## Execution and fee accounting

Each direction gets its own adapter with constructor
`(sourcePrivacyPool, targetPrivacyPool)`. The assets must be the two exact tokens;
the pools must share the registry and verifier identities and have distinct
scopes. The adapter captures their runtime hashes. It does not create the pools.

For SPCX → LINCOLN, it calls typed `buy`; LINCOLN → SPCX calls typed `sell`.
Both use strategy `2`, `asset = SPCX`, an empty V3-hop array, expected stage `2`
and `allowPartialFill = false`. The pinned router performs the manager unlock
callback and one-shot settlement. The new adapter has **no manager callback**,
arbitrary router calldata, native-currency path, owner, setter or sweep.

The action binds the existing proof's 256-byte second output envelope to the new
domain `LINCOLN_HEDGEFUN_FIXED_V4_FEE_V1`, adapter, both privacy pools, nested venue
hash, full key PoolId, direction, immutable fee/treasury and all nine action
fields. `ExtData` preserves the frozen tuple order: recipient, feeRecipient,
processor, publicIn, publicOut, fee. Adapter recipient/processor, public input
zero, public output `amountIn`, fee zero and public signal slots `1`, `2`, `8`
are checked just as in the existing fee adapter.

The router chooses the TickMath extreme price limit. This candidate **only accepts
that same extreme limit** in its proof-bound action; it does not advertise custom
sqrt-price limits. The user's absolute minimum net output remains enforced by
the router's reverse-calculated minimum gross output and by the adapter's final
net target deposit. Input and minimum output are restricted to usable signed
int128 V4 delta bounds. Partial fills, even dust refunds, revert atomically.
The public V4 transaction and trade events still reveal venue, token amounts and
timing; source-note ownership and the destination note remain the privacy layer.

The hook's stock tax is currently exactly 100 bps. The candidate requires the
registered version-3 hook/vault, tax 100, and zero spike and snipe settings at every
call. The actual hook swap sender is the **deployed router**, which must differ
from the exempt strategy treasury. Calling `buyRateBps` from the adapter is valid
only because the candidate additionally requires `snipeSeconds = 0`, making the
reviewed `_buyRate` independent of sender; it never assumes a caller exemption.

The hook taxes SPCX input on SPCX → LINCOLN, or SPCX output on LINCOLN → SPCX.
The V4 LP fee is 2,000 pips (0.2%). The Lincoln service fee is a separate
`floor(actualOutputAfterHook * 30 / 10000)` (0.3%) paid to
`0x9CF17a6E3c75D200f58283A165C442a8A3994555` in the output token. A quote that
already includes hook and LP fees must **not subtract them again**. Minimum output
means the net amount inserted into the target privacy pool after the service fee.

Adapter and router balances must return exactly to their pre-call baselines,
while the target pool and Safe increase by the exact net amount and service fee.
Allowances must start at zero, are approved only for the required amount, and
must end at zero. Source withdrawal, swap, fee payment and target insertion all
revert together on a failure, including target capacity or issuer transfer checks.

## Latest cap direction and pending deployment approval

| Private pool | Single deposit, raw token units | Total, raw token units |
| --- | --- | --- |
| LINCOLN | `340282366920938463463374607431768211455` raw base units | same |
| SPCX | `340282366920938463463374607431768211455` raw base units | same |

This is `type(uint128).max` for both fields: no additional business cap within the
frozen pool's existing integer range. Zero is not an unlimited sentinel and is
rejected by the frozen pool's `_validateCaps`. The previous 48,000,000 / 670,000,000
LINCOLN and 17 / 100 SPCX token limits are superseded proposals and must not be used
for deployment. Both tokens have 18 decimals; the table uses **raw base units**.
SPCX's issuer UI multiplier can change the underlying share interpretation.

The Safe's emergency deposit-pause and cap-lowering controls remain available.
The adapter's signed-int128 swap bound and proof/circuit limits also remain;
removing business caps does not remove protocol arithmetic limits. No frozen
contract changes or cap changes on the existing thirteen pools are proposed.
Final scope approval is still required before any new deployment spending.

The proposed scope is two new frozen-RC.3 pool deployments plus two adapters,
maximum 0.0022 ETH, gas price ceiling 0.1 gwei, within the existing cumulative
0.065 ETH deployer limit and 0.003 ETH reserve. **This new scope is unapproved.**
Conservative provisional limits of 5,500,000 gas per pool and 5,500,000 per adapter
total 22,000,000 gas / 0.0022 ETH at the proposed ceiling. These are budget hints,
not RPC estimates: just depositing each adapter's 20,033 runtime bytes costs
4,006,600 gas before initcode, constructor calls and transaction overhead. Obtain
actual estimates with the concrete pool addresses and enforce a remaining-budget
check before every signature. Do not reset the existing deployer ledger.

SPCX retains issuer freeze, blacklist, pause, mint, arbitrary-holder burn and
beacon upgrade powers. Runtime pinning detects implementation changes; it cannot
prevent issuer actions or repair burned/blocked collateral. This requires explicit
risk acknowledgement before deployment, separate from the selected capacities.

## SDK/backend integration requirements

Use this candidate's compiler ABI, new `swap` selector and nested-domain helper;
changing only a V3 route's adapter address will produce an invalid proof/call.
`node scripts/operations/hedgefun-v4-candidate-plan.mjs --plan` is offline and
unsigned. Its `prepareCandidateAction` export generates the exact action hash,
envelope and source `ExtData` after concrete pool/adapter addresses are known.
It does not validate deployment approval, generate a proof or query a price.

A future funded swap request must obtain a fresh hook-aware V4 quote, derive a
minimum net output and absolute fee cap, make an encrypted target template, call
the helper, and then generate the source proof. The target precommitment,
encrypted template, adapter and all action bounds must stay unchanged between
proof and submission. Never send plaintext note secrets to the relay.

The current thirteen-pool active backend and existing twenty-four V3 routes are
unchanged. Before enabling this distinct route type, deploy and verify both new
privacy pools/adapters, publish their provenance and code hashes, add their
indexer/ASP/relay/Access coverage, and complete the separately authorized
both-direction acceptance. Compilation and a source review do not establish
end-to-end correctness or production readiness.
