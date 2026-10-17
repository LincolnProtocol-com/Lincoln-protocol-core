# Lincoln Protocol Core

Privacy pools, proof verifiers, association-set policy and typed DEX adapters for **Robinhood Chain, chain ID 4663**.

Start with the review files below. Each is a regular file whose bytes are bound to the RC.3 candidate by [review-manifest.json](review-manifest.json). The check command rejects a review copy that differs from its mapped release file.

| Directory | Review here |
| --- | --- |
| [`contracts/`](contracts/README.md) | Pool, policy registry, DEX adapters, verifiers and hash libraries |
| [`zk/`](zk/README.md) | Circuit sources, final proving parameters and public ceremony evidence |
| [abi/](abi/) | Ten production ABI exports |
| [`test/`](test/README.md) | Contract tests and recorded local proof-acceptance evidence |
| [`releases/`](releases/README.md) | Current RC.3 reproduction capsule and immutable RC.2 archive |

Read [audit scope](docs/AUDIT_SCOPE.md), [security model](docs/SECURITY_MODEL.md) and [parameter provenance](docs/PARAMETER_PROVENANCE.md) for the review boundary and assumptions. [Mainnet operations](docs/MAINNET_OPERATIONS.md) describes the separate deployment work.

The candidate supports two-input/two-output private payments, recovery and respend, public withdrawal, ownership-based public exits, deposit caps with a 12-hour increase delay, deposit-only pause and fixed-route swaps that return net output to a privacy pool. The selected new-adapter fee is 30 bps; official-relay pricing is separate from a mandatory core-pool tax.

**Mainnet core deployment and the product launch are incomplete.** Both original Poseidon libraries are now recorded as confirmed and eligible for verified reuse by the RC.3 command. Keep the original journals and shared account-wide gas ledger. An individually confirmed library is not a complete deployment. Live fee routes, stock fork/DEX acceptance, operations funding and real-market acceptance remain separate launch work. Independent audit is deferred. Publishing this repository does not authorize mainnet spending.

The [seven stock-token caps](docs/STOCK_CAPS.md) are now fixed at approximately USD 2,500 per deposit and USD 25,000 total per asset using the approved historical quotes. Stock pools remain disabled. ETH/USDG retain their existing caps; the default core deployment includes no stocks or routes.

## Reproduce

Use Node.js **22 or newer** and Foundry **1.8.4**, with `forge` and `anvil` on `PATH`.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run check:circuits
npm test
npm run test:contracts
npm run test:contracts:deep
npm run test:proofs
```

`npm run check` verifies the regular review files, mapping and preserved release. The build and test wrappers validate that binding, then run the preserved tooling with its original logical source paths. Keeping those compiler paths makes the RC.3 metadata and library references reproducible. RC.3 intentionally changes the pool bytecode for the 12-hour delay; it does not rewrite the RC.2 archive. The readable root paths are review entry points; they are not a promise that direct root-level `forge` compilation needs no remapping.

No production wallet or funding is needed. Proof acceptance uses fresh local Anvil chains and explicit mock DEX liquidity. Recorded RC.2 evidence includes **68 Foundry test results** and **15 actual final proofs across 121 local transactions**; see [test evidence](test/README.md) for the limits of those results. These are recorded release results, not a claim that every command has been rerun for each later documentation/layout commit.

The earlier RC.2 public-layout migration was separately rerun: **116 Node tests, 68 Foundry tests, both circuit rebuilds and 15 fresh final proofs across 121 local transactions passed**. Its [validation report](test/evidence/layout/validation.json) binds new run IDs and logs; the historical RC.2 evidence remains unchanged.

RC.3 is a separately identified candidate. The original `v0.1.0-rc.2` tag and `releases/rc2/` remain unchanged. The pool increase delay changes from 24 to 12 hours; circuit statements and final proving keys are retained. Historical source identifiers remain for compiler identity. Licensing boundaries are documented in [third-party notices](THIRD_PARTY_NOTICES.md).

Fresh RC.3 acceptance passed **178 Node tests**, **69 default Foundry tests**, **19 deep tests scoped to caps and invariants**, and **15 final proofs across 124 local transactions**. The deep campaign used 20,000 runs per fuzz case and 40,960 invariant calls with zero reverts. The [validation report](audit/acceptance/rc3/validation.json) binds the reports and logs; historical RC.2 results remain separate. Deployment preparation uses `bash scripts/deploy-mainnet.sh --prepare`; see [operations](docs/MAINNET_OPERATIONS.md) before any local `--deploy`.
