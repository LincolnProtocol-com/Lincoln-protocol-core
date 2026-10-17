# Audit scope

Review the regular files under [`contracts/`](../contracts/README.md), [`zk/`](../zk/README.md), [abi/](../abi/) and [`test/`](../test/README.md). The target chain is **Robinhood Chain, ID 4663**. The contracts are a locally verified release candidate; neither a complete Lincoln mainnet deployment nor a completed independent audit is asserted.

[review-manifest.json](../review-manifest.json) maps the readable review files to their RC.3 candidate files in [releases/rc3/](../releases/rc3/). The check command verifies byte identity and the preserved release binding. The current target is `v0.1.0-rc.3`: pool cap increases wait 12 hours. The immutable `v0.1.0-rc.2` tag and archive remain unchanged; the circuits and final keys are shared unchanged. Review-copy equality and successful tests do not establish security against every attack.

## Production contracts

There are **ten deployable contract/library types in nine source files**, not ten deployed addresses. Pools and fixed routes may have multiple instances.

| Review file | Solidity identifier | Review focus |
| --- | --- | --- |
| [contracts/PrivacyPool.sol](../contracts/PrivacyPool.sol) | `Phase2ASPPool` | Custody, deposits, accounted reserve, cap/pause governance, append-only tree, nullifiers, proof/context binding, public exits and solvency |
| [contracts/AssociationSetRegistry.sol](../contracts/AssociationSetRegistry.sol) | `Phase2ASPRegistry` | Publication, 16-epoch acceptance, expiry/grace, suspension and delayed provider rotation |
| [contracts/adapters/V3RouteAdapter.sol](../contracts/adapters/V3RouteAdapter.sol) | `Phase2RouteAdapter` | Typed V3/UP routes, exact input, balance deltas, action authorization and reshielding |
| [contracts/adapters/Router02Adapter.sol](../contracts/adapters/Router02Adapter.sol) | `Phase2Router02Adapter` | Router02 execution with the same route/accounting boundaries |
| [contracts/adapters/FeeAdapters.sol](../contracts/adapters/FeeAdapters.sol) | `Phase2FeeRouteAdapter`, `Phase2FeeRouter02Adapter` | Measured output, net minimum, fee cap, treasury and action binding |
| [contracts/verifiers/JoinSplitVerifier.sol](../contracts/verifiers/JoinSplitVerifier.sol) | `Phase2ASPJoinSplitVerifier` | Final Groth16 verifier, nine public inputs and final-key binding |
| [contracts/verifiers/HolderExitVerifier.sol](../contracts/verifiers/HolderExitVerifier.sol) | `Phase2ASPExitVerifier` | Final Groth16 verifier, five public inputs and final-key binding |
| [contracts/libraries/PoseidonT3.sol](../contracts/libraries/PoseidonT3.sol) | `PoseidonT3` | Linked two-element hash implementation, field/compiler compatibility |
| [contracts/libraries/PoseidonT4.sol](../contracts/libraries/PoseidonT4.sol) | `PoseidonT4` | Linked three-element hash implementation, field/compiler compatibility |

The fee base and interfaces are supporting code, not additional deployable types. OpenZeppelin dependencies, Poseidon source identity, compiler settings, constructor values, library links and full runtime/immutable verification are part of the review boundary. Ten ABI exports under [abi/](../abi/) retain the real contract names even where display filenames are shorter.

## Circuits and final keys

Review [zk/circuits/joinsplit/](../zk/circuits/joinsplit/) and [zk/circuits/holder-exit/](../zk/circuits/holder-exit/), with the final materials under [zk/parameters/](../zk/parameters/). Obligations include ownership, value ranges/conservation, dummy notes, pool scope, nullifier construction, pool and association Merkle paths, and binding public actions to encrypted output hashes. Holder exit must consume the same nullifier as normal spending.

JoinSplit supports two inputs/two outputs at depth 20 with nine public inputs. Holder exit has five public inputs and does not require ASP membership. Exact field ordering comes from the circuit and parameter manifests. Caps and selected fees retain these statements and final keys; changing the source filename does not define a new circuit.

Review contribution-chain verification, public beacon evidence, parameter hashes and generated-verifier derivation. Recorded labels do not authenticate independent contributors, honest entropy, destruction of toxic waste or publication timing. Initial setup keys must never be substituted for final keys. See [parameter provenance](PARAMETER_PROVENANCE.md).

## Contract obligations and trust boundaries

