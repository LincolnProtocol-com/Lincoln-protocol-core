# Four additional mainnet pools: preparation

This proposal adds AAPL, USDe, PONS and CASHCAT to Robinhood mainnet (4663). It reuses the deployed RC.3 pool bytecode, five shared components, final proof parameters, guardian and 30 bps fee adapter component. It does not change the nine existing pools or the eighteen deployed adapters.

**The proposal is not a deployed pool record.** It remains immutable with `signingEnabled: false`. A separate [scoped approval](../config/approved-four-pools-20261017.json) now records the user’s 2026-10-17 decision, and the [deployment runner](mainnet-four-pool-deployment-runner.md) enforces that approval. The offline planner itself has no RPC or wallet dependencies and refuses `--deploy`.

## Exact proposed capacities

All four tokens are proposed with 18 decimals; their actual precision and identity must be independently checked.

| Asset | Maximum deposit (tokens) | Maximum total (tokens) | Deposit base units | Total base units |
| --- | ---: | ---: | ---: | ---: |
| AAPL | 7.2 | 100 | 7200000000000000000 | 100000000000000000000 |
| USDe | 2,500 | 50,000 | 2500000000000000000000 | 50000000000000000000000 |
| PONS | 7,900 | 110,000 | 7900000000000000000000 | 110000000000000000000000 |
| CASHCAT | 22,000 | 300,000 | 22000000000000000000000 | 300000000000000000000000 |

USDe follows USDG's 50,000 **token** total capacity, converted to USDe's 18 decimals. USDG's 6-decimal raw integer is not reusable. Values are fixed token quantities; the approximately dollar-denominated descriptions in the handoff are not live price feeds. Price changes, stock corporate actions and issuer multipliers never adjust a cap automatically.

New pool constructor caps apply immediately on deployment. Later reductions and deposit pauses are controlled by the registry's Safe guardian. Later increases require its existing 12-hour proposal/acceptance process.

## Offline commands

Run from the core checkout; no dependencies need installing for these commands:

```sh
node scripts/operations/new-pools-mainnet-plan.mjs --plan
node scripts/operations/new-pools-mainnet-plan.mjs --plan --include-calldata > /tmp/lincoln-four-pool-unsigned-plan.json
node --test test/operations/new-pools-mainnet-plan.test.mjs
```

To attach a public review report stored under this checkout:

```sh
node scripts/operations/new-pools-mainnet-plan.mjs --plan \
  --review deployments/robinhood-mainnet/verification/four-pool-review.json
```

The report path must be a regular public file within the checkout. Private directories, symlinks, absolute paths and `..` are refused. The example report path above is a future output, not an existing successful review.

The plan pins the original ETH/USDG deployment manifest, final RC.3 release, core artifact and fee artifact by SHA256. It rechecks both circuit manifests against deployed profile pins. Pool constructor arguments are encoded into the real library-linked frozen creation bytecode. `--include-calldata` includes those unsigned creation inputs; their SHA256 values are always included. Transaction nonce and price remain unset. Adapter constructor intents refer to not-yet-created pools as `created:pool:<id>` instead of guessing addresses.

The plan identifier commits to the complete policy bytes, frozen artifacts, core anchors, optional review report, four pool intents and six adapter intents. Displaying creation calldata does not change that identity.

## Selected exchange markets

Each selected market produces two immutable `Phase2FeeRouter02Adapter` intents. ETH endpoints use canonical WETH internally, preserving native wrapping/unwrapping.

