# Lincoln Protocol Core

Privacy pools, proof verifiers, association-set policy and typed DEX adapters for **Robinhood Chain, chain ID 4663**.

Start with the review files below. Each is a regular file whose bytes are bound to the preserved RC.2 release by [review-manifest.json](review-manifest.json). The check command rejects a review copy that differs from its mapped release file.

| Directory | Review here |
| --- | --- |
| [`contracts/`](contracts/README.md) | Pool, policy registry, DEX adapters, verifiers and hash libraries |
| [`zk/`](zk/README.md) | Circuit sources, final proving parameters and public ceremony evidence |
| [abi/](abi/) | Ten production ABI exports |
| [`test/`](test/README.md) | Contract tests and recorded local proof-acceptance evidence |
| [`releases/`](releases/README.md) | Immutable RC.2 reproduction capsule and release provenance |

Read [audit scope](docs/AUDIT_SCOPE.md), [security model](docs/SECURITY_MODEL.md) and [parameter provenance](docs/PARAMETER_PROVENANCE.md) for the review boundary and assumptions. [Mainnet operations](docs/MAINNET_OPERATIONS.md) describes the separate deployment work.

The candidate supports two-input/two-output private payments, recovery and respend, public withdrawal, ownership-based public exits, deposit caps with delayed increases, deposit-only pause and fixed-route swaps that return net output to a privacy pool. The selected new-adapter fee is 30 bps; official-relay pricing is separate from a mandatory core-pool tax.

**Mainnet core deployment and the product launch are incomplete.** An individually confirmed component does not establish a complete deployment. Live fee-route activation, asset-specific stock caps, operations funding and real-market acceptance remain separate launch work. Independent audit is deferred. Publishing this repository does not authorize mainnet spending.

## Reproduce

Use Node.js **22 or newer** and Foundry **1.8.4**, with `forge` and `anvil` on `PATH`.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run check:circuits
npm run test:contracts
npm run test:proofs
```

`npm run check` verifies the regular review files, mapping and preserved release. The build and test wrappers validate that binding, then run the preserved tooling with its original logical source paths. Keeping those compiler paths preserves Solidity metadata, library references and the exact RC.2 bytecode. The readable root paths are review entry points; they are not a promise that direct root-level `forge` compilation needs no remapping.

No production wallet or funding is needed. Proof acceptance uses fresh local Anvil chains and explicit mock DEX liquidity. Recorded RC.2 evidence includes **68 Foundry test results** and **15 actual final proofs across 121 local transactions**; see [test evidence](test/README.md) for the limits of those results. These are recorded release results, not a claim that every command has been rerun for each later documentation/layout commit.

The public-layout migration was separately rerun: **116 Node tests, 68 Foundry tests, both circuit rebuilds and 15 fresh final proofs across 121 local transactions passed**. Its [validation report](test/evidence/layout/validation.json) binds new run IDs and logs; the historical RC.2 evidence remains unchanged.

The layout preserves the original `v0.1.0-rc.2` tag, contract identifiers, compiled bytecode and final proving keys. Source comments and identifiers are retained byte-for-byte even where they contain historical naming. Licensing boundaries are documented in [third-party notices](THIRD_PARTY_NOTICES.md).
