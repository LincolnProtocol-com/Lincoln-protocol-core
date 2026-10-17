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

**Thirteen custody pools are deployed: ETH, USDG, seven original stock pools, AAPL, USDe, PONS and CASHCAT.** The original seven-contract ETH/USDG core and seven stock pools are preserved. The [core manifest](deployments/robinhood-mainnet/rc3-eth-usdg.json), [stock manifest](deployments/robinhood-mainnet/stocks-100-tokens.json), [stock deployment verification](deployments/robinhood-mainnet/verification/stocks-100-tokens-20261017.json) and [nine-pool read-only state acceptance](deployments/robinhood-mainnet/verification/nine-pool-state-20261017.json) record the public chain evidence. The [timestamped backend activation record](deployments/robinhood-mainnet/backend-activation-20261017.json) now records thirteen signing relay services, thirteen-pool indexing and ASP, WSS hints, one publication confirmation and direct Access-protected SSE acceptance. Recheck live readiness for current availability. The original eighteen 30 bps [fee adapters](deployments/robinhood-mainnet/fee-adapters-30bps.json) and six [extension adapters](deployments/robinhood-mainnet/four-pools-fee-adapters-30bps.json) are deployed and verified; the official relay is configured with all twenty-four route directions and the selected service-fee policy; frontend integration and funded real-market acceptance remain launch work. Independent audit is deferred. Keep the original journals and shared account-wide gas ledger.

The later [100-token capacity decision](docs/STOCK_CAPACITY_100_TOKENS.md) supersedes the historical stock total caps. Each deployed stock pool has a total capacity of 100 stock tokens, retaining its earlier approximately USD 2,500 single-deposit reference limit. Fee adapters now connect USDG with every stock pool; relay service routes are configured; frontend synchronization and funded end-to-end acceptance are still pending before official stock trading is offered. ETH/USDG retain their existing caps; the default core deployment includes no stocks or routes.

**Four-pool extension deployed:** the [AAPL/USDe/PONS/CASHCAT manifest](deployments/robinhood-mainnet/four-pools-20261017.json), [six fee adapters](deployments/robinhood-mainnet/four-pools-fee-adapters-30bps.json) and [independent read-only deployment verification](deployments/robinhood-mainnet/verification/four-pools-deployment-20261017.json) bind all ten confirmed CREATE transactions, runtimes, getters and pool caps to frozen RC.3. Actual deployment gas cost was 0.000771810193892 ETH. New-pool relay, indexer, ASP, service-fee and Access activation have [separate read-only operational evidence](deployments/robinhood-mainnet/backend-activation-20261017.json). Existing approved notes remain usable during publication changes when the registry still accepts their epoch; frontend Worker SSE forwarding and funded end-to-end acceptance remain pending. The [public token review](deployments/robinhood-mainnet/verification/four-pool-review.json) discloses accepted issuer risks, including AAPL freeze, pause, administrative burn and upgrade powers and USDe OFT bridge administration. The separate [LINCOLN / SPCX V4 design](docs/mainnet-v4-lincoln-spcx-design.md) remains undeployed, needs a new adapter and approved token capacities, and is excluded from the address book and TVL roster.

## Mainnet address book

These are **Robinhood Chain mainnet** addresses, recorded on **2026-10-17**. They are not Ethereum, Base or Robinhood testnet addresses. The machine-readable [address book](deployments/robinhood-mainnet/address-book.json) contains the same roster, creation transaction/block hashes, runtime code hashes, asset decimals, initial caps, ABI paths and source-manifest hashes. Deployment manifests are preserved as historical evidence; consult on-chain getters and service readiness for current policy and operating state.

