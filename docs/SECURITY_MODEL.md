# Security model

This document describes the contract candidate extracted from upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1`. It does not assert completed independent audit, production anonymity or a live mainnet deployment. Exact sources, parameters and artifacts are identified by `artifacts/phase2-mainnet/release-candidate-20261016.json`.

## Custody, ownership and authorization

Each immutable pool holds one asset: native ETH or a fixed ERC20 address. A private note represents value controlled by its ownership secret. Normal JoinSplit supports at most two input notes and two output notes, and uses Groth16 to prove ownership, membership and value conservation. Public action fields and encrypted output hashes are bound into the proof context. The processor submitting a proof must match the processor authorized by that proof.

A nullifier derived from the note, ownership secret and pool scope prevents a note from being spent twice. Normal spending, holder exit and ragequit consume the same nullifier. Observing a commitment, a public deposit or an original-depositor record alone does not convey spending authority. After a successful private transfer, the sender's old note is spent; its original depositor cannot reclaim the recipient's new note merely by knowing the funding source.

There is no pool owner sweep, upgrade proxy or arbitrary administrator withdrawal. An incorrect immutable pool or verifier cannot be repaired in place; a replacement deployment and an explicit migration would be necessary. Contracts and adapters do not make compromised client keys or malicious proof-building software safe.

## Current-note ASP policy

Normal spending requires every positive input note to belong to an accepted association set. The association leaf is scoped to a particular pool. Every new output must be admitted before its next normal spend. Public dynamic deposits do not require ASP admission; they can remain pending for normal spending.

The policy is **approval of current notes**, not inherited deposit-lineage tracking. It does not prove that every ancestor of a note originated from an approved funding address, and removing an original deposit does not automatically revoke all descendants. Recovery information does not deliberately carry an original-source label to the recipient. These properties do not establish statistical anonymity against timing, amount or network analysis.

The initial mainnet configuration selects a self-hosted provider with `all-current-notes` and `sourceScreening:false`. This is not sanctions screening and must not be marketed as such. A different screening policy is an operational and privacy decision that needs its own specification; the current-note circuit must not be represented as enforcing historic funds-lineage screening.

The provider publishes the association root, an increasing epoch, an expiry and the digest of the public membership data. It cannot withdraw pool funds, but it can censor normal spending, withhold membership data, stop publishing or publish a restrictive set. Normal proof generation depends on availability of the matching public set data. A self-hosted provider is therefore a liveness and admission dependency even though it is not a custodian.

## Accepted epochs and Guardian powers

At most the newest **16 epochs**, including the latest, are eligible. A superseded epoch must also be unexpired and less than **one hour** past its replacement. The epoch-count bound and time bound both apply. Sixteen epochs do not guarantee a fixed wall-clock window: 15-second publications would provide approximately four minutes around the newest epoch, whereas faster publication shortens that interval.

Proofs created before an update can remain executable during the acceptance window. Consequently, a note removed from the newest set may still be spent using a previously accepted set. Publishing a newer set is not immediate global revocation.

The immutable Guardian can suspend the provider and immediately revoke **all epochs published through that point**. It cannot publish a root or take pool funds. Suspension halts normal spending, including pending proofs, while public deposits and ownership-based exits remain outside ASP approval. Resuming the provider does not revive revoked epochs; a fresh policy is required.

The Guardian can propose a new provider, with a public **three-day delay**, after which the proposed provider must accept. It can cancel the proposal. The pool's normal authorization context binds the registry's provider identity; operations must update pinned profiles and publisher configuration after rotation. The Guardian itself is not replaceable through a registry setter. The proposed deployment uses a separately verified 2-of-3 Safe as Guardian and DEX fee treasury; the Safe signers and their key custody are external trust dependencies.

## Public exits

`holderExit` proves current ownership of one unspent note and exits that entire note. It reveals the commitment and value, does not require ASP approval or a recent Merkle root, and binds processor, recipient and fee terms. Its fee, if any, comes out of that note's value. Users need a functioning way to generate the proof and submit a transaction, including their own gas if an official relay is unavailable.

`ragequit` uses the ownership-based exit proof and additionally requires the original dynamic-deposit record. It refunds the recorded original depositor in full with zero protocol fee. Knowledge of that public mapping alone never authorizes a refund. This escape path is not limited to notes rejected by ASP.

DEX adapters are recorded as the original depositor when they dynamically deposit swap proceeds. A recipient of such a note should use `holderExit`; on-chain ragequit would send funds to the adapter, which has no owner recovery sweep. A relay-side refusal to submit ragequit to a recognized adapter is an additional product guard, not an on-chain prohibition covering arbitrary users or contracts.

## DEX and fee boundary

Adapters are immutable typed exact-input routes for supported UP/Uniswap router ABIs. Their path, router, factory, wrapped-native address and pools are fixed per deployment. There is no generic arbitrary-calldata executor. Supported routes have one to four hops and can wrap ETH or unwrap WETH when the target pool holds native ETH. External liquidity, router behavior and token behavior remain dependencies.

Fee adapters measure the actual gross output, compute `floor(gross * feeBps / 10000)`, pay treasury and deposit the net output into the target pool atomically. `minAmountOut` is the **net** target-note minimum; the absolute `maxServiceFee` and treasury terms are proof-bound. The selected launch rate is 20 bps, with immutable fee and treasury per adapter. Native-output fees are paid to treasury in WETH. Ordinary official-relay transfer/withdrawal service fees have a different settlement path and are not automatically paid directly to this DEX treasury.

Public DEX execution reveals the traded assets, route, amounts, fees and timing. Reshielding the output does not make an external exchange trade confidential. Public deposits, exits, approvals, membership documents, ciphertext traffic, network metadata and fees may also provide correlation signals. Neither two-input support nor a successful end-to-end test measures the practical anonymity set.

## Asset and capacity assumptions

ERC20 assets must exhibit exact-transfer behavior compatible with the pool and adapter balance checks. Rebasing, fee-on-transfer and otherwise unusual tokens are not generally supported. SafeERC20 does not eliminate arbitrary token behavior. Stock-token issuers may pause, block, upgrade or administratively burn tokens; Lincoln contracts cannot remove those powers. Pinning proxy runtime alone does not freeze the proxy's present or future implementation.

The append-only Merkle tree has depth 20 and at most **2^20 leaves**. This counts inserted commitments, not users or deposits; transactions can insert multiple leaves. Spent leaves are not reclaimed. There is no enforced minimum deposit beyond a positive valid amount, so dust deposits and finite tree capacity remain an availability concern. A full tree prevents operations that require new output insertions. The ownership-based exit path does not need a new tree leaf.

Previously observed Merkle roots remain known permanently. The 100-entry public root array is a recent-history view, not the complete validity set. This prevents dust deposits from evicting an in-flight root, but it does not solve tree-capacity exhaustion. Increasing tree depth or input/output counts would change circuit assumptions and requires a separately reviewed release; it is not a backend setting.

## Off-chain and cryptographic dependencies

The security argument assumes sound Groth16 and Poseidon implementations, appropriate contribution randomness, correct final-key/verifier binding, canonical-chain execution and uncompromised user secrets. Verification records do not prove destruction of contributor randomness or identify independently controlled contribution environments.

RPC/indexer completeness, public association-data availability, relay service and gas funding determine the quality and liveness of the product. The official relay can refuse service but does not gain note ownership merely by receiving proofs and ciphertexts. Client-side recovery, independent state checks and direct public exits must not be confused with a guarantee that hosted services always remain available.
