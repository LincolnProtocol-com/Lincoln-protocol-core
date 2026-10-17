# Security model

This describes the production review sources under `contracts/` and `zk/`, mapped byte-for-byte to the immutable RC.2 capsule by `review-manifest.json`. It does not assert independent audit completion, production anonymity or a live mainnet deployment. See [audit scope](AUDIT_SCOPE.md) for the exact review boundary.

## Custody and note ownership

Each immutable pool holds one fixed asset: native ETH or a specified ERC20. A note is controlled by its ownership secret. Groth16 proves ownership, tree membership and value conservation for at most two inputs/two outputs. Public action fields and encrypted output hashes are bound to the proof context, including the authorized submitting processor.

Nullifiers are shared across normal spending, holder exit and ragequit. A commitment, public deposit or original-depositor record alone never authorizes spending. After a successful private transfer, the old input is spent; its original depositor cannot reclaim a recipient's new note solely from knowledge of the original funding source.

There is no owner sweep, upgrade proxy or arbitrary administrative withdrawal. An incorrect immutable deployment cannot be repaired in place and would require a replacement and explicit migration. These contracts do not protect a compromised ownership secret, recovery seed or proof-building environment.

## Association-set policy

Every positive input to normal spending must be in an accepted current-note association set. Each new output needs admission before a subsequent normal spend. Deposits need no ASP approval but remain subject to cap and pause checks.

This is **current-note approval**, not inherited deposit-lineage screening. Removing an original deposit does not automatically revoke all descendants. Recovery does not deliberately label the original source for the recipient. These properties do not establish statistical anonymity against timing, value or network analysis.

The selected bootstrap is self-hosted approval of all current notes, with no source screening. It must not be advertised as sanctions or historic funds-lineage screening. A future denylist or external screening service is a separate policy and privacy decision.

The provider publishes roots, epochs, expiry and public membership-data digests. It cannot withdraw funds, but it can censor admission, stop publishing or withhold the data needed to prove membership. Public-data availability is therefore a liveness dependency.

## Accepted epochs and Guardian

At most the newest **16 epochs** are eligible. A superseded epoch must also be unexpired and less than **one hour** past its replacement. Count and time limits both apply. Sixteen epochs do not guarantee a fixed wall-clock interval; a sufficiently fast publisher shortens it.

A note removed from the newest set can still spend using an older accepted set. Publishing a newer set alone is not instant global revocation. Guardian suspension immediately revokes all published epochs through that point and halts normal spending, including pending proofs. Resume does not revive revoked epochs; a new policy is needed.

Provider rotation requires a Guardian proposal and acceptance by the new provider after **three days**. The Guardian may cancel proposals but cannot publish a root. Normal-spend contexts bind the provider identity; clients and pinned profiles must account for rotation. The Guardian itself has no replacement setter.

The same immutable Guardian administers pool deposit controls. The selected Guardian/DEX treasury is a separately observed 2-of-3 Safe; future owners, signer custody and any Safe-level changes remain external dependencies. Guardian powers do not grant ownership of private notes or a payout path.

## Deposit caps and pause

Pool constructors require positive uint128 `maxDeposit` and `maxTotal`, with single-deposit cap no higher than total. Zero is not unlimited. `accountedBalance` records note-backed liabilities; arbitrary donations do not consume headroom.

Accounting changes are `+value` on a successful dynamic deposit, `-publicOut` once on normal spending, and minus the full note value on holder exit/ragequit. The fee is already inside gross `publicOut` or the revealed exit value; payout and fee split it rather than add another debit. Private-only transfers leave pool liabilities unchanged. Solvency requires actual custody **at least** accounted liabilities; donations can create a surplus.

Guardian `setCaps` may lower caps immediately, including below current reserve. Raising either requires a non-decreasing proposal and a fresh **24-hour delay**. Replacing the proposal restarts the delay; any applied cap change, including a no-op set, clears it. Mixed reductions/increases require reducing first and proposing afresh. Pending increases can be cancelled.

Only `depositDynamic` is paused or capped. This includes a DEX adapter's reshielding deposit. Normal withdrawal, private transfer, holder exit and ragequit remain outside those restrictions; normal spending still needs ASP approval. A paused/full target pool causes the entire DEX operation, source spend and fee movements to revert atomically. Quote-time capacity is advisory and may change before execution.