| Network field | Value |
| --- | --- |
| Chain ID | `4663` |
| Native asset | ETH, 18 decimals |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com/` |
| Genesis hash | `0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c` |
| Contract / proof release | [`v0.1.0-rc.3`](releases/rc3/README.md) |
| ABI catalog | [`abi/manifest.json`](abi/manifest.json) |

### Custody pools and assets

Every pool holds exactly one asset. ETH uses the zero address as its asset identifier and holds native ETH directly. All other entries are ERC20 token addresses. Every pool uses [`PrivacyPool.json`](abi/PrivacyPool.json).

| Asset | Privacy pool | Underlying token | Decimals | Creation block |
| --- | --- | --- | ---: | ---: |
| ETH | `0xF9c767CAb9B9A7dE8Dd959967269787880267ab2` | Native ETH (`0x0000000000000000000000000000000000000000`) | 18 | 90,696,133 |
| USDG | `0x5Cd4c081eb747406DAb66e22004324600f1928C9` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | 90,696,170 |
| NVDA | `0x4C8BAEb78b032EA3610E0F5D4C8B5Bb4fF5995f7` | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 | 90,703,048 |
| SPY | `0x8a29Db84A20B0A3CA528FAE0F69F50FfD39c6C39` | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 18 | 90,703,092 |
| META | `0xA2078e02A631ae9218DBAa84987a24741bD24d10` | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | 18 | 90,703,141 |
| TSLA | `0xE8c619705B7452c2281cA8fA675a355846D34BFE` | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 | 90,703,190 |
| GOOGL | `0x31Bd720527D9875b444c0946c5795351a56d9d8B` | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | 18 | 90,703,241 |
| QQQ | `0xd4375275F5FA231e238c9FF1237A8e8666Be6B62` | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 18 | 90,703,293 |
| MSTR | `0x207Dc4DD4E40Ab280dF9eC10CD5Edf04685e9d88` | `0xec262a75e413fAfD0dF80480274532C79D42da09` | 18 | 90,703,349 |
| AAPL | `0xC2991be873dD0EC1D93a0911dC1068bcCcf4D3B4` | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 18 | 90,846,780 |
| USDe | `0x4AC6D3EB4379Bd82f1dcD5C8A61c6b8F15b7812C` | `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34` | 18 | 90,846,954 |
| PONS | `0x757335BD24807EAc290521Ee6b3Ab2CB86fd9F18` | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | 18 | 90,847,135 |
| CASHCAT | `0xe6711cbb2E44A0Ce72d301cC27EfBC244cBD75fb` | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | 18 | 90,847,306 |

Initial single-deposit / total caps are **1 / 20 ETH**, **2,500 / 50,000 USDG**, and the following stock-token units. These are constructor values; read `maxDeposit()` and `maxTotal()` for current limits.

| Stock token | Single deposit | Total note-backed capacity |
| --- | ---: | ---: |
| NVDA | 11.4 | 100 |
| SPY | 3.2 | 100 |
| META | 3.4 | 100 |
| TSLA | 7 | 100 |
| GOOGL | 7.3 | 100 |
| QQQ | 3.5 | 100 |
| MSTR | 18.3 | 100 |

Additional constructor caps are **7.2 / 100 AAPL**, **2,500 / 50,000 USDe**, **7,900 / 110,000 PONS** and **22,000 / 300,000 CASHCAT** (single deposit / total). USDe has no exchange route. PONS and CASHCAT are third-party tokens; each asset needs its own accepted pricing mapping.

Stock caps count **issuer ERC20 tokens**, not a guaranteed number of underlying shares. They do not track live dollar prices or automatically adjust for issuer multipliers/corporate actions. See the [100-token decision](docs/STOCK_CAPACITY_100_TOKENS.md). Deposit pause and cap controls do not pause withdrawals or ownership-based public exits. Cap increases require **12 hours**; reductions are immediate.

### Shared contracts

| Component | Mainnet address | ABI |
| --- | --- | --- |
| Poseidon T3 library | `0x4781B6D29Dd0CeFEf101049E23f31D2165a553fa` | [PoseidonT3.json](abi/PoseidonT3.json) |
| Poseidon T4 library | `0x9096D809dc96BCeE1F9c7b64BAd8F79FA6dCF165` | [PoseidonT4.json](abi/PoseidonT4.json) |
| Join-split verifier | `0xA5bC542708D7fEBD706E7fD78caD2ACa785B9dF4` | [JoinSplitVerifier.json](abi/JoinSplitVerifier.json) |
| Holder-exit verifier | `0xF430E5d1aa6d970de10C745DC04cb7e7E1F53Ab5` | [HolderExitVerifier.json](abi/HolderExitVerifier.json) |
| ASP association-set registry | `0x89ad7Cce6c161A21323BE234d9924fEe915b2660` | [AssociationSetRegistry.json](abi/AssociationSetRegistry.json) |

### Administrative and operating addresses

These roles are separate from user custody pools and **must not be counted as TVL**. This is a public address roster, not a request to send funds.

| Role | Address | Authority |
| --- | --- | --- |
| Original deployer | `0x555998Ba2B2723C97d91FB20Da0ddb896749797e` | Original contract creator; no owner sweep. |
| Safe guardian | `0x9CF17a6E3c75D200f58283A165C442a8A3994555` | Deposit controls, ASP suspension and delayed provider rotation; no private-note ownership. |
| ASP provider | `0xce6770154D793dF78FbfA0D3615B2946366E6612` | Publishes association roots; cannot withdraw user notes. |
| Official relay | `0x8d890058818EDbc222E6E01F501dC77FBFf6f4dC` | Submits proof-bound transactions; does not own private notes. |

Read the registry's `PROVIDER()` for the current ASP authority. The provider address may rotate after the immutable Guardian's proposal and a **three-day** delay. The registry accepts at most **16 epochs**, with a **one-hour** replacement grace period and independent expiry checks. Normal private spends require current-note ASP approval; `holderExit` and `ragequit` do not. The bootstrap policy is self-hosted **all-current-notes**, with **no original-source screening**. See [security model](docs/SECURITY_MODEL.md).

The stock issuer registry and implementation observed during verification are external dependencies, not Lincoln custody contracts:

| Observed dependency | Address |
| --- | --- |
| stock-issuer-registry | `0xe10b6f6B275de231345c20D14Ab812db62151b00` |
| stock-issuer-implementation | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |

Their code hashes and observation block are in the [stock verification record](deployments/robinhood-mainnet/verification/stocks-100-tokens-20261017.json). An observed issuer implementation does not prevent future issuer changes.

### Fees, routes and integration status

The core pools do not impose a mandatory 0.3% tax. The selected policy for new fee adapters is **30 bps (0.3%)**; official-relay withdrawal / relayed holder-exit pricing is a separate proof-bound service policy. A policy selection is not evidence that live service fees are configured. **The original eighteen 30 bps fee adapters were deployed on 2026-10-17** by the same deployer and account ledger; the [fee adapter manifest](deployments/robinhood-mainnet/fee-adapters-30bps.json) records creation transactions, runtime code hashes and every verified immutable getter. Each adapter is a fixed one-hop exact-input route between two privacy pools with an immutable 30 bps fee paid to the Safe treasury `0x9CF17a6E3c75D200f58283A165C442a8A3994555` (as WETH for ETH targets); the net output is reshielded into the target pool. Deployment verification covers bytecode and constructor bindings only. Official relay routes and per-asset service-fee configuration are enabled in the backend; frontend synchronization and funded real-market end-to-end acceptance remain separate launch steps. The adapter source supports ETH wrapping and 1–4 hops for future verified routes.

| Route | Adapter | Venue / pool parameter | Hop pool |
| --- | --- | --- | --- |
| `uniswap-eth-to-usdg` | `0x51BdAdcDC1B8B6Ed0EDe948EE4Ba1b1F48D22106` | Uniswap V3 fee 100 | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` |
| `uniswap-usdg-to-eth` | `0xf4E0376E185177EbF38773fEA3F46089733cB029` | Uniswap V3 fee 100 | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` |
| `up-eth-to-usdg` | `0xf75881f178D15fF44cC4B00dAdcEbCD5e04a9296` | UP Slipstream tick spacing 10 | `0x16679e2ac1A798865eCf1c1639e67693ddB1C220` |
| `up-usdg-to-eth` | `0xF6d233367c3Adfa45047571BAAfBB1b3864c8eA8` | UP Slipstream tick spacing 10 | `0x16679e2ac1A798865eCf1c1639e67693ddB1C220` |
| `uniswap-usdg-to-nvda` | `0x39c340f193C2f6D4131A9537f005Da3385d0e0fB` | Uniswap V3 fee 500 | `0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3` |
| `uniswap-nvda-to-usdg` | `0x829eC924A39A110B0Ea59fcDD1164a2EE6d25f42` | Uniswap V3 fee 500 | `0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3` |
| `uniswap-usdg-to-spy` | `0x804a2f51a04c4c552FB03743409BCbA0C6485D92` | Uniswap V3 fee 500 | `0xa7Bb1AC63BBaB0C44316E6c8C455213441689167` |
| `uniswap-spy-to-usdg` | `0xDcD5b12c1dC1FfdC58045Fe306305Da705af00d9` | Uniswap V3 fee 500 | `0xa7Bb1AC63BBaB0C44316E6c8C455213441689167` |
| `uniswap-usdg-to-meta` | `0x7a8454953CC392b5Ce2E267Dc0570D4D1bC65490` | Uniswap V3 fee 3000 | `0x107a7Cb40d8665360ba10E59471Af06150A50922` |
| `uniswap-meta-to-usdg` | `0xA755940ca05Da17580982767607E42C801b7a897` | Uniswap V3 fee 3000 | `0x107a7Cb40d8665360ba10E59471Af06150A50922` |
| `uniswap-usdg-to-tsla` | `0xbF542B7195Eb402671aA30cED94114e0557ac1d5` | Uniswap V3 fee 3000 | `0xf4ACdAEEB7022862A763C9B1B885e11191c889E3` |
| `uniswap-tsla-to-usdg` | `0x3DaE2c98EB758685325417fc615e8980263970B3` | Uniswap V3 fee 3000 | `0xf4ACdAEEB7022862A763C9B1B885e11191c889E3` |
| `uniswap-usdg-to-googl` | `0xa3eF05228fC562a7610B3d038B990f53de582862` | Uniswap V3 fee 500 | `0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7` |
| `uniswap-googl-to-usdg` | `0xaC082BB3e0C4A6852516f25DBe0d85aB546F834A` | Uniswap V3 fee 500 | `0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7` |
| `uniswap-usdg-to-qqq` | `0x10B002942c1dcf6E93951dC85b9A41D3dA30B690` | Uniswap V3 fee 500 | `0xD60A5d14dB690B7Afad71F76B108071D7175597d` |
| `uniswap-qqq-to-usdg` | `0x23C932B0B8C879D0D982353411D8e6Ba3Bac3aaa` | Uniswap V3 fee 500 | `0xD60A5d14dB690B7Afad71F76B108071D7175597d` |
| `uniswap-usdg-to-mstr` | `0xb7e36f25FfDaFAbcB28DdE863C97C8ad7dC57bc2` | Uniswap V3 fee 10000 | `0x17578C0e0D15da44f31677263114F71aE76653EA` |
| `uniswap-mstr-to-usdg` | `0x784a20CAC13Bedcc885AEb0c3B052644582Df2F1` | Uniswap V3 fee 10000 | `0x17578C0e0D15da44f31677263114F71aE76653EA` |

The extension adds these six confirmed fee adapters, bringing the deployed total to **24**. Their backend activation is pending and is not implied by this table.

| Route | Adapter | Uniswap V3 fee | Hop pool |
| --- | --- | ---: | --- |
| `uniswap-aapl-to-usdg` | `0x1294FF276c7cE8DA5a3Be8635BFB422931d152e9` | 500 | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` |
| `uniswap-usdg-to-aapl` | `0xe8A5208e21B9c3Ca9d0DDD3374f27A092FE91547` | 500 | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` |
| `uniswap-pons-to-eth` | `0xdCC6FB0Be9dE8c2BeeB549d0187bdA920B3705f5` | 3000 | `0xed50bdeea8adc232f159486192a4157281d722ff` |
| `uniswap-eth-to-pons` | `0x2dD4643AF77b2E223208ca82337c696F7f31f4F3` | 3000 | `0xed50bdeea8adc232f159486192a4157281d722ff` |
| `uniswap-cashcat-to-eth` | `0xe3A67af6FA192E06d7Cd528D2f0EBAE171653DC2` | 3000 | `0xd42a491087a15e5afd51feb3606066cc152d2b09` |
| `uniswap-eth-to-cashcat` | `0xaE8daE90Db5601b786B6ED883D65600397cBC537` | 3000 | `0xd42a491087a15e5afd51feb3606066cc152d2b09` |

For audit, start with [audit scope](docs/AUDIT_SCOPE.md), [review manifest](review-manifest.json), [RC.3 acceptance evidence](audit/acceptance/rc3/validation.json), [ABI catalog](abi/manifest.json) and [parameter provenance](docs/PARAMETER_PROVENANCE.md). Source review paths are `contracts/` and `zk/`; the preserved release paths exist to reproduce compiler and parameter identities. Neither deployment verification nor local proof acceptance is an independent audit.

For **DefiLlama**, use the [address book JSON](deployments/robinhood-mainnet/address-book.json) and [TVL integration notes](docs/TVL_INTEGRATION.md). Count underlying custody at the thirteen deployed pools once. Do not add note balances, `accountedBalance`, operator gas, the registry or external DEX liquidity to that same balance. Chain support, token price mappings and a DefiLlama adapter submission remain separate integration work; no listing or acceptance is claimed here.

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
