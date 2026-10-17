# Audit scope

This repository packages the Robinhood Chain mainnet core candidate originally extracted from upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1`. The pushed **`v0.1.0-rc.1`** is a historical snapshot. **RC.2** changes caps and fee policy and has passed fresh real-proof native/fee acceptance; the exact inventory and standalone reproduction checks have also passed. It is not evidence of a mainnet deployment or a completed independent audit. Target chain ID: **4663**.

The RC.2 release-inventory path is `artifacts/phase2-mainnet/release-candidate-20261016-r2.json`. Its frozen SHA256 is `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3`. Review the tag and inventory together; the candidate is not a live deployment. RC.1 extraction provenance and historical acceptance remain separately identifiable; they are not blanket authorization to accept changed files. Review the exact candidate commit and inventory together. See [RC.2 reconciliation](PLAN_RECONCILIATION_R2.md).

## Deployment contract scope

The inventory contains **10 deployable contract/library types**, not ten already deployed addresses. Pools and fixed-route adapters may have several instances.

| Contract or library | Authoritative source | Review focus |
| --- | --- | --- |
| `Phase2ASPPool` | `protocol/phase2-mainnet/contracts/Phase2ASPPool.sol` | Custody, raw-unit deposit/accounted-reserve caps, donation surplus, Guardian cap changes and deposit-only pause, append-only tree, nullifiers, proof/context binding, exits and solvency |
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

The core artifact is `artifacts/phase2-mainnet/contracts.json`. The fee artifact is `artifacts/phase2-fees-mainnet/contracts.json`, with portable input `contracts/phase2-fees-mainnet.standard-input.json`. ABI exports live in `abi/phase2-mainnet/` and `abi/phase2-fees-mainnet/`. RC.2 requires regenerated artifacts and ABIs: the pool constructor now includes two uint128 cap arguments, and the fee component must bind the changed core even if its adapter runtime logic is unchanged.

The selected new-adapter rate is 30 bps with the Safe treasury. The core pool does not enforce a universal 30-bps tax; its fee amounts remain proof-authenticated. Review the separate v2 commercial policy described below without attributing its live deployment or service availability to these contracts.

## Circuits and proving-material scope

Review the circuits under `protocol/phase2-asp/circuits/`: the two-input/two-output JoinSplit circuit and the holder-exit circuit. Those circuit paths retain their upstream names; the finalized production keys, WASM, R1CS, verification keys and manifests are under `protocol/phase2-mainnet/build/joinsplit/` and `protocol/phase2-mainnet/build/holder-exit/`.

Key obligations include note ownership, value ranges and conservation, dummy inputs/outputs, pool scope, nullifier construction, both pool and association Merkle paths, and binding public actions to encrypted outputs. Holder exit must consume the same note nullifier as normal spending.

RC.2 retains the note structure, two-input/two-output statements and exact final proving keys. Deposit caps and pause do not inherently require another contribution ceremony, but unchanged keys must be tested against the changed deployed pool and context bindings.

The final keys include two recorded non-beacon contributions followed by the committed future-block beacon. Review contribution-chain verification, public commitment evidence, manifest/file hashing and generated verifier derivation. The records do not authenticate contributor identity, independent machine control or destruction of secret contribution randomness. Historical initial `0000.zkey` files are not included in this subset and must never be deployed as final keys.

## SDK and build boundary

The included JavaScript subset supports artifact validation, pure fee-policy validation, state reconciliation and proof acceptance; it is not a claim that the complete wallet, relayer, indexer or cloud deployment is part of this repository.

Relevant code includes `src/phase2-mainnet/sdk.mjs`, `src/phase2-mainnet/artifacts.mjs`, `src/phase2-mainnet/release.mjs` and their included shared dependencies. Review production-profile rejection of development materials, exact final artifact loading, parameter hashes, witness preparation and correspondence between SDK hashing/encryption and circuit/contract context fields. Wallet secrets and witness data are intended to remain on the client. Compromise of a wallet, recovery seed or proof-building environment is outside the protection supplied by the on-chain contracts.

The mainnet builder derives release-specific sources from earlier development implementations. `protocol/phase2-asp/`, `protocol/phase2-routes/`, `protocol/phase2-router02/` and `protocol/phase2-fees/contracts/` may therefore appear as required derivation/reference inputs. Their testnet/local chain allowances and development verifiers are **not the mainnet deployment target**. Verify the derivation and use the mainnet sources, final artifacts and source hashes as the deployed-code review boundary.

RC.2 adds `src/phase2-fees/policy.mjs`: versioned v1/v2 normalization, exact integer quotes and new-job fee validation. Review withdrawal/holder-exit percentage plus prequoted fixed gas; zero-fee deposit/ragequit; launch free private transfer and gas subsidy; immutable swap rate/treasury checks; uint128/rounding limits; and preservation of old v1 job semantics. Existing proved or recovering jobs must not be repriced. This component performs no RPC quote, signing or live runtime activation. See [fee policy v2](FEE_POLICY_V2.md).

For caps, review the Guardian authorization source, 24-hour increase delay, pending-proposal replacement and clearing, immediate reductions, pause scope and constructor requirements. Check `publicOut` is deducted only once, public exits deduct the entire note, donations leave accounted liabilities unchanged, and target-cap failures roll back the entire DEX route. Where state helpers are included, event-derived reserve must reconcile with on-chain accounted balance and actual custody at one canonical block.

Mainnet deployer fields remain null. ETH/USDG raw caps are selected, while each stock's raw caps and fixed-block valuation/liquidity evidence remain unresolved. A planner must reject an unresolved deployment selection rather than invent a key/address or select unlimited caps. These are unresolved operations inputs, not evidence of a contract deployment.

## What the evidence does and does not cover

| Evidence | What it demonstrates | What it does not demonstrate |
| --- | --- | --- |
| Updated RC.2 `protocol/phase2-mainnet/fuzz/` | **68 passing tests**, 1,000 runs per fuzz case; invariant campaign 128 × 40 = 5,120 calls, zero reverts. Contract accounting/caps, donation surplus, pause and exit liveness, policy-window/time models, adversarial routers and rollback | Verifier mocks accept proofs; these tests do not establish circuit soundness, actual final-proof acceptance or live DEX liquidity |
| RC.2 native report, `audit/acceptance/standalone-20261016-r2/native.json` | **43 checks, 11 actual final Groth16 proofs and 48 local transactions** on the changed pool, including continued real-proof spends/exits with deposits paused and caps lowered below reserve | Public mainnet execution, independent audit or measured anonymity |
| RC.2 fee report, `audit/acceptance/standalone-20261016-r2/fees.json` | **22 checks, four actual final proofs and 73 local transactions**; both router ABIs, two-hop wrap/unwrap, 30-bps net recovery and subsequent withdrawal | Routers/tokens/factories/liquidity are explicit mocks; no actual market prices or mainnet fills |
| Historical RC.1 reports/builds, `audit/baselines/v0.1.0-rc.1/` | Their recorded RC.1 build only; preserved with the original tag | Changed RC.2 bytecode; they cannot replace current acceptance |
| Governance report and Safe report in `artifacts/phase2-mainnet/` | Recorded local governance acceptance and separately observed RH mainnet Safe identity/configuration | A deployed Lincoln mainnet registry, future Safe ownership or continuous operational monitoring |

The RC.2 native run is `d2172cda-01bc-4b26-8d43-95b1d0e241c3`; the fee run is `e7cf5b6d-36ec-41cc-9e68-2dcde9f48d3d`. Together they executed **15 actual proofs and 121 local transactions**, with zero public-chain transactions. They bind core SHA256 `6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e` and fee SHA256 `52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a`.

The fee fixture produces gross output 10,000, charges 30, recovers B's 9,970-unit note and withdraws gross 9,970 once with fee 32 (29 percentage units plus three **synthetic fixed-gas fixture units**), net 9,938. The three-unit quote is not the mainnet ETH preset. Mock-verifier Foundry evidence remains distinct from these actual Groth16 runs.

Some Foundry adapter tests import the earlier adapter implementation as behavioral regression coverage, including the fee implementation in `protocol/phase2-fees/contracts/`. They do not replace review and final-proof testing of the derived mainnet fee artifact. See `protocol/phase2-mainnet/fuzz/README.md` for the exact suite assumptions. Running a test suite now produces new evidence; the included historical reports only describe their recorded runs.

## Explicit exclusions and open review areas

The extracted audit scope excludes frontend presentation, hosted infrastructure, API availability, production key custody, Cloudflare/AWS configuration, external DEX implementations, bridges, lending, TVL investment and new DEX adapter types. External contract integration assumptions still need review even though those third-party implementations are not Lincoln-owned audit targets.

Assess cap/pause governance and delayed increases, donation/accounted-reserve reconciliation, atomic cap failure during reshielding, finite tree capacity and dust-deposit denial of service, current-note approval limitations, old-policy acceptance after note removal, publisher/set-data availability, privacy leakage and small anonymity sets, exact-transfer token assumptions, issuer-controlled stock tokens and permanent immutable-contract failure modes. An entry in this list is a stated boundary or review topic, not a claim that the independent audit has already resolved it.
