# Audit scope

This repository packages the Robinhood Chain mainnet contract release candidate from upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1`. It is a review snapshot, not evidence of a mainnet deployment or a completed independent audit. Target chain ID: **4663**.

The authoritative frozen inventory is `artifacts/phase2-mainnet/release-candidate-20261016.json`. Original paths and file contents are retained so that its SHA256 entries remain meaningful. Packaging documentation is separate from that upstream inventory.

## Deployment contract scope

The inventory contains **10 deployable contract/library types**, not ten already deployed addresses. Pools and fixed-route adapters may have several instances.

| Contract or library | Authoritative source | Review focus |
| --- | --- | --- |
| `Phase2ASPPool` | `protocol/phase2-mainnet/contracts/Phase2ASPPool.sol` | Custody, deposit measurement, append-only tree, nullifiers, proof/context binding, exits and solvency |
| `Phase2ASPRegistry` | `protocol/phase2-mainnet/contracts/Phase2ASPRegistry.sol` | Policy publication, 16-epoch acceptance, expiry/grace, suspension and delayed provider rotation |
| `Phase2RouteAdapter` | `protocol/phase2-mainnet/contracts/Phase2RouteAdapter.sol` | Typed exact-input UP/Uniswap V3 routes, authorization, balance deltas and reshielding |
| `Phase2Router02Adapter` | `protocol/phase2-mainnet/contracts/Phase2Router02Adapter.sol` | Router02 ABI, the same route and accounting boundaries |
| `Phase2ASPJoinSplitVerifier` | `protocol/phase2-mainnet/generated/Phase2ASPJoinSplitVerifier.sol` | Generated Groth16 verifier, nine public inputs, final-key binding |
| `Phase2ASPExitVerifier` | `protocol/phase2-mainnet/generated/Phase2ASPExitVerifier.sol` | Generated Groth16 verifier, five public inputs, final-key binding |
| `PoseidonT3` | Pinned `poseidon-solidity/PoseidonT3.sol` npm dependency; exact source digest in the frozen core artifact | Hash implementation, linked runtime, field and compiler compatibility |
| `PoseidonT4` | Pinned `poseidon-solidity/PoseidonT4.sol` npm dependency; exact source digest in the frozen core artifact | The same checks for the three-element hash |
| `Phase2FeeRouteAdapter` | `protocol/phase2-fees/mainnet/Phase2FeeRouteAdapter.sol` | Measured output fee, net minimum, fee cap, treasury and action binding |
| `Phase2FeeRouter02Adapter` | `protocol/phase2-fees/mainnet/Phase2FeeRouteAdapter.sol` | Router02 execution with the same fee/accounting boundaries |

`Phase2FeeRouteBase` and interface declarations are supporting audit code; they are not additional deployable types in the ten-type count. OpenZeppelin and Poseidon dependencies, Solidity settings, library links, constructor immutables and complete compilation inputs are part of the reproducibility boundary.

The core artifact is `artifacts/phase2-mainnet/contracts.json`. The fee artifact is `artifacts/phase2-fees-mainnet/contracts.json`, with portable input `contracts/phase2-fees-mainnet.standard-input.json`. ABI exports live in `abi/phase2-mainnet/` and `abi/phase2-fees-mainnet/`.

## Circuits and proving-material scope

Review the circuits under `protocol/phase2-asp/circuits/`: the two-input/two-output JoinSplit circuit and the holder-exit circuit. Those circuit paths retain their upstream names; the finalized production keys, WASM, R1CS, verification keys and manifests are under `protocol/phase2-mainnet/build/joinsplit/` and `protocol/phase2-mainnet/build/holder-exit/`.

Key obligations include note ownership, value ranges and conservation, dummy inputs/outputs, pool scope, nullifier construction, both pool and association Merkle paths, and binding public actions to encrypted outputs. Holder exit must consume the same note nullifier as normal spending.

The final keys include two recorded non-beacon contributions followed by the committed future-block beacon. Review contribution-chain verification, public commitment evidence, manifest/file hashing and generated verifier derivation. The records do not authenticate contributor identity, independent machine control or destruction of secret contribution randomness. Historical initial `0000.zkey` files are not included in this subset and must never be deployed as final keys.

## SDK and build boundary

The included JavaScript subset supports artifact validation and proof acceptance; it is not a claim that the complete wallet, relayer, indexer or cloud deployment is part of this extracted repository.

Relevant code includes `src/phase2-mainnet/sdk.mjs`, `src/phase2-mainnet/artifacts.mjs`, `src/phase2-mainnet/release.mjs` and their included shared dependencies. Review production-profile rejection of development materials, exact final artifact loading, parameter hashes, witness preparation and correspondence between SDK hashing/encryption and circuit/contract context fields. Wallet secrets and witness data are intended to remain on the client. Compromise of a wallet, recovery seed or proof-building environment is outside the protection supplied by the on-chain contracts.

The mainnet builder derives release-specific sources from earlier development implementations. `protocol/phase2-asp/`, `protocol/phase2-routes/`, `protocol/phase2-router02/` and `protocol/phase2-fees/contracts/` may therefore appear as required derivation/reference inputs. Their testnet/local chain allowances and development verifiers are **not the mainnet deployment target**. Verify the derivation and use the mainnet sources, final artifacts and source hashes as the deployed-code review boundary.

## What the evidence does and does not cover

| Evidence | What it demonstrates | What it does not demonstrate |
| --- | --- | --- |
| `protocol/phase2-mainnet/fuzz/` | Contract accounting, authorization, policy-window/time models, adversarial router behavior and invariants | Verifier mocks accept proofs; these tests do not establish circuit soundness or actual final-proof acceptance |
| `artifacts/phase2-mainnet/final-parameter-acceptance.json` | 36 checks, 11 actual final Groth16 proofs and 43 local transactions, using final production verifiers and native pool | Public mainnet execution, actual DEX integration, independent audit or measured anonymity |
| `artifacts/phase2-mainnet/final-fee-parameter-acceptance.json` | 22 checks, four actual final proofs and 73 local transactions, using final production pools and fee adapters; both router ABIs, native wrap/unwrap, net recovery and withdrawal | Routers, tokens, factories and liquidity are explicit mocks; no actual market prices or mainnet fills were tested |
| Governance report and Safe report in `artifacts/phase2-mainnet/` | Recorded local governance acceptance and separately observed RH mainnet Safe identity/configuration | A deployed Lincoln mainnet registry, future Safe ownership or continuous operational monitoring |

Some Foundry adapter tests import the earlier adapter implementation as behavioral regression coverage, including the fee implementation in `protocol/phase2-fees/contracts/`. They do not replace review and final-proof testing of the derived mainnet fee artifact. See `protocol/phase2-mainnet/fuzz/README.md` for the exact suite assumptions. Running a test suite now produces new evidence; the included historical reports only describe their recorded runs.

## Explicit exclusions and open review areas

The extracted audit scope excludes frontend presentation, hosted infrastructure, API availability, production key custody, Cloudflare/AWS configuration, external DEX implementations, bridges, lending, TVL investment and new DEX adapter types. External contract integration assumptions still need review even though those third-party implementations are not Lincoln-owned audit targets.

Assess finite tree capacity and dust-deposit denial of service, current-note approval limitations, old-policy acceptance after note removal, publisher/set-data availability, privacy leakage and small anonymity sets, exact-transfer token assumptions, issuer-controlled stock tokens and permanent immutable-contract failure modes. An entry in this list is a stated boundary or review topic, not a claim that the independent audit has already resolved it.