- **Accounting and caps:** `publicOut` already includes its fee. Deduct it once, deduct full note value on public exit, and leave accounted liabilities unchanged by donations. Verify actual custody covers accounted reserve. Cap increases wait 12 hours; replacements reset the delay and applied changes clear old proposals. Reductions below reserve and deposit pause must never gate withdrawal or ownership-based exits. A failed target deposit must roll back the complete DEX transaction.
- **ASP and Guardian:** only approved positive input notes may spend normally. Approval is current-note membership, not inherited source lineage. Review expiry, the latest-plus-15-epochs count, one-hour superseded grace, immediate revocation on suspension, resume behavior and the three-day provider rotation. The Guardian can control admission and pause new deposits but cannot publish roots or withdraw users' funds.
- **Public exits:** holder exit reveals commitment/value and pays the proof-bound holder recipient. Ragequit additionally pays the recorded original depositor and requires zero fee. DEX-created deposits record the adapter as original depositor; ragequit to that adapter can strand proceeds because it has no sweep. Holder exit is the supported recipient escape path.
- **DEX and fees:** routes are typed, immutable exact-input routes, with no generic arbitrary-calldata executor. Review 1–4 hops, wrap/unwrap, exact transfers, allowance cleanup, residual balances, actual rather than reported output, net minimum and proof-bound absolute fee cap. Selected new-adapter fees are 30 bps to an immutable Safe treasury; native-output fees settle as WETH.
- **Commercial policy:** official relay withdrawal/holder-exit pricing is separate from an enforced core-pool percentage tax. Review integer 30-bps quotes plus fixed, prequoted pool-asset gas; free launch transfer/ragequit; zero-fee deposits; immutable swap rate/treasury checks; uint128 limits; and preserved legacy job semantics. Existing proved, signed, submitted or recovering jobs must not be repriced. Including a pure validator does not activate a live service.

The [security model](SECURITY_MODEL.md) expands these limits, including finite tree capacity, dust deposits, issuer-controlled stock tokens, network/timing correlation and current-note policy censorship.

## Reproducibility boundary

Use the root `npm run check`, `build`, `check:circuits`, `test:contracts` and `test:proofs` commands. They verify the regular review files and invoke preserved tooling in `releases/rc3/` at its original logical paths. Those paths are compiler/manifest identities, not extra production targets. Compiling renamed root paths directly can alter metadata and library links; it must not be substituted for the frozen build.

The capsule also includes build/SDK/state-validation helpers needed for artifact rejection, witness preparation, context hashing, encryption and acceptance. This is a scoped reproduction dependency, not a claim that the complete wallet, relay, indexer or hosted product is included in the audit target. Review the helper closure and exact source/input bindings through the preserved inventories. User keys and witnesses are intended to remain client-side.

## Recorded evidence

| Evidence in `test/evidence/rc2/` | Recorded result | Limits |
| --- | --- | --- |
| [foundry.json](../test/evidence/rc2/foundry.json) | 68 passing results, 1,000 runs per fuzz case; invariant campaign 128 × 40 = 5,120 calls, zero reverts | Mock verifiers; contract accounting/authorization/rollback evidence, not proof soundness |
| [native.json](../test/evidence/rc2/native.json) | 43 checks, 11 actual final proofs, 48 local transactions; includes real-proof spending/exits while deposits are paused and caps lowered below reserve | Isolated local chain; no live mainnet execution, independent audit or anonymity measurement |
| [fees.json](../test/evidence/rc2/fees.json) | 22 checks, four actual final proofs, 73 local transactions; two-hop wrap/unwrap, fee-bound recovery and withdrawal | Actual production pool/verifier/adapter, but routers/tokens/factories/liquidity are mocks |

Actual-proof reports total **15 proofs and 121 local transactions**, with zero public transactions. They bind the preserved RC.2 core/fee artifacts. Some adapter fuzz tests use retained derivation baselines; production fee acceptance is a separate actual-proof run. Scenario gas totals are not single relay-transaction estimates. Recorded runs must not be described as fresh execution for every later layout commit.

## Exclusions and open review areas

The scope excludes frontend presentation, hosted availability, production key custody, Cloudflare/AWS operation, third-party DEX implementations, bridges, lending, TVL investment and new DEX adapter types. Integration assumptions still require review. Seven stock caps are fixed in [the approved dataset](../config/stock-caps-mainnet-20261017.json), which is hash-bound in the RC.3 target. Stock pools remain disabled pending per-asset fork and two-way DEX acceptance. Live fee-route activation, operational funding and public-chain A/B acceptance remain unresolved launch work. Mainnet broadcasting is paused while the unresolved RC.2 PoseidonT4 broadcast is reconciled; the replacement deployment must reuse verified libraries and the original account-wide accounting.

Assess permanent immutable-contract failures, tree exhaustion/dust, old-policy spendability after exclusion, public set-data availability, practical anonymity under small sets, exact-transfer/issuer assumptions and cap/pause governance. An identified review topic is not a claim that an audit has resolved it. Independent audit is deferred under the current launch decision.

Fresh [RC.3 evidence](../test/README.md#current-rc3-results) passed against the new pool bytecode: 69 default Foundry results, 19 deep cap/invariant results and 15 actual final proofs across 124 local transactions. The RC.2 report table above remains historical provenance.