| Market | Uniswap V3 fee | Selected pool |
| --- | ---: | --- |
| AAPL / USDG | 500 (0.05%) | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` |
| PONS / WETH | 3000 (0.3%) | `0xed50bdeea8adc232f159486192a4157281d722ff` |
| CASHCAT / WETH | 3000 (0.3%) | `0xd42a491087a15e5afd51feb3606066cc152d2b09` |

The handoff's alternative 1% pools remain unselected references. Choosing an alternative requires updating the reviewed proposal and route evidence. There is no USDe route. The scope contains exactly four assets; later supplied token/pair addresses do not automatically add another asset or inherit an arbitrary cap.

All six adapters retain fee 30 and treasury `0x9CF17a6E3c75D200f58283A165C442a8A3994555`. Adapter deployment is a permissionless CREATE; the core has no adapter registration transaction. New service routing still requires verified runtime/getter records, asset gas quotes and actual exchange acceptance.

## Public evidence contract

`assessNewPoolReview()` accepts `lincoln-mainnet-four-pool-review/v1` reports. Its checks verify report bindings, not the truth of an arbitrary report writer's claims. Live checks must run again immediately before any future deployment.

Required report fields:

- `schema`, `chainId: 4663`, `genesisHash`, exact `policySHA256`; `observation` with decimal-string `blockNumber`, `blockHash` and `observedAt`; `transactionsBroadcast: 0`.
- `sharedComponents`, keyed by the five reused identifiers. Each entry matches the core manifest's `address`, `runtimeCodeHash`, `startBlock`, `blockHash`, and records `creationReceiptMatched: true` and `creationInputMatched: true`.
- `assets`, exactly one entry per policy id. Each binds `address`, `symbol`, `decimals`, `runtimeCodeHash`.
- Asset `sourceReview`: `complete`, `sourceURL`, `sourceSHA256`, `runtimeMatchesReviewedSource`, boolean `upgradeable`, and `implementations` as address/runtime-hash pairs. Upgradeable tokens also disclose `upgradeAuthority`.
- Asset `transferBehavior`: `forkTestPassed`, `evidenceSHA256`, `transferExact`, `transferFromExact`, `noTransferFee` and `noRebase`, all true for unsupported-token-behavior gates to pass.
- Asset `controls`: explicit booleans `freezeAuthority`, `blacklistAuthority`, `pauseAuthority`, `bridgeAuthority`, a human-readable `description`, and `poolAddressBlocking` equal to `absent` or `issuer-controlled`.
- `markets`, exactly one entry per selected market id, binding its `address`, `fee`, `factory`, `router`, `quoter`, `wrappedNative`, token pair and runtime hash; `factoryGetPoolMatched`, `routerBindingsMatched`, `swapSimulationPassed` and `swapEvidenceSHA256`.

Freeze, blacklist, pause, proxy upgrade or issuer-controlled pool blocking always produce an explicit risk-approval blocker. An absent/reverting function selector does not prove the absence of such powers. An OFT bridge owner's ability to configure peers or bridging is recorded separately from a local ERC20 freeze capability; the description must explain the actual boundary. Do not label an issuer-controlled token as incapable of freezing just because current transfers succeed.

The existing pool checks exact balance changes when pulling or pushing assets. This rejects many tax/rebase mismatches at transaction time. It does not protect future redemption against an issuer freezing or upgrading its token, nor does it turn a rebasing asset into a supported asset.

A complete synthetic report is used only inside the unit tests. No synthetic report is committed as real chain evidence.

## Gas and deployment gates

The new transaction policy proposes a separate tighter per-transaction price ceiling of 0.1 gwei, within the existing 2.8 gwei account ceiling. The preparation alone grants no approval; the separate user-approved scope now authorizes this tighter ceiling. Four pool gas limits of 6M and six adapter limits of 4M would reserve at most 0.0048 ETH at that new ceiling, before the existing 0.003 ETH reserve. This is a fee ceiling, not a cost estimate.

A future deployment runner must:

1. Obtain explicit user approval of these token quantities, issuer risks, deployment scope and new transaction policy.
2. Reuse the original `lincoln-deployer` account and its physical cumulative signer journal. Preserve the 0.065 ETH historical budget, all past fees and unknown-broadcast recovery rules. Never reset the budget or copy signed records into a new signer store.
3. Recheck chain/genesis, core creation anchors, token and proxy code, issuer controls, Safe, precision, exact transfers and selected DEX markets against the approved public evidence.
4. Recheck current cumulative budget, reserved live entries, balance, nonce, base fee and remaining deployment gas before accessing the local keystore. It must never automatically resign or resend an unknown broadcast.
5. Verify each new CREATE input, receipt, canonical block, linked runtime, immutable getters and constructor `CapsUpdated` event; verify every adapter route/fee/treasury getter.
6. Publish a new real `phase2-mainnet-stock-extension-deployed/v1` record only after confirmed receipts. Its `profiles` contains only `aapl`, `usde`, `pons`, `cashcat`; `stockPoolsDeployed: true` is not set by this planner.

The frontend auto-discovers committed extension records on core `origin/main`. It rejects duplicate profile ids and mismatched registry/release/circuit pins. Its backend route source remains `artifacts/aws-mainnet/dex-adapters-20261017/fee-adapters-30bps.json`; append new routes without replacing the old eighteen. The relayer address remains the existing public record.

Backend activation also requires all four new listener/Access origins, an updated indexer with deployment blocks, the complete shared-registry ASP pool roster and service fee quotes. Extending the pool roster is a configuration migration; the current same-configuration blue/green API rollout must not be used to skip that migration review. Keep the nine existing pools serving during this work.

## Separate LINCOLN / SPCX request

The subsequently supplied LINCOLN / SPCX market is outside this four-pool proposal. It is described as a Uniswap V4 market, so the existing V3/UP adapter bytecode cannot be presented as supporting it. Integration requires an independently reviewed typed V4 adapter, a confirmed PoolKey (including currencies, fee, tick spacing and hooks), and both token privacy-pool profiles with approved capacities. LINCOLN token source/creation-initcode and transfer-control review is also pending. A token or pool address by itself is not sufficient evidence to enable this route.