Selected initial raw-asset caps are 1/20 ETH and 2,500/50,000 USDG. Stock dollar targets require pinned raw-token price/decimals, multiplier and liquidity evidence before constructor values are resolved. Raw caps do not use an on-chain USD oracle, hold dollar exposure constant or guarantee DEX liquidity.

## Public escape paths

`holderExit` reveals one note's commitment/value, proves ownership and withdraws the full note with proof-bound recipient/fee terms. It requires no ASP approval, recent Merkle root or new tree leaf. Users need proof-generation capability and a way to submit gas themselves if an official relay is unavailable.

`ragequit` additionally refunds the recorded original depositor and requires zero fee. Knowing that mapping does not confer ownership; the note must still be unspent and its ownership proof valid. Ragequit is not limited to ASP-rejected notes.

For DEX-created notes, the recorded depositor is the adapter. On-chain ragequit can pay that adapter and strand funds because no sweep exists. The recipient should use holder exit. Relay refusal to submit to a recognized adapter is an extra product guard, not a general on-chain prohibition.

## DEX and service fees

Adapters are immutable typed exact-input routes with fixed router, factory, wrapped-native asset, pools and path. They support 1–4 hops and ETH wrap/unwrap, with no arbitrary-calldata executor. External liquidity and router/token behavior remain dependencies.

Fee adapters measure gross output, deduct `floor(gross × feeBps / 10000)` and deposit net output atomically. `minAmountOut` is a net minimum; absolute `maxServiceFee` and adapter/treasury terms are proof-bound. New selected adapters charge **30 bps** with immutable rate and treasury. Native-output fees settle as WETH; only net output is unwrapped into the ETH pool.

Official relay pricing is separate from a mandatory core-pool tax. The selected policy charges withdrawals and relayed holder exits 30 bps plus a fixed gas quote in the current pool asset, disclosed and bound before proving. It selects zero-fee deposits and free private-transfer/ragequit service, including zero gas deducted from those notes; the operator subsidizes their relay gas. Direct public deposits still require the sender's transaction gas.

A fixed quote is not permission to reprice after proof, signature, submission or recovery. ETH wei presets must not be applied to ERC20 pools without explicit asset-unit pricing. Existing job semantics must remain intact. The pure quote/validation component does not install live service configuration, route fees to a Safe automatically or enable signing.

External swaps reveal assets, route, amounts, fees and timing. Reshielding does not make an external DEX trade confidential. Deposits, public exits, approvals, association documents, ciphertext traffic and network metadata can also correlate activity. Two-input support and an end-to-end pass do not measure the practical anonymity set.

## Asset and tree assumptions

Assets must obey exact-transfer behavior. Rebasing, fee-on-transfer and unusual tokens are not generally supported, and SafeERC20 does not neutralize arbitrary token code. Stock issuers may pause, block, upgrade or burn; those controls can prevent actual delivery despite correct pool accounting. A pinned proxy runtime does not freeze implementation behavior.

The append-only depth-20 tree has at most **2^20 inserted leaves**. Spent leaves are not reclaimed; dust deposits can consume capacity. Full capacity blocks operations needing new outputs, while holder exit does not need a new leaf. Previously observed roots stay known permanently; the 100-entry public root array is only a recent-history view. Permanent root retention prevents dust-based root eviction, not capacity exhaustion.

## Cryptographic and operational assumptions

Security assumes sound Groth16/Poseidon, correct finalized-key/verifier binding, canonical chain execution and uncompromised client secrets. Transcript checks do not prove honest entropy, destroyed toxic waste, authenticated independent contributors or trustworthy machines. See [parameter provenance](PARAMETER_PROVENANCE.md).

The root review map and reproduction commands preserve exact source/parameter identity, not independent security assurance. RPC/indexer completeness, public set-data hosting, relay uptime and gas funding affect liveness. Stale state must not authorize a fresh spend. A relay holding proofs and ciphertexts does not thereby own the notes, but direct recovery/exit support still depends on functioning client tools.

Mainnet funding, signing, live fee activation, stock raw caps and actual market acceptance are separate operational work. Neither a public artifact nor a deposit cap authorizes a mainnet expenditure.
